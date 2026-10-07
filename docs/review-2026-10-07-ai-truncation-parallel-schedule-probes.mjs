// Independent probes; no private config, real model or production database.
// npm run build && node --test docs/review-2026-10-07-ai-truncation-parallel-schedule-probes.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ai } from "../dist/ai.js";
import { Store } from "../dist/store.js";
import { Scheduler } from "../dist/scheduler.js";
const config = {
  origin: "http://localhost:3000",
  timezone: "UTC",
  database: ":memory:",
  passwordHash: "test-only",
  llm: { baseUrl: "https://example.invalid", apiKey: "mock", model: "mock" },
};
const reply = (data, length = false) =>
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
const decode = (init) => JSON.parse(JSON.parse(init.body).messages[1].content);
const daily = (data) => ({
  sections: (data.originals || data).map((e) => ({
    segments: [{ text: e.text, sources: [e.id] }],
  })),
});
const text = (n, length) =>
  Array.from({ length: 2000 }, (_, i) => `${n}:${i}中😀;`)
    .join("")
    .slice(0, length - 5) + "END!!";
const append = (map, entries) =>
  entries.forEach((e) => map.set(e.id, (map.get(e.id) || "") + e.text));
const complete = (map, entries) =>
  entries.forEach((e) => assert.equal(map.get(e.id), e.text));
