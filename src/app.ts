import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { resolve } from "node:path";
import type { Config } from "./config.js";
import { localDate, validDay, validMonth } from "./config.js";
import { digest, token, validHash, verifyPassword } from "./auth.js";
import { Store } from "./store.js";
import { Ai, AiError } from "./ai.js";
const LOGIN_WINDOW_MS = 30_000;
interface Session {
  hash: string;
  csrf: string;
  expires: number;
}
export function createApp(
  config: Config,
  store: Store,
  fetcher: typeof fetch = fetch,
) {
  if (!validHash(config.passwordHash))
    throw new Error("尚未设置有效密码哈希，请运行 npm run password");
  // Cap login attempts left by older releases with a longer lockout window.
  const maximumExpiry = Date.now() + LOGIN_WINDOW_MS;
  store.db
    .prepare("UPDATE attempts SET until=? WHERE until>?")
    .run(maximumExpiry, maximumExpiry);
  const previous = store.db
    .prepare("SELECT value FROM meta WHERE key=?")
    .get("password") as { value: string } | undefined;
  if (previous?.value !== digest(config.passwordHash)) {
    store.db.exec("DELETE FROM sessions");
    store.db
      .prepare("INSERT OR REPLACE INTO meta VALUES (?,?)")
      .run("password", digest(config.passwordHash));
  }
  const app = express(),
    ai = new Ai(store, config, fetcher),
    secure = config.origin.startsWith("https:");
  app.disable("x-powered-by");
  // 仅信任回环代理（如 Caddy）附加的 X-Forwarded-For；直连客户端无法伪造。
  app.set("trust proxy", "loopback");
  app.use((_req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    });
    if (secure) res.set("Strict-Transport-Security", "max-age=31536000");
    next();
  });
  app.use(express.json({ limit: "32kb" }));
  app.use("/api", (req, res, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.get("origin") !== config.origin
    ) {
      res.status(403).json({ error: "请求来源不可信" });
      return;
    }
    next();
  });
  const cookie = (res: Response, value: string, maxAge: number) =>
    res.cookie(secure ? "__Host-fleeting" : "fleeting", value, {
      httpOnly: true,
      secure,
      sameSite: "strict",
      path: "/",
      maxAge,
    });
  app.post("/api/login", async (req, res) => {
    const now = Date.now(),
      ip = (req.ip || req.socket.remoteAddress || "unknown").slice(0, 64);
    store.db.prepare("DELETE FROM attempts WHERE until<?").run(now);
    store.db.prepare("DELETE FROM sessions WHERE expires<?").run(now);
    const attempt = store.db
      .prepare("SELECT count,until FROM attempts WHERE ip=?")
      .get(ip) as { count: number; until: number } | undefined;
    if (attempt && attempt.count >= 8) {
      const seconds = Math.max(1, Math.ceil((attempt.until - now) / 1000));
      res
        .set("Retry-After", String(seconds))
        .status(429)
        .json({ error: `尝试过多，请 ${seconds} 秒后再试` });
      return;
    }
    // Count before asynchronous hashing, so parallel requests cannot bypass the limit.
    store.db
      .prepare(
        "INSERT INTO attempts VALUES (?,1,?) ON CONFLICT(ip) DO UPDATE SET count=count+1",
      )
      .run(ip, now + LOGIN_WINDOW_MS);
    if (
      typeof req.body?.password !== "string" ||
      !(await verifyPassword(req.body.password, config.passwordHash))
    ) {
      res.status(401).json({ error: "密码不正确" });
      return;
    }
    const value = token(),
      csrf = token();
    store.db
      .prepare("INSERT INTO sessions VALUES (?,?,?)")
      .run(digest(value), csrf, now + 7 * 86400000);
    cookie(res, value, 7 * 86400000);
    res.json({ ok: true });
  });
  app.use("/api", (req, res, next) => {
    const name = secure ? "__Host-fleeting" : "fleeting";
    const raw = (req.headers.cookie || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(name + "="))
      ?.slice(name.length + 1);
    const session =
      raw &&
      (store.db
        .prepare("SELECT * FROM sessions WHERE hash=? AND expires>?")
        .get(digest(raw), Date.now()) as Session | undefined);
    if (!session) {
      res.status(401).json({ error: "请先登录" });
      return;
    }
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.get("x-csrf-token") !== session.csrf
    ) {
      res.status(403).json({ error: "安全令牌无效，请刷新后重试" });
      return;
    }
    res.locals.session = session;
    next();
  });
  app.get("/api/session", (_req, res) =>
    res.json({
      csrf: (res.locals.session as Session).csrf,
      today: localDate(new Date(), config.timezone),
      timezone: config.timezone,
      aiConfigured: ai.configured(),
    }),
  );
  app.post("/api/logout", (_req, res) => {
    store.db
      .prepare("DELETE FROM sessions WHERE hash=?")
      .run((res.locals.session as Session).hash);
    cookie(res, "", 0);
    res.json({ ok: true });
  });
  app.get("/api/dates", (_req, res) =>
    res.json(
      store.db
        .prepare(
          "SELECT day,COUNT(*) AS count FROM entries GROUP BY day ORDER BY day DESC",
        )
        .all(),
    ),
  );
  app.get("/api/entries", (req, res) => {
    const { day, q } = req.query;
    if (q !== undefined) {
      if (typeof q !== "string" || !q.trim() || q.length > 200) {
        res.status(400).json({ error: "搜索词需 1–200 字符" });
        return;
      }
      res.json(
        store.db
          .prepare(
            "SELECT * FROM entries WHERE instr(text,?)>0 ORDER BY createdAt DESC LIMIT 200",
          )
          .all(q),
      );
      return;
    }
    if (!validDay(day)) {
      res.status(400).json({ error: "日期无效" });
      return;
    }
    res.json(store.entries(day));
  });
  app.get("/api/entries/:id", (req, res) => {
    const e = store.get(String(req.params.id));
    if (!e) res.status(404).json({ error: "原文已删除" });
    else res.json(e);
  });
  function textInput(req: Request): string {
    const text = req.body?.text;
    if (typeof text !== "string" || !text.trim() || text.length > 8000)
      throw new Error("INVALID_TEXT");
    return text;
  }
  app.post("/api/entries", (req, res) => {
    const key = req.get("idempotency-key");
    if (!key || !/^[a-zA-Z0-9-]{16,100}$/.test(key)) {
      res.status(400).json({ error: "缺少有效幂等标识" });
      return;
    }
    const result = store.create(textInput(req), key);
    res.status(result.replay ? 200 : 201).json(result);
  });
  app.put("/api/entries/:id", (req, res) => {
    if (!Number.isInteger(req.body?.version)) {
      res.status(400).json({ error: "缺少版本" });
      return;
    }
    res.json(
      store.update(String(req.params.id), textInput(req), req.body.version),
    );
  });
  app.delete("/api/entries/:id", (req, res) => {
    if (!Number.isInteger(req.body?.version)) {
      res.status(400).json({ error: "缺少版本" });
      return;
    }
    store.delete(String(req.params.id), req.body.version);
    res.json({ ok: true });
  });
  function scope(req: Request): { kind: "day" | "month"; period: string } {
    const { kind, period } =
      (req.method === "GET" ? req.query : req.body) || {};
    if (!(
      (kind === "day" && validDay(period)) ||
      (kind === "month" && validMonth(period))
    ))
      throw new Error("INVALID_PERIOD");
    return { kind, period };
  }
  app.get("/api/result", (req, res) => {
    const { kind, period } = scope(req);
    const job = store.latestJob(kind, period);
    const ready = store.latestReady(kind, period);
    const data = ready?.data ? JSON.parse(ready.data) : null;
    const entries = store.entries(period, kind);
    const sources: { id: string; version: number }[] = data?.sources ?? [];
    const addedOrChanged =
      data &&
      entries.some(
        (e) => !sources.some((s) => s.id === e.id && s.version === e.version),
      );
    const removed =
      data && sources.some((s) => !entries.some((e) => e.id === s.id));
    res.json({
      kind,
      period,
      state: job?.state ?? null,
      error: job?.state === "failed" ? job.error : null,
      data,
      model: ready?.model ?? job?.model ?? null,
      generatedAt: ready?.generatedAt ?? null,
      outdated: !!data && store.snapshot(entries) !== ready!.fingerprint,
      change: addedOrChanged
        ? removed
          ? "mixed"
          : "added"
        : removed
          ? "removed"
          : "none",
    });
  });
  app.post("/api/generate", async (req, res) => {
    const { kind, period } = scope(req);
    if (req.body?.consent !== true) {
      res.status(400).json({ error: "请先确认向模型服务商发送所选原文" });
      return;
    }
    await ai.generate(kind, period);
    res.json({ ok: true });
  });
  app.get("/api/export", (req, res) => {
    const { day, format } = req.query;
    if (day !== undefined && !validDay(day)) {
      res.status(400).json({ error: "日期无效" });
      return;
    }
    const entries = day
      ? store.entries(day as string)
      : store.db.prepare("SELECT * FROM entries ORDER BY createdAt,id").all();
    res.set(
      "Content-Disposition",
      `attachment; filename="fleeting-${day || "all"}.${format === "markdown" ? "md" : "json"}"`,
    );
    if (format === "markdown") {
      res
        .type("text/markdown")
        .send(
          (entries as ReturnType<Store["entries"]>)
            .map(
              (e) =>
                `## ${e.day} · ${e.timeUnknown ? "补录 · 时间未记录" : new Intl.DateTimeFormat("zh-CN", { timeZone: config.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(e.createdAt))}\n\n${e.text}\n`,
            )
            .join("\n"),
        );
    } else
      res.json({
        formatVersion: 1,
        timezone: config.timezone,
        exportedAt: new Date().toISOString(),
        entries,
      });
  });
  app.use("/api", (_req, res) => res.status(404).json({ error: "接口不存在" }));
  app.use(express.static(resolve("public"), { etag: false, maxAge: 0 }));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const messages: Record<string, [number, string]> = {
      IDEMPOTENCY_CONFLICT: [409, "幂等标识已用于其他内容"],
      VERSION_CONFLICT: [409, "原文已更新，请刷新后重试"],
      NOT_FOUND: [404, "记录不存在"],
      INVALID_TEXT: [400, "原文需 1–8000 字符，不能全为空白"],
      INVALID_PERIOD: [400, "日期范围无效"],
    };
    const code = err instanceof Error ? err.message : "";
    if (err instanceof AiError) {
      res.status(503).json({ error: err.message });
      return;
    }
    const match = messages[code];
    if (match) {
      res.status(match[0]).json({ error: match[1] });
      return;
    }
    const status = (err as { status?: number })?.status;
    res.status(status === 413 ? 413 : status === 400 ? 400 : 500).json({
      error:
        status === 413
          ? "请求过大"
          : status === 400
            ? "请求格式无效"
            : "服务暂不可用，请稍后重试",
    });
    // Deliberately never log request bodies, model responses, credentials or raw errors.
  });
  return app;
}
