import { test } from "node:test";
import assert from "node:assert/strict";
import { Ai } from "../src/ai.js";
import { Store } from "../src/store.js";
import type { Config } from "../src/config.js";

const config: Config = {
  origin: "http://localhost:3000",
  timezone: "UTC",
  database: ":memory:",
  passwordHash: "test-only",
  llm: { baseUrl: "https://example.invalid", apiKey: "mock", model: "mock" },
};
const reply = (data: unknown, truncated = false) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: truncated ? "length" : "stop",
          message: { content: JSON.stringify(data) },
        },
      ],
    }),
  );

for (const [name, earlier, supplied, quote] of [
  ["空白首匹配", "甲 \t乙", "甲\n乙", "甲 乙"],
  ["标点首匹配", "甲，乙！", "甲,乙！", "甲,乙!"],
  ["精确命中抢先", "甲 乙", "甲\n乙", "甲 乙"],
]) {
  for (const compress of [false, true]) {
    test(`R1 ${name}：${compress ? "压缩回顾与压缩聚合" : "层级聚合"}候选筛选及越界拒绝`, async () => {
      const store = new Store(":memory:", "UTC");
      const e = store.create(
        earlier + "填".repeat(2000) + supplied + "真正未供给",
        "a",
      ).entry!;
      store.create("另一条合成记录", "b");
      let mode: "exact" | "normalized" | "outside" = "exact";
      let compressions = 0,
        aggregates = 0,
        repairs = 0;
      const review = (evidence: { id: string; quote: string }[]) => ({
        overview: "合成概括",
        insights: evidence.length ? [{ fact: "合成事实", evidence }] : [],
        changes: [],
        connections: [],
        questions: [],
      });
      try {
        const ai = new Ai(store, config, async (_u, init) => {
          const payload = JSON.parse(init!.body as string);
          const data = JSON.parse(payload.messages[1].content);
          const task = data.task ?? data;
          const prompt = payload.messages[0].content as string;
          if (data.error) repairs++;
          if (Array.isArray(task))
            return reply({
              entries: task.map((x: any) => ({
                id: x.id,
                themes: ["合成主题"],
                points: "合成要点",
              })),
            });
          if (!task.reviews)
            return reply(
              review(
                task.originals.some((x: any) => x.text.includes(supplied))
                  ? [{ id: e.id, quote: supplied }]
                  : [],
              ),
            );
          assert.ok(task.originals.length > 0);
          assert.ok(
            task.originals.every(
              (x: any) => x.id === e.id && x.text === supplied,
            ),
            "各聚合/压缩阶段只能收到叶阶段供给的精确证据",
          );
          if (compress && prompt.includes("层级归纳全部候选回顾"))
            return reply({}, true);
          if (prompt.includes("压缩这个回顾")) compressions++;
          else {
            aggregates++;
            if (compress)
              for (const r of task.reviews) {
                assert.equal(r.insights.length, mode === "outside" ? 0 : 1);
                if (mode !== "outside")
                  assert.equal(r.insights[0].evidence[0].quote, supplied);
              }
          }
          return reply(
            review([
              {
                id: e.id,
                quote:
                  mode === "exact"
                    ? supplied
                    : mode === "normalized"
                      ? quote
                      : "真正未供给",
              },
            ]),
          );
        });
        const month = e.day.slice(0, 7);
        // Establish an old ready through the same public generation pipeline.
        await ai.generate("month", month);
        mode = "normalized";
        compressions = aggregates = repairs = 0;
        await ai.generate("month", month);
        const ready = store.latestReady("month", month)!;
        const out = JSON.parse(ready.data!);
        assert.equal(out.insights.length, 1);
        assert.equal(out.insights[0].evidence[0].quote, supplied);
        assert.equal(out.insights[0].evidence[0].quote.length, supplied.length);
        assert.ok(e.text.includes(out.insights[0].evidence[0].quote));
        assert.equal(repairs, 0);
        assert.equal(aggregates, 1);
        assert.equal(compressions, compress ? 2 : 0);
        mode = "outside";
        compressions = aggregates = repairs = 0;
        await assert.rejects(
          ai.generate("month", month),
          compress ? /月度压缩聚合.*洞察不足/ : /月度层级聚合.*洞察不足/,
        );
        assert.equal(compressions, compress ? 2 : 0);
        assert.equal(aggregates, 2);
        assert.equal(repairs, 1);
        assert.equal(store.latestReady("month", month)!.id, ready.id);
        assert.equal(store.latestReady("month", month)!.data, ready.data);
        assert.ok(!ready.data!.includes("真正未供给"));
      } finally {
        store.close();
      }
    });
  }
}