test("independent: day first/second-stage truncation preserves every fragment in order, including surrogate boundaries", async () => {
  const store = new Store(":memory:", "UTC");
  try {
    const entries = [0, 1, 2].map(
      (n) =>
        store.create(
          text(n, 8000),
          `entry-${n}`,
          new Date(`2026-10-06T0${n}:00:00Z`),
        ).entry,
    );
    let firstTruncations = 0,
      secondTruncations = 0,
      calls = 0;
    const processed = new Map();
    await new Ai(store, config, async (_u, init) => {
      calls++;
      const data = decode(init),
        originals = data.originals || data;
      for (const e of originals) assert.equal(e.text.isWellFormed(), true);
      const size = originals.reduce((n, e) => n + e.text.length, 0);
      if (!data.originals && size > 1500) {
        firstTruncations++;
        return reply({}, true);
      }
      if (data.originals && size > 600) {
        secondTruncations++;
        return reply({}, true);
      }
      if (data.originals) append(processed, originals);
      return reply(daily(data));
    }).generate("day", entries[0].day);
    complete(processed, entries);
    const result = JSON.parse(store.latestReady("day", entries[0].day).data);
    const saved = new Map();
    append(
      saved,
      result.sections
        .flatMap((s) => s.segments)
        .map((s) => ({ id: s.sources[0], text: s.text })),
    );
    complete(saved, entries);
    assert.ok(firstTruncations > 0 && secondTruncations > 0 && calls <= 512);
    console.log(
      JSON.stringify({
        dayCalls: calls,
        firstTruncations,
        secondTruncations,
        chars: 24000,
      }),
    );
  } finally {
    store.close();
  }
});
test("independent: 120000-character month full classification/leaf coverage, bounded aggregation retry, fabricated final evidence rejected", async () => {
  const store = new Store(":memory:", "UTC");
  try {
    const entries = Array.from(
      { length: 15 },
      (_, n) =>
        store.create(
          text(n, 8000),
          `month-${n}`,
          new Date(`2026-10-${String(n + 1).padStart(2, "0")}T00:00:00Z`),
        ).entry,
    );
    const classified = new Map(),
      leaves = new Map();
    let calls = 0,
      maximum = 0,
      retried = false,
      forged = false,
      compressions = 0;
    const fetcher = async (_u, init) => {
      calls++;
      const data = decode(init),
        prompt = JSON.parse(init.body).messages[0].content;
      maximum = Math.max(maximum, JSON.stringify(data).length);
      if (Array.isArray(data)) {
        if (data.reduce((n, e) => n + e.text.length, 0) > 2000)
          return reply({}, true);
        append(classified, data);
        return reply({
          entries: data.map((e) => ({
            id: e.id,
            themes: ["all", "all"],
            points: "synthetic points",
          })),
        });
      }
      if (!data.reviews) {
        if (data.originals.reduce((n, e) => n + e.text.length, 0) > 1100)
          return reply({}, true);
        append(leaves, data.originals);
      } else {
        assert.equal(data.reviews.length <= 2, true);
        if (!retried) {
          retried = true;
          return reply({}, true);
        }
        if (prompt.includes("压缩这个回顾")) compressions++;
      }
      const originals = data.originals;
      const evidence = [originals[0], originals.at(-1)].map((e) => ({
        id: e.id,
        quote: e.text.slice(-32),
      }));
      if (forged && data.reviews)
        evidence[0].quote = "THIS_QUOTE_DOES_NOT_EXIST_IN_ANY_ORIGINAL";
      const item = {
        fact: "test",
        hypothesis: "test",
        limitation: "test",
        question: "test",
        evidence,
      };
      return reply({
        overview: "synthetic",
        insights: [item, item],
        changes: [],
        connections: [],
        questions: [],
      });
    };
    const ai = new Ai(store, config, fetcher);
    await ai.generate("month", "2026-10");
    complete(classified, entries);
    complete(leaves, entries);
    const ready = store.latestReady("month", "2026-10"),
      result = JSON.parse(ready.data);
    assert.equal(result.total, 15);
    assert.equal(result.activeDays, 15);
    assert.equal(result.themes[0].count, 15);
    assert.equal(new Set(result.classifications.map((c) => c.id)).size, 15);
    for (const i of result.insights)
      for (const e of i.evidence)
        assert.ok(store.get(e.id).text.includes(e.quote));
    assert.ok(calls <= 512 && maximum <= 60000);
    assert.equal(compressions, 2);
    console.log(
      JSON.stringify({
        monthCalls: calls,
        maxDataChars: maximum,
        compressions,
        coveredChars: 120000,
      }),
    );
    forged = true;
    await assert.rejects(ai.generate("month", "2026-10"), /原文证据校验失败/);
    assert.equal(store.latestReady("month", "2026-10").id, ready.id);
    assert.equal(store.latestJob("month", "2026-10").state, "failed");
  } finally {
    store.close();
  }
});
test("independent: hard 512-call cap stops partially successful retry tree without replacing old ready", async () => {
  const store = new Store(":memory:", "UTC");
  try {
    store.create("test item 0", "cap-0", new Date("2026-10-06T00:00:00Z"));
    await new Ai(store, config, async (_u, init) =>
      reply(daily(decode(init))),
    ).generate("day", "2026-10-06");
    const old = store.latestReady("day", "2026-10-06");
    let calls = 0;
    for (let i = 1; i < 500; i++)
      store.create(
        `test item ${i}`,
        `cap-${i}`,
        new Date("2026-10-06T00:00:00Z"),
      );
    await assert.rejects(
      new Ai(store, config, async (_u, init) => {
        calls++;
        const data = decode(init);
        return Array.isArray(data) && data.length > 1
          ? reply({}, true)
          : reply(daily(data));
      }).generate("day", "2026-10-06"),
      /自动拆分/,
    );
    assert.equal(calls, 512);
    assert.equal(store.latestReady("day", "2026-10-06").id, old.id);
    assert.equal(store.latestJob("day", "2026-10-06").state, "failed");
    console.log("hard cap = 512 calls; old ready retained");
  } finally {
    store.close();
  }
});
test("independent: durable automatic running claim survives restart; following calendar day still runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fleeting-review-restart-")),
    path = join(dir, "test.sqlite");
  let store = new Store(path, "America/New_York");
  try {
    store.create("synthetic prior day", "a", new Date(), "2025-11-01");
    const cfg = { ...config, timezone: "America/New_York" };
    const never = new Promise(() => {});
    void new Scheduler(
      store,
      new Ai(store, cfg, async () => never),
      () => new Date("2025-11-02T05:00:00Z"),
    ).tick();
    assert.equal(store.latestJob("day", "2025-11-01").state, "running");
    assert.equal(
      store.db
        .prepare("SELECT value FROM meta WHERE key=?")
        .get("auto-day:2025-11-02").value,
      "2025-11-01",
    );
    store.close();
    store = new Store(path, "America/New_York");
    assert.equal(store.latestJob("day", "2025-11-01").state, "failed");
    let calls = 0,
      clock = new Date("2025-11-02T06:00:00Z");
    const scheduler = new Scheduler(
      store,
      new Ai(store, cfg, async (_u, init) => {
        calls++;
        return reply(daily(decode(init)));
      }),
      () => clock,
    );
    await scheduler.tick();
    assert.equal(calls, 0);
    store.create("synthetic next day", "b", new Date(), "2025-11-02");
    clock = new Date("2025-11-03T06:00:00Z");
    await scheduler.tick();
    assert.equal(calls, 2);
    assert.equal(store.latestJob("day", "2025-11-02").state, "ready");
    console.log(
      "restart running -> failed; repeated DST 01:00 sends 0; next day sends 2",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
