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
    "../generated/build_info": { BROKER_BUILD_INFO: {} }
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

async function listen(server, t) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("timing input preserves received header order, case, duplicates, and complete body", async t => {
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
  const timingRequest = recorded[6];
  assert.deepEqual(JSON.parse(JSON.stringify(timingRequest.requestHeaders.filter(header =>
    ["ages_user", "ages_pass", "x-ages-api-key"].includes(header.name.toLowerCase())))), [
    { name: "AGES_USER", value: "synthetic-user" },
    { name: "AGES_PASS", value: "synthetic-password" },
    { name: "X-AGES-API-Key", value: "synthetic-key-a" },
    { name: "x-ages-api-key", value: "synthetic-key-b" }
  ]);
  assert.equal(timingRequest.requestBody, body);
});

test("timing output captures at most 1024 UTF-8 bytes of JSON and no non-JSON response", async () => {
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
    const timingRequest = {
      requestHeaders: [{ name: "AGES_PASS", value: "synthetic-password" }],
      requestBody: '{"login":"synthetic"}'
    };
    responseBody = JSON.stringify({ message: "🦊".repeat(300) });
    const jsonResult = await pool.proxyCall("bigb", "ologin.autorizar", "", { method: "POST" }, "", "", timingRequest);
    const jsonTrace = pool.getTimingLog().find(trace => trace.id === jsonResult.traceId);
    assert.deepEqual(jsonResult.body, Buffer.from(responseBody));
    assert.equal(jsonTrace.requestHeaders[0].value, "synthetic-password");
    assert.equal(jsonTrace.requestBody, timingRequest.requestBody);
    assert.ok(Buffer.byteLength(jsonTrace.responseJson, "utf8") <= 1024);
    assert.ok(responseBody.startsWith(jsonTrace.responseJson));
    assert.ok(!jsonTrace.responseJson.includes("�"));

    responseBody = '{"result":"json-with-plain-content-type"}';
    responseType = "text/plain";
    const plainJsonResult = await pool.proxyCall("bigb", "plain-json", "", { method: "GET" }, "", "", timingRequest);
    const plainJsonTrace = pool.getTimingLog().find(trace => trace.id === plainJsonResult.traceId);
    assert.equal(plainJsonTrace.responseJson, responseBody);

    responseBody = "plain-text-response";
    responseType = "text/plain";
    const textResult = await pool.proxyCall("bigb", "plain", "", { method: "GET" }, "", "", timingRequest);
    const textTrace = pool.getTimingLog().find(trace => trace.id === textResult.traceId);
    assert.equal(textTrace.responseJson, undefined);
    assert.equal(textResult.body.toString(), responseBody);
  } finally {
    global.fetch = originalFetch;
  }
});
