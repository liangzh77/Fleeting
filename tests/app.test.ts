import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { createApp } from "../src/app.js";
import { hashPassword, verifyPassword } from "../src/auth.js";
import { localDate, validDay } from "../src/config.js";
import { Store } from "../src/store.js";
import { Ai, themeCounts } from "../src/ai.js";
import type { Config } from "../src/config.js";
const password = "test-only-not-a-credential";
async function fixture(
  fetcher?: typeof fetch,
  configured = false,
  origin = "http://localhost:3000",
) {
  const dir = mkdtempSync(join(tmpdir(), "fleeting-test-"));
  const config: Config = {
    origin,
    timezone: "Asia/Shanghai",
    database: join(dir, "test.sqlite"),
    passwordHash: await hashPassword(password),
    llm: configured
      ? {
          baseUrl: "https://example.invalid/v1",
          apiKey: "mock-test-placeholder",
          model: "mock",
        }
      : { baseUrl: "", apiKey: "", model: "" },
  };
  const store = new Store(config.database, config.timezone),
    server = createApp(config, store, fetcher).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  let cookie = "",
    csrf = "";
  async function req(
    path: string,
    method = "GET",
    body?: unknown,
    extra: Record<string, string> = {},
  ) {
    return fetch(base + "/api" + path, {
      method,
      headers: {
        Origin: config.origin,
        Cookie: cookie,
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function login() {
    const res = await req("/login", "POST", { password });
    assert.equal(res.status, 200);
    cookie = res.headers.get("set-cookie")!.split(";")[0];
    const session = await (await req("/session")).json();
    csrf = session.csrf;
    return res;
  }
  async function close() {
    await new Promise<void>((r, reject) =>
      server.close((e) => (e ? reject(e) : r())),
    );
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return { dir, store, config, req, login, close, base };
}
const jsonResponse = (o: unknown) =>
  new Response(
    JSON.stringify({
      choices: [
        { finish_reason: "stop", message: { content: JSON.stringify(o) } },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
const mock: typeof fetch = async (_url, init) => {
  const payload = JSON.parse(init!.body as string),
    prompt: string = payload.messages[0].content,
    input = JSON.parse(payload.messages[1].content);
  if (prompt.includes("按每条原文抽取"))
    return jsonResponse({
      entries: input.map((e: { id: string; text: string }) => ({
        id: e.id,
        themes: ["生活", "生活", e.text.includes("AI") ? "AI" : "亲子"],
        points: e.text.slice(0, 1000),
      })),
    });
  if (prompt.includes("生成月度回顾")) {
    const evidence = input.originals.map((e: { id: string; text: string }) => ({
      id: e.id,
      quote: e.text,
    }));
    const insight = {
      fact: "记录中的自述",
      hypothesis: "可能存在联系，尚待验证",
      limitation: "材料较少，非诊断",
      question: "还有哪些不同情境？",
      evidence,
    };
    return jsonResponse({
      total: 99999,
      themes: [{ name: "模型猜计数", count: 99999 }],
      overview: "材料较少，仅初步归纳",
      insights: [insight, insight],
      changes: [insight],
      connections: [insight],
      questions: [{ text: "尚未在记录中见到回答", evidence }],
    });
  }
  const entries = input.originals || input;
  return jsonResponse({
    sections: entries.map((e: { id: string; time: string; text: string }) => ({
      period: e.time,
      segments: (e.text.match(/[\s\S]{1,4000}/g) || []).map((text) => ({
        text,
        sources: [e.id],
      })),
    })),
  });
};
test("允许短密码但拒绝空密码", async () => {
  await assert.rejects(hashPassword(""), /不能为空/);
  const hash = await hashPassword("7");
  assert.equal(await verifyPassword("7", hash), true);
  assert.equal(await verifyPassword("", hash), false);
});
test("时区午夜边界、合法日期与服务端记录日期", () => {
  assert.equal(
    localDate("2026-10-06T15:59:59Z", "Asia/Shanghai"),
    "2026-10-06",
  );
  assert.equal(
    localDate("2026-10-06T16:00:00Z", "Asia/Shanghai"),
    "2026-10-07",
  );
  assert.equal(
    localDate("2026-10-07T00:00:00Z", "America/Los_Angeles"),
    "2026-10-06",
  );
  assert.equal(validDay("2026-02-30"), false);
  assert.equal(validDay("2024-02-29"), true);
  const store = new Store(":memory:", "Asia/Shanghai");
  try {
    store.create("午夜前", "boundary-before", new Date("2026-10-06T15:59:59Z"));
    store.create("午夜后", "boundary-after", new Date("2026-10-06T16:00:00Z"));
    assert.equal(store.entries("2026-10-06").length, 1);
    assert.equal(store.entries("2026-10-07").length, 1);
  } finally {
    store.close();
  }
});
test("旧数据库迁移和按日期补录：不编造时间，重复导入不重复，AI 仍可整理", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fleeting-legacy-"));
  const path = join(dir, "old.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(
    "CREATE TABLE entries(id TEXT PRIMARY KEY,text TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,day TEXT NOT NULL,version INTEGER NOT NULL)",
  );
  legacy.close();
  const migrated = new Store(path, "Asia/Shanghai");
  try {
    assert.equal(
      (
        migrated.db.prepare("PRAGMA table_info(entries)").all() as {
          name: string;
        }[]
      ).some((c) => c.name === "timeUnknown"),
      true,
    );
    assert.equal(migrated.create("普通记录", "ordinary").entry?.timeUnknown, 0);
    assert.throws(() =>
      migrated.create("错误日期", "bad-date", new Date(), "2026-02-30"),
    );
  } finally {
    migrated.close();
    rmSync(dir, { recursive: true, force: true });
  }
  const f = await fixture(mock, true);
  try {
    const day = "2026-10-04";
    const created = f.store.create(
      "补录原文，不知道具体几点。",
      "date-only-test-key",
      new Date("2026-10-07T05:00:00Z"),
      day,
    );
    assert.equal(created.entry?.day, day);
    assert.equal(created.entry?.timeUnknown, 1);
    assert.equal(created.entry?.createdAt, "2026-10-07T05:00:00.000Z");
    assert.equal(
      f.store.create(
        "补录原文，不知道具体几点。",
        "date-only-test-key",
        new Date(),
        day,
      ).replay,
      true,
    );
    assert.equal(f.store.entries(day).length, 1);
    await f.login();
    const exported = await (
      await f.req(`/export?day=${day}&format=markdown`)
    ).text();
    assert.match(exported, /2026-10-04 · 补录 · 时间未记录/);
    assert.doesNotMatch(exported, /13:00/);
    await new Ai(f.store, f.config, mock).generate("day", day);
    const result = JSON.parse(f.store.latestReady("day", day)!.data!);
    assert.equal(result.sections[0].period, "时间未记录（补录）");
  } finally {
    await f.close();
  }
});
test("全私有接口鉴权、Origin、CSRF、会话 Cookie 与退出", async () => {
  const f = await fixture();
  try {
    for (const [path, method, body] of [
      ["/session", "GET"],
      ["/entries?day=2026-10-07", "GET"],
      ["/dates", "GET"],
      ["/entries/id", "GET"],
      ["/export", "GET"],
      ["/result?kind=day&period=2026-10-07", "GET"],
      ["/entries", "POST", { text: "secret" }],
      ["/entries/id", "PUT", { text: "secret" }],
      ["/entries/id", "DELETE", { version: 1 }],
      ["/generate", "POST", { kind: "day", period: "2026-10-07" }],
    ] as const)
      assert.equal((await f.req(path, method, body)).status, 401, path);
    assert.equal(
      (
        await f.req(
          "/login",
          "POST",
          { password },
          { Origin: "https://evil.invalid" },
        )
      ).status,
      403,
    );
    const login = await f.login();
    const cookie = login.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.equal(
      (await f.req("/entries", "POST", { text: "a" }, { "X-CSRF-Token": "" }))
        .status,
      403,
    );
    assert.equal(
      (await f.req("/logout", "POST", {}, { Origin: "" })).status,
      403,
    );
    assert.equal((await f.req("/logout", "POST", {})).status, 200);
    assert.equal((await f.req("/export")).status, 401);
  } finally {
    await f.close();
  }
});
test("HTTPS Cookie、安全响应头与密码变更撤销会话", async () => {
  const f = await fixture(undefined, false, "https://notes.example.org");
  try {
    const res = await f.login();
    assert.match(res.headers.get("set-cookie")!, /^__Host-fleeting=/);
    assert.match(res.headers.get("set-cookie")!, /; Secure/);
    assert.match(
      res.headers.get("content-security-policy")!,
      /frame-ancestors 'none'/,
    );
    assert.match(res.headers.get("strict-transport-security")!, /max-age=/);
    f.config.passwordHash = await hashPassword("changed-test-only-password");
    createApp(f.config, f.store);
    assert.equal((await f.req("/session")).status, 401);
  } finally {
    await f.close();
  }
});
test("数据库重开保持原文，时区禁止静默更换，重启将未完成任务标失败", async () => {
  const f = await fixture();
  try {
    const entry = f.store.create("持久化恢复样例", "persistence-entry").entry!;
    f.store.db
      .prepare("INSERT INTO results VALUES (?,?,?,?,?,?,?,?,?)")
      .run(
        "previous-ready",
        "day",
        entry.day,
        "ready",
        "snapshot",
        '{"sections":[],"sources":[]}',
        "mock",
        new Date().toISOString(),
        null,
      );
    f.store.db
      .prepare("INSERT INTO results VALUES (?,?,?,?,?,?,?,?,?)")
      .run(
        "legacy-stale",
        "day",
        entry.day,
        "stale",
        "snapshot",
        null,
        "mock",
        new Date().toISOString(),
        null,
      );
    f.store.db
      .prepare("INSERT INTO results VALUES (?,?,?,?,?,?,?,?,?)")
      .run(
        "restart-job",
        "day",
        entry.day,
        "running",
        "snapshot",
        null,
        "mock",
        new Date().toISOString(),
        null,
      );
    const reopened = new Store(f.config.database, "Asia/Shanghai");
    try {
      assert.equal(reopened.get(entry.id)?.text, entry.text);
      assert.equal(reopened.latestJob("day", entry.day)?.state, "failed");
      assert.equal(
        reopened.latestReady("day", entry.day)?.data,
        '{"sections":[],"sources":[]}',
      );
      assert.equal(
        reopened.db.prepare("SELECT id FROM results WHERE state='stale'").get(),
        undefined,
      );
    } finally {
      reopened.close();
    }
    assert.throws(() => new Store(f.config.database, "UTC"), /时区已固定/);
  } finally {
    await f.close();
  }
});
test("AI 超限在上传前拒绝", async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    throw new Error("should not send");
  }, true);
  try {
    for (let n = 0; n < 16; n++)
      f.store.create("x".repeat(8000), "oversize-entry-" + n);
    const day = f.store.db.prepare("SELECT day FROM entries LIMIT 1").get()!
      .day as string;
    await assert.rejects(
      new Ai(f.store, f.config, async () => {
        calls++;
        throw new Error("should not send");
      }).generate("day", day),
      /12 万/,
    );
    assert.equal(calls, 0);
  } finally {
    await f.close();
  }
});
test("登录限速对并行失败请求生效", async () => {
  const f = await fixture();
  try {
    const statuses = await Promise.all(
      Array.from(
        { length: 12 },
        async () =>
          (await f.req("/login", "POST", { password: "wrong" })).status,
      ),
    );
    assert.equal(statuses.filter((s) => s === 401).length, 8);
    assert.equal(statuses.filter((s) => s === 429).length, 4);
    const blocked = await f.req("/login", "POST", { password });
    assert.equal(blocked.status, 429);
    const seconds = Number(blocked.headers.get("Retry-After"));
    assert.ok(seconds >= 1 && seconds <= 30);
    assert.match(
      (await blocked.json()).error,
      new RegExp(`${seconds} 秒后再试`),
    );
    const oldExpiry = Date.now() + 900_000;
    f.store.db.prepare("UPDATE attempts SET until=?").run(oldExpiry);
    createApp(f.config, f.store); // restarting a newer release caps old 15-minute locks
    const capped = f.store.db.prepare("SELECT until FROM attempts").get() as {
      until: number;
    };
    assert.ok(capped.until <= Date.now() + 30_000);
    assert.ok(capped.until > Date.now());
    f.store.db.prepare("UPDATE attempts SET until=?").run(Date.now() - 1);
    assert.equal((await f.req("/login", "POST", { password })).status, 200);
  } finally {
    await f.close();
  }
});
test("经可信代理时登录限速按客户端地址区分", async () => {
  const f = await fixture();
  try {
    const viaProxy = (ip: string) => ({ "X-Forwarded-For": ip });
    for (let i = 0; i < 8; i += 1) {
      const res = await f.req(
        "/login",
        "POST",
        { password: "wrong" },
        viaProxy("203.0.113.9"),
      );
      assert.equal(res.status, 401);
    }
    const sameClient = await f.req(
      "/login",
      "POST",
      { password: "wrong" },
      viaProxy("203.0.113.9"),
    );
    assert.equal(sameClient.status, 429);
    // 另一个客户端、以及直连（回环）客户端都不应被牵连。
    assert.equal(
      (
        await f.req(
          "/login",
          "POST",
          { password: "wrong" },
          viaProxy("198.51.100.4"),
        )
      ).status,
      401,
    );
    assert.equal(
      (await f.req("/login", "POST", { password: "wrong" })).status,
      401,
    );
    assert.equal((await f.req("/login", "POST", { password })).status, 200);
    const keys = f.store.db
      .prepare("SELECT ip,count FROM attempts ORDER BY ip")
      .all() as { ip: string; count: number }[];
    assert.deepEqual(keys.map((k) => k.ip).sort(), [
      "127.0.0.1",
      "198.51.100.4",
      "203.0.113.9",
    ]);
    assert.ok(keys.every((k) => k.count <= 8));
  } finally {
    await f.close();
  }
});
test("保存原文、幂等重试、版本冲突、搜索、导出、重启与备份恢复", async () => {
  const f = await fixture();
  try {
    await f.login();
    const headers = { "Idempotency-Key": "test-idempotency-key-0001" },
      text =
        "  昨晚 3 次尝试，AI 想法？\n矛盾也保留。<script>alert(1)</script>  ";
    assert.equal(
      (await f.req("/entries", "POST", { text: " " }, headers)).status,
      400,
    );
    const first = await f.req("/entries", "POST", { text }, headers);
    assert.equal(first.status, 201);
    const { entry } = await first.json();
    assert.equal(entry.text, text);
    const replays = await Promise.all(
      Array.from({ length: 3 }, () =>
        f.req("/entries", "POST", { text }, headers),
      ),
    );
    for (const r of replays) {
      assert.equal(r.status, 200);
      assert.equal((await r.json()).entry.id, entry.id);
    }
    assert.equal(
      (await f.req("/entries", "POST", { text: "不同原文" }, headers)).status,
      409,
    );
    assert.equal(
      (await (await f.req("/entries?day=" + entry.day)).json()).length,
      1,
    );
    assert.equal(
      (await (await f.req("/entries?q=" + encodeURIComponent("昨晚"))).json())
        .length,
      1,
    );
    assert.equal(
      (await f.req("/entries/" + entry.id, "PUT", { text: "修改", version: 2 }))
        .status,
      409,
    );
    assert.equal(
      (await f.req("/entries/" + entry.id, "PUT", { text: "修改", version: 1 }))
        .status,
      200,
    );
    const exported = await (await f.req("/export")).json();
    assert.equal(exported.entries[0].text, "修改");
    assert.equal(exported.timezone, "Asia/Shanghai");
    assert.match(await (await f.req("/export?format=markdown")).text(), /修改/);
    const target = join(f.dir, "restore.sqlite");
    await backup(f.store.db, target);
    chmodSync(target, 0o600);
    const restored = new Store(target, "Asia/Shanghai");
    assert.equal(restored.get(entry.id)!.text, "修改");
    restored.close();
    const reopened = new DatabaseSync(f.config.database, { readOnly: true });
    assert.equal(
      (
        reopened.prepare("SELECT count(*) AS n FROM entries").get() as {
          n: number;
        }
      ).n,
      1,
    );
    reopened.close();
    assert.equal(
      (await f.req("/entries/" + entry.id, "DELETE", { version: 2 })).status,
      200,
    );
    const replayDeleted = await (
      await f.req("/entries", "POST", { text }, headers)
    ).json();
    assert.equal(replayDeleted.entry, null);
    assert.equal(f.store.entries(entry.day).length, 0);
  } finally {
    await f.close();
  }
});
test("缺 AI 配置和模型错误不影响记录；错误不泄漏原文/密钥", async () => {
  const f = await fixture();
  try {
    await f.login();
    const e = f.store.create("private", "test-missing-model").entry!;
    assert.equal(
      (
        await f.req("/generate", "POST", {
          kind: "day",
          period: e.day,
          consent: true,
        })
      ).status,
      503,
    );
    assert.equal(
      (await (await f.req("/entries?day=" + e.day)).json()).length,
      1,
    );
  } finally {
    await f.close();
  }
  const failed = await fixture(
    async () => new Response("provider echoed private secret", { status: 500 }),
    true,
  );
  try {
    await failed.login();
    const e = failed.store.create("private", "test-failed-model").entry!;
    assert.equal(
      (await failed.req("/generate", "POST", { kind: "day", period: e.day }))
        .status,
      400,
    );
    const res = await failed.req("/generate", "POST", {
      kind: "day",
      period: e.day,
      consent: true,
    });
    assert.equal(res.status, 503);
    assert.doesNotMatch(await res.text(), /private|secret|mock-test/);
    assert.equal(failed.store.latestJob("day", e.day)?.state, "failed");
    assert.equal(failed.store.entries(e.day).length, 1);
  } finally {
    await failed.close();
  }
});
test("mock 日整理、月度证据与数值口径；新增/修改/删除保留旧文本并报告变更方向", async () => {
  const f = await fixture(mock, true);
  try {
    await f.login();
    const a = f.store.create(
      "昨晚和孩子聊了 3 次，控制还是放手？",
      "mock-evidence-a",
      new Date("2026-10-01T00:00:00Z"),
    ).entry!;
    const b = f.store.create(
      "AI 产品想减少控制，但也担心错误。",
      "mock-evidence-b",
      new Date("2026-10-02T10:00:00Z"),
    ).entry!;
    const emptyResult = await (
      await f.req(`/result?kind=day&period=${a.day}`)
    ).json();
    assert.equal(emptyResult.state, null);
    assert.equal(emptyResult.data, null);
    assert.equal(emptyResult.outdated, false);
    assert.equal(emptyResult.change, "none");
    const generatedDay = await f.req("/generate", "POST", {
      kind: "day",
      period: a.day,
      consent: true,
    });
    assert.equal(generatedDay.status, 200, await generatedDay.text());
    const daily = await (
      await f.req("/result?kind=day&period=" + a.day)
    ).json();
    assert.equal(daily.state, "ready");
    assert.equal(daily.data.sections[0].segments[0].text, a.text);
    assert.equal(daily.data.sources[0].version, 1);
    assert.equal(
      (
        await f.req("/generate", "POST", {
          kind: "month",
          period: "2026-10",
          consent: true,
        })
      ).status,
      200,
    );
    const monthly = await (
      await f.req("/result?kind=month&period=2026-10")
    ).json();
    assert.equal(monthly.data.total, 2);
    assert.equal(monthly.data.activeDays, 2);
    assert.equal(
      monthly.data.themes.find((t: { name: string }) => t.name === "生活")
        .count,
      2,
    );
    assert.equal(monthly.data.insights.length, 2);
    assert.equal(monthly.data.insights[0].evidence[0].day, "2026-10-01");
    const check = async (
      kind: string,
      period: string,
      old: unknown,
      change: string,
    ) => {
      const result = await (
        await f.req(`/result?kind=${kind}&period=${period}`)
      ).json();
      assert.deepEqual(result.data, old);
      assert.equal(result.outdated, true);
      assert.equal(result.change, change);
      assert.equal(result.state, "ready");
    };
    f.store.update(a.id, "修改后的私人内容", 1);
    await check("day", a.day, daily.data, "added");
    await check("month", "2026-10", monthly.data, "added");
    f.store.delete(b.id, 1);
    await check("month", "2026-10", monthly.data, "mixed");
    const added = f.store.create(
      "新增",
      "mock-new-retain",
      new Date("2026-10-01T12:00:00Z"),
    ).entry!;
    await check("day", a.day, daily.data, "added");
    await new Ai(f.store, f.config, mock).generate("day", a.day);
    const refreshed = await (
      await f.req(`/result?kind=day&period=${a.day}`)
    ).json();
    assert.equal(refreshed.outdated, false);
    await new Ai(f.store, f.config, mock).generate("month", "2026-10");
    const refreshedMonth = await (
      await f.req("/result?kind=month&period=2026-10")
    ).json();
    f.store.delete(added.id, 1);
    await check("day", a.day, refreshed.data, "removed");
    await check("month", "2026-10", refreshedMonth.data, "removed");
    f.store.update(a.id, "再次修改", 2);
    await check("day", a.day, refreshed.data, "mixed");
    await new Ai(f.store, f.config, mock).generate("month", "2026-10");
    await new Ai(f.store, f.config, mock).generate("day", a.day);
    assert.equal(
      JSON.parse(f.store.latestReady("day", a.day)!.data!).sources.length,
      1,
    );
  } finally {
    await f.close();
  }
});
test("重新生成期间和失败后保留最近成功的日/月内容", async () => {
  const f = await fixture(mock, true);
  try {
    await f.login();
    const entry = f.store.create("保留成功内容", "retain-ready").entry!;
    for (const kind of ["day", "month"] as const) {
      const period = kind === "day" ? entry.day : entry.day.slice(0, 7);
      await new Ai(f.store, f.config, mock).generate(kind, period);
      const before = await (
        await f.req(`/result?kind=${kind}&period=${period}`)
      ).json();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pending = new Ai(f.store, f.config, async () => {
        await gate;
        return new Response("private secret", { status: 500 });
      }).generate(kind, period);
      const rejection = assert.rejects(pending, /模型服务调用失败/);
      const running = await (
        await f.req(`/result?kind=${kind}&period=${period}`)
      ).json();
      assert.equal(running.state, "running");
      assert.deepEqual(running.data, before.data);
      release();
      await rejection;
      const failed = await (
        await f.req(`/result?kind=${kind}&period=${period}`)
      ).json();
      assert.equal(failed.state, "failed");
      assert.ok(failed.error);
      assert.deepEqual(failed.data, before.data);
      assert.equal(failed.generatedAt, before.generatedAt);
      assert.equal(failed.outdated, false);
    }
  } finally {
    await f.close();
  }
});
test("主题统计按来源去重，多标签非百分比", () => {
  assert.deepEqual(
    themeCounts([
      { id: "a", themes: ["生活", "生活", "AI"] },
      { id: "b", themes: ["生活"] },
    ]).map((t) => [t.name, t.count]),
    [
      ["生活", 2],
      ["AI", 1],
    ],
  );
});
test("生成期间继续写，来源快照失效，避免旧报告被当成最新", async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => {
      entered = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  const delayed: typeof fetch = async (url, init) => {
    entered();
    await gate;
    return mock(url, init);
  };
  const f = await fixture(delayed, true);
  try {
    const e = f.store.create("初始内容", "race-source-entry").entry!;
    const ai = new Ai(f.store, f.config, delayed);
    const pending = ai.generate("day", e.day);
    await started;
    await assert.rejects(ai.generate("day", e.day), /已有生成/);
    f.store.update(e.id, "生成期间修改", 1);
    release();
    await pending;
    assert.equal(f.store.latestJob("day", e.day)?.state, "ready");
    assert.ok(f.store.latestReady("day", e.day)?.data);
    await f.login();
    const result = await (
      await f.req(`/result?kind=day&period=${e.day}`)
    ).json();
    assert.equal(result.outdated, true);
  } finally {
    release();
    await f.close();
  }
});
test("模型坏 JSON / 不合法引用 / 伪造摘录被拒绝，长材料分块覆盖", async () => {
  const f = await fixture(mock, true);
  try {
    const a = f.store.create("x".repeat(7000), "large-source-a").entry!,
      b = f.store.create("y".repeat(7000), "large-source-b").entry!;
    let calls = 0;
    const counted: typeof fetch = async (u, i) => {
      calls++;
      return mock(u, i);
    };
    await new Ai(f.store, f.config, counted).generate("day", a.day);
    assert.equal(calls, 14);
    assert.equal(
      JSON.parse(f.store.latestReady("day", a.day)!.data!).sources.length,
      2,
    );
    for (const bad of [
      async () => new Response("not json"),
      async () =>
        jsonResponse({
          sections: [
            {
              period: "上午",
              segments: [{ text: "fake", sources: ["nonexistent"] }],
            },
          ],
        }),
      async () =>
        jsonResponse({
          sections: [{ segments: [{ text: "fake", sources: [] }] }],
        }),
      async () =>
        jsonResponse({
          sections: [{ segments: [{ text: "fake", sources: [a.id] }] }],
        }),
      async () => jsonResponse({ sections: [] }),
      async () => jsonResponse({ sections: [{ segments: [] }] }),
    ] as (typeof fetch)[])
      await assert.rejects(
        new Ai(f.store, f.config, bad).generate("day", a.day),
      );
    const fabricated: typeof fetch = async (u, i) => {
      const p = JSON.parse(i!.body as string);
      if (p.messages[0].content.includes("生成月度回顾"))
        return jsonResponse({
          overview: "少量",
          insights: [
            {
              fact: "fake",
              hypothesis: "fake",
              limitation: "fake",
              question: "fake",
              evidence: [{ id: b.id, quote: "原文没有这个" }],
            },
          ],
          changes: [],
          connections: [],
          questions: [],
        });
      return mock(u, i);
    };
    await assert.rejects(
      new Ai(f.store, f.config, fabricated).generate(
        "month",
        a.day.slice(0, 7),
      ),
      /丢弃了无法落地的证据后洞察不足/,
    );
  } finally {
    await f.close();
  }
});
