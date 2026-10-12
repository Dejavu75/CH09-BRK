"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TimingStore = void 0;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
class TimingStore {
    constructor(path, limit = 500) {
        this.limit = limit;
        if (!path.trim() || !(0, node_path_1.isAbsolute)(path))
            throw new Error("An absolute timing database path is required");
        const directory = (0, node_path_1.dirname)(path);
        (0, node_fs_1.mkdirSync)(directory, { recursive: true, mode: 0o700 });
        if (!(0, node_fs_1.lstatSync)(directory).isDirectory())
            throw new Error("Timing database directory must be a real directory");
        (0, node_fs_1.chmodSync)(directory, 0o700);
        try {
            (0, node_fs_1.closeSync)((0, node_fs_1.openSync)(path, node_fs_1.constants.O_CREAT | node_fs_1.constants.O_EXCL | node_fs_1.constants.O_RDWR, 0o600));
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            if (!(0, node_fs_1.lstatSync)(path).isFile())
                throw new Error("Timing database must be a regular file");
            (0, node_fs_1.chmodSync)(path, 0o600);
        }
        this.db = new better_sqlite3_1.default(path);
        this.db.pragma("journal_mode = WAL");
        this.db.exec(`CREATE TABLE IF NOT EXISTS timing_records (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL
    )`);
    }
    load() {
        const rows = this.db.prepare("SELECT payload FROM timing_records ORDER BY sequence DESC LIMIT ?")
            .all(this.limit);
        return rows.reverse().map(row => JSON.parse(row.payload));
    }
    upsert(trace) {
        this.db.transaction(() => {
            this.db.prepare(`INSERT INTO timing_records (trace_id, payload) VALUES (?, ?)
        ON CONFLICT(trace_id) DO UPDATE SET payload = excluded.payload`).run(trace.id, JSON.stringify(trace));
            this.db.prepare(`DELETE FROM timing_records WHERE sequence NOT IN
        (SELECT sequence FROM timing_records ORDER BY sequence DESC LIMIT ?)`).run(this.limit);
        })();
    }
    clear() {
        return this.db.prepare("DELETE FROM timing_records").run().changes;
    }
    close() { this.db.close(); }
}
exports.TimingStore = TimingStore;
