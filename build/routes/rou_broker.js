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
exports.BrokerRouter = void 0;
const express_1 = require("express");
const ages_pool_1 = require("../services/ages_pool");
exports.BrokerRouter = (0, express_1.Router)();
exports.BrokerRouter.get("/", (_req, res) => {
    res.send({ message: "Welcome to the broker: where messages learn to behave before crossing the border." });
});
exports.BrokerRouter.get("/health", (_req, res) => {
    res.json({
        status: "ok",
        service: "CH09-BRK"
    });
});
exports.BrokerRouter.get("/ages-pool", (_req, res) => {
    res.json(ages_pool_1.agesConnectionPool.getSummary());
});
exports.BrokerRouter.get("/pool", (_req, res) => {
    res.json(ages_pool_1.agesConnectionPool.getSummary());
});
exports.BrokerRouter.get("/ages-pool/show", (_req, res) => {
    res.type("html").send(renderPoolPage());
});
exports.BrokerRouter.get("/pool/show", (_req, res) => {
    res.type("html").send(renderPoolPage());
});
exports.BrokerRouter.post("/ages-pool/warmup", (_req, res) => __awaiter(void 0, void 0, void 0, function* () {
    res.json(yield ages_pool_1.agesConnectionPool.warmUp());
}));
exports.BrokerRouter.post("/ages-pool/slots/:slot/recycle", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    yield recyclePoolSlot(req, res);
}));
exports.BrokerRouter.post("/pool/slots/:slot/recycle", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    yield recyclePoolSlot(req, res);
}));
exports.BrokerRouter.all("/ages/~mini~/:agesFunction", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    yield proxyAgesRequest("mini", req, res);
}));
exports.BrokerRouter.all("/ages/:agesFunction", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    yield proxyAgesRequest("bigb", req, res);
}));
exports.BrokerRouter.all("/~mini~/:agesFunction", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    yield proxyAgesRequest("mini", req, res);
}));
exports.BrokerRouter.all("/:agesFunction", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    yield proxyAgesRequest("bigb", req, res);
}));
function recyclePoolSlot(req, res) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            res.json(yield ages_pool_1.agesConnectionPool.recycleSlotByReference(String(req.params.slot)));
        }
        catch (error) {
            res.status(400).json({
                status: "error",
                message: error instanceof Error ? error.message : String(error)
            });
        }
    });
}
function proxyAgesRequest(kind, req, res) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const sourceIp = getSourceIp(req);
            const result = yield ages_pool_1.agesConnectionPool.proxyCall(kind, String(req.params.agesFunction), getQueryString(req), {
                method: req.method,
                headers: getProxyHeaders(req),
                body: getProxyBody(req)
            }, sourceIp.value, sourceIp.source);
            setProxyResponseHeaders(res, result.headers);
            res
                .status(result.status)
                .setHeader("X-CH09-BRK-Pool-Slot", result.slotId.toString().padStart(2, "0"))
                .setHeader("X-CH09-BRK-Pool-Kind", result.slotKind)
                .send(result.body);
        }
        catch (error) {
            if (error instanceof Error && error.message === "AGES pool is still in warmup") {
                res.status(503).json({
                    status: "warmup",
                    message: "AGES pool slots are still in warmup",
                    pool: ages_pool_1.agesConnectionPool.getSummary()
                });
                return;
            }
            res.status(502).json({
                status: "error",
                message: error instanceof Error ? error.message : String(error)
            });
        }
    });
}
function getQueryString(req) {
    var _a;
    return (_a = req.originalUrl.split("?")[1]) !== null && _a !== void 0 ? _a : "";
}
function getSourceIp(req) {
    var _a, _b, _c, _d;
    const candidates = [
        { source: "xff", value: (_a = getFirstHeaderValue(req.headers["x-forwarded-for"])) === null || _a === void 0 ? void 0 : _a.split(",")[0] },
        { source: "xri", value: getFirstHeaderValue(req.headers["x-real-ip"]) },
        { source: "xci", value: getFirstHeaderValue(req.headers["x-client-ip"]) },
        { source: "xofi", value: (_b = getFirstHeaderValue(req.headers["x-original-forwarded-for"])) === null || _b === void 0 ? void 0 : _b.split(",")[0] },
        { source: "cf", value: getFirstHeaderValue(req.headers["cf-connecting-ip"]) },
        { source: "tci", value: getFirstHeaderValue(req.headers["true-client-ip"]) },
        { source: "envoy", value: getFirstHeaderValue(req.headers["x-envoy-external-address"]) },
        { source: "forwarded", value: getForwardedFor(req.headers.forwarded) },
        { source: "req", value: req.ip },
        { source: "socket", value: req.socket.remoteAddress }
    ];
    const sourceIp = (_c = candidates.find((candidate) => candidate.value && candidate.value.trim().length > 0)) !== null && _c !== void 0 ? _c : {
        source: "unknown",
        value: ""
    };
    return {
        source: sourceIp.source,
        value: normalizeIp((_d = sourceIp.value) !== null && _d !== void 0 ? _d : "")
    };
}
function getFirstHeaderValue(value) {
    if (Array.isArray(value)) {
        return value[0];
    }
    return value;
}
function getForwardedFor(value) {
    var _a;
    const forwarded = getFirstHeaderValue(value);
    if (!forwarded) {
        return undefined;
    }
    return (_a = forwarded.match(/for="?([^;,"]+)/i)) === null || _a === void 0 ? void 0 : _a[1];
}
function normalizeIp(value) {
    return value.trim().replace(/^::ffff:/, "");
}
function getProxyHeaders(req) {
    const headers = {};
    Object.entries(req.headers).forEach(([key, value]) => {
        if (value === undefined) {
            return;
        }
        headers[key] = Array.isArray(value) ? value.join(", ") : value;
    });
    return headers;
}
function getProxyBody(req) {
    if (["GET", "HEAD"].includes(req.method.toUpperCase()) || req.body === undefined) {
        return undefined;
    }
    if (Buffer.isBuffer(req.body) || typeof req.body === "string") {
        return req.body;
    }
    return JSON.stringify(req.body);
}
function setProxyResponseHeaders(res, headers) {
    const ignoredHeaders = new Set(["connection", "content-encoding", "content-length", "transfer-encoding"]);
    Object.entries(headers).forEach(([key, value]) => {
        if (!ignoredHeaders.has(key.toLowerCase())) {
            res.setHeader(key, value);
        }
    });
}
function renderPoolPage() {
    const pool = ages_pool_1.agesConnectionPool.getSummary();
    const json = escapeHtml(JSON.stringify(pool, null, 2));
    return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CH09-BRK Pool</title>
  <style>
    body { margin: 0; font-family: Consolas, Monaco, monospace; background: #111827; color: #e5e7eb; }
    main { padding: 24px; }
    h1 { margin: 0 0 12px; font-size: 20px; font-family: Arial, sans-serif; }
    .summary { margin-bottom: 16px; color: #93c5fd; font-family: Arial, sans-serif; }
    pre { margin: 0; padding: 16px; background: #020617; border: 1px solid #334155; border-radius: 6px; overflow: auto; line-height: 1.45; }
  </style>
</head>
<body>
  <main>
    <h1>CH09-BRK Pool</h1>
    <div class="summary">ready ${pool.ready}/${pool.size} | warming ${pool.warming} | error ${pool.error}</div>
    <pre>${json}</pre>
  </main>
</body>
</html>`;
}
function escapeHtml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}
