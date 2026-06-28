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
var _a, _b, _c, _d, _e;
Object.defineProperty(exports, "__esModule", { value: true });
exports.agesConnectionPool = exports.AgesConnectionPool = void 0;
require("dotenv/config");
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const util_1 = require("util");
const logger_1 = require("../utils/logger");
const AGES_BASE_URL = (_a = process.env.HAAGES) !== null && _a !== void 0 ? _a : "http://localhost/ages";
const ASP_NET_SESSION_COOKIE = "ASP.NET_SessionId";
const AGES_TOKEN_HEADER = "AGES_TOKEN";
const AGES_API_KEY_HEADER = "X-AGES-API-Key";
const WARMUP_TIMEOUT_MS = 50000;
const WARMUP_MAX_ATTEMPTS = 2;
const PING_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MINI_SLOTS = 5;
const DEFAULT_BIGB_SLOTS = 5;
const INITIAL_MINI_SLOTS = getEnvSlotCount("slots_mini", DEFAULT_MINI_SLOTS);
const INITIAL_BIGB_SLOTS = getEnvSlotCount("slots_bigb", DEFAULT_BIGB_SLOTS);
const MAX_MINI_SLOTS = getEnvMaxSlotCount("slots_mini_max", INITIAL_MINI_SLOTS);
const MAX_BIGB_SLOTS = getEnvMaxSlotCount("slots_bigb_max", INITIAL_BIGB_SLOTS);
const ADAPTIVE_SLOT_HOLD_MS = getEnvDurationMinutes("slots_adaptive_hold_minutes", 30) * 60 * 1000;
const ADAPTIVE_SWEEP_INTERVAL_MS = 60 * 1000;
const ERROR_DEBUG_DETAILS = isConfigEnabled("ERROR_DEBUG_DETAILS", true);
const AGES_SSH_HOST = (_b = process.env.AGES_SSH_HOST) !== null && _b !== void 0 ? _b : getHostFromUrl(AGES_BASE_URL);
const AGES_SSH_USER = (_c = process.env.AGES_SSH_USER) !== null && _c !== void 0 ? _c : "";
const AGES_SSH_KEY_PATH = (_d = process.env.AGES_SSH_KEY_PATH) !== null && _d !== void 0 ? _d : "/app/keys/ch09_brk_iis";
const AGES_SSH_RESTART_COMMAND = (_e = process.env.AGES_SSH_RESTART_COMMAND) !== null && _e !== void 0 ? _e : "powershell -NoProfile -ExecutionPolicy Bypass -Command \"iisreset /restart\"";
const AGES_IIS_RESTART_COOLDOWN_MS = getEnvDurationSeconds("AGES_IIS_RESTART_COOLDOWN_SECONDS", 300) * 1000;
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
const initialEndpoints = createInitialEndpoints();
class AgesConnectionPool {
    constructor(baseUrl = AGES_BASE_URL, endpoints = initialEndpoints) {
        this.baseUrl = baseUrl;
        this.nextSlotId = 1;
        this.nextSlotIndex = 0;
        this.pingSweepRunning = false;
        this.agesHostRestartRunning = false;
        this.agesHostRestartCooldownUntil = 0;
        this.initialWarmupFinished = false;
        this.traceSequence = 0;
        this.timingLog = [];
        this.slotWaiters = {
            bigb: [],
            mini: []
        };
        this.growPromises = {};
        this.slots = endpoints.map((item) => this.createSlot(item.kind, false));
    }
    warmUp() {
        return __awaiter(this, arguments, void 0, function* (reason = "warmup requested") {
            if (this.warmupPromise) {
                return this.warmupPromise;
            }
            this.warmupPromise = this.runWarmUp({ resetBeforeStart: true, resetReason: reason }).finally(() => {
                this.warmupPromise = undefined;
            });
            return this.warmupPromise;
        });
    }
    runWarmUp() {
        return __awaiter(this, arguments, void 0, function* (options = {}) {
            var _a, _b;
            this.initialWarmupFinished = false;
            const warmupSlots = [...this.slots];
            if (options.resetBeforeStart) {
                yield this.resetPoolForWarmup((_a = options.resetReason) !== null && _a !== void 0 ? _a : "warmup requested");
            }
            (0, logger_1.log)([
                `warmup start`,
                `n=${this.slots.length}`,
                `mini=${this.slots.filter((slot) => slot.kind === "mini").length}`,
                `BigBoy=${this.slots.filter((slot) => slot.kind === "bigb").length}`,
                `base=${this.baseUrl}`,
                `host=${getHostFromUrl(this.baseUrl) || "unknown"}`,
                `proto=${getProtocolFromUrl(this.baseUrl) || "unknown"}`,
                `ssh=${AGES_SSH_HOST || "unset"}`
            ].join(" | "));
            for (const slot of warmupSlots) {
                yield this.initializeSlot(slot);
                if (slot.status !== "ready") {
                    (0, logger_1.warn)([
                        `warmup slot fail`,
                        this.formatSlot(slot),
                        `err=${(_b = slot.lastError) !== null && _b !== void 0 ? _b : "unknown"}`
                    ].join(" | "));
                    continue;
                }
                this.notifySlotWaiters(slot.kind);
            }
            this.initialWarmupFinished = warmupSlots.every((slot) => slot.status === "ready");
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
            lastEndpoint: slot.lastEndpoint,
            lastUsedAt: slot.lastUsedAt,
            lastResponsePreview: slot.lastResponsePreview,
            lastResponseBody: slot.lastResponseBody,
            warmupResponse: slot.warmupResponse,
            agesToken: slot.agesToken,
            aspNetSessionId: slot.aspNetSessionId,
            inUse: slot.inUse,
            dynamic: slot.dynamic,
            holdUntil: slot.holdUntil ? new Date(slot.holdUntil).toISOString() : undefined
        }));
        return {
            baseUrl: this.baseUrl,
            size: this.slots.length,
            ready: this.slots.filter((slot) => slot.status === "ready").length,
            warming: this.slots.filter((slot) => slot.status === "warming").length,
            error: this.slots.filter((slot) => slot.status === "error").length,
            config: {
                adaptiveHoldMinutes: ADAPTIVE_SLOT_HOLD_MS / 60 / 1000,
                mini: this.getKindSummary("mini"),
                bigb: this.getKindSummary("bigb")
            },
            iisRestart: {
                running: this.agesHostRestartRunning,
                cooldownSeconds: AGES_IIS_RESTART_COOLDOWN_MS / 1000,
                lastStartedAt: this.lastAgesHostRestartStartedAt,
                lastFinishedAt: this.lastAgesHostRestartFinishedAt,
                cooldownUntil: this.agesHostRestartCooldownUntil > Date.now()
                    ? new Date(this.agesHostRestartCooldownUntil).toISOString()
                    : undefined
            },
            slots
        };
    }
    getTimingLog() {
        return [...this.timingLog].reverse();
    }
    clearTimingLog() {
        const cleared = this.timingLog.length;
        this.timingLog.length = 0;
        return {
            status: "ok",
            cleared
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
        this.startAdaptiveSweep();
    }
    recycleSlotByReference(slotReference) {
        return __awaiter(this, void 0, void 0, function* () {
            const slot = this.getSlotByReference(slotReference);
            slot.lastError = "manual recycle requested";
            yield this.recycleSlot(slot, this.resolveEndpoint(this.buildFunctionEndpoint(slot.kind, "manual")));
            return this.getSummary();
        });
    }
    restartAgesHostManually() {
        return __awaiter(this, void 0, void 0, function* () {
            const reason = "manual_iis_restart";
            const restarted = yield this.restartAgesHost(reason);
            return {
                status: restarted ? "ok" : "error",
                host: AGES_SSH_HOST,
                reason
            };
        });
    }
    proxyCall(kind_1, functionName_1) {
        return __awaiter(this, arguments, void 0, function* (kind, functionName, queryString = "", init = {}, sourceIp = "", sourceIpSource = "") {
            var _a, _b, _c, _d, _e;
            const brokerInMs = Date.now();
            if (!this.hasReadySlot(kind)) {
                throw new Error(`AGES ${kind} pool is still in warmup`);
            }
            const endpoint = this.buildFunctionEndpoint(kind, functionName);
            const agesUrl = this.appendQueryString(this.resolveEndpoint(endpoint), queryString);
            const isInternalBeat = this.isInternalBeatEndpoint(kind, endpoint);
            const excludedSlotIds = new Set();
            let damagedSlotRetryAttempt = 0;
            while (true) {
                const attemptBrokerInMs = Date.now();
                const trace = this.createTimingTrace(kind, (_a = init.method) !== null && _a !== void 0 ? _a : "GET", agesUrl, sourceIp, sourceIpSource, attemptBrokerInMs);
                trace.slotWaitStartAt = new Date().toISOString();
                const slot = yield this.acquireSlot(kind, {
                    allowGrow: !this.warmupPromise && !isInternalBeat,
                    baseOnly: isInternalBeat,
                    excludeSlotIds: excludedSlotIds
                });
                const slotAcquiredMs = Date.now();
                trace.slot = this.formatSlot(slot);
                trace.slotDynamic = slot.dynamic;
                trace.slotAcquiredAt = new Date(slotAcquiredMs).toISOString();
                trace.waitMs = slotAcquiredMs - brokerInMs;
                this.logProxyCall(slot, (_b = init.method) !== null && _b !== void 0 ? _b : "GET", agesUrl, sourceIp, sourceIpSource);
                const requestHeaders = this.buildSessionHeaders(slot, init.headers);
                let response;
                let agesStartMs = 0;
                let agesEndMs = 0;
                try {
                    try {
                        agesStartMs = Date.now();
                        trace.agesStartAt = new Date(agesStartMs).toISOString();
                        response = yield fetch(agesUrl, Object.assign(Object.assign({}, init), { headers: requestHeaders }));
                        agesEndMs = Date.now();
                        trace.agesEndAt = new Date(agesEndMs).toISOString();
                        trace.agesMs = agesEndMs - agesStartMs;
                    }
                    catch (error) {
                        agesEndMs = Date.now();
                        trace.agesEndAt = new Date(agesEndMs).toISOString();
                        trace.agesMs = agesStartMs ? agesEndMs - agesStartMs : undefined;
                        trace.error = formatError(error);
                        slot.lastError = formatError(error);
                        this.logProxyError(slot, (_c = init.method) !== null && _c !== void 0 ? _c : "GET", agesUrl, sourceIp, sourceIpSource, {
                            error,
                            requestHeaders,
                            requestBodySize: getBodySize(init.body)
                        });
                        throw error;
                    }
                    this.captureSessionState(slot, response);
                    slot.lastStatusCode = response.status;
                    const body = Buffer.from(yield response.arrayBuffer());
                    trace.status = response.status;
                    trace.bytes = body.length;
                    if (!isInternalBeat) {
                        this.recordSlotUse(slot, agesUrl, body);
                    }
                    if (response.status >= 400) {
                        this.logProxyError(slot, (_d = init.method) !== null && _d !== void 0 ? _d : "GET", agesUrl, sourceIp, sourceIpSource, {
                            status: response.status,
                            responseHeaders: this.responseHeadersToObject(response.headers),
                            responsePreview: this.previewBody(body),
                            requestHeaders,
                            requestBodySize: getBodySize(init.body)
                        });
                    }
                    if (response.status === 503) {
                        yield this.restartAgesHost(this.isDllInitError(response.status, body) ? "dll_init_error" : "ages_503");
                    }
                    const avfpInvalidObjectReason = this.getAvfpInvalidObjectReason(body);
                    if (avfpInvalidObjectReason) {
                        excludedSlotIds.add(slot.id);
                        damagedSlotRetryAttempt += 1;
                        slot.agesToken = "";
                        slot.lastError = avfpInvalidObjectReason;
                        slot.status = "error";
                        trace.error = avfpInvalidObjectReason;
                        this.logProxyError(slot, (_e = init.method) !== null && _e !== void 0 ? _e : "GET", agesUrl, sourceIp, sourceIpSource, {
                            status: response.status,
                            responseHeaders: this.responseHeadersToObject(response.headers),
                            responsePreview: this.previewBody(body),
                            requestHeaders,
                            requestBodySize: getBodySize(init.body)
                        });
                        const hasExistingRetrySlot = this.hasAvailableAlternateSlot(kind, excludedSlotIds, isInternalBeat);
                        const shouldGrowAdaptiveRetrySlot = !hasExistingRetrySlot && this.canGrowAdaptiveRetrySlot(kind, isInternalBeat);
                        if (hasExistingRetrySlot || shouldGrowAdaptiveRetrySlot) {
                            this.recordDamagedSlotRetry(slot, avfpInvalidObjectReason, damagedSlotRetryAttempt, shouldGrowAdaptiveRetrySlot);
                            void this.recycleDamagedSlot(slot, agesUrl);
                            continue;
                        }
                        throw new Error(`${avfpInvalidObjectReason}; no alternate ${kind} slot available`);
                    }
                    const recycleReason = this.getRecycleReason(response.status, body);
                    if (recycleReason) {
                        slot.lastError = recycleReason;
                        yield this.recycleSlot(slot, agesUrl);
                    }
                    return {
                        slotId: slot.id,
                        slotKind: slot.kind,
                        agesUrl,
                        status: response.status,
                        headers: this.responseHeadersToObject(response.headers),
                        body,
                        traceId: trace.id,
                        traceHeaders: this.buildTraceHeaders(trace)
                    };
                }
                finally {
                    this.completeTimingTrace(trace);
                    this.releaseSlot(slot, !isInternalBeat);
                }
            }
        });
    }
    completeTraceResponse(traceId, status, bytes) {
        const trace = this.timingLog.find((item) => item.id === traceId);
        if (!trace) {
            return undefined;
        }
        trace.status = status;
        trace.bytes = bytes;
        trace.brokerOutAt = new Date().toISOString();
        trace.totalMs = Date.parse(trace.brokerOutAt) - Date.parse(trace.brokerInAt);
        return trace;
    }
    initializeSlot(slot) {
        return __awaiter(this, void 0, void 0, function* () {
            this.clearSlotForWarmup(slot);
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
                for (const slot of [...this.slots]) {
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
            if (slot.inUse) {
                return;
            }
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
            this.clearSlotForWarmup(slot);
            slot.status = "idle";
            const recycledStatus = yield this.initializeSlot(slot);
            if (recycledStatus === "ready") {
                (0, logger_1.log)([
                    `recycle ok`,
                    this.formatSlot(slot),
                    `st=${recycledStatus}`
                ].join(" | "));
                this.notifySlotWaiters(slot.kind);
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
                headers: this.buildSessionHeaders(slot, undefined, { includeInternalApiKey: true })
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
    logProxyCall(slot, method, url, sourceIp, sourceIpSource) {
        const formattedUrl = this.formatUrl(url);
        if (formattedUrl.startsWith("/ages/~mini~/beat.ages")) {
            return;
        }
        (0, logger_1.log)([
            `proxy`,
            this.formatSlot(slot),
            `ip=${sourceIp || "unknown"}`,
            `ips=${sourceIpSource || "unknown"}`,
            `m=${method}`,
            `u=${formattedUrl}`
        ].join(" | "));
    }
    logProxyError(slot, method, url, sourceIp, sourceIpSource, detail) {
        var _a, _b, _c;
        (0, logger_1.warn)((ERROR_DEBUG_DETAILS
            ? [
                `proxy err`,
                this.formatSlot(slot),
                `ip=${sourceIp || "unknown"}`,
                `ips=${sourceIpSource || "unknown"}`,
                `m=${method}`,
                `u=${this.formatUrl(url)}`,
                `st=${(_a = detail.status) !== null && _a !== void 0 ? _a : "fetch-fail"}`,
                `rb=${(_b = detail.requestBodySize) !== null && _b !== void 0 ? _b : 0}`,
                `reqh=${this.formatHeaderNames(detail.requestHeaders)}`,
                detail.responseHeaders ? `resh=${this.formatHeaderNames(detail.responseHeaders)}` : "",
                detail.responsePreview ? `resp=${detail.responsePreview}` : "",
                detail.error ? `err=${formatError(detail.error)}` : ""
            ]
            : [
                `proxy err`,
                this.formatSlot(slot),
                `m=${method}`,
                `u=${this.formatUrl(url)}`,
                `st=${(_c = detail.status) !== null && _c !== void 0 ? _c : "fetch-fail"}`,
                detail.error ? `err=${shortError(detail.error)}` : ""
            ])
            .filter(Boolean)
            .join(" | "));
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
    buildSessionHeaders(slot, headers, options = {}) {
        var _a, _b, _c;
        const normalizedHeaders = this.normalizeHeaders(headers);
        const currentCookie = (_b = (_a = normalizedHeaders.Cookie) !== null && _a !== void 0 ? _a : normalizedHeaders.cookie) !== null && _b !== void 0 ? _b : "";
        delete normalizedHeaders.cookie;
        normalizedHeaders[AGES_TOKEN_HEADER] = slot.agesToken;
        const agesApiKey = (_c = process.env.AGES_API_KEY) !== null && _c !== void 0 ? _c : readEnvFileValue("AGES_API_KEY");
        if (options.includeInternalApiKey && agesApiKey && !hasHeader(normalizedHeaders, AGES_API_KEY_HEADER)) {
            normalizedHeaders[AGES_API_KEY_HEADER] = agesApiKey;
        }
        else if (options.includeInternalApiKey && !agesApiKey && !hasHeader(normalizedHeaders, AGES_API_KEY_HEADER)) {
            (0, logger_1.warn)(`AGES API key is not configured; ${AGES_API_KEY_HEADER} header will not be sent.`);
        }
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
    getSlotByReference(slotReference) {
        const normalizedReference = slotReference.trim().toUpperCase();
        const idMatch = normalizedReference.match(/^S?(\d{1,2})(?:[MB])?$/);
        if (!idMatch) {
            throw new Error(`Invalid slot reference ${slotReference}`);
        }
        return this.getSlot(Number.parseInt(idMatch[1], 10));
    }
    getNextReadySlot(kind) {
        const readySlots = this.slots.filter((slot) => slot.kind === kind && slot.status === "ready" && !slot.inUse);
        if (readySlots.length === 0) {
            throw new Error(`AGES ${kind} pool has no ready slots`);
        }
        const slot = readySlots[this.nextSlotIndex % readySlots.length];
        this.nextSlotIndex = (this.nextSlotIndex + 1) % readySlots.length;
        return slot;
    }
    hasReadySlot(kind) {
        const slots = this.slots.filter((slot) => slot.kind === kind);
        return slots.some((slot) => slot.status === "ready");
    }
    hasAvailableAlternateSlot(kind, excludeSlotIds, baseOnly) {
        return this.slots.some((slot) => slot.kind === kind &&
            slot.status === "ready" &&
            !slot.inUse &&
            !excludeSlotIds.has(slot.id) &&
            (!baseOnly || !slot.dynamic));
    }
    canGrowAdaptiveRetrySlot(kind, baseOnly) {
        return !baseOnly && !this.warmupPromise && this.getSlotCount(kind) < this.getMaxSlots(kind);
    }
    acquireSlot(kind, options) {
        return __awaiter(this, void 0, void 0, function* () {
            while (true) {
                const readySlot = this.getNextAvailableSlot(kind, options.baseOnly, options.excludeSlotIds);
                if (readySlot) {
                    readySlot.inUse = true;
                    return readySlot;
                }
                if (options.allowGrow && this.getSlotCount(kind) < this.getMaxSlots(kind)) {
                    const grownSlot = yield this.growPool(kind);
                    if (grownSlot) {
                        return grownSlot;
                    }
                }
                yield this.waitForSlot(kind);
            }
        });
    }
    getNextAvailableSlot(kind, baseOnly, excludeSlotIds = new Set()) {
        const baseReadySlots = this.slots.filter((slot) => slot.kind === kind && slot.status === "ready" && !slot.inUse && !slot.dynamic && !excludeSlotIds.has(slot.id));
        if (baseReadySlots.length > 0) {
            const slot = baseReadySlots[this.nextSlotIndex % baseReadySlots.length];
            this.nextSlotIndex = (this.nextSlotIndex + 1) % baseReadySlots.length;
            return slot;
        }
        if (baseOnly) {
            return undefined;
        }
        const adaptiveReadySlots = this.slots.filter((slot) => slot.kind === kind && slot.status === "ready" && !slot.inUse && slot.dynamic && !excludeSlotIds.has(slot.id));
        if (adaptiveReadySlots.length === 0) {
            return undefined;
        }
        const slot = adaptiveReadySlots[this.nextSlotIndex % adaptiveReadySlots.length];
        this.nextSlotIndex = (this.nextSlotIndex + 1) % adaptiveReadySlots.length;
        return slot;
    }
    growPool(kind) {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.growPromises[kind]) {
                yield this.growPromises[kind];
                return undefined;
            }
            this.growPromises[kind] = this.runGrowPool(kind).finally(() => {
                this.growPromises[kind] = undefined;
            });
            return this.growPromises[kind];
        });
    }
    runGrowPool(kind) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            const maxSlots = this.getMaxSlots(kind);
            const kindSlots = this.slots.filter((slot) => slot.kind === kind);
            if (kindSlots.length >= maxSlots) {
                (0, logger_1.warn)(`pool grow skip | kind=${this.formatKind(kind)} | n=${kindSlots.length} | max=${maxSlots}`);
                return undefined;
            }
            const slot = this.createSlot(kind, true);
            this.slots.push(slot);
            (0, logger_1.warn)(`pool grow | ${this.formatSlot(slot)} | n=${kindSlots.length + 1} | max=${maxSlots} | hold=${ADAPTIVE_SLOT_HOLD_MS}`);
            const status = yield this.initializeSlot(slot);
            if (status !== "ready") {
                (0, logger_1.warn)(`pool grow fail | ${this.formatSlot(slot)} | st=${status} | err=${(_a = slot.lastError) !== null && _a !== void 0 ? _a : "unknown"}`);
                this.removeSlot(slot);
                return undefined;
            }
            slot.inUse = true;
            return slot;
        });
    }
    releaseSlot(slot, extendAdaptiveHold = true) {
        slot.inUse = false;
        if (slot.dynamic && extendAdaptiveHold) {
            slot.holdUntil = Date.now() + ADAPTIVE_SLOT_HOLD_MS;
        }
        this.notifySlotWaiters(slot.kind);
    }
    waitForSlot(kind) {
        const waiters = this.slotWaiters[kind];
        (0, logger_1.warn)([
            `pool wait`,
            `kind=${this.formatKind(kind)}`,
            `q=${waiters.length + 1}`,
            `n=${this.getSlotCount(kind)}`,
            `max=${this.getMaxSlots(kind)}`
        ].join(" | "));
        return new Promise((resolve) => {
            waiters.push(resolve);
        });
    }
    notifySlotWaiters(kind) {
        const waiters = this.slotWaiters[kind].splice(0);
        waiters.forEach((waiter) => {
            waiter();
        });
    }
    startAdaptiveSweep() {
        var _a, _b;
        if (this.adaptiveSweep) {
            return;
        }
        this.adaptiveSweep = setInterval(() => {
            this.shrinkAdaptiveSlots();
        }, ADAPTIVE_SWEEP_INTERVAL_MS);
        (_b = (_a = this.adaptiveSweep).unref) === null || _b === void 0 ? void 0 : _b.call(_a);
    }
    shrinkAdaptiveSlots() {
        const now = Date.now();
        for (const kind of ["mini", "bigb"]) {
            const minSlots = this.getInitialSlots(kind);
            const kindSlots = this.slots.filter((slot) => slot.kind === kind);
            kindSlots.forEach((slot) => {
                if (slot.dynamic && !slot.inUse && !slot.holdUntil) {
                    slot.holdUntil = now + ADAPTIVE_SLOT_HOLD_MS;
                }
            });
            const removableSlots = kindSlots.filter((slot) => { var _a; return slot.dynamic && !slot.inUse && slot.status !== "warming" && ((_a = slot.holdUntil) !== null && _a !== void 0 ? _a : 0) <= now; });
            for (const slot of removableSlots) {
                if (this.slots.filter((item) => item.kind === kind).length <= minSlots) {
                    break;
                }
                const index = this.slots.indexOf(slot);
                if (index >= 0) {
                    this.removeSlot(slot);
                    (0, logger_1.log)(`pool shrink | ${this.formatSlot(slot)} | n=${this.slots.filter((item) => item.kind === kind).length}`);
                }
            }
        }
    }
    removeSlot(slot) {
        const index = this.slots.indexOf(slot);
        if (index >= 0) {
            this.slots.splice(index, 1);
        }
    }
    createSlot(kind, dynamic) {
        const endpoint = kind === "mini" ? "/~mini~/dummy_val.ages" : "dummy_val.ages";
        return {
            id: this.nextSlotId++,
            kind,
            endpoint,
            url: this.resolveEndpoint(endpoint),
            warmupResponse: "",
            agesToken: "",
            aspNetSessionId: "",
            status: "idle",
            inUse: false,
            dynamic,
            holdUntil: dynamic ? Date.now() + ADAPTIVE_SLOT_HOLD_MS : undefined
        };
    }
    getInitialSlots(kind) {
        return kind === "mini" ? INITIAL_MINI_SLOTS : INITIAL_BIGB_SLOTS;
    }
    getMaxSlots(kind) {
        return kind === "mini" ? MAX_MINI_SLOTS : MAX_BIGB_SLOTS;
    }
    getSlotCount(kind) {
        return this.slots.filter((slot) => slot.kind === kind).length;
    }
    createTimingTrace(kind, method, url, sourceIp, sourceIpSource, brokerInMs) {
        const trace = {
            id: this.createTraceId(),
            entryType: "proxy",
            kind,
            method,
            url: this.formatUrl(url),
            sourceIp,
            sourceIpSource,
            brokerInAt: new Date(brokerInMs).toISOString()
        };
        this.pushTimingTrace(trace);
        return trace;
    }
    pushTimingTrace(trace) {
        this.timingLog.push(trace);
        while (this.timingLog.length > 500) {
            this.timingLog.shift();
        }
    }
    pushTimingEvent(message, errorDetail) {
        this.pushTimingTrace({
            id: this.createTraceId(),
            entryType: "event",
            method: "EVENT",
            url: message,
            sourceIp: "system",
            sourceIpSource: "broker",
            brokerInAt: new Date().toISOString(),
            brokerOutAt: new Date().toISOString(),
            totalMs: 0,
            error: errorDetail
        });
    }
    recordDamagedSlotRetry(slot, reason, attempt, nextSlotWillBeAdaptive) {
        const nextTarget = nextSlotWillBeAdaptive ? "adaptive" : "existing";
        const message = [
            "damaged-slot retry",
            this.formatSlot(slot),
            `kind=${this.formatKind(slot.kind)}`,
            `attempt=${attempt}`,
            `next=${nextTarget}`
        ].join(" | ");
        (0, logger_1.warn)(`${message} | err=${reason}`);
        this.pushTimingTrace({
            id: this.createTraceId(),
            entryType: "event",
            kind: slot.kind,
            method: "RETRY",
            url: message,
            sourceIp: "system",
            sourceIpSource: "broker",
            slot: this.formatSlot(slot),
            slotDynamic: slot.dynamic,
            brokerInAt: new Date().toISOString(),
            brokerOutAt: new Date().toISOString(),
            totalMs: 0,
            error: reason
        });
    }
    recycleDamagedSlot(slot, agesUrl) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield this.recycleSlot(slot, agesUrl);
            }
            catch (error) {
                (0, logger_1.warn)(`damaged-slot recycle fail | ${this.formatSlot(slot)} | err=${formatError(error)}`);
                this.pushTimingEvent(`damaged-slot recycle fail: ${this.formatSlot(slot)}`, formatError(error));
            }
        });
    }
    completeTimingTrace(trace) {
        if (!trace.brokerOutAt) {
            trace.brokerOutAt = new Date().toISOString();
        }
        trace.totalMs = Date.parse(trace.brokerOutAt) - Date.parse(trace.brokerInAt);
    }
    buildTraceHeaders(trace) {
        var _a, _b, _c, _d, _e, _f;
        return {
            "X-CH09-BRK-Trace-Id": trace.id,
            "X-CH09-BRK-Broker-In": trace.brokerInAt,
            "X-CH09-BRK-Slot-Acquired": (_a = trace.slotAcquiredAt) !== null && _a !== void 0 ? _a : "",
            "X-CH09-BRK-AGES-Start": (_b = trace.agesStartAt) !== null && _b !== void 0 ? _b : "",
            "X-CH09-BRK-AGES-End": (_c = trace.agesEndAt) !== null && _c !== void 0 ? _c : "",
            "X-CH09-BRK-Wait-Ms": String((_d = trace.waitMs) !== null && _d !== void 0 ? _d : 0),
            "X-CH09-BRK-AGES-Ms": String((_e = trace.agesMs) !== null && _e !== void 0 ? _e : 0),
            "X-CH09-BRK-Slot-Dynamic": String((_f = trace.slotDynamic) !== null && _f !== void 0 ? _f : false)
        };
    }
    createTraceId() {
        this.traceSequence = (this.traceSequence + 1) % 1000000;
        return `${Date.now().toString(36)}-${this.traceSequence.toString().padStart(6, "0")}`;
    }
    getKindSummary(kind) {
        const slots = this.slots.filter((slot) => slot.kind === kind);
        const dynamicSlots = slots.filter((slot) => slot.dynamic);
        return {
            kind,
            base: this.getInitialSlots(kind),
            current: slots.length,
            ready: slots.filter((slot) => slot.status === "ready").length,
            inUse: slots.filter((slot) => slot.inUse).length,
            dynamic: dynamicSlots.length,
            dynamicReady: dynamicSlots.filter((slot) => slot.status === "ready").length,
            dynamicInUse: dynamicSlots.filter((slot) => slot.inUse).length,
            max: this.getMaxSlots(kind),
            waiting: this.slotWaiters[kind].length,
            holdMinutes: ADAPTIVE_SLOT_HOLD_MS / 60 / 1000
        };
    }
    isInternalBeatEndpoint(kind, endpoint) {
        return kind === "mini" && endpoint.replace(/^\/+/, "").toLowerCase() === "~mini~/beat.ages";
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
    recordSlotUse(slot, agesUrl, body) {
        slot.lastEndpoint = this.formatUrl(agesUrl);
        slot.lastUsedAt = new Date().toISOString();
        slot.lastResponseBody = body.toString("utf8");
        slot.lastResponsePreview = this.previewBody(body);
    }
    clearSlotForWarmup(slot) {
        slot.agesToken = "";
        slot.aspNetSessionId = "";
        slot.warmupResponse = "";
        slot.lastResponsePreview = undefined;
        slot.lastResponseBody = undefined;
        slot.lastEndpoint = undefined;
        slot.lastUsedAt = undefined;
        slot.lastStatusCode = undefined;
        slot.lastInitializedAt = undefined;
        slot.lastError = undefined;
        slot.inUse = false;
    }
    prepareSlotsForWarmup(slots) {
        slots.forEach((slot) => {
            this.clearSlotForWarmup(slot);
            slot.status = "warming";
        });
    }
    previewBody(body) {
        return body.toString("utf8").replace(/\s+/g, " ").trim().slice(0, 100);
    }
    formatHeaderNames(headers) {
        const names = Object.keys(headers !== null && headers !== void 0 ? headers : {}).sort();
        return names.length > 0 ? names.join(",") : "none";
    }
    getRecycleReason(status, body) {
        const avfpInvalidObjectReason = this.getAvfpInvalidObjectReason(body);
        if (avfpInvalidObjectReason) {
            return avfpInvalidObjectReason;
        }
        if (status >= 500) {
            return `proxy returned status ${status}`;
        }
        const responseText = body.toString("utf8");
        if (/Desde el SCRIPT:\s*(SERVICIOS_AVFP_MINI|SAVFP)\s+no es un objeto/i.test(responseText)) {
            return "AGES script object error";
        }
        return "";
    }
    getAvfpInvalidObjectReason(body) {
        return /OSAVFP\s+no es un objeto/i.test(body.toString("utf8")) ? "AGES OSAVFP object error" : "";
    }
    isDllInitError(status, body) {
        if (status !== 503) {
            return false;
        }
        try {
            const payload = JSON.parse(body.toString("utf8"));
            return payload.error === "dll_init_error";
        }
        catch (_a) {
            return /"error"\s*:\s*"dll_init_error"/i.test(body.toString("utf8"));
        }
    }
    restartAgesHost(reason) {
        return __awaiter(this, void 0, void 0, function* () {
            const now = Date.now();
            if (this.agesHostRestartRunning) {
                (0, logger_1.warn)(`ages restart skip | reason=${reason} | err=restart already running`);
                return false;
            }
            if (now < this.agesHostRestartCooldownUntil) {
                const remainingSeconds = Math.ceil((this.agesHostRestartCooldownUntil - now) / 1000);
                (0, logger_1.warn)(`ages restart skip | reason=${reason} | err=cooldown | left=${remainingSeconds}s`);
                this.pushTimingEvent(`IIS restart cooldown: ${reason}`, `${remainingSeconds}s`);
                return false;
            }
            if (!AGES_SSH_HOST || !AGES_SSH_USER) {
                (0, logger_1.warn)(`ages restart skip | reason=${reason} | err=missing AGES_SSH_HOST or AGES_SSH_USER`);
                return false;
            }
            this.agesHostRestartRunning = true;
            this.agesHostRestartCooldownUntil = now + AGES_IIS_RESTART_COOLDOWN_MS;
            this.lastAgesHostRestartStartedAt = new Date(now).toISOString();
            (0, logger_1.warn)(`ages restart start | host=${AGES_SSH_HOST} | user=${AGES_SSH_USER} | reason=${reason}`);
            this.pushTimingEvent(`IIS restart start: ${reason}`);
            void this.notifyAgesRestart(reason);
            try {
                yield execFileAsync("ssh", [
                    "-i",
                    AGES_SSH_KEY_PATH,
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "StrictHostKeyChecking=accept-new",
                    `${AGES_SSH_USER}@${AGES_SSH_HOST}`,
                    AGES_SSH_RESTART_COMMAND
                ]);
                (0, logger_1.log)(`ages restart ok | host=${AGES_SSH_HOST} | reason=${reason}`);
                this.pushTimingEvent(`IIS restart ok: ${reason}`);
                void this.warmUp(`host restart ${reason}`);
                return true;
            }
            catch (error) {
                (0, logger_1.warn)(`ages restart fail | host=${AGES_SSH_HOST} | reason=${reason} | err=${formatError(error)}`);
                this.pushTimingEvent(`IIS restart fail: ${reason}`, formatError(error));
                return false;
            }
            finally {
                this.lastAgesHostRestartFinishedAt = new Date().toISOString();
                this.agesHostRestartRunning = false;
            }
        });
    }
    notifyAgesRestart(reason) {
        return __awaiter(this, void 0, void 0, function* () {
            yield (0, logger_1.sendDebugMail)("CH09-BRK IIS restart", [
                `CH09-BRK detecto ${reason} y lanzo reinicio de IIS.`,
                `Host: ${AGES_SSH_HOST}`,
                `AGES: ${this.baseUrl}`,
                `Fecha: ${new Date().toISOString()}`
            ].join("\n"));
        });
    }
    resetPoolForWarmup(reason) {
        return __awaiter(this, void 0, void 0, function* () {
            (0, logger_1.warn)(`warmup reset | reason=${reason}`);
            this.initialWarmupFinished = false;
            this.prepareSlotsForWarmup(this.slots);
        });
    }
}
exports.AgesConnectionPool = AgesConnectionPool;
function getHostFromUrl(url) {
    try {
        return new URL(url).hostname;
    }
    catch (_a) {
        return "";
    }
}
function getProtocolFromUrl(url) {
    try {
        return new URL(url).protocol.replace(/:$/, "");
    }
    catch (_a) {
        return "";
    }
}
function formatError(error) {
    if (error instanceof Error) {
        const details = [
            error.name,
            error.message,
            getErrorCause(error),
            error.stack ? `stack=${error.stack.split("\n").slice(0, 3).join(" <- ")}` : ""
        ].filter(Boolean);
        return details.join(" | ");
    }
    return String(error);
}
function getErrorCause(error) {
    const withCause = error;
    if (!withCause.cause) {
        return "";
    }
    if (withCause.cause instanceof Error) {
        const causeWithCode = withCause.cause;
        return `cause=${causeWithCode.name}:${causeWithCode.message}${causeWithCode.code ? ` code=${causeWithCode.code}` : ""}`;
    }
    return `cause=${String(withCause.cause)}`;
}
function getBodySize(body) {
    if (!body) {
        return 0;
    }
    if (typeof body === "string") {
        return Buffer.byteLength(body);
    }
    if (Buffer.isBuffer(body)) {
        return body.length;
    }
    if (body instanceof URLSearchParams) {
        return Buffer.byteLength(body.toString());
    }
    return 0;
}
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
function readEnvFileValue(name) {
    try {
        const envText = (0, fs_1.readFileSync)("/app/.env", "utf8");
        const match = envText.match(new RegExp(`^${name}=(.*)$`, "m"));
        return match ? match[1].trim() : "";
    }
    catch (_a) {
        return "";
    }
}
function hasHeader(headers, headerName) {
    return Object.keys(headers).some((key) => key.toLowerCase() === headerName.toLowerCase());
}
function getEnvMaxSlotCount(envName, minimum) {
    const value = getEnvSlotCount(envName, minimum);
    if (value < minimum) {
        (0, logger_1.warn)(`Invalid ${envName}="${process.env[envName]}". Using minimum ${minimum}.`);
        return minimum;
    }
    return value;
}
function getEnvDurationMinutes(envName, fallback) {
    const rawValue = process.env[envName];
    if (!rawValue) {
        return fallback;
    }
    const value = Number.parseInt(rawValue, 10);
    if (!Number.isInteger(value) || value < 1) {
        (0, logger_1.warn)(`Invalid ${envName}="${rawValue}". Using fallback ${fallback}.`);
        return fallback;
    }
    return value;
}
function getEnvDurationSeconds(envName, fallback) {
    const rawValue = process.env[envName];
    if (!rawValue) {
        return fallback;
    }
    const value = Number.parseInt(rawValue, 10);
    if (!Number.isInteger(value) || value < 1) {
        (0, logger_1.warn)(`Invalid ${envName}="${rawValue}". Using fallback ${fallback}.`);
        return fallback;
    }
    return value;
}
function isConfigEnabled(name, fallback = false) {
    const rawValue = process.env[name];
    if (rawValue === undefined) {
        return fallback;
    }
    return ["1", "true", "yes", "on", "enabled"].includes(rawValue.trim().toLowerCase());
}
function shortError(error) {
    return error instanceof Error ? error.message : String(error);
}
exports.agesConnectionPool = new AgesConnectionPool();
