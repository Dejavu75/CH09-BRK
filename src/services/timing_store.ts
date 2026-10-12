import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import Database from "better-sqlite3";

export class TimingStore<T extends { id: string }> {
  private readonly db: Database.Database;

  constructor(path: string, private readonly limit = 500) {
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
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS timing_records (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL
    )`);
  }

  load(): T[] {
    const rows = this.db.prepare("SELECT payload FROM timing_records ORDER BY sequence DESC LIMIT ?")
      .all(this.limit) as Array<{ payload: string }>;
    return rows.reverse().map(row => JSON.parse(row.payload) as T);
  }

  upsert(trace: T): void {
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO timing_records (trace_id, payload) VALUES (?, ?)
        ON CONFLICT(trace_id) DO UPDATE SET payload = excluded.payload`).run(trace.id, JSON.stringify(trace));
      this.db.prepare(`DELETE FROM timing_records WHERE sequence NOT IN
        (SELECT sequence FROM timing_records ORDER BY sequence DESC LIMIT ?)`).run(this.limit);
    })();
  }

  clear(): number {
    return this.db.prepare("DELETE FROM timing_records").run().changes;
  }

  close(): void { this.db.close(); }
}
