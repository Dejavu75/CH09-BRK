"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyMs07BeatBearer = verifyMs07BeatBearer;
const node_crypto_1 = require("node:crypto");
function decodeJson(value) {
    if (!/^[A-Za-z0-9_-]+$/.test(value))
        throw new Error("Invalid token encoding");
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value)
        throw new Error("Noncanonical token encoding");
    return JSON.parse(decoded.toString("utf8"));
}
function verifyMs07BeatBearer(authorization, secret, now = Math.floor(Date.now() / 1000)) {
    if (!secret || Buffer.byteLength(secret, "utf8") < 32 || !authorization)
        return false;
    const bearer = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization);
    if (!bearer || bearer[1].length > 8192)
        return false;
    const [headerPart, payloadPart, signaturePart] = bearer[1].split(".");
    const actual = Buffer.from(signaturePart, "base64url");
    const expected = (0, node_crypto_1.createHmac)("sha256", secret).update(`${headerPart}.${payloadPart}`).digest();
    if (actual.length !== expected.length || !(0, node_crypto_1.timingSafeEqual)(actual, expected) ||
        actual.toString("base64url") !== signaturePart)
        return false;
    try {
        const header = decodeJson(headerPart);
        const payload = decodeJson(payloadPart);
        if (!header || typeof header !== "object" || Array.isArray(header) ||
            header.alg !== "HS256" || header.typ !== "JWT" ||
            !payload || typeof payload !== "object" || Array.isArray(payload))
            return false;
        return payload.iss === "solinges-ecosystem" && payload.aud === "broker" &&
            payload.mscode === "MS07" && typeof payload.instance === "string" && payload.instance.length > 0 &&
            payload.sub === `MS07/${payload.instance}` && Array.isArray(payload.scope) &&
            payload.scope.includes("broker:beat") && Number.isInteger(payload.iat) && Number.isInteger(payload.exp) &&
            payload.iat > 0 && payload.iat <= now + 60 &&
            payload.exp > now && payload.exp > payload.iat &&
            payload.exp - payload.iat <= 3600;
    }
    catch (_a) {
        return false;
    }
}
