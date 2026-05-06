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

BrokerRouter.post("/ages-pool/warmup", async (_req, res) => {
  res.json(await agesConnectionPool.warmUp());
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

async function proxyAgesRequest(kind: "bigb" | "mini", req: Request, res: Response): Promise<void> {
  try {
    const result = await agesConnectionPool.proxyCall(
      kind,
      String(req.params.agesFunction),
      getQueryString(req),
      {
        method: req.method,
        headers: getProxyHeaders(req),
        body: getProxyBody(req)
      },
      getSourceIp(req)
    );

    setProxyResponseHeaders(res, result.headers);
    res
      .status(result.status)
      .setHeader("X-CH09-BRK-Pool-Slot", result.slotId.toString().padStart(2, "0"))
      .setHeader("X-CH09-BRK-Pool-Kind", result.slotKind)
      .send(result.body);
  } catch (error) {
    if (error instanceof Error && error.message === "AGES pool is still in warmup") {
      res.status(503).json({
        status: "warmup",
        message: "AGES pool slots are still in warmup",
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

function getSourceIp(req: Request): string {
  const candidates = [
    getFirstHeaderValue(req.headers["x-forwarded-for"])?.split(",")[0],
    getFirstHeaderValue(req.headers["x-real-ip"]),
    getFirstHeaderValue(req.headers["x-client-ip"]),
    getFirstHeaderValue(req.headers["x-original-forwarded-for"])?.split(",")[0],
    getForwardedFor(req.headers.forwarded),
    req.ip,
    req.socket.remoteAddress
  ];

  const sourceIp = candidates.find((value) => value && value.trim().length > 0) ?? "";

  return normalizeIp(sourceIp);
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
