// Independent acceptance probes. Run explicitly; intentionally exposes R1 failures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { Ai } from "../src/ai.js";
import { Store, type Entry } from "../src/store.js";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import type { Config } from "../src/config.js";
const config: Config = {
  origin: "http://localhost:3000",
  timezone: "UTC",
  database: ":memory:",
  passwordHash: "synthetic",
  llm: {
    baseUrl: "https://example.invalid",
    apiKey: "synthetic",
    model: "mock",
  },
};
const review = (insights: unknown[], questions: unknown[] = []) => ({
  overview: "独立验收合成概括",
  insights,
  questions,
  changes: [],
  connections: [],
});
function fixture(texts: string[]) {
  const store = new Store(":memory:", "UTC");
  const entries = texts.map(
    (text, i) =>
      store.create(text, `review-${i}`, new Date(Date.now() + i)).entry!,
  );
  const month = entries[0].day.slice(0, 7);
  let repairs = 0;
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  return {
    store,
    entries,
    month,
    warnings,
    get repairs() {
      return repairs;
    },
    async generate(fn: (task: any, entries: Entry[]) => unknown) {
      await new Ai(store, config, async (url, init) => {
        assert.equal(url, "https://example.invalid/chat/completions");
        const request = JSON.parse(init!.body as string);
        const input = JSON.parse(request.messages[1].content);
        if (input.error) repairs++;
        const task = input.task ?? input;
        const output = Array.isArray(task)
          ? {
              entries: task.map((e: any) => ({
                id: e.id,
                themes: ["合成"],
                points: "合成要点",
              })),
            }
          : fn(task, entries);
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: { content: JSON.stringify(output) },
              },
            ],
          }),
        );
      }).generate("month", month);
    },
    data() {
      return JSON.parse(store.latestReady("month", month)!.data!);
    },
    close() {
      console.warn = warn;
      store.close();
    },
  };
}
const cited = (id: string, quote: string) => ({
  fact: "合成事实",
  evidence: [{ id, quote }],
});

for (const [name, original, quote, expected] of [
  ["exact", "前😀原文；尾", "😀原文；", "😀原文；"],
  [
    "whitespace-offsets",
    "前😀甲\r\n\t　乙\u00a0\u00a0丙尾",
    "😀甲 乙\n丙",
    "😀甲\r\n\t　乙\u00a0\u00a0丙",
  ],
  [
    "punctuation-offsets",
    "前‘甲’：“乙”！（😀）。尾",
    "'甲':\"乙\"!(😀).",
    "‘甲’：“乙”！（😀）。",
  ],
  [
    "combined-cross-fragment",
    "填".repeat(1998) + "😀甲\n　乙，丙！" + "尾".repeat(2010),
    "😀甲 乙,丙!",
    "😀甲\n　乙，丙！",
  ],
]) {
  test(`independent A: ${name}`, async () => {
    const f = fixture([original, "第二条独立合成记录"]);
    let leaves = 0,
      aggregates = 0;
    try {
      await f.generate((task, [e]) => {
        if (task.reviews) {
          aggregates++;
          assert.ok(task.originals.every((s: any) => e.text.includes(s.text)));
          assert.ok(task.originals.some((s: any) => s.text === expected));
        } else {
          leaves++;
          if (name === "combined-cross-fragment")
            assert.ok(
              task.originals.every((s: any) => !s.text.includes(expected)),
            );
        }
        return review([cited(e.id, quote)]);
      });
      const item = f.data().insights[0];
      assert.equal(item.evidence[0].quote, expected);
      assert.equal(item.evidence[0].quote.length, expected.length);
      assert.ok(original.includes(item.evidence[0].quote));
      assert.equal(item.evidence[0].day, f.entries[0].day);
      for (const key of ["hypothesis", "limitation", "question"])
        assert.equal(item[key], "");
      assert.equal(f.repairs, 0);
      if (name === "combined-cross-fragment") {
        assert.equal(leaves, 3);
        assert.equal(aggregates, 2);
      }
      if (quote !== expected)
        assert.ok(
          f.warnings.some((x) =>
            /月度.*insights\[0\]\.evidence\[0\]\.quote 替换/.test(x),
          ),
        );
      assert.ok(
        f.warnings.every((x) => !x.includes(quote) && !x.includes(expected)),
      );
    } finally {
      f.close();
    }
  });
}

