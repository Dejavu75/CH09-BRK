"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startTlsCertificateReload = startTlsCertificateReload;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
function fingerprint(credentials) {
    return (0, node_crypto_1.createHash)("sha256")
        .update(credentials.cert)
        .update("\0")
        .update(credentials.key)
        .digest("hex");
}
function startTlsCertificateReload(target, options) {
    var _a, _b, _c, _d, _e;
    const schedule = (_a = options.setInterval) !== null && _a !== void 0 ? _a : setInterval;
    const cancel = (_b = options.clearInterval) !== null && _b !== void 0 ? _b : clearInterval;
    const intervalMs = (_c = options.intervalMs) !== null && _c !== void 0 ? _c : 60000;
    const readCredentials = () => ({
        cert: (0, node_fs_1.readFileSync)(options.certPath),
        key: (0, node_fs_1.readFileSync)(options.keyPath)
    });
    let activeFingerprint = fingerprint((_d = options.initialCredentials) !== null && _d !== void 0 ? _d : readCredentials());
    const reload = () => {
        var _a, _b;
        try {
            const credentials = readCredentials();
            const nextFingerprint = fingerprint(credentials);
            if (nextFingerprint === activeFingerprint)
                return;
            target.setSecureContext(credentials);
            activeFingerprint = nextFingerprint;
            (_a = options.onReload) === null || _a === void 0 ? void 0 : _a.call(options, "TLS certificate reloaded");
        }
        catch (reloadError) {
            const errorName = reloadError instanceof Error ? reloadError.name : "UnknownError";
            (_b = options.onError) === null || _b === void 0 ? void 0 : _b.call(options, `TLS certificate reload failed | err=${errorName}`);
        }
    };
    const timer = schedule(reload, intervalMs);
    (_e = timer.unref) === null || _e === void 0 ? void 0 : _e.call(timer);
    return () => cancel(timer);
}
