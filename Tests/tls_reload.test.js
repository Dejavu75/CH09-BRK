const assert = require("node:assert/strict");
const test = require("node:test");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

test("TLS credentials reload atomically and retry after a partial renewal", t => {
  const { startTlsCertificateReload } = require("../build/services/tls_reloader");
  const directory = mkdtempSync(join(tmpdir(), "broker-tls-reload-"));
  const certPath = join(directory, "fullchain.pem");
  const keyPath = join(directory, "privkey.pem");
  writeFileSync(certPath, "certificate-1");
  writeFileSync(keyPath, "key-1");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  let sweep;
  let interval;
  let unrefed = false;
  let cleared = false;
  const applied = [];
  const warnings = [];
  const timer = { unref: () => { unrefed = true; } };
  const target = {
    setSecureContext(credentials) {
      const cert = credentials.cert.toString();
      const key = credentials.key.toString();
      if (cert.at(-1) !== key.at(-1)) throw new Error("certificate/key mismatch");
      applied.push({ cert, key });
    }
  };

  const stop = startTlsCertificateReload(target, {
    certPath,
    keyPath,
    intervalMs: 1234,
    setInterval: (callback, delay) => {
      sweep = callback;
      interval = delay;
      return timer;
    },
    clearInterval: handle => {
      assert.equal(handle, timer);
      cleared = true;
    },
    onError: message => warnings.push(message)
  });

  assert.equal(interval, 1234);
  assert.equal(unrefed, true);
  sweep();
  assert.deepEqual(applied, []);

  writeFileSync(certPath, "certificate-2");
  sweep();
  assert.deepEqual(applied, []);
  assert.equal(warnings.length, 1);

  writeFileSync(keyPath, "key-2");
  sweep();
  assert.deepEqual(applied, [{ cert: "certificate-2", key: "key-2" }]);
  sweep();
  assert.equal(applied.length, 1);

  stop();
  assert.equal(cleared, true);
});
