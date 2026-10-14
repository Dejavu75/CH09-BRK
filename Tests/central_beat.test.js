const assert = require("node:assert/strict");
const { test } = require("node:test");

const { verifyMs07BeatCentrally, MS07_BEAT_VALIDATION_URL } = require("../build/auth/central_beat");

const bearer = "Bearer synthetic.token.signature";

test("accepts only an explicit central validation success", async () => {
  let requests = 0;
  const verify = async (url, init) => {
    requests++;
    assert.equal(url, MS07_BEAT_VALIDATION_URL);
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, bearer);
    assert.ok(init.signal);
    return new Response(JSON.stringify({ valid: true }), { status: 200 });
  };
  assert.equal(await verifyMs07BeatCentrally(bearer, verify), true);
  assert.equal(requests, 1);
  assert.equal(await verifyMs07BeatCentrally(undefined, verify), false);
  assert.equal(await verifyMs07BeatCentrally("Bearer bad\r\nX-Evil: yes", verify), false);
  assert.equal(requests, 1);
});

test("denies errors, redirects, and ambiguous central responses", async () => {
  for (const response of [
    new Response(JSON.stringify({ valid: false }), { status: 200 }),
    new Response("{}", { status: 200 }),
    new Response(JSON.stringify({ valid: true }), { status: 401 }),
    new Response("", { status: 302, headers: { Location: "https://elsewhere.invalid" } }),
    new Response("not-json", { status: 200 })
  ]) {
    assert.equal(await verifyMs07BeatCentrally(bearer, async () => response), false);
  }
  assert.equal(await verifyMs07BeatCentrally(bearer, async () => { throw new Error("offline"); }), false);
});
