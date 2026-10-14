const assert = require("node:assert/strict");
const test = require("node:test");

const { AgesConnectionPool, agesConnectionPool, chooseLeastLoadedBackend, resolveIisAppPoolName } = require("../build/services/ages_pool");
const { BrokerRouter, isBrokerAdminAuthorized } = require("../build/routes/rou_broker");
const logger = require("../build/utils/logger");

const dual = { mode: "dual", backends: [
  { id: "A", baseUrl: "http://ages-a" }, { id: "B", baseUrl: "http://ages-b" }
] };
const endpoints = [{ kind: "mini" }, { kind: "mini" }, { kind: "bigb" }, { kind: "bigb" }];

function ready(url, body = "ok", status = 200) {
  const host = new URL(url).hostname;
  return new Response(body, { status, headers: {
    AGES_TOKEN: `token-${host}`, "set-cookie": `ASP.NET_SessionId=session-${host}; Path=/`
  } });
}

async function withFetch(handler, run) {
  const original = global.fetch;
  global.fetch = handler;
  try { return await run(); } finally { global.fetch = original; }
}

async function waitFor(check, timeout = 250) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition timeout");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("ordinary pool logs retain metadata without credential or response payloads", t => {
  const messages = [];
  const originalLog = logger.log;
  const originalWarn = logger.warn;
  logger.log = message => messages.push(message);
  logger.warn = message => messages.push(message);
  t.after(() => { logger.log = originalLog; logger.warn = originalWarn; });
  const pool = new AgesConnectionPool("http://legacy", [{ kind: "mini" }],
    { mode: "legacy", backends: [{ id: "legacy", baseUrl: "http://legacy" }] });
  const slot = pool.slots[0];
  slot.agesToken = "secret-ages-token";
  slot.aspNetSessionId = "secret-asp-session";
  slot.warmupResponse = "secret-warmup-response";
  slot.lastStatusCode = 200;
  slot.lastError = "secret-upstream-error";
  pool.logSlotReady(slot, 1);
  pool.logSlotError(slot);
  pool.logProxyError(slot, "GET", "http://legacy/ages/test?token=secret-query", "client", "socket", {
    status: 500, responsePreview: "secret-response-preview",
    error: new Error("secret-error-message"), requestHeaders: { Authorization: "secret-request-header" },
    responseHeaders: { "Set-Cookie": "secret-response-header" }
  });
  const output = messages.join("\n");
  assert.match(output, /st=500/);
  assert.match(output, /reqh=Authorization/);
  assert.doesNotMatch(output, /secret-|AGES_TOKEN=|ASP\.NET_SessionId=/);
});

test("keeps healthy legacy slots available after a partial warmup", async () => {
  let calls = 0;
  await withFetch(async (url) => {
    calls++;
    return calls === 1 || calls >= 4 ? ready(url) : new Response("init failed", { status: 500 });
  }, async () => {
    const legacy = { mode: "legacy", backends: [{ id: "legacy", baseUrl: "http://legacy" }] };
    const pool = new AgesConnectionPool("http://legacy", [{ kind: "mini" }, { kind: "mini" }], legacy);

    const summary = await pool.warmUp();

    assert.equal(summary.backends[0].state, "active");
    assert.equal(summary.ready, 1);
    assert.equal(summary.error, 1);
    assert.equal((await pool.proxyCall("mini", "healthy")).status, 200);
  });
});

test("retries failed legacy slots during ping and converges the pool", async () => {
  let calls = 0;
  await withFetch(async (url) => {
    calls++;
    return calls === 1 || calls >= 4 ? ready(url) : new Response("init failed", { status: 500 });
  }, async () => {
    const legacy = { mode: "legacy", backends: [{ id: "legacy", baseUrl: "http://legacy" }] };
    const pool = new AgesConnectionPool("http://legacy", [{ kind: "mini" }, { kind: "mini" }], legacy);
    await pool.warmUp();
    const failedSlot = pool.slots.find((slot) => slot.status === "error");

    await pool.pingSlot(failedSlot);

    const summary = pool.getSummary();
    assert.equal(calls, 4);
    assert.equal(summary.backends[0].state, "active");
    assert.equal(summary.ready, 2);
    assert.equal(summary.error, 0);
  });
});

