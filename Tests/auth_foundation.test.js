const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const { BrokerAuthService } = require("../build/auth/auth_service");
const { CredentialFile } = require("../build/auth/credentials");

function fixture(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-auth-test-"));
  const credentialFile = path.join(dir, "users.htpasswd");
  const databaseFile = path.join(dir, "state", "sessions.sqlite");
  fs.writeFileSync(credentialFile, `alice:${bcrypt.hashSync("synthetic-secret", 4)}\n`);
  const config = { publicOrigin: "https://broker.example.test", credentialFile, databaseFile,
    sessionTtlSeconds: 60, loginLimit: 2, loginWindowSeconds: 60, ...extra };
  return { config, credentialFile, databaseFile, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("built-in Broker accounts need no credential file and reject unknown users", async t => {
  const users = new CredentialFile();
  for (const username of ["guillermo.negrete", "diego.zacur"]) {
    assert.match(users.fingerprint(username), /^[a-f0-9]{64}$/);
    assert.equal(await users.verify(username, "incorrect-synthetic-password"), false);
  }
  assert.equal(users.fingerprint("unknown"), null);
  assert.equal(await users.verify("unknown", "incorrect-synthetic-password"), false);
  const { config, cleanup } = fixture({ credentialFile: undefined });
  const auth = new BrokerAuthService(config);
  t.after(() => { auth.close(); cleanup(); });
  assert.equal((await auth.login({ username: "unknown", password: "incorrect-synthetic-password",
    clientKey: "unknown", origin: config.publicOrigin })).status, 401);
});

test("htpasswd-format bcrypt records authenticate and malformed files fail closed", async t => {
  const { credentialFile, cleanup } = fixture();
  t.after(cleanup);
  const users = new CredentialFile(credentialFile);
  assert.equal(await users.verify("alice", "synthetic-secret"), true);
  assert.equal(await users.verify("alice", "wrong"), false);
  assert.equal(await users.verify("missing", "synthetic-secret"), false);
  assert.equal(await users.verify("alice", "x".repeat(73)), false);
  fs.appendFileSync(credentialFile, `alice:${bcrypt.hashSync("other", 4)}\n`);
  assert.throws(() => new CredentialFile(credentialFile), /duplicate/);
});

test("login is origin-bound, rate-limited, and creates a hashed durable session", async t => {
  const { config, databaseFile, cleanup } = fixture();
  const auth = new BrokerAuthService(config);
  const input = { username: "alice", password: "synthetic-secret", clientKey: "client-1", origin: config.publicOrigin };
  assert.equal((await auth.login({ ...input, origin: "https://evil.example" }, 1000)).status, 403);
  assert.equal((await auth.login({ ...input, password: "wrong" }, 1000)).status, 401);
  assert.equal((await auth.login({ ...input, password: "wrong" }, 1000)).status, 401);
  assert.equal((await auth.login(input, 1000)).status, 429);
  const login = await auth.login(input, 61_001);
  assert.equal(login.status, 200);
  assert.match(login.setCookie, /^__Host-broker_session=[^;]+; Max-Age=60; Path=\/; Secure; HttpOnly; SameSite=Strict$/);
  const token = login.setCookie.split(";")[0].split("=")[1];
  assert.equal(fs.readFileSync(databaseFile).includes(Buffer.from(token)), false);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(databaseFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(databaseFile)).mode & 0o777, 0o700);
  }
  auth.close();
  if (process.platform !== "win32") {
    fs.chmodSync(databaseFile, 0o666);
    fs.chmodSync(path.dirname(databaseFile), 0o777);
  }
  const restarted = new BrokerAuthService(config);
  t.after(() => { restarted.close(); cleanup(); });
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(databaseFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(databaseFile)).mode & 0o777, 0o700);
  }
  assert.equal(restarted.session(login.setCookie, 61_001).username, "alice");
});

test("mutations need exact Origin and CSRF; logout revokes; expiry rejects", async t => {
  const { config, cleanup } = fixture();
  const auth = new BrokerAuthService(config);
  t.after(() => { auth.close(); cleanup(); });
  const login = await auth.login({ username: "alice", password: "synthetic-secret", clientKey: "client", origin: config.publicOrigin }, 1000);
  const request = { cookieHeader: login.setCookie, method: "POST", origin: config.publicOrigin, csrfToken: login.csrfToken };
  assert.equal(auth.verify(request, 1000).status, 204);
  assert.equal(auth.verify({ ...request, csrfToken: "wrong" }, 1000).status, 403);
  assert.equal(auth.verify({ ...request, origin: "https://evil.example" }, 1000).status, 403);
  assert.equal(auth.logout({ cookieHeader: login.setCookie, origin: config.publicOrigin, csrfToken: "wrong" }, 1000).status, 403);
  assert.equal(auth.logout(request, 1000).status, 200);
  assert.equal(auth.verify(request, 1000).status, 401);
  const next = await auth.login({ username: "alice", password: "synthetic-secret", clientKey: "client", origin: config.publicOrigin }, 1000);
  assert.equal(auth.verify({ cookieHeader: next.setCookie, method: "GET" }, 62_000).status, 401);
});

test("invalid auth configuration and missing credential source fail closed", t => {
  const { config, cleanup } = fixture();
  t.after(cleanup);
  assert.throws(() => new BrokerAuthService({ ...config, publicOrigin: "http://broker.example.test" }), /HTTPS/);
  assert.throws(() => new BrokerAuthService({ ...config, credentialFile: "missing-users.htpasswd" }), /ENOENT/);
});

