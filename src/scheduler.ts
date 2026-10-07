import { Ai } from "./ai.js";
import { Store } from "./store.js";

export function yesterday(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}
export class Scheduler {
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private store: Store,
    private ai: Pick<Ai, "configured" | "generate">,
    private now: () => Date = () => new Date(),
    private log: (message: string) => void = console.warn,
  ) {}
  async tick(): Promise<void> {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: this.store.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(this.now());
    const part = (name: string) => parts.find((p) => p.type === name)!.value;
    if (Number(part("hour")) < 1 || !this.ai.configured()) return;
    const day = `${part("year")}-${part("month")}-${part("day")}`;
    const period = yesterday(day);
    if (
      this.store.db
        .prepare("SELECT key FROM meta WHERE key=?")
        .get(`auto-day:${day}`)
    )
      return;
    const entries = this.store.entries(period);
    if (!entries.length) return;
    if (
      this.store.latestReady("day", period)?.fingerprint ===
      this.store.snapshot(entries)
    )
      return;
    if (this.store.latestJob("day", period)?.state === "running") return;
    try {
      // Ai atomically claims both the running scope and the durable attempt.
      await this.ai.generate("day", period, day);
    } catch {
      this.log("自动整理未完成；原文和旧结果保留，可手动重试");
    }
  }
  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, 60000);
    this.timer.unref();
  }
  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