test("routes ready BigBoy slots while Mini recovery restores degraded dual backends", async () => {
  let miniReady = false;
  let backendRecycles = 0;
  await withFetch(async (url) => {
    if (String(url).includes("~mini~") && !miniReady) return new Response("ERROR");
    return ready(url);
  }, async () => {
    const pool = new AgesConnectionPool("http://legacy", endpoints, dual, {
      recycleExecutor: async () => { backendRecycles++; }
    });
    const summary = await pool.warmUp();

    assert.deepEqual(summary.backends.map((backend) => backend.state), ["degraded", "degraded"]);
    assert.equal(summary.config.mini.ready, 0);
    assert.equal(summary.config.bigb.ready, 2);
    assert.equal((await pool.proxyCall("bigb", "healthy")).status, 200);
    assert.equal(backendRecycles, 0);

    await assert.rejects(pool.proxyCall("mini", "unavailable"), /still in warmup/);
    assert.equal(backendRecycles, 0);

    miniReady = true;
    for (const slot of pool.slots.filter((item) => item.kind === "mini")) await pool.pingSlot(slot);

    const recovered = pool.getSummary();
    assert.equal(recovered.config.mini.ready, 2);
    assert.deepEqual(recovered.backends.map((backend) => backend.state), ["active", "active"]);
  });
});

test("keeps lifecycle backends fail closed for routing and maintenance", async () => {
  let calls = 0;
  await withFetch(async (url) => { calls++; return ready(url); }, async () => {
    const pool = new AgesConnectionPool("http://legacy", [{ kind: "mini" }, { kind: "bigb" }], dual);
    await pool.warmUp();
    const backendASlot = pool.slots.find((slot) => slot.backendId === "A");

    for (const state of ["draining", "recycling", "warming"]) {
      pool.backendStates.get("A").state = state;
      backendASlot.status = "error";
      const callsBeforeMaintenance = calls;
      await pool.pingSlot(backendASlot);
      assert.equal(calls, callsBeforeMaintenance);
      await assert.rejects(pool.proxyCall(backendASlot.kind, "blocked"), /still in warmup/);
      assert.equal(calls, callsBeforeMaintenance);
    }
  });
});

test("serializes backend lifecycle, drains live traffic, and keeps the peer serving", async () => {
  let release;
  let recycled = false;
  await withFetch(async (url) => {
    if (String(url).includes("ages-a") && String(url).includes("hold.ages")) {
      await new Promise((resolve) => { release = resolve; });
    }
    return ready(url);
  }, async () => {
    const pool = new AgesConnectionPool("http://legacy", endpoints, dual, {
      drainTimeoutMs: 200, pollMs: 2, recycleExecutor: async () => { recycled = true; }
    });
    await pool.warmUp();
    const held = pool.proxyCall("mini", "hold");
    await waitFor(() => Boolean(release));
    const operation = pool.drainAndRecycleBackend("A");
    await waitFor(() => pool.getSummary().backends[0].state === "draining");
    assert.equal(recycled, false);
    await assert.rejects(pool.drainAndRecycleBackend("B"), /already recycling/);
    await assert.rejects(pool.warmUp(), /while backend A is recycling/);
    assert.equal((await pool.proxyCall("mini", "peer")).backendId, "B");
    release();
    await held;
    await operation;
    assert.equal(recycled, true);
    assert.deepEqual(pool.getSummary().backends.map((item) => item.state), ["active", "active"]);
  });
});

test("requires a ready peer and global warmup drains before resetting live slots", async () => {
  await withFetch(ready, async () => {
    const pool = new AgesConnectionPool("http://legacy", [{ kind: "mini" }, { kind: "mini" }, { kind: "bigb" }], dual,
      { recycleExecutor: async () => {} });
    await pool.warmUp();
    await assert.rejects(pool.drainAndRecycleBackend("A"), /Peer backend B is not active and ready/);
  });

  await withFetch(async (url) => String(url).includes("ages-b") ? new Response("bad") : ready(url), async () => {
    const pool = new AgesConnectionPool("http://legacy", endpoints, dual, { pollMs: 2, recycleExecutor: async () => {} });
    await pool.warmUp();
    await assert.rejects(pool.drainAndRecycleBackend("A"), /Peer backend B is not active and ready/);
  });

  let release;
  await withFetch(async (url) => {
    if (String(url).includes("hold.ages")) await new Promise((resolve) => { release = resolve; });
    return ready(url);
  }, async () => {
    const pool = new AgesConnectionPool("http://legacy", endpoints, dual, { drainTimeoutMs: 200, pollMs: 2 });
    await pool.warmUp();
    const held = pool.proxyCall("mini", "hold");
    await waitFor(() => Boolean(release));
    const warmup = pool.warmUp();
    await waitFor(() => pool.getSummary().backends.every((item) => item.state === "draining"));
    assert.equal(pool.getSummary().slots.some((slot) => slot.inUse), true);
    await assert.rejects(pool.drainAndRecycleBackend("B"), /Global warmup is running/);
    release();
    await held;
    await warmup;
  });
});