test("restart revokes sessions for removed users and rotated credential hashes", async t => {
  const { config, credentialFile, cleanup } = fixture();
  t.after(cleanup);
  const alice = bcrypt.hashSync("synthetic-secret", 4);
  const bob = bcrypt.hashSync("bob-secret", 4);
  fs.writeFileSync(credentialFile, `alice:${alice}\nbob:${bob}\n`);
  let auth = new BrokerAuthService(config);
  const login = await auth.login({ username: "alice", password: "synthetic-secret",
    clientKey: "client", origin: config.publicOrigin }, 1000);
  assert.equal(login.status, 200);
  auth.close();

  fs.writeFileSync(credentialFile, `bob:${bob}\n`);
  auth = new BrokerAuthService(config);
  const Database = require("better-sqlite3");
  let persisted = new Database(config.databaseFile, { readonly: true });
  assert.equal(persisted.prepare("SELECT count(*) AS n FROM sessions").get().n, 0);
  persisted.close();
  assert.equal(auth.session(login.setCookie, 1000).status, 401);
  auth.close();

  fs.writeFileSync(credentialFile, `alice:${alice}\nbob:${bob}\n`);
  auth = new BrokerAuthService(config);
  const next = await auth.login({ username: "alice", password: "synthetic-secret",
    clientKey: "client", origin: config.publicOrigin }, 1000);
  auth.close();
  fs.writeFileSync(credentialFile, `alice:${bcrypt.hashSync("new-secret", 4)}\nbob:${bob}\n`);
  auth = new BrokerAuthService(config);
  persisted = new Database(config.databaseFile, { readonly: true });
  assert.equal(persisted.prepare("SELECT count(*) AS n FROM sessions").get().n, 0);
  persisted.close();
  assert.equal(auth.verify({ cookieHeader: next.setCookie, method: "GET" }, 1000).status, 401);
  assert.equal((await auth.login({ username: "alice", password: "synthetic-secret",
    clientKey: "client", origin: config.publicOrigin }, 1000)).status, 401);
  auth.close();
});

test("legacy unbound sessions are removed on database upgrade", t => {
  const { config, databaseFile, cleanup } = fixture();
  t.after(cleanup);
  fs.mkdirSync(path.dirname(databaseFile));
  const Database = require("better-sqlite3");
  const db = new Database(databaseFile);
  db.exec(`CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, username TEXT NOT NULL,
    csrf_hash TEXT NOT NULL, csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL);
    INSERT INTO sessions VALUES ('legacy', 'alice', 'csrf', 'csrf', 999999, 0, 0);`);
  db.close();
  const auth = new BrokerAuthService(config);
  auth.close();
  const upgraded = new Database(databaseFile);
  assert.equal(upgraded.prepare("SELECT count(*) AS n FROM sessions").get().n, 0);
  upgraded.close();
});

test("auth cleanup removes expired attempts and sessions in bounded batches", async t => {
  const { config, databaseFile, cleanup } = fixture();
  const auth = new BrokerAuthService(config);
  const input = { username: "alice", password: "synthetic-secret", origin: config.publicOrigin };
  for (const clientKey of ["failed-1", "failed-2", "failed-3"]) {
    assert.equal((await auth.login({ ...input, clientKey, password: "wrong" }, 0)).status, 401);
  }
  const expired1 = await auth.login({ ...input, clientKey: "valid-1" }, 0);
  const expired2 = await auth.login({ ...input, clientKey: "valid-2" }, 1_000);
  const active = await auth.login({ ...input, clientKey: "valid-3" }, 50_000);
  const Database = require("better-sqlite3");
  const db = new Database(databaseFile, { readonly: true });
  t.after(() => { db.close(); auth.close(); cleanup(); });
  const count = () => db.prepare("SELECT count(*) AS n FROM sessions").get().n;
  assert.equal(auth.attempts.size, 3);
  assert.equal(count(), 3);

  auth.cleanup(61_000, 1);
  assert.equal(auth.attempts.size, 2);
  assert.equal(count(), 2);
  auth.cleanup(61_000, 1);
  assert.equal(auth.attempts.size, 1);
  assert.equal(count(), 1);
  auth.cleanup(61_000, 1);
  assert.equal(auth.attempts.size, 0);
  assert.equal(count(), 1);
  assert.equal(auth.session(active.setCookie, 61_000).status, 200);
  assert.equal(auth.session(expired1.setCookie, 61_000).status, 401);
  assert.equal(auth.session(expired2.setCookie, 61_000).status, 401);
  assert.throws(() => auth.cleanup(61_000, 0), /batch size/);
});

test("auth cleanup is scheduled, unrefed, and canceled on close", async t => {
  const { config, cleanup } = fixture();
  t.after(cleanup);
  let sweep;
  let interval;
  let unrefed = false;
  let canceled = false;
  const timer = { unref: () => { unrefed = true; } };
  t.mock.method(globalThis, "setInterval", (callback, delay) => {
    sweep = callback;
    interval = delay;
    return timer;
  });
  t.mock.method(globalThis, "clearInterval", handle => {
    assert.equal(handle, timer);
    canceled = true;
  });
  const auth = new BrokerAuthService(config);
  assert.equal(interval, 60_000);
  assert.equal(unrefed, true);
  assert.equal((await auth.login({ username: "alice", password: "wrong",
    clientKey: "failed", origin: config.publicOrigin }, 0)).status, 401);
  assert.equal(auth.attempts.size, 1);
  sweep();
  assert.equal(auth.attempts.size, 0);
  auth.close();
  assert.equal(canceled, true);
});
