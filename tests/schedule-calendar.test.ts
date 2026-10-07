import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Ai } from "../src/ai.js";
import { Scheduler } from "../src/scheduler.js";
import type { Config } from "../src/config.js";
test("调度实际归档：跨年、闰日、DST 回拨的重复 01:00 不重复调用", async () => {
  for (const [timezone, instant, period, repeated] of [
    [
      "Asia/Tokyo",
      "2025-12-31T16:00:00Z",
      "2025-12-31",
      "2025-12-31T16:01:00Z",
    ],
    [
      "Pacific/Auckland",
      "2024-02-29T12:00:00Z",
      "2024-02-29",
      "2024-02-29T12:01:00Z",
    ],
    [
      "America/New_York",
      "2025-11-02T05:00:00Z",
      "2025-11-01",
      "2025-11-02T06:00:00Z",
    ],
  ]) {
    const store = new Store(":memory:", timezone);
    try {
      const config: Config = {
        origin: "http://localhost:3000",
        timezone,
        database: ":memory:",
        passwordHash: "test-only",
        llm: {
          baseUrl: "https://example.invalid",
          apiKey: "test-only",
          model: "mock",
        },
      };
      const e = store.create("测试资料", "a", new Date(), period).entry!;
      let clock = new Date(instant),
        calls = 0;
      const ai = new Ai(store, config, async () => {
        calls++;
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    sections: [
                      { segments: [{ text: "测试资料", sources: [e.id] }] },
                    ],
                  }),
                },
              },
            ],
          }),
        );
      });
      const scheduler = new Scheduler(store, ai, () => clock);
      await scheduler.tick();
      assert.equal(calls, 2, timezone);
      assert.ok(store.latestReady("day", period), timezone);
      clock = new Date(repeated);
      await scheduler.tick();
      assert.equal(calls, 2, timezone);
      assert.equal(
        store.db.prepare("SELECT count(*) AS n FROM results").get()!.n,
        1,
      );
      scheduler.start();
      scheduler.stop();
      scheduler.stop();
    } finally {
      store.close();
    }
  }
});
