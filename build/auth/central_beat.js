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
Object.defineProperty(exports, "__esModule", { value: true });
exports.MS07_BEAT_VALIDATION_URL = void 0;
exports.verifyMs07BeatCentrally = verifyMs07BeatCentrally;
exports.MS07_BEAT_VALIDATION_URL = "https://ec.solinges.com.ar/healthmonitor/heartbeat/broker-beat/validate";
function verifyMs07BeatCentrally(authorization_1) {
    return __awaiter(this, arguments, void 0, function* (authorization, request = fetch) {
        if (!authorization || authorization.length > 8200 ||
            !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(authorization))
            return false;
        try {
            const response = yield request(exports.MS07_BEAT_VALIDATION_URL, {
                method: "POST",
                headers: { Authorization: authorization, Accept: "application/json" },
                redirect: "error",
                cache: "no-store",
                signal: AbortSignal.timeout(2000)
            });
            if (response.status !== 200 || !response.body)
                return false;
            const reader = response.body.getReader();
            const chunks = [];
            let length = 0;
            while (true) {
                const { done, value } = yield reader.read();
                if (done)
                    break;
                length += value.byteLength;
                if (length > 128) {
                    yield reader.cancel();
                    return false;
                }
                chunks.push(value);
            }
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            return body && typeof body === "object" && !Array.isArray(body) && body.valid === true;
        }
        catch (_a) {
            return false;
        }
    });
}
