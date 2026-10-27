const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const express = require("express");

const { AgesConnectionPool } = require("../build/services/ages_pool");

function loadBrokerRouter(pool) {
  const filename = path.join(__dirname, "..", "src", "routes", "rou_broker.ts");
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText;
  const dependencies = {
    "se_configbase": { getHeartBeat: () => ({}) },
    "../services/ages_pool": { agesConnectionPool: pool },
    "../services/heartbeat_metadata": { configureHeartbeatExtraData() {} },
    "../utils/logger": { warn() {} },
    "../generated/build_info": { BROKER_BUILD_INFO: {} },
    "../auth/http": { SERVICE_KEY_HEADER: "x-broker-service-api-key" },
    "../auth/session_store": { SESSION_COOKIE: "__Host-broker_session" }
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, Buffer, URL, process: { env: {} },
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      if (name.startsWith(".")) throw new Error(`Unexpected dependency: ${name}`);
      return require(name);
    }
  }, { filename });
  return exports.BrokerRouter;
}

test("timing API validates and forwards combined filters without querying invalid inputs", async t => {
  const calls = [];
  const app = express();
  app.use("/broker", loadBrokerRouter({ getTimingLog(...args) { calls.push(args); return { rows: [] }; } }));
  const base = await listen(http.createServer(app), t);
  const query = "from=2026-10-16T12:00:00Z&to=2026-10-16T13:00:00Z&url=clientes&result=errors&minTotalMs=2000&cursor=42";
  const response = await fetch(`${base}/broker/pool/timings?${query}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { rows: [] });
  assert.equal(calls[0][0], 42);
  assert.equal(JSON.stringify(calls[0][1]), JSON.stringify({ from: "2026-10-16T12:00:00Z",
    to: "2026-10-16T13:00:00Z", url: "clientes", result: "errors", minTotalMs: 2000 }));
  for (const invalid of ["from=not-a-date", "from=2026-10-16", "from=2026-02-30T12:00:00Z", "minTotalMs=-1", "minTotalMs=NaN",
    "minTotalMs=1&minTotalMs=2", "result=600", "result=oops", "url[x]=bad",
    "from=2026-10-17T00:00:00Z&to=2026-10-16T00:00:00Z"]) {
    assert.equal((await fetch(`${base}/broker/pool/timings?${invalid}`)).status, 400, invalid);
  }
  assert.equal(calls.length, 1);
  const html = await (await fetch(`${base}/broker/pool/timings/show`)).text();
  assert.match(html, /id="timingFilters"/);
  assert.match(html, /datetime-local/);
  assert.match(html, /minTotalMs/);
});

test("timing window preserves applied filters on refresh and pagination, resets to the first page, and rejects stale responses", async t => {
  const app = express();
  app.use("/broker", loadBrokerRouter({}));
  const base = await listen(http.createServer(app), t);
  const html = await (await fetch(`${base}/broker/pool/timings/show`)).text();
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, { checked: true, disabled: false, textContent: "", innerHTML: "",
      listeners: {}, addEventListener(event, handler) { this.listeners[event] = handler; } });
    return elements.get(id);
  }
  const requests = [];
  let fields = [];
  let completeDelayed;
  let delayNext = false;
  const context = {
    document: { getElementById: element, querySelector: element }, URLSearchParams, Date, Intl,
    FormData: class { constructor() { return fields[Symbol.iterator](); } },
    window: { setTimeout() {} }, setInterval() {},
    fetch: async url => {
      requests.push(new URL(url, base));
      if (delayNext) {
        delayNext = false;
        return new Promise(resolve => { completeDelayed = () => resolve({ ok: true,
          json: async () => ({ rows: [{ id: "stale" }], nextCursor: 1 }) }); });
      }
      return { ok: true, json: async () => ({ rows: [{ id: "current" }], nextCursor: 42 }) };
    }
  };
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush();
  fields = [["url", "clientes"], ["from", "2026-10-16T12:00:00"], ["result", "errors"], ["minTotalMs", "2000"]];
  element("timingFilters").listeners.submit({ preventDefault() {} });
  await flush();
  assert.equal(requests.at(-1).searchParams.get("from"), new Date(fields[1][1]).toISOString());
  assert.equal(requests.at(-1).searchParams.get("url"), "clientes");
  await element("olderTimings").listeners.click();
  assert.equal(requests.at(-1).searchParams.get("cursor"), "42");
  assert.equal(requests.at(-1).searchParams.get("result"), "errors");
  await element("refreshTimings").listeners.click();
  assert.equal(requests.at(-1).searchParams.get("minTotalMs"), "2000");
  delayNext = true;
  const delayed = element("refreshTimings").listeners.click();
  element("timingFilters").listeners.reset();
  await flush();
  assert.equal(requests.at(-1).search, "");
  completeDelayed();
  await delayed;
  assert.ok(element("pre").textContent.includes("current"));
  assert.ok(!element("pre").textContent.includes("stale"));
  assert.equal(element("newerTimings").disabled, true);
});

async function listen(server, t) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("proxy forwards credentials but never supplies raw request data to timings", async t => {
  let recorded;
  const responseBody = Buffer.from('{"result":"synthetic"}');
  const pool = {
    async proxyCall(...args) {
      recorded = args;
      return {
        status: 200, body: responseBody, headers: { "content-type": "application/json" },
        traceHeaders: {}, traceId: "test-trace", slotId: 1, slotKind: "bigb", backendId: "legacy"
      };
    },
    completeTraceResponse() {}
  };
  const app = express();
  app.use(express.raw({ type: () => true }));
  app.use("/ages", loadBrokerRouter(pool));
  const url = await listen(http.createServer(app), t);
  const body = JSON.stringify({ payload: "synthetic-body".repeat(100) });
  const result = await new Promise((resolve, reject) => {
    const target = new URL(url);
    const socket = net.connect(Number(target.port), target.hostname, () => {
      socket.write([
        "POST /ages/login/autorizar HTTP/1.1",
        `Host: ${target.host}`,
        "AGES_USER: synthetic-user",
        "AGES_PASS: synthetic-password",
        "X-AGES-API-Key: synthetic-key-a",
        "x-ages-api-key: synthetic-key-b",
        "X-Broker-Service-Api-Key: synthetic-service-key",
        "Cookie: __Host-broker_session=synthetic-session; Other=preserved",
        "Content-Type: application/json",
        `Content-Length: ${Buffer.byteLength(body)}`,
        "Connection: close", "", body
      ].join("\r\n"));
    });
    const chunks = [];
    socket.on("data", chunk => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      const response = Buffer.concat(chunks).toString();
      resolve({ status: Number(response.split(" ")[1]), body: Buffer.from(response.split("\r\n\r\n")[1] ?? "") });
    });
  });

  assert.equal(result.status, 200, result.body.toString());
  assert.deepEqual(result.body, responseBody);
  assert.equal(recorded.length, 6, "timing payload has no raw request argument");
  assert.equal(recorded[3].headers["x-broker-service-api-key"], undefined);
  assert.equal(recorded[3].headers.cookie, "Other=preserved");
});

test("timing output omits request and response content and query parameters", async () => {
  const originalFetch = global.fetch;
  let responseBody = "";
  let responseType = "application/problem+json; charset=utf-8";
  global.fetch = async url => {
    if (String(url).includes("dummy_val")) {
      return new Response("ready", {
        headers: { AGES_TOKEN: "synthetic-slot-token", "set-cookie": "ASP.NET_SessionId=synthetic-session; Path=/" }
      });
    }
    return new Response(responseBody, { headers: { "content-type": responseType } });
  };
  try {
    const pool = new AgesConnectionPool("http://synthetic/ages", [{ kind: "bigb" }]);
    await pool.warmUp();
    responseBody = JSON.stringify({ message: "synthetic-secret-response" });
    const jsonResult = await pool.proxyCall("bigb", "ologin.autorizar", "token=synthetic-secret-query", { method: "POST", body: "synthetic-secret-request" });
    const jsonTrace = pool.getTimingLog().rows.find(trace => trace.id === jsonResult.traceId);
    assert.deepEqual(jsonResult.body, Buffer.from(responseBody));
    assert.equal(jsonTrace.requestHeaders, undefined);
    assert.equal(jsonTrace.requestBody, undefined);
    assert.equal(jsonTrace.responseJson, undefined);
    assert.ok(!JSON.stringify(jsonTrace).includes("synthetic-secret"));

    responseBody = '{"result":"json-with-plain-content-type"}';
    responseType = "text/plain";
    const plainJsonResult = await pool.proxyCall("bigb", "plain-json", "", { method: "GET" });
    const plainJsonTrace = pool.getTimingLog().rows.find(trace => trace.id === plainJsonResult.traceId);
    assert.equal(plainJsonTrace.responseJson, undefined);

    responseBody = "plain-text-response";
    responseType = "text/plain";
    const textResult = await pool.proxyCall("bigb", "plain", "", { method: "GET" });
    const textTrace = pool.getTimingLog().rows.find(trace => trace.id === textResult.traceId);
    assert.equal(textTrace.responseJson, undefined);
    assert.equal(textResult.body.toString(), responseBody);
  } finally {
    global.fetch = originalFetch;
  }
});

test("timing API validates keyset cursors and page HTML does not load history eagerly", async t => {
  const cursors = [];
  const pool = {
    getTimingLog(cursor) {
      cursors.push(cursor);
      return cursor === undefined
        ? { rows: [{ id: "synthetic-trace" }], liveRows: [{ id: "synthetic-live" }], nextCursor: 10 }
        : { rows: [{ id: "synthetic-older" }] };
    }
  };
  const app = express();
  app.use("/foreign/broker", loadBrokerRouter(pool));
  const url = await listen(http.createServer(app), t);
  const html = await (await fetch(`${url}/foreign/broker/pool/timings/show`)).text();
  assert.match(html, /Más antiguos/);
  assert.match(html, /page\.rows/);
  assert.match(html, /page\.liveRows/);
  assert.deepEqual(cursors, [], "the HTML response must not scan timing history");

  const first = await (await fetch(`${url}/foreign/broker/pool/timings`)).json();
  assert.equal(first.rows.length, 1);
  assert.deepEqual(first.liveRows, [{ id: "synthetic-live" }]);
  assert.equal(first.nextCursor, 10);
  const older = await (await fetch(`${url}/foreign/broker/pool/timings?cursor=10`)).json();
  assert.equal(older.rows.length, 1);
  assert.equal(older.liveRows, undefined);
  assert.deepEqual(cursors, [undefined, 10]);
  for (const cursor of ["0", "-1", "abc", "1.5", "9007199254740992"]) {
    assert.equal((await fetch(`${url}/foreign/broker/pool/timings?cursor=${cursor}`)).status, 400);
  }
  assert.deepEqual(cursors, [undefined, 10]);
});
