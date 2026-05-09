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
const logger_1 = require("../utils/logger");
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
exports.BrokerRouter.get("/ages-pool/show", (req, res) => {
    res.type("html").send(renderPoolPage(req));
});
exports.BrokerRouter.get("/pool/show", (req, res) => {
    res.type("html").send(renderPoolPage(req));
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
exports.BrokerRouter.post("/ages-host/restart-iis", (_req, res) => __awaiter(void 0, void 0, void 0, function* () {
    yield restartIis(res);
}));
exports.BrokerRouter.post("/iis/restart", (_req, res) => __awaiter(void 0, void 0, void 0, function* () {
    yield restartIis(res);
}));
exports.BrokerRouter.get("/ages-host/restart-iis", (_req, res) => __awaiter(void 0, void 0, void 0, function* () {
    yield restartIis(res);
}));
exports.BrokerRouter.get("/iis/restart", (_req, res) => __awaiter(void 0, void 0, void 0, function* () {
    yield restartIis(res);
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
function restartIis(res) {
    return __awaiter(this, void 0, void 0, function* () {
        const result = yield ages_pool_1.agesConnectionPool.restartAgesHostManually();
        res.status(result.status === "ok" ? 200 : 500).json(result);
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
            const sourceIp = getSourceIp(req);
            (0, logger_1.warn)([
                `proxy route err`,
                `kind=${kind}`,
                `ip=${sourceIp.value || "unknown"}`,
                `ips=${sourceIp.source || "unknown"}`,
                `m=${req.method}`,
                `u=${req.originalUrl}`,
                `h=${Object.keys(req.headers).sort().join(",") || "none"}`,
                `b=${getRequestBodySize(req)}`,
                `err=${formatRouteError(error)}`
            ].join(" | "));
            if (error instanceof Error && /^AGES (mini|bigb) pool is still in warmup$/.test(error.message)) {
                res.status(503).json({
                    status: "warmup",
                    message: error.message.replace("bigb", "BigBoy"),
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
function getRequestBodySize(req) {
    if (Buffer.isBuffer(req.body)) {
        return req.body.length;
    }
    if (typeof req.body === "string") {
        return Buffer.byteLength(req.body);
    }
    if (req.body === undefined) {
        return 0;
    }
    return Buffer.byteLength(JSON.stringify(req.body));
}
function formatRouteError(error) {
    if (error instanceof Error) {
        return `${error.name}:${error.message}`;
    }
    return String(error);
}
function setProxyResponseHeaders(res, headers) {
    const ignoredHeaders = new Set(["connection", "content-encoding", "content-length", "transfer-encoding"]);
    Object.entries(headers).forEach(([key, value]) => {
        if (!ignoredHeaders.has(key.toLowerCase())) {
            res.setHeader(key, value);
        }
    });
}
function renderPoolPage(req) {
    const pool = ages_pool_1.agesConnectionPool.getSummary();
    const json = escapeHtml(JSON.stringify(pool, null, 2));
    const basePath = req.baseUrl || "";
    const restartPath = `${basePath}/iis/restart`;
    const warmupPath = `${basePath}/ages-pool/warmup`;
    const cards = pool.slots.map((slot) => renderSlotCard(basePath, slot)).join("");
    return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CH09-BRK Pool</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, sans-serif; background: #0f172a; color: #e5e7eb; }
    main { padding: 24px; max-width: 1280px; margin: 0 auto; }
    header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 20px; }
    h1 { margin: 0 0 6px; font-size: 24px; line-height: 1.1; }
    .base { color: #94a3b8; font-size: 13px; overflow-wrap: anywhere; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    button { border: 1px solid #475569; background: #1e293b; color: #f8fafc; border-radius: 6px; padding: 9px 12px; font-size: 13px; cursor: pointer; }
    button:hover { background: #334155; }
    .danger { border-color: #b91c1c; background: #7f1d1d; }
    .danger:hover { background: #991b1b; }
    .summary { display: grid; grid-template-columns: repeat(4, minmax(120px, 1fr)); gap: 10px; margin-bottom: 18px; }
    .metric { border: 1px solid #334155; background: #111827; border-radius: 8px; padding: 12px; }
    .metric b { display: block; font-size: 24px; margin-bottom: 3px; }
    .metric span { color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-bottom: 18px; }
    .slot { border: 1px solid #334155; background: #111827; border-radius: 8px; padding: 14px; min-width: 0; }
    .slot-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
    .slot-id { font: 700 18px Consolas, Monaco, monospace; }
    .badge { border-radius: 999px; padding: 4px 8px; font-size: 12px; text-transform: uppercase; }
    .ready { background: #064e3b; color: #bbf7d0; }
    .warming { background: #713f12; color: #fde68a; }
    .error { background: #7f1d1d; color: #fecaca; }
    .idle { background: #334155; color: #cbd5e1; }
    dl { margin: 0; display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 6px 10px; font-size: 13px; }
    dt { color: #94a3b8; }
    dd { margin: 0; min-width: 0; overflow-wrap: anywhere; font-family: Consolas, Monaco, monospace; }
    .slot form { margin-top: 12px; }
    .slot button { width: 100%; }
    details { border: 1px solid #334155; background: #111827; border-radius: 8px; padding: 12px; }
    summary { cursor: pointer; color: #93c5fd; }
    pre { margin: 12px 0 0; padding: 14px; background: #020617; border: 1px solid #334155; border-radius: 6px; overflow: auto; line-height: 1.45; font: 12px Consolas, Monaco, monospace; }
    @media (max-width: 720px) {
      main { padding: 16px; }
      header { display: block; }
      .actions { justify-content: stretch; margin-top: 14px; }
      .actions form, .actions button { width: 100%; }
      .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>CH09-BRK Pool</h1>
        <div class="base">${escapeHtml(pool.baseUrl)}</div>
      </div>
      <div class="actions">
        <form method="post" action="${escapeHtml(warmupPath)}"><button type="submit">Warmup</button></form>
        <form method="post" action="${escapeHtml(restartPath)}"><button class="danger" type="submit">Restart IIS</button></form>
      </div>
    </header>
    <section class="summary">
      <div class="metric"><b>${pool.ready}</b><span>Ready</span></div>
      <div class="metric"><b>${pool.warming}</b><span>Warming</span></div>
      <div class="metric"><b>${pool.error}</b><span>Error</span></div>
      <div class="metric"><b>${pool.size}</b><span>Total</span></div>
    </section>
    <section class="grid">${cards}</section>
    <details>
      <summary>JSON completo</summary>
      <pre>${json}</pre>
    </details>
  </main>
</body>
</html>`;
}
function renderSlotCard(basePath, slot) {
    var _a;
    const slotName = `S${slot.id.toString().padStart(2, "0")}${slot.kind === "mini" ? "M" : "B"}`;
    const recyclePath = `${basePath}/pool/slots/${slotName}/recycle`;
    return `<article class="slot">
    <div class="slot-head">
      <div class="slot-id">${slotName}</div>
      <span class="badge ${escapeHtml(slot.status)}">${escapeHtml(slot.status)}</span>
    </div>
    <dl>
      <dt>Kind</dt><dd>${slot.kind === "mini" ? "Mini" : "BigBoy"}</dd>
      <dt>Status</dt><dd>${(_a = slot.lastStatusCode) !== null && _a !== void 0 ? _a : "-"}</dd>
      <dt>Token</dt><dd>${escapeHtml(slot.agesToken || "-")}</dd>
      <dt>Cookie</dt><dd>${escapeHtml(slot.aspNetSessionId || "-")}</dd>
      <dt>Endpoint</dt><dd>${escapeHtml(slot.lastEndpoint || "-")}</dd>
      <dt>Uso</dt><dd>${escapeHtml(slot.lastUsedAt || "-")}</dd>
      <dt>Error</dt><dd>${escapeHtml(slot.lastError || "-")}</dd>
      <dt>Resp</dt><dd>${escapeHtml(slot.lastResponsePreview || slot.warmupResponse || "-")}</dd>
    </dl>
    <form method="post" action="${escapeHtml(recyclePath)}">
      <button type="submit">Reciclar slot</button>
    </form>
  </article>`;
}
function escapeHtml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}
