"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadServiceKey = loadServiceKey;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const KEY_FILE = "service-api-key";
function privatePath(file, directory) {
    const state = (0, node_fs_1.lstatSync)(file);
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
function loadServiceKey(configured, databaseFile) {
    if (configured === null || configured === void 0 ? void 0 : configured.trim()) {
        const value = configured.trim();
        if (Buffer.byteLength(value, "utf8") < 32)
            throw new Error("BROKER_SERVICE_API_KEY must contain at least 32 bytes");
        return value;
    }
    const directory = node_path_1.default.dirname(databaseFile);
    privatePath(directory, true);
    const file = node_path_1.default.join(directory, KEY_FILE);
    try {
        const key = (0, node_crypto_1.randomBytes)(32).toString("base64url");
        const fd = (0, node_fs_1.openSync)(file, node_fs_1.constants.O_WRONLY | node_fs_1.constants.O_CREAT | node_fs_1.constants.O_EXCL | node_fs_1.constants.O_NOFOLLOW, 0o600);
        try {
            (0, node_fs_1.writeSync)(fd, `${key}\n`);
            (0, node_fs_1.fsyncSync)(fd);
        }
        finally {
            (0, node_fs_1.closeSync)(fd);
        }
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
    }
    privatePath(file, false);
    const key = (0, node_fs_1.readFileSync)(file, "utf8").trim();
    if (Buffer.byteLength(key, "utf8") < 32)
        throw new Error("Broker service key is invalid");
    return key;
}
