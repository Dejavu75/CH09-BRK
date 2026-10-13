const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createServer } = require("node:http");
const { createHmac } = require("node:crypto");
const { after, test } = require("node:test");
const express = require("express");
const bcrypt = require("bcryptjs");

const { BrokerAuthService } = require("../build/auth/auth_service");
const { createAuthHttp, isMachineRoute, requireSecureTransport, SERVICE_KEY_HEADER } = require("../build/auth/http");

const directory = mkdtempSync(join(tmpdir(), "broker-routes-"));
const users = join(directory, "users.htpasswd");
const database = join(directory, "sessions.sqlite");
const origin = "https://broker.synthetic";
const serviceKey = "synthetic-machine-key-with-at-least-32-bytes";
const interMsSecret = "synthetic-inter-ms-secret-with-at-least-32-bytes";
writeFileSync(users, `operator:${bcrypt.hashSync("synthetic-password", 4)}\n`);
const auth = new BrokerAuthService({ publicOrigin: origin, credentialFile: users, databaseFile: database });
const { routes, gate } = createAuthHttp(auth, serviceKey, interMsSecret);
const app = express();
app.set("trust proxy", "loopback");
app.use(requireSecureTransport);
app.use("/auth", routes);
app.use(gate);
app.get("/foreign/broker/pool/show", (_req, res) => res.send("private page"));
app.post("/foreign/broker/pool/timings/clear", (_req, res) => res.json({ status: "cleared" }));
app.all("/ages/autorizar", (_req, res) => res.json({ status: "proxied" }));
for (const path of ["/ages/ages/autorizar", "/ages/~mini~/beat.ages",
  "/foreign/broker/autorizar", "/foreign/broker/ages/autorizar",
  "/foreign/broker/~mini~/beat.ages", "/foreign/broker/other/module/action",
  "/ages/health/status", "/foreign/broker/heartbeat/custom",
  "/ages/pool/custom", "/foreign/broker/iis/custom"]) {
  app.all(path, (_req, res) => res.json({ status: "proxied" }));
}
app.get("/foreign/broker/heartbeat/beat", (_req, res) => res.json({ status: "beat" }));
app.get("/foreign/broker/health", (_req, res) => res.json({ status: "healthy" }));
app.get("/ages/health", (_req, res) => res.json({ status: "healthy" }));
app.get("/ages/heartbeat/beat", (_req, res) => res.json({ status: "beat" }));
app.post("/ages/health", (_req, res) => res.json({ status: "proxied" }));
app.post("/ages/pool/show", (_req, res) => res.json({ status: "proxied" }));
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
  return fetch(base + path, {
    redirect: "manual", ...init,
    headers: { "X-Forwarded-Proto": "https", ...init.headers }
  });
}

test("classifies Broker controls, not AGES proxy paths, as machine routes", () => {
  for (const path of ["/foreign/broker/heartbeat/beat", "/foreign/broker/health", "/ages/health",
    "/ages/heartbeat/beat", "/FOREIGN/BROKER/HEARTBEAT/BEAT", "/AGES/HEALTH",
    "/foreign/broker/health/", "/ages/heartbeat/"]) {
    assert.equal(isMachineRoute(path), true, path);
  }
  for (const path of ["/foreign/broker/pool/show", "/foreign/broker/pool/timings/clear",
    "/foreign/broker/iis/restart", "/foreign/broker/ages-host/restart-iis", "/foreign/broker", "/",
    "/ages/pool/show", "/ages/iis/restart", "/ages/", "/ages/autorizar",
    "/foreign/broker/ages/autorizar", "/foreign/broker/ologin.autorizar.ages", "/AGES/autorizar",
    "/ages/health/status", "/foreign/broker/heartbeat/custom", "/ages/pool/custom",
    "/foreign/broker/iis/custom"]) {
    assert.equal(isMachineRoute(path), false, path);
  }
  assert.equal(isMachineRoute("/ages/health", "POST"), false);
});

test("passes AGES proxy routes on both mounts without Broker credentials", async () => {
  for (const path of ["/ages/autorizar", "/ages/ages/autorizar", "/ages/~mini~/beat.ages",
    "/foreign/broker/autorizar", "/foreign/broker/ages/autorizar",
    "/foreign/broker/~mini~/beat.ages", "/foreign/broker/other/module/action",
    "/ages/health/status", "/foreign/broker/heartbeat/custom",
    "/ages/pool/custom", "/foreign/broker/iis/custom"]) {
    assert.equal((await request(path)).status, 200, path);
    assert.equal((await request(path, { method: "POST", headers: { [SERVICE_KEY_HEADER]: "wrong" } })).status, 200, path);
  }
  assert.equal((await request("/ages/health", { method: "POST" })).status, 200);
  assert.equal((await request("/ages/pool/show", { method: "POST" })).status, 200);
});