test("independent B: discard paraphrases, missing/empty evidence, preserve one insight, fail at zero with old ready intact", async () => {
  const f = fixture(["原文甲事实。", "原文乙事实。"]);
  try {
    await f.generate((_task, [e]) =>
      review(
        [
          {
            ...cited(e.id, "伪造改写"),
            evidence: [
              { id: e.id, quote: "伪造改写" },
              { id: e.id, quote: e.text },
            ],
            hypothesis: "",
            limitation: "\n\t",
            question: " ",
          },
          cited(e.id, "完全不存在的引文"),
          { fact: "缺失证据" },
          { fact: "空证据", evidence: [] },
        ],
        [
          {
            text: "丢弃问题",
            evidence: [{ id: e.id, quote: "问题的伪造证据" }],
          },
          { text: "无证据问题" },
          { text: "有效问题", evidence: [{ id: e.id, quote: e.text }] },
        ],
      ),
    );
    const ready = f.store.latestReady("month", f.month)!;
    const out = f.data();
    assert.equal(out.insights.length, 1);
    assert.equal(out.insights[0].evidence.length, 1);
    assert.equal(out.questions.length, 1);
    assert.equal(out.questions[0].text, "有效问题");
    for (const key of ["hypothesis", "limitation", "question"])
      assert.equal(out.insights[0][key], "");
    assert.doesNotMatch(ready.data!, /伪造|不存在|缺失证据|空证据|无证据问题/);
    await assert.rejects(
      f.generate((_task, [e]) => review([cited(e.id, "全部不存在")])),
      /月度叶回顾.*insights 丢弃了无法落地的证据后洞察不足/,
    );
    assert.equal(f.repairs, 1);
    assert.equal(f.store.latestReady("month", f.month)!.data, ready.data);
    assert.equal(f.store.latestJob("month", f.month)!.state, "failed");
    assert.ok(
      f.warnings.every(
        (x) =>
          /月度.*evidence/.test(x) &&
          !x.includes("不存在") &&
          !x.includes("伪造"),
      ),
    );
  } finally {
    f.close();
  }
});

test("independent B: one-record range may have zero grounded insights", async () => {
  const f = fixture(["单条真实合成记录"]);
  try {
    await f.generate((_task, [e]) =>
      review([cited(e.id, "不存在")], [{ text: "无来源" }]),
    );
    assert.deepEqual(f.data().insights, []);
    assert.deepEqual(f.data().questions, []);
    assert.equal(f.repairs, 0);
  } finally {
    f.close();
  }
});

for (const target of ["insights", "questions"] as const) {
  test(`independent A/B: unknown id in ${target} still errors even with a valid insight`, async () => {
    const f = fixture(["合成来源甲", "合成来源乙"]);
    try {
      await assert.rejects(
        f.generate((_task, [e]) => {
          const bad = { id: "never-existed", quote: "合成来源甲" };
          return target === "insights"
            ? review([cited(e.id, e.text), { fact: "坏来源", evidence: [bad] }])
            : review(
                [cited(e.id, e.text)],
                [{ text: "坏来源", evidence: [bad] }],
              );
        }),
        new RegExp(
          `月度叶回顾结构校验失败：${target}\\[${target === "insights" ? 1 : 0}\\]\\.evidence\\[0\\]\\.id 来源无效`,
        ),
      );
      assert.equal(f.repairs, 1);
      assert.equal(f.store.latestReady("month", f.month), undefined);
      assert.doesNotMatch(
        f.store.latestJob("month", f.month)!.error!,
        /never-existed|合成来源甲/,
      );
    } finally {
      f.close();
    }
  });
}

test("independent B: aggregation must not add a different original passage", async () => {
  const f = fixture([
    "只给这个证据" + "填".repeat(2100) + "这是未供给的原文",
    "第二条合成原文",
  ]);
  try {
    await assert.rejects(
      f.generate((task, [e]) =>
        review([
          cited(e.id, task.reviews ? "这是未供给的原文" : "只给这个证据"),
        ]),
      ),
      /月度层级聚合.*洞察不足/,
    );
    assert.equal(f.repairs, 1);
  } finally {
    f.close();
  }
});

for (const field of ["fact", "questions[0].text"] as const) {
  test(`independent B: ${field} remains mandatory`, async () => {
    const f = fixture(["必填字段合成来源甲", "必填字段合成来源乙"]);
    try {
      await assert.rejects(
        f.generate((_task, [e]) => {
          const item = cited(e.id, e.text);
          return field === "fact"
            ? review([{ ...item, fact: " " }])
            : review([item], [{ evidence: item.evidence }]);
        }),
        field === "fact"
          ? /月度叶回顾.*insights\[0\]\.fact 为空/
          : /月度叶回顾.*questions\[0\]\.text 缺失或类型错误/,
      );
      assert.equal(f.repairs, 1);
    } finally {
      f.close();
    }
  });
}

test("independent A: existing id outside the generation month is invalid", async () => {
  const f = fixture(["本次月度来源"]);
  const otherMonth = f.month === "2000-01" ? "2001-01-01" : "2000-01-01";
  const outside = f.store.create(
    "不在生成范围的合成原文",
    "outside",
    new Date(),
    otherMonth,
  ).entry!;
  try {
    await assert.rejects(
      f.generate(() => review([cited(outside.id, outside.text)])),
      /月度叶回顾.*evidence\[0\]\.id 来源无效/,
    );
    assert.equal(f.repairs, 1);
    assert.doesNotMatch(
      f.store.latestJob("month", f.month)!.error!,
      /不在生成范围/,
    );
  } finally {
    f.close();
  }
});

