import { CredentialFile } from "./credentials";
import { clearCookie, cookie, equalHash, readSessionCookie, Session, SessionStore, sha256 } from "./session_store";

export type AuthConfig = {
  publicOrigin: string;
  credentialFile: string;
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
  private readonly origin: string;
  private readonly ttl: number;
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(config: AuthConfig) {
    const parsed = new URL(config.publicOrigin);
    if (parsed.protocol !== "https:" || parsed.origin !== config.publicOrigin) {
      throw new Error("publicOrigin must be an exact HTTPS origin");
    }
    this.origin = config.publicOrigin;
    this.ttl = positive(config.sessionTtlSeconds ?? 30 * 24 * 60 * 60);
    this.limit = positive(config.loginLimit ?? 10);
    this.windowMs = positive(config.loginWindowSeconds ?? 900) * 1000;
    this.users = new CredentialFile(config.credentialFile);
    this.sessions = new SessionStore(config.databaseFile);
  }

  async login(input: { username: unknown; password: unknown; clientKey: string; origin: string | undefined }, nowMs = Date.now()): Promise<AuthResult> {
    if (input.origin !== this.origin) return { status: 403 };
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
    const created = this.sessions.create(username, this.ttl, Math.floor(nowMs / 1000));
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

  verify(input: { cookieHeader: string | undefined; method: string; origin?: string; csrfToken?: string }, nowMs = Date.now()): AuthResult {
    const current = this.current(input.cookieHeader, nowMs);
    if (!current) return { status: 401, setCookie: clearCookie() };
    const method = input.method.toUpperCase();
    if (!["GET", "HEAD", "OPTIONS"].includes(method) &&
        (input.origin !== this.origin || !this.validCsrf(input.csrfToken, current.session))) return { status: 403 };
    const expiresAt = this.sessions.refresh(current.token, this.ttl, Math.floor(nowMs / 1000));
    return { status: 204, username: current.session.username, expiresAt, setCookie: cookie(current.token, this.ttl) };
  }

  logout(input: { cookieHeader: string | undefined; origin?: string; csrfToken?: string }, nowMs = Date.now()): AuthResult {
    if (input.origin !== this.origin) return { status: 403 };
    const current = this.current(input.cookieHeader, nowMs);
    if (current && !this.validCsrf(input.csrfToken, current.session)) return { status: 403 };
    if (current) this.sessions.delete(current.token);
    return { status: 200, setCookie: clearCookie() };
  }

  cleanup(nowMs = Date.now()): void {
    for (const [key, attempt] of this.attempts) if (attempt.resetAt <= nowMs) this.attempts.delete(key);
    this.sessions.cleanup(Math.floor(nowMs / 1000));
  }

  close(): void { this.sessions.close(); }

  private current(cookieHeader: string | undefined, nowMs: number): { token: string; session: Session } | null {
    const token = readSessionCookie(cookieHeader);
    if (!token) return null;
    const session = this.sessions.find(token, Math.floor(nowMs / 1000));
    return session ? { token, session } : null;
  }

  private validCsrf(value: string | undefined, session: Session): boolean {
    return typeof value === "string" && equalHash(sha256(value), session.csrfHash);
  }
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid positive integer auth setting");
  return value;
}
