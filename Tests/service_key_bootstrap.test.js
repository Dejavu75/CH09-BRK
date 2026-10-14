const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { loadServiceKey } = require("../build/auth/service_key");

test("generates one private service key in durable state and reuses it", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "broker-service-key-"));
  try {
    fs.chmodSync(directory, 0o700);
    const database = path.join(directory, "sessions.sqlite");
    const first = loadServiceKey(undefined, database);
    const second = loadServiceKey(undefined, database);
    assert.equal(first, second);
    assert.ok(Buffer.byteLength(first) >= 32);
    const stat = fs.lstatSync(path.join(directory, "service-api-key"));
    assert.ok(stat.isFile());
    if (process.platform !== "win32") assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(loadServiceKey("explicit-service-key-with-at-least-32-bytes", database),
      "explicit-service-key-with-at-least-32-bytes");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a weak override and an insecure state directory", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "broker-service-key-"));
  try {
    assert.throws(() => loadServiceKey("weak", path.join(directory, "sessions.sqlite")));
    if (process.platform !== "win32") {
      fs.chmodSync(directory, 0o755);
      assert.throws(() => loadServiceKey(undefined, path.join(directory, "sessions.sqlite")));
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
