const assert = require("node:assert/strict");
const { X509Certificate } = require("node:crypto");
const { readFileSync, mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createServer, request: httpRequest } = require("node:http");
const { test } = require("node:test");
const express = require("express");
const bcrypt = require("bcryptjs");

const { certifiedHttpsOrigin } = require("../build/auth/origin");
const { BrokerAuthService } = require("../build/auth/auth_service");
const { createAuthHttp } = require("../build/auth/http");

const certificatePem = readFileSync(join(__dirname, "fixtures", "broker-origin-cert.pem"));
const certificate = new X509Certificate(certificatePem);
const serviceKey = "synthetic-machine-key-with-at-least-32-bytes";

test("certificate constrains raw Host, including wildcard and public port", () => {
  assert.equal(certifiedHttpsOrigin("broker.synthetic", certificate), "https://broker.synthetic");
  assert.equal(certifiedHttpsOrigin("BROKER.SYNTHETIC:8443", certificate), "https://broker.synthetic:8443");
  assert.equal(certifiedHttpsOrigin("broker.synthetic:443", certificate), "https://broker.synthetic");
  assert.equal(certifiedHttpsOrigin("one.tenant.synthetic:9443", certificate), "https://one.tenant.synthetic:9443");
  const cnOnly = new X509Certificate(readFileSync(join(__dirname, "fixtures", "broker-cn-only-cert.pem")));
  assert.equal(certifiedHttpsOrigin("broker.synthetic", cnOnly), undefined);
  for (const host of ["other.synthetic", "tenant.synthetic", "a.b.tenant.synthetic", "broker.synthetic.evil.test",
    "broker.synthetic:0", "broker.synthetic:65536", "broker.synthetic:44x", "broker.synthetic,evil.test",
    "user@broker.synthetic", "broker.synthetic/evil", "broker..synthetic", "broker.synthetic."]) {
    assert.equal(certifiedHttpsOrigin(host, certificate), undefined, host);
  }
});

async function withApp(options, run) {
  const dir = mkdtempSync(join(tmpdir(), "broker-origin-"));
  const credentials = join(dir, "users.htpasswd");
  writeFileSync(credentials, `operator:${bcrypt.hashSync("synthetic-password", 4)}\n`);
  const auth = new BrokerAuthService({ credentialFile: credentials, databaseFile: join(dir, "sessions.sqlite"),
    certificatePem: options.certificatePem, publicOrigin: options.publicOrigin });
  const app = express();
  if (options.trustProxy) app.set("trust proxy", ["127.0.0.1"]);
  const { routes, gate } = createAuthHttp(auth, serviceKey);
  app.use("/auth", routes);
  app.use(gate);
  app.get("/private", (_req, res) => res.send("private"));
  app.post("/private", (_req, res) => res.send("updated"));
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, headers, init = {}) => new Promise((resolve, reject) => {
    const outgoing = httpRequest(base + route, { method: init.method ?? "GET", headers }, incoming => {
      const chunks = [];
      incoming.on("data", chunk => chunks.push(chunk));
      incoming.on("end", () => resolve({ status: incoming.statusCode,
        headers: { get: name => {
          const value = incoming.headers[name.toLowerCase()];
          return Array.isArray(value) ? value[0] : value ?? null;
        } },
        json: async () => JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    outgoing.on("error", reject);
    outgoing.end(init.body);
  });
  try { await run(request); }
  finally {
    await new Promise(resolve => server.close(resolve));
    auth.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function loginHeaders(host, origin, extra = {}) {
  return { Host: host, Origin: origin, "X-Forwarded-Proto": "https", "Content-Type": "application/json", ...extra };
}
const loginBody = JSON.stringify({ username: "operator", password: "synthetic-password" });

test("trusted TLS proxy permits certified Host and exact Origin, not forwarded Host", async () => {
  await withApp({ certificatePem, trustProxy: true }, async request => {
    const valid = await request("/auth/login", loginHeaders("broker.synthetic:8443", "https://broker.synthetic:8443",
      { "X-Forwarded-Host": "evil.synthetic:8443" }), { method: "POST", body: loginBody });
    assert.equal(valid.status, 200);
    const cookie = valid.headers.get("set-cookie").split(";")[0];
    const session = await request("/auth/session", { Host: "broker.synthetic:8443", Cookie: cookie,
      "X-Forwarded-Proto": "https" });
    assert.equal(session.status, 200);
    const csrf = (await session.json()).csrfToken;
    assert.equal((await request("/private", { Host: "broker.synthetic:8443", Cookie: cookie,
      "X-Forwarded-Proto": "https" })).status, 200);
    assert.equal((await request("/private", { Host: "broker.synthetic:8443", Cookie: cookie,
      "X-Forwarded-Proto": "https", Origin: "https://broker.synthetic:8443", "X-CSRF-Token": csrf },
    { method: "POST" })).status, 200);
    assert.equal((await request("/private", { Host: "broker.synthetic:8443", Cookie: cookie,
      "X-Forwarded-Proto": "https", Origin: "https://broker.synthetic", "X-CSRF-Token": csrf },
    { method: "POST" })).status, 403);
    assert.equal((await request("/private", { Host: "other.synthetic", Cookie: cookie,
      "X-Forwarded-Proto": "https" })).status, 403);
    assert.equal((await request("/auth/logout", { Host: "broker.synthetic:8443", Cookie: cookie,
      "X-Forwarded-Proto": "https", Origin: "https://broker.synthetic", "X-CSRF-Token": csrf },
    { method: "POST" })).status, 403);
    for (const [host, origin] of [
      ["other.synthetic", "https://other.synthetic"],
      ["broker.synthetic:8443", "https://other.synthetic"],
      ["broker.synthetic:8443", "https://broker.synthetic"]
    ]) {
      assert.equal((await request("/auth/login", loginHeaders(host, origin),
        { method: "POST", body: loginBody })).status, 403);
    }
    assert.equal((await request("/auth/login", loginHeaders("other.synthetic", "https://broker.synthetic:8443",
      { "X-Forwarded-Host": "broker.synthetic:8443" }), { method: "POST", body: loginBody })).status, 403);
  });
});

test("untrusted forwarding and missing certificate fail closed; explicit origin remains supported", async () => {
  await withApp({ certificatePem, trustProxy: false }, async request => {
    assert.equal((await request("/auth/login", loginHeaders("broker.synthetic", "https://broker.synthetic"),
      { method: "POST", body: loginBody })).status, 403);
  });
  await withApp({ trustProxy: true }, async request => {
    assert.equal((await request("/auth/login", loginHeaders("broker.synthetic", "https://broker.synthetic"),
      { method: "POST", body: loginBody })).status, 403);
  });
  await withApp({ publicOrigin: "https://configured.synthetic:7443", trustProxy: true }, async request => {
    assert.equal((await request("/auth/login", loginHeaders("unrelated.synthetic", "https://configured.synthetic:7443"),
      { method: "POST", body: loginBody })).status, 200);
  });
});
