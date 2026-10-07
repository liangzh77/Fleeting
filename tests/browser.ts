import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import type { Config } from "../src/config.js";
import { reportErrors } from "./browser-report-errors.js";
const dir = mkdtempSync(join(tmpdir(), "fleeting-browser-"));
const password = "browser-test-only-password";
const config: Config = {
  origin: "http://localhost:3000",
  timezone: "Asia/Shanghai",
  database: join(dir, "db.sqlite"),
  passwordHash: await hashPassword(password),
  llm: { baseUrl: "", apiKey: "", model: "" },
};
const store = new Store(config.database, config.timezone);
let modelGate: Promise<void> | null = null;
let modelFails = false;
let dayGate: Promise<void> | null = null;
let monthGate: Promise<void> | null = null;
const mock: typeof fetch = async (_url, init) => {
  if (modelGate) await modelGate;
  if (modelFails) return new Response("test provider failure", { status: 500 });
  const payload = JSON.parse(init!.body as string),
    prompt = payload.messages[0].content,
    input = JSON.parse(payload.messages[1].content);
  if (prompt.includes("将全部记录") && dayGate) await dayGate;
  if (!prompt.includes("将全部记录") && monthGate) await monthGate;
  const reply = (data: unknown) =>
    new Response(
      JSON.stringify({
        choices: [
          { message: { content: JSON.stringify(data) }, finish_reason: "stop" },
        ],
      }),
    );
  if (prompt.includes("按每条原文抽取"))
    return reply({
      entries: input.map((e: { id: string; text: string }) => ({
        id: e.id,
        themes: ["随想"],
        points: e.text,
      })),
    });
  if (prompt.includes("生成月度回顾")) {
    const evidence = input.originals.map((e: { id: string; text: string }) => ({
      id: e.id,
      quote: e.text,
    }));
    const item = {
      fact: '<img src=x onerror="window.evil=2">',
      evidence,
    };
    return reply({
      overview: "mock 材料有限",
      insights: [
        item,
        { ...item, hypothesis: "", limitation: "  ", question: "" },
      ],
      changes: [],
      connections: [],
      questions: [{ text: "开放问题", evidence }],
    });
  }
  return reply({
    sections: (input.originals || input).map(
      (e: { id: string; text: string }) => ({
        period: "粗时间段",
        segments: [
          {
            text: e.text,
            sources: (input.originals || input).map(
              (entry: { id: string }) => entry.id,
            ),
          },
        ],
      }),
    ),
  });
};
const server = createApp(config, store, mock).listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
config.origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : {}),
  headless: true,
});
try {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 900 },
  ]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(config.origin);
    await page.getByLabel("私人随笔 · 密码").waitFor();
    assert.equal(await page.locator("#nav").isVisible(), false);
    await page.getByLabel("私人随笔 · 密码").fill(password);
    await page.getByRole("button", { name: "进入", exact: true }).click();
    const draft = page.getByLabel("此刻，想记下什么？");
    await draft.waitFor();
    const activeNav = page.locator('nav button[aria-current="page"]');
    assert.equal(await activeNav.count(), 1);
    assert.equal(await activeNav.textContent(), "随笔");
    const activeColor = await activeNav.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    const inactiveColor = await page
      .locator("#monthNav")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    assert.notEqual(activeColor, inactiveColor);
    const text = `浏览器 ${viewport.width} <img src=x onerror="window.evil=1">\n昨天聊过 3 次？`;
    await draft.fill(text);
    // Server-confirmed success with a lost response: retry the same key, never create two entries.
    let dropped = false;
    await page.route("**/api/entries", async (route) => {
      if (route.request().method() === "POST" && !dropped) {
        dropped = true;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await page.getByRole("button", { name: "完成", exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector("#status")?.textContent?.includes("输入已保留"),
    );
    assert.equal(await draft.inputValue(), text);
    await page.getByRole("button", { name: "完成", exact: true }).click();
    await page.waitForFunction(
      () =>
        (document.querySelector("#draft") as HTMLTextAreaElement)?.value === "",
    );
    await page.getByText(text, { exact: true }).first().waitFor();
    assert.equal(
      await page.evaluate(() => (window as unknown as { evil?: number }).evil),
      undefined,
    );
    assert.equal(
      store.db
        .prepare("SELECT count(*) AS n FROM entries WHERE text=?")
        .get(text)?.n,
      1,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "AI 整理", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(await page.locator(".record-heading .entry-tools").count(), 1);
    assert.equal(await page.locator("article.entry details").count(), 0);
    assert.equal(
      await page
        .locator(".entry-select")
        .first()
        .evaluate((element) => getComputedStyle(element).backgroundColor),
      "rgba(0, 0, 0, 0)",
    );
    const title = await page.locator("header h1").boundingBox();
    const navigation = await page.locator("header nav").boundingBox();
    assert.ok(title && navigation);
    assert.ok(navigation.x >= title.x + title.width);
    assert.ok(Math.abs(navigation.y - title.y) < 24);
    for (const width of viewport.width === 390 ? [390, 320] : [1280]) {
      await page.setViewportSize({ width, height: viewport.height });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      const heading = await page.locator(".record-heading h2").boundingBox();
      const tools = await page
        .locator(".record-heading .entry-tools")
        .boundingBox();
      assert.ok(heading && tools);
      assert.ok(Math.abs(heading.y - tools.y) < 24);
      const headerTitle = await page.locator("header h1").boundingBox();
      const headerNav = await page.locator("header nav").boundingBox();
      assert.ok(headerTitle && headerNav);
      assert.ok(headerNav.x >= headerTitle.x + headerTitle.width);
      assert.ok(Math.abs(headerNav.y - headerTitle.y) < 24);
    }
    await page.setViewportSize(viewport);
    await page.getByRole("button", { name: "随笔", exact: true }).click();
    assert.equal(await activeNav.count(), 1);
    assert.equal(await activeNav.textContent(), "随笔");
    await page
      .getByLabel("原文搜索（最多 200 条）")
      .fill(`浏览器 ${viewport.width}`);
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.getByText(text, { exact: true }).first().waitFor();
    assert.equal(await page.locator(".record-heading .entry-tools").count(), 1);
    assert.equal(await page.locator("article.entry details").count(), 0);
    await page.locator(".record-heading summary").click();
    await page.getByRole("button", { name: "修改", exact: true }).click();
    await page.getByLabel("修改原文").fill("修改后 <script>alert(1)</script>");
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await page
      .getByText("修改后 <script>alert(1)</script>", { exact: true })
      .first()
      .waitFor();
    await page.getByRole("button", { name: "洞察", exact: true }).click();
    await page.getByLabel("选择月份").waitFor();
    assert.equal(await activeNav.count(), 1);
    assert.equal(await activeNav.textContent(), "洞察");
    await page
      .getByText("未配置模型，AI 暂不可用；普通记录不受影响。")
      .waitFor();
    await page.getByRole("button", { name: "退出", exact: true }).click();
    await page.getByLabel("私人随笔 · 密码").waitFor();
    assert.equal(await page.locator("article").count(), 0);
    assert.equal(await page.locator("#dialogContent").textContent(), "");
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      `PASS 浏览器 ${viewport.width}×${viewport.height}：登录、保存丢响应重试、XSS、回看、编辑、缺模型、退出、无横向溢出`,
    );
  }
  async function testSessionExpiry() {
    for (const expiryPath of ["save", "background"] as const) {
      // Isolate from the login-rate budget consumed by preceding browser cases.
      store.db.prepare("DELETE FROM attempts").run();
      const context = await browser.newContext();
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const signIn = async () => {
        await page.getByLabel("私人随笔 · 密码").fill(password);
        await page.getByRole("button", { name: "进入", exact: true }).click();
        await page.getByLabel("此刻，想记下什么？").waitFor();
      };
      await page.goto(config.origin);
      await signIn();
      const draft = page.getByLabel("此刻，想记下什么？");
      const original = `认证过期 ${expiryPath} 待确认正文`;
      const edited = original + "；新草稿也要恢复";
      const submissions: { key: string | undefined; text: string }[] = [];
      let dropped = false;
      await page.route("**/api/entries", async (route) => {
        if (route.request().method() !== "POST") {
          await route.continue();
          return;
        }
        submissions.push({
          key: route.request().headers()["idempotency-key"],
          text: route.request().postDataJSON().text,
        });
        if (!dropped) {
          dropped = true;
          // Commit but lose the response, leaving pending text and key in memory.
          await route.fetch();
          await route.abort("failed");
        } else await route.continue();
      });
      await draft.fill(original);
      await page.getByRole("button", { name: "完成", exact: true }).click();
      await page.waitForFunction(() =>
        document.querySelector("#status")?.textContent?.includes("输入已保留"),
      );
      await draft.fill(edited);
      store.db.prepare("UPDATE sessions SET expires=?").run(Date.now() - 1);
      const rejected = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname ===
            (expiryPath === "save" ? "/api/entries" : "/api/session") &&
          r.status() === 401,
      );
      if (expiryPath === "save")
        await page
          .getByRole("button", { name: "确认上次保存", exact: true })
          .click();
      else await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await rejected;
      await page.getByLabel("私人随笔 · 密码").waitFor();
      assert.equal(await page.locator("#nav").isVisible(), false);
      assert.equal(await page.locator("#draft").count(), 0);
      assert.equal(await page.locator("article").count(), 0);
      assert.equal(await page.locator("#dialog").isVisible(), false);
      assert.equal(await page.locator("#dialogContent").textContent(), "");
      assert.equal(
        (await page.locator("#app").textContent())?.includes(original),
        false,
      );
      let privateRequests = 0;
      page.on("request", (r) => {
        if (new URL(r.url()).pathname.startsWith("/api/")) privateRequests++;
      });
      // Even programmatic clicks on hidden navigation and background checks are inert.
      await page.evaluate(() => {
        for (const id of ["journalNav", "monthNav"])
          document.querySelector<HTMLButtonElement>("#" + id)!.click();
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.waitForTimeout(100);
      assert.equal(privateRequests, 0);
      await signIn();
      assert.equal(await draft.inputValue(), edited);
      await page
        .getByRole("button", { name: "确认上次保存", exact: true })
        .click();
      await page.waitForFunction(() =>
        document
          .querySelector("#status")
          ?.textContent?.includes("上次提交已确认"),
      );
      assert.equal(await draft.inputValue(), edited);
      assert.ok(submissions[0].key);
      assert.ok(submissions.length >= 2);
      for (const submission of submissions)
        assert.deepEqual(submission, submissions[0]);
      assert.equal(
        store.db
          .prepare("SELECT count(*) AS n FROM entries WHERE text=?")
          .get(original)?.n,
        1,
      );
      await page.getByRole("button", { name: "完成", exact: true }).click();
      await page.waitForFunction(
        () =>
          (document.querySelector("#draft") as HTMLTextAreaElement)?.value ===
          "",
      );
      assert.equal(
        store.db
          .prepare("SELECT count(*) AS n FROM entries WHERE text=?")
          .get(edited)?.n,
        1,
      );
      assert.notEqual(submissions.at(-1)!.key, submissions[0].key);
      await draft.fill("主动退出应清除的草稿");
      await page.getByRole("button", { name: "退出", exact: true }).click();
      await page.getByLabel("私人随笔 · 密码").waitFor();
      await signIn();
      assert.equal(await draft.inputValue(), "");
      assert.deepEqual(errors, []);
      await context.close();
      console.log(
        `PASS 浏览器认证过期 ${expiryPath} 401：私有界面隐藏、请求禁用、草稿/待确认正文/幂等键恢复、主动退出清除`,
      );
    }
  }
  config.llm = {
    baseUrl: "https://example.invalid/v1",
    apiKey: "mock-test-placeholder",
    model: "mock",
  };
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  page.on("dialog", (d) => void d.accept());
  await page.goto(config.origin);
  await page.getByLabel("私人随笔 · 密码").fill(password);
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.getByRole("button", { name: "AI 整理", exact: true }).waitFor();
  await page.getByRole("button", { name: "AI 整理", exact: true }).click();
  await page.getByRole("button", { name: "重新生成", exact: true }).waitFor();
  const oldSegments = await page.locator(".segment").allTextContents();
  const reportBox = await page.locator(".report").boundingBox();
  const recordsBox = await page.locator(".record-heading").boundingBox();
  assert.ok(reportBox && recordsBox && reportBox.y < recordsBox.y);
  assert.equal(
    await page.getByRole("button", { name: "回看", exact: true }).count(),
    0,
  );
  await page.locator(".segment").first().click();
  await page.locator("#dialog").waitFor();
  const today = (
    await (await page.request.get(config.origin + "/api/session")).json()
  ).today;
  for (const entry of store.entries(today))
    assert.ok(
      (await page.locator("#dialogContent").textContent())?.includes(
        entry.text,
      ),
    );
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  let failRelease!: () => void;
  modelGate = new Promise<void>((resolve) => {
    failRelease = resolve;
  });
  modelFails = true;
  const failedGeneration = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/generate",
  );
  await page.getByRole("button", { name: "重新生成", exact: true }).click();
  await page
    .getByText("正在生成新一轮整理，以下是上一次整理。", { exact: true })
    .waitFor();
  assert.deepEqual(
    await page.locator(".segment").allTextContents(),
    oldSegments,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "重新生成", exact: true })
      .isDisabled(),
    true,
  );
  failRelease();
  assert.equal((await failedGeneration).status(), 503);
  await page.getByText(/^本次生成失败：.*以下是上一次整理。$/).waitFor();
  assert.deepEqual(
    await page.locator(".segment").allTextContents(),
    oldSegments,
  );
  modelGate = null;
  modelFails = false;
  await page.getByRole("button", { name: "洞察", exact: true }).click();
  await page.getByRole("button", { name: "AI 整理", exact: true }).click();
  await page.getByText("mock 材料有限", { exact: true }).waitFor();
  assert.equal(
    await page.getByText("AI 提出的可能解释", { exact: true }).count(),
    0,
  );
  assert.equal(await page.getByText(/^其他解释 \/ 局限：/).count(), 0);
  assert.equal(await page.getByText(/^追问：/).count(), 0);
  assert.ok(
    (await page.getByText("事实 / 原文表达", { exact: true }).count()) > 0,
  );
  assert.ok((await page.locator("blockquote").count()) > 0);
  console.log("PASS 洞察非核心字段缺失/空白隐藏，事实和精确证据保留");
  assert.equal(await page.locator("progress").getAttribute("value"), "2");
  assert.equal(
    await page.evaluate(() => (window as unknown as { evil?: number }).evil),
    undefined,
  );
  await page.getByRole("button", { name: "随笔", exact: true }).click();
  const rows = page.locator("article.entry");
  await rows.nth(1).waitFor();
  assert.ok((await rows.count()) >= 2);
  const firstId = (await rows.first().getAttribute("id"))!.slice(6);
  const selectedRow = rows.nth(1);
  const selectedId = (await selectedRow.getAttribute("id"))!.slice(6);
  const background = async (index: number) =>
    rows
      .nth(index)
      .locator(".entry-select")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
  assert.equal(await background(0), "rgba(0, 0, 0, 0)");
  await selectedRow.locator(".entry-select").click();
  assert.equal(await background(1), "rgba(0, 0, 0, 0)");
  await rows.first().locator(".entry-select").click();
  assert.equal(await background(0), "rgba(0, 0, 0, 0)");
  await selectedRow.locator(".entry-select").click();
  assert.equal(await background(1), "rgba(0, 0, 0, 0)");
  const preview = (await selectedRow.locator(".entry-body").textContent())!;
  assert.ok(
    (await page.locator(".entry-menu p").textContent())?.includes(
      preview.slice(0, 24),
    ),
  );
  assert.equal(
    await selectedRow.locator(".entry-select").getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(
    await rows.first().locator(".entry-select").getAttribute("aria-pressed"),
    "false",
  );
  assert.equal(await page.locator(".record-heading .entry-tools").count(), 1);
  await page.locator(".record-heading summary").click();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  assert.equal(store.get(selectedId), undefined);
  assert.ok(store.get(firstId));
  await page
    .getByText("生成后原文有删除，以下是上一次整理。", {
      exact: true,
    })
    .waitFor();
  assert.deepEqual(
    await page.locator(".segment").allTextContents(),
    oldSegments,
  );
  await page.locator(".segment").first().click();
  await page.getByText("原文已删除", { exact: true }).waitFor();
  assert.ok(
    (await page.locator("#dialogContent").textContent())?.includes(
      store.get(firstId)!.text,
    ),
  );
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "洞察", exact: true }).click();
  await page
    .getByText("生成后原文有删除，以下是上一次整理。", {
      exact: true,
    })
    .waitFor();
  assert.equal(await page.locator("progress").count(), 1);
  await context.close();
  console.log(
    "PASS 浏览器 mock AI：布局顺序、分段多来源/已删除弹窗、生成中与失败保留旧正文、月度图表、模型 XSS、删除后日/月保留",
  );
  const regression = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const p = await regression.newPage();
  p.on("dialog", (d) => void d.accept());
  await p.goto(config.origin);
  await p.getByLabel("私人随笔 · 密码").fill(password);
  await p.getByRole("button", { name: "进入", exact: true }).click();
  const draft = p.getByLabel("此刻，想记下什么？");
  await draft.waitFor();
  let failed = false;
  await p.route("**/api/entries", async (route) => {
    if (route.request().method() === "POST" && !failed) {
      failed = true;
      await route.abort("failed");
    } else await route.continue();
  });
  const original = "失败前的原文",
    edited = original + "，失败后新写的内容不能丢失";
  await draft.fill(original);
  await p.getByRole("button", { name: "完成", exact: true }).click();
  await p.waitForFunction(() =>
    document.querySelector("#status")?.textContent?.includes("输入已保留"),
  );
  await draft.fill(edited);
  await p.getByRole("button", { name: "确认上次保存", exact: true }).click();
  await p.waitForFunction(() =>
    document.querySelector("#status")?.textContent?.includes("上次提交已确认"),
  );
  assert.equal(await draft.inputValue(), edited);
  assert.equal(
    store.db
      .prepare("SELECT count(*) AS n FROM entries WHERE text=?")
      .get(original)?.n,
    1,
  );
  assert.equal(
    store.db
      .prepare("SELECT count(*) AS n FROM entries WHERE text=?")
      .get(edited)?.n,
    0,
  );
  await p.getByRole("button", { name: "完成", exact: true }).click();
  await p.waitForFunction(
    () =>
      (document.querySelector("#draft") as HTMLTextAreaElement)?.value === "",
  );
  assert.equal(
    store.db
      .prepare("SELECT count(*) AS n FROM entries WHERE text=?")
      .get(edited)?.n,
    1,
  );
  const regenerated = p.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/generate",
  );
  await p.getByRole("button", { name: "重新生成", exact: true }).click();
  await regenerated;
  await p.getByRole("button", { name: "重新生成", exact: true }).waitFor();
  let captured!: () => void, release!: () => void, finished!: () => void;
  const capturedPromise = new Promise<void>((r) => {
      captured = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    }),
    finishedPromise = new Promise<void>((r) => {
      finished = r;
    });
  await p.route("**/api/entries/*", async (route) => {
    const response = await route.fetch();
    captured();
    await gate;
    try {
      await route.fulfill({ response });
    } catch {
      /* Browser aborted the request on logout. */
    } finally {
      finished();
    }
  });
  await p.locator(".segment").first().click();
  await capturedPromise;
  await p.getByRole("button", { name: "退出", exact: true }).click();
  await p.getByLabel("私人随笔 · 密码").waitFor();
  release();
  await finishedPromise;
  await p.waitForTimeout(100);
  assert.equal(await p.locator("#dialog").isVisible(), false);
  assert.equal(await p.locator("#dialogContent").textContent(), "");
  assert.equal(await p.locator("article").count(), 0);
  assert.equal(
    (await p.request.get(config.origin + "/api/session")).status(),
    401,
  );
  await p.unroute("**/api/entries/*");
  await p.getByLabel("私人随笔 · 密码").fill(password);
  await p.getByRole("button", { name: "进入", exact: true }).click();
  await draft.waitFor();
  await draft.fill("跨午夜仍保留的草稿");
  const current = await (
    await p.request.get(config.origin + "/api/session")
  ).json();
  const nextDay = new Date(Date.parse(current.today + "T00:00:00Z") + 86400000)
    .toISOString()
    .slice(0, 10);
  store.create(
    "新日期记录应该出现在今天",
    "next-day-browser-entry",
    new Date(nextDay + "T00:00:00+08:00"),
  );
  await p.route("**/api/session", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      json: { ...(await response.json()), today: nextDay },
    });
  });
  await p.getByRole("button", { name: "随笔", exact: true }).click();
  await p.getByRole("button", { name: "随笔", exact: true }).click();
  await p.getByText("新日期记录应该出现在今天", { exact: true }).waitFor();
  assert.equal(await draft.inputValue(), "跨午夜仍保留的草稿");
  assert.equal(await p.locator("article").count(), 1);
  await p.getByRole("button", { name: "AI 整理", exact: true }).click();
  await p.getByRole("button", { name: "重新生成", exact: true }).waitFor();
  assert.equal(store.latestReady("day", nextDay)?.state, "ready");
  await regression.close();
  console.log(
    "PASS 独立审查回归：失败后继续编辑不丢草稿、退出取消延迟来源请求、跨午夜首页/日整理更新且保留草稿",
  );
  await testSessionExpiry();
  store.db.prepare("DELETE FROM attempts").run();
  store.create(
    "按指定日期补录的原文",
    "browser-date-only-import",
    new Date("2026-10-07T08:00:00Z"),
    "2026-10-04",
  );
  const backfill = await browser.newContext();
  const importedPage = await backfill.newPage();
  await importedPage.goto(config.origin);
  await importedPage.getByLabel("私人随笔 · 密码").fill(password);
  await importedPage.getByRole("button", { name: "进入", exact: true }).click();
  await importedPage.locator(".segment").first().waitFor();
  const previousText = await importedPage.locator(".segment").allTextContents();
  const serverToday = (
    await (
      await importedPage.request.get(config.origin + "/api/session")
    ).json()
  ).today;
  await importedPage.getByLabel("已有记录的日期").selectOption("2026-10-04");
  await importedPage
    .getByText("按指定日期补录的原文", { exact: true })
    .waitFor();
  assert.match(
    (await importedPage.locator(".entry-select .meta").first().textContent())!,
    /2026-10-04 · 补录 · 时间未记录/,
  );
  importedPage.on("dialog", (dialog) => void dialog.accept());
  await importedPage
    .getByRole("button", { name: "AI 整理", exact: true })
    .click();
  await importedPage.locator(".segment").first().waitFor();
  let releaseOldDay!: () => void;
  modelGate = new Promise<void>((resolve) => {
    releaseOldDay = resolve;
  });
  const oldGeneration = importedPage.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/generate",
  );
  await importedPage
    .getByRole("button", { name: "重新生成", exact: true })
    .click();
  await importedPage
    .getByText("正在生成新一轮整理，以下是上一次整理。", { exact: true })
    .waitFor();
  await importedPage
    .getByLabel("此刻，想记下什么？")
    .fill("浏览旧日期时写的新记录");
  await importedPage.getByRole("button", { name: "完成", exact: true }).click();
  await importedPage
    .getByText("浏览旧日期时写的新记录", { exact: true })
    .waitFor();
  await importedPage
    .getByText("整理后有新内容，以下是上一次整理。", { exact: true })
    .waitFor();
  assert.equal(
    await importedPage.getByLabel("查看日期").inputValue(),
    serverToday,
  );
  assert.equal(
    store.db
      .prepare("SELECT day FROM entries WHERE text=?")
      .get("浏览旧日期时写的新记录")?.day,
    serverToday,
  );
  assert.deepEqual(
    await importedPage.locator(".segment").allTextContents(),
    previousText,
  );
  async function assertTodayRange() {
    assert.equal(
      await importedPage.getByLabel("查看日期").inputValue(),
      serverToday,
    );
    assert.equal(
      await importedPage.locator(".record-heading h2").textContent(),
      `${serverToday} · 原始记录`,
    );
    const recordDates = await importedPage
      .locator(".entry-select .meta")
      .allTextContents();
    assert.ok(recordDates.length > 0);
    assert.ok(
      recordDates.every((text) => text.startsWith(serverToday + " · ")),
    );
    assert.ok(
      (await importedPage.locator(".entry-body").allTextContents()).includes(
        "浏览旧日期时写的新记录",
      ),
    );
    assert.ok(
      (await importedPage.locator(".report > .meta").textContent())!.startsWith(
        serverToday + " · ",
      ),
    );
    assert.deepEqual(
      await importedPage.locator(".segment").allTextContents(),
      previousText,
    );
  }
  // Observe past the old range's 2.5-second polling interval, not just immediately after save.
  for (let i = 0; i < 11; i++) {
    await assertTodayRange();
    await importedPage.waitForTimeout(300);
  }
  const statusBeforeOldCompletion = await importedPage
    .locator("#status")
    .textContent();
  modelGate = null;
  releaseOldDay();
  await oldGeneration;
  await importedPage.waitForTimeout(350);
  assert.equal(
    await importedPage.locator("#status").textContent(),
    statusBeforeOldCompletion,
  );
  await assertTodayRange();
  assert.equal(store.latestJob("day", "2026-10-04")?.state, "ready");
  console.log(
    "PASS 慢生成范围隔离：旧日生成中保存回今天，超过旧轮询周期及生成完成后日期/原文/整理始终一致",
  );
  await importedPage.getByRole("button", { name: "洞察", exact: true }).click();
  await importedPage
    .getByText("本次回顾后有新内容，以下是上一次回顾。", { exact: true })
    .waitFor();
  await importedPage.getByText("mock 材料有限", { exact: true }).waitFor();
  // Leaving 随笔 for 洞察 and coming back keeps the day being viewed.
  await importedPage.getByRole("button", { name: "随笔", exact: true }).click();
  await importedPage.getByLabel("查看日期").fill("2026-10-04");
  const backfilled = importedPage
    .locator(".entry-body")
    .getByText("按指定日期补录的原文", { exact: true });
  await backfilled.waitFor();
  await importedPage.getByRole("button", { name: "洞察", exact: true }).click();
  await importedPage.getByRole("button", { name: "随笔", exact: true }).click();
  await backfilled.waitFor();
  assert.equal(
    await importedPage.getByLabel("查看日期").inputValue(),
    "2026-10-04",
  );
  assert.equal(
    await importedPage.locator(".record-heading h2").textContent(),
    "2026-10-04 · 原始记录",
  );
  await backfill.close();
  console.log("PASS 切页保留日期：洞察返回随笔仍在原查看日期");
  console.log(
    "PASS 合并页：旧日期写作按服务端今天保存、返回今天；新增后日/月提示且保留旧正文",
  );
  console.log("PASS 浏览器日期补录：按指定日期回看，不显示编造的记录时刻");
  const parallel = await browser.newContext();
  const pp = await parallel.newPage();
  pp.on("dialog", (d) => void d.accept());
  await pp.goto(config.origin);
  await pp.getByLabel("私人随笔 · 密码").fill(password);
  await pp.getByRole("button", { name: "进入", exact: true }).click();
  let releaseDay!: () => void, releaseMonth!: () => void;
  dayGate = new Promise<void>((r) => {
    releaseDay = r;
  });
  monthGate = new Promise<void>((r) => {
    releaseMonth = r;
  });
  const dayResponse = pp.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/generate" &&
      r.request().postDataJSON().kind === "day",
  );
  await pp.getByRole("button", { name: "重新生成", exact: true }).click();
  await pp
    .getByText("正在生成新一轮整理，以下是上一次整理。", { exact: true })
    .waitFor();
  const parallelDraft = pp.getByLabel("此刻，想记下什么？");
  await parallelDraft.fill("并行任务切页草稿");
  await pp.getByRole("button", { name: "洞察", exact: true }).click();
  assert.equal(
    await pp
      .getByRole("button", { name: "重新生成", exact: true })
      .isDisabled(),
    false,
  );
  const monthResponse = pp.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/generate" &&
      r.request().postDataJSON().kind === "month",
  );
  await pp.getByRole("button", { name: "重新生成", exact: true }).click();
  await pp
    .getByText("正在生成新一轮整理，以下是上一次整理。", { exact: true })
    .waitFor();
  assert.equal(store.latestJob("day", today)?.state, "running");
  assert.equal(store.latestJob("month", today.slice(0, 7))?.state, "running");
  await pp.getByRole("button", { name: "随笔", exact: true }).click();
  assert.equal(await parallelDraft.inputValue(), "并行任务切页草稿");
  assert.equal(
    await pp
      .getByRole("button", { name: "重新生成", exact: true })
      .isDisabled(),
    true,
  );
  releaseMonth();
  assert.equal((await monthResponse).status(), 200);
  assert.equal(store.latestJob("day", today)?.state, "running");
  await pp.waitForTimeout(2800);
  assert.equal(await pp.getByText("mock 材料有限", { exact: true }).count(), 0);
  assert.equal(await parallelDraft.inputValue(), "并行任务切页草稿");
  releaseDay();
  assert.equal((await dayResponse).status(), 200);
  await pp
    .getByRole("button", { name: "重新生成", exact: true })
    .waitFor({ state: "visible" });
  await pp.getByRole("button", { name: "洞察", exact: true }).click();
  await pp.getByText("mock 材料有限", { exact: true }).waitFor();
  assert.equal(
    await pp
      .getByRole("button", { name: "重新生成", exact: true })
      .isDisabled(),
    false,
  );
  await pp.getByRole("button", { name: "随笔", exact: true }).click();
  assert.equal(await parallelDraft.inputValue(), "并行任务切页草稿");
  dayGate = null;
  monthGate = null;
  await parallel.close();
  console.log(
    "PASS 浏览器并行：日/月同时运行、切页按钮独立、旧完成与轮询不覆盖当前范围、草稿保留",
  );
  await reportErrors(browser);
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
