// Independent review: synthetic data, in-memory SQLite, mock model, random loopback port.
// Run after npm run build: node docs/review-2026-10-07-ai-truncation-parallel-schedule-browser-probe.mjs
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { Store } from "../dist/store.js";
import { createApp } from "../dist/app.js";
import { hashPassword } from "../dist/auth.js";
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
let dayGate = deferred();
const monthGate = deferred(),
  captured = deferred(),
  releaseResponse = deferred();
const config = {
  origin: "http://localhost:3000",
  timezone: "UTC",
  database: ":memory:",
  passwordHash: await hashPassword("review-only"),
  llm: { baseUrl: "https://example.invalid", apiKey: "mock", model: "mock" },
};
const store = new Store(":memory:", "UTC");
const entry = store.create("synthetic review material", "review-only").entry;
const reply = (data) =>
  new Response(
    JSON.stringify({
      choices: [
        { finish_reason: "stop", message: { content: JSON.stringify(data) } },
      ],
    }),
  );
const mock = async (_url, init) => {
  const payload = JSON.parse(init.body),
    data = JSON.parse(payload.messages[1].content),
    prompt = payload.messages[0].content;
  if (prompt.includes("将全部记录")) {
    await dayGate.promise;
    return reply({
      sections: (data.originals || data).map((e) => ({
        segments: [{ text: e.text, sources: [e.id] }],
      })),
    });
  }
  await monthGate.promise;
  if (Array.isArray(data))
    return reply({
      entries: data.map((e) => ({
        id: e.id,
        themes: ["review"],
        points: "review",
      })),
    });
  return reply({
    overview: "review",
    insights: [],
    changes: [],
    connections: [],
    questions: [],
  });
};
const server = createApp(config, store, mock).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
config.origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
try {
  const page = await browser.newPage();
  page.on("dialog", (d) => d.accept());
  await page.goto(config.origin);
  await page.getByLabel("私人随笔 · 密码").fill("review-only");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.getByLabel("此刻，想记下什么？").fill("unsaved review draft");
  await page.getByRole("button", { name: "手动生成", exact: true }).click();
  await page.getByText("正在生成，可继续记录。", { exact: true }).waitFor();
  let intercepted = false;
  await page.route("**/api/result?kind=day&*", async (route) => {
    if (!intercepted && store.latestJob("day", entry.day)?.state === "ready") {
      intercepted = true;
      captured.resolve();
      await releaseResponse.promise;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "REVIEW_OLD_DAY_REFRESH_FAILED" }),
      });
    } else await route.continue();
  });
  dayGate.resolve();
  await captured.promise;
  await page.getByRole("button", { name: "洞察", exact: true }).click();
  await page.getByRole("button", { name: "手动生成", exact: true }).click();
  await page.getByText("正在生成，可继续记录。", { exact: true }).waitFor();
  const before = await page.locator("#status").textContent();
  assert.match(before, /正在生成/);
  releaseResponse.resolve();
  await page.waitForFunction(
    () =>
      document.querySelector("#status").textContent ===
      "REVIEW_OLD_DAY_REFRESH_FAILED",
  );
  const after = await page.locator("#status").textContent();
  assert.equal(
    store.latestJob("month", entry.day.slice(0, 7)).state,
    "running",
  );
  assert.equal(await page.locator(".report h2").textContent(), "月度回顾");
  console.log(
    JSON.stringify({
      reproduced: true,
      before,
      after,
      currentView: "month",
      monthState: "running",
    }),
  );
  await page.getByRole("button", { name: "随笔", exact: true }).click();
  assert.equal(
    await page.getByLabel("此刻，想记下什么？").inputValue(),
    "unsaved review draft",
  );
  // Second boundary: return to a running scope, then lose exactly one poll.
  await page.unroute("**/api/result?kind=day&*");
  monthGate.resolve();
  dayGate = deferred();
  await page.getByRole("button", { name: "重新生成", exact: true }).click();
  await page
    .getByText("正在生成新一轮整理，以下是上一次整理。", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "洞察", exact: true }).click();
  await page.getByLabel("选择月份").waitFor();
  await page.getByRole("button", { name: "随笔", exact: true }).click();
  await page
    .getByText("正在生成新一轮整理，以下是上一次整理。", { exact: true })
    .waitFor();
  let failedPolls = 0,
    followupPolls = 0;
  const polled = deferred();
  await page.route("**/api/result?kind=day&*", async (route) => {
    if (failedPolls === 0) {
      failedPolls++;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "REVIEW_TRANSIENT_POLL_FAILURE" }),
      });
      polled.resolve();
    } else {
      followupPolls++;
      await route.continue();
    }
  });
  await polled.promise;
  await page.waitForTimeout(100);
  dayGate.resolve();
  await page.waitForTimeout(5600);
  assert.equal(store.latestJob("day", entry.day).state, "ready");
  assert.equal(followupPolls, 0);
  assert.equal(
    await page
      .getByRole("button", { name: "重新生成", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await page
      .getByText("正在生成新一轮整理，以下是上一次整理。", { exact: true })
      .count(),
    1,
  );
  const stuckStatus = await page.locator("#status").textContent();
  assert.equal(stuckStatus, "");
  console.log(
    JSON.stringify({
      reproduced: true,
      case: "transient poll failure after returning to day",
      backend: "ready",
      buttonDisabled: true,
      followupPolls,
      status: stuckStatus,
      waitedMs: 5600,
    }),
  );
} finally {
  dayGate.resolve();
  monthGate.resolve();
  releaseResponse.resolve();
  await browser.close();
  await new Promise((r) => server.close(r));
  store.close();
}
