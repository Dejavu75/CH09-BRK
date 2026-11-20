const assert = require("node:assert/strict");
const http = require("node:http");
const { test } = require("node:test");

async function mockAges(context, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  context.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return "http://127.0.0.1:" + server.address().port + "/ages";
}

const env = {
  BROKER_MS07_RELAY_ENABLED: "true", BROKER_MS07_RELAY_URL: "https://ms07.example.test/healthmonitor/heartbeat/broker-relay",
  BROKER_MS07_RELAY_KEY: "a".repeat(43), MSCODE: "CH09-BRK", MSINSTANCE: "SITE",
  BROKER_MS07_RELAY_TIMEOUT_MS: "3000"
};

test("relay requires explicit opt-in, HTTPS and complete configuration", () => {
  const { readMs07RelayConfig } = require("../build/services/ms07_relay");
  assert.equal(readMs07RelayConfig({}), undefined);
  assert.equal(readMs07RelayConfig({ ...env, BROKER_MS07_RELAY_ENABLED: "false" }), undefined);
  assert.throws(() => readMs07RelayConfig({ ...env, BROKER_MS07_RELAY_URL: "http://ms07.example.test" }));
  assert.throws(() => readMs07RelayConfig({ ...env, BROKER_MS07_RELAY_KEY: "" }));
});

test("relay reports a live broker and the real private AGES response independently", async t => {
  const { readMs07RelayConfig, relayMs07Beat } = require("../build/services/ms07_relay");
  const ages = await mockAges(t, (req, res) => {
    assert.equal(req.url, "/ages/~mini~/beat.ages");
    assert.equal(req.headers["x-ages-api-key"], "private-ages-key");
    assert.equal(req.headers.authorization, undefined);
    res.end(JSON.stringify({ Version_AGES_MINI: "1.2.3", secret: "must-not-leave" }));
  });
  const send = async (url, request) => {
    assert.equal(url, env.BROKER_MS07_RELAY_URL);
    assert.equal(request.redirect, "error");
    assert.equal(request.headers.Authorization, "Bearer " + env.BROKER_MS07_RELAY_KEY);
    assert.deepEqual(JSON.parse(request.body), {
      broker: { mscode: "CH09-BRK", instance: "SITE", status: "OK" },
      ages: { status: "OK", miniVersion: "1.2.3" }
    });
    return new Response(null, { status: 204 });
  };
  await relayMs07Beat(readMs07RelayConfig(env), [ages], "private-ages-key", send);
});

test("a private AGES error, malformed response or timeout never masks broker liveness", async t => {
  const { readMs07RelayConfig, relayMs07Beat } = require("../build/services/ms07_relay");
  const unavailable = await mockAges(t, (_req, res) => res.writeHead(503).end());
  const malformed = await mockAges(t, (_req, res) => res.end("<html>not a beat</html>"));
  const stalled = await mockAges(t, () => {});
  let calls = 0;
  await relayMs07Beat(readMs07RelayConfig({ ...env, BROKER_MS07_RELAY_TIMEOUT_MS: "200" }), [unavailable, malformed, stalled], undefined, async (_url, request) => {
    calls++;
    const body = JSON.parse(request.body);
    assert.equal(body.broker.status, "OK");
    assert.deepEqual(body.ages, { status: "down" });
    return new Response(null, { status: 204 });
  });
  assert.equal(calls, 1);
});
