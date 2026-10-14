import { randomBytes } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";

const KEY_FILE = "service-api-key";

function privatePath(file: string, directory: boolean): void {
  const state = lstatSync(file);
  if (state.isSymbolicLink() || !(directory ? state.isDirectory() : state.isFile())) {
    throw new Error("Broker service key path is not a regular private path");
  }
  // A root-run Broker may trust the operator-owned mount, but the key file
  // itself must remain root-owned and private.
  if (process.platform !== "win32" &&
      ((typeof process.getuid === "function" && state.uid !== process.getuid() &&
        !(directory && process.getuid() === 0)) ||
       (state.mode & (directory ? 0o077 : 0o177)) !== 0)) {
    throw new Error("Broker service key path is not private");
  }
}

export function loadServiceKey(configured: string | undefined, databaseFile: string): string {
  if (configured?.trim()) {
    const value = configured.trim();
    if (Buffer.byteLength(value, "utf8") < 32) throw new Error("BROKER_SERVICE_API_KEY must contain at least 32 bytes");
    return value;
  }
  const directory = path.dirname(databaseFile);
  privatePath(directory, true);
  const file = path.join(directory, KEY_FILE);
  try {
    const key = randomBytes(32).toString("base64url");
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeSync(fd, `${key}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  privatePath(file, false);
  const key = readFileSync(file, "utf8").trim();
  if (Buffer.byteLength(key, "utf8") < 32) throw new Error("Broker service key is invalid");
  return key;
}
