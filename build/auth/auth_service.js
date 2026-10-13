"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrokerAuthService = void 0;
const credentials_1 = require("./credentials");
const session_store_1 = require("./session_store");
const logger_1 = require("../utils/logger");
const CLEANUP_INTERVAL_MS = 60000;
const CLEANUP_BATCH_SIZE = 1000;
class BrokerAuthService {
    constructor(config) {
        var _a, _b, _c;
        this.attempts = new Map();
        this.attemptsCursor = this.attempts.entries();
        const parsed = new URL(config.publicOrigin);
        if (parsed.protocol !== "https:" || parsed.origin !== config.publicOrigin) {
            throw new Error("publicOrigin must be an exact HTTPS origin");
        }
        this.origin = config.publicOrigin;
        this.ttl = positive((_a = config.sessionTtlSeconds) !== null && _a !== void 0 ? _a : 30 * 24 * 60 * 60);
        this.limit = positive((_b = config.loginLimit) !== null && _b !== void 0 ? _b : 10);
        this.windowMs = positive((_c = config.loginWindowSeconds) !== null && _c !== void 0 ? _c : 900) * 1000;
        this.users = new credentials_1.CredentialFile(config.credentialFile);
        this.sessions = new session_store_1.SessionStore(config.databaseFile);
        this.sessions.revokeStaleCredentials(username => this.users.fingerprint(username));
        this.cleanupTimer = setInterval(() => {
            try {
                this.cleanup();
            }
            catch (_a) {
                (0, logger_1.warn)("Broker auth cleanup failed");
            }
        }, CLEANUP_INTERVAL_MS);
        this.cleanupTimer.unref();
    }
    login(input_1) {
        return __awaiter(this, arguments, void 0, function* (input, nowMs = Date.now()) {
            if (input.origin !== this.origin)
                return { status: 403 };
            const key = input.clientKey;
            const attempt = this.attempts.get(key);
            if (attempt && attempt.resetAt > nowMs && attempt.count >= this.limit) {
                return { status: 429, retryAfterSeconds: Math.ceil((attempt.resetAt - nowMs) / 1000) };
            }
            const username = typeof input.username === "string" ? input.username.trim() : "";
            const password = typeof input.password === "string" ? input.password : "";
            const valid = yield this.users.verify(username, password);
            if (!valid) {
                const current = attempt && attempt.resetAt > nowMs ? attempt : { count: 0, resetAt: nowMs + this.windowMs };
                current.count += 1;
                this.attempts.set(key, current);
                return { status: 401 };
            }
            this.attempts.delete(key);
            const fingerprint = this.users.fingerprint(username);
            if (!fingerprint)
                return { status: 401 };
            const created = this.sessions.create(username, fingerprint, this.ttl, Math.floor(nowMs / 1000));
            return { status: 200, username, csrfToken: created.csrfToken,
                expiresAt: created.expiresAt, setCookie: (0, session_store_1.cookie)(created.token, this.ttl) };
        });
    }
    session(cookieHeader, nowMs = Date.now()) {
        const current = this.current(cookieHeader, nowMs);
        if (!current)
            return { status: 401, setCookie: (0, session_store_1.clearCookie)() };
        const expiresAt = this.sessions.refresh(current.token, this.ttl, Math.floor(nowMs / 1000));
        return { status: 200, username: current.session.username, csrfToken: current.session.csrfToken,
            expiresAt, setCookie: (0, session_store_1.cookie)(current.token, this.ttl) };
    }
    verify(input, nowMs = Date.now()) {
        const current = this.current(input.cookieHeader, nowMs);
        if (!current)
            return { status: 401, setCookie: (0, session_store_1.clearCookie)() };
        const method = input.method.toUpperCase();
        if (!["GET", "HEAD", "OPTIONS"].includes(method) &&
            (input.origin !== this.origin || !this.validCsrf(input.csrfToken, current.session)))
            return { status: 403 };
        const expiresAt = this.sessions.refresh(current.token, this.ttl, Math.floor(nowMs / 1000));
        return { status: 204, username: current.session.username, expiresAt, setCookie: (0, session_store_1.cookie)(current.token, this.ttl) };
    }
    logout(input, nowMs = Date.now()) {
        if (input.origin !== this.origin)
            return { status: 403 };
        const current = this.current(input.cookieHeader, nowMs);
        if (current && !this.validCsrf(input.csrfToken, current.session))
            return { status: 403 };
        if (current)
            this.sessions.delete(current.token);
        return { status: 200, setCookie: (0, session_store_1.clearCookie)() };
    }
    cleanup(nowMs = Date.now(), batchSize = CLEANUP_BATCH_SIZE) {
        if (!Number.isSafeInteger(batchSize) || batchSize <= 0)
            throw new Error("Invalid auth cleanup batch size");
        for (let scanned = 0; scanned < batchSize; scanned++) {
            const entry = this.attemptsCursor.next();
            if (entry.done) {
                this.attemptsCursor = this.attempts.entries();
                break;
            }
            const [key, attempt] = entry.value;
            if (attempt.resetAt <= nowMs)
                this.attempts.delete(key);
        }
        this.sessions.cleanup(Math.floor(nowMs / 1000), batchSize);
    }
    close() {
        clearInterval(this.cleanupTimer);
        this.sessions.close();
    }
    current(cookieHeader, nowMs) {
        const token = (0, session_store_1.readSessionCookie)(cookieHeader);
        if (!token)
            return null;
        const session = this.sessions.find(token, Math.floor(nowMs / 1000));
        if (!session)
            return null;
        if (session.credentialFingerprint !== this.users.fingerprint(session.username)) {
            this.sessions.delete(token);
            return null;
        }
        return { token, session };
    }
    validCsrf(value, session) {
        return typeof value === "string" && (0, session_store_1.equalHash)((0, session_store_1.sha256)(value), session.csrfHash);
    }
}
exports.BrokerAuthService = BrokerAuthService;
function positive(value) {
    if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error("Invalid positive integer auth setting");
    return value;
}
