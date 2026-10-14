import { isIP } from "node:net";

// Trust only explicit reverse-proxy socket addresses, never client-supplied headers by default.
export function trustedProxyAddresses(value: string | undefined): false | string[] {
  if (value === undefined || value.trim() === "") return false;
  const addresses = value.split(",").map(address => address.trim());
  if (addresses.some(address => isIP(address) === 0)) {
    throw new Error("BROKER_TRUSTED_PROXY_IPS must contain only IP addresses");
  }
  return addresses;
}
