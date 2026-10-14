import { CredentialFile } from "./credentials";
import { clearCookie, cookie, equalHash, readSessionCookie, Session, SessionStore, sha256 } from "./session_store";
import { warn } from "../utils/logger";
import { X509Certificate } from "node:crypto";
import { certifiedHttpsOrigin } from "./origin";

const CLEANUP_INTERVAL_MS = 60_000;
const CLEANUP_BATCH_SIZE = 1_000;

export type AuthConfig = {
  publicOrigin?: string;
  certificatePem?: string | Buffer;
  credentialFile?: string;
  databaseFile: string;
  sessionTtlSeconds?: number;
  loginLimit?: number;
  loginWindowSeconds?: number;
};
type AuthResult = { status: number; setCookie?: string; retryAfterSeconds?: number;
  username?: string; csrfToken?: string; expiresAt?: number };

export class BrokerAuthService {
  private readonly users: CredentialFile;
  private readonly sessions: SessionStore;
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();
  private attemptsCursor = this.attempts.entries();
  private readonly cleanupTimer: NodeJS.Timeout;
  private readonly origin?: string;
  private readonly certificate?: X509Certificate;
  private readonly ttl: number;
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(config: AuthConfig) {
    if (config.publicOrigin !== undefined) {
      const parsed = new URL(config.publicOrigin);
      if (parsed.protocol !== "https:" || parsed.origin !== config.publicOrigin) {
        throw new Error("publicOrigin must be an exact HTTPS origin");
      }
    }
    this.origin = config.publicOrigin;
    this.certificate = config.certificatePem ? new X509Certificate(config.certificatePem) : undefined;
    this.ttl = positive(config.sessionTtlSeconds ?? 30 * 24 * 60 * 60);
    this.limit = positive(config.loginLimit ?? 10);
    this.windowMs = positive(config.loginWindowSeconds ?? 900) * 1000;
    this.users = new CredentialFile(config.credentialFile);
    this.sessions = new SessionStore(config.databaseFile);
    this.sessions.revokeStaleCredentials(username => this.users.fingerprint(username));
    this.cleanupTimer = setInterval(() => {
      try { this.cleanup(); } catch { warn("Broker auth cleanup failed"); }
    }, CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  expectedOrigin(host: string | undefined, secure: boolean): string | undefined {
    if (this.origin) return this.origin;
    return secure && this.certificate ? certifiedHttpsOrigin(host, this.certificate) : undefined;
  }

  async login(input: { username: unknown; password: unknown; clientKey: string; origin: string | undefined;
    host?: string; secure?: boolean }, nowMs = Date.now()): Promise<AuthResult> {
    const expected = this.expectedOrigin(input.host, input.secure ?? false);
    if (!expected || input.origin !== expected) return { status: 403 };
    const key = input.clientKey;
    const attempt = this.attempts.get(key);
    if (attempt && attempt.resetAt > nowMs && attempt.count >= this.limit) {
      return { status: 429, retryAfterSeconds: Math.ceil((attempt.resetAt - nowMs) / 1000) };
    }
    const username = typeof input.username === "string" ? input.username.trim() : "";
    const password = typeof input.password === "string" ? input.password : "";
    const valid = await this.users.verify(username, password);
    if (!valid) {
      const current = attempt && attempt.resetAt > nowMs ? attempt : { count: 0, resetAt: nowMs + this.windowMs };
      current.count += 1;
      this.attempts.set(key, current);
      return { status: 401 };
    }
    this.attempts.delete(key);
    const fingerprint = this.users.fingerprint(username);
    if (!fingerprint) return { status: 401 };
    const created = this.sessions.create(username, fingerprint, this.ttl, Math.floor(nowMs / 1000));
    return { status: 200, username, csrfToken: created.csrfToken,
      expiresAt: created.expiresAt, setCookie: cookie(created.token, this.ttl) };
  }

  session(cookieHeader: string | undefined, nowMs = Date.now()): AuthResult {
    const current = this.current(cookieHeader, nowMs);
    if (!current) return { status: 401, setCookie: clearCookie() };
    const expiresAt = this.sessions.refresh(current.token, this.ttl, Math.floor(nowMs / 1000));
    return { status: 200, username: current.session.username, csrfToken: current.session.csrfToken,
      expiresAt, setCookie: cookie(current.token, this.ttl) };
  }

  verify(input: { cookieHeader: string | undefined; method: string; origin?: string; csrfToken?: string;
    host?: string; secure?: boolean }, nowMs = Date.now()): AuthResult {
    const current = this.current(input.cookieHeader, nowMs);
    if (!current) return { status: 401, setCookie: clearCookie() };
    const method = input.method.toUpperCase();
    const expected = this.expectedOrigin(input.host, input.secure ?? false);
    if (!expected) return { status: 403 };
    if (!["GET", "HEAD", "OPTIONS"].includes(method) &&
        (input.origin !== expected ||
          !this.validCsrf(input.csrfToken, current.session))) return { status: 403 };
    const expiresAt = this.sessions.refresh(current.token, this.ttl, Math.floor(nowMs / 1000));
    return { status: 204, username: current.session.username, expiresAt, setCookie: cookie(current.token, this.ttl) };
  }

  logout(input: { cookieHeader: string | undefined; origin?: string; csrfToken?: string;
    host?: string; secure?: boolean }, nowMs = Date.now()): AuthResult {
    const expected = this.expectedOrigin(input.host, input.secure ?? false);
    if (!expected || input.origin !== expected) return { status: 403 };
    const current = this.current(input.cookieHeader, nowMs);
    if (current && !this.validCsrf(input.csrfToken, current.session)) return { status: 403 };
    if (current) this.sessions.delete(current.token);
    return { status: 200, setCookie: clearCookie() };
  }

  cleanup(nowMs = Date.now(), batchSize = CLEANUP_BATCH_SIZE): void {
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) throw new Error("Invalid auth cleanup batch size");
    for (let scanned = 0; scanned < batchSize; scanned++) {
      const entry = this.attemptsCursor.next();
      if (entry.done) {
        this.attemptsCursor = this.attempts.entries();
        break;
      }
      const [key, attempt] = entry.value;
      if (attempt.resetAt <= nowMs) this.attempts.delete(key);
    }
    this.sessions.cleanup(Math.floor(nowMs / 1000), batchSize);
  }

  close(): void {
    clearInterval(this.cleanupTimer);
    this.sessions.close();
  }

  private current(cookieHeader: string | undefined, nowMs: number): { token: string; session: Session } | null {
    const token = readSessionCookie(cookieHeader);
    if (!token) return null;
    const session = this.sessions.find(token, Math.floor(nowMs / 1000));
    if (!session) return null;
    if (session.credentialFingerprint !== this.users.fingerprint(session.username)) {
      this.sessions.delete(token);
      return null;
    }
    return { token, session };
  }

  private validCsrf(value: string | undefined, session: Session): boolean {
    return typeof value === "string" && equalHash(sha256(value), session.csrfHash);
  }
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid positive integer auth setting");
  return value;
}
