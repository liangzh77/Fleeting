// 子路径部署回归：站点把应用挂在 /fleeting/（Caddy handle_path 剥前缀 → 本进程看到根路径）。
// 这里用一个等价的剥前缀反向代理复现生产拓扑：断言页面资源与接口都走 /fleeting/*，
// 且站内不再出现任何根路径请求（曾经 /style.css、/app.js 会打到主站 404，页面无样式无脚本）。
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { chromium } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import type { Config } from "../src/config.js";

const dir = mkdtempSync(join(tmpdir(), "fleeting-base-path-"));
const prefix = "/fleeting";
const password = "base-path-test-only-password";
let targetPort = 0;
const config: Config = {
  origin: "http://localhost:3000",
  timezone: "Asia/Shanghai",
  database: join(dir, "db.sqlite"),
  passwordHash: await hashPassword(password),
  llm: { baseUrl: "", apiKey: "", model: "" },
};
const store = new Store(config.database, config.timezone);
const mock: typeof fetch = async () => {
  throw new Error("子路径测试不应调用模型");
};
// 剥掉 prefix 后转发给应用；浏览器看到的 origin 是代理，因此 config.origin 取代理地址。
const proxy = createServer((req, res) => {
  const url = req.url || "/";
  if (url !== prefix && !url.startsWith(prefix + "/")) {
    res.statusCode = 404;
    res.end("prefix mismatch");
    return;
  }
  const upstream = httpRequest(
    {
      host: "127.0.0.1",
      port: targetPort,
      method: req.method,
      path: url.slice(prefix.length) || "/",
      headers: req.headers,
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", () => {
    res.statusCode = 502;
    res.end();
  });
  req.pipe(upstream);
});
await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
const proxyPort = (proxy.address() as { port: number }).port;
config.origin = `http://127.0.0.1:${proxyPort}`;
const server = createApp(config, store, mock).listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
targetPort = (server.address() as { port: number }).port;
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : {}),
  headless: true,
});
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  const rootRequests: string[] = [];
  const status = new Map<string, number>();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (new URL(r.url()).origin !== config.origin) return;
    const path = new URL(r.url()).pathname;
    if (path !== prefix && !path.startsWith(prefix + "/"))
      rootRequests.push(path);
  });
  page.on("response", (r) => {
    if (new URL(r.url()).origin === config.origin)
      status.set(
        `${r.request().method()} ${new URL(r.url()).pathname}`,
        r.status(),
      );
  });
  await page.goto(`${config.origin}${prefix}/`);
  await page.getByLabel("私人随笔 · 密码").waitFor();
  // 样式与脚本必须真的生效（根路径部署时这里是 404，样式全丢、脚本不执行）。
  assert.equal(status.get(`GET ${prefix}/style.css`), 200);
  assert.equal(status.get(`GET ${prefix}/app.js`), 200);
  assert.equal(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--paper")
        .trim(),
    ),
    "#f5f2ea",
  );
  assert.equal(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).backgroundColor,
    ),
    "rgb(245, 242, 234)",
  );
  assert.deepEqual(rootRequests, []);
  // 接口也必须在子路径下（config.origin 已指向代理，Origin 校验同时被验证）。
  await page.getByLabel("私人随笔 · 密码").fill(password);
  await page.getByRole("button", { name: "进入", exact: true }).click();
  const draft = page.getByLabel("此刻，想记下什么？");
  await draft.waitFor();
  await draft.fill("子路径部署回归材料");
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByText("子路径部署回归材料", { exact: true }).first().waitFor();
  assert.equal(store.db.prepare("SELECT count(*) n FROM entries").get()?.n, 1);
  assert.equal(status.get(`GET ${prefix}/api/session`), 200);
  assert.equal(status.get(`POST ${prefix}/api/entries`), 201);
  // 导出链接不能指回站点根路径。
  const exportLinks = await page
    .locator("a.download")
    .evaluateAll((nodes) =>
      nodes.map((n) => (n as HTMLAnchorElement).getAttribute("href")),
    );
  assert.equal(exportLinks.length, 2);
  assert.equal(exportLinks[0], `${prefix}/api/export?format=json`);
  assert.match(
    exportLinks[1]!,
    new RegExp(
      `^${prefix}/api/export\\?format=markdown&day=\\d{4}-\\d{2}-\\d{2}$`,
    ),
  );
  assert.deepEqual(rootRequests, []);
  assert.deepEqual(errors, []);
  console.log(
    "PASS 子路径部署：/fleeting/ 下样式脚本接口全走前缀、无根路径请求、登录保存导出正常",
  );
  await context.close();
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => proxy.close(() => r()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
