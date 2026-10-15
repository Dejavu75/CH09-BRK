const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const express = require("express");

// Exercise the public router without loading AGES configuration or credentials.
function createRouter(variant, observed) {
  const filename = path.join(__dirname, "..", variant, "routes", `rou_broker.${variant === "src" ? "ts" : "js"}`);
  const input = fs.readFileSync(filename, "utf8");
  const code = variant === "src" ? ts.transpileModule(input, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText : input;
  const exports = {};
  const dependencies = {
    se_configbase: { getHeartBeat() {} },
    "../services/ages_pool": { agesConnectionPool: {
      async proxyCall(kind, name, query, init) {
        observed.push({ kind, name, query, method: init.method });
        return { status: 200, body: Buffer.from("ok"), headers: {}, traceHeaders: {}, slotId: 1, slotKind: kind, backendId: "synthetic" };
      },
      completeTraceResponse() {}
    } },
    "../services/heartbeat_metadata": { configureHeartbeatExtraData() {} },
    "../utils/logger": { warn() {} },
    "../generated/build_info": { BROKER_BUILD_INFO: {} },
    "../auth/http": { SERVICE_KEY_HEADER: "x-broker-service-api-key" },
    "../auth/session_store": { SESSION_COOKIE: "__Host-broker_session" }
  };
  vm.runInNewContext(code, {
    exports, Buffer, URL, process: { env: {} },
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      if (name.startsWith(".") || name === "se_configbase") throw new Error(`Unexpected production dependency: ${name}`);
      return require(name);
    }
  }, { filename });
  return exports.BrokerRouter;
}

async function withRouter(t, variant, check) {
  const observed = [];
  const router = createRouter(variant, observed);
  const app = express();
  app.use("/foreign/broker", router);
  app.use(router);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await check(`http://127.0.0.1:${server.address().port}`, observed);
}

for (const variant of ["src", "build"]) {
  test(`${variant}: cost-center aliases use the registered AVFP object`, async t => {
    await withRouter(t, variant, async (base, observed) => {
      for (const prefix of ["/ages", "/foreign/broker/ages", "/foreign/broker"]) {
        for (const kind of ["bigb", "mini"]) {
          for (const module of ["centros_costos", "ocentros_costos", "OCENTROS_COSTOS"]) {
            for (const member of ["centros", "subcentros", "subcentros.ages"]) {
              const response = await fetch(`${base}${prefix}/${kind === "mini" ? "~mini~/" : ""}tablas/${module}/${member}?id=7`);
              assert.equal(response.status, 200);
              assert.equal(await response.text(), "ok");
              assert.deepEqual(observed.at(-1), { kind, name: `otablas.oCentros.${member.replace(/\.ages$/, "")}`, query: "id=7", method: "GET" });
            }
          }
        }
      }
    });
  });

  test(`${variant}: existing paths preserve object prefixes and method underscores`, async t => {
    await withRouter(t, variant, async (base, observed) => {
      for (const [route, expected] of [
        ["tablas/articulos/estados_de_venta", "otablas.oarticulos.estados_de_venta"],
        ["oTablas/oArticulos/marcas", "oTablas.oArticulos.marcas"],
        ["OTablas/OArticulos/marcas", "OTablas.OArticulos.marcas"],
        ["tablas/centros/centros", "otablas.ocentros.centros"],
        ["otablas.oCentros.centros.ages", "otablas.oCentros.centros.ages"]
      ]) {
        const response = await fetch(`${base}/ages/${route}`);
        assert.equal(response.status, 200);
        await response.text();
        assert.equal(observed.at(-1).name, expected);
      }
    });
  });
}
