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
exports.BrokerRouter.get("/pool", (_req, res) => {
    res.json(ages_pool_1.agesConnectionPool.getSummary());
});
exports.BrokerRouter.get("/pool/timings", (_req, res) => {
    res.json(ages_pool_1.agesConnectionPool.getTimingLog());
});
exports.BrokerRouter.post("/pool/timings/clear", (_req, res) => {
    res.json(ages_pool_1.agesConnectionPool.clearTimingLog());
});
exports.BrokerRouter.get("/pool/timings/show", (req, res) => {
    res.type("html").send(renderTimingPage(req));
});
exports.BrokerRouter.get("/pool/show", (req, res) => {
    res.type("html").send(renderPoolPage(req));
});
exports.BrokerRouter.post("/pool/warmup", (_req, res) => __awaiter(void 0, void 0, void 0, function* () {
    res.json(yield ages_pool_1.agesConnectionPool.warmUp());
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
exports.BrokerRouter.all("/ages/~mini~/*", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    yield proxyAgesRequest("mini", req, res, translateRestPathToAgesFunction(getWildcardPath(req)));
}));
exports.BrokerRouter.all("/ages/:agesFunction", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    yield proxyAgesRequest("bigb", req, res);
}));
exports.BrokerRouter.all("/ages/*", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    yield proxyAgesRequest("bigb", req, res, translateRestPathToAgesFunction(getWildcardPath(req)));
}));
exports.BrokerRouter.all("/~mini~/:agesFunction", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    yield proxyAgesRequest("mini", req, res);
}));
exports.BrokerRouter.all("/~mini~/*", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    yield proxyAgesRequest("mini", req, res, translateRestPathToAgesFunction(getWildcardPath(req)));
}));
exports.BrokerRouter.all("/:agesFunction", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    yield proxyAgesRequest("bigb", req, res);
}));
exports.BrokerRouter.all("/*", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    yield proxyAgesRequest("bigb", req, res, translateRestPathToAgesFunction(getWildcardPath(req)));
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
function proxyAgesRequest(kind, req, res, agesFunction) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const sourceIp = getSourceIp(req);
            const result = yield ages_pool_1.agesConnectionPool.proxyCall(kind, agesFunction !== null && agesFunction !== void 0 ? agesFunction : String(req.params.agesFunction), getQueryString(req), {
                method: req.method,
                headers: getProxyHeaders(req),
                body: getProxyBody(req)
            }, sourceIp.value, sourceIp.source);
            setProxyResponseHeaders(res, result.headers);
            const trace = ages_pool_1.agesConnectionPool.completeTraceResponse(result.traceId, result.status, result.body.length);
            setTraceHeaders(res, result.traceHeaders, trace);
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
                res
                    .setHeader("Retry-After", "60")
                    .status(503)
                    .json({
                    status: "warmup",
                    message: error.message.replace("bigb", "BigBoy")
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
function translateRestPathToAgesFunction(path) {
    var _a;
    const segments = path
        .split("/")
        .map((segment) => segment.trim())
        .filter(Boolean);
    if (segments.length <= 1) {
        return (_a = segments[0]) !== null && _a !== void 0 ? _a : path;
    }
    const modules = segments.slice(0, -1).map(normalizeAgesModuleSegment);
    const functionName = segments[segments.length - 1].replace(/\.ages$/i, "");
    return [...modules, functionName].join(".");
}
function getWildcardPath(req) {
    var _a, _b;
    const params = req.params;
    const value = (_b = (_a = params[0]) !== null && _a !== void 0 ? _a : params["0"]) !== null && _b !== void 0 ? _b : params[""];
    return Array.isArray(value) ? value.join("/") : String(value !== null && value !== void 0 ? value : "");
}
function normalizeAgesModuleSegment(segment) {
    return segment.toLowerCase().startsWith("o") ? segment : `o${segment}`;
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
function setTraceHeaders(res, headers, trace) {
    var _a, _b;
    Object.entries(headers).forEach(([key, value]) => {
        res.setHeader(key, value);
    });
    if (trace) {
        res
            .setHeader("X-CH09-BRK-Broker-Out", (_a = trace.brokerOutAt) !== null && _a !== void 0 ? _a : "")
            .setHeader("X-CH09-BRK-Total-Ms", String((_b = trace.totalMs) !== null && _b !== void 0 ? _b : 0));
    }
}
function renderTimingPage(req) {
    const rows = ages_pool_1.agesConnectionPool.getTimingLog();
    const visibleRows = rows.filter((row) => !isInternalBeatTiming(row));
    const body = visibleRows.map(renderTimingRow).join("");
    const json = escapeHtml(JSON.stringify(visibleRows, null, 2));
    const timingsPath = `${req.baseUrl || ""}/pool/timings`;
    const clearTimingsPath = `${req.baseUrl || ""}/pool/timings/clear`;
    const poolShowPath = `${req.baseUrl || ""}/pool/show`;
    return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CH09-BRK Timings</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, sans-serif; background: #0f172a; color: #e5e7eb; }
    main { padding: 24px; max-width: 1500px; margin: 0 auto; }
    header { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; }
    h1 { margin: 0; font-size: 24px; }
    button, .nav-button { border: 1px solid #475569; background: #1e293b; color: #f8fafc; border-radius: 6px; padding: 8px 12px; cursor: pointer; text-decoration: none; display: inline-block; font-size: 13px; }
    button:hover, .nav-button:hover { background: #334155; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .switch { display: inline-flex; align-items: center; gap: 7px; border: 1px solid #334155; border-radius: 6px; padding: 7px 10px; color: #bfdbfe; font-size: 13px; user-select: none; }
    .switch input { width: 16px; height: 16px; accent-color: #0f766e; }
    .table-wrap { overflow: auto; border: 1px solid #334155; border-radius: 8px; background: #111827; }
    table { width: 100%; border-collapse: collapse; min-width: 980px; }
    th, td { padding: 9px 10px; border-bottom: 1px solid #1f2937; text-align: left; font-size: 13px; white-space: nowrap; }
    th { color: #93c5fd; background: #0f172a; position: sticky; top: 0; }
    td.url { max-width: 280px; overflow: hidden; text-overflow: ellipsis; }
    .mono { font-family: Consolas, Monaco, monospace; }
    .ok { color: #bbf7d0; }
    .warn { color: #fde68a; }
    .bad { color: #fecaca; }
    details { margin-top: 16px; border: 1px solid #334155; border-radius: 8px; padding: 12px; background: #111827; }
    summary { cursor: pointer; color: #93c5fd; }
    .copy-status { color: #94a3b8; font-size: 13px; min-width: 88px; align-self: center; }
    pre { overflow: auto; font: 12px Consolas, Monaco, monospace; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>CH09-BRK Timings</h1>
      <div class="actions">
        <a class="nav-button" href="${escapeHtml(poolShowPath)}">Pool</a>
        <label class="switch"><input id="hideInternalBeat" type="checkbox" checked>Ocultar beat interno</label>
        <button id="copyJson" type="button">Copiar JSON</button>
        <button id="clearTimings" type="button">Limpiar</button>
        <button onclick="location.reload()">Actualizar</button>
        <span id="copyStatus" class="copy-status"></span>
      </div>
    </header>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Trace</th>
            <th>Slot</th>
            <th>Tipo</th>
            <th>HTTP</th>
            <th>Método</th>
            <th>URL</th>
            <th>IP</th>
            <th>Broker in</th>
            <th>Slot +ms</th>
            <th>AGES ini +ms</th>
            <th>AGES fin +ms</th>
            <th>Out +ms</th>
            <th>Wait</th>
            <th>AGES</th>
            <th>Total</th>
            <th>Bytes</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>${body || '<tr><td colspan="17">Sin llamadas registradas.</td></tr>'}</tbody>
      </table>
    </div>
    <details>
      <summary>JSON completo</summary>
      <pre>${json}</pre>
    </details>
  </main>
  <script>
    const timingsPath = ${JSON.stringify(timingsPath)};
    const clearTimingsPath = ${JSON.stringify(clearTimingsPath)};
    const tbody = document.querySelector("tbody");
    const jsonBlock = document.querySelector("pre");
    const clearTimings = document.getElementById("clearTimings");
    const copyJson = document.getElementById("copyJson");
    const copyStatus = document.getElementById("copyStatus");
    const hideInternalBeat = document.getElementById("hideInternalBeat");
    let timingRows = [];
    const dateFormatter = new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });

    function escapeHtml(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    function localTime(value) {
      if (!value) return "-";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : dateFormatter.format(date);
    }

    function ms(value) {
      return value === undefined ? "-" : value + " ms";
    }

    function offsetMs(base, value) {
      if (!base || !value) return "-";
      const baseMs = Date.parse(base);
      const valueMs = Date.parse(value);
      return Number.isNaN(baseMs) || Number.isNaN(valueMs) ? "-" : "+" + (valueMs - baseMs) + " ms";
    }

    function localizeJson(value) {
      return JSON.stringify(value, (key, item) => {
        if (typeof item === "string" && /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}/.test(item)) {
          return localTime(item);
        }
        return item;
      }, 2);
    }

    function isInternalBeatTiming(row) {
      return String(row && row.url ? row.url : "").toLowerCase().startsWith("/ages/~mini~/beat.ages");
    }

    function getVisibleRows() {
      return hideInternalBeat.checked ? timingRows.filter((row) => !isInternalBeatTiming(row)) : timingRows;
    }

    function renderRow(row) {
      const isEvent = row.entryType === "event";
      const statusClass = isEvent ? "warn" : !row.status ? "warn" : row.status >= 500 ? "bad" : row.status >= 400 ? "warn" : "ok";
      return '<tr>' +
        '<td class="mono">' + escapeHtml(row.id) + '</td>' +
        '<td class="mono">' + escapeHtml(row.slot || "-") + (row.slotDynamic ? "*" : "") + '</td>' +
        '<td>' + (isEvent ? "Evento" : row.kind === "mini" ? "Mini" : "BigBoy") + '</td>' +
        '<td class="' + statusClass + '">' + escapeHtml(isEvent ? "CUT" : row.status ?? "-") + '</td>' +
        '<td>' + escapeHtml(row.method || "-") + '</td>' +
        '<td class="url">' + escapeHtml(row.url || "-") + '</td>' +
        '<td>' + escapeHtml(row.sourceIp || "-") + ' <span class="mono">' + escapeHtml(row.sourceIpSource || "") + '</span></td>' +
        '<td class="mono">' + escapeHtml(localTime(row.brokerInAt)) + '</td>' +
        '<td class="mono">' + offsetMs(row.brokerInAt, row.slotAcquiredAt) + '</td>' +
        '<td class="mono">' + offsetMs(row.brokerInAt, row.agesStartAt) + '</td>' +
        '<td class="mono">' + offsetMs(row.brokerInAt, row.agesEndAt) + '</td>' +
        '<td class="mono">' + offsetMs(row.brokerInAt, row.brokerOutAt) + '</td>' +
        '<td class="mono">' + ms(row.waitMs) + '</td>' +
        '<td class="mono">' + ms(row.agesMs) + '</td>' +
        '<td class="mono">' + ms(row.totalMs) + '</td>' +
        '<td>' + escapeHtml(row.bytes ?? "-") + '</td>' +
        '<td>' + escapeHtml(row.error || "") + '</td>' +
      '</tr>';
    }

    async function refreshTimings() {
      const response = await fetch(timingsPath, { headers: { Accept: "application/json" } });
      if (!response.ok) return;
      timingRows = await response.json();
      renderTimings();
    }

    function renderTimings() {
      const rows = getVisibleRows();
      tbody.innerHTML = rows.length ? rows.map(renderRow).join("") : '<tr><td colspan="17">Sin llamadas registradas.</td></tr>';
      jsonBlock.textContent = localizeJson(rows);
    }

    async function copyText(value) {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return;
      }

      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }

    function showCopyStatus(text) {
      copyStatus.textContent = text;
      window.setTimeout(() => {
        if (copyStatus.textContent === text) copyStatus.textContent = "";
      }, 1800);
    }

    refreshTimings();
    setInterval(refreshTimings, 5000);
    hideInternalBeat.addEventListener("change", renderTimings);
    copyJson.addEventListener("click", async () => {
      copyJson.disabled = true;
      try {
        await copyText(jsonBlock.textContent || "");
        showCopyStatus("Copiado");
      } catch (error) {
        showCopyStatus("Error");
      } finally {
        copyJson.disabled = false;
      }
    });
    clearTimings.addEventListener("click", async () => {
      clearTimings.disabled = true;
      try {
        await fetch(clearTimingsPath, { method: "POST", headers: { Accept: "application/json" } });
        await refreshTimings();
      } finally {
        clearTimings.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}
function renderTimingRow(row) {
    var _a, _b, _c, _d, _e, _f;
    const isEvent = row.entryType === "event";
    const statusClass = isEvent ? "warn" : !row.status ? "warn" : row.status >= 500 ? "bad" : row.status >= 400 ? "warn" : "ok";
    return `<tr>
    <td class="mono">${escapeHtml(row.id)}</td>
    <td class="mono">${escapeHtml((_a = row.slot) !== null && _a !== void 0 ? _a : "-")}${row.slotDynamic ? "*" : ""}</td>
    <td>${isEvent ? "Evento" : row.kind === "mini" ? "Mini" : "BigBoy"}</td>
    <td class="${statusClass}">${isEvent ? "CUT" : (_b = row.status) !== null && _b !== void 0 ? _b : "-"}</td>
    <td>${escapeHtml((_c = row.method) !== null && _c !== void 0 ? _c : "-")}</td>
    <td class="url">${escapeHtml((_d = row.url) !== null && _d !== void 0 ? _d : "-")}</td>
    <td>${escapeHtml(row.sourceIp || "-")} <span class="mono">${escapeHtml(row.sourceIpSource || "")}</span></td>
    <td class="mono">${escapeHtml(row.brokerInAt)}</td>
    <td class="mono">${formatOffsetMs(row.brokerInAt, row.slotAcquiredAt)}</td>
    <td class="mono">${formatOffsetMs(row.brokerInAt, row.agesStartAt)}</td>
    <td class="mono">${formatOffsetMs(row.brokerInAt, row.agesEndAt)}</td>
    <td class="mono">${formatOffsetMs(row.brokerInAt, row.brokerOutAt)}</td>
    <td class="mono">${formatTimingMs(row.waitMs)}</td>
    <td class="mono">${formatTimingMs(row.agesMs)}</td>
    <td class="mono">${formatTimingMs(row.totalMs)}</td>
    <td>${(_e = row.bytes) !== null && _e !== void 0 ? _e : "-"}</td>
    <td>${escapeHtml((_f = row.error) !== null && _f !== void 0 ? _f : "")}</td>
  </tr>`;
}
function isInternalBeatTiming(row) {
    var _a;
    return ((_a = row.url) !== null && _a !== void 0 ? _a : "").toLowerCase().startsWith("/ages/~mini~/beat.ages");
}
function formatTimingMs(value) {
    return value === undefined ? "-" : `${value} ms`;
}
function formatOffsetMs(base, value) {
    if (!base || !value) {
        return "-";
    }
    const baseMs = Date.parse(base);
    const valueMs = Date.parse(value);
    if (Number.isNaN(baseMs) || Number.isNaN(valueMs)) {
        return "-";
    }
    return `+${valueMs - baseMs} ms`;
}
function renderPoolPage(req) {
    const pool = ages_pool_1.agesConnectionPool.getSummary();
    const json = escapeHtml(JSON.stringify(pool, null, 2));
    const basePath = req.baseUrl || "";
    const poolPath = `${basePath}/pool`;
    const restartPath = `${basePath}/iis/restart`;
    const warmupPath = `${basePath}/pool/warmup`;
    const timingsShowPath = `${basePath}/pool/timings/show`;
    const clearTimingsPath = `${basePath}/pool/timings/clear`;
    const cards = pool.slots.map((slot) => renderSlotCard(basePath, slot)).join("");
    const queueCards = renderQueueConfig(pool);
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
    button, .nav-button { border: 1px solid #475569; background: #1e293b; color: #f8fafc; border-radius: 6px; padding: 9px 12px; font-size: 13px; cursor: pointer; text-decoration: none; display: inline-block; }
    button:hover, .nav-button:hover { background: #334155; }
    .danger { border-color: #b91c1c; background: #7f1d1d; }
    .danger:hover { background: #991b1b; }
    .summary { display: grid; grid-template-columns: repeat(5, minmax(120px, 1fr)); gap: 10px; margin-bottom: 12px; }
    .queues { display: grid; grid-template-columns: repeat(2, minmax(260px, 1fr)); gap: 10px; margin-bottom: 18px; }
    .queue { border: 1px solid #334155; background: #111827; border-radius: 8px; padding: 8px 10px; display: flex; align-items: center; gap: 10px; min-width: 0; }
    .queue h2 { margin: 0; font-size: 15px; min-width: 64px; }
    .queue-grid { display: flex; flex-wrap: wrap; gap: 6px 10px; min-width: 0; }
    .queue-item { display: inline-flex; gap: 4px; align-items: baseline; min-width: 0; }
    .queue-item b { display: inline; font-size: 16px; }
    .queue-item span { color: #94a3b8; font-size: 10px; text-transform: uppercase; }
    .metric { border: 1px solid #334155; background: #111827; border-radius: 8px; padding: 12px; }
    .metric b { display: block; font-size: 24px; margin-bottom: 3px; }
    .metric.restart b { font-size: 13px; line-height: 1.35; }
    .metric span { color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-bottom: 18px; }
    .slot { border: 1px solid #334155; background: #111827; border-radius: 8px; padding: 14px; min-width: 0; display: flex; flex-direction: column; min-height: 390px; }
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
    .resp-line { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: start; }
    .copy-small { width: auto; padding: 4px 7px; font-size: 11px; border-radius: 5px; }
    .slot form { margin-top: auto; padding-top: 12px; }
    .slot button { width: 100%; }
    .statusline { color: #94a3b8; font-size: 13px; margin-top: 10px; min-height: 18px; text-align: right; }
    details { border: 1px solid #334155; background: #111827; border-radius: 8px; padding: 12px; }
    summary { cursor: pointer; color: #93c5fd; }
    pre { margin: 12px 0 0; padding: 14px; background: #020617; border: 1px solid #334155; border-radius: 6px; overflow: auto; line-height: 1.45; font: 12px Consolas, Monaco, monospace; }
    @media (max-width: 720px) {
      main { padding: 16px; }
      header { display: block; }
      .actions { justify-content: stretch; margin-top: 14px; }
      .actions form, .actions button, .actions .nav-button { width: 100%; text-align: center; }
      .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .queues { grid-template-columns: 1fr; }
      .queue { align-items: flex-start; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>CH09-BRK Pool</h1>
        <div id="base" class="base">${escapeHtml(pool.baseUrl)}</div>
      </div>
      <div class="actions">
        <a class="nav-button" href="${escapeHtml(timingsShowPath)}">Timings</a>
        <button id="copyJson" type="button">Copiar JSON</button>
        <form data-pool-action method="post" action="${escapeHtml(clearTimingsPath)}"><button type="submit">Limpiar métricas</button></form>
        <form data-pool-action method="post" action="${escapeHtml(warmupPath)}"><button type="submit">Warmup</button></form>
        <form data-pool-action method="post" action="${escapeHtml(restartPath)}"><button class="danger" type="submit">Restart IIS</button></form>
      </div>
    </header>
    <section class="summary" id="summary">
      ${renderSummaryMetrics(pool)}
    </section>
    <section class="queues" id="queues">${queueCards}</section>
    <section class="grid" id="slots">${cards}</section>
    <div class="statusline" id="statusline">Actualizado al abrir</div>
    <details>
      <summary>JSON completo</summary>
      <pre id="json">${json}</pre>
    </details>
  </main>
  <script>
    const poolPath = ${JSON.stringify(poolPath)};
    const refreshMs = 5000;
    const statusLine = document.getElementById("statusline");
    const summary = document.getElementById("summary");
    const queues = document.getElementById("queues");
    const slots = document.getElementById("slots");
    const json = document.getElementById("json");
    const copyJson = document.getElementById("copyJson");
    const base = document.getElementById("base");
    let currentPool = null;
    const dateFormatter = new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });

    function escapeHtml(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    function slotName(slot) {
      return "S" + String(slot.id).padStart(2, "0") + (slot.kind === "mini" ? "M" : "B");
    }

    function statusText() {
      return new Date().toLocaleTimeString("es-AR", { hour12: false });
    }

    function localTime(value) {
      if (!value) return "-";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : dateFormatter.format(date);
    }

    function localizeJson(value) {
      return JSON.stringify(value, (key, item) => {
        if (typeof item === "string" && /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}/.test(item)) {
          return localTime(item);
        }
        return item;
      }, 2);
    }

    function renderSummary(pool) {
      return [
        '<div class="metric"><b>' + pool.ready + '</b><span>Ready</span></div>',
        '<div class="metric"><b>' + pool.warming + '</b><span>Warming</span></div>',
        '<div class="metric"><b>' + pool.error + '</b><span>Error</span></div>',
        '<div class="metric"><b>' + pool.size + '</b><span>Total</span></div>',
        '<div class="metric restart"><b>' + escapeHtml(localTime(pool.iisRestart.lastStartedAt)) + '</b><span>Último IIS</span></div>'
      ].join("");
    }

    function renderQueueItem(value, label) {
      return '<div class="queue-item"><b>' + escapeHtml(value) + '</b><span>' + escapeHtml(label) + '</span></div>';
    }

    function renderQueue(kind, title) {
      return '<article class="queue"><h2>' + title + '</h2><div class="queue-grid">' +
        renderQueueItem(kind.base, "Base") +
        renderQueueItem(kind.current, "Actual") +
        renderQueueItem(kind.max, "Max") +
        renderQueueItem(kind.dynamic, "Adapt") +
        renderQueueItem(kind.ready, "Ready") +
        renderQueueItem(kind.inUse, "En uso") +
        renderQueueItem(kind.waiting, "Espera") +
        renderQueueItem(kind.holdMinutes + "m", "Retiene") +
      '</div></article>';
    }

    function renderQueues(pool) {
      return renderQueue(pool.config.mini, "Mini") + renderQueue(pool.config.bigb, "BigBoy");
    }

    function renderSlot(slot) {
      const name = slotName(slot);
      const recyclePath = ${JSON.stringify(basePath)} + "/pool/slots/" + name + "/recycle";
      const responsePreview = slot.lastResponsePreview || slot.warmupResponse || "-";
      const canCopyResponse = Boolean(slot.lastResponseBody || slot.warmupResponse);
      return '<article class="slot">' +
        '<div class="slot-head"><div class="slot-id">' + name + '</div><span class="badge ' + escapeHtml(slot.status) + '">' + escapeHtml(slot.status) + '</span></div>' +
        '<dl>' +
          '<dt>Kind</dt><dd>' + (slot.kind === "mini" ? "Mini" : "BigBoy") + '</dd>' +
          '<dt>Modo</dt><dd>' + (slot.dynamic ? "Adaptativo" : "Base") + '</dd>' +
          '<dt>Uso</dt><dd>' + (slot.inUse ? "En uso" : "Libre") + '</dd>' +
          '<dt>Retiene</dt><dd>' + escapeHtml(localTime(slot.holdUntil)) + '</dd>' +
          '<dt>Status</dt><dd>' + escapeHtml(slot.lastStatusCode ?? "-") + '</dd>' +
          '<dt>Token</dt><dd>' + (slot.agesToken ? "Presente (oculto)" : "-") + '</dd>' +
          '<dt>Cookie</dt><dd>' + (slot.aspNetSessionId ? "Presente (oculta)" : "-") + '</dd>' +
          '<dt>Endpoint</dt><dd>' + escapeHtml(slot.lastEndpoint || "-") + '</dd>' +
          '<dt>Uso</dt><dd>' + escapeHtml(localTime(slot.lastUsedAt)) + '</dd>' +
          '<dt>Error</dt><dd>' + escapeHtml(slot.lastError || "-") + '</dd>' +
          '<dt>Resp</dt><dd><span class="resp-line"><span>' + escapeHtml(responsePreview) + '</span>' +
          (canCopyResponse ? '<button class="copy-small" type="button" data-copy-slot-response="' + escapeHtml(name) + '">Copiar</button>' : '') +
          '</span></dd>' +
        '</dl>' +
        '<form data-pool-action method="post" action="' + escapeHtml(recyclePath) + '"><button type="submit">Reciclar slot</button></form>' +
      '</article>';
    }

    function renderPool(pool) {
      currentPool = pool;
      base.textContent = pool.baseUrl;
      summary.innerHTML = renderSummary(pool);
      queues.innerHTML = renderQueues(pool);
      slots.innerHTML = pool.slots.map(renderSlot).join("");
      json.textContent = localizeJson(pool);
      statusLine.textContent = "Actualizado " + statusText();
    }

    async function refreshPool() {
      const response = await fetch(poolPath, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("pool status " + response.status);
      renderPool(await response.json());
    }

    async function copyText(value) {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return;
      }

      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }

    copyJson.addEventListener("click", async () => {
      copyJson.disabled = true;
      try {
        await copyText(json.textContent || "");
        statusLine.textContent = "JSON copiado";
      } catch (error) {
        statusLine.textContent = "Error al copiar JSON";
      } finally {
        copyJson.disabled = false;
      }
    });

    document.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-copy-slot-response]");
      if (!button) return;
      const name = button.getAttribute("data-copy-slot-response");
      const slot = currentPool && currentPool.slots.find((item) => slotName(item) === name);
      if (!slot) return;
      button.disabled = true;
      try {
        await copyText(slot.lastResponseBody || slot.warmupResponse || "");
        statusLine.textContent = "Respuesta " + name + " copiada";
      } catch (error) {
        statusLine.textContent = "Error al copiar respuesta " + name;
      } finally {
        button.disabled = false;
      }
    });

    document.addEventListener("submit", async (event) => {
      const form = event.target.closest("[data-pool-action]");
      if (!form) return;
      event.preventDefault();
      const button = form.querySelector("button");
      const previous = button ? button.textContent : "";
      if (button) {
        button.disabled = true;
        button.textContent = "Procesando...";
      }
      statusLine.textContent = "Ejecutando accion...";
      try {
        const response = await fetch(form.action, { method: form.method || "POST", headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error("accion status " + response.status);
        await refreshPool();
      } catch (error) {
        statusLine.textContent = "Error: " + (error && error.message ? error.message : String(error));
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = previous;
        }
      }
    });

    setInterval(() => {
      refreshPool().catch((error) => {
        statusLine.textContent = "Error al actualizar: " + (error && error.message ? error.message : String(error));
      });
    }, refreshMs);
    refreshPool().catch(() => {});
  </script>
</body>
</html>`;
}
function renderSummaryMetrics(pool) {
    return [
        `<div class="metric"><b>${pool.ready}</b><span>Ready</span></div>`,
        `<div class="metric"><b>${pool.warming}</b><span>Warming</span></div>`,
        `<div class="metric"><b>${pool.error}</b><span>Error</span></div>`,
        `<div class="metric"><b>${pool.size}</b><span>Total</span></div>`,
        `<div class="metric restart"><b>${escapeHtml(pool.iisRestart.lastStartedAt || "-")}</b><span>Último IIS</span></div>`
    ].join("");
}
function renderQueueConfig(pool) {
    return [
        renderQueueCard("Mini", pool.config.mini),
        renderQueueCard("BigBoy", pool.config.bigb)
    ].join("");
}
function renderQueueCard(title, queue) {
    return `<article class="queue">
    <h2>${escapeHtml(title)}</h2>
    <div class="queue-grid">
      ${renderQueueItem(queue.base, "Base")}
      ${renderQueueItem(queue.current, "Actual")}
      ${renderQueueItem(queue.max, "Max")}
      ${renderQueueItem(queue.dynamic, "Adapt")}
      ${renderQueueItem(queue.ready, "Ready")}
      ${renderQueueItem(queue.inUse, "En uso")}
      ${renderQueueItem(queue.waiting, "Espera")}
      ${renderQueueItem(`${queue.holdMinutes}m`, "Retiene")}
    </div>
  </article>`;
}
function renderQueueItem(value, label) {
    return `<div class="queue-item"><b>${escapeHtml(String(value))}</b><span>${escapeHtml(label)}</span></div>`;
}
function renderSlotCard(basePath, slot) {
    var _a;
    const slotName = `S${slot.id.toString().padStart(2, "0")}${slot.kind === "mini" ? "M" : "B"}`;
    const recyclePath = `${basePath}/pool/slots/${slotName}/recycle`;
    const responsePreview = slot.lastResponsePreview || slot.warmupResponse || "-";
    const canCopyResponse = Boolean(slot.lastResponseBody || slot.warmupResponse);
    return `<article class="slot">
    <div class="slot-head">
      <div class="slot-id">${slotName}</div>
      <span class="badge ${escapeHtml(slot.status)}">${escapeHtml(slot.status)}</span>
    </div>
    <dl>
      <dt>Kind</dt><dd>${slot.kind === "mini" ? "Mini" : "BigBoy"}</dd>
      <dt>Modo</dt><dd>${slot.dynamic ? "Adaptativo" : "Base"}</dd>
      <dt>Uso</dt><dd>${slot.inUse ? "En uso" : "Libre"}</dd>
      <dt>Retiene</dt><dd>${escapeHtml(slot.holdUntil || "-")}</dd>
      <dt>Status</dt><dd>${(_a = slot.lastStatusCode) !== null && _a !== void 0 ? _a : "-"}</dd>
      <dt>Token</dt><dd>${slot.agesToken ? "Presente (oculto)" : "-"}</dd>
      <dt>Cookie</dt><dd>${slot.aspNetSessionId ? "Presente (oculta)" : "-"}</dd>
      <dt>Endpoint</dt><dd>${escapeHtml(slot.lastEndpoint || "-")}</dd>
      <dt>Uso</dt><dd>${escapeHtml(slot.lastUsedAt || "-")}</dd>
      <dt>Error</dt><dd>${escapeHtml(slot.lastError || "-")}</dd>
      <dt>Resp</dt><dd><span class="resp-line"><span>${escapeHtml(responsePreview)}</span>${canCopyResponse ? `<button class="copy-small" type="button" data-copy-slot-response="${escapeHtml(slotName)}">Copiar</button>` : ""}</span></dd>
    </dl>
    <form data-pool-action method="post" action="${escapeHtml(recyclePath)}">
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
