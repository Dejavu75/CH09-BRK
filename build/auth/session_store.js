"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionStore = exports.SESSION_COOKIE = void 0;
exports.sha256 = sha256;
exports.opaqueToken = opaqueToken;
exports.equalHash = equalHash;
exports.cookie = cookie;
exports.clearCookie = clearCookie;
exports.readSessionCookie = readSessionCookie;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
exports.SESSION_COOKIE = "__Host-broker_session";
function sha256(value) {
    return (0, node_crypto_1.createHash)("sha256").update(value, "utf8").digest("hex");
}
function opaqueToken() {
    return (0, node_crypto_1.randomBytes)(32).toString("base64url");
}
function equalHash(left, right) {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && (0, node_crypto_1.timingSafeEqual)(a, b);
}
function cookie(token, maxAge) {
    return `${exports.SESSION_COOKIE}=${token}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Strict`;
}
function clearCookie() { return cookie("", 0); }
function readSessionCookie(header) {
    for (const item of (header || "").split(";")) {
        const separator = item.indexOf("=");
        if (separator >= 0 && item.slice(0, separator).trim() === exports.SESSION_COOKIE) {
            return item.slice(separator + 1).trim() || null;
        }
    }
    return null;
}
class SessionStore {
    constructor(path) {
        const directory = (0, node_path_1.dirname)(path);
        (0, node_fs_1.mkdirSync)(directory, { recursive: true, mode: 0o700 });
        if (!(0, node_fs_1.lstatSync)(directory).isDirectory())
            throw new Error("Session database directory must be a real directory");
        // SQLite may create WAL/SHM sidecars here, so the directory itself must be private.
        (0, node_fs_1.chmodSync)(directory, 0o700);
        // Create private bytes before SQLite opens the file; do not rely on the process-wide umask.
        try {
            (0, node_fs_1.closeSync)((0, node_fs_1.openSync)(path, node_fs_1.constants.O_CREAT | node_fs_1.constants.O_EXCL | node_fs_1.constants.O_RDWR, 0o600));
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            if (!(0, node_fs_1.lstatSync)(path).isFile())
                throw new Error("Session database must be a regular file");
            (0, node_fs_1.chmodSync)(path, 0o600);
        }
        this.db = new better_sqlite3_1.default(path, { fileMustExist: false });
        this.db.pragma("journal_mode = WAL");
        this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      credential_fingerprint TEXT NOT NULL DEFAULT '',
      csrf_hash TEXT NOT NULL,
      csrf_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);`);
        // Existing sessions have no credential binding and must not survive the upgrade.
        const columns = this.db.pragma("table_info(sessions)");
        if (!columns.some(column => column.name === "credential_fingerprint")) {
            this.db.exec("ALTER TABLE sessions ADD COLUMN credential_fingerprint TEXT NOT NULL DEFAULT ''; DELETE FROM sessions;");
        }
    }
    create(username, fingerprint, ttlSeconds, now) {
        const token = opaqueToken();
        const csrfToken = opaqueToken();
        const expiresAt = now + ttlSeconds;
        this.db.prepare(`INSERT INTO sessions (token_hash, username, credential_fingerprint,
      csrf_hash, csrf_token, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(sha256(token), username, fingerprint, sha256(csrfToken), csrfToken, expiresAt, now, now);
        return { token, csrfToken, expiresAt };
    }
    find(token, now) {
        const session = this.db.prepare(`SELECT token_hash AS tokenHash, username,
      credential_fingerprint AS credentialFingerprint, csrf_hash AS csrfHash,
      csrf_token AS csrfToken, expires_at AS expiresAt FROM sessions WHERE token_hash = ?`)
            .get(sha256(token));
        if (!session)
            return null;
        if (session.expiresAt <= now) {
            this.delete(token);
            return null;
        }
        return session;
    }
    refresh(token, ttlSeconds, now) {
        const expiresAt = now + ttlSeconds;
        this.db.prepare("UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE token_hash = ?")
            .run(expiresAt, now, sha256(token));
        return expiresAt;
    }
    delete(token) {
        this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
    }
    revokeStaleCredentials(currentFingerprint) {
        const sessions = this.db.prepare("SELECT token_hash AS tokenHash, username, credential_fingerprint AS fingerprint FROM sessions")
            .all();
        const remove = this.db.prepare("DELETE FROM sessions WHERE token_hash = ?");
        this.db.transaction(() => {
            for (const session of sessions) {
                if (!session.fingerprint || session.fingerprint !== currentFingerprint(session.username)) {
                    remove.run(session.tokenHash);
                }
            }
        })();
    }
    cleanup(now, limit) {
        this.db.prepare(`DELETE FROM sessions WHERE token_hash IN (
      SELECT token_hash FROM sessions WHERE expires_at <= ? ORDER BY expires_at, token_hash LIMIT ?
    )`).run(now, limit);
    }
    close() { this.db.close(); }
}
exports.SessionStore = SessionStore;
