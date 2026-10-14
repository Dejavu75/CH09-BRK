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

test("timing store retains records beyond 500 and pages stably across restart", t => {
  const file = fixture(t);
  const store = new TimingStore(file);
  for (let index = 0; index < 502; index++) store.upsert({ id: `trace-${index}`, index });
  store.upsert({ id: "trace-501", index: 900 });
  const firstPage = store.page();
  assert.equal(firstPage.rows.length, 100);
  assert.equal(firstPage.rows[0].index, 900);
  assert.equal(firstPage.rows.at(-1).id, "trace-402");
  store.upsert({ id: "new-trace" });
  const secondPage = store.page(firstPage.nextCursor);
  assert.equal(secondPage.rows[0].id, "trace-401");
  const ids = [...firstPage.rows, ...secondPage.rows];
  let cursor = secondPage.nextCursor;
  while (cursor !== undefined) {
    const page = store.page(cursor);
    ids.push(...page.rows);
    cursor = page.nextCursor;
  }
  assert.equal(ids.length, 502);
  assert.equal(ids.at(-1).id, "trace-0");
  store.close();

  const reopened = new TimingStore(file);
  assert.equal(reopened.page().rows[0].id, "new-trace");
  assert.equal(reopened.clear(), 503);
  reopened.close();
  const afterClear = new TimingStore(file);
  assert.deepEqual(afterClear.page(), { rows: [] });
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
    const current = first.getTimingLog().rows.find(row => row.id === result.traceId);
    assert.equal(current.status, 200);
    assert.ok(current.brokerOutAt);
    first.closeTimingStore();

    const second = new AgesConnectionPool("http://synthetic/ages", [{ kind: "bigb" }], undefined,
      { timingStorePath: file });
    const restored = second.getTimingLog().rows.find(row => row.id === result.traceId);
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
    assert.equal(third.getTimingLog().rows.length, 0);
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
  assert.equal(first.clearTimingLog().cleared, 1);
  first.completeTimingTrace(pending);
  first.closeTimingStore();
  const second = new AgesConnectionPool("http://synthetic/ages", [], undefined, { timingStorePath: file });
  assert.deepEqual(second.getTimingLog(), { rows: [] });
  second.pushTimingEvent("IIS restart fail: synthetic-event-secret", "synthetic-error-secret");
  const event = second.getTimingLog().rows[0];
  assert.equal(event.url, "IIS restart fail");
  assert.equal(event.error, "event_error");
  second.closeTimingStore();
  const third = new AgesConnectionPool("http://synthetic/ages", [], undefined, { timingStorePath: file });
  assert.equal(third.getTimingLog().rows.length, 1);
  assert.ok(!JSON.stringify(third.getTimingLog()).includes("synthetic-secret"));
  third.closeTimingStore();
});

test("clear between upstream completion and response update cannot resurrect a trace", t => {
  const file = fixture(t);
  const pool = new AgesConnectionPool("http://synthetic/ages", [], undefined, { timingStorePath: file });
  const trace = pool.createTimingTrace("bigb", "GET", "http://synthetic/ages/test.ages", "", "", Date.now());
  pool.completeTimingTrace(trace);
  assert.equal(pool.getTimingLog().rows.length, 1);
  assert.equal(pool.clearTimingLog().cleared, 1);
  assert.equal(pool.completeTraceResponse(trace.id, 200, 10), undefined);
  assert.deepEqual(pool.getTimingLog(), { rows: [] });
  pool.closeTimingStore();
});

test("first timing page includes bounded live traces without persisting or resurrecting them", t => {
  const file = fixture(t);
  const pool = new AgesConnectionPool("http://synthetic/ages", [], undefined, { timingStorePath: file });
  const live = Array.from({ length: 102 }, (_, index) => pool.createTimingTrace(
    "bigb", "GET", `http://synthetic/ages/test${index}.ages?secret=hidden`, "", "", index
  ));
  const first = pool.getTimingLog();
  assert.deepEqual(first.rows, []);
  assert.equal(first.liveRows.length, 100);
  assert.equal(first.liveRows[0].id, live[101].id);
  assert.equal(first.liveRows.at(-1).id, live[2].id);
  assert.ok(!JSON.stringify(first).includes("hidden"));
  assert.deepEqual(pool.getTimingLog(1), { rows: [] }, "older history must not repeat live traces");

  const reopened = new AgesConnectionPool("http://synthetic/ages", [], undefined, { timingStorePath: file });
  assert.deepEqual(reopened.getTimingLog(), { rows: [] }, "live traces must not be persisted");
  reopened.closeTimingStore();

  assert.equal(pool.clearTimingLog().cleared, 0);
  assert.deepEqual(pool.getTimingLog(), { rows: [] });
  for (const trace of live) pool.completeTimingTrace(trace);
  assert.deepEqual(pool.getTimingLog(), { rows: [] }, "cleared live traces must not reappear after completion");
  pool.closeTimingStore();
});
