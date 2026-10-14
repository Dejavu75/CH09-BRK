export const MS07_BEAT_VALIDATION_URL = "https://ec.solinges.com.ar/healthmonitor/heartbeat/broker-beat/validate";

export async function verifyMs07BeatCentrally(
  authorization: string | undefined,
  request: typeof fetch = fetch
): Promise<boolean> {
  if (!authorization || authorization.length > 8200 ||
      !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(authorization)) return false;
  try {
    const response = await request(MS07_BEAT_VALIDATION_URL, {
      method: "POST",
      headers: { Authorization: authorization, Accept: "application/json" },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(2000)
    });
    if (response.status !== 200 || !response.body) return false;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 128) {
        await reader.cancel();
        return false;
      }
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return body && typeof body === "object" && !Array.isArray(body) && body.valid === true;
  } catch {
    return false;
  }
}