test("drain waits for in-flight maintenance before recycling and replacing session state", async () => {
  let releasePing;
  let recycled = false;
  await withFetch(async (url) => {
    if (!recycled && String(url).includes("ages-a") && String(url).includes("ping.ages")) {
      await new Promise((resolve) => { releasePing = resolve; });
      return new Response("old", { headers: { AGES_TOKEN: "old", "set-cookie": "ASP.NET_SessionId=old" } });
    }
    const response = ready(url);
    if (recycled && String(url).includes("ages-a")) {
      response.headers.set("AGES_TOKEN", "new");
      response.headers.set("set-cookie", "ASP.NET_SessionId=new");
    }
    return response;
  }, async () => {
    const pool = new AgesConnectionPool("http://legacy", endpoints, dual, {
      drainTimeoutMs: 200, pollMs: 2, recycleExecutor: async () => { recycled = true; }
    });
    await pool.warmUp();
    const ping = pool.pingSlot(pool.slots[0]);
    await waitFor(() => Boolean(releasePing));
    const operation = pool.drainAndRecycleBackend("A");
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(recycled, false);
    releasePing();
    await ping;
    await operation;
    assert.equal(pool.slots[0].agesToken, "new");
    assert.equal(pool.slots[0].aspNetSessionId, "new");
  });
});

test("global warmup reactivates backends before waking slot waiters", async () => withFetch(ready, async () => {
  const pool = new AgesConnectionPool("http://legacy", [{ kind: "mini" }, { kind: "mini" }], dual);
  await pool.warmUp();
  pool.slots.forEach((slot) => { slot.inUse = true; });
  const waiting = pool.acquireSlot("mini", { allowGrow: false, baseOnly: false, excludeSlotIds: new Set() });
  const warmup = pool.warmUp();
  await waitFor(() => pool.getSummary().backends.every((item) => item.state === "draining"));
  pool.slots.forEach((slot) => pool.releaseSlot(slot));
  await warmup;
  const acquired = await Promise.race([
    waiting, new Promise((_, reject) => setTimeout(() => reject(new Error("waiter was not notified")), 100))
  ]);
  assert.equal(pool.getSummary().backends.find((item) => item.id === acquired.backendId).state, "active");
  assert.throws(() => chooseLeastLoadedBackend([], []), /No active AGES backend/);
}));

test("polls Warmingup to ready and degrades only the failed backend", async () => {
  let recycled = false;
  let warmingReplies = 2;
  await withFetch(async (url) => {
    if (recycled && String(url).includes("ages-a") && warmingReplies-- > 0) return new Response("Warmingup");
    return ready(url);
  }, async () => {
    const pool = new AgesConnectionPool("http://legacy", endpoints, dual, {
      drainTimeoutMs: 100, pollMs: 2, recycleExecutor: async () => { recycled = true; }
    });
    await pool.warmUp();
    await pool.drainAndRecycleBackend("A");
    assert.equal(pool.getSummary().backends[0].state, "active");
    assert.ok(warmingReplies < 0);
  });

  await withFetch(ready, async () => {
    const pool = new AgesConnectionPool("http://legacy", endpoints, dual, {
      pollMs: 2, recycleExecutor: async () => { throw new Error("ssh failed"); }
    });
    await pool.warmUp();
    await assert.rejects(pool.drainAndRecycleBackend("A"), /ssh failed/);
    assert.deepEqual(pool.getSummary().backends.map((item) => item.state), ["degraded", "active"]);
  });

  let recycledForTimeout = false;
  await withFetch(async (url) => recycledForTimeout && String(url).includes("ages-a")
    ? new Response("Warmingup") : ready(url), async () => {
    const pool = new AgesConnectionPool("http://legacy", endpoints, dual, {
      drainTimeoutMs: 15, pollMs: 2, recycleExecutor: async () => { recycledForTimeout = true; }
    });
    await pool.warmUp();
    await assert.rejects(pool.drainAndRecycleBackend("A"));
    assert.equal(pool.getSummary().backends[0].state, "degraded");
  });
});

test("correlates dual HTTP 503 to one backend without global restart", async () => {
  const recycled = [];
  await withFetch(async (url) => String(url).includes("fail.ages")
    ? new Response("unavailable", { status: 503 }) : ready(url), async () => {
    const pool = new AgesConnectionPool("http://legacy", endpoints, dual, {
      pollMs: 2, recycleExecutor: async (id) => { recycled.push(id); }
    });
    await pool.warmUp();
    const result = await pool.proxyCall("mini", "fail");
    assert.equal(result.backendId, "A");
    await waitFor(() => recycled.length === 1);
    assert.deepEqual(recycled, ["A"]);
  });
});

