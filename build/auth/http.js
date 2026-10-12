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
exports.requireSecureTransport = exports.SERVICE_KEY_HEADER = void 0;
exports.isMachineRoute = isMachineRoute;
exports.createAuthHttp = createAuthHttp;
const node_crypto_1 = require("node:crypto");
const express_1 = require("express");
exports.SERVICE_KEY_HEADER = "x-broker-service-api-key";
const requireSecureTransport = (req, res, next) => {
    if (req.secure) {
        next();
        return;
    }
    // Do not redirect: a redirect could forward credentials or service keys.
    res.status(403).set("Cache-Control", "no-store").json({ error: "HTTPS required" });
};
exports.requireSecureTransport = requireSecureTransport;
function safeNext(value) {
    return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") &&
        !/[\\\r\n]/.test(value) ? value : "/foreign/broker/pool/show";
}
function escapeHtml(value) {
    return value.replace(/[&<>"']/g, character => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character] || character);
}
function firstHeader(value) {
    return Array.isArray(value) ? undefined : value;
}
function sameKey(supplied, expected) {
    if (!supplied)
        return false;
    const actual = Buffer.from(supplied, "utf8");
    const wanted = Buffer.from(expected, "utf8");
    return actual.length === wanted.length && (0, node_crypto_1.timingSafeEqual)(actual, wanted);
}
function isMachineRoute(path) {
    const normalized = path.toLowerCase();
    let route;
    if (normalized === "/ages" || normalized.startsWith("/ages/")) {
        route = normalized.slice("/ages".length).replace(/^\//, "");
    }
    else if (normalized === "/foreign/broker" || normalized.startsWith("/foreign/broker/")) {
        route = normalized.slice("/foreign/broker".length).replace(/^\//, "");
    }
    else {
        return false;
    }
    if (!route)
        return false;
    if (isHumanControlRoute(route))
        return false;
    if (route === "health" || route === "heartbeat" || route.startsWith("heartbeat/"))
        return true;
    // The Broker router's final catch-all routes proxy arbitrary AGES functions.
    return true;
}
function isHumanControlRoute(route) {
    return route === "pool" || route.startsWith("pool/") || route === "ages-host" ||
        route.startsWith("ages-host/") || route === "iis" || route.startsWith("iis/");
}
function isStateChangingGet(path) {
    const normalized = path.toLowerCase();
    return ["/foreign/broker/iis/restart", "/foreign/broker/ages-host/restart-iis",
        "/ages/iis/restart", "/ages/ages-host/restart-iis"].includes(normalized);
}
function createAuthHttp(auth, serviceKey) {
    if (Buffer.byteLength(serviceKey, "utf8") < 32) {
        throw new Error("BROKER_SERVICE_API_KEY must contain at least 32 bytes");
    }
    const routes = (0, express_1.Router)();
    routes.use((0, express_1.json)({ limit: "8kb" }), (0, express_1.urlencoded)({ extended: false, limit: "8kb" }));
    routes.get("/login", (req, res) => {
        const next = safeNext(req.query.next);
        res.set({
            "Cache-Control": "no-store",
            "Content-Security-Policy": "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'",
            "X-Content-Type-Options": "nosniff"
        });
        res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Broker login</title><style>body{font:1rem system-ui;max-width:24rem;margin:4rem auto;padding:1rem}label{display:block;margin:1rem 0}input{display:block;width:100%;box-sizing:border-box;padding:.5rem}button{padding:.6rem 1rem}</style></head><body><h1>Broker login</h1><form method="post" action="/auth/login"><input type="hidden" name="next" value="${escapeHtml(next)}"><label>Username<input name="username" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Sign in</button></form></body></html>`);
    });
    routes.post("/login", (req, res) => __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c;
        const result = yield auth.login({
            username: (_a = req.body) === null || _a === void 0 ? void 0 : _a.username,
            password: (_b = req.body) === null || _b === void 0 ? void 0 : _b.password,
            clientKey: req.ip || req.socket.remoteAddress || "unknown",
            origin: req.get("origin")
        });
        res.set("Cache-Control", "no-store");
        if (result.retryAfterSeconds)
            res.set("Retry-After", String(result.retryAfterSeconds));
        if (result.setCookie)
            res.set("Set-Cookie", result.setCookie);
        if (result.status !== 200) {
            res.status(result.status).json({ error: result.status === 429 ? "Too many login attempts" : "Invalid login" });
            return;
        }
        if (req.is("application/x-www-form-urlencoded")) {
            res.redirect(303, safeNext((_c = req.body) === null || _c === void 0 ? void 0 : _c.next));
            return;
        }
        res.json({ username: result.username, csrfToken: result.csrfToken, expiresAt: result.expiresAt });
    }));
    routes.get("/session", (req, res) => {
        const result = auth.session(req.headers.cookie);
        res.set("Cache-Control", "no-store");
        if (result.setCookie)
            res.set("Set-Cookie", result.setCookie);
        res.status(result.status).json(result.status === 200 ?
            { username: result.username, csrfToken: result.csrfToken, expiresAt: result.expiresAt } :
            { error: "Unauthorized" });
    });
    routes.post("/logout", (req, res) => {
        var _a, _b;
        const result = auth.logout({
            cookieHeader: req.headers.cookie,
            origin: req.get("origin"),
            csrfToken: (_a = firstHeader(req.headers["x-csrf-token"])) !== null && _a !== void 0 ? _a : (_b = req.body) === null || _b === void 0 ? void 0 : _b.csrfToken
        });
        res.set("Cache-Control", "no-store");
        if (result.setCookie)
            res.set("Set-Cookie", result.setCookie);
        res.status(result.status).json(result.status === 200 ? { status: "ok" } : { error: "Forbidden" });
    });
    const gate = (req, res, next) => {
        var _a;
        if (isMachineRoute(req.path)) {
            if (!sameKey(firstHeader(req.headers[exports.SERVICE_KEY_HEADER]), serviceKey)) {
                res.status(401).set("Cache-Control", "no-store").json({ error: "Unauthorized" });
                return;
            }
            next();
            return;
        }
        const result = auth.verify({
            cookieHeader: req.headers.cookie,
            // Legacy GET aliases restart IIS; they must not bypass origin/CSRF checks.
            method: ["GET", "HEAD"].includes(req.method) && isStateChangingGet(req.path) ? "POST" : req.method,
            origin: req.get("origin"),
            csrfToken: firstHeader(req.headers["x-csrf-token"])
        });
        if (result.setCookie)
            res.set("Set-Cookie", result.setCookie);
        if (result.status !== 204) {
            if (result.status === 401 && ["GET", "HEAD"].includes(req.method) &&
                ((_a = req.get("accept")) === null || _a === void 0 ? void 0 : _a.includes("text/html")) &&
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
