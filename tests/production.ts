import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validHash } from "../src/auth.js";
import { DatabaseSync } from "node:sqlite";
const dir = mkdtempSync(join(tmpdir(), "fleeting-production-"));
const probe = createServer();
probe.listen(0, "127.0.0.1");
await new Promise<void>((r) => probe.once("listening", r));
const port = (probe.address() as { port: number }).port;
await new Promise<void>((r) => probe.close(() => r()));
const origin = `http://127.0.0.1:${port}`,
  password = "production-smoke-test-only";
const configPath = join(dir, "config.json");
writeFileSync(
  configPath,
  JSON.stringify({
    origin,
    timezone: "Asia/Shanghai",
    database: join(dir, "db.sqlite"),
    password,
    llm: {},
  }),
  { mode: 0o600 },
);
const env = {
  ...process.env,
  FLEETING_CONFIG: configPath,
  PORT: String(port),
  HOST: "127.0.0.1",
  PASSWORD_HASH: "",
  APP_ORIGIN: "",
  APP_TIMEZONE: "",
  DATABASE_PATH: "",
  LLM_BASE_URL: "",
  LLM_API_KEY: "",
  LLM_MODEL: "",
};
let child: ReturnType<typeof spawn> | undefined;
async function start() {
  child = spawn(process.execPath, ["dist/server.js"], { env, stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(origin + "/api/session");
      if (r.status === 401) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("构建后的服务未启动");
}
async function stop() {
  const c = child;
  if (!c || c.exitCode !== null) return;
  await new Promise<void>((r) => {
    c.once("exit", () => r());
    c.kill("SIGTERM");
  });
  child = undefined;
}
async function login(secret = password) {
  const r = await fetch(origin + "/api/login", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ password: secret }),
  });
  assert.equal(r.status, 200);
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  const session = await (
    await fetch(origin + "/api/session", { headers: { Cookie: cookie } })
  ).json();
  return { cookie, session };
}
try {
  await start();
  const migrated = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal("password" in migrated, false);
  assert.ok(validHash(migrated.passwordHash));
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  const home = await (await fetch(origin)).text();
  assert.match(home, /Fleeting/);
  assert.match(home, /rel="icon" type="image\/svg\+xml" href="\/favicon\.svg"/);
  const favicon = await fetch(origin + "/favicon.svg");
  assert.equal(favicon.status, 200);
  assert.match(favicon.headers.get("content-type") || "", /image\/svg\+xml/);
  assert.match(await favicon.text(), /<svg /);
  assert.equal((await fetch(origin + "/app.js")).status, 200);
  const { cookie, session } = await login();
  const created = await fetch(origin + "/api/entries", {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: cookie,
      "X-CSRF-Token": session.csrf,
      "Content-Type": "application/json",
      "Idempotency-Key": "compiled-server-smoke-key",
    },
    body: JSON.stringify({ text: "构建产物真实存储与恢复" }),
  });
  assert.equal(created.status, 201);
  const id = (await created.json()).entry.id;
  await promisify(execFile)(
    "npm",
    ["run", "backup", "--", join(dir, "backup.sqlite")],
    { env },
  );
  const restored = new DatabaseSync(join(dir, "backup.sqlite"), {
    readOnly: true,
  });
  assert.equal(
    restored.prepare("SELECT text FROM entries WHERE id=?").get(id)!.text,
    "构建产物真实存储与恢复",
  );
  restored.close();
  await stop();
  await start();
  const again = await login();
  const original = await (
    await fetch(origin + "/api/entries/" + id, {
      headers: { Cookie: again.cookie },
    })
  ).json();
  assert.equal(original.text, "构建产物真实存储与恢复");
  await stop();
  writeFileSync(configPath, JSON.stringify({ ...migrated, password: "7" }), {
    mode: 0o600,
  });
  await start();
  const reset = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal("password" in reset, false);
  assert.notEqual(reset.passwordHash, migrated.passwordHash);
  assert.equal(
    (
      await fetch(origin + "/api/session", {
        headers: { Cookie: again.cookie },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(origin + "/api/login", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      })
    ).status,
    401,
  );
  await login("7");
  console.log(
    "PASS 编译后的服务：明文密码自动哈希并擦除、重设撤销旧会话、原文持久化与在线备份恢复",
  );
} finally {
  await stop();
  rmSync(dir, { recursive: true, force: true });
}
