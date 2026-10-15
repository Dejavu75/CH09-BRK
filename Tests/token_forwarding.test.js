const assert = require("node:assert/strict");
const test = require("node:test");
const { loadPool } = require("./helpers/token_pool");
const legacy = { mode: "legacy", backends: [{ id: "legacy", baseUrl: "http://synthetic-ages" }] };
const dual = { mode: "dual", backends: [
  { id: "A", baseUrl: "http://synthetic-a" }, { id: "B", baseUrl: "http://synthetic-b" }
] };

async function setup(t, config = legacy, endpoints = [{ kind: "mini" }], handle = () => new Response("ok")) {
  const original = global.fetch;
  const seen = [];
  let warmups = 0;
  global.fetch = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    if (String(url).includes("dummy_val.ages")) {
      warmups++;
      assert.equal(headers.get("X-AGES-API-Key"), "synthetic-pool-key");
      const host = new URL(url).hostname;
      return new Response("ready", { headers: {
        AGES_TOKEN: `slot-${host}`, "set-cookie": `ASP.NET_SessionId=session-${host}; Path=/`
      } });
    }
    seen.push({ url: String(url), headers, body: init.body });
    return handle(url, init, seen);
  };
  const Pool = loadPool();
  const pool = new Pool("http://synthetic-ages", endpoints, config, { recycleExecutor: async () => {}, pollMs: 1 });
  t.after(() => { pool.closeTimingStore(); global.fetch = original; });
  await pool.warmUp();
  return { pool, seen, warmups: () => warmups };
}

const forms = [
  ["absent", undefined, null],
  ["mixed-case object", { AgEs_ToKeN: "client" }, "client"],
  ["Headers", new Headers({ AGES_TOKEN: "client" }), "client"],
  ["tuples", [["ages_token", "client"]], "client"],
  ["empty", { AGES_TOKEN: "" }, ""],
  ["invalid", { AGES_TOKEN: "invalid" }, "invalid"],
  ["duplicates", [["AGES_TOKEN", "client"], ["ages_token", "other"]], "client, other"]
];
for (const kind of ["bigb", "mini"]) {
  for (const [name, headers, expected] of forms) {
    test(`${kind} forwards only the supplied technical token: ${name}`, async t => {
      const { pool, seen } = await setup(t, legacy, [{ kind }]);
      const result = await pool.proxyCall(kind, "probe", "", { headers });
      assert.equal(result.status, 200);
      assert.equal(seen.at(-1).headers.get("AGES_TOKEN"), expected);
      assert.match(seen.at(-1).headers.get("cookie"), /ASP\.NET_SessionId=session-/);
      assert.equal(seen.at(-1).headers.get("X-AGES-API-Key"), null);
    });
  }
}

for (const config of [legacy, dual]) {
  test(`${config.mode} preserves successful internal request, ping and recycle authentication`, async t => {
    const endpoints = (config.mode === "dual" ? ["mini", "mini", "bigb", "bigb"] : ["mini", "bigb"]).map(kind => ({ kind }));
    const { pool, seen, warmups } = await setup(t, config, endpoints);
    await pool.request(1, "/internal.ages");
    await pool.runPingSweep();
    assert.equal(seen.length, endpoints.length + 1);
    for (const row of seen) {
      assert.equal(row.headers.get("AGES_TOKEN"), `slot-${new URL(row.url).hostname}`);
      assert.match(row.headers.get("cookie"), /ASP\.NET_SessionId=session-/);
    }
    const before = warmups();
    if (config.mode === "dual") await pool.drainAndRecycleBackend("A");
    else await pool.recycleSlotByReference("1");
    assert.ok(warmups() > before);
    assert.equal(pool.getSummary().ready, endpoints.length);
  });
}

test("Mini beat preserves caller identity and does not borrow the slot token", async t => {
  const { pool, seen } = await setup(t, legacy, [{ kind: "mini" }], (_url, init) => {
    const authorized = new Headers(init.headers).get("AGES_USER_TOKEN") === "synthetic-user";
    return new Response(authorized ? "beat" : "denied", { status: authorized ? 200 : 401 });
  });
  assert.equal((await pool.proxyCall("mini", "beat")).status, 401);
  assert.equal((await pool.proxyCall("mini", "beat", "", { headers: { AGES_USER_TOKEN: "synthetic-user" } })).status, 200);
  assert.equal(seen.length, 2);
  assert.ok(seen.every(row => row.url.endsWith("/~mini~/beat.ages") && row.headers.get("AGES_TOKEN") === null));
  assert.equal(seen.at(-1).headers.get("AGES_USER_TOKEN"), "synthetic-user");
});

test("reusing a slot keeps client tokens separate while characterizing response state capture", async t => {
  const { pool, seen } = await setup(t);
  global.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), headers: new Headers(init.headers) });
    const headers = new Headers({ AGES_TOKEN: "response-slot-token" });
    headers.append("set-cookie", "other=kept; Path=/");
    headers.append("set-cookie", "ASP.NET_SessionId=response-session; Path=/");
    return new Response("ok", { headers });
  };
  const alice = await pool.proxyCall("mini", "probe", "", { headers: { AGES_TOKEN: "alice" } });
  await pool.proxyCall("mini", "probe", "", { headers: { AGES_TOKEN: "bob", Cookie: "other=client; ASP.NET_SessionId=untrusted" } });
  await pool.request(1, "/internal.ages");
  assert.equal(seen[0].headers.get("AGES_TOKEN"), "alice");
  assert.equal(seen[1].headers.get("AGES_TOKEN"), "bob");
  assert.equal(seen[1].headers.get("cookie"), "other=client; ASP.NET_SessionId=response-session");
  assert.equal(seen[2].headers.get("AGES_TOKEN"), "response-slot-token");
  assert.ok(alice.headers["set-cookie"].some(value => value.includes("other=kept")));
  assert.ok(alice.headers["set-cookie"].some(value => value.includes("ASP.NET_SessionId=response-session")));
  assert.equal(pool.slots[0].aspNetSessionId, "response-session");
});


test("damaged-slot retry changes backend without replacing caller credentials", async t => {
  let damaged = false;
  const { pool, seen } = await setup(t, dual, [{ kind: "mini" }, { kind: "mini" }], () => {
    if (!damaged) { damaged = true; return new Response("OSAVFP no es un objeto"); }
    return new Response("ok");
  });
  const result = await pool.proxyCall("mini", "retry", "", {
    headers: { AGES_TOKEN: "retry-client", AGES_USER_TOKEN: "retry-user" }
  });
  await new Promise(setImmediate);
  assert.equal(result.backendId, "B");
  assert.deepEqual(seen.map(row => new URL(row.url).hostname), ["synthetic-a", "synthetic-b"]);
  for (const row of seen) {
    assert.equal(row.headers.get("AGES_TOKEN"), "retry-client");
    assert.equal(row.headers.get("AGES_USER_TOKEN"), "retry-user");
    assert.equal(row.headers.get("cookie"), `ASP.NET_SessionId=session-${new URL(row.url).hostname}`);
  }
  assert.equal(pool.getSummary().ready, 2);
});
