import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export const SESSION_COOKIE = "__Host-broker_session";
export type Session = { tokenHash: string; username: string; credentialFingerprint: string;
  csrfHash: string; csrfToken: string; expiresAt: number };

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function opaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function equalHash(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function cookie(token: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${token}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Strict`;
}

export function clearCookie(): string { return cookie("", 0); }

export function readSessionCookie(header: string | undefined): string | null {
  for (const item of (header || "").split(";")) {
    const separator = item.indexOf("=");
    if (separator >= 0 && item.slice(0, separator).trim() === SESSION_COOKIE) {
      return item.slice(separator + 1).trim() || null;
    }
  }
  return null;
}

export class SessionStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory()) throw new Error("Session database directory must be a real directory");
    // SQLite may create WAL/SHM sidecars here, so the directory itself must be private.
    chmodSync(directory, 0o700);
    // Create private bytes before SQLite opens the file; do not rely on the process-wide umask.
    try {
      closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!lstatSync(path).isFile()) throw new Error("Session database must be a regular file");
      chmodSync(path, 0o600);
    }
    this.db = new Database(path, { fileMustExist: false });
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
    const columns = this.db.pragma("table_info(sessions)") as Array<{ name: string }>;
    if (!columns.some(column => column.name === "credential_fingerprint")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN credential_fingerprint TEXT NOT NULL DEFAULT ''; DELETE FROM sessions;");
    }
  }

  create(username: string, fingerprint: string, ttlSeconds: number, now: number): { token: string; csrfToken: string; expiresAt: number } {
    const token = opaqueToken();
    const csrfToken = opaqueToken();
    const expiresAt = now + ttlSeconds;
    this.db.prepare(`INSERT INTO sessions (token_hash, username, credential_fingerprint,
      csrf_hash, csrf_token, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sha256(token), username, fingerprint, sha256(csrfToken), csrfToken, expiresAt, now, now);
    return { token, csrfToken, expiresAt };
  }

  find(token: string, now: number): Session | null {
    const session = this.db.prepare(`SELECT token_hash AS tokenHash, username,
      credential_fingerprint AS credentialFingerprint, csrf_hash AS csrfHash,
      csrf_token AS csrfToken, expires_at AS expiresAt FROM sessions WHERE token_hash = ?`)
      .get(sha256(token)) as Session | undefined;
    if (!session) return null;
    if (session.expiresAt <= now) {
      this.delete(token);
      return null;
    }
    return session;
  }

  refresh(token: string, ttlSeconds: number, now: number): number {
    const expiresAt = now + ttlSeconds;
    this.db.prepare("UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE token_hash = ?")
      .run(expiresAt, now, sha256(token));
    return expiresAt;
  }

  delete(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  }

  revokeStaleCredentials(currentFingerprint: (username: string) => string | null): void {
    const sessions = this.db.prepare("SELECT token_hash AS tokenHash, username, credential_fingerprint AS fingerprint FROM sessions")
      .all() as Array<{ tokenHash: string; username: string; fingerprint: string }>;
    const remove = this.db.prepare("DELETE FROM sessions WHERE token_hash = ?");
    this.db.transaction(() => {
      for (const session of sessions) {
        if (!session.fingerprint || session.fingerprint !== currentFingerprint(session.username)) {
          remove.run(session.tokenHash);
        }
      }
    })();
  }

  cleanup(now: number, limit: number): void {
    this.db.prepare(`DELETE FROM sessions WHERE token_hash IN (
      SELECT token_hash FROM sessions WHERE expires_at <= ? ORDER BY expires_at, token_hash LIMIT ?
    )`).run(now, limit);
  }

  close(): void { this.db.close(); }
}
