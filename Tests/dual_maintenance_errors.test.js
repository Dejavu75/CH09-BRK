const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { AgesConnectionPool } = require('../build/services/ages_pool');

async function waitFor(check) {
  const deadline = Date.now() + 1500;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'La recuperación dual debe avanzar sin tráfico externo');
    await new Promise(resolve => setTimeout(resolve, 3));
  }
}

async function fixture(t, options = {}) {
  const statuses = { A: 201, B: 201 };
  let release;
  const server = http.createServer((req, res) => {
    const id = req.url.startsWith('/a/') ? 'A' : 'B';
    const send = () => {
      const status = statuses[id];
      res.writeHead(status, status === 201 ? {
        AGES_TOKEN: `test-${id}`, 'Set-Cookie': `ASP.NET_SessionId=test-${id}; Path=/`
      } : {});
      res.end(status === 201 ? 'ok' : 'upstream unavailable');
    };
    if (req.url.includes('hold.ages')) { release = send; return; }
    send();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const recycled = [];
  let pool;
  pool = new AgesConnectionPool(url,
    Array.from({ length: options.size || 4 }, () => ({ kind: 'mini' })),
    { mode: 'dual', backends: [{ id: 'A', baseUrl: `${url}/a` }, { id: 'B', baseUrl: `${url}/b` }] },
    { pollMs: 2, drainTimeoutMs: 500, recycleExecutor: async id => {
      assert.ok(pool.slots.filter(slot => slot.backendId === id)
        .every(slot => !slot.inUse && slot.maintenanceInFlight === 0));
      recycled.push(id);
      statuses[id] = 201;
    } });
  pool.restartAgesHost = async () => { assert.fail('Dual no debe reiniciar IIS global'); };
  t.after(() => pool.closeTimingStore());
  return { pool, statuses, recycled, held: () => !!release, release: () => release() };
}

for (const status of [500, 503]) {
  test(`recupera warmup dual ${status} sin solicitudes y conserva el backend sano`, async t => {
    const { pool, statuses, recycled } = await fixture(t);
    statuses.A = status;
    const before = await pool.warmUp();
    assert.equal(before.error, 2);
    assert.equal(before.backends[1].ready, 2);
    await waitFor(() => pool.getSummary().ready === 4);
    assert.deepEqual(recycled, ['A']);
    assert.equal(pool.getSummary().backends[1].state, 'active');
    assert.equal((await pool.proxyCall('mini', 'check')).status, 201);
  });
}

test('503 de mantenimiento drena operaciones activas y mantiene al peer atendiendo', async t => {
  const f = await fixture(t, { size: 6 });
  await f.pool.warmUp();
  const first = f.pool.proxyCall('mini', 'hold');
  await waitFor(f.held);
  f.statuses.A = 503;
  await f.pool.runPingSweep();
  await waitFor(() => f.pool.getSummary().backends[0].state === 'draining');
  assert.deepEqual(f.recycled, []);
  const peer = await f.pool.proxyCall('mini', 'peer');
  assert.equal(peer.backendId, 'B');
  assert.equal(peer.status, 201);
  f.statuses.A = 201;
  f.release();
  assert.equal((await first).status, 201);
  await waitFor(() => f.pool.getSummary().ready === 6 && f.recycled.length === 1);
  assert.deepEqual(f.recycled, ['A']);
});

test('dos conexiones del mismo backend con 500 y 503 persistentes forman una sola recuperación', async t => {
  const { pool, statuses, recycled } = await fixture(t);
  await pool.warmUp();
  const [first, second] = pool.slots.filter(slot => slot.backendId === 'A');
  statuses.A = 500;
  await pool.pingSlot(first);
  await pool.pingSlot(first);
  await new Promise(setImmediate);
  assert.deepEqual(recycled, []);
  statuses.A = 503;
  await pool.pingSlot(second);
  await waitFor(() => pool.getSummary().ready === 4);
  assert.deepEqual(recycled, ['A']);
});

test('si ambos backends fallan no fuerza reciclados sin un peer sano', async t => {
  const { pool, statuses, recycled } = await fixture(t);
  statuses.A = 503;
  statuses.B = 500;
  assert.equal((await pool.warmUp()).error, 4);
  await new Promise(setImmediate);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(recycled, []);
  assert.deepEqual(pool.getSummary().backends.map(x => x.state), ['degraded', 'degraded']);
});
