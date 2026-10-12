const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

// Load production wiring without binding production ports, warming the pool,
// reading credentials, or registering this test instance with the registry.
function loadSource(relativePath, dependencies) {
  const filename = path.join(__dirname, "..", "src", relativePath);
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, Buffer, URL, process: { env: {
      BROKER_PUBLIC_ORIGIN: "https://broker.synthetic",
      BROKER_AUTH_HTPASSWD_PATH: "/synthetic/users",
      BROKER_AUTH_DB_PATH: "/synthetic/sessions",
      BROKER_SERVICE_API_KEY: "synthetic-service-key-with-32-bytes"
    } },
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      if (name.startsWith(".") || name === "se_configbase") {
        throw new Error(`Unexpected production dependency: ${name}`);
      }
      return require(name);
    }
  }, { filename });
  return exports;
}

function createProxy(upstreamUrl, options = {}) {
  const pool = {
    async proxyCall(_kind, _name, _query, init) {
      if (options.proxyError) throw options.proxyError;
      assert.equal(init.headers["content-length"], undefined, "fetch must calculate body length");
      assert.equal(init.headers["transfer-encoding"], undefined, "incoming framing must not be forwarded");
      const response = await fetch(upstreamUrl, { ...init, signal: AbortSignal.timeout(2000) });
      return {
        status: response.status, body: Buffer.from(await response.arrayBuffer()),
        headers: {}, traceHeaders: {}, slotId: 1, slotKind: "bigb", backendId: "test"
      };
    },
    completeTraceResponse() {}
  };
  const dependencies = {
    "se_configbase": {
      DoormanController: { getInstance: () => ({ getSession(_req, _res, next) { next(); } }) },
      getFullCors: () => (_req, _res, next) => next(),
      getServingConfig: () => ({ port: 0 })
    },
    "../services/ages_pool": { agesConnectionPool: pool },
    "../services/heartbeat_metadata": { configureHeartbeatExtraData() {} },
    "../utils/logger": { warn: options.onWarn ?? (() => {}) },
    "../generated/build_info": { BROKER_BUILD_INFO: {} },
    "../auth/http": { SERVICE_KEY_HEADER: "x-broker-service-api-key" },
    "../auth/session_store": { SESSION_COOKIE: "__Host-broker_session" }
  };
  const router = loadSource("routes/rou_broker.ts", dependencies);
  let app;
  loadSource("app.ts", {
    ...dependencies,
    "./routes/rou_broker": router,
    "./services/ages_pool": { agesConnectionPool: pool },
    "./services/heartbeat_metadata": dependencies["../services/heartbeat_metadata"],
    "./auth/auth_service": { BrokerAuthService: class {} },
    "./auth/http": { createAuthHttp() { return { routes: require("express").Router(), gate(_req, _res, next) { next(); } }; },
      requireSecureTransport(_req, _res, next) { next(); } },
    "./auth/trusted_proxy": { trustedProxyAddresses: () => false },
    "./utils/logger": { log() {}, error() {}, isConfigEnabled: () => true },
    http: { createServer(value) { app = value; return { listen() {} }; } }
  });
  return http.createServer(app);
}

async function listen(server, t) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

function request(url, method, headers, body, noFraming = false) {
  if (noFraming) {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const socket = require("node:net").connect(Number(target.port), target.hostname, () => {
        const lines = [`${method} ${target.pathname} HTTP/1.1`, `Host: ${target.host}`, "Connection: close"];
        for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
        socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      });
      let response = "";
      socket.setEncoding("utf8");
      socket.setTimeout(3000, () => socket.destroy(new Error("Proxy request timed out")));
      socket.on("data", chunk => { response += chunk; });
      socket.on("error", reject);
      socket.on("end", () => resolve({ status: Number(response.split(" ")[1]), body: Buffer.from(response.split("\r\n\r\n")[1] ?? "") }));
    });
  }
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("Proxy request timed out")));
    req.end(body);
  });
}

const cases = [
  { name: "empty POST without Content-Type", headers: { "Content-Length": "0" } },
  { name: "empty JSON POST", headers: { "Content-Length": "0", "Content-Type": "application/json" } },
  { name: "chunked empty POST", headers: { "Transfer-Encoding": "chunked" } },
  { name: "untyped raw bytes", body: Buffer.from([0, 255, 128, 65]), headers: { "Content-Length": "4" } },
  { name: "chunked untyped raw bytes", body: Buffer.from([0, 255, 128, 65]), headers: { "Transfer-Encoding": "chunked" } },
  { name: "JSON bytes including whitespace", body: Buffer.from(' { "value": 1 }\n'), headers: { "Content-Type": "application/json" } },
  { name: "bodyless GET", method: "GET", headers: {} },
  { name: "POST without framing headers", headers: {}, noFraming: true }
];

for (const prefix of ["/ages", "/foreign/broker/ages"]) {
  for (const scenario of cases) {
    test(`${prefix}: preserves ${scenario.name}`, { timeout: 6000 }, async t => {
      const expected = scenario.body ?? Buffer.alloc(0);
      let observed;
      const upstream = http.createServer((req, res) => {
        const chunks = [];
        req.on("data", chunk => chunks.push(chunk));
        req.on("end", () => {
          observed = { body: Buffer.concat(chunks), headers: req.headers };
          res.end("ok");
        });
      });
      const upstreamUrl = await listen(upstream, t);
      const proxyUrl = await listen(createProxy(upstreamUrl), t);
      const headers = { ...scenario.headers, AGES_USER: "test-user", AGES_PASS: "test-password" };
      const result = await request(`${proxyUrl}${prefix}/autorizar`, scenario.method ?? "POST", headers, scenario.body, scenario.noFraming);
      assert.equal(result.status, 200, result.body.toString());
      assert.deepEqual(observed.body, expected);
      assert.equal(observed.headers["content-type"], headers["Content-Type"]);
      if (observed.headers["content-length"] !== undefined) {
        assert.equal(Number(observed.headers["content-length"]), expected.length);
      }
      assert.equal(observed.headers.ages_user, "test-user");
      assert.equal(observed.headers.ages_pass, "test-password");
    });
  }
}

test("proxy failure log excludes query values and upstream error messages", async t => {
  const warnings = [];
  const proxyUrl = await listen(createProxy("http://unused", {
    proxyError: new Error("secret-upstream-error"),
    onWarn: message => warnings.push(message)
  }), t);
  const response = await request(`${proxyUrl}/ages/autorizar?token=secret-query`, "GET", {}, undefined);
  assert.equal(response.status, 502);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /u=\/ages\/autorizar/);
  assert.match(warnings[0], /st=502/);
  assert.match(warnings[0], /err=Error/);
  assert.doesNotMatch(warnings[0], /secret-|token=/);
});
