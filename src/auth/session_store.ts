import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export const SESSION_COOKIE = "__Host-broker_session";
export type Session = { tokenHash: string; username: string; csrfHash: string; csrfToken: string; expiresAt: number };

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
      csrf_hash TEXT NOT NULL,
      csrf_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);`);
  }

  create(username: string, ttlSeconds: number, now: number): { token: string; csrfToken: string; expiresAt: number } {
    const token = opaqueToken();
    const csrfToken = opaqueToken();
    const expiresAt = now + ttlSeconds;
    this.db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(sha256(token), username, sha256(csrfToken), csrfToken, expiresAt, now, now);
    return { token, csrfToken, expiresAt };
  }

  find(token: string, now: number): Session | null {
    const session = this.db.prepare(`SELECT token_hash AS tokenHash, username, csrf_hash AS csrfHash,
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

  cleanup(now: number): void {
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  }

  close(): void { this.db.close(); }
}
