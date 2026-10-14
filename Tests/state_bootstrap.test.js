const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { bootstrapStatePaths, validateMount } = require("../scripts/state_bootstrap.cjs");
const { SessionStore } = require("../build/auth/session_store");
const { TimingStore } = require("../build/services/timing_store");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "broker-state-bootstrap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "logdir");
}

function mountInfo(mountPath, type = "ext4", mode = "rw") {
  const encoded = mountPath.replace(/ /g, "\\040");
  return `100 99 8:1 / ${encoded} ${mode},relatime - ${type} /dev/sda1 ${mode},errors=remount-ro\n`;
}

test("root accepts an operator-owned private log mount without changing its owner", t => {
  const mountPath = fixture(t);
  fs.mkdirSync(mountPath);
  const originalGetuid = process.getuid;
  const originalLstat = fs.lstatSync;
  const child = path.join(mountPath, "broker-state");
  let mountMode = 0o750;
  let stateOwner;
  process.getuid = () => 0;
  fs.lstatSync = pathToStat => {
    const stat = originalLstat(pathToStat);
    if (pathToStat === mountPath) {
      return Object.assign(Object.create(stat), { uid: 1000, mode: (stat.mode & ~0o777) | mountMode });
    }
    if (pathToStat === child && stateOwner !== undefined) {
      return Object.assign(Object.create(stat), { uid: stateOwner });
    }
    return stat;
  };
  t.after(() => {
    fs.lstatSync = originalLstat;
    if (originalGetuid) process.getuid = originalGetuid;
    else delete process.getuid;
  });

  assert.doesNotThrow(() => validateMount(mountPath, mountInfo(mountPath)));
  assert.equal(bootstrapStatePaths({}, { mountPath, mountInfo: mountInfo(mountPath) }).auth,
    path.join(child, "sessions.sqlite"));
  assert.equal(originalLstat(child).uid, originalGetuid?.() ?? 0);
  mountMode = 0o770;
  assert.throws(() => validateMount(mountPath, mountInfo(mountPath)), /untrusted user/);
  mountMode = 0o750;
  process.getuid = () => 2000;
  assert.throws(() => validateMount(mountPath, mountInfo(mountPath)), /untrusted user/);
  process.getuid = () => 0;
  stateOwner = 1000;
  assert.throws(() => bootstrapStatePaths({}, { mountPath, mountInfo: mountInfo(mountPath) }),
    /owned by another user/);
});

test("defaults need an exact, writable, local, non-symlinked log mount", t => {
  const mountPath = fixture(t);
  assert.throws(() => bootstrapStatePaths({}, { mountPath, mountInfo: mountInfo(mountPath) }), /ENOENT/);
  fs.mkdirSync(mountPath);
  assert.throws(() => bootstrapStatePaths({}, { mountPath, mountInfo: "" }), /exact mountpoint/);
  assert.throws(() => bootstrapStatePaths({}, { mountPath, mountInfo: mountInfo(mountPath) + mountInfo(mountPath) }), /ambiguous/);
  for (const type of ["overlay", "tmpfs", "nfs", "cifs", "9p", "fuse"])
    assert.throws(() => bootstrapStatePaths({}, { mountPath, mountInfo: mountInfo(mountPath, type) }), /allowed local/);
  assert.throws(() => bootstrapStatePaths({}, { mountPath, mountInfo: mountInfo(mountPath, "ext4", "ro") }), /read-only/);
  const link = path.join(path.dirname(mountPath), "link");
  fs.symlinkSync(mountPath, link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => bootstrapStatePaths({}, { mountPath: link, mountInfo: mountInfo(link) }), /real directory/);
});

test("only two absent paths receive private defaults; explicit paths stay untouched", t => {
  const mountPath = fixture(t);
  assert.equal(bootstrapStatePaths({ BROKER_AUTH_DB_PATH: "/custom/auth.sqlite" }, { mountPath, mountInfo: "" }), null);
  assert.equal(bootstrapStatePaths({ BROKER_TIMINGS_DB_PATH: "/custom/timing.sqlite" }, { mountPath, mountInfo: "" }), null);
  fs.mkdirSync(mountPath);
  const child = path.join(mountPath, "broker-state");
  fs.symlinkSync(mountPath, child, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => bootstrapStatePaths({}, { mountPath, mountInfo: mountInfo(mountPath) }), /real directory/);
  fs.rmSync(child);
  const paths = bootstrapStatePaths({}, { mountPath, mountInfo: mountInfo(mountPath) });
  assert.equal(paths.auth, path.join(child, "sessions.sqlite"));
  assert.equal(paths.timings, path.join(child, "timings.sqlite"));
  assert.equal(bootstrapStatePaths({}, { mountPath, mountInfo: mountInfo(mountPath) }).auth, paths.auth);
  if (process.platform !== "win32") assert.equal(fs.statSync(child).mode & 0o777, 0o700);
});

test("foreign-owned state and writable log root fail closed, operator-owned root is accepted", {
  skip: typeof process.getuid !== "function" || process.getuid() !== 0
}, t => {
  const mountPath = fixture(t);
  fs.mkdirSync(mountPath, { mode: 0o755 });
  const child = path.join(mountPath, "broker-state");
  fs.mkdirSync(child, { mode: 0o700 });
  fs.chownSync(child, 12345, 12345);
  assert.throws(() => bootstrapStatePaths({}, { mountPath, mountInfo: mountInfo(mountPath) }), /owned by another user/);
  fs.chownSync(child, process.getuid(), process.getgid());
  fs.chmodSync(mountPath, 0o775);
  assert.throws(() => bootstrapStatePaths({}, { mountPath, mountInfo: mountInfo(mountPath) }), /untrusted user/);
  fs.chmodSync(mountPath, 0o755);
  fs.chownSync(mountPath, 12345, 12345);
  assert.doesNotThrow(() => bootstrapStatePaths({}, { mountPath, mountInfo: mountInfo(mountPath) }));
});

test("default databases reopen and durable clear survives restart", t => {
  const mountPath = fixture(t);
  fs.mkdirSync(mountPath);
  const paths = bootstrapStatePaths({}, { mountPath, mountInfo: mountInfo(mountPath) });
  const sessions = new SessionStore(paths.auth);
  const created = sessions.create("synthetic-user", "synthetic-fingerprint", 3600, 100);
  const timings = new TimingStore(paths.timings);
  timings.upsert({ id: "synthetic-trace" });
  assert.equal(timings.page().rows.length, 1);
  timings.close();
  sessions.close();

  const reopened = bootstrapStatePaths({}, { mountPath, mountInfo: mountInfo(mountPath) });
  const reopenedSessions = new SessionStore(reopened.auth);
  const reopenedTimings = new TimingStore(reopened.timings);
  assert.equal(reopenedSessions.find(created.token, 101).username, "synthetic-user");
  assert.equal(reopenedTimings.page().rows[0].id, "synthetic-trace");
  assert.equal(reopenedTimings.clear(), 1);
  reopenedTimings.close();
  reopenedSessions.close();
  const afterClear = new TimingStore(paths.timings);
  assert.deepEqual(afterClear.page().rows, []);
  afterClear.close();
  if (process.platform !== "win32") {
    for (const file of fs.readdirSync(path.dirname(paths.auth))) {
      assert.equal(fs.statSync(path.join(path.dirname(paths.auth), file)).mode & 0o077, 0);
    }
  }
});
