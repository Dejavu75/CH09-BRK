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
