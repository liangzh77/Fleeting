// Independent R1 edge probes: exercise only the public generation/storage path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Ai } from "../src/ai.js";
import { Store } from "../src/store.js";
import type { Config } from "../src/config.js";

const config: Config = {
  origin: "http://localhost:3000",
  timezone: "UTC",
  database: ":memory:",
  passwordHash: "synthetic-only",
  llm: { baseUrl: "https://example.invalid", apiKey: "mock", model: "mock" },
};
const response = (data: unknown, truncated = false) =>
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
const cases = [
  {
    name: "overlapping normalized occurrences",
    tail: "甲 \t甲\n甲",
    supplied: ["甲\n甲"],
    quote: "甲 甲",
    accept: true,
  },
  {
    name: "whitespace rejection falls through to punctuation",
    tail: "甲\t乙!隔甲\n乙！",
    supplied: ["甲\n乙！"],
    quote: "甲 乙!",
    accept: true,
  },
  {
    name: "must not join separate supplied slices",
    tail: "保留来源甲\n乙丙！",
    supplied: ["保留来源", "甲\n乙", "丙！"],
    quote: "甲 乙丙!",
    accept: false,
  },
  {
    name: "same text supplied under another id is insufficient",
    tail: "保留来源跨ID候选",
    supplied: ["保留来源"],
    quote: "跨ID候选",
    accept: false,
    other: "跨ID候选",
  },
];
for (const c of cases)
  for (const compress of [false, true]) {
    test(`independent rereview: ${c.name} / ${compress ? "compression" : "aggregation"}`, async () => {
      const store = new Store(":memory:", "UTC");
      const a = store.create(
        "填".repeat(2001) + c.tail,
        "a",
        new Date(),
        "2026-10-06",
      ).entry!;
      const b = store.create(
        c.other ?? "第二条合成记录",
        "b",
        new Date(),
        "2026-10-06",
      ).entry!;
      const given = c.supplied.map((text) => ({ id: a.id, text }));
      if (c.other) given.push({ id: b.id, text: c.other });
      const item = (id: string, quote: string) => ({
        fact: "合成事实",
        evidence: [{ id, quote }],
      });
      const result = (items: ReturnType<typeof item>[]) => ({
        overview: "独立边界复验",
        insights: items,
        changes: items,
        connections: items,
        questions: items.map((x) => ({
          text: "合成问题",
          evidence: x.evidence,
        })),
      });
      let leaves = 0,
        aggregates = 0,
        compressions = 0,
        repairs = 0;
      const assertGrounded = (r: any, expected: string) => {
        for (const field of [
          "insights",
          "changes",
          "connections",
          "questions",
        ]) {
          assert.equal(r[field].length, 1, field);
          const evidence = r[field][0].evidence;
          assert.equal(evidence.length, 1);
          assert.deepEqual(evidence[0], {
            id: a.id,
            day: a.day,
            quote: expected,
          });
          assert.equal(evidence[0].quote.length, expected.length);
          assert.ok(a.text.includes(evidence[0].quote));
          assert.ok(
            given.some(
              (s) => s.id === a.id && s.text.includes(evidence[0].quote),
            ),
          );
        }
      };
      try {
        const ai = new Ai(store, config, async (url, init) => {
          assert.equal(url, "https://example.invalid/chat/completions");
          const request = JSON.parse(init!.body as string);
          const input = JSON.parse(request.messages[1].content);
          if (input.error) repairs++;
          const task = input.task ?? input;
          const prompt = request.messages[0].content as string;
          if (Array.isArray(task))
            return response({
              entries: task.map((x: any) => ({
                id: x.id,
                themes: ["合成"],
                points: "合成要点",
              })),
            });
          if (!task.reviews) {
            leaves++;
            return response(
              result(
                given
                  .filter((s) =>
                    task.originals.some(
                      (x: any) => x.id === s.id && x.text.includes(s.text),
                    ),
                  )
                  .map((s) => item(s.id, s.text)),
              ),
            );
          }
          assert.deepEqual(
            new Set(
              task.originals.map((s: any) => JSON.stringify([s.id, s.text])),
            ),
            new Set(given.map((s) => JSON.stringify([s.id, s.text]))),
          );
          if (compress && prompt.includes("层级归纳全部候选回顾"))
            return response({}, true);
          if (prompt.includes("压缩这个回顾")) compressions++;
          else {
            aggregates++;
            if (compress)
              for (const r of task.reviews) assertGrounded(r, c.supplied[0]);
          }
          return response(
            result(
              c.accept
                ? [item(a.id, c.quote)]
                : [item(a.id, c.supplied[0]), item(a.id, c.quote)],
            ),
          );
        });
        await ai.generate("month", "2026-10");
        const ready = store.latestReady("month", "2026-10")!;
        assertGrounded(JSON.parse(ready.data!), c.supplied[0]);
        assert.equal(repairs, 0);
        assert.equal(leaves, 2);
        assert.equal(aggregates, 1);
        assert.equal(compressions, compress ? 2 : 0);
        if (c.accept)
          assert.notEqual(
            c.supplied[0],
            c.quote,
            "must save the original slice, not normalized model text",
          );
      } finally {
        store.close();
      }
    });
  }
