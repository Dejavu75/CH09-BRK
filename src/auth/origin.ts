import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";

// Host supplies only the authority; the certificate supplies the permitted identity.
export function certifiedHttpsOrigin(authority: string | undefined, certificate: X509Certificate): string | undefined {
  if (!authority || authority.length > 260 || /[^\x21-\x7e]/.test(authority)) return undefined;
  const match = /^([^:]+)(?::([0-9]{1,5}))?$/.exec(authority);
  if (!match) return undefined;
  const hostname = match[1].toLowerCase();
  if (isIP(hostname) === 4) {
    if (!certificate.checkIP(hostname)) return undefined;
  } else {
    if (hostname.length > 253 || !hostname.split(".").every(label =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return undefined;
    // A legacy Common Name alone is not enough to anchor a browser origin.
    if (!certificate.checkHost(hostname, { subject: "never" })) return undefined;
  }
  if (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535)) return undefined;
  const origin = new URL(`https://${hostname}${match[2] ? `:${match[2]}` : ""}`).origin;
  return origin;
}
