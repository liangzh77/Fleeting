import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ai } from "../src/ai.js";
import { Store } from "../src/store.js";
import { loadConfig, parseExtraBody, type Config } from "../src/config.js";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";

const config: Config = {
  origin: "http://localhost:3000",
  timezone: "UTC",
  database: ":memory:",
  passwordHash: "test-only",
  llm: {
    baseUrl: "https://example.invalid",
    apiKey: "mock-only",
    model: "mock",
  },
};
const reply = (
  data: unknown,
  options: { fence?: boolean; content?: string; length?: boolean } = {},
) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: options.length ? "length" : "stop",
          message: {
            content:
              options.content ??
              (options.fence
                ? "```json\n" + JSON.stringify(data) + "\n```"
                : JSON.stringify(data)),
          },
        },
      ],
    }),
  );
function valid(prompt: string, data: any): any {
  if (prompt.includes("按每条原文抽取"))
    return {
      entries: data.map((e: any) => ({
        id: e.id,
        themes: ["主题"],
        points: "要点",
      })),
    };
  const originals = data.originals ?? data;
  if (!prompt.includes("生成月度回顾"))
    return {
      sections: originals.map((e: any) => ({
        segments: [{ text: "整理", sources: [e.id] }],
      })),
    };
  const item = {
    fact: "事实",
    hypothesis: "推测",
    limitation: "材料有限",
    question: "问题",
    evidence: [{ id: originals[0].id, quote: originals[0].text.slice(0, 10) }],
  };
  return {
    overview: "概括",
    insights: [item, structuredClone(item)],
    changes: [],
    connections: [],
    questions: [],
  };
}
function setup(texts = ["合成材料甲", "合成材料乙"]) {
  const store = new Store(":memory:", "UTC");
  const entries = texts.map((text, i) => store.create(text, String(i)).entry!);
  return {
    store,
    entries,
    day: entries[0].day,
    month: entries[0].day.slice(0, 7),
  };
}

test("月软上限裁剪、围栏、超长文本不拆代理对，主题统计与保留项一致", async () => {
  const f = setup();
  let calls = 0;
  try {
    await new Ai(f.store, config, async (_u, init) => {
      calls++;
      const p = JSON.parse(init!.body as string),
        data = JSON.parse(p.messages[1].content),
        out = valid(p.messages[0].content, data);
      if (out.entries) {
        for (const e of out.entries) {
          e.themes = Array.from({ length: 7 }, (_, i) => "主题" + i);
          e.points = "字".repeat(999) + "😀";
        }
        out.entries.push(out.entries[0]);
      } else {
        out.overview = "字".repeat(999) + "😀";
        out.insights = Array.from({ length: 5 }, () =>
          structuredClone(out.insights[0]),
        );
        out.changes = Array.from({ length: 7 }, () =>
          structuredClone(out.insights[0]),
        );
        out.connections = out.changes;
        out.questions = Array.from({ length: 5 }, () => ({
          text: "问题",
          evidence: out.insights[0].evidence,
        }));
        out.insights[0].fact = "字".repeat(199) + "😀";
      }
      return reply(out, { fence: true });
    }).generate("month", f.month);
    const out = JSON.parse(f.store.latestReady("month", f.month)!.data!);
    assert.equal(calls, 2);
    assert.equal(out.insights.length, 4);
    assert.equal(out.changes.length, 6);
    assert.equal(out.connections.length, 6);
    assert.equal(out.questions.length, 4);
    assert.equal(out.overview.length, 999);
    assert.equal(out.insights[0].fact.length, 199);
    assert.equal(out.themes.length, 5);
    assert.ok(out.themes.every((t: any) => t.count === 2));
  } finally {
    f.store.close();
  }
});

for (const target of [
  "classification",
  "leaf",
  "aggregate",
  "daily-first",
  "daily-check",
] as const) {
  test(`一次结构修复成功：${target}，发送该次输出/错误/任务且默认无推理参数`, async () => {
    const f = setup(
      target === "aggregate"
        ? ["甲".repeat(2000), "乙".repeat(2000), "丙".repeat(2000)]
        : undefined,
    );
    let broken = false,
      repaired = 0;
    try {
      await new Ai(f.store, config, async (_u, init) => {
        const p = JSON.parse(init!.body as string),
          prompt = p.messages[0].content,
          data = JSON.parse(p.messages[1].content);
        assert.ok(!("reasoning_effort" in p));
        assert.ok(!("thinking" in p));
        assert.ok(!("enable_thinking" in p));
        if (data.error) {
          repaired++;
          assert.ok(data.candidate);
          assert.match(data.error, /结构校验失败/);
          assert.ok(data.task);
          return reply(valid(prompt, data.task));
        }
        const match =
          target === "classification"
            ? Array.isArray(data) && prompt.includes("按每条原文抽取")
            : target === "leaf"
              ? !!data.points
              : target === "aggregate"
                ? !!data.reviews
                : target === "daily-first"
                  ? Array.isArray(data)
                  : !!data.candidate;
        if (match && !broken) {
          broken = true;
          return reply({}, { content: "不是 JSON" });
        }
        return reply(valid(prompt, data));
      }).generate(
        target.startsWith("daily") ? "day" : "month",
        target.startsWith("daily") ? f.day : f.month,
      );
      assert.ok(broken);
      assert.equal(repaired, 1);
    } finally {
      f.store.close();
    }
  });
}