test("recycles only after two distinct same-backend slots finish recycling with HTTP 500", async () => {
  let failA = true;
  const recycled = [];
  await withFetch(async (url) => failA && String(url).includes("ages-a")
    ? new Response("failed", { status: 500 }) : ready(url), async () => {
    const pool = new AgesConnectionPool("http://legacy", endpoints, dual, {
      pollMs: 2, drainTimeoutMs: 200, recycleExecutor: async (id) => { recycled.push(id); failA = false; }
    });
    failA = false;
    await pool.warmUp();
    failA = true;
    const [first, second] = pool.slots.filter((slot) => slot.backendId === "A");
    await pool.pingSlot(first);
    await pool.pingSlot(first);
    assert.deepEqual(recycled, []);
    await pool.pingSlot(second);
    await pool.pingSlot(second);
    await waitFor(() => recycled.length === 1);
    await waitFor(() => pool.getSummary().backends[0].state === "active");
    assert.deepEqual(recycled, ["A"]);
    assert.equal(pool.getSummary().backends[0].ready, 2);
  });
});

test("does not combine backend cohorts and removes a recovered slot", async () => {
  const failed = new Set();
  const recycled = [];
  await withFetch(async (url) => failed.has(new URL(url).hostname)
    ? new Response("failed", { status: 500 }) : ready(url), async () => {
    const pool = new AgesConnectionPool("http://legacy", endpoints, dual, {
      pollMs: 2, drainTimeoutMs: 200, recycleExecutor: async (id) => { recycled.push(id); }
    });
    await pool.warmUp();
    const [a1, a2] = pool.slots.filter((slot) => slot.backendId === "A");
    const b1 = pool.slots.find((slot) => slot.backendId === "B");
    failed.add("ages-a");
    await pool.pingSlot(a1);
    failed.delete("ages-a");
    await pool.pingSlot(a1);
    failed.add("ages-b");
    await pool.pingSlot(b1);
    assert.deepEqual(recycled, []);
    failed.delete("ages-b");
    await pool.pingSlot(b1);
    failed.add("ages-a");
    await pool.pingSlot(a2);
    await new Promise(setImmediate);
    assert.deepEqual(recycled, []);
  });
});

test("does not count a slot whose final recycle response is not HTTP 500", async () => {
  let failing = false;
  const recycled = [];
  await withFetch(async (url) => {
    if (!failing || String(url).includes("ages-b")) return ready(url);
    return new Response("failed", { status: String(url).includes("~mini~") ? 503 : 500 });
  }, async () => {
    const pool = new AgesConnectionPool("http://legacy", endpoints, dual, {
      recycleExecutor: async (id) => { recycled.push(id); }
    });
    await pool.warmUp();
    failing = true;
    for (const slot of pool.slots.filter((item) => item.backendId === "A")) await pool.pingSlot(slot);
    await new Promise(setImmediate);
    assert.deepEqual(recycled, []);
  });
});

test("removes a prior HTTP 500 when the same slot later fails with another status", async () => {
  let miniStatus = 200;
  let bigbStatus = 200;
  const recycled = [];
  await withFetch(async (url) => {
    if (String(url).includes("ages-b")) return ready(url);
    const status = String(url).includes("~mini~") ? miniStatus : bigbStatus;
    return status === 200 ? ready(url) : new Response("failed", { status });
  }, async () => {
    const pool = new AgesConnectionPool("http://legacy", endpoints, dual, {
      recycleExecutor: async (id) => { recycled.push(id); miniStatus = 200; bigbStatus = 200; }
    });
    await pool.warmUp();
    const [mini, bigb] = pool.slots.filter((slot) => slot.backendId === "A");
    miniStatus = 500;
    await pool.pingSlot(mini);
    miniStatus = 503;
    await pool.pingSlot(mini);
    bigbStatus = 500;
    await pool.pingSlot(bigb);
    await new Promise(setImmediate);
    assert.deepEqual(recycled, []);
  });
});

