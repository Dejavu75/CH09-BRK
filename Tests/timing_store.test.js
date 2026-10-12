const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { AgesConnectionPool } = require("../build/services/ages_pool");
const { TimingStore } = require("../build/services/timing_store");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "broker-timings-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "private", "timings.sqlite");
}

test("timing store upserts a trace, caps 500 records, and clears durably", t => {
  const file = fixture(t);
  const store = new TimingStore(file);
  for (let index = 0; index < 502; index++) store.upsert({ id: `trace-${index}`, index });
  store.upsert({ id: "trace-501", index: 900 });
  assert.equal(store.load().length, 500);
  assert.equal(store.load()[0].id, "trace-2");
  assert.equal(store.load().at(-1).index, 900);
  store.close();

  const reopened = new TimingStore(file);
  assert.equal(reopened.load().length, 500);
  assert.equal(reopened.clear(), 500);
  reopened.close();
  const afterClear = new TimingStore(file);
  assert.deepEqual(afterClear.load(), []);
  afterClear.close();
});

test("finalized proxy timing survives recreation without request, response, or query secrets", async t => {
  const file = fixture(t);
  const originalFetch = global.fetch;
  global.fetch = async url => String(url).includes("dummy_val")
    ? new Response("ready", { headers: { AGES_TOKEN: "synthetic-token", "set-cookie": "ASP.NET_SessionId=synthetic-session" } })
    : new Response('{"secret":"synthetic-response-secret"}', { headers: { "content-type": "application/json" } });
  try {
    const first = new AgesConnectionPool("http://synthetic/ages", [{ kind: "bigb" }], undefined,
      { timingStorePath: file });
    await first.warmUp();
    const result = await first.proxyCall("bigb", "login.autorizar", "key=synthetic-query-secret",
      { method: "POST", body: "synthetic-request-secret", headers: { AGES_PASS: "synthetic-header-secret" } });
    first.completeTraceResponse(result.traceId, result.status, result.body.length);
    const current = first.getTimingLog().find(row => row.id === result.traceId);
    assert.equal(current.status, 200);
    assert.ok(current.brokerOutAt);
    first.closeTimingStore();

    const second = new AgesConnectionPool("http://synthetic/ages", [{ kind: "bigb" }], undefined,
      { timingStorePath: file });
    const restored = second.getTimingLog().find(row => row.id === result.traceId);
    assert.equal(restored.totalMs, current.totalMs);
    assert.equal(restored.url, "/ages/login.autorizar.ages");
    assert.equal(restored.bytes, result.body.length);
    const disk = fs.readdirSync(path.dirname(file)).map(name => fs.readFileSync(path.join(path.dirname(file), name))).join(" ");
    for (const secret of ["synthetic-response-secret", "synthetic-request-secret", "synthetic-header-secret", "synthetic-query-secret"]) {
      assert.ok(!JSON.stringify(restored).includes(secret));
      assert.ok(!disk.includes(secret), `${secret} was persisted`);
    }
    assert.equal(second.clearTimingLog().cleared, 1);
    second.closeTimingStore();
    const third = new AgesConnectionPool("http://synthetic/ages", [{ kind: "bigb" }], undefined,
      { timingStorePath: file });
    assert.equal(third.getTimingLog().length, 0);
    third.closeTimingStore();
  } finally {
    global.fetch = originalFetch;
  }
});

test("invalid timing database path fails closed", t => {
  assert.throws(() => new TimingStore("timings.sqlite"), /absolute/);
  const file = fixture(t);
  fs.mkdirSync(file, { recursive: true });
  assert.throws(() => new TimingStore(file), /regular file/);
});

test("events persist without arbitrary error text and clear does not resurrect in-flight traces", t => {
  const file = fixture(t);
  const first = new AgesConnectionPool("http://synthetic/ages", [], undefined, { timingStorePath: file });
  first.pushTimingEvent("IIS restart fail: synthetic-event-secret", "synthetic-error-secret");
  const pending = first.createTimingTrace("bigb", "GET", "http://synthetic/ages/check.ages?token=synthetic-query-secret",
    "invalid-ip-secret", "invalid-source-secret", Date.now());
  assert.equal(first.clearTimingLog().cleared, 2);
  first.completeTimingTrace(pending);
  first.closeTimingStore();
  const second = new AgesConnectionPool("http://synthetic/ages", [], undefined, { timingStorePath: file });
  assert.deepEqual(second.getTimingLog(), []);
  second.pushTimingEvent("IIS restart fail: synthetic-event-secret", "synthetic-error-secret");
  const event = second.getTimingLog()[0];
  assert.equal(event.url, "IIS restart fail");
  assert.equal(event.error, "event_error");
  second.closeTimingStore();
  const third = new AgesConnectionPool("http://synthetic/ages", [], undefined, { timingStorePath: file });
  assert.equal(third.getTimingLog().length, 1);
  assert.ok(!JSON.stringify(third.getTimingLog()).includes("synthetic-secret"));
  third.closeTimingStore();
});