for (const field of [
  "overview",
  "limitation",
  "question",
  "evidence",
  "insights",
  "size",
  "hard-array",
]) {
  test(`少给/空值/缺证据不伪造成功，修复后成功：${field}`, async () => {
    const f = setup();
    let repairs = 0;
    try {
      await new Ai(f.store, config, async (_u, init) => {
        const p = JSON.parse(init!.body as string),
          prompt = p.messages[0].content,
          data = JSON.parse(p.messages[1].content);
        if (data.error) {
          repairs++;
          return reply(valid(prompt, data.task));
        }
        const out = valid(prompt, data);
        if (!out.entries) {
          if (field === "overview") out.overview = "";
          else if (field === "insights") out.insights = [];
          else if (field === "size") out.padding = "字".repeat(12001);
          else if (field === "hard-array") out.insights = Array(2001).fill({});
          else out.insights[0][field] = field === "evidence" ? [] : "";
        }
        return reply(out);
      }).generate("month", f.month);
      assert.equal(
        repairs,
        ["limitation", "question", "evidence"].includes(field) ? 0 : 1,
      );
    } finally {
      f.store.close();
    }
  });
}

test("修复后仍失败：阶段/字段可诊断、原文不泄漏、旧 ready 保留", async () => {
  const f = setup();
  let fail = false,
    calls = 0;
  try {
    const ai = new Ai(f.store, config, async (_u, init) => {
      calls++;
      const p = JSON.parse(init!.body as string),
        data = JSON.parse(p.messages[1].content);
      const out = valid(p.messages[0].content, data.task ?? data);
      if (fail && out.insights) out.insights[0].fact = "";
      return reply(out);
    });
    await ai.generate("month", f.month);
    const ready = f.store.latestReady("month", f.month)!;
    fail = true;
    calls = 0;
    await assert.rejects(
      ai.generate("month", f.month),
      /月度叶回顾结构校验失败：insights\[0\]\.fact 为空/,
    );
    assert.equal(calls, 3);
    assert.equal(f.store.latestReady("month", f.month)!.id, ready.id);
    const job = f.store.latestJob("month", f.month)!;
    assert.equal(job.state, "failed");
    for (const e of f.entries) assert.ok(!job.error!.includes(e.text));
    assert.ok(!job.error!.includes(config.llm.apiKey));
  } finally {
    f.store.close();
  }
});

for (const mode of ["network", "timeout", "http500", "http401", "http400"]) {
  test(`非结构错误不修复：${mode}`, async () => {
    const f = setup();
    let calls = 0;
    try {
      await assert.rejects(
        new Ai(f.store, config, async () => {
          calls++;
          if (mode === "network" || mode === "timeout")
            throw new Error("合成隐私信息");
          return new Response("合成隐私信息", {
            status: Number(mode.slice(4)),
          });
        }).generate("day", f.day),
        /模型网络或格式错误|模型服务调用失败/,
      );
      assert.equal(calls, 1);
    } finally {
      f.store.close();
    }
  });
}

test("修复调用截断仍拆分；拆分父步骤不被结构修复吞掉", async () => {
  const f = setup(["甲".repeat(512)]);
  let repaired = 0,
    length = false;
  try {
    await new Ai(f.store, config, async (_u, init) => {
      const p = JSON.parse(init!.body as string),
        data = JSON.parse(p.messages[1].content);
      if (data.error) {
        repaired++;
        length = true;
        return reply({}, { length: true });
      }
      if (!length) return reply({});
      return reply(valid(p.messages[0].content, data));
    }).generate("day", f.day);
    assert.equal(repaired, 1);
    assert.equal(
      JSON.parse(f.store.latestReady("day", f.day)!.data!).sections.length,
      2,
    );
  } finally {
    f.store.close();
  }
});

test("修复共享512预算：持续拆分+坏结构至上限后停止", async () => {
  const f = setup(
    Array.from({ length: 15 }, (_, i) => String(i % 10).repeat(8000)),
  );
  let calls = 0,
    repairs = 0;
  try {
    await assert.rejects(
      new Ai(f.store, config, async (_u, init) => {
        calls++;
        const p = JSON.parse(init!.body as string),
          data = JSON.parse(p.messages[1].content);
        if (data.error) {
          repairs++;
          return reply(valid(p.messages[0].content, data.task));
        }
        if (data.length > 1 || data[0].text.length > 128)
          return reply({}, { length: true });
        return reply({});
      }).generate("month", f.month),
      /自动拆分\/重试/,
    );
    assert.equal(calls, 512);
    assert.ok(repairs > 100);
    assert.equal(f.store.latestJob("month", f.month)!.state, "failed");
  } finally {
    f.store.close();
  }
});

