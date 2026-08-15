const assert = require("node:assert/strict");
const test = require("node:test");

const {
  AgesConnectionPool,
  resolveBackendConfiguration
} = require("../build/services/ages_pool");

const dual = {
  mode: "dual",
  backends: [
    { id: "A", baseUrl: "http://ages-a" },
    { id: "B", baseUrl: "http://ages-b" }
  ]
};

function ready(url, body = "ok") {
  const host = new URL(url).hostname;
  return new Response(body, {
    headers: {
      AGES_TOKEN: `token-${host}`,
      "set-cookie": `ASP.NET_SessionId=session-${host}; Path=/`
    }
  });
}

async function withFetch(handler, run) {
  const original = global.fetch;
  global.fetch = handler;
  try { return await run(); } finally { global.fetch = original; }
}

test("preserves legacy HAAGES when dual variables are absent", () => {
  assert.deepEqual(resolveBackendConfiguration({}, "http://legacy/ages"), {
    mode: "legacy",
    backends: [{ id: "legacy", baseUrl: "http://legacy/ages" }]
  });
});

test("fails closed for partial or invalid dual configuration", () => {
  assert.equal(resolveBackendConfiguration({ HAAGES_A: "http://a", HAAGES_B: "https://b" }).mode, "dual");
  assert.throws(() => resolveBackendConfiguration({ HAAGES_A: "http://a" }), /configured together/);
  assert.throws(
    () => resolveBackendConfiguration({ HAAGES_A: "ftp://a", HAAGES_B: "http://b" }),
    /Invalid AGES backend URL/
  );
});

test("balances the default ten slots five per backend", () => {
  const pool = new AgesConnectionPool("http://legacy", undefined, dual);
  assert.deepEqual(pool.getSummary().backends.map((backend) => backend.slots), [5, 5]);
});

test("keeps tokens and cookies pinned to each slot backend", async () => withFetch(
  async (url, init = {}) => {
    if (!String(url).includes("dummy_val")) {
      const host = new URL(url).hostname;
      const headers = new Headers(init.headers);
      assert.equal(headers.get("AGES_TOKEN"), `token-${host}`);
      assert.match(headers.get("cookie"), new RegExp(`session-${host}`));
    }
    return ready(url);
  },
  async () => {
    const pool = new AgesConnectionPool("http://legacy", [{ kind: "mini" }, { kind: "mini" }], dual);
    await pool.warmUp();
    const first = await pool.proxyCall("mini", "first");
    const second = await pool.proxyCall("mini", "second");
    assert.deepEqual([first.backendId, second.backendId], ["A", "B"]);
    assert.match(first.agesUrl, /ages-a/);
    assert.match(second.agesUrl, /ages-b/);
  }
));

test("balances adaptive growth onto the least-loaded backend", async () => {
  let release;
  await withFetch(async (url) => {
    if (String(url).includes("ages-a") && String(url).includes("hold.ages")) {
      await new Promise((resolve) => { release = resolve; });
    }
    return ready(url);
  }, async () => {
    const pool = new AgesConnectionPool("http://legacy", [{ kind: "mini" }], dual);
    await pool.warmUp();
    const held = pool.proxyCall("mini", "hold");
    await new Promise(setImmediate);
    const grown = await pool.proxyCall("mini", "grown");
    assert.equal(grown.backendId, "B");
    assert.equal(pool.getSummary().slots.find((slot) => slot.id === grown.slotId).dynamic, true);
    release();
    await held;
  });
});
