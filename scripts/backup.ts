import { DatabaseSync, backup } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
const config = loadConfig();
const output = process.argv[2];
if (
  !output ||
  resolve(output) === resolve(config.database) ||
  existsSync(output)
)
  throw new Error(
    "用法 npm run backup -- /私有路径/新文件.sqlite（不可覆盖已有文件）",
  );
mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(config.database, { readOnly: true });
try {
  await backup(db, output);
  chmodSync(output, 0o600);
  console.log("SQLite 一致性备份完成");
} finally {
  db.close();
}
