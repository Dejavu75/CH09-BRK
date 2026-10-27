import { Request, Response, Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { getHeartBeat } from "se_configbase";

import { agesConnectionPool } from "../services/ages_pool";
import type { TimingFilters } from "../services/timing_store";
import { configureHeartbeatExtraData } from "../services/heartbeat_metadata";
import { warn } from "../utils/logger";
import { BROKER_BUILD_INFO } from "../generated/build_info";
import { SERVICE_KEY_HEADER } from "../auth/http";
import { SESSION_COOKIE } from "../auth/session_store";

export const BrokerRouter = Router();

BrokerRouter.get("/", (_req, res) => {
  res.send({ message: "Welcome to the broker: where messages learn to behave before crossing the border." });
});

BrokerRouter.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "CH09-BRK",
    build: BROKER_BUILD_INFO
  });
});

BrokerRouter.all("/heartbeat", (_req, res) => {
  res.json({ message: "AGES Broker is alive." });
});

BrokerRouter.all("/heartbeat/beat", (_req, res) => {
  configureHeartbeatExtraData();
  res.json(getHeartBeat());
});

BrokerRouter.get("/pool", (_req, res) => {
  res.json(getPublicPoolSummary());
});

BrokerRouter.get("/pool/timings", (req, res) => {
  const rawCursor = req.query.cursor;
  if (rawCursor !== undefined && (typeof rawCursor !== "string" || !/^[1-9]\d*$/.test(rawCursor) ||
    !Number.isSafeInteger(Number(rawCursor)))) {
    res.status(400).json({ error: "Invalid timing cursor" });
    return;
  }
  const filters: TimingFilters = {};
  for (const key of ["from", "to", "url", "result", "minTotalMs"] as const) {
    const value = req.query[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length === 0 || value.length > 512) {
      res.status(400).json({ error: `Invalid timing filter: ${key}` });
      return;
    }
    if (key === "minTotalMs") {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        res.status(400).json({ error: "Invalid timing filter: minTotalMs" });
        return;
      }
      filters.minTotalMs = Number(value);
    } else {
      if ((key === "from" || key === "to") &&
        (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
          !Number.isFinite(Date.parse(value)) || Number(value.slice(11, 13)) > 23 ||
          new Date(value.slice(0, 10) + "T00:00:00Z").toISOString().slice(0, 10) !== value.slice(0, 10))) {
        res.status(400).json({ error: `Invalid timing filter: ${key}` });
        return;
      }
      if (key === "result" && !/^(errors|[2-5]xx|[1-5]\d{2})$/.test(value)) {
        res.status(400).json({ error: "Invalid timing filter: result" });
        return;
      }
      filters[key] = value;
    }
  }
  if (filters.from && filters.to && Date.parse(filters.from) > Date.parse(filters.to)) {
    res.status(400).json({ error: "Timing filter from must not exceed to" });
    return;
  }
  res.json(agesConnectionPool.getTimingLog(rawCursor === undefined ? undefined : Number(rawCursor), filters));
});

BrokerRouter.post("/pool/timings/clear", (_req, res) => {
  res.json(agesConnectionPool.clearTimingLog());
});

BrokerRouter.get("/pool/timings/show", (req, res) => {
  res.type("html").send(renderTimingPage(req));
});

BrokerRouter.get("/pool/show", (req, res) => {
  res.type("html").send(renderPoolPage(req));
});

BrokerRouter.post("/pool/warmup", requireBrokerAdmin, async (_req, res) => {
  try {
    res.json(await agesConnectionPool.warmUp());
  } catch (error) {
    const message = formatRouteError(error);
    res.status(/while backend|Global warmup|already recycling/i.test(message) ? 409 : 503)
      .json({ status: "error", message });
  }
});

BrokerRouter.post("/pool/backends/:backend/drain-recycle", requireBrokerAdmin, async (req, res) => {
  try {
    res.json(await agesConnectionPool.drainAndRecycleBackend(String(req.params.backend)));
  } catch (error) {
    res.status(409).json({ status: "error", message: formatRouteError(error) });
  }
});

BrokerRouter.post("/pool/slots/:slot/recycle", async (req, res) => {
  await recyclePoolSlot(req, res);
});

BrokerRouter.post("/ages-host/restart-iis", async (_req, res) => {
  await restartIis(res);
});

BrokerRouter.post("/iis/restart", async (_req, res) => {
  await restartIis(res);
});

