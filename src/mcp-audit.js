"use strict";

// MCP adapter orchestration — package-scan-first, then connect-and-enumerate.
//
// The ordering is the point (see MCP_ADAPTER_PROMPT.md): enumerating a stdio
// server SPAWNS it, so when the server ships as a package/local ref the
// static, no-execution scan (guardExtension — the same call `pkgxray guard`
// makes) runs BEFORE any connection, and a `block` halts the connect step
// unless the caller force-accepts.
//
// T1: inspect = guard (optional) + enumerate. Verdicts over the manifest text
// itself arrive in T2.

const { guardExtension } = require("./quarantine");
const { enumerateMcpServer } = require("./mcp-client");

// Inspect an MCP server: optionally package-scan it, then enumerate its tool
// manifest.
//
// target  — { url } or { command, args } (see enumerateMcpServer)
// options —
//   packageRef     npm/github/local reference the server ships as; scanned
//                  with guardExtension before any connection.
//   packageScan    false to skip the scan even when packageRef is given
//                  (the CLI surfaces this as --no-package-scan, loudly).
//   force          connect even when the package scan says block.
//   guard          injectable guard implementation (tests); defaults to
//                  guardExtension.
//   timeoutMs, cwd, extraEnv — forwarded to the enumeration.
//
// Returns { packageScan, manifest, halted }:
//   packageScan — null when no scan ran, else { reference, decision, verdict,
//                 report } straight from the guard.
//   halted      — true when a block verdict stopped us before connecting
//                 (manifest is null in that case).
async function inspectMcpServer(target, options = {}) {
  const guard = options.guard || guardExtension;
  let packageScan = null;

  if (options.packageRef && options.packageScan !== false) {
    const result = await guard(options.packageRef, {
      quarantineRoot: options.quarantineRoot,
      policy: options.policy
    });
    packageScan = {
      reference: options.packageRef,
      decision: result.decision,
      verdict: result.report ? result.report.verdict : null,
      report: result.report || null
    };
    if (result.decision === "block" && !options.force) {
      return { packageScan, manifest: null, halted: true };
    }
  }

  const manifest = await enumerateMcpServer(target, {
    timeoutMs: options.timeoutMs,
    cwd: options.cwd,
    extraEnv: options.extraEnv
  });

  return { packageScan, manifest, halted: false };
}

module.exports = {
  inspectMcpServer
};
