// Independent review: synthetic data, in-memory SQLite, mock model, random loopback port.
// Positive rereview expectations plus independent mixed-fault/recovery probes.
// Run after npm run build: node docs/review-2026-10-07-ai-truncation-parallel-schedule-rereview-browser-probe.mjs
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
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
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
  const oldResponse = page.waitForResponse(
    (r) => r.url().includes("kind=day") && r.status() === 503,
  );
  releaseResponse.resolve();
  await oldResponse;
  await page.waitForTimeout(5600);
  const after = await page.locator("#status").textContent();
  assert.equal(after, before);
  assert.equal(
    store.latestJob("month", entry.day.slice(0, 7)).state,
    "running",
  );
  assert.equal(await page.locator(".report h2").textContent(), "月度回顾");
  console.log(
    JSON.stringify({
      passed: true,
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
  assert.equal(followupPolls, 1);
  assert.equal(
    await page
      .getByRole("button", { name: "重新生成", exact: true })
      .isDisabled(),
    false,
  );
  assert.equal(
    await page
      .getByText("正在生成新一轮整理，以下是上一次整理。", { exact: true })
      .count(),
    0,
  );
  const stuckStatus = await page.locator("#status").textContent();
  assert.equal(stuckStatus, "");
  console.log(
    JSON.stringify({
      passed: true,
      case: "transient poll failure after returning to day",
      backend: "ready",
      buttonDisabled: false,
      followupPolls,
      status: stuckStatus,
      waitedMs: 5600,
    }),
  );
  // Independently exercise real fetch rejection, HTTP failure and invalid JSON.
  // Three failures -> successful running read -> another three failures -> ready.
  // The second burst must get a fresh retry budget, not inherit the first one.
  const generate = () =>
    page.getByRole("button", { name: "重新生成", exact: true });
  const running = () =>
    page.getByText("正在生成新一轮整理，以下是上一次整理。", { exact: true });
  const status = () => page.locator("#status").textContent();
  const dayRoute = "**/api/result?kind=day&*";
  const draft = page.getByLabel("此刻，想记下什么？");
  const ready = async () => {
    await page.waitForFunction(() => {
      const b = Array.from(document.querySelectorAll(".report button")).find(
        (b) => b.textContent === "重新生成",
      );
      return b && !b.disabled;
    });
    assert.equal(store.latestJob("day", entry.day).state, "ready");
    assert.equal(await running().count(), 0);
    assert.equal(await draft.inputValue(), "unsaved review draft");
  };
  const detachedRunning = async () => {
    await page.unroute(dayRoute);
    dayGate = deferred();
    await generate().click();
    await running().waitFor();
    await page.getByRole("button", { name: "洞察", exact: true }).click();
    await page.getByLabel("选择月份").waitFor();
    await page.getByRole("button", { name: "随笔", exact: true }).click();
    await running().waitFor();
  };
  await detachedRunning();
  const previous = await page.locator(".segment").allTextContents();
  let mixedReads = 0;
  await page.route(dayRoute, async (route) => {
    const n = ++mixedReads;
    if (n === 4 || n >= 8) {
      await route.continue();
      return;
    }
    assert.deepEqual(
      await page.locator(".segment").allTextContents(),
      previous,
    );
    if (n === 7) dayGate.resolve();
    if (n === 1 || n === 5 || n === 7) await route.abort("failed");
    else
      await route.fulfill({
        status: n === 3 ? 200 : 503,
        contentType: "application/json",
        body:
          n === 3
            ? "not JSON"
            : JSON.stringify({ error: "REVIEW_MIXED_FAILURE" }),
      });
  });
  await ready();
  assert.equal(mixedReads, 8);
  assert.equal(await status(), "");
  await page.waitForTimeout(2800);
  assert.equal(mixedReads, 8);
  console.log(
    JSON.stringify({
      passed: true,
      case: "two mixed-fault bursts reset budget after running success",
      reads: mixedReads,
      ready: true,
      draftAndOldContentPreserved: true,
    }),
  );

  // Hard failure cap while returning to a running task; backend finishes without
  // a current POST callback. Restore network, then recover via the advertised navigation.
  await detachedRunning();
  let boundedReads = 0;
  await page.route(dayRoute, async (route) => {
    boundedReads++;
    if (boundedReads % 2) await route.abort("failed");
    else
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"REVIEW_BOUNDED"}',
      });
  });
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("已停止自动重试"),
  );
  assert.equal(boundedReads, 4);
  assert.deepEqual(await page.locator(".segment").allTextContents(), previous);
  dayGate.resolve();
  await page.waitForTimeout(5600);
  assert.equal(store.latestJob("day", entry.day).state, "ready");
  assert.equal(boundedReads, 4);
  assert.equal(await generate().isDisabled(), true);
  await page.unroute(dayRoute);
  await page.getByRole("button", { name: "洞察", exact: true }).click();
  await page.getByLabel("选择月份").waitFor();
  await page.getByRole("button", { name: "随笔", exact: true }).click();
  await ready();
  assert.equal(await status(), "");
  console.log(
    JSON.stringify({
      passed: true,
      case: "four mixed failures stop; restored network + navigation recovers ready",
      reads: boundedReads,
      buttonDisabled: false,
    }),
  );

  // Hold an already-issued poll, leave, THEN reject fetch. Verify that this is
  // consumed (no global catch and no resurrected retry), both on navigation/logout.
  // Returning to the SAME day after navigation also checks epoch, not just kind+period.
  for (const exit of ["navigation", "logout"]) {
    await detachedRunning();
    const held = deferred(),
      release = deferred(),
      finished = deferred();
    let reads = 0;
    await page.route(dayRoute, async (route) => {
      reads++;
      held.resolve();
      await release.promise;
      try {
        await route.abort("failed");
      } finally {
        finished.resolve();
      }
    });
    await held.promise;
    if (exit === "navigation") {
      await page.getByRole("button", { name: "洞察", exact: true }).click();
      await page.getByText("review", { exact: true }).waitFor();
    } else {
      await page.getByRole("button", { name: "退出", exact: true }).click();
      await page.getByLabel("私人随笔 · 密码").waitFor();
    }
    const leavingStatus = await status();
    release.resolve();
    await finished.promise;
    dayGate.resolve();
    await page.waitForTimeout(5600);
    assert.equal(reads, 1);
    assert.equal(await status(), leavingStatus);
    await page.unroute(dayRoute);
    if (exit === "navigation") {
      await page.getByRole("button", { name: "随笔", exact: true }).click();
      await ready();
    } else {
      assert.equal(await page.locator(".report").count(), 0);
      await page.getByLabel("私人随笔 · 密码").fill("review-only");
      await page.getByRole("button", { name: "进入", exact: true }).click();
      await page.locator(".segment").first().waitFor();
      assert.equal(await draft.inputValue(), "");
      assert.equal(await generate().isDisabled(), false);
      assert.equal(await status(), "");
    }
    console.log(
      JSON.stringify({
        passed: true,
        case: `pending GET rejects after ${exit}`,
        reads,
        staleMessage: false,
        resurrectedPoll: false,
      }),
    );
  }
  assert.deepEqual(pageErrors, []);
  console.log(
    "PASS independent Chrome rereview: R1/R2, mixed faults, bounded recovery, late rejection on navigation/logout; no pageerror",
  );
} finally {
  dayGate.resolve();
  monthGate.resolve();
  releaseResponse.resolve();
  await browser.close();
  await new Promise((r) => server.close(r));
  store.close();
}
