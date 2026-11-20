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
exports.readMs07RelayConfig = readMs07RelayConfig;
exports.relayMs07Beat = relayMs07Beat;
exports.startMs07Relay = startMs07Relay;
function readMs07RelayConfig(env) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    if (env.BROKER_MS07_RELAY_ENABLED !== "true")
        return;
    const url = new URL((_a = env.BROKER_MS07_RELAY_URL) !== null && _a !== void 0 ? _a : "");
    const key = (_b = env.BROKER_MS07_RELAY_KEY) !== null && _b !== void 0 ? _b : "";
    const mscode = (_d = (_c = env.MSCODE) === null || _c === void 0 ? void 0 : _c.trim()) !== null && _d !== void 0 ? _d : "";
    const instance = (_f = (_e = env.MSINSTANCE) === null || _e === void 0 ? void 0 : _e.trim()) !== null && _f !== void 0 ? _f : "";
    const interval = Number((_g = env.MSMONINTERVAL) !== null && _g !== void 0 ? _g : "600") * 1000;
    const timeout = Number((_h = env.BROKER_MS07_RELAY_TIMEOUT_MS) !== null && _h !== void 0 ? _h : "5000");
    const identity = /^[\w.-]{1,30}$/;
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
        !/^[A-Za-z0-9_-]{43,128}$/.test(key) || !identity.test(mscode) || !identity.test(instance) ||
        !Number.isInteger(interval) || interval < 10000 || interval > 86400000 ||
        !Number.isInteger(timeout) || timeout < 100 || timeout * 2 >= interval) {
        throw new Error("Invalid MS07 heartbeat relay configuration");
    }
    return { url: url.href, key, mscode, instance, interval, timeout };
}
function version(value) {
    if (typeof value !== "string" && typeof value !== "number")
        return;
    const v = String(value).trim();
    if (/^[\w.+-]{1,80}$/.test(v))
        return v;
}
function probeAges(base, key, timeout) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d, _e, _f, _g;
        const url = new URL(base);
        if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) {
            throw new Error("Invalid AGES probe origin");
        }
        url.pathname = url.pathname.replace(/\/+$/, "") + "/~mini~/beat.ages";
        const response = yield fetch(url, {
            headers: Object.assign({ Accept: "application/json" }, (key ? { "X-AGES-API-Key": key } : {})),
            redirect: "error", signal: AbortSignal.timeout(timeout)
        });
        if (!response.ok || !response.body) {
            yield ((_a = response.body) === null || _a === void 0 ? void 0 : _a.cancel());
            return { status: "down" };
        }
        const reader = response.body.getReader();
        const chunks = [];
        let bytes = 0;
        for (;;) {
            const { done, value } = yield reader.read();
            if (done)
                break;
            bytes += value.byteLength;
            if (bytes > 65536) {
                yield reader.cancel();
                return { status: "down" };
            }
            chunks.push(Buffer.from(value));
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const miniVersion = version((_d = (_c = (_b = payload === null || payload === void 0 ? void 0 : payload.build) === null || _b === void 0 ? void 0 : _b.mini) === null || _c === void 0 ? void 0 : _c.version) !== null && _d !== void 0 ? _d : payload === null || payload === void 0 ? void 0 : payload.Version_AGES_MINI);
        const bigBoyVersion = version((_g = (_f = (_e = payload === null || payload === void 0 ? void 0 : payload.build) === null || _e === void 0 ? void 0 : _e.bigBoy) === null || _f === void 0 ? void 0 : _f.version) !== null && _g !== void 0 ? _g : payload === null || payload === void 0 ? void 0 : payload.Version_AGES);
        if (!miniVersion && !bigBoyVersion)
            return { status: "down" };
        return { status: "OK", miniVersion, bigBoyVersion };
    });
}
function relayMs07Beat(config_1, origins_1, agesKey_1) {
    return __awaiter(this, arguments, void 0, function* (config, origins, agesKey, send = fetch) {
        var _a, _b;
        const results = yield Promise.all(origins.map(base => probeAges(base, agesKey, config.timeout)
            .catch(() => ({ status: "down" }))));
        const ages = (_a = results.find(result => result.status === "OK")) !== null && _a !== void 0 ? _a : { status: "down" };
        const response = yield send(config.url, {
            method: "POST", redirect: "error", signal: AbortSignal.timeout(config.timeout),
            headers: { Authorization: "Bearer " + config.key, "Content-Type": "application/json" },
            body: JSON.stringify({ broker: { mscode: config.mscode, instance: config.instance, status: "OK" }, ages })
        });
        yield ((_b = response.body) === null || _b === void 0 ? void 0 : _b.cancel());
        if (response.status !== 204)
            throw new Error("MS07 rejected the heartbeat relay");
    });
}
function startMs07Relay(config, origins, agesKey, warn) {
    const controller = new AbortController();
    let timer;
    const run = () => __awaiter(this, void 0, void 0, function* () {
        const started = Date.now();
        try {
            yield relayMs07Beat(config, origins, agesKey);
        }
        catch (_a) {
            warn("MS07 heartbeat relay delivery failed");
        }
        finally {
            if (!controller.signal.aborted)
                timer = setTimeout(run, Math.max(0, config.interval - (Date.now() - started))).unref();
        }
    });
    void run();
    return () => { controller.abort(); clearTimeout(timer); };
}
