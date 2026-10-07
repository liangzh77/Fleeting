#!/usr/bin/env node
// 运行期一致性备份：使用 node:sqlite 的在线备份 API（与 scripts/backup.ts 同一机制），
// 只依赖 Node 内置模块，因此生产环境无需安装 devDependencies。
// 用法：node deploy/backup.mjs
import { DatabaseSync, backup } from "node:sqlite";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const configPath =
  process.env.FLEETING_CONFIG ||
  "/srv/apps/fleeting/shared/config.local.json";
const file = JSON.parse(readFileSync(configPath, "utf8"));
const database = resolve(process.env.DATABASE_PATH || file.database);
const directory = resolve(
  process.env.FLEETING_BACKUP_DIR || join(dirname(database), "..", "backups"),
);
const keep = Number(process.env.FLEETING_BACKUP_KEEP || 14);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const output = join(directory, `fleeting-${stamp}.sqlite`);
const db = new DatabaseSync(database, { readOnly: true });
try {
  await backup(db, output);
  chmodSync(output, 0o600);
} finally {
  db.close();
}
const files = readdirSync(directory)
  .filter((name) => /^fleeting-.*\.sqlite$/.test(name))
  .map((name) => ({ name, mtime: statSync(join(directory, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);
for (const old of files.slice(keep)) unlinkSync(join(directory, old.name));
console.log(
  `SQLite 一致性备份完成：${output}（保留 ${Math.min(files.length, keep)} 份）`,
);
