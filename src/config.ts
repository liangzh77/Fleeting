import {
  readFileSync,
  existsSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { hashPassword } from "./auth.js";
export interface Config {
  origin: string;
  timezone: string;
  database: string;
  passwordHash: string;
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
    reasoningEffort?: string;
    extraBody?: Record<string, unknown>;
  };
}
export interface PrivateConfig {
  origin?: string;
  timezone?: string;
  database?: string;
  passwordHash?: string;
  password?: string;
  llm?: Omit<Partial<Config["llm"]>, "extraBody"> & { extraBody?: string };
}
export function readPrivateConfig(path: string): PrivateConfig {
  // Never allow JSON parser errors to echo a snippet of private configuration.
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error();
    const file = raw as Record<string, unknown>;
    for (const key of [
      "origin",
      "timezone",
      "database",
      "passwordHash",
      "password",
    ]) {
      if (file[key] !== undefined && typeof file[key] !== "string")
        throw new Error();
    }
    if (file.llm !== undefined) {
      if (!file.llm || typeof file.llm !== "object" || Array.isArray(file.llm))
        throw new Error();
      const llm = file.llm as Record<string, unknown>;
      for (const key of [
        "baseUrl",
        "apiKey",
        "model",
        "reasoningEffort",
        "extraBody",
      ]) {
        if (llm[key] !== undefined && typeof llm[key] !== "string")
          throw new Error();
      }
    }
    return file as PrivateConfig;
  } catch {
    throw new Error("私有配置读取失败，请检查文件权限、JSON 格式及字段类型");
  }
}
// A plaintext password is only accepted as a one-time setup/reset instruction.
// Persist its hash before listening so failed writes never leave a running server
// using credentials that are not durably configured.
export async function migratePassword(
  path = process.env.FLEETING_CONFIG || "config.local.json",
): Promise<boolean> {
  if (!existsSync(path)) return false;
  const file = readPrivateConfig(path);
  if (file.password === undefined) return false;
  if (process.env.PASSWORD_HASH)
    throw new Error(
      "设置了 PASSWORD_HASH 环境变量，请先移除它再使用配置文件的 password",
    );
  const hash = await hashPassword(file.password);
  delete file.password;
  file.passwordHash = hash;
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(file, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, path);
  } catch {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw new Error("密码哈希写入私有配置失败；服务未启动，请检查文件权限");
  }
  return true;
}
export function parseExtraBody(
  value: string | undefined,
): Record<string, unknown> | undefined {
  if (value === undefined || value === "") return undefined;
  try {
    if (value.length > 2000) throw new Error();
    const body: unknown = JSON.parse(value);
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error();
    const forbidden = [
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
    ];
    if (
      Object.keys(body).some((key) => forbidden.includes(key)) ||
      JSON.stringify(body).length > 2000
    )
      throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new Error(
      "LLM_EXTRA_BODY / llm.extraBody 必须是最多2000字符的 JSON 对象，且不能覆盖程序自有字段",
    );
  }
}
export function loadConfig(): Config {
  const path = process.env.FLEETING_CONFIG || "config.local.json";
  const file = existsSync(path) ? readPrivateConfig(path) : {};
  const c: Config = {
    origin: process.env.APP_ORIGIN || file.origin || "http://localhost:3000",
    timezone: process.env.APP_TIMEZONE || file.timezone || "Asia/Shanghai",
    database:
      process.env.DATABASE_PATH || file.database || "./data/fleeting.sqlite",
    passwordHash: process.env.PASSWORD_HASH || file.passwordHash || "",
    llm: {
      baseUrl: process.env.LLM_BASE_URL || file.llm?.baseUrl || "",
      apiKey: process.env.LLM_API_KEY || file.llm?.apiKey || "",
      model: process.env.LLM_MODEL || file.llm?.model || "",
      reasoningEffort:
        process.env.LLM_REASONING_EFFORT ?? file.llm?.reasoningEffort ?? "",
      extraBody: parseExtraBody(
        process.env.LLM_EXTRA_BODY ?? file.llm?.extraBody,
      ),
    },
  };
  let origin: URL;
  try {
    origin = new URL(c.origin);
  } catch {
    throw new Error("APP_ORIGIN 必须是无路径的 HTTP(S) origin");
  }
  if (
    origin.origin !== c.origin ||
    !["http:", "https:"].includes(origin.protocol)
  )
    throw new Error("APP_ORIGIN 必须是无路径的 HTTP(S) origin");
  if (
    origin.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
  )
    throw new Error("非本机部署必须 HTTPS");
  try {
    new Intl.DateTimeFormat("en", { timeZone: c.timezone });
  } catch {
    throw new Error("APP_TIMEZONE 必须是有效的 IANA 时区");
  }
  return c;
}
export function localDate(time: string | Date, timezone: string): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(time));
  return ["year", "month", "day"]
    .map((k) => p.find((v) => v.type === k)!.value)
    .join("-");
}
export function validDay(s: unknown): s is string {
  return (
    typeof s === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    !isNaN(Date.parse(s)) &&
    new Date(s).toISOString().slice(0, 10) === s
  );
}
export function validMonth(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}