// R1: valid supplied later occurrence must remain groundable when an earlier
// normalized-equivalent occurrence in the FULL record has different exact bytes.
for (const [name, earlier, supplied, normalized] of [
  ["whitespace-first-match", "甲 \t乙", "甲\n乙", "甲 乙"],
  ["punctuation-first-match", "甲，乙！", "甲,乙！", "甲,乙!"],
  ["exact-hit-outside-supplied", "甲 乙", "甲\n乙", "甲 乙"],
]) {
  test(`independent R1: aggregate normalized supplied evidence survives ${name}`, async () => {
    const f = fixture([
      earlier + "填".repeat(2000) + supplied,
      "第二条合成记录",
    ]);
    let normalize = false,
      aggregates = 0;
    const model = (task: any, [e]: Entry[]) => {
      if (task.reviews) {
        aggregates++;
        assert.ok(task.originals.length > 0);
        assert.ok(task.originals.every((x: any) => x.text === supplied));
        return review([cited(e.id, normalize ? normalized : supplied)]);
      }
      return review(
        task.originals.some((x: any) => x.text.includes(supplied))
          ? [cited(e.id, supplied)]
          : [],
      );
    };
    try {
      await f.generate(model);
      assert.equal(f.data().insights[0].evidence[0].quote, supplied);
      const old = f.store.latestReady("month", f.month)!.id;
      normalize = true;
      let failure: unknown;
      try {
        await f.generate(model);
      } catch (e) {
        failure = e;
      }
      if (failure) {
        assert.equal(f.store.latestReady("month", f.month)!.id, old);
        assert.equal(f.repairs, 1);
        assert.match(String(failure), /月度层级聚合.*洞察不足/);
        console.log(
          `REPRO ${name}: exact aggregate succeeds; normalized aggregate fails after repair; supplied=${JSON.stringify(supplied)}; quote=${JSON.stringify(normalized)}; old ready retained`,
        );
      }
      assert.ok(aggregates >= 2);
      assert.equal(
        failure,
        undefined,
        "A/B require accepting this normalized supplied evidence and persisting its exact supplied original slice",
      );
      assert.equal(f.data().insights[0].evidence[0].quote, supplied);
    } finally {
      f.close();
    }
  });
}

test("independent C: Chrome hides missing/empty narratives, keeps populated narratives, exact evidence and source dialog", async () => {
  const f = fixture(["前缀😀甲\n　乙，丙！后缀", "第二条合成记录"]);
  const password = "independent-synthetic-password";
  const cfg = { ...config, passwordHash: await hashPassword(password) };
  let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await f.generate((_task, [e]) =>
      review([
        cited(e.id, "😀甲 乙,丙!"),
        {
          ...cited(e.id, "😀甲 乙,丙!"),
          hypothesis: "",
          limitation: " ",
          question: "\n",
        },
        {
          ...cited(e.id, "😀甲 乙,丙!"),
          hypothesis: "保留解释",
          limitation: "保留局限",
          question: "保留追问",
        },
      ]),
    );
    const out = f.data();
    for (const key of ["hypothesis", "limitation", "question"]) {
      assert.equal(out.insights[0][key], "");
      assert.equal(out.insights[1][key], "");
      delete out.insights[0][key]; // Also check older payloads lacking optional keys.
      out.insights[1][key] = " \n\t";
    }
    server = createApp(cfg, f.store, async () => {
      throw new Error("unexpected model call");
    }).listen(0, "127.0.0.1");
    await new Promise<void>((r) => server!.once("listening", r));
    cfg.origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.CHROME_PATH ||
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/api/result?*", async (route) => {
      if (new URL(route.request().url()).searchParams.get("kind") === "month")
        await route.fulfill({
          json: {
            state: "ready",
            data: out,
            model: "mock",
            generatedAt: new Date().toISOString(),
            outdated: false,
          },
        });
      else await route.continue();
    });
    await page.goto(cfg.origin);
    await page.getByLabel("私人随笔 · 密码").fill(password);
    await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.getByLabel("此刻，想记下什么？").waitFor();
    await page.getByRole("button", { name: "洞察", exact: true }).click();
    await page.getByText("独立验收合成概括", { exact: true }).waitFor();
    assert.equal(
      await page.getByText("事实 / 原文表达", { exact: true }).count(),
      3,
    );
    assert.equal(
      await page.getByText("AI 提出的可能解释", { exact: true }).count(),
      1,
    );
    assert.deepEqual(
      await page.getByText(/^其他解释 \/ 局限：/).allTextContents(),
      ["其他解释 / 局限：保留局限"],
    );
    assert.deepEqual(await page.getByText(/^追问：/).allTextContents(), [
      "追问：保留追问",
    ]);
    assert.deepEqual(
      await page.locator("blockquote").allTextContents(),
      Array(3).fill("😀甲\n　乙，丙！"),
    );
    await page
      .getByRole("button", { name: /^查看来源/ })
      .first()
      .click();
    await page.locator("#dialog[open]").waitFor();
    assert.ok(
      (await page.locator("#dialogContent").textContent())!.includes(
        f.entries[0].text,
      ),
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    f.close();
  }
});
