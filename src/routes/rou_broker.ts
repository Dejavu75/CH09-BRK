import { Request, Response, Router } from "express";

import { agesConnectionPool } from "../services/ages_pool";
import { warn } from "../utils/logger";

export const BrokerRouter = Router();

BrokerRouter.get("/", (_req, res) => {
  res.send({ message: "Welcome to the broker: where messages learn to behave before crossing the border." });
});

BrokerRouter.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "CH09-BRK"
  });
});

BrokerRouter.get("/ages-pool", (_req, res) => {
  res.json(agesConnectionPool.getSummary());
});

BrokerRouter.get("/pool", (_req, res) => {
  res.json(agesConnectionPool.getSummary());
});

BrokerRouter.get("/ages-pool/show", (req, res) => {
  res.type("html").send(renderPoolPage(req));
});

BrokerRouter.get("/pool/show", (req, res) => {
  res.type("html").send(renderPoolPage(req));
});

BrokerRouter.post("/ages-pool/warmup", async (_req, res) => {
  res.json(await agesConnectionPool.warmUp());
});

BrokerRouter.post("/ages-pool/slots/:slot/recycle", async (req, res) => {
  await recyclePoolSlot(req, res);
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

BrokerRouter.all("/ages/:agesFunction", async (req, res) => {
  await proxyAgesRequest("bigb", req, res);
});

BrokerRouter.all("/~mini~/:agesFunction", async (req, res) => {
  await proxyAgesRequest("mini", req, res);
});

BrokerRouter.all("/:agesFunction", async (req, res) => {
  await proxyAgesRequest("bigb", req, res);
});

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

async function proxyAgesRequest(kind: "bigb" | "mini", req: Request, res: Response): Promise<void> {
  try {
    const sourceIp = getSourceIp(req);
    const result = await agesConnectionPool.proxyCall(
      kind,
      String(req.params.agesFunction),
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
    res
      .status(result.status)
      .setHeader("X-CH09-BRK-Pool-Slot", result.slotId.toString().padStart(2, "0"))
      .setHeader("X-CH09-BRK-Pool-Kind", result.slotKind)
      .send(result.body);
  } catch (error) {
    const sourceIp = getSourceIp(req);
    warn(
      [
        `proxy route err`,
        `kind=${kind}`,
        `ip=${sourceIp.value || "unknown"}`,
        `ips=${sourceIp.source || "unknown"}`,
        `m=${req.method}`,
        `u=${req.originalUrl}`,
        `h=${Object.keys(req.headers).sort().join(",") || "none"}`,
        `b=${getRequestBodySize(req)}`,
        `err=${formatRouteError(error)}`
      ].join(" | ")
    );

    if (error instanceof Error && /^AGES (mini|bigb) pool is still in warmup$/.test(error.message)) {
      res.status(503).json({
        status: "warmup",
        message: error.message.replace("bigb", "BigBoy"),
        pool: agesConnectionPool.getSummary()
      });
      return;
    }

    res.status(502).json({
      status: "error",
      message: error instanceof Error ? error.message : String(error)
    });
  }
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
    if (value === undefined) {
      return;
    }

    headers[key] = Array.isArray(value) ? value.join(", ") : value;
  });

  return headers;
}

function getProxyBody(req: Request): BodyInit | undefined {
  if (["GET", "HEAD"].includes(req.method.toUpperCase()) || req.body === undefined) {
    return undefined;
  }

  if (Buffer.isBuffer(req.body) || typeof req.body === "string") {
    return req.body as unknown as BodyInit;
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

function setProxyResponseHeaders(res: Response, headers: Record<string, string | string[]>): void {
  const ignoredHeaders = new Set(["connection", "content-encoding", "content-length", "transfer-encoding"]);

  Object.entries(headers).forEach(([key, value]) => {
    if (!ignoredHeaders.has(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  });
}

function renderPoolPage(req: Request): string {
  const pool = agesConnectionPool.getSummary();
  const json = escapeHtml(JSON.stringify(pool, null, 2));
  const basePath = req.baseUrl || "";
  const poolPath = `${basePath}/pool`;
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
        <div id="base" class="base">${escapeHtml(pool.baseUrl)}</div>
      </div>
      <div class="actions">
        <form data-pool-action method="post" action="${escapeHtml(warmupPath)}"><button type="submit">Warmup</button></form>
        <form data-pool-action method="post" action="${escapeHtml(restartPath)}"><button class="danger" type="submit">Restart IIS</button></form>
      </div>
    </header>
    <section class="summary" id="summary">
      ${renderSummaryMetrics(pool)}
    </section>
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
    const slots = document.getElementById("slots");
    const json = document.getElementById("json");
    const base = document.getElementById("base");

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

    function renderSummary(pool) {
      return [
        '<div class="metric"><b>' + pool.ready + '</b><span>Ready</span></div>',
        '<div class="metric"><b>' + pool.warming + '</b><span>Warming</span></div>',
        '<div class="metric"><b>' + pool.error + '</b><span>Error</span></div>',
        '<div class="metric"><b>' + pool.size + '</b><span>Total</span></div>'
      ].join("");
    }

    function renderSlot(slot) {
      const name = slotName(slot);
      const recyclePath = ${JSON.stringify(basePath)} + "/pool/slots/" + name + "/recycle";
      return '<article class="slot">' +
        '<div class="slot-head"><div class="slot-id">' + name + '</div><span class="badge ' + escapeHtml(slot.status) + '">' + escapeHtml(slot.status) + '</span></div>' +
        '<dl>' +
          '<dt>Kind</dt><dd>' + (slot.kind === "mini" ? "Mini" : "BigBoy") + '</dd>' +
          '<dt>Status</dt><dd>' + escapeHtml(slot.lastStatusCode ?? "-") + '</dd>' +
          '<dt>Token</dt><dd>' + escapeHtml(slot.agesToken || "-") + '</dd>' +
          '<dt>Cookie</dt><dd>' + escapeHtml(slot.aspNetSessionId || "-") + '</dd>' +
          '<dt>Endpoint</dt><dd>' + escapeHtml(slot.lastEndpoint || "-") + '</dd>' +
          '<dt>Uso</dt><dd>' + escapeHtml(slot.lastUsedAt || "-") + '</dd>' +
          '<dt>Error</dt><dd>' + escapeHtml(slot.lastError || "-") + '</dd>' +
          '<dt>Resp</dt><dd>' + escapeHtml(slot.lastResponsePreview || slot.warmupResponse || "-") + '</dd>' +
        '</dl>' +
        '<form data-pool-action method="post" action="' + escapeHtml(recyclePath) + '"><button type="submit">Reciclar slot</button></form>' +
      '</article>';
    }

    function renderPool(pool) {
      base.textContent = pool.baseUrl;
      summary.innerHTML = renderSummary(pool);
      slots.innerHTML = pool.slots.map(renderSlot).join("");
      json.textContent = JSON.stringify(pool, null, 2);
      statusLine.textContent = "Actualizado " + statusText();
    }

    async function refreshPool() {
      const response = await fetch(poolPath, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("pool status " + response.status);
      renderPool(await response.json());
    }

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
  </script>
</body>
</html>`;
}

function renderSummaryMetrics(pool: ReturnType<typeof agesConnectionPool.getSummary>): string {
  return [
    `<div class="metric"><b>${pool.ready}</b><span>Ready</span></div>`,
    `<div class="metric"><b>${pool.warming}</b><span>Warming</span></div>`,
    `<div class="metric"><b>${pool.error}</b><span>Error</span></div>`,
    `<div class="metric"><b>${pool.size}</b><span>Total</span></div>`
  ].join("");
}

function renderSlotCard(basePath: string, slot: ReturnType<typeof agesConnectionPool.getSummary>["slots"][number]): string {
  const slotName = `S${slot.id.toString().padStart(2, "0")}${slot.kind === "mini" ? "M" : "B"}`;
  const recyclePath = `${basePath}/pool/slots/${slotName}/recycle`;

  return `<article class="slot">
    <div class="slot-head">
      <div class="slot-id">${slotName}</div>
      <span class="badge ${escapeHtml(slot.status)}">${escapeHtml(slot.status)}</span>
    </div>
    <dl>
      <dt>Kind</dt><dd>${slot.kind === "mini" ? "Mini" : "BigBoy"}</dd>
      <dt>Status</dt><dd>${slot.lastStatusCode ?? "-"}</dd>
      <dt>Token</dt><dd>${escapeHtml(slot.agesToken || "-")}</dd>
      <dt>Cookie</dt><dd>${escapeHtml(slot.aspNetSessionId || "-")}</dd>
      <dt>Endpoint</dt><dd>${escapeHtml(slot.lastEndpoint || "-")}</dd>
      <dt>Uso</dt><dd>${escapeHtml(slot.lastUsedAt || "-")}</dd>
      <dt>Error</dt><dd>${escapeHtml(slot.lastError || "-")}</dd>
      <dt>Resp</dt><dd>${escapeHtml(slot.lastResponsePreview || slot.warmupResponse || "-")}</dd>
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