BrokerRouter.get("/ages-host/restart-iis", async (_req, res) => {
  await restartIis(res);
});

BrokerRouter.get("/iis/restart", async (_req, res) => {
  await restartIis(res);
});

BrokerRouter.all("/ages/~mini~/:agesFunction", async (req, res) => {
  await proxyAgesRequest("mini", req, res);
});

BrokerRouter.all("/ages/~mini~/*", async (req, res) => {
  await proxyAgesRequest("mini", req, res, translateRestPathToAgesFunction(getWildcardPath(req)));
});

BrokerRouter.all("/ages/:agesFunction", async (req, res) => {
  await proxyAgesRequest("bigb", req, res);
});

BrokerRouter.all("/ages/*", async (req, res) => {
  await proxyAgesRequest("bigb", req, res, translateRestPathToAgesFunction(getWildcardPath(req)));
});

BrokerRouter.all("/~mini~/:agesFunction", async (req, res) => {
  await proxyAgesRequest("mini", req, res);
});

BrokerRouter.all("/~mini~/*", async (req, res) => {
  await proxyAgesRequest("mini", req, res, translateRestPathToAgesFunction(getWildcardPath(req)));
});

BrokerRouter.all("/:agesFunction", async (req, res) => {
  await proxyAgesRequest("bigb", req, res);
});

BrokerRouter.all("/*", async (req, res) => {
  await proxyAgesRequest("bigb", req, res, translateRestPathToAgesFunction(getWildcardPath(req)));
});

export function isBrokerAdminAuthorized(supplied: string | undefined, configured = process.env.BROKER_ADMIN_API_KEY): boolean {
  if (!supplied || !configured || supplied.length !== configured.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(configured));
}

function requireBrokerAdmin(req: Request, res: Response, next: () => void): void {
  const configured = process.env.BROKER_ADMIN_API_KEY;
  if (!configured) {
    res.status(503).json({ status: "error", message: "Broker admin API is not configured" });
    return;
  }
  const supplied = getFirstHeaderValue(req.headers["x-broker-admin-api-key"]);
  if (!isBrokerAdminAuthorized(supplied, configured)) {
    res.status(403).json({ status: "error", message: "Forbidden" });
    return;
  }
  next();
}

