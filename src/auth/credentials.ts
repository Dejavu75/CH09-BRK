import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import bcrypt from "bcryptjs";

const BCRYPT_HASH = /^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/;
const SHA512_CRYPT_HASH = /^\$6\$(?:rounds=\d+\$)?[./A-Za-z0-9]{1,16}\$[./A-Za-z0-9]{86}$/;

export class CredentialFile {
  private readonly users = new Map<string, string>();
  private readonly dummyHash = bcrypt.hashSync("invalid-password", 12);

  constructor(private readonly path: string) {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const entry = line.trim();
      if (!entry || entry.startsWith("#")) continue;
      const separator = entry.indexOf(":");
      if (separator <= 0) throw new Error("Malformed credential entry");
      const username = entry.slice(0, separator).trim();
      const hash = entry.slice(separator + 1).trim();
      if (!username || this.users.has(username) || !(BCRYPT_HASH.test(hash) || SHA512_CRYPT_HASH.test(hash))) {
        throw new Error("Unsupported or duplicate credential entry");
      }
      this.users.set(username, hash);
    }
    if (this.users.size === 0) throw new Error("Credential file contains no users");
  }

  async verify(username: string, password: string): Promise<boolean> {
    const hash = this.users.get(username);
    const length = Buffer.byteLength(password, "utf8");
    const invalid = length > 1024 || /[\r\n]/.test(password);
    const safePassword = invalid ? "invalid-password" : password;
    await bcrypt.compare(safePassword, this.dummyHash);
    if (!hash || invalid) return false;
    if (hash.startsWith("$2")) {
      if (length > 72) return false;
      const candidate = hash.startsWith("$2y$") ? `$2b$${hash.slice(4)}` : hash;
      return bcrypt.compare(password, candidate).catch(() => false);
    }
    return new Promise(resolve => {
      const child = execFile("htpasswd", ["-vi", this.path, username], {
        timeout: 5000, maxBuffer: 1024, windowsHide: true
      }, error => resolve(error === null));
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(`${password}\n`);
    });
  }
}
