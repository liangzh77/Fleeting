import assert from "node:assert/strict";
import type { Browser } from "playwright";
import { Store } from "../src/store.js";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import type { Config } from "../src/config.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

export async function reportErrors(browser: Browser) {
  let dayGate = deferred();
  const monthGate = deferred(),
    captured = deferred(),
    release = deferred();
  const config: Config = {
    origin: "http://localhost:3000",
    timezone: "UTC",
    database: ":memory:",
    passwordHash: await hashPassword("report-errors-only"),
    llm: { baseUrl: "https://example.invalid", apiKey: "mock", model: "mock" },
  };
  const store = new Store(":memory:", "UTC");
  const entry = store.create(
    "synthetic report error material",
    "report-errors-only",
  ).entry;
  assert(entry);
  const reply = (data: unknown) =>
    new Response(
      JSON.stringify({
        choices: [
          { finish_reason: "stop", message: { content: JSON.stringify(data) } },
        ],
      }),
    );
  const mock: typeof fetch = async (_url, init) => {
    const payload = JSON.parse(init!.body as string),
      data = JSON.parse(payload.messages[1].content);
    if (payload.messages[0].content.includes("将全部记录")) {
      await dayGate.promise;
      return reply({
        sections: (data.originals || data).map(
          (e: { id: string; text: string }) => ({
            segments: [{ text: e.text, sources: [e.id] }],
          }),
        ),
      });
    }
    await monthGate.promise;
    if (Array.isArray(data))
      return reply({
        entries: data.map((e: { id: string }) => ({
          id: e.id,
          themes: ["test"],
          points: "test",
        })),
      });
    return reply({
      overview: "test month",
      insights: [],
      changes: [],
      connections: [],
      questions: [],
    });
  };
  const server = createApp(config, store, mock).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const address = server.address();
  assert(address && typeof address !== "string");
  config.origin = `http://127.0.0.1:${address.port}`;
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.on("dialog", (d) => d.accept());
    await page.goto(config.origin);
    await page.getByLabel("私人随笔 · 密码").fill("report-errors-only");
    await page.getByRole("button", { name: "进入", exact: true }).click();
    const draft = page.getByLabel("此刻，想记下什么？");
    await draft.fill("unsaved error regression draft");
    await page.getByRole("button", { name: "AI 整理", exact: true }).click();
    await page.getByText("正在生成，可继续记录。", { exact: true }).waitFor();
    let intercepted = false;
    await page.route("**/api/result?kind=day&*", async (route) => {
      if (
        !intercepted &&
        store.latestJob("day", entry.day)?.state === "ready"
      ) {
        intercepted = true;
        captured.resolve();
        await release.promise;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "OLD_DAY_REFRESH_FAILED" }),
        });
      } else await route.continue();
    });
    dayGate.resolve();
    await captured.promise;
    await page.getByRole("button", { name: "洞察", exact: true }).click();
    await page.getByRole("button", { name: "AI 整理", exact: true }).click();
    await page.getByText("正在生成，可继续记录。", { exact: true }).waitFor();
    const before = await page.locator("#status").textContent();
    assert.match(before!, /正在生成/);
    const oldResponse = page.waitForResponse(
      (r) => r.url().includes("kind=day") && r.status() === 503,
    );
    release.resolve();
    await oldResponse;
    await page.waitForTimeout(2800);
    assert.equal(await page.locator("#status").textContent(), before);
    assert.equal(
      store.latestJob("month", entry.day.slice(0, 7))?.state,
      "running",
    );
    assert.equal(await page.locator(".report h2").textContent(), "月度回顾");
    await page.getByRole("button", { name: "随笔", exact: true }).click();
    assert.equal(await draft.inputValue(), "unsaved error regression draft");
    await page.unroute("**/api/result?kind=day&*");
    monthGate.resolve();
    dayGate = deferred();
    await page.getByRole("button", { name: "重新生成", exact: true }).click();
    const running = page.getByText("正在生成新一轮整理，以下是上一次整理。", {
      exact: true,
    });
    await running.waitFor();
    await page.getByRole("button", { name: "洞察", exact: true }).click();
    await page.getByLabel("选择月份").waitFor();
    await page.getByRole("button", { name: "随笔", exact: true }).click();
    await running.waitFor();
    let failures = 0,
      followups = 0;
    const polled = deferred();
    await page.route("**/api/result?kind=day&*", async (route) => {
      if (!failures) {
        failures++;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "TRANSIENT_POLL_FAILURE" }),
        });
        polled.resolve();
      } else {
        followups++;
        await route.continue();
      }
    });
    await polled.promise;
    await page.waitForFunction(() =>
      document.querySelector("#status")!.textContent!.includes("将自动重试"),
    );
    // Keep previous successful content and draft while the state read is failing.
    await page.getByText(entry.text, { exact: true }).first().waitFor();
    assert.equal(await draft.inputValue(), "unsaved error regression draft");
    dayGate.resolve();
    await page.waitForFunction(() => {
      const b = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".report button"),
      ).find((b) => b.textContent === "重新生成");
      return b && !b.disabled;
    });
    assert.equal(store.latestJob("day", entry.day)?.state, "ready");
    assert.equal(await running.count(), 0);
    assert.equal(await page.locator("#status").textContent(), "");
    assert.equal(failures, 1);
    assert.equal(followups, 1);
    await page.waitForTimeout(2800);
    assert.equal(followups, 1); // Ready stops polling.

    // Persistent errors are bounded; leaving a scope cancels its scheduled retry.
    await page.unroute("**/api/result?kind=day&*");
    let reads = 0;
    await page.route("**/api/result?kind=day&*", async (route) => {
      reads++;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "PERSISTENT_READ_FAILURE" }),
      });
    });
    await page.getByRole("button", { name: "洞察", exact: true }).click();
    await page.getByLabel("选择月份").waitFor();
    await page.getByRole("button", { name: "随笔", exact: true }).click();
    await page.waitForFunction(() =>
      document
        .querySelector("#status")!
        .textContent!.includes("已停止自动重试"),
    );
    assert.equal(reads, 4);
    await page.waitForTimeout(2800);
    assert.equal(reads, 4);
    await page.getByRole("button", { name: "洞察", exact: true }).click();
    await page.getByLabel("选择月份").waitFor();
    await page.getByRole("button", { name: "随笔", exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector("#status")!.textContent!.includes("将自动重试"),
    );
    const leavingReads = reads;
    await page.getByRole("button", { name: "洞察", exact: true }).click();
    await page.getByLabel("选择月份").waitFor();
    const monthStatus = await page.locator("#status").textContent();
    await page.waitForTimeout(2800);
    assert.equal(reads, leavingReads);
    assert.equal(await page.locator("#status").textContent(), monthStatus);
    // Logout also invalidates a pending retry.
    await page.getByRole("button", { name: "随笔", exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector("#status")!.textContent!.includes("将自动重试"),
    );
    const logoutReads = reads;
    await page.getByRole("button", { name: "退出", exact: true }).click();
    await page.getByLabel("私人随笔 · 密码").waitFor();
    await page.waitForTimeout(2800);
    assert.equal(reads, logoutReads);
    console.log(
      "PASS Chrome R1/R2：旧最终GET 503隔离、一次轮询503自动恢复、ready停轮询、持续失败最多3次重试、切页/退出取消、旧内容与草稿保留",
    );
  } finally {
    dayGate.resolve();
    monthGate.resolve();
    release.resolve();
    await context.close();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
}
