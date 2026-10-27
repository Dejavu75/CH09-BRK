import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:https";

type TlsCredentials = { cert: Buffer; key: Buffer };
type ReloadTarget = Pick<Server, "setSecureContext">;

type TlsCertificateReloadOptions = {
  certPath: string;
  keyPath: string;
  initialCredentials?: TlsCredentials;
  intervalMs?: number;
  setInterval?: (callback: () => void, intervalMs: number) => NodeJS.Timeout;
  clearInterval?: (timer: NodeJS.Timeout) => void;
  onReload?: (message: string) => void;
  onError?: (message: string) => void;
};

function fingerprint(credentials: TlsCredentials): string {
  return createHash("sha256")
    .update(credentials.cert)
    .update("\0")
    .update(credentials.key)
    .digest("hex");
}

export function startTlsCertificateReload(
  target: ReloadTarget,
  options: TlsCertificateReloadOptions
): () => void {
  const schedule = options.setInterval ?? setInterval;
  const cancel = options.clearInterval ?? clearInterval;
  const intervalMs = options.intervalMs ?? 60_000;
  const readCredentials = (): TlsCredentials => ({
    cert: readFileSync(options.certPath),
    key: readFileSync(options.keyPath)
  });
  let activeFingerprint = fingerprint(options.initialCredentials ?? readCredentials());

  const reload = (): void => {
    try {
      const credentials = readCredentials();
      const nextFingerprint = fingerprint(credentials);
      if (nextFingerprint === activeFingerprint) return;
      target.setSecureContext(credentials);
      activeFingerprint = nextFingerprint;
      options.onReload?.("TLS certificate reloaded");
    } catch (reloadError) {
      const errorName = reloadError instanceof Error ? reloadError.name : "UnknownError";
      options.onError?.(`TLS certificate reload failed | err=${errorName}`);
    }
  };

  const timer = schedule(reload, intervalMs);
  timer.unref?.();
  return () => cancel(timer);
}
