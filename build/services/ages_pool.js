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
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.agesConnectionPool = exports.AgesConnectionPool = void 0;
require("dotenv/config");
const logger_1 = require("../utils/logger");
const AGES_BASE_URL = (_a = process.env.HAAGES) !== null && _a !== void 0 ? _a : "http://localhost/ages";
const ASP_NET_SESSION_COOKIE = "ASP.NET_SessionId";
const AGES_TOKEN_HEADER = "AGES_TOKEN";
const WARMUP_TIMEOUT_MS = 50000;
const WARMUP_MAX_ATTEMPTS = 2;
const PING_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MINI_SLOTS = 5;
const DEFAULT_BIGB_SLOTS = 5;
const initialEndpoints = createInitialEndpoints();
class AgesConnectionPool {
    constructor(baseUrl = AGES_BASE_URL, endpoints = initialEndpoints) {
        this.baseUrl = baseUrl;
        this.nextSlotIndex = 0;
        this.pingSweepRunning = false;
        this.slots = endpoints.map((item, index) => ({
            id: index + 1,
            kind: item.kind,
            endpoint: item.endpoint,
            url: this.resolveEndpoint(item.endpoint),
            warmupResponse: "",
            agesToken: "",
            aspNetSessionId: "",
            status: "idle"
        }));
    }
    warmUp() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.warmupPromise) {
                return this.warmupPromise;
            }
            this.warmupPromise = this.runWarmUp().finally(() => {
                this.warmupPromise = undefined;
            });
            return this.warmupPromise;
        });
    }
    runWarmUp() {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            (0, logger_1.log)(`warmup start | n=${this.slots.length}`);
            for (const slot of this.slots) {
                yield this.initializeSlot(slot);
                if (slot.status !== "ready") {
                    (0, logger_1.warn)([
                        `warmup stop`,
                        this.formatSlot(slot),
                        `err=${(_a = slot.lastError) !== null && _a !== void 0 ? _a : "unknown"}`
                    ].join(" | "));
                    break;
                }
            }
            return this.getSummary();
        });
    }
    getSummary() {
        const slots = this.slots.map((slot) => ({
            id: slot.id,
            kind: slot.kind,
            status: slot.status,
            lastStatusCode: slot.lastStatusCode,
            lastInitializedAt: slot.lastInitializedAt,
            lastError: slot.lastError,
            warmupResponse: slot.warmupResponse,
            agesToken: slot.agesToken,
            aspNetSessionId: slot.aspNetSessionId
        }));
        return {
            baseUrl: this.baseUrl,
            size: this.slots.length,
            ready: this.slots.filter((slot) => slot.status === "ready").length,
            warming: this.slots.filter((slot) => slot.status === "warming").length,
            error: this.slots.filter((slot) => slot.status === "error").length,
            slots
        };
    }
    request(slotId_1, endpoint_1) {
        return __awaiter(this, arguments, void 0, function* (slotId, endpoint, init = {}) {
            const slot = this.getSlot(slotId);
            const response = yield fetch(this.resolveEndpoint(endpoint), Object.assign(Object.assign({}, init), { headers: this.buildSessionHeaders(slot, init.headers) }));
            this.captureSessionState(slot, response);
            return response;
        });
    }
    startPingMonitor() {
        var _a, _b;
        if (this.pingMonitor) {
            return;
        }
        this.pingMonitor = setInterval(() => {
            void this.runPingSweep();
        }, PING_INTERVAL_MS);
        (_b = (_a = this.pingMonitor).unref) === null || _b === void 0 ? void 0 : _b.call(_a);
    }
    proxyCall(kind_1, functionName_1) {
        return __awaiter(this, arguments, void 0, function* (kind, functionName, queryString = "", init = {}, sourceIp = "") {
            var _a;
            if (!this.isReady()) {
                throw new Error("AGES pool is still in warmup");
            }
            const slot = this.getNextReadySlot(kind);
            const endpoint = this.buildFunctionEndpoint(kind, functionName);
            const agesUrl = this.appendQueryString(this.resolveEndpoint(endpoint), queryString);
            this.logProxyCall(slot, (_a = init.method) !== null && _a !== void 0 ? _a : "GET", agesUrl, sourceIp);
            const response = yield fetch(agesUrl, Object.assign(Object.assign({}, init), { headers: this.buildSessionHeaders(slot, init.headers) }));
            this.captureSessionState(slot, response);
            return {
                slotId: slot.id,
                slotKind: slot.kind,
                agesUrl,
                status: response.status,
                headers: this.responseHeadersToObject(response.headers),
                body: Buffer.from(yield response.arrayBuffer())
            };
        });
    }
    initializeSlot(slot) {
        return __awaiter(this, void 0, void 0, function* () {
            slot.status = "warming";
            slot.lastError = undefined;
            for (let attempt = 1; attempt <= WARMUP_MAX_ATTEMPTS; attempt++) {
                try {
                    const response = yield this.fetchWarmup(slot);
                    slot.lastStatusCode = response.status;
                    slot.lastInitializedAt = new Date().toISOString();
                    this.captureSessionState(slot, response);
                    slot.warmupResponse = yield response.text();
                    if (slot.agesToken && slot.aspNetSessionId) {
                        slot.status = "ready";
                        this.logSlotReady(slot, attempt);
                        return slot.status;
                    }
                    slot.status = "error";
                    slot.lastError = `AGES did not return ${AGES_TOKEN_HEADER} and ${ASP_NET_SESSION_COOKIE}`;
                }
                catch (error) {
                    slot.status = "error";
                    slot.lastInitializedAt = new Date().toISOString();
                    slot.lastError = error instanceof Error ? error.message : String(error);
                }
                if (attempt < WARMUP_MAX_ATTEMPTS) {
                    this.logSlotRetry(slot, attempt + 1);
                }
            }
            this.logSlotError(slot);
            return slot.status;
        });
    }
    runPingSweep() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.pingSweepRunning) {
                (0, logger_1.warn)("ping skip | err=previous sweep running");
                return;
            }
            this.pingSweepRunning = true;
            try {
                for (const slot of this.slots) {
                    yield this.pingSlot(slot);
                }
            }
            finally {
                this.pingSweepRunning = false;
            }
        });
    }
    pingSlot(slot) {
        return __awaiter(this, void 0, void 0, function* () {
            if (slot.status !== "ready") {
                if (slot.status === "warming") {
                    (0, logger_1.warn)([
                        `ping skip`,
                        this.formatSlot(slot),
                        `st=${slot.status}`
                    ].join(" | "));
                    return;
                }
                slot.lastError = `slot status is ${slot.status}`;
                (0, logger_1.warn)([
                    `ping recycle`,
                    this.formatSlot(slot),
                    `st=${slot.status}`
                ].join(" | "));
                yield this.recycleSlot(slot, this.resolveEndpoint(this.buildFunctionEndpoint(slot.kind, "ping")));
                return;
            }
            const pingUrl = this.resolveEndpoint(this.buildFunctionEndpoint(slot.kind, "ping"));
            try {
                const response = yield this.fetchWithTimeout(pingUrl, {
                    method: "GET",
                    headers: this.buildSessionHeaders(slot)
                });
                this.captureSessionState(slot, response);
                slot.lastStatusCode = response.status;
                if (response.status === 200) {
                    return;
                }
                slot.lastError = `ping returned status ${response.status}`;
                yield this.recycleSlot(slot, pingUrl);
            }
            catch (error) {
                slot.lastError = error instanceof Error ? error.message : String(error);
                yield this.recycleSlot(slot, pingUrl);
            }
        });
    }
    recycleSlot(slot, pingUrl) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            (0, logger_1.warn)([
                `recycle start`,
                this.formatSlot(slot),
                `u=${this.formatUrl(pingUrl)}`,
                `err=${(_a = slot.lastError) !== null && _a !== void 0 ? _a : "unknown"}`
            ].join(" | "));
            slot.agesToken = "";
            slot.aspNetSessionId = "";
            slot.warmupResponse = "";
            slot.status = "idle";
            const recycledStatus = yield this.initializeSlot(slot);
            if (recycledStatus === "ready") {
                (0, logger_1.log)([
                    `recycle ok`,
                    this.formatSlot(slot),
                    `st=${recycledStatus}`
                ].join(" | "));
                return;
            }
            (0, logger_1.warn)([
                `recycle fail`,
                this.formatSlot(slot),
                `st=${recycledStatus}`,
                `err=${(_b = slot.lastError) !== null && _b !== void 0 ? _b : "unknown"}`
            ].join(" | "));
        });
    }
    fetchWarmup(slot) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.fetchWithTimeout(slot.url, {
                method: "GET",
                headers: {
                    [AGES_TOKEN_HEADER]: "",
                    Cookie: `${ASP_NET_SESSION_COOKIE}=`
                }
            });
        });
    }
    fetchWithTimeout(url, init) {
        return __awaiter(this, void 0, void 0, function* () {
            const abortController = new AbortController();
            const timeout = setTimeout(() => abortController.abort(), WARMUP_TIMEOUT_MS);
            try {
                return yield fetch(url, Object.assign(Object.assign({}, init), { signal: abortController.signal }));
            }
            finally {
                clearTimeout(timeout);
            }
        });
    }
    logSlotReady(slot, attempt) {
        var _a;
        (0, logger_1.log)([
            `ready`,
            this.formatSlot(slot),
            `u=${this.formatUrl(slot.url)}`,
            `a=${attempt}`,
            `st=${(_a = slot.lastStatusCode) !== null && _a !== void 0 ? _a : "unknown"}`,
            `${AGES_TOKEN_HEADER}=${slot.agesToken}`,
            `${ASP_NET_SESSION_COOKIE}=${slot.aspNetSessionId}`,
            `response=${slot.warmupResponse}`
        ].join(" | "));
    }
    logProxyCall(slot, method, url, sourceIp) {
        const formattedUrl = this.formatUrl(url);
        if (formattedUrl.startsWith("/ages/~mini~/beat.ages")) {
            return;
        }
        (0, logger_1.log)([
            `proxy`,
            this.formatSlot(slot),
            `ip=${sourceIp || "unknown"}`,
            `m=${method}`,
            `u=${formattedUrl}`
        ].join(" | "));
    }
    logSlotRetry(slot, nextAttempt) {
        var _a;
        (0, logger_1.warn)([
            `retry`,
            this.formatSlot(slot),
            `u=${this.formatUrl(slot.url)}`,
            `a=${nextAttempt}`,
            `to=${WARMUP_TIMEOUT_MS}`,
            `err=${(_a = slot.lastError) !== null && _a !== void 0 ? _a : "unknown"}`
        ].join(" | "));
    }
    logSlotError(slot) {
        var _a, _b;
        (0, logger_1.warn)([
            `slot err`,
            this.formatSlot(slot),
            `u=${this.formatUrl(slot.url)}`,
            `st=${(_a = slot.lastStatusCode) !== null && _a !== void 0 ? _a : "unknown"}`,
            `err=${(_b = slot.lastError) !== null && _b !== void 0 ? _b : "unknown"}`
        ].join(" | "));
    }
    captureSessionState(slot, response) {
        var _a;
        const agesToken = (_a = response.headers.get(AGES_TOKEN_HEADER)) !== null && _a !== void 0 ? _a : response.headers.get("AGES-TOKEN");
        const aspNetSessionId = this.extractAspNetSessionId(response.headers);
        if (agesToken) {
            slot.agesToken = agesToken;
        }
        if (aspNetSessionId) {
            slot.aspNetSessionId = aspNetSessionId;
        }
    }
    buildSessionHeaders(slot, headers) {
        var _a, _b;
        const normalizedHeaders = this.normalizeHeaders(headers);
        const currentCookie = (_b = (_a = normalizedHeaders.Cookie) !== null && _a !== void 0 ? _a : normalizedHeaders.cookie) !== null && _b !== void 0 ? _b : "";
        delete normalizedHeaders.cookie;
        normalizedHeaders[AGES_TOKEN_HEADER] = slot.agesToken;
        normalizedHeaders.Cookie = this.mergeCookies(currentCookie, `${ASP_NET_SESSION_COOKIE}=${slot.aspNetSessionId}`);
        return normalizedHeaders;
    }
    responseHeadersToObject(headers) {
        const normalizedHeaders = {};
        headers.forEach((value, key) => {
            normalizedHeaders[key] = value;
        });
        const setCookieHeaders = this.getSetCookieHeaders(headers);
        if (setCookieHeaders.length > 0) {
            normalizedHeaders["set-cookie"] = setCookieHeaders;
        }
        return normalizedHeaders;
    }
    normalizeHeaders(headers) {
        const normalizedHeaders = {};
        if (!headers) {
            return normalizedHeaders;
        }
        new Headers(headers).forEach((value, key) => {
            normalizedHeaders[key] = value;
        });
        return normalizedHeaders;
    }
    extractAspNetSessionId(headers) {
        var _a;
        const setCookieHeaders = this.getSetCookieHeaders(headers).join(",");
        const match = setCookieHeaders.match(/ASP\.NET_SessionId=([^;,\s]+)/i);
        return (_a = match === null || match === void 0 ? void 0 : match[1]) !== null && _a !== void 0 ? _a : "";
    }
    getSetCookieHeaders(headers) {
        const nodeHeaders = headers;
        const cookies = typeof nodeHeaders.getSetCookie === "function" ? nodeHeaders.getSetCookie() : [];
        const setCookie = headers.get("set-cookie");
        return setCookie ? [...cookies, setCookie] : cookies;
    }
    mergeCookies(currentCookie, sessionCookie) {
        const withoutSession = currentCookie
            .split(";")
            .map((cookie) => cookie.trim())
            .filter((cookie) => cookie && !cookie.toLowerCase().startsWith(`${ASP_NET_SESSION_COOKIE.toLowerCase()}=`));
        return [...withoutSession, sessionCookie].join("; ");
    }
    getSlot(slotId) {
        const slot = this.slots.find((item) => item.id === slotId);
        if (!slot) {
            throw new Error(`AGES pool slot ${slotId} does not exist`);
        }
        return slot;
    }
    getNextReadySlot(kind) {
        const readySlots = this.slots.filter((slot) => slot.kind === kind && slot.status === "ready");
        if (readySlots.length === 0) {
            throw new Error(`AGES ${kind} pool has no ready slots`);
        }
        const slot = readySlots[this.nextSlotIndex % readySlots.length];
        this.nextSlotIndex = (this.nextSlotIndex + 1) % readySlots.length;
        return slot;
    }
    isReady() {
        return this.slots.length > 0 && this.slots.every((slot) => slot.status === "ready");
    }
    buildFunctionEndpoint(kind, functionName) {
        const normalizedFunctionName = functionName.replace(/^\/+/, "");
        const agesFile = normalizedFunctionName.toLowerCase().endsWith(".ages")
            ? normalizedFunctionName
            : `${normalizedFunctionName}.ages`;
        return kind === "mini" ? `/~mini~/${agesFile}` : agesFile;
    }
    appendQueryString(url, queryString) {
        const normalizedQueryString = queryString.replace(/^\?/, "");
        return normalizedQueryString ? `${url}?${normalizedQueryString}` : url;
    }
    resolveEndpoint(endpoint) {
        return `${this.baseUrl.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
    }
    formatSlotId(slotId) {
        return slotId.toString().padStart(2, "0");
    }
    formatKind(kind) {
        return kind === "mini" ? "M" : "B";
    }
    formatSlot(slot) {
        return `S${this.formatSlotId(slot.id)}${this.formatKind(slot.kind)}`;
    }
    formatUrl(url) {
        try {
            const parsedUrl = new URL(url);
            return `${parsedUrl.pathname}${parsedUrl.search}`;
        }
        catch (_a) {
            return url.replace(this.baseUrl.replace(/\/+$/, ""), "");
        }
    }
}
exports.AgesConnectionPool = AgesConnectionPool;
function createInitialEndpoints() {
    return [
        ...Array(getEnvSlotCount("slots_mini", DEFAULT_MINI_SLOTS)).fill({
            kind: "mini",
            endpoint: "/~mini~/dummy_val.ages"
        }),
        ...Array(getEnvSlotCount("slots_bigb", DEFAULT_BIGB_SLOTS)).fill({
            kind: "bigb",
            endpoint: "dummy_val.ages"
        })
    ];
}
function getEnvSlotCount(envName, fallback) {
    const rawValue = process.env[envName];
    if (!rawValue) {
        return fallback;
    }
    const value = Number.parseInt(rawValue, 10);
    if (!Number.isInteger(value) || value < 0) {
        (0, logger_1.warn)(`Invalid ${envName}="${rawValue}". Using fallback ${fallback}.`);
        return fallback;
    }
    return value;
}
exports.agesConnectionPool = new AgesConnectionPool();
