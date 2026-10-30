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
    Array.from({ length: options.size || 4 }, (_, i) => ({ kind: options.mixed && i >= 4 ? 'bigb' : 'mini' })),
    { mode: 'dual', backends: [{ id: 'A', baseUrl: `${url}/a` }, { id: 'B', baseUrl: `${url}/b` }] },
    { pollMs: 2, drainTimeoutMs: options.drainTimeoutMs || 500,
      recoveryNow: options.recoveryNow, recycleExecutor: async id => {
      assert.ok(pool.slots.filter(slot => slot.backendId === id)
        .every(slot => !slot.inUse && slot.maintenanceInFlight === 0));
      recycled.push(id);
      if (options.recycle) await options.recycle(id, pool, statuses);
      else statuses[id] = 201;
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

test('recupera primero A y confirma su warmup antes de reciclar B, sin IIS global', async t => {
  const observed = [];
  const { pool, statuses, recycled } = await fixture(t, { recycle: async (id, pool, statuses) => {
    observed.push([id, pool.getSummary().backends[0].state]);
    statuses[id] = 201;
  } });
  statuses.A = 503;
  statuses.B = 500;
  assert.equal((await pool.warmUp()).error, 4);
  await waitFor(() => pool.getSummary().ready === 4 && !pool.lifecycle);
  assert.deepEqual(recycled, ['A', 'B']);
  assert.deepEqual(observed, [['A', 'recycling'], ['B', 'active']]);
  assert.equal((await pool.proxyCall('mini', 'check')).status, 201);
});

test('un fallo SSH o warmup de A detiene la secuencia antes de B', async t => {
  for (const failSsh of [true, false]) {
    const f = await fixture(t, { drainTimeoutMs: 30, recycle: async () => {
      if (failSsh) throw new Error('SSH simulado fallido');
    } });
    f.statuses.A = 503;
    f.statuses.B = 500;
    await f.pool.warmUp();
    await waitFor(() => f.recycled.length === 1 && !f.pool.lifecycle);
    assert.deepEqual(f.recycled, ['A']);
    assert.deepEqual(f.pool.getSummary().backends.map(x => x.state), ['degraded', 'degraded']);
    await f.pool.runPingSweep();
    await new Promise(setImmediate);
    assert.deepEqual(f.recycled, ['A'], 'No debe reintentar durante la pausa');
  }
});

test('la pausa protege también B cuando A se recupera y B falla', async t => {
  const f = await fixture(t, { recycle: async (id, pool, statuses) => {
    if (id === 'B') throw new Error('SSH simulado fallido');
    statuses.A = 201;
  } });
  f.statuses.A = 503;
  f.statuses.B = 503;
  await f.pool.warmUp();
  await waitFor(() => f.recycled.length === 2 && !f.pool.lifecycle);
  await f.pool.runPingSweep();
  await new Promise(setImmediate);
  assert.deepEqual(f.recycled, ['A', 'B']);
  assert.equal(f.pool.getSummary().backends[0].state, 'active');
});

for (const timeout of [false, true]) {
  test(`el rescate dual respeta el drenaje activo${timeout ? ' y no reinicia si vence el plazo' : ''}`, async t => {
    const f = await fixture(t, { size: 6, drainTimeoutMs: timeout ? 35 : 500 });
    await f.pool.warmUp();
    const held = f.pool.proxyCall('mini', 'hold');
    await waitFor(f.held);
    f.statuses.A = 503; f.statuses.B = 500;
    await f.pool.runPingSweep();
    await waitFor(() => f.pool.getSummary().backends[0].state === 'draining');
    assert.deepEqual(f.recycled, []);
    if (timeout) {
      await waitFor(() => !f.pool.lifecycle);
      assert.deepEqual(f.recycled, [], 'Un drenaje fallido nunca debe ejecutar AppPool');
    }
    f.statuses.A = 201;
    f.release();
    assert.equal((await held).status, 201);
    if (!timeout) {
      await waitFor(() => f.pool.getSummary().ready === 6 && !f.pool.lifecycle);
      assert.deepEqual(f.recycled, ['A', 'B']);
    }
  });
}

test('deduplica la recuperación dual y excluye reciclados manuales y warmup concurrentes', async t => {
  let release;
  const f = await fixture(t, { recycle: async (id, pool, statuses) => {
    if (id === 'A') await new Promise(resolve => { release = resolve; });
    statuses[id] = 201;
  } });
  f.statuses.A = 500;
  f.statuses.B = 503;
  await f.pool.warmUp();
  await waitFor(() => !!release);
  await f.pool.runPingSweep();
  await assert.rejects(f.pool.warmUp(), /recycling/);
  await assert.rejects(f.pool.drainAndRecycleBackend('B'), /already recycling/);
  assert.deepEqual(f.recycled, ['A']);
  release();
  await waitFor(() => f.pool.getSummary().ready === 4 && !f.pool.lifecycle);
  assert.deepEqual(f.recycled, ['A', 'B']);
});

test('la pausa de cinco minutos y el máximo de dos ciclos no se reinician tras un éxito', async t => {
  let now = 1000;
  const f = await fixture(t, { recoveryNow: () => now });
  const failBoth = async () => {
    f.statuses.A = 500; f.statuses.B = 503;
    await f.pool.warmUp();
    await new Promise(setImmediate);
    await waitFor(() => !f.pool.lifecycle && f.pool.scheduledBackendRecycles.size === 0);
  };
  await failBoth();
  assert.deepEqual(f.recycled, ['A', 'B']);
  now += 299999;
  await failBoth();
  assert.equal(f.recycled.length, 2);
  now += 1;
  await failBoth();
  assert.deepEqual(f.recycled, ['A', 'B', 'A', 'B']);
  now += 300000;
  await failBoth();
  assert.equal(f.recycled.length, 4, 'El tercer ciclo exige intervención');
});

test('no combina un único slot de cada backend ni errores ajenos a 500/503', async t => {
  for (const options of [{ size: 2 }, { size: 4, status: 502 }]) {
    const f = await fixture(t, options);
    f.statuses.A = options.status || 500; f.statuses.B = 503;
    await f.pool.warmUp();
    await new Promise(setImmediate);
    assert.deepEqual(f.recycled, []);
  }
});

test('conserva el guard público de peer sano cuando se pide un reciclado manual', async t => {
  const { pool, statuses, recycled } = await fixture(t);
  await pool.warmUp();
  statuses.B = 502;
  await pool.runPingSweep();
  await assert.rejects(pool.drainAndRecycleBackend('A'), /not active and ready/);
  assert.deepEqual(recycled, []);
});

test('mide la pausa desde el final y limita también los intentos fallidos', async t => {
  let now = 1000;
  const f = await fixture(t, { recoveryNow: () => now, recycle: async () => {
    now += 900000;
    throw new Error('SSH simulado fallido');
  } });
  const sweep = async () => {
    await f.pool.warmUp();
    await new Promise(setImmediate);
    await waitFor(() => !f.pool.lifecycle && f.pool.scheduledBackendRecycles.size === 0);
  };
  f.statuses.A = 500; f.statuses.B = 503;
  await sweep();
  assert.equal(f.recycled.length, 1);
  now += 299999;
  await sweep();
  assert.equal(f.recycled.length, 1);
  now++;
  await sweep();
  assert.equal(f.recycled.length, 2);
  now += 3600000;
  await sweep();
  assert.equal(f.recycled.length, 2);
});

test('confirma Mini y BigBoy de A antes de B sin solapar ejecutores', async t => {
  let active = 0;
  const f = await fixture(t, { size: 8, mixed: true, recycle: async (id, pool, statuses) => {
    assert.equal(active++, 0);
    if (id === 'B') {
      assert.ok(pool.getSummary().slots.filter(slot => slot.backendId === 'A')
        .every(slot => slot.status === 'ready'));
    }
    await new Promise(resolve => setTimeout(resolve, 3));
    statuses[id] = 201;
    active--;
  } });
  f.statuses.A = 503; f.statuses.B = 500;
  await f.pool.warmUp();
  await waitFor(() => f.pool.getSummary().ready === 8 && !f.pool.lifecycle);
  assert.deepEqual(f.recycled, ['A', 'B']);
  assert.equal((await f.pool.proxyCall('bigb', 'check')).status, 201);
});
