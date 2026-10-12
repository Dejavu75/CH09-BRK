const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createServer } = require("node:http");
const { after, test } = require("node:test");
const express = require("express");
const bcrypt = require("bcryptjs");

const { BrokerAuthService } = require("../build/auth/auth_service");
const { createAuthHttp, isMachineRoute, SERVICE_KEY_HEADER } = require("../build/auth/http");

const directory = mkdtempSync(join(tmpdir(), "broker-routes-"));
const users = join(directory, "users.htpasswd");
const database = join(directory, "sessions.sqlite");
const origin = "https://broker.synthetic";
const serviceKey = "synthetic-machine-key-with-at-least-32-bytes";
writeFileSync(users, `operator:${bcrypt.hashSync("synthetic-password", 4)}\n`);
const auth = new BrokerAuthService({ publicOrigin: origin, credentialFile: users, databaseFile: database });
const { routes, gate } = createAuthHttp(auth, serviceKey);
const app = express();
app.use("/auth", routes);
app.use(gate);
app.get("/foreign/broker/pool/show", (_req, res) => res.send("private page"));
app.post("/foreign/broker/pool/timings/clear", (_req, res) => res.json({ status: "cleared" }));
app.all("/ages/autorizar", (_req, res) => res.json({ status: "proxied" }));
app.get("/foreign/broker/heartbeat/beat", (_req, res) => res.json({ status: "beat" }));
app.get("/foreign/broker/health", (_req, res) => res.json({ status: "healthy" }));
app.get("/foreign/broker/iis/restart", (_req, res) => res.json({ status: "restarted" }));
app.get("/ages/pool/show", (_req, res) => res.send("private alias"));
app.get("/ages/iis/restart", (_req, res) => res.json({ status: "restarted" }));
const server = createServer(app);

after(async () => {
  await new Promise(resolve => server.close(resolve));
  auth.close();
  rmSync(directory, { recursive: true, force: true });
});

let base;
async function request(path, init = {}) {
  if (!base) {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  return fetch(base + path, { redirect: "manual", ...init });
}

test("classifies machine aliases but not human administration", () => {
  for (const path of ["/ages/autorizar", "/foreign/broker/ages/autorizar", "/foreign/broker/heartbeat/beat",
    "/foreign/broker/health", "/foreign/broker/ologin.autorizar.ages", "/AGES/autorizar",
    "/FOREIGN/BROKER/HEARTBEAT/BEAT"]) {
    assert.equal(isMachineRoute(path), true, path);
  }
  for (const path of ["/foreign/broker/pool/show", "/foreign/broker/pool/timings/clear",
    "/foreign/broker/iis/restart", "/foreign/broker/ages-host/restart-iis", "/foreign/broker", "/",
    "/ages/pool/show", "/ages/iis/restart", "/ages/"]) {
    assert.equal(isMachineRoute(path), false, path);
  }
});

test("denies machine calls without separate credential and denies session as substitute", async () => {
  assert.equal((await request("/ages/autorizar")).status, 401);
  assert.equal((await request("/foreign/broker/heartbeat/beat")).status, 401);
  assert.equal((await request("/foreign/broker/health")).status, 401);
  assert.equal((await request("/ages/autorizar", { headers: { [SERVICE_KEY_HEADER]: "wrong" } })).status, 401);
  for (const path of ["/ages/autorizar", "/foreign/broker/heartbeat/beat", "/foreign/broker/health"]) {
    assert.equal((await request(path, { headers: { [SERVICE_KEY_HEADER]: serviceKey } })).status, 200, path);
  }
  assert.equal((await request("/foreign/broker/pool/show", { headers: { [SERVICE_KEY_HEADER]: serviceKey } })).status, 401);
  assert.equal((await request("/ages/pool/show", { headers: { [SERVICE_KEY_HEADER]: serviceKey } })).status, 401);
  assert.equal((await request("/ages/iis/restart", { headers: { [SERVICE_KEY_HEADER]: serviceKey } })).status, 401);
});

test("login session protects pages and CSRF protects mutation and logout", async () => {
  const redirect = await request("/foreign/broker/pool/show", { headers: { Accept: "text/html" } });
  assert.equal(redirect.status, 303);
  assert.match(redirect.headers.get("location"), /^\/auth\/login\?next=/);
  const loginPage = await request(redirect.headers.get("location"));
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /name="password"/);
  assert.equal(loginPage.headers.get("cache-control"), "no-store");

  const invalid = await request("/auth/login", {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "operator", password: "wrong" })
  });
  assert.equal(invalid.status, 401);
  const login = await request("/auth/login", {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "operator", password: "synthetic-password" })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.match(cookie, /^__Host-broker_session=/);
  const session = await (await request("/auth/session", { headers: { Cookie: cookie } })).json();
  assert.equal(session.username, "operator");
  assert.equal((await request("/foreign/broker/pool/show", { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await request("/ages/pool/show", { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await request("/ages/autorizar", { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await request("/foreign/broker/pool/timings/clear", {
    method: "POST", headers: { Cookie: cookie, Origin: origin }
  })).status, 403);
  assert.equal((await request("/foreign/broker/pool/timings/clear", {
    method: "POST", headers: { Cookie: cookie, Origin: "https://other.synthetic", "X-CSRF-Token": session.csrfToken }
  })).status, 403);
  assert.equal((await request("/foreign/broker/pool/timings/clear", {
    method: "POST", headers: { Cookie: cookie, Origin: origin, "X-CSRF-Token": session.csrfToken }
  })).status, 200);
  assert.equal((await request("/foreign/broker/iis/restart", { headers: { Cookie: cookie } })).status, 403);
  assert.equal((await request("/foreign/broker/iis/restart", {
    headers: { Cookie: cookie, Origin: origin, "X-CSRF-Token": session.csrfToken }
  })).status, 200);
  assert.equal((await request("/ages/iis/restart", { headers: { Cookie: cookie } })).status, 403);
  assert.equal((await request("/auth/logout", {
    method: "POST", headers: { Cookie: cookie, Origin: origin, "X-CSRF-Token": session.csrfToken }
  })).status, 200);
  assert.equal((await request("/foreign/broker/pool/show", { headers: { Cookie: cookie } })).status, 401);
});

test("login rejects cross-origin attempts and open redirects", async () => {
  const denied = await request("/auth/login", {
    method: "POST", headers: { Origin: "https://evil.synthetic", "Content-Type": "application/json" },
    body: JSON.stringify({ username: "operator", password: "synthetic-password" })
  });
  assert.equal(denied.status, 403);
  const form = await request("/auth/login", {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "operator", password: "synthetic-password", next: "//evil.synthetic" })
  });
  assert.equal(form.status, 303);
  assert.equal(form.headers.get("location"), "/foreign/broker/pool/show");
});
