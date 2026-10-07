import { readFileSync } from "node:fs";
import { digest } from "../src/auth.js";
import { loadConfig, validDay } from "../src/config.js";
import { Store } from "../src/store.js";

const [day, file] = process.argv.slice(2);
if (!validDay(day) || !file || process.argv.length !== 4)
  throw new Error(
    "用法：npm run import:entry -- YYYY-MM-DD /私有路径/原文.txt（或 - 从标准输入）",
  );
const text =
  file === "-"
    ? readFileSync(0, "utf8").replace(/\r?\n$/, "")
    : readFileSync(file, "utf8");
if (!text.trim() || text.length > 8000)
  throw new Error("原文需 1–8000 字符且不能为空；请拆分过长的原文");

const config = loadConfig();
// A second connection is safe with SQLite WAL; it must not mark an active AI job
// as interrupted, which is a server-startup-only task.
const store = new Store(config.database, config.timezone, false);
try {
  const existing = store.db
    .prepare("SELECT id FROM entries WHERE day=? AND text=? LIMIT 1")
    .get(day, text);
  if (existing) {
    console.log(`${day} 已有相同原文，未重复导入`);
  } else {
    const result = store.create(
      text,
      digest(`date-only-import:${day}:${text}`),
      new Date(),
      day,
    );
    if (!result.entry || result.entry.day !== day || !result.entry.timeUnknown)
      throw new Error("导入状态不一致，请检查数据库；未重复导入");
    console.log(`${day} 已导入 1 条原文（补录，记录时间未提供）`);
  }
} finally {
  store.close();
}
