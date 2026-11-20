type RelayConfig = { url: string; key: string; mscode: string; instance: string; interval: number; timeout: number };
type AgesBeat = { status: "OK" | "down"; miniVersion?: string; bigBoyVersion?: string };

export function readMs07RelayConfig(env: NodeJS.ProcessEnv): RelayConfig | undefined {
  if (env.BROKER_MS07_RELAY_ENABLED !== "true") return;
  const url = new URL(env.BROKER_MS07_RELAY_URL ?? "");
  const key = env.BROKER_MS07_RELAY_KEY ?? "";
  const mscode = env.MSCODE?.trim() ?? "";
  const instance = env.MSINSTANCE?.trim() ?? "";
  const interval = Number(env.MSMONINTERVAL ?? "600") * 1000;
  const timeout = Number(env.BROKER_MS07_RELAY_TIMEOUT_MS ?? "5000");
  const identity = /^[\w.-]{1,30}$/;
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(key) || !identity.test(mscode) || !identity.test(instance) ||
      !Number.isInteger(interval) || interval < 10000 || interval > 86400000 ||
      !Number.isInteger(timeout) || timeout < 100 || timeout * 2 >= interval) {
    throw new Error("Invalid MS07 heartbeat relay configuration");
  }
  return { url: url.href, key, mscode, instance, interval, timeout };
}

function version(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return;
  const v = String(value).trim();
  if (/^[\w.+-]{1,80}$/.test(v)) return v;
}

async function probeAges(base: string, key: string | undefined, timeout: number): Promise<AgesBeat> {
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) {
    throw new Error("Invalid AGES probe origin");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") + "/~mini~/beat.ages";
  const response = await fetch(url, {
    headers: { Accept: "application/json", ...(key ? { "X-AGES-API-Key": key } : {}) },
    redirect: "error", signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    return { status: "down" };
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 65536) {
      await reader.cancel();
      return { status: "down" };
    }
    chunks.push(Buffer.from(value));
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const miniVersion = version(payload?.build?.mini?.version ?? payload?.Version_AGES_MINI);
  const bigBoyVersion = version(payload?.build?.bigBoy?.version ?? payload?.Version_AGES);
  if (!miniVersion && !bigBoyVersion) return { status: "down" };
  return { status: "OK", miniVersion, bigBoyVersion };
}

export async function relayMs07Beat(config: RelayConfig, origins: string[], agesKey?: string, send = fetch): Promise<void> {
  const results = await Promise.all(origins.map(base => probeAges(base, agesKey, config.timeout)
    .catch((): AgesBeat => ({ status: "down" }))));
  const ages = results.find(result => result.status === "OK") ?? { status: "down" };
  const response = await send(config.url, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(config.timeout),
    headers: { Authorization: "Bearer " + config.key, "Content-Type": "application/json" },
    body: JSON.stringify({ broker: { mscode: config.mscode, instance: config.instance, status: "OK" }, ages })
  });
  await response.body?.cancel();
  if (response.status !== 204) throw new Error("MS07 rejected the heartbeat relay");
}

export function startMs07Relay(config: RelayConfig, origins: string[], agesKey: string | undefined, warn: (message: string) => void): () => void {
  const controller = new AbortController();
  let timer: NodeJS.Timeout;
  const run = async () => {
    const started = Date.now();
    try {
      await relayMs07Beat(config, origins, agesKey);
    } catch {
      warn("MS07 heartbeat relay delivery failed");
    } finally {
      if (!controller.signal.aborted) timer = setTimeout(run, Math.max(0, config.interval - (Date.now() - started))).unref();
    }
  };
  void run();
  return () => { controller.abort(); clearTimeout(timer); };
}
