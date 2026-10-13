import { timingSafeEqual } from "node:crypto";
import { NextFunction, Request, RequestHandler, Response, Router, json, urlencoded } from "express";

import { BrokerAuthService } from "./auth_service";
import { verifyMs07BeatBearer } from "./interms";

export const SERVICE_KEY_HEADER = "x-broker-service-api-key";

export const requireSecureTransport: RequestHandler = (req, res, next) => {
  if (req.secure) {
    next();
    return;
  }
  // Do not redirect: a redirect could forward credentials or service keys.
  res.status(403).set("Cache-Control", "no-store").json({ error: "HTTPS required" });
};

function safeNext(value: unknown): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") &&
    !/[\\\r\n]/.test(value) ? value : "/foreign/broker/pool/show";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character] || character);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value;
}

function requestHost(req: Request): string | undefined {
  const hostHeaders = req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === "host");
  return hostHeaders.length === 1 ? firstHeader(req.headers.host) : undefined;
}

function sameKey(supplied: string | undefined, expected: string): boolean {
  if (!supplied) return false;
  const actual = Buffer.from(supplied, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

type BrokerRouteKind = "human" | "machine" | "ages-proxy";

function brokerRouteKind(path: string, method: string): BrokerRouteKind {
  const normalized = path.toLowerCase();
  let route: string;
  if (normalized === "/ages" || normalized.startsWith("/ages/")) {
    route = normalized.slice("/ages".length).replace(/^\//, "");
  } else if (normalized === "/foreign/broker" || normalized.startsWith("/foreign/broker/")) {
    route = normalized.slice("/foreign/broker".length).replace(/^\//, "");
  } else {
    return "human";
  }
  // Express accepts one optional trailing slash on registered routes.
  const exactRoute = route.endsWith("/") ? route.slice(0, -1) : route;
  if (!route || isHumanControlRoute(exactRoute, method)) return "human";
  if ((exactRoute === "health" && ["GET", "HEAD"].includes(method)) ||
      exactRoute === "heartbeat" || exactRoute === "heartbeat/beat") return "machine";
  // Everything else reaches the Broker router's AGES proxy handlers.
  return "ages-proxy";
}

export function isMachineRoute(path: string, method = "GET"): boolean {
  return brokerRouteKind(path, method) === "machine";
}

function isHumanControlRoute(route: string, method: string): boolean {
  if (["GET", "HEAD"].includes(method) && [
    "pool", "pool/timings", "pool/timings/show", "pool/show",
    "ages-host/restart-iis", "iis/restart"
  ].includes(route)) return true;
  if (method !== "POST") return false;
  return ["pool/timings/clear", "pool/warmup", "ages-host/restart-iis", "iis/restart"].includes(route) ||
    /^pool\/(?:backends\/[^/]+\/drain-recycle|slots\/[^/]+\/recycle)$/.test(route);
}

function isStateChangingGet(path: string): boolean {
  const normalized = path.toLowerCase().replace(/\/$/, "");
  return ["/foreign/broker/iis/restart", "/foreign/broker/ages-host/restart-iis",
    "/ages/iis/restart", "/ages/ages-host/restart-iis"].includes(normalized);
}

export function createAuthHttp(auth: BrokerAuthService, serviceKey: string, interMsSecret?: string): {
  routes: Router;
  gate: RequestHandler;
} {
  if (Buffer.byteLength(serviceKey, "utf8") < 32) {
    throw new Error("BROKER_SERVICE_API_KEY must contain at least 32 bytes");
  }

  const routes = Router();
  routes.use(json({ limit: "8kb" }), urlencoded({ extended: false, limit: "8kb" }));
  routes.use((req, res, next) => {
    if (auth.expectedOrigin(requestHost(req), req.secure)) return next();
    res.status(403).set("Cache-Control", "no-store").json({ error: "Forbidden" });
  });

  routes.get("/login", (req, res) => {
    const next = safeNext(req.query.next);
    res.set({
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'",
      "X-Content-Type-Options": "nosniff"
    });
    res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Broker login</title><style>body{font:1rem system-ui;max-width:24rem;margin:4rem auto;padding:1rem}label{display:block;margin:1rem 0}input{display:block;width:100%;box-sizing:border-box;padding:.5rem}button{padding:.6rem 1rem}</style></head><body><h1>Broker login</h1><form method="post" action="/auth/login"><input type="hidden" name="next" value="${escapeHtml(next)}"><label>Username<input name="username" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Sign in</button></form></body></html>`);
  });

  routes.post("/login", async (req, res) => {
    const result = await auth.login({
      username: req.body?.username,
      password: req.body?.password,
      clientKey: req.ip || req.socket.remoteAddress || "unknown",
      origin: req.get("origin"),
      host: requestHost(req),
      secure: req.secure
    });
    res.set("Cache-Control", "no-store");
    if (result.retryAfterSeconds) res.set("Retry-After", String(result.retryAfterSeconds));
    if (result.setCookie) res.set("Set-Cookie", result.setCookie);
    if (result.status !== 200) {
      res.status(result.status).json({ error: result.status === 429 ? "Too many login attempts" : "Invalid login" });
      return;
    }
    if (req.is("application/x-www-form-urlencoded")) {
      res.redirect(303, safeNext(req.body?.next));
      return;
    }
    res.json({ username: result.username, csrfToken: result.csrfToken, expiresAt: result.expiresAt });
  });

  routes.get("/session", (req, res) => {
    const result = auth.session(req.headers.cookie);
    res.set("Cache-Control", "no-store");
    if (result.setCookie) res.set("Set-Cookie", result.setCookie);
    res.status(result.status).json(result.status === 200 ?
      { username: result.username, csrfToken: result.csrfToken, expiresAt: result.expiresAt } :
      { error: "Unauthorized" });
  });

  routes.post("/logout", (req, res) => {
    const result = auth.logout({
      cookieHeader: req.headers.cookie,
      origin: req.get("origin"),
      host: requestHost(req),
      secure: req.secure,
      csrfToken: firstHeader(req.headers["x-csrf-token"]) ?? req.body?.csrfToken
    });
    res.set("Cache-Control", "no-store");
    if (result.setCookie) res.set("Set-Cookie", result.setCookie);
    res.status(result.status).json(result.status === 200 ? { status: "ok" } : { error: "Forbidden" });
  });

  const gate = (req: Request, res: Response, next: NextFunction): void => {
    const routeKind = brokerRouteKind(req.path, req.method);
    if (routeKind === "ages-proxy") {
      next();
      return;
    }
    if (routeKind === "machine") {
      const scopedBeat = req.path.toLowerCase() === "/foreign/broker/heartbeat/beat";
      const signedBeat = scopedBeat && req.method === "GET" &&
        verifyMs07BeatBearer(firstHeader(req.headers.authorization), interMsSecret);
      if (!sameKey(firstHeader(req.headers[SERVICE_KEY_HEADER]), serviceKey) && !signedBeat) {
        res.status(401).set("Cache-Control", "no-store").json({ error: "Unauthorized" });
        return;
      }
      next();
      return;
    }
    const expectedOrigin = auth.expectedOrigin(requestHost(req), req.secure);
    if (!expectedOrigin) {
      res.status(403).set("Cache-Control", "no-store").json({ error: "Forbidden" });
      return;
    }
    const result = auth.verify({
      cookieHeader: req.headers.cookie,
      // Legacy GET aliases restart IIS; they must not bypass origin/CSRF checks.
      method: ["GET", "HEAD"].includes(req.method) && isStateChangingGet(req.path) ? "POST" : req.method,
      origin: req.get("origin"),
      host: requestHost(req),
      secure: req.secure,
      csrfToken: firstHeader(req.headers["x-csrf-token"])
    });
    if (result.setCookie) res.set("Set-Cookie", result.setCookie);
    if (result.status !== 204) {
      if (result.status === 401 && ["GET", "HEAD"].includes(req.method) &&
          req.get("accept")?.includes("text/html") &&
          !req.path.startsWith("/auth/")) {
        res.redirect(303, `/auth/login?next=${encodeURIComponent(safeNext(req.originalUrl))}`);
        return;
      }
      res.status(result.status).set("Cache-Control", "no-store")
        .json({ error: result.status === 401 ? "Unauthorized" : "Forbidden" });
      return;
    }
    next();
  };

  return { routes, gate };
}
