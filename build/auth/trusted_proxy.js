"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.trustedProxyAddresses = trustedProxyAddresses;
const node_net_1 = require("node:net");
// Trust only explicit reverse-proxy socket addresses, never client-supplied headers by default.
function trustedProxyAddresses(value) {
    if (value === undefined || value.trim() === "")
        return false;
    const addresses = value.split(",").map(address => address.trim());
    if (addresses.some(address => (0, node_net_1.isIP)(address) === 0)) {
        throw new Error("BROKER_TRUSTED_PROXY_IPS must contain only IP addresses");
    }
    return addresses;
}