async function recyclePoolSlot(req: Request, res: Response): Promise<void> {
  try {
    res.json(await agesConnectionPool.recycleSlotByReference(String(req.params.slot)));
  } catch (error) {
    res.status(400).json({
      status: "error",
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

async function restartIis(res: Response): Promise<void> {
  const result = await agesConnectionPool.restartAgesHostManually();
  res.status(result.status === "ok" ? 200 : 500).json(result);
}

async function proxyAgesRequest(kind: "bigb" | "mini", req: Request, res: Response, agesFunction?: string): Promise<void> {
  try {
    const sourceIp = getSourceIp(req);
    const result = await agesConnectionPool.proxyCall(
      kind,
      agesFunction ?? String(req.params.agesFunction),
      getQueryString(req),
      {
        method: req.method,
        headers: getProxyHeaders(req),
        body: getProxyBody(req)
      },
      sourceIp.value,
      sourceIp.source
    );

    setProxyResponseHeaders(res, result.headers);
    const trace = agesConnectionPool.completeTraceResponse(result.traceId, result.status, result.body.length);
    setTraceHeaders(res, result.traceHeaders, trace);
    res
      .status(result.status)
      .setHeader("X-CH09-BRK-Pool-Slot", result.slotId.toString().padStart(2, "0"))
      .setHeader("X-CH09-BRK-Pool-Kind", result.slotKind)
      .setHeader("X-CH09-BRK-Backend", result.backendId)
      .send(result.body);
  } catch (error) {
    const sourceIp = getSourceIp(req);
    const isWarmup = error instanceof Error && /^AGES (mini|bigb) pool is still in warmup$/.test(error.message);
    warn(
      [
        `proxy route err`,
        `kind=${kind}`,
        `ip=${sourceIp.value || "unknown"}`,
        `ips=${sourceIp.source || "unknown"}`,
        `m=${req.method}`,
        `u=${req.originalUrl.split("?", 1)[0]}`,
        `h=${Object.keys(req.headers).sort().join(",") || "none"}`,
        `b=${getRequestBodySize(req)}`,
        `st=${isWarmup ? 503 : 502}`,
        `err=${safeRouteErrorName(error)}`
      ].join(" | ")
    );

    if (isWarmup && error instanceof Error) {
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
}

function translateRestPathToAgesFunction(path: string): string {
  const segments = path
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length <= 1) {
    return segments[0] ?? path;
  }

  const modules = segments.slice(0, -1).map(normalizeAgesModuleSegment);
  const functionName = segments[segments.length - 1].replace(/\.ages$/i, "");

  return [...modules, functionName].join(".");
}

function getWildcardPath(req: Request): string {
  const params = req.params as Record<string, string | string[] | undefined>;
  const value = params[0] ?? params["0"] ?? params[""];

  return Array.isArray(value) ? value.join("/") : String(value ?? "");
}

function normalizeAgesModuleSegment(segment: string): string {
  const unprefixed = segment.replace(/^o/i, "");
  if (unprefixed.toLowerCase() === "centros_costos") return "oCentros";
  return segment.toLowerCase().startsWith("o") ? segment : `o${segment}`;
}

function getQueryString(req: Request): string {
  return req.originalUrl.split("?")[1] ?? "";
}

function getSourceIp(req: Request): { source: string; value: string } {
  const candidates = [
    { source: "xff", value: getFirstHeaderValue(req.headers["x-forwarded-for"])?.split(",")[0] },
    { source: "xri", value: getFirstHeaderValue(req.headers["x-real-ip"]) },
    { source: "xci", value: getFirstHeaderValue(req.headers["x-client-ip"]) },
    { source: "xofi", value: getFirstHeaderValue(req.headers["x-original-forwarded-for"])?.split(",")[0] },
    { source: "cf", value: getFirstHeaderValue(req.headers["cf-connecting-ip"]) },
    { source: "tci", value: getFirstHeaderValue(req.headers["true-client-ip"]) },
    { source: "envoy", value: getFirstHeaderValue(req.headers["x-envoy-external-address"]) },
    { source: "forwarded", value: getForwardedFor(req.headers.forwarded) },
    { source: "req", value: req.ip },
    { source: "socket", value: req.socket.remoteAddress }
  ];

  const sourceIp = candidates.find((candidate) => candidate.value && candidate.value.trim().length > 0) ?? {
    source: "unknown",
    value: ""
  };

  return {
    source: sourceIp.source,
    value: normalizeIp(sourceIp.value ?? "")
  };
}

function getFirstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function getForwardedFor(value: string | string[] | undefined): string | undefined {
  const forwarded = getFirstHeaderValue(value);

  if (!forwarded) {
    return undefined;
  }

  return forwarded.match(/for="?([^;,"]+)/i)?.[1];
}

function normalizeIp(value: string): string {
  return value.trim().replace(/^::ffff:/, "");
}

function getProxyHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {};

  Object.entries(req.headers).forEach(([key, value]) => {
    if (value === undefined || ["content-length", "transfer-encoding", SERVICE_KEY_HEADER].includes(key.toLowerCase())) {
      return;
    }

    const normalized = Array.isArray(value) ? value.join(", ") : value;
    if (key.toLowerCase() === "cookie") {
      const filtered = withoutBrokerSession(normalized);
      if (filtered) headers[key] = filtered;
    } else {
      headers[key] = normalized;
    }
  });

  return headers;
}

function withoutBrokerSession(value: string): string {
  return value.split(";").map(part => part.trim())
    .filter(part => part && part.slice(0, part.indexOf("=") >= 0 ? part.indexOf("=") : part.length).trim() !== SESSION_COOKIE)
    .join("; ");
}

function getProxyBody(req: Request): BodyInit | undefined {
  if (["GET", "HEAD"].includes(req.method.toUpperCase()) || req.body === undefined) {
    return undefined;
  }

  if (Buffer.isBuffer(req.body) || typeof req.body === "string") {
    return req.body as unknown as BodyInit;
  }

  // Body parsers initialize an absent body as {}; do not invent a JSON payload.
  if (!req.headers["transfer-encoding"] && Number(req.headers["content-length"] ?? 0) === 0) {
    return undefined;
  }

  return JSON.stringify(req.body);
}

function getRequestBodySize(req: Request): number {
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

function formatRouteError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}:${error.message}`;
  }

  return String(error);
}

function safeRouteErrorName(error: unknown): string {
  if (!(error instanceof Error)) return "Error";
  return ["AbortError", "TimeoutError", "TypeError", "Error"].includes(error.name) ? error.name : "Error";
}

function setProxyResponseHeaders(res: Response, headers: Record<string, string | string[]>): void {
  const ignoredHeaders = new Set(["connection", "content-encoding", "content-length", "transfer-encoding"]);

  Object.entries(headers).forEach(([key, value]) => {
    if (!ignoredHeaders.has(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  });
}

function setTraceHeaders(res: Response, headers: Record<string, string>, trace: ReturnType<typeof agesConnectionPool.completeTraceResponse>): void {
  Object.entries(headers).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  if (trace) {
    res
      .setHeader("X-CH09-BRK-Broker-Out", trace.brokerOutAt ?? "")
      .setHeader("X-CH09-BRK-Total-Ms", String(trace.totalMs ?? 0));
  }
}

function renderTimingPage(req: Request): string {
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
    #timingFilters { margin-bottom: 16px; padding: 16px; border: 1px solid #334155; border-radius: 8px; background: #111827; }
    #timingFilters .filter-grid { display: grid; grid-template-columns: minmax(190px, 1fr) minmax(190px, 1fr) minmax(220px, 1.5fr) minmax(130px, .8fr) minmax(150px, .9fr); gap: 12px; align-items: end; }
    #timingFilters .filter-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; color: #cbd5e1; font-size: 12px; line-height: 16px; }
    #timingFilters input, #timingFilters select { width: 100%; min-width: 0; height: 36px; padding: 7px 10px; border: 1px solid #475569; border-radius: 6px; background: #0f172a; color: #e5e7eb; font: 13px Arial, sans-serif; }
    #timingFilters input:hover, #timingFilters select:hover { border-color: #94a3b8; }
    #timingFilters input:focus-visible, #timingFilters select:focus-visible, #timingFilters button:focus-visible { outline: 2px solid #93c5fd; outline-offset: 2px; }
    #timingFilters input:disabled, #timingFilters select:disabled, #timingFilters button:disabled { opacity: .5; cursor: not-allowed; }
    #timingFilters .filter-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 8px; margin-top: 12px; }
    #timingFilters button { min-height: 36px; }
    #timingFilters button[type="submit"] { border-color: #0f766e; background: #0f766e; }
    #timingFilters button[type="submit"]:hover { border-color: #115e59; background: #115e59; }
    #timingFilters button[type="reset"] { border-color: #334155; background: transparent; color: #cbd5e1; }
    #timingFilters button[type="reset"]:hover { background: #1e293b; }
    #timingFilters #filterStatus { display: block; margin-top: 12px; color: #fecaca; font-size: 13px; line-height: 1.4; }
    #timingFilters #filterStatus:empty { margin-top: 0; }
    @media (max-width: 1000px) {
      #timingFilters .filter-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      #timingFilters .filter-endpoint { grid-column: 1 / -1; }
    }
    @media (max-width: 560px) {
      #timingFilters { padding: 12px; }
      #timingFilters .filter-grid { grid-template-columns: minmax(0, 1fr); }
      #timingFilters .filter-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
      #timingFilters input, #timingFilters select, #timingFilters button { min-height: 40px; }
    }
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
        <button id="refreshTimings" type="button">Actualizar</button>
        <button id="newerTimings" type="button" disabled>Ir al inicio</button>
        <button id="olderTimings" type="button" disabled>Más antiguos</button>
        <span id="copyStatus" class="copy-status"></span>
      </div>
    </header>
    <form id="timingFilters" aria-label="Filtros de timings">
      <div class="filter-grid">
        <label class="filter-field">Desde <input name="from" type="datetime-local" step="1"></label>
        <label class="filter-field">Hasta <input name="to" type="datetime-local" step="1"></label>
        <label class="filter-field filter-endpoint">Endpoint contiene <input name="url" type="search" maxlength="512"></label>
        <label class="filter-field">Resultado <select name="result">
          <option value="">Todos</option><option value="errors">Con error</option>
          <option value="2xx">HTTP 2xx</option><option value="3xx">HTTP 3xx</option>
          <option value="4xx">HTTP 4xx</option><option value="5xx">HTTP 5xx</option>
        </select></label>
        <label class="filter-field">Total mínimo (ms) <input name="minTotalMs" type="number" min="0" step="1" max="9007199254740991"></label>
      </div>
      <div class="filter-actions">
        <button type="submit">Aplicar filtros</button>
        <button type="reset">Restablecer filtros</button>
      </div>
      <span id="filterStatus" role="status" aria-live="polite"></span>
    </form>
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
        <tbody><tr><td colspan="17">Cargando...</td></tr></tbody>
      </table>
    </div>
    <details>
      <summary>JSON de metadatos (sin cuerpos ni credenciales)</summary>
      <pre>[]</pre>
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
    const newerTimings = document.getElementById("newerTimings");
    const olderTimings = document.getElementById("olderTimings");
    const refreshButton = document.getElementById("refreshTimings");
    const filterForm = document.getElementById("timingFilters");
    const filterStatus = document.getElementById("filterStatus");
    let activeFilters = new URLSearchParams();
    let timingRows = [];
    let currentCursor;
    let nextCursor;
    let requestVersion = 0;
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
      const cursor = currentCursor;
      const version = ++requestVersion;
      const query = new URLSearchParams(activeFilters);
      if (cursor !== undefined) query.set("cursor", cursor);
      const url = timingsPath + (query.size ? "?" + query.toString() : "");
      let page;
      try {
        const response = await fetch(url, { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error("timings status " + response.status);
        page = await response.json();
      } catch (_error) {
        if (version === requestVersion) filterStatus.textContent = "No se pudieron cargar los registros. Verifique los filtros e intente nuevamente.";
        return;
      }
      if (version !== requestVersion || cursor !== currentCursor) return;
      filterStatus.textContent = "";
      timingRows = [...(page.liveRows || []), ...page.rows];
      nextCursor = page.nextCursor;
      newerTimings.disabled = currentCursor === undefined;
      olderTimings.disabled = nextCursor === undefined;
      renderTimings();
    }

    async function csrfToken() {
      const response = await fetch("/auth/session", { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("session status " + response.status);
      return (await response.json()).csrfToken;
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

    function applyFilters(query) {
      activeFilters = query;
      currentCursor = undefined;
      nextCursor = undefined;
      olderTimings.disabled = true;
      newerTimings.disabled = true;
      timingRows = [];
      renderTimings();
      void refreshTimings();
    }

    filterForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const query = new URLSearchParams();
      for (const [key, value] of new FormData(filterForm)) {
        if (value) query.set(key, key === "from" || key === "to" ? new Date(value).toISOString() : value);
      }
      applyFilters(query);
    });
    filterForm.addEventListener("reset", () => applyFilters(new URLSearchParams()));

    refreshTimings();
    setInterval(() => { if (currentCursor === undefined) void refreshTimings(); }, 5000);
    refreshButton.addEventListener("click", refreshTimings);
    olderTimings.addEventListener("click", async () => {
      if (nextCursor === undefined) return;
      currentCursor = nextCursor;
      await refreshTimings();
    });
    newerTimings.addEventListener("click", async () => {
      currentCursor = undefined;
      await refreshTimings();
    });
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
        const response = await fetch(clearTimingsPath, {
          method: "POST", headers: { Accept: "application/json", "X-CSRF-Token": await csrfToken() }
        });
        if (!response.ok) throw new Error("clear status " + response.status);
        currentCursor = undefined;
        await refreshTimings();
      } catch (_error) {
        showCopyStatus("Error al limpiar");
      } finally {
        clearTimings.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

type PublicPoolSummary = ReturnType<typeof agesConnectionPool.getSummary> & {
  build: typeof BROKER_BUILD_INFO;
};

function getPublicPoolSummary(): PublicPoolSummary {
  const pool = agesConnectionPool.getSummary();

  return {
    ...pool,
    build: BROKER_BUILD_INFO,
    slots: pool.slots.map((slot) => ({
      ...slot,
      agesToken: slot.agesToken ? "Presente (oculto)" : "",
      aspNetSessionId: slot.aspNetSessionId ? "Presente (oculta)" : ""
    }))
  };
}

function renderPoolPage(req: Request): string {
  const pool = getPublicPoolSummary();
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
        <div id="base" class="base">${escapeHtml(`${pool.mode}: ${pool.backends.map((backend) => `${backend.id}=${backend.baseUrl}`).join(" · ")}`)}</div>
      </div>
      <div class="actions">
        <a class="nav-button" href="${escapeHtml(timingsShowPath)}">Timings</a>
        <button id="copyJson" type="button">Copiar JSON</button>
        <form data-pool-action method="post" action="${escapeHtml(clearTimingsPath)}"><button type="submit">Limpiar métricas</button></form>
        <form data-pool-action data-admin-required method="post" action="${escapeHtml(warmupPath)}"><button type="submit">Warmup</button></form>
        <form data-pool-action method="post" action="${escapeHtml(restartPath)}"><button class="danger" type="submit">Restart IIS</button></form>
      </div>
    </header>
    <section class="summary" id="summary">
      ${renderSummaryMetrics(pool)}
    </section>
    <section class="queues" id="queues">${queueCards}</section>
    <section class="grid" id="slots">${cards}</section>
    <div class="statusline" id="statusline">ACTUALIZADO al abrir</div>
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
    const buildInfo = ${JSON.stringify(BROKER_BUILD_INFO)};
    let currentPool = null;
    async function csrfToken() {
      const response = await fetch("/auth/session", { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("session status " + response.status);
      return (await response.json()).csrfToken;
    }
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

    function buildInfoText() {
      return "Versión " + buildInfo.version + " · Compilado " + localTime(buildInfo.builtAt);
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
          '<dt>Backend</dt><dd>' + escapeHtml(slot.backendId) + '</dd>' +
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
      base.textContent = pool.mode + ": " + pool.backends.map((backend) => backend.id + "=" + backend.baseUrl).join(" · ");
      summary.innerHTML = renderSummary(pool);
      queues.innerHTML = renderQueues(pool);
      slots.innerHTML = pool.slots.map(renderSlot).join("");
      json.textContent = localizeJson(pool);
      statusLine.textContent = "ACTUALIZADO " + statusText() + " · " + buildInfoText();
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
      const headers = { Accept: "application/json" };
      if (form.hasAttribute("data-admin-required")) {
        const adminKey = window.prompt("Broker admin API key");
        if (!adminKey) {
          statusLine.textContent = "Accion cancelada";
          return;
        }
        headers["X-Broker-Admin-Api-Key"] = adminKey;
      }
      const button = form.querySelector("button");
      const previous = button ? button.textContent : "";
      if (button) {
        button.disabled = true;
        button.textContent = "Procesando...";
      }
      statusLine.textContent = "Ejecutando accion...";
      try {
        headers["X-CSRF-Token"] = await csrfToken();
        const response = await fetch(form.action, { method: form.method || "POST", headers });
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

function renderSummaryMetrics(pool: ReturnType<typeof agesConnectionPool.getSummary>): string {
  return [
    `<div class="metric"><b>${pool.ready}</b><span>Ready</span></div>`,
    `<div class="metric"><b>${pool.warming}</b><span>Warming</span></div>`,
    `<div class="metric"><b>${pool.error}</b><span>Error</span></div>`,
    `<div class="metric"><b>${pool.size}</b><span>Total</span></div>`,
    `<div class="metric restart"><b>${escapeHtml(pool.iisRestart.lastStartedAt || "-")}</b><span>Último IIS</span></div>`
  ].join("");
}

function renderQueueConfig(pool: ReturnType<typeof agesConnectionPool.getSummary>): string {
  return [
    renderQueueCard("Mini", pool.config.mini),
    renderQueueCard("BigBoy", pool.config.bigb)
  ].join("");
}

function renderQueueCard(title: string, queue: ReturnType<typeof agesConnectionPool.getSummary>["config"]["mini"]): string {
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

function renderQueueItem(value: string | number, label: string): string {
  return `<div class="queue-item"><b>${escapeHtml(String(value))}</b><span>${escapeHtml(label)}</span></div>`;
}

function renderSlotCard(basePath: string, slot: ReturnType<typeof agesConnectionPool.getSummary>["slots"][number]): string {
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
      <dt>Backend</dt><dd>${escapeHtml(slot.backendId)}</dd>
      <dt>Kind</dt><dd>${slot.kind === "mini" ? "Mini" : "BigBoy"}</dd>
      <dt>Modo</dt><dd>${slot.dynamic ? "Adaptativo" : "Base"}</dd>
      <dt>Uso</dt><dd>${slot.inUse ? "En uso" : "Libre"}</dd>
      <dt>Retiene</dt><dd>${escapeHtml(slot.holdUntil || "-")}</dd>
      <dt>Status</dt><dd>${slot.lastStatusCode ?? "-"}</dd>
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
