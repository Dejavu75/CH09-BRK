const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { AgesConnectionPool } = require('../build/services/ages_pool');

async function scenario(t, run) {
  let status = 503;
  const server = http.createServer((_req, res) => {
    res.writeHead(status, status === 201 ? {
      AGES_TOKEN: 'test-token', 'Set-Cookie': 'ASP.NET_SessionId=test-session; Path=/'
    } : {});
    res.end(status === 503 ? 'Service Unavailable' : 'ok');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const pool = new AgesConnectionPool(url, [{ kind: 'mini' }, { kind: 'mini' }],
    { mode: 'legacy', backends: [{ id: 'legacy', baseUrl: url }] },
    { drainTimeoutMs: 100, pollMs: 2 });
  t.after(() => pool.timingStore.close());
  await run(pool, value => { status = value; });
}

async function waitFor(check) {
  const deadline = Date.now() + 1500;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'La recuperación debe ejecutarse sin tráfico externo');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('recupera un warmup legacy 503 sin solicitudes externas y deduplica el reinicio', async t => {
  await scenario(t, async (pool, setStatus) => {
    let restarts = 0;
    pool.restartAgesHost = async reason => {
      assert.equal(reason, 'ages_503_maintenance');
      assert.ok(pool.slots.every(slot => !slot.inUse && slot.maintenanceInFlight === 0));
      restarts++;
      setStatus(201);
      void pool.startWarmUp('recuperación de prueba');
      return true;
    };
    const failed = await pool.warmUp();
    assert.equal(failed.error, 2);
    await waitFor(() => pool.getSummary().ready === 2);
    assert.equal(restarts, 1);
    assert.equal(pool.getSummary().error, 0);
  });
});

test('el mantenimiento espera las operaciones activas antes de reiniciar', async t => {
  await scenario(t, async (pool, setStatus) => {
    setStatus(201);
    await pool.warmUp();
    let restarts = 0;
    pool.restartAgesHost = async () => { restarts++; return false; };
    pool.slots[1].inUse = true;
    setStatus(503);
    await pool.runPingSweep();
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(restarts, 0);
    pool.slots[1].inUse = false;
    await waitFor(() => restarts === 1);
    await waitFor(() => pool.getSummary().backends[0].state === 'active');
  });
});

test('un warmup legacy 500 conserva el comportamiento anterior sin reiniciar IIS', async t => {
  await scenario(t, async (pool, setStatus) => {
    setStatus(500);
    let restarts = 0;
    pool.restartAgesHost = async () => { restarts++; return false; };
    assert.equal((await pool.warmUp()).error, 2);
    await new Promise(setImmediate);
    assert.equal(restarts, 0);
  });
});

test('un warmup público no reabre legacy mientras el reinicio automático está pendiente', async t => {
  await scenario(t, async (pool, setStatus) => {
    let endRestart;
    pool.restartAgesHost = async () => {
      await new Promise(resolve => { endRestart = resolve; });
      return false;
    };
    await pool.warmUp();
    await waitFor(() => !!endRestart);
    setStatus(201);
    await assert.rejects(pool.warmUp('warmup manual'), /legacy maintenance recovery/);
    assert.equal(pool.getSummary().backends[0].state, 'draining');
    await assert.rejects(pool.proxyCall('mini', 'check'), /warmup/);
    endRestart();
    await waitFor(() => !pool.legacyMaintenanceRecoveryScheduled);
    assert.equal((await pool.warmUp()).ready, 2);
    assert.equal((await pool.proxyCall('mini', 'check')).status, 201);
  });
});

test('un drenaje legacy vencido no ejecuta reinicio y restaura el estado', async t => {
  await scenario(t, async (pool, setStatus) => {
    setStatus(201);
    await pool.warmUp();
    let restarts = 0;
    pool.restartAgesHost = async () => { restarts++; return false; };
    pool.slots[1].inUse = true;
    setStatus(503);
    await pool.runPingSweep();
    await waitFor(() => pool.legacyMaintenanceRecoveryScheduled);
    await waitFor(() => !pool.legacyMaintenanceRecoveryScheduled);
    assert.equal(restarts, 0);
    assert.equal(pool.getSummary().backends[0].state, 'active');
    pool.slots[1].inUse = false;
  });
});
