import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ai } from "../src/ai.js";
import { Scheduler, yesterday } from "../src/scheduler.js";
import { Store } from "../src/store.js";
import type { Config } from "../src/config.js";
const response = (data: unknown, length = false) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: length ? "length" : "stop",
          message: { content: JSON.stringify(data) },
        },
      ],
    }),
  );
function fixture(timezone = "Asia/Shanghai") {
  const dir = mkdtempSync(join(tmpdir(), "fleeting-scheduler-"));
  const config: Config = {
    origin: "http://localhost:3000",
    timezone,
    database: join(dir, "test.sqlite"),
    passwordHash: "test-only",
    llm: {
      baseUrl: "https://example.invalid",
      apiKey: "test-only",
      model: "mock",
    },
  };
  let store = new Store(config.database, timezone);
  return {
    config,
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new Store(config.database, timezone);
    },
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
type Material = { id: string; text: string; time?: string | null };
function mock(seen: Material[] = [], truncate = false): typeof fetch {
  return async (_u, init) => {
    const body = JSON.parse(init!.body as string),
      prompt = body.messages[0].content,
      data = JSON.parse(body.messages[1].content);
    const originals: Material[] = data.originals || data;
    if (
      Array.isArray(data) &&
      truncate &&
      data.reduce((n: number, x: Material) => n + x.text.length, 0) > 800
    )
      return response({}, true);
    if (prompt.includes("按每条原文抽取")) {
      seen.push(...data);
      return response({
        entries: data.map((e: Material) => ({
          id: e.id,
          themes: ["主题"],
          points: "保留材料信息",
        })),
      });
    }
    if (prompt.includes("生成月度回顾")) {
      if (
        truncate &&
        !data.reviews &&
        originals.reduce((n, x) => n + x.text.length, 0) > 400
      )
        return response({}, true);
      const evidence = originals
        .slice(0, 2)
        .map((e) => ({ id: e.id, quote: e.text.slice(0, 50) }));
      const item = {
        fact: "事实",
        hypothesis: "推测",
        limitation: "层级归纳可能损失细节",
        question: "问题",
        evidence,
      };
      return response({
        overview: "有限材料",
        insights: [item, item],
        changes: [],
        connections: [],
        questions: [],
      });
    }
    if (!data.originals) seen.push(...data);
    return response({
      sections: originals.map((e) => ({
        segments: [{ text: e.text, sources: [e.id] }],
      })),
    });
  };
}
test("截断自动拆分：日长单条与多条完整顺序、补录语义、月分类全覆盖与证据", async () => {
  const f = fixture();
  try {
    const text = "首" + "甲".repeat(7998) + "尾";
    const a = f.store.create(text, "a", new Date(), "2026-10-06").entry!;
    const b = f.store.create("第二条尾部", "b", new Date(), a.day).entry!;
    const seen: Material[] = [];
    const ai = new Ai(f.store, f.config, mock(seen, true));
    await ai.generate("day", a.day);
    const daily = JSON.parse(f.store.latestReady("day", a.day)!.data!);
    assert.equal(
      daily.sections
        .flatMap((s: any) => s.segments)
        .filter((s: any) => s.sources[0] === a.id)
        .map((s: any) => s.text)
        .join(""),
      text,
    );
    assert.ok(
      daily.sections.every((s: any) => s.period.includes("时间未记录")),
    );
    assert.ok(daily.sections.some((s: any) => s.sources.includes(b.id)));
    seen.length = 0;
    await ai.generate("month", "2026-10");
    assert.equal(
      seen
        .filter((e) => e.id === a.id)
        .map((e) => e.text)
        .join(""),
      text,
    );
    const monthly = JSON.parse(f.store.latestReady("month", "2026-10")!.data!);
    assert.equal(monthly.total, 2);
    assert.equal(monthly.classifications.length, 2);
    assert.equal(monthly.themes[0].count, 2);
    for (const i of monthly.insights)
      for (const e of i.evidence)
        assert.ok(f.store.get(e.id)!.text.includes(e.quote));
  } finally {
    f.close();
  }
});
test("不可恢复截断有界失败、旧结果不清除", async () => {
  const f = fixture();
  try {
    const e = f.store.create("材料".repeat(1000), "a").entry!;
    await new Ai(f.store, f.config, mock()).generate("day", e.day);
    const old = f.store.latestReady("day", e.day)!.data;
    let calls = 0;
    await assert.rejects(
      new Ai(f.store, f.config, async () => {
        calls++;
        return response({}, true);
      }).generate("day", e.day),
      /自动拆分\/重试/,
    );
    assert.ok(calls <= 6);
    assert.equal(f.store.latestReady("day", e.day)!.data, old);
    assert.equal(f.store.latestJob("day", e.day)!.state, "failed");
  } finally {
    f.close();
  }
});
test("day/month 同时 running，同范围互斥；一方失败不影响另一方", async () => {
  const f = fixture();
  try {
    const e = f.store.create("测试材料", "a").entry!;
    let releaseDay!: () => void, releaseMonth!: () => void;
    const dayGate = new Promise<void>((r) => (releaseDay = r)),
      monthGate = new Promise<void>((r) => (releaseMonth = r));
    const ai = new Ai(f.store, f.config, async (u, init) => {
      const body = JSON.parse(init!.body as string);
      if (body.messages[0].content.includes("将全部记录")) {
        await dayGate;
        return new Response("test", { status: 500 });
      }
      await monthGate;
      return mock()(u, init);
    });
    const day = ai.generate("day", e.day).catch((e: Error) => e);
    const month = ai.generate("month", e.day.slice(0, 7));
    assert.equal(f.store.latestJob("day", e.day)!.state, "running");
    assert.equal(
      f.store.latestJob("month", e.day.slice(0, 7))!.state,
      "running",
    );
    await assert.rejects(ai.generate("day", e.day), /已有生成/);
    assert.equal(
      f.store.db.prepare("SELECT count(*) AS n FROM results").get()!.n,
      2,
    );
    releaseDay();
    await day;
    assert.equal(
      f.store.latestJob("month", e.day.slice(0, 7))!.state,
      "running",
    );
    releaseMonth();
    await month;
    assert.ok(f.store.latestReady("month", e.day.slice(0, 7)));
  } finally {
    f.close();
  }
});
test("日历昨天：年/月/闰日边界", () => {
  assert.equal(yesterday("2026-01-01"), "2025-12-31");
  assert.equal(yesterday("2024-03-01"), "2024-02-29");
  assert.equal(yesterday("2026-03-01"), "2026-02-28");
});
test("时区 00:59 跳过、01:00 一次、重启幂等、旧成功跳过、无配置/无记录", async () => {
  const f = fixture();
  try {
    f.store.create("昨天", "a", new Date(), "2026-10-06");
    let now = new Date("2026-10-06T16:59:00Z"),
      calls = 0;
    const fetcher: typeof fetch = async (u, init) => {
      calls++;
      return mock()(u, init);
    };
    let scheduler = new Scheduler(
      f.store,
      new Ai(f.store, f.config, fetcher),
      () => now,
    );
    await scheduler.tick();
    assert.equal(calls, 0);
    now = new Date("2026-10-06T17:00:00Z");
    await Promise.all([scheduler.tick(), scheduler.tick()]);
    assert.equal(calls, 2);
    assert.ok(f.store.latestReady("day", "2026-10-06"));
    now = new Date("2026-10-06T17:01:00Z");
    await scheduler.tick();
    assert.equal(calls, 2);
    f.reopen();
    scheduler = new Scheduler(
      f.store,
      new Ai(f.store, f.config, fetcher),
      () => now,
    );
    await scheduler.tick();
    assert.equal(calls, 2);
    // New scheduler day never backfills older dates.
    now = new Date("2026-10-07T17:01:00Z");
    await scheduler.tick();
    assert.equal(calls, 2);
    f.store.create("第二天", "b", new Date(), "2026-10-07");
    f.config.llm.model = "";
    await scheduler.tick();
    assert.equal(calls, 2);
    f.config.llm.model = "mock";
    await new Ai(f.store, f.config, fetcher).generate("day", "2026-10-07");
    const before = calls;
    await scheduler.tick();
    assert.equal(calls, before);
  } finally {
    f.close();
  }
});
test("自动失败持久幂等，手动冲突不消费机会，月任务不阻塞，DST 非本机时区", async () => {
  const f = fixture("America/New_York");
  try {
    const e = f.store.create("旧材料", "a", new Date(), "2024-03-09").entry!;
    await new Ai(f.store, f.config, mock()).generate("day", e.day);
    const old = f.store.latestReady("day", e.day)!.data;
    f.store.update(e.id, "改变材料", 1);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ai = new Ai(f.store, f.config, async (u, init) => {
      await gate;
      return mock()(u, init);
    });
    const manual = ai.generate("day", e.day);
    const now = () => new Date("2024-03-10T06:00:00Z"); // 01:00 EST before DST change
    let calls = 0;
    const failed = new Ai(f.store, f.config, async () => {
      calls++;
      return new Response("test", { status: 500 });
    });
    const scheduler = new Scheduler(f.store, failed, now, () => {});
    await scheduler.tick();
    assert.equal(calls, 0);
    assert.equal(
      f.store.db
        .prepare("SELECT key FROM meta WHERE key LIKE 'auto-day:%'")
        .get(),
      undefined,
    );
    release();
    await manual;
    const beforeFailure = f.store.latestReady("day", e.day)!.data;
    f.store.update(e.id, "再次改变", 2);
    const month = ai.generate("month", "2024-03");
    await scheduler.tick();
    assert.equal(calls, 1);
    await month;
    assert.equal(f.store.latestReady("day", e.day)!.data, beforeFailure);
    assert.notEqual(old, null);
    f.reopen();
    await new Scheduler(
      f.store,
      new Ai(f.store, f.config, async () => {
        calls++;
        return response({}, true);
      }),
      now,
      () => {},
    ).tick();
    assert.equal(calls, 1);
  } finally {
    f.close();
  }
});
