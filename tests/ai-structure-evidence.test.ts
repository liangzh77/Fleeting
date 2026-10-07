import { test } from "node:test";
import assert from "node:assert/strict";
import { Ai } from "../src/ai.js";
import { Store } from "../src/store.js";
import type { Config } from "../src/config.js";
const config: Config = {
  origin: "http://localhost:3000",
  timezone: "UTC",
  database: ":memory:",
  passwordHash: "test",
  llm: { baseUrl: "https://example.invalid", apiKey: "mock", model: "mock" },
};
const reply = (data: unknown) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: "stop",
          message: { content: "```\n" + JSON.stringify(data) + "\n```" },
        },
      ],
    }),
  );

test("quote超长裁剪后仍是连续子串；裸代码围栏也可解析", async () => {
  const store = new Store(":memory:", "UTC"),
    e = store.create("甲".repeat(1999) + "乙", "a").entry!;
  let calls = 0;
  try {
    await new Ai(store, config, async (_u, init) => {
      calls++;
      const p = JSON.parse(init!.body as string),
        data = JSON.parse(p.messages[1].content);
      if (Array.isArray(data))
        return reply({
          entries: [{ id: e.id, themes: ["主题"], points: "要点" }],
        });
      const item = {
        fact: "事实",
        hypothesis: "推测",
        limitation: "局限",
        question: "问题",
        evidence: [{ id: e.id, quote: e.text + "多余尾巴" }],
      };
      return reply({
        overview: "概括",
        insights: [item],
        changes: [],
        connections: [],
        questions: [],
      });
    }).generate("month", e.day.slice(0, 7));
    assert.equal(calls, 2);
    const out = JSON.parse(
      store.latestReady("month", e.day.slice(0, 7))!.data!,
    );
    assert.equal(out.insights[0].evidence[0].quote, e.text);
  } finally {
    store.close();
  }
});

test("叶回顾不得编造来源ID；修复仍错给出字段且不泄密", async () => {
  const store = new Store(":memory:", "UTC");
  const a = store.create("甲".repeat(2000), "a").entry!,
    b = store.create("乙".repeat(2000), "b").entry!,
    c = store.create("不在本批的合成证据".repeat(200), "c").entry!;
  let repairs = 0;
  try {
    await assert.rejects(
      new Ai(store, config, async (_u, init) => {
        const p = JSON.parse(init!.body as string),
          data = JSON.parse(p.messages[1].content);
        if (Array.isArray(data))
          return reply({
            entries: data.map((e: any) => ({
              id: e.id,
              themes: ["主题"],
              points: "要点",
            })),
          });
        if (data.error) repairs++;
        const item = {
          fact: "事实",
          hypothesis: "推测",
          limitation: "局限",
          question: "问题",
          evidence: [{ id: "unknown-synthetic-id", quote: c.text.slice(0, 8) }],
        };
        return reply({
          overview: "概括",
          insights: [item, item],
          changes: [],
          connections: [],
          questions: [],
        });
      }).generate("month", a.day.slice(0, 7)),
      /月度叶回顾结构校验失败：insights\[0\]\.evidence\[0\]\.id 来源无效/,
    );
    assert.equal(repairs, 1);
    const error = store.latestJob("month", a.day.slice(0, 7))!.error!;
    assert.ok(!error.includes(c.text.slice(0, 8)));
    assert.ok(!error.includes(b.id));
  } finally {
    store.close();
  }
});