test("cancels a scheduled backend recycle if its two-slot cohort shrinks before execution", async () => {
  let failMini = false;
  let failBigb = false;
  const recycled = [];
  await withFetch(async (url) => {
    if (String(url).includes("ages-b")) return ready(url);
    const failing = String(url).includes("~mini~") ? failMini : failBigb;
    return failing ? new Response("failed", { status: 500 }) : ready(url);
  }, async () => {
    const pool = new AgesConnectionPool("http://legacy", endpoints, dual, {
      recycleExecutor: async (id) => { recycled.push(id); failBigb = false; }
    });
    await pool.warmUp();
    const [mini, bigb] = pool.slots.filter((slot) => slot.backendId === "A");
    const originalSetImmediate = global.setImmediate;
    let scheduled;
    try {
      global.setImmediate = (callback) => { scheduled = callback; };
      failMini = true;
      failBigb = true;
      await pool.pingSlot(mini);
      await pool.pingSlot(bigb);
    } finally {
      global.setImmediate = originalSetImmediate;
    }
    assert.ok(scheduled);
    failMini = false;
    await pool.pingSlot(mini);
    scheduled();
    await new Promise(originalSetImmediate);
    assert.deepEqual(recycled, []);
  });
});

test("counts HTTP 500 with token and session headers as a failed slot recycle", async () => {
  let failA = false;
  const recycled = [];
  await withFetch(async (url) => failA && String(url).includes("ages-a")
    ? ready(url, "failed", 500) : ready(url), async () => {
    const pool = new AgesConnectionPool("http://legacy", endpoints, dual, {
      pollMs: 2, drainTimeoutMs: 200,
      recycleExecutor: async (id) => { recycled.push(id); failA = false; }
    });
    await pool.warmUp();
    failA = true;
    for (const slot of pool.slots.filter((item) => item.backendId === "A")) await pool.pingSlot(slot);
    await waitFor(() => recycled.length === 1);
    assert.deepEqual(recycled, ["A"]);
  });
});

test("accepts successful 201 warmup responses with token and session headers", async () => {
  await withFetch(async (url) => ready(url, "created", 201), async () => {
    const pool = new AgesConnectionPool("http://legacy", endpoints, dual);
    const summary = await pool.warmUp();
    assert.equal(summary.ready, endpoints.length);
  });
});

test("validates directed AppPool names and a separate constant-time admin key", () => {
  assert.equal(resolveIisAppPoolName("A", { AGES_IIS_APP_POOL_A: "AGES_A" }), "AGES_A");
  assert.throws(() => resolveIisAppPoolName("B", { AGES_IIS_APP_POOL_B: "AGES B; iisreset" }), /Invalid/);
  assert.equal(isBrokerAdminAuthorized("secret", "secret"), true);
  assert.equal(isBrokerAdminAuthorized("AGES-key", "admin-key"), false);
  assert.equal(isBrokerAdminAuthorized("", ""), false);
  const warmupRoute = BrokerRouter.stack.find((layer) => layer.route?.path === "/pool/warmup");
  assert.equal(warmupRoute.route.stack[0].handle.name, "requireBrokerAdmin");
});

test("handles warmup rejection and renders an ephemeral admin-key UI flow", async () => {
  const warmupRoute = BrokerRouter.stack.find((layer) => layer.route?.path === "/pool/warmup");
  const originalWarmUp = agesConnectionPool.warmUp;
  let status;
  let body;
  const response = { status(value) { status = value; return this; }, json(value) { body = value; return this; } };
  try {
    agesConnectionPool.warmUp = async () => { throw new Error("Global warmup is running"); };
    await warmupRoute.route.stack[1].handle({}, response);
    assert.equal(status, 409);
    assert.match(body.message, /Global warmup/);
    agesConnectionPool.warmUp = async () => { throw new Error("upstream failed"); };
    await warmupRoute.route.stack[1].handle({}, response);
    assert.equal(status, 503);
  } finally {
    agesConnectionPool.warmUp = originalWarmUp;
  }

  const showRoute = BrokerRouter.stack.find((layer) => layer.route?.path === "/pool/show");
  let html = "";
  showRoute.route.stack[0].handle({ baseUrl: "" }, { type() { return this; }, send(value) { html = value; } });
  assert.match(html, /data-admin-required/);
  assert.match(html, /window\.prompt\("Broker admin API key"\)/);
  assert.match(html, /headers\["X-Broker-Admin-Api-Key"\] = adminKey/);
  assert.match(html, /headers\["X-CSRF-Token"\] = await csrfToken\(\)/);
  assert.match(html, /if \(!adminKey\).*Accion cancelada/s);
  const timingsRoute = BrokerRouter.stack.find((layer) => layer.route?.path === "/pool/timings/show");
  let timingsHtml = "";
  timingsRoute.route.stack[0].handle({ baseUrl: "" }, { type() { return this; }, send(value) { timingsHtml = value; } });
  assert.match(timingsHtml, /"X-CSRF-Token": await csrfToken\(\)/);
});