test("denies Broker machine controls without separate credential and denies session as substitute", async () => {
  assert.equal((await request("/foreign/broker/heartbeat/beat")).status, 401);
  assert.equal((await request("/foreign/broker/health")).status, 401);
  assert.equal((await request("/ages/health")).status, 401);
  assert.equal((await request("/ages/heartbeat/beat")).status, 401);
  assert.equal((await request("/ages/health/")).status, 401);
  assert.equal((await request("/ages/heartbeat/beat/")).status, 401);
  assert.equal((await request("/ages/pool/show/")).status, 401);
  assert.equal((await request("/ages/iis/restart/")).status, 401);
  for (const path of ["/foreign/broker/heartbeat/beat", "/foreign/broker/health",
    "/ages/health", "/ages/heartbeat/beat"]) {
    assert.equal((await request(path, { headers: { [SERVICE_KEY_HEADER]: serviceKey } })).status, 200, path);
  }
  assert.equal((await request("/foreign/broker/pool/show", { headers: { [SERVICE_KEY_HEADER]: serviceKey } })).status, 401);
  assert.equal((await request("/ages/pool/show", { headers: { [SERVICE_KEY_HEADER]: serviceKey } })).status, 401);
  assert.equal((await request("/ages/iis/restart", { headers: { [SERVICE_KEY_HEADER]: serviceKey } })).status, 401);
});

// Mirrors the se_configbase HS256 signer fields and base64url wire format.
function signedBeat(overrides = {}, signingSecret = interMsSecret) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: "solinges-ecosystem", sub: "MS07/UNICA", aud: "broker",
    scope: ["broker:beat", "ms:call"], mscode: "MS07", instance: "UNICA",
    serviceType: "monitor", url: "https://ms07.synthetic", iat: now, exp: now + 300,
    ...overrides
  };
  const unsigned = [JSON.stringify({ alg: "HS256", typ: "JWT" }), JSON.stringify(payload)]
    .map(value => Buffer.from(value).toString("base64url")).join(".");
  const signature = createHmac("sha256", signingSecret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

test("accepts only signed, scoped MS07 beats on the exact route", async () => {
  const beat = "/foreign/broker/heartbeat/beat";
  const bearer = token => ({ Authorization: `Bearer ${token}` });
  assert.equal((await request(beat, { headers: bearer(signedBeat()) })).status, 200);
  assert.equal((await request(beat, { method: "POST", headers: bearer(signedBeat()) })).status, 401);
  assert.equal((await request(beat, { headers: bearer(signedBeat({ aud: "solinges-ecosystem" })) })).status, 401);
  assert.equal((await request(beat, { headers: bearer(signedBeat({ scope: ["ms:call"] })) })).status, 401);
  assert.equal((await request(beat, { headers: bearer(signedBeat({ iss: "other" })) })).status, 401);
  assert.equal((await request(beat, { headers: bearer(signedBeat({ mscode: "MS08" })) })).status, 401);
  assert.equal((await request(beat, { headers: bearer(signedBeat({ sub: "MS08/UNICA" })) })).status, 401);
  assert.equal((await request(beat, { headers: bearer(signedBeat({ exp: 1 })) })).status, 401);
  assert.equal((await request(beat, { headers: bearer(signedBeat({ iat: Math.floor(Date.now() / 1000) + 120 })) })).status, 401);
  assert.equal((await request(beat, { headers: bearer(signedBeat({}, "different-signing-secret-with-at-least-32-bytes")) })).status, 401);
  const tampered = signedBeat().split(".");
  tampered[1] = Buffer.from(JSON.stringify({ aud: "broker", mscode: "MS07" })).toString("base64url");
  assert.equal((await request(beat, { headers: bearer(tampered.join(".")) })).status, 401);
  assert.equal((await request("/foreign/broker/heartbeat", { headers: bearer(signedBeat()) })).status, 401);
  assert.equal((await request("/foreign/broker/health", { headers: bearer(signedBeat()) })).status, 401);
  assert.equal((await request("/ages/health", { headers: bearer(signedBeat()) })).status, 401);
  assert.equal((await request("/ages/heartbeat/beat", { headers: bearer(signedBeat()) })).status, 401);
  assert.equal((await request(beat, { headers: { "X-Inter-MS-Token": signedBeat() } })).status, 401);
  assert.equal((await request(beat, { headers: { "X-AGES-API-Key": `interms:${signedBeat()}` } })).status, 401);
});

test("missing or weak inter-MS secret does not enable unsigned beat", async () => {
  const { verifyMs07BeatBearer } = require("../build/auth/interms");
  assert.equal(verifyMs07BeatBearer(`Bearer ${signedBeat()}`, undefined), false);
  assert.equal(verifyMs07BeatBearer(`Bearer ${signedBeat()}`, "weak"), false);
  assert.equal(verifyMs07BeatBearer(undefined, interMsSecret), false);
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
  assert.equal((await request("/ages/autorizar", { headers: { Cookie: cookie } })).status, 200);
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
  assert.equal((await request("/ages/iis/restart/", { headers: { Cookie: cookie } })).status, 403);
  assert.equal((await request("/ages/iis/restart/", { method: "HEAD", headers: { Cookie: cookie } })).status, 403);
  assert.equal((await request("/ages/iis/restart/", {
    headers: { Cookie: cookie, Origin: origin, "X-CSRF-Token": session.csrfToken }
  })).status, 200);
  assert.equal((await request("/auth/logout", {
    method: "POST", headers: { Cookie: cookie, Origin: origin, "X-CSRF-Token": session.csrfToken }
  })).status, 200);
  assert.equal((await request("/foreign/broker/pool/show", { headers: { Cookie: cookie } })).status, 401);
});

test("HTTP denies AGES passthrough as well as Broker controls", async () => {
  for (const path of ["/ages/autorizar", "/foreign/broker/ages/autorizar",
    "/foreign/broker/heartbeat/beat", "/ages/pool/show"]) {
    assert.equal((await request(path, { headers: { "X-Forwarded-Proto": "http" } })).status, 403, path);
  }
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
