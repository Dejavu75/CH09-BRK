const assert = require("node:assert/strict");
const { test } = require("node:test");
const express = require("express");
const { requireSecureTransport } = require("../build/auth/http");
const { trustedProxyAddresses } = require("../build/auth/trusted_proxy");

async function withServer(trustedProxies, callback) {
  const app = express();
  app.set("trust proxy", trustedProxyAddresses(trustedProxies));
  let processed = 0;
  app.get("/.well-known/acme-challenge/synthetic", (_req, res) => res.send("challenge"));
  app.use(requireSecureTransport);
  app.use((_req, res) => { processed++; res.send("protected"); });
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise(resolve => server.once("listening", resolve));
    await callback(`http://127.0.0.1:${server.address().port}`, () => processed);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("direct HTTP rejects login, session and machine requests before processing, without redirect", async () => {
  await withServer(undefined, async (base, processed) => {
    for (const [path, init] of [
      ["/auth/login", { method: "POST", headers: { Origin: "https://broker.synthetic", "Content-Type": "application/json" }, body: JSON.stringify({ username: "synthetic", password: "synthetic" }) }],
      ["/auth/session", { headers: { Cookie: "__Host-broker_session=synthetic" } }],
      ["/ages/operation", { headers: { "X-Broker-Service-Api-Key": "synthetic-secret" } }],
      ["/foreign/broker/pool/show", { headers: { Accept: "text/html" } }]
    ]) {
      const response = await fetch(base + path, { redirect: "manual", ...init });
      assert.equal(response.status, 403, path);
      assert.equal(response.headers.get("location"), null, path);
      assert.equal(response.headers.get("cache-control"), "no-store", path);
    }
    assert.equal(processed(), 0);
    assert.equal((await fetch(base + "/.well-known/acme-challenge/synthetic")).status, 200);
  });
});

test("forwarded HTTPS is accepted only from an explicitly trusted proxy", async () => {
  await withServer(undefined, async (base, processed) => {
    const response = await fetch(base + "/auth/login", { headers: { "X-Forwarded-Proto": "https" }, redirect: "manual" });
    assert.equal(response.status, 403);
    assert.equal(processed(), 0);
  });
  await withServer("127.0.0.1", async (base, processed) => {
    const accepted = await fetch(base + "/auth/login", { headers: { "X-Forwarded-Proto": "https" } });
    assert.equal(accepted.status, 200);
    assert.equal(processed(), 1);
    const rejected = await fetch(base + "/ages/operation", { headers: { "X-Forwarded-Proto": "http" } });
    assert.equal(rejected.status, 403);
    assert.equal(processed(), 1);
  });
});
