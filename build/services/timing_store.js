"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TimingStore = void 0;
exports.matchesTimingFilters = matchesTimingFilters;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
function matchesTimingFilters(row, filters) {
    var _a, _b, _c, _d, _e;
    const time = Date.parse((_a = row.brokerInAt) !== null && _a !== void 0 ? _a : "");
    if (filters.from && !(time >= Date.parse(filters.from)))
        return false;
    if (filters.to && !(time <= Date.parse(filters.to)))
        return false;
    if (filters.url && !((_b = row.url) !== null && _b !== void 0 ? _b : "").toLowerCase().includes(filters.url.toLowerCase()))
        return false;
    if (filters.minTotalMs !== undefined && !(row.totalMs !== undefined && row.totalMs >= filters.minTotalMs))
        return false;
    if (filters.result === "errors")
        return Boolean(row.error) || ((_c = row.status) !== null && _c !== void 0 ? _c : 0) >= 400;
    if ((_d = filters.result) === null || _d === void 0 ? void 0 : _d.endsWith("xx"))
        return Math.floor(((_e = row.status) !== null && _e !== void 0 ? _e : 0) / 100) === Number(filters.result[0]);
    return !filters.result || row.status === Number(filters.result);
}
class TimingStore {
    constructor(path) {
        if (path !== undefined) {
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
        }
        // An empty filename uses SQLite's temporary disk database for local runs.
        this.db = new better_sqlite3_1.default(path !== null && path !== void 0 ? path : "");
        this.db.pragma("journal_mode = WAL");
        this.db.exec(`CREATE TABLE IF NOT EXISTS timing_records (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL
    )`);
    }
    page(cursor, filters = {}) {
        // Apply the same predicate to persisted and live traces, before either page limit.
        this.db.function("timing_matches", (payload) => matchesTimingFilters(JSON.parse(payload), filters) ? 1 : 0);
        const rows = this.db.prepare(`SELECT sequence, payload FROM timing_records
      WHERE (? IS NULL OR sequence < ?) AND timing_matches(payload)
      ORDER BY sequence DESC LIMIT ?`)
            .all(cursor !== null && cursor !== void 0 ? cursor : null, cursor !== null && cursor !== void 0 ? cursor : null, TimingStore.PAGE_SIZE + 1);
        const hasMore = rows.length > TimingStore.PAGE_SIZE;
        const visible = rows.slice(0, TimingStore.PAGE_SIZE);
        const payload = { rows: visible.map(row => JSON.parse(row.payload)) };
        return hasMore ? Object.assign(Object.assign({}, payload), { nextCursor: visible.at(-1).sequence }) : payload;
    }
    get(traceId) {
        const row = this.db.prepare("SELECT payload FROM timing_records WHERE trace_id = ?")
            .get(traceId);
        return row ? JSON.parse(row.payload) : undefined;
    }
    upsert(trace) {
        this.db.prepare(`INSERT INTO timing_records (trace_id, payload) VALUES (?, ?)
      ON CONFLICT(trace_id) DO UPDATE SET payload = excluded.payload`).run(trace.id, JSON.stringify(trace));
    }
    clear() {
        return this.db.prepare("DELETE FROM timing_records").run().changes;
    }
    close() { this.db.close(); }
}
exports.TimingStore = TimingStore;
TimingStore.PAGE_SIZE = 100;