test("配置推理参数仅按需发送、extraBody合并与禁止键/非法JSON/长度启动报错", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fleeting-structure-config-")),
    path = join(dir, "synthetic.json");
  const keys = [
    "FLEETING_CONFIG",
    "LLM_REASONING_EFFORT",
    "LLM_EXTRA_BODY",
  ] as const;
  const old = keys.map((k) => process.env[k]);
  const f = setup();
  try {
    process.env.FLEETING_CONFIG = path;
    delete process.env.LLM_REASONING_EFFORT;
    delete process.env.LLM_EXTRA_BODY;
    writeFileSync(
      path,
      JSON.stringify({
        llm: {
          reasoningEffort: "off",
          extraBody: '{"thinking":{"type":"disabled"}}',
        },
      }),
    );
    const loaded = loadConfig();
    assert.equal(loaded.llm.reasoningEffort, "off");
    assert.deepEqual(loaded.llm.extraBody, { thinking: { type: "disabled" } });
    await new Ai(
      f.store,
      {
        ...config,
        llm: {
          ...config.llm,
          reasoningEffort: loaded.llm.reasoningEffort,
          extraBody: loaded.llm.extraBody,
        },
      },
      async (_u, init) => {
        const p = JSON.parse(init!.body as string);
        assert.equal(p.reasoning_effort, "off");
        assert.deepEqual(p.thinking, { type: "disabled" });
        return reply(
          valid(p.messages[0].content, JSON.parse(p.messages[1].content)),
        );
      },
    ).generate("day", f.day);
    await new Ai(
      f.store,
      {
        ...config,
        llm: {
          ...config.llm,
          reasoningEffort: "off",
          extraBody: parseExtraBody(
            '{"enable_thinking":false,"reasoning_effort":"low"}',
          ),
        },
      },
      async (_u, init) => {
        const p = JSON.parse(init!.body as string);
        assert.equal(p.reasoning_effort, "low");
        assert.equal(p.enable_thinking, false);
        return reply(
          valid(p.messages[0].content, JSON.parse(p.messages[1].content)),
        );
      },
    ).generate("day", f.day);
    process.env.LLM_REASONING_EFFORT = "";
    process.env.LLM_EXTRA_BODY = "";
    assert.equal(loadConfig().llm.reasoningEffort, "");
    assert.equal(loadConfig().llm.extraBody, undefined);
    process.env.LLM_EXTRA_BODY = '{"enable_thinking":false}';
    assert.deepEqual(loadConfig().llm.extraBody, { enable_thinking: false });
    for (const value of [
      "not-json",
      "[]",
      "null",
      "false",
      '{"x":"' + "x".repeat(2000) + '"}',
      ...[
        "model",
        "messages",
        "stream",
        "tools",
        "tool_choice",
        "response_format",
        "max_tokens",
        "max_completion_tokens",
        "__proto__",
        "constructor",
        "prototype",
      ].map((k) => JSON.stringify({ [k]: false })),
    ]) {
      process.env.LLM_EXTRA_BODY = value;
      assert.throws(() => loadConfig(), /LLM_EXTRA_BODY/);
    }
  } finally {
    keys.forEach((k, i) => {
      if (old[i] === undefined) delete process.env[k];
      else process.env[k] = old[i];
    });
    f.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("API真实响应沿用error字段，修复失败仍返回旧成功内容", async () => {
  const f = setup();
  let fail = false;
  const cfg = { ...config, passwordHash: await hashPassword("test-only") };
  const aiMock: typeof fetch = async (_u, init) => {
    const p = JSON.parse(init!.body as string),
      data = JSON.parse(p.messages[1].content);
    const out = valid(p.messages[0].content, data.task ?? data);
    if (fail && out.insights) out.insights[0].fact = "";
    return reply(out);
  };
  const ai = new Ai(f.store, cfg, aiMock);
  await ai.generate("month", f.month);
  fail = true;
  await assert.rejects(ai.generate("month", f.month));
  const server = createApp(cfg, f.store, aiMock).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const login = await fetch(base + "/api/login", {
      method: "POST",
      headers: { Origin: cfg.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ password: "test-only" }),
    });
    assert.equal(login.status, 200);
    const res = await fetch(base + `/api/result?kind=month&period=${f.month}`, {
      headers: { Cookie: login.headers.get("set-cookie")!.split(";")[0] },
    });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.state, "failed");
    assert.match(out.error, /月度叶回顾.*insights\[0\]\.fact/);
    assert.equal(out.data.overview, "概括");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    f.store.close();
  }
});
