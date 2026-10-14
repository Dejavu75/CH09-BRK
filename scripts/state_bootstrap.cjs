"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const LOG_MOUNT = "/etc/nages2/logdir";
const STATE_DIRECTORY = "broker-state";
const LOCAL_FILESYSTEMS = new Set(["ext2", "ext3", "ext4", "xfs", "btrfs", "f2fs", "zfs"]);

function decodeMountPath(value) {
  return value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

function validateMount(mountPath, mountInfo) {
  const stat = fs.lstatSync(mountPath);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(mountPath) !== mountPath) {
    throw new Error("Broker log mount must be a real directory");
  }
  // A root-run container may use an operator-owned bind mount. Its owner is
  // trusted to control the parent directory; the state child stays root-owned.
  if (typeof process.getuid === "function" &&
      ((process.getuid() !== 0 && stat.uid !== process.getuid()) || (stat.mode & 0o022) !== 0)) {
    throw new Error("Broker log mount is owned or writable by an untrusted user");
  }
  const entries = mountInfo.split("\n").filter(Boolean).map(line => {
    const [left, right] = line.split(" - ");
    if (!right) throw new Error("Invalid mount information");
    const fields = left.split(" ");
    const after = right.split(" ");
    return { mount: decodeMountPath(fields[4]), options: fields[5], type: after[0], superOptions: after[2] };
  });
  const matches = entries.filter(item => item.mount === mountPath);
  if (matches.length > 1) throw new Error("Broker log mount is ambiguous");
  const entry = matches[0];
  if (!entry) throw new Error("Broker log directory is not an exact mountpoint");
  if (!LOCAL_FILESYSTEMS.has(entry.type)) throw new Error("Broker log mount is not an allowed local filesystem");
  if (entry.options.split(",").includes("ro") || entry.superOptions?.split(",").includes("ro")) {
    throw new Error("Broker log mount is read-only");
  }
}

function bootstrapStatePaths(env = process.env, options = {}) {
  if (env.BROKER_AUTH_DB_PATH || env.BROKER_TIMINGS_DB_PATH) return null;
  const mountPath = options.mountPath ?? LOG_MOUNT;
  const mountInfo = options.mountInfo ?? fs.readFileSync("/proc/self/mountinfo", "utf8");
  validateMount(mountPath, mountInfo);

  const directory = path.join(mountPath, STATE_DIRECTORY);
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const state = fs.lstatSync(directory);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("Broker state path must be a real directory");
  if (typeof process.getuid === "function" && state.uid !== process.getuid()) {
    throw new Error("Broker state directory is owned by another user");
  }
  fs.chmodSync(directory, 0o700);
  const probe = path.join(directory, `.write-probe-${randomUUID()}`);
  const fd = fs.openSync(probe, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeSync(fd, "ok"); } finally { fs.closeSync(fd); fs.unlinkSync(probe); }
  return {
    auth: path.join(directory, "sessions.sqlite"),
    timings: path.join(directory, "timings.sqlite")
  };
}

if (require.main === module) {
  try { bootstrapStatePaths(); }
  catch (error) {
    process.stderr.write(`Broker state bootstrap failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { bootstrapStatePaths, validateMount };
