const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { AgesConnectionPool } = require('../build/services/ages_pool');

test('restaurar legacy después de rechazar reinicio despierta solicitudes en espera', async t => {
  let failing = false;
  let releaseLong;
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const server = http.createServer((req, res) => {
    const ready = () => {
      res.writeHead(201, { AGES_TOKEN: 'test-token', 'Set-Cookie': 'ASP.NET_SessionId=test-session; Path=/' });
      res.end('ok');
    };
    if (req.url.includes('long.ages')) { releaseLong = ready; signalStarted(); return; }
    if (failing) { res.writeHead(503); res.end('Service Unavailable'); return; }
    ready();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const pool = new AgesConnectionPool(url, [{ kind: 'mini' }, { kind: 'mini' }],
    { mode: 'legacy', backends: [{ id: 'legacy', baseUrl: url }] },
    { drainTimeoutMs: 500, pollMs: 2 });
  // Simular la capacidad máxima configurada sin cambiar el entorno del proceso.
  pool.getMaxSlots = () => 2;
  t.after(() => pool.closeTimingStore());
  await pool.warmUp();
  let restarts = 0;
  pool.restartAgesHost = async () => { restarts++; return false; };
  const first = pool.proxyCall('mini', 'long');
  await started;
  const spare = pool.slots.find(slot => !slot.inUse);
  spare.status = 'error';
  let secondDone = false;
  const second = pool.proxyCall('mini', 'next').then(result => { secondDone = true; return result; });
  const waitFor = async check => {
    const deadline = Date.now() + 1000;
    while (!check()) {
      assert.ok(Date.now() < deadline, 'La solicitud en espera debe continuar sin tráfico adicional');
      await new Promise(resolve => setTimeout(resolve, 2));
    }
  };
  await waitFor(() => pool.slotWaiters.mini.length === 1);
  failing = true;
  await pool.initializeSlot(spare);
  await waitFor(() => pool.getSummary().backends[0].state === 'draining');
  failing = false;
  releaseLong();
  await first;
  await waitFor(() => restarts === 1 && pool.getSummary().backends[0].state === 'active');
  // La línea base no exige recuperación, pero sí debe completar la solicitud.
  await waitFor(() => secondDone);
  assert.equal((await second).status, 201);
  assert.equal(pool.slotWaiters.mini.length, 0);
  assert.equal(restarts, 1);
});
