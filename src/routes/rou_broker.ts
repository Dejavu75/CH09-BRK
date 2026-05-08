import { Request, Response, Router } from "express";

import { agesConnectionPool } from "../services/ages_pool";

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

BrokerRouter.get("/ages-pool/show", (_req, res) => {
  res.type("html").send(renderPoolPage());
});

BrokerRouter.get("/pool/show", (_req, res) => {
  res.type("html").send(renderPoolPage());
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

function setProxyResponseHeaders(res: Response, headers: Record<string, string | string[]>): void {
  const ignoredHeaders = new Set(["connection", "content-encoding", "content-length", "transfer-encoding"]);

  Object.entries(headers).forEach(([key, value]) => {
    if (!ignoredHeaders.has(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  });
}

function renderPoolPage(): string {
  const pool = agesConnectionPool.getSummary();
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
