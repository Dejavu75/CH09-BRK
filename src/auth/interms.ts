import { createHmac, timingSafeEqual } from "node:crypto";

type InterMsBeatPayload = {
  iss?: unknown;
  sub?: unknown;
  aud?: unknown;
  scope?: unknown;
  mscode?: unknown;
  instance?: unknown;
  iat?: unknown;
  exp?: unknown;
};

function decodeJson(value: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid token encoding");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error("Noncanonical token encoding");
  return JSON.parse(decoded.toString("utf8"));
}

export function verifyMs07BeatBearer(authorization: string | undefined, secret: string | undefined,
  now = Math.floor(Date.now() / 1000)): boolean {
  if (!secret || Buffer.byteLength(secret, "utf8") < 32 || !authorization) return false;
  const bearer = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization);
  if (!bearer || bearer[1].length > 8192) return false;
  const [headerPart, payloadPart, signaturePart] = bearer[1].split(".");
  const actual = Buffer.from(signaturePart, "base64url");
  const expected = createHmac("sha256", secret).update(`${headerPart}.${payloadPart}`).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected) ||
      actual.toString("base64url") !== signaturePart) return false;

  try {
    const header = decodeJson(headerPart);
    const payload = decodeJson(payloadPart) as InterMsBeatPayload;
    if (!header || typeof header !== "object" || Array.isArray(header) ||
        (header as { alg?: unknown }).alg !== "HS256" || (header as { typ?: unknown }).typ !== "JWT" ||
        !payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    return payload.iss === "solinges-ecosystem" && payload.aud === "broker" &&
      payload.mscode === "MS07" && typeof payload.instance === "string" && payload.instance.length > 0 &&
      payload.sub === `MS07/${payload.instance}` && Array.isArray(payload.scope) &&
      payload.scope.includes("broker:beat") && Number.isInteger(payload.iat) && Number.isInteger(payload.exp) &&
      (payload.iat as number) > 0 && (payload.iat as number) <= now + 60 &&
      (payload.exp as number) > now && (payload.exp as number) > (payload.iat as number) &&
      (payload.exp as number) - (payload.iat as number) <= 3600;
  } catch {
    return false;
  }
}
