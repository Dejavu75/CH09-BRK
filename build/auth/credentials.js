"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CredentialFile = void 0;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const BCRYPT_HASH = /^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/;
const SHA512_CRYPT_HASH = /^\$6\$(?:rounds=\d+\$)?[./A-Za-z0-9]{1,16}\$[./A-Za-z0-9]{86}$/;
class CredentialFile {
    constructor(path) {
        this.path = path;
        this.users = new Map();
        this.dummyHash = bcryptjs_1.default.hashSync("invalid-password", 12);
        for (const line of (0, node_fs_1.readFileSync)(path, "utf8").split(/\r?\n/)) {
            const entry = line.trim();
            if (!entry || entry.startsWith("#"))
                continue;
            const separator = entry.indexOf(":");
            if (separator <= 0)
                throw new Error("Malformed credential entry");
            const username = entry.slice(0, separator).trim();
            const hash = entry.slice(separator + 1).trim();
            if (!username || this.users.has(username) || !(BCRYPT_HASH.test(hash) || SHA512_CRYPT_HASH.test(hash))) {
                throw new Error("Unsupported or duplicate credential entry");
            }
            this.users.set(username, hash);
        }
        if (this.users.size === 0)
            throw new Error("Credential file contains no users");
    }
    verify(username, password) {
        return __awaiter(this, void 0, void 0, function* () {
            const hash = this.users.get(username);
            const length = Buffer.byteLength(password, "utf8");
            const invalid = length > 1024 || /[\r\n]/.test(password);
            const safePassword = invalid ? "invalid-password" : password;
            yield bcryptjs_1.default.compare(safePassword, this.dummyHash);
            if (!hash || invalid)
                return false;
            if (hash.startsWith("$2")) {
                if (length > 72)
                    return false;
                const candidate = hash.startsWith("$2y$") ? `$2b$${hash.slice(4)}` : hash;
                return bcryptjs_1.default.compare(password, candidate).catch(() => false);
            }
            return new Promise(resolve => {
                var _a, _b;
                const child = (0, node_child_process_1.execFile)("htpasswd", ["-vi", this.path, username], {
                    timeout: 5000, maxBuffer: 1024, windowsHide: true
                }, error => resolve(error === null));
                (_a = child.stdin) === null || _a === void 0 ? void 0 : _a.on("error", () => undefined);
                (_b = child.stdin) === null || _b === void 0 ? void 0 : _b.end(`${password}\n`);
            });
        });
    }
}
exports.CredentialFile = CredentialFile;
