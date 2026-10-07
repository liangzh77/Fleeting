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
        { finish_reason: "stop", message: { content: JSON.stringify(data) } },
      ],
    }),
  );
for (const scenario of [
  {
    name: "空白映射（换行、制表、全角空格与代理对）",
    text: "前缀😀甲\n  乙\t丙　丁后缀",
    quote: "😀甲 \n 乙 丙 丁",
    exact: "😀甲\n  乙\t丙　丁",
  },
  {
    name: "标点映射",
    text: "前缀“甲”，乙！（丙）。后缀",
    quote: '"甲",乙!(丙).',
    exact: "“甲”，乙！（丙）。",
  },
  { name: "不归一化全角字母/数字", text: "Ａ１２", quote: "A12", exact: null },
  {
    name: "连续跨2000字分片且重复id",
    text: "甲".repeat(1998) + "边界前后引用" + "乙".repeat(2100),
    quote: "边界前后引用",
    exact: "边界前后引用",
  },
]) {
  test(`证据落地：${scenario.name}`, async () => {
    const store = new Store(":memory:", "UTC");
    const e = store.create(scenario.text, "synthetic").entry!;
    let leaves = 0,
      merges = 0;
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message) => warnings.push(String(message));
    try {
      await new Ai(store, config, async (_u, init) => {
        const p = JSON.parse(init!.body as string),
          data = JSON.parse(p.messages[1].content);
        assert.ok(!data.error, "不应发起结构修复");
        if (Array.isArray(data))
          return reply({
            entries: data.map((x: any) => ({
              id: x.id,
              themes: ["主题"],
              points: "要点",
            })),
          });
        if (data.reviews) {
          merges++;
          assert.ok(data.originals.every((x: any) => e.text.includes(x.text)));
        } else leaves++;
        const evidence = [{ id: e.id, quote: scenario.quote }];
        return reply({
          overview: "概括",
          insights: [{ fact: "事实", evidence }],
          changes: [],
          connections: [],
          questions: [{ text: "问题", evidence }],
        });
      }).generate("month", e.day.slice(0, 7));
      const out = JSON.parse(
        store.latestReady("month", e.day.slice(0, 7))!.data!,
      );
      if (scenario.exact) {
        const q = out.insights[0].evidence[0].quote;
        assert.equal(q, scenario.exact);
        assert.equal(q.length, scenario.exact.length);
        assert.ok(e.text.includes(q));
        for (const key of ["hypothesis", "limitation", "question"])
          assert.equal(out.insights[0][key], "");
      } else {
        assert.deepEqual(out.insights, []);
        assert.deepEqual(out.questions, []);
      }
      if (scenario.text.length > 4000) {
        assert.ok(leaves >= 3);
        assert.ok(merges >= 2);
      }
      assert.ok(
        warnings.every(
          (x) =>
            x.includes("月度") &&
            x.includes("evidence") &&
            !x.includes(scenario.quote),
        ),
      );
    } finally {
      console.warn = warn;
      store.close();
    }
  });
}

test("丢弃伪造证据/空条目/问题，保留一个有效洞察；零洞察失败保留旧ready", async () => {
  const store = new Store(":memory:", "UTC");
  const a = store.create("合成原文甲", "a").entry!;
  store.create("合成原文乙", "b");
  let fail = false,
    repairs = 0;
  try {
    const ai = new Ai(store, config, async (_u, init) => {
      const p = JSON.parse(init!.body as string),
        data = JSON.parse(p.messages[1].content);
      if (data.error) repairs++;
      const task = data.task ?? data;
      if (Array.isArray(task))
        return reply({
          entries: task.map((x: any) => ({
            id: x.id,
            themes: ["主题"],
            points: "要点",
          })),
        });
      const bogus = { id: a.id, quote: "不存在的模型改写" };
      return reply({
        overview: "概括",
        insights: [
          {
            fact: "有效事实",
            hypothesis: "",
            limitation: "  ",
            question: "",
            evidence: fail ? [bogus] : [bogus, { id: a.id, quote: a.text }],
          },
          { fact: "不可信", evidence: [bogus] },
          { fact: "无证据" },
        ],
        changes: [{ fact: "变化", evidence: [] }],
        connections: [],
        questions: [{ text: "问题", evidence: [bogus] }, { text: "缺证据" }],
      });
    });
    const month = a.day.slice(0, 7);
    await ai.generate("month", month);
    const ready = store.latestReady("month", month)!;
    const out = JSON.parse(ready.data!);
    assert.equal(out.insights.length, 1);
    assert.equal(out.insights[0].evidence.length, 1);
    assert.deepEqual(out.questions, []);
    assert.deepEqual(out.changes, []);
    assert.ok(!ready.data!.includes("不存在的模型改写"));
    fail = true;
    await assert.rejects(
      ai.generate("month", month),
      /月度叶回顾.*insights 丢弃了无法落地的证据后洞察不足/,
    );
    assert.equal(repairs, 1);
    assert.equal(store.latestReady("month", month)!.id, ready.id);
    assert.ok(!store.latestJob("month", month)!.error!.includes(a.text));
  } finally {
    store.close();
  }
});

test("聚合不得扩展引用至未给定的原文部分", async () => {
  const store = new Store(":memory:", "UTC");
  const e = store.create("甲".repeat(1999) + "乙".repeat(2001), "a").entry!;
  store.create("另一个记录", "b");
  try {
    await assert.rejects(
      new Ai(store, config, async (_u, init) => {
        const p = JSON.parse(init!.body as string),
          data = JSON.parse(p.messages[1].content),
          task = data.task ?? data;
        if (Array.isArray(task))
          return reply({
            entries: task.map((x: any) => ({
              id: x.id,
              themes: ["主题"],
              points: "要点",
            })),
          });
        return reply({
          overview: "概括",
          insights: [
            {
              fact: "事实",
              evidence: [{ id: e.id, quote: task.reviews ? "甲乙" : "甲" }],
            },
          ],
          changes: [],
          connections: [],
          questions: [],
        });
      }).generate("month", e.day.slice(0, 7)),
      /月度层级聚合.*洞察不足/,
    );
  } finally {
    store.close();
  }
});
