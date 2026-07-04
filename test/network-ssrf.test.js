"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isPrivateOrLocalHost,
  assertDownloadHostAllowed,
  tarballHostAllowlist,
} = require("../src/quarantine");

function allows(url, opts) {
  assertDownloadHostAllowed(new URL(url), { originalUrl: url, ...opts });
}
function rejects(url, opts) {
  assert.throws(() => allows(url, opts));
}

test("isPrivateOrLocalHost classifies internal vs public hosts", () => {
  for (const h of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "0.0.0.0", "100.64.0.1", "localhost", "[::1]", "[fe80::1]", "[fc00::1]"]) {
    assert.equal(isPrivateOrLocalHost(h), true, `${h} should be private/local`);
  }
  for (const h of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "registry.npmjs.org", "[2606:4700::1111]"]) {
    assert.equal(isPrivateOrLocalHost(h), false, `${h} should be public`);
  }
});

test("npm strict pin: only the registry origin is allowed", () => {
  const allowed = tarballHostAllowlist(["registry.npmjs.org"]);
  const opts = { allowedHosts: allowed, strictHosts: true };
  allows("https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz", opts); // legit
  rejects("http://169.254.169.254/latest/meta-data/", opts);              // SSRF metadata (also http)
  rejects("https://evil.com/lodash-4.17.21.tgz", opts);                   // off-origin public
  rejects("http://registry.npmjs.org/x.tgz", opts);                       // right host, non-https
  rejects("https://0x08080808/x.tgz", opts);                              // hex-IP off-origin
});

test("npm SSRF via encoded loopback IP is rejected (URL normalizes to dotted-quad)", () => {
  const allowed = tarballHostAllowlist(["registry.npmjs.org"]);
  // 2130706433 / 0x7f000001 both normalize to 127.0.0.1 — not the registry origin.
  rejects("https://2130706433/x.tgz", { allowedHosts: allowed, strictHosts: true });
});

test("github non-strict: public hosts allowed, private/loopback rejected", () => {
  const allowed = tarballHostAllowlist(["codeload.github.com", "github.com", "objects.githubusercontent.com"]);
  const opts = { allowedHosts: allowed, strictHosts: false };
  allows("https://codeload.github.com/o/r/tar.gz/main", opts);   // legit
  allows("https://objects.githubusercontent.com/abc", opts);     // public CDN redirect
  rejects("http://127.0.0.1:8080/x", opts);                      // loopback (also http)
  rejects("https://[::1]/x", opts);                              // ipv6 loopback
  rejects("https://[::ffff:169.254.169.254]/x", opts);           // v4-mapped metadata
  rejects("https://10.0.0.5/x", opts);                           // private redirect target
});

test("PKGXRAY_TARBALL_HOSTS extends the npm allowlist", () => {
  const prev = process.env.PKGXRAY_TARBALL_HOSTS;
  process.env.PKGXRAY_TARBALL_HOSTS = "cdn.example.com";
  try {
    const allowed = tarballHostAllowlist(["registry.npmjs.org"]);
    allows("https://cdn.example.com/x.tgz", { allowedHosts: allowed, strictHosts: true });
  } finally {
    if (prev === undefined) delete process.env.PKGXRAY_TARBALL_HOSTS;
    else process.env.PKGXRAY_TARBALL_HOSTS = prev;
  }
});
