import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Ai } from "../src/ai.js";
import type { Config } from "../src/config.js";
const reply = (data: unknown, length = false) =>
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
const config: Config = {
  origin: "http://localhost:3000",
  timezone: "UTC",
  database: ":memory:",
  passwordHash: "test-only",
  llm: {
    baseUrl: "https://example.invalid",
    apiKey: "test-only",
    model: "mock",
  },
};
test("日第二阶段截断也重新完成两阶段，全字符不丢", async () => {
  const store = new Store(":memory:", "UTC");
  try {
    const text = "开始" + "中".repeat(1996) + "结束";
    const e = store.create(text, "a").entry!;
    let truncated = false,
      first = 0,
      second = 0;
    await new Ai(store, config, async (_u, init) => {
      const payload = JSON.parse(init!.body as string),
        data = JSON.parse(payload.messages[1].content);
      if (data.originals) {
        second++;
        if (!truncated) {
          truncated = true;
          return reply({}, true);
        }
      } else first++;
      return reply({
        sections: (data.originals || data).map((e: any) => ({
          segments: [{ text: e.text, sources: [e.id] }],
        })),
      });
    }).generate("day", e.day);
    assert.equal(first, 3);
    assert.equal(second, 3);
    const result = JSON.parse(store.latestReady("day", e.day)!.data!);
    assert.equal(
      result.sections
        .flatMap((s: any) => s.segments)
        .map((s: any) => s.text)
        .join(""),
      text,
    );
  } finally {
    store.close();
  }
});
test("月聚合截断：压缩双方并有限重试，失败保留旧成功与完整分类", async () => {
  const store = new Store(":memory:", "UTC");
  try {
    const a = store.create("甲".repeat(2000), "a").entry!;
    const b = store.create("乙".repeat(2000), "b").entry!;
    const c = store.create("丙".repeat(2000), "c").entry!;
    let fail = false,
      aggregated = false,
      compressions = 0,
      calls = 0;
    const mock: typeof fetch = async (_u, init) => {
      calls++;
      const payload = JSON.parse(init!.body as string),
        data = JSON.parse(payload.messages[1].content),
        prompt = payload.messages[0].content;
      if (Array.isArray(data))
        return reply({
          entries: data.map((e: any) => ({
            id: e.id,
            themes: ["材料"],
            points: "保留全部材料的要点",
          })),
        });
      if (data.reviews) {
        if (fail || !aggregated) {
          aggregated = true;
          return reply({}, true);
        }
        if (prompt.includes("压缩这个回顾")) compressions++;
      }
      const evidence = data.originals
        .slice(0, 2)
        .map((e: any) => ({ id: e.id, quote: e.text.slice(0, 10) }));
      const item = {
        fact: "材料",
        hypothesis: "推测",
        limitation: "有局限",
        question: "问题",
        evidence,
      };
      return reply({
        overview: "层级归纳",
        insights: [item, item],
        changes: [],
        connections: [],
        questions: [],
      });
    };
    const ai = new Ai(store, config, mock);
    await ai.generate("month", a.day.slice(0, 7));
    assert.equal(compressions, 2);
    const ready = store.latestReady("month", a.day.slice(0, 7))!;
    const result = JSON.parse(ready.data!);
    assert.deepEqual(
      new Set(result.classifications.map((x: any) => x.id)),
      new Set([a.id, b.id, c.id]),
    );
    assert.equal(result.total, 3);
    assert.equal(result.themes[0].count, 3);
    fail = true;
    calls = 0;
    await assert.rejects(
      ai.generate("month", a.day.slice(0, 7)),
      /自动拆分\/重试/,
    );
    assert.ok(calls < 10);
    assert.equal(store.latestReady("month", a.day.slice(0, 7))!.id, ready.id);
  } finally {
    store.close();
  }
});
