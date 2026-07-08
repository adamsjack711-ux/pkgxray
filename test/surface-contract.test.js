"use strict";

// Contract tests for the surfaces graduated to Stable in 0.16 (mcp, mcp-proxy,
// cache). These pin the documented FLAG and ROUTE names so a rename is caught in
// CI — the Stable-tier promise in docs/compatibility.md is that these don't
// change without a major bump. Behavior is covered by mcp-proxy.test.js,
// mcp-audit.test.js, and cache-server.test.js; this file guards the names.

const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { start, parseArgs } = require("../bin/pkgxray-cache");

const CLI = path.join(__dirname, "..", "bin", "audit.js");

function usageText() {
  // --help prints the usage banner (to stderr) and exits 0 — capture both streams.
  const r = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
  return `${r.stdout || ""}${r.stderr || ""}`;
}

test("pkgxray mcp keeps its documented Stable flag surface", () => {
  const u = usageText();
  assert.match(u, /pkgxray mcp\b/);
  for (const flag of ["--package", "--no-package-scan", "--force", "--pin", "--recheck"]) {
    assert.ok(u.includes(flag), `mcp usage missing ${flag}`);
  }
});

test("pkgxray mcp-proxy keeps its documented Stable flag surface", () => {
  const u = usageText();
  assert.match(u, /pkgxray mcp-proxy\b/);
  for (const flag of ["--policy strict|balanced|permissive", "--pin", "--no-recheck", "--no-scan-results"]) {
    assert.ok(u.includes(flag), `mcp-proxy usage missing ${flag}`);
  }
});

test("canary opt-in + hardening flags are documented", () => {
  const u = usageText();
  for (const flag of ["--yes-run-untrusted-code", "--require-sandbox", "--keep-sandbox"]) {
    assert.ok(u.includes(flag), `canary usage missing ${flag}`);
  }
});

test("cache server keeps its documented flags and /healthz route", async () => {
  // Flags
  const opts = parseArgs(["--port", "0", "--host", "127.0.0.1", "--cache-dir", "/tmp/x"]);
  assert.equal(opts.port, 0);
  assert.equal(opts.host, "127.0.0.1");
  assert.equal(opts.cacheDir, "/tmp/x");

  // Route: /healthz responds ok; an unknown route 404s.
  const { server, address } = await start({ port: 0, host: "127.0.0.1", cacheDir: "/tmp/pkgxray-contract-cache" });
  try {
    const health = await getJson(address.port, "/healthz");
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);

    const unknown = await getJson(address.port, "/definitely-not-a-route");
    assert.equal(unknown.status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: pathname, agent: false, headers: { Connection: "close" } }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let body = {};
          try {
            body = JSON.parse(data);
          } catch {
            /* non-JSON body is fine for the status-only assertions */
          }
          resolve({ status: res.statusCode, body });
        });
      })
      .on("error", reject);
  });
}
