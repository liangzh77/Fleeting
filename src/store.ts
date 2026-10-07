import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { digest } from "./auth.js";
import { localDate, validDay } from "./config.js";
export interface Entry {
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  day: string;
  version: number;
  /** 1 for date-only imports: createdAt is the import time, not a claimed diary time. */
  timeUnknown: number;
}
export interface Result {
  id: string;
  kind: "day" | "month";
  period: string;
  state: string;
  fingerprint: string;
  data: string | null;
  model: string;
  generatedAt: string;
  error: string | null;
}
export class Store {
  db: DatabaseSync;
  constructor(
    path: string,
    public timezone: string,
    markInterruptedJobs = true,
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY,text TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,day TEXT NOT NULL,version INTEGER NOT NULL,timeUnknown INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS entries_day ON entries(day,createdAt);
      CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY,bodyHash TEXT NOT NULL,entryId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts(ip TEXT PRIMARY KEY,count INTEGER NOT NULL,until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS results(id TEXT PRIMARY KEY,kind TEXT NOT NULL,period TEXT NOT NULL,state TEXT NOT NULL,fingerprint TEXT NOT NULL,data TEXT,model TEXT NOT NULL,generatedAt TEXT NOT NULL,error TEXT);
    `);
    // Existing databases predate date-only imports; ordinary records have known times.
    const columns = this.db.prepare("PRAGMA table_info(entries)").all() as {
      name: string;
    }[];
    if (!columns.some((column) => column.name === "timeUnknown"))
      this.db.exec(
        "ALTER TABLE entries ADD COLUMN timeUnknown INTEGER NOT NULL DEFAULT 0",
      );
    // Legacy stale rows already had their derived content cleared.
    this.db.exec("DELETE FROM results WHERE state='stale'");
    const old = this.db
      .prepare("SELECT value FROM meta WHERE key=?")
      .get("timezone") as { value: string } | undefined;
    if (old && old.value !== timezone) {
      this.db.close();
      throw new Error("数据库时区已固定；更改时区需显式迁移");
    }
    this.db
      .prepare("INSERT OR IGNORE INTO meta VALUES (?,?)")
      .run("timezone", timezone);
    if (markInterruptedJobs)
      this.db
        .prepare(
          "UPDATE results SET state='failed',error='服务重启，生成中断' WHERE state='running'",
        )
        .run();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      this.db.exec("COMMIT");
      return v;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  entries(period: string, kind: "day" | "month" = "day"): Entry[] {
    return this.db
      .prepare(
        `SELECT * FROM entries WHERE ${kind === "day" ? "day=?" : "substr(day,1,7)=?"} ORDER BY createdAt,id`,
      )
      .all(period) as unknown as Entry[];
  }
  snapshot(entries: Entry[]): string {
    return digest(JSON.stringify(entries.map((e) => [e.id, e.version])));
  }
  create(
    text: string,
    key: string,
    now = new Date(),
    archiveDay?: string,
  ): { entry: Entry | null; replay: boolean } {
    if (archiveDay !== undefined && !validDay(archiveDay))
      throw new Error("日期无效");
    return this.transaction(() => {
      const previous = this.db
        .prepare("SELECT * FROM requests WHERE key=?")
        .get(key) as { bodyHash: string; entryId: string } | undefined;
      if (previous) {
        if (previous.bodyHash !== digest(text))
          throw new Error("IDEMPOTENCY_CONFLICT");
        return { entry: this.get(previous.entryId) || null, replay: true };
      }
      const time = now.toISOString();
      const e: Entry = {
        id: randomUUID(),
        text,
        createdAt: time,
        updatedAt: time,
        day: archiveDay ?? localDate(time, this.timezone),
        version: 1,
        timeUnknown: archiveDay === undefined ? 0 : 1,
      };
      this.db
        .prepare(
          "INSERT INTO entries(id,text,createdAt,updatedAt,day,version,timeUnknown) VALUES (?,?,?,?,?,?,?)",
        )
        .run(e.id, text, time, time, e.day, 1, e.timeUnknown);
      this.db
        .prepare("INSERT INTO requests VALUES (?,?,?)")
        .run(key, digest(text), e.id);
      return { entry: e, replay: false };
    });
  }
  get(id: string): Entry | undefined {
    return this.db
      .prepare("SELECT * FROM entries WHERE id=?")
      .get(id) as unknown as Entry | undefined;
  }
  update(id: string, text: string, version: number): Entry {
    return this.transaction(() => {
      const e = this.get(id);
      if (!e) throw new Error("NOT_FOUND");
      if (e.version !== version) throw new Error("VERSION_CONFLICT");
      this.db
        .prepare(
          "UPDATE entries SET text=?,updatedAt=?,version=version+1 WHERE id=?",
        )
        .run(text, new Date().toISOString(), id);
      return this.get(id)!;
    });
  }
  delete(id: string, version: number): void {
    this.transaction(() => {
      const e = this.get(id);
      if (!e) throw new Error("NOT_FOUND");
      if (e.version !== version) throw new Error("VERSION_CONFLICT");
      this.db.prepare("DELETE FROM entries WHERE id=?").run(id);
    });
  }
  latestReady(kind: string, period: string): Result | undefined {
    return this.db
      .prepare(
        "SELECT * FROM results WHERE kind=? AND period=? AND state='ready' AND data IS NOT NULL ORDER BY rowid DESC LIMIT 1",
      )
      .get(kind, period) as unknown as Result | undefined;
  }
  latestJob(kind: string, period: string): Result | undefined {
    return this.db
      .prepare(
        "SELECT * FROM results WHERE kind=? AND period=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(kind, period) as unknown as Result | undefined;
  }
  close(): void {
    this.db.close();
  }
}
