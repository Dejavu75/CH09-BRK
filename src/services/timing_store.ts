import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import Database from "better-sqlite3";

export type TimingFilters = {
  from?: string;
  to?: string;
  url?: string;
  result?: string;
  minTotalMs?: number;
};

export function matchesTimingFilters(row: {
  brokerInAt?: string; url?: string; status?: number; error?: string; totalMs?: number;
}, filters: TimingFilters): boolean {
  const time = Date.parse(row.brokerInAt ?? "");
  if (filters.from && !(time >= Date.parse(filters.from))) return false;
  if (filters.to && !(time <= Date.parse(filters.to))) return false;
  if (filters.url && !(row.url ?? "").toLowerCase().includes(filters.url.toLowerCase())) return false;
  if (filters.minTotalMs !== undefined && !(row.totalMs !== undefined && row.totalMs >= filters.minTotalMs)) return false;
  if (filters.result === "errors") return Boolean(row.error) || (row.status ?? 0) >= 400;
  if (filters.result?.endsWith("xx")) return Math.floor((row.status ?? 0) / 100) === Number(filters.result[0]);
  return !filters.result || row.status === Number(filters.result);
}

export class TimingStore<T extends { id: string }> {
  private readonly db: Database.Database;
  static readonly PAGE_SIZE = 100;

  constructor(path?: string) {
    if (path !== undefined) {
      if (!path.trim() || !isAbsolute(path)) throw new Error("An absolute timing database path is required");
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!lstatSync(directory).isDirectory()) throw new Error("Timing database directory must be a real directory");
      chmodSync(directory, 0o700);
      try {
        closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!lstatSync(path).isFile()) throw new Error("Timing database must be a regular file");
        chmodSync(path, 0o600);
      }
    }
    // An empty filename uses SQLite's temporary disk database for local runs.
    this.db = new Database(path ?? "");
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS timing_records (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL
    )`);
  }

  page(cursor?: number, filters: TimingFilters = {}): { rows: T[]; nextCursor?: number } {
    // Apply the same predicate to persisted and live traces, before either page limit.
    this.db.function("timing_matches", (payload: string) =>
      matchesTimingFilters(JSON.parse(payload), filters) ? 1 : 0);
    const rows = this.db.prepare(`SELECT sequence, payload FROM timing_records
      WHERE (? IS NULL OR sequence < ?) AND timing_matches(payload)
      ORDER BY sequence DESC LIMIT ?`)
      .all(cursor ?? null, cursor ?? null, TimingStore.PAGE_SIZE + 1) as Array<{ sequence: number; payload: string }>;
    const hasMore = rows.length > TimingStore.PAGE_SIZE;
    const visible = rows.slice(0, TimingStore.PAGE_SIZE);
    const payload = { rows: visible.map(row => JSON.parse(row.payload) as T) };
    return hasMore ? { ...payload, nextCursor: visible.at(-1)!.sequence } : payload;
  }

  get(traceId: string): T | undefined {
    const row = this.db.prepare("SELECT payload FROM timing_records WHERE trace_id = ?")
      .get(traceId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as T : undefined;
  }

  upsert(trace: T): void {
    this.db.prepare(`INSERT INTO timing_records (trace_id, payload) VALUES (?, ?)
      ON CONFLICT(trace_id) DO UPDATE SET payload = excluded.payload`).run(trace.id, JSON.stringify(trace));
  }

  clear(): number {
    return this.db.prepare("DELETE FROM timing_records").run().changes;
  }

  close(): void { this.db.close(); }
}
