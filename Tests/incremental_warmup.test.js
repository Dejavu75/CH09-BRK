const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Exercise the shipped build without loading operational logging or credentials.
const exportsUnderTest = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../build/services/ages_pool.js"), "utf8"), {
  exports: exportsUnderTest, Buffer, URL, Headers, AbortController, setTimeout, clearTimeout,
  process: { env: {} }, fetch: (...args) => global.fetch(...args),
  require(name) {
    if (name === "dotenv/config") return {};
    if (name === "../utils/logger") return { log() {}, warn() {}, sendDebugMail: async () => {} };
    return require(name);
  }
});
const { AgesConnectionPool } = exportsUnderTest;

const legacy = { mode: "legacy", backends: [{ id: "legacy", baseUrl: "http://legacy" }] };
const dual = { mode: "dual", backends: [
  { id: "A", baseUrl: "http://ages-a" }, { id: "B", baseUrl: "http://ages-b" }
] };
const endpoints = ["mini", "mini", "bigb", "bigb"].map((kind) => ({ kind }));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function ready(url) {
  const host = new URL(url).hostname;
  return new Response("ok", { headers: {
    AGES_TOKEN: `token-${host}`, "set-cookie": `ASP.NET_SessionId=session-${host}; Path=/`
  } });
}

for (const config of [legacy, dual]) {
  for (const manual of [false, true]) {
    test(`${config.mode} serves each ready slot during ${manual ? "manual" : "initial"} warmup`, { timeout: 10000 }, async () => {
      const originalFetch = global.fetch;
      const gates = endpoints.map(() => ({ entered: deferred(), release: deferred() }));
      const pool = new AgesConnectionPool("http://legacy", endpoints, config);
      let controlled = false;
      let index = 0;
      let completed = false;
      let warmup;
      const requests = [];
      global.fetch = async (url, init) => {
        if (controlled && String(url).includes("dummy_val.ages")) {
          const gate = gates[index++];
          gate.entered.resolve();
          await gate.release.promise;
        } else if (controlled) {
          requests.push({ url, headers: new Headers(init.headers) });
        }
        return ready(url);
      };
      try {
        if (manual) await pool.warmUp();
        controlled = true;
        warmup = pool.warmUp().then(() => { completed = true; });
        await gates[0].entered.promise;
        assert.equal(pool.getSummary().ready, 0);
        assert.ok(pool.slots.every((slot) => !slot.agesToken && !slot.aspNetSessionId));
        await assert.rejects(pool.proxyCall("mini", "blocked"), /still in warmup/);
        for (let i = 0; i < gates.length - 1; i++) {
          gates[i].release.resolve();
          await gates[i + 1].entered.promise;
          assert.equal(completed, false);
          assert.equal(pool.getSummary().ready, i + 1);
          const result = await pool.proxyCall(endpoints[i].kind, "incremental");
          assert.equal(result.status, 200);
          const request = requests.at(-1);
          const host = new URL(request.url).hostname;
          assert.equal(request.headers.get("AGES_TOKEN"), `token-${host}`);
          assert.equal(request.headers.get("cookie"), `ASP.NET_SessionId=session-${host}`);
          const callsBeforePing = requests.length;
          await pool.runPingSweep();
          assert.equal(requests.length, callsBeforePing, "maintenance remains blocked during global warmup");
          assert.equal(index, i + 2, "maintenance must not reinitialize pending slots");
          if (i < 2) await assert.rejects(pool.proxyCall("bigb", "blocked"), /still in warmup/);
        }
      } finally {
        gates.forEach((gate) => gate.release.resolve());
        if (warmup) await warmup;
        global.fetch = originalFetch;
      }
    });
  }
}

test("new ready slot wakes a queued request before global warmup completes", { timeout: 10000 }, async () => {
  const originalFetch = global.fetch;
  const gates = [0, 1, 2].map(() => ({ entered: deferred(), release: deferred() }));
  const held = deferred();
  const holding = deferred();
  let index = 0;
  let warmup;
  let first;
  let queued;
  const pool = new AgesConnectionPool("http://legacy", gates.map(() => ({ kind: "mini" })), legacy);
  global.fetch = async (url) => {
    if (String(url).includes("dummy_val.ages")) {
      const gate = gates[index++];
      gate.entered.resolve();
      await gate.release.promise;
    } else if (String(url).includes("hold.ages")) {
      holding.resolve();
      await held.promise;
    }
    return ready(url);
  };
  try {
    warmup = pool.warmUp();
    await gates[0].entered.promise;
    gates[0].release.resolve();
    await gates[1].entered.promise;
    assert.equal(pool.hasReadySlot("mini"), true);
    first = pool.proxyCall("mini", "hold");
    await holding.promise;
    queued = pool.proxyCall("mini", "queued");
    assert.equal(pool.getSummary().config.mini.waiting, 1);
    gates[1].release.resolve();
    await gates[2].entered.promise;
    assert.equal((await queued).slotId, 2);
    assert.equal(pool.getSummary().slots[0].inUse, true);
    assert.equal(pool.getSummary().size, 3, "no adaptive growth during warmup");
  } finally {
    held.resolve();
    gates.forEach((gate) => gate.release.resolve());
    await Promise.all([warmup, first, queued]);
    global.fetch = originalFetch;
  }
});

test("directed recycle keeps ready slots isolated until its backend finishes warming", { timeout: 10000 }, async () => {
  const originalFetch = global.fetch;
  const entered = deferred();
  const release = deferred();
  let recycled = false;
  let operation;
  const pool = new AgesConnectionPool("http://legacy", endpoints, dual, {
    recycleExecutor: async () => { recycled = true; }
  });
  global.fetch = async (url) => {
    if (recycled && String(url) === "http://ages-a/dummy_val.ages") {
      entered.resolve();
      await release.promise;
    }
    return ready(url);
  };
  try {
    await pool.warmUp();
    operation = pool.drainAndRecycleBackend("A");
    await entered.promise;
    assert.equal(pool.slots[0].status, "ready");
    assert.equal(pool.getSummary().backends[0].state, "warming");
    for (const kind of ["mini", "bigb"]) {
      assert.equal((await pool.proxyCall(kind, "peer")).backendId, "B");
    }
  } finally {
    release.resolve();
    if (operation) await operation;
    global.fetch = originalFetch;
  }
});
