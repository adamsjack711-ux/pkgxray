"use strict";

const dns = require("node:dns");
const net = require("node:net");

const blocked = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]
]) blocked.addSubnet(address, prefix, "ipv4");
// Accept only global unicast IPv6, excluding documentation and transition
// ranges that can tunnel traffic to an otherwise blocked IPv4 destination.
const globalV6 = new net.BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
blocked.addSubnet("2001::", 23, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");
function isPublicAddress(address) {
  address = String(address).replace(/^\[|\]$/g, "");
  const family = net.isIP(address);
  return family === 4 ? !blocked.check(address, "ipv4")
    : family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}
function isPrivateOrLocalHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return !host || host === "localhost" || host.endsWith(".localhost") ||
    (Boolean(net.isIP(host)) && !isPublicAddress(host));
}

function createUpstreamPolicy(base, { allowPrivateUpstream = false, codeload = false, lookup = dns.lookup } = {}) {
  const initial = new URL(base);
  const origins = new Set([initial.origin]);
  if (codeload && initial.origin === "https://codeload.github.com") {
    origins.add("https://github.com");
    origins.add("https://objects.githubusercontent.com");
  }
  function validate(value) {
    const url = new URL(value);
    const privateOptIn = allowPrivateUpstream && url.origin === initial.origin;
    if (!origins.has(url.origin) || url.username || url.password ||
        (url.protocol !== "https:" && !(privateOptIn && url.protocol === "http:"))) {
      throw new Error("Upstream URL violates the configured origin/HTTPS policy");
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (!privateOptIn && (hostname === "localhost" || hostname.endsWith(".localhost") ||
        (net.isIP(hostname) && !isPublicAddress(hostname)))) {
      throw new Error("Upstream destination is not a public address");
    }
    // Validate the actual addresses returned to the socket, avoiding a second
    // DNS lookup between validation and connection (DNS rebinding).
    const safeLookup = (host, options, callback) => {
      if (typeof options === "number") options = { family: options };
      options ||= {};
      lookup(host, { ...options, all: true }, (error, addresses) => {
        if (error) return callback(error);
        if (!addresses.length || (!privateOptIn && addresses.some(a => !isPublicAddress(a.address)))) {
          return callback(new Error("Upstream DNS resolved to a non-public address"));
        }
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      });
    };
    return { url, lookup: safeLookup };
  }
  validate(initial);
  return validate;
}

module.exports = { createUpstreamPolicy, isPublicAddress, isPrivateOrLocalHost };
