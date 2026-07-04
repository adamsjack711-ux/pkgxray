"use strict";

// Package-scan-first orchestration. The guard is injected (options.guard, the
// same pattern recheck uses with options.evaluate) so these run offline; the
// enumeration side talks to the real stdio fixture.

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { inspectMcpServer } = require("../src/mcp-audit");

const FIXTURE = path.join(__dirname, "fixtures", "mcp-stdio-server.js");
const TARGET = { command: process.execPath, args: [FIXTURE] };

function fakeGuard(decision, calls) {
  return async (reference) => {
    calls.push(reference);
    return {
      reference,
      decision,
      report: { verdict: decision === "allow" ? "safe" : decision, findings: [] }
    };
  };
}

test("a block package scan halts before any connection", async () => {
  const calls = [];
  const result = await inspectMcpServer(
    // A command that would fail loudly if spawned — proving we never connect.
    { command: "/nonexistent/mcp-server-binary" },
    { packageRef: "npm:evil-server@1.0.0", guard: fakeGuard("block", calls), timeoutMs: 2000 }
  );
  assert.deepEqual(calls, ["npm:evil-server@1.0.0"]);
  assert.equal(result.halted, true);
  assert.equal(result.manifest, null);
  assert.equal(result.packageScan.decision, "block");
});

test("--force connects past a block scan, and the scan verdict is surfaced", async () => {
  const calls = [];
  const result = await inspectMcpServer(TARGET, {
    packageRef: "npm:evil-server@1.0.0",
    guard: fakeGuard("block", calls),
    force: true,
    timeoutMs: 10_000
  });
  assert.equal(result.halted, false);
  assert.equal(result.packageScan.decision, "block");
  assert.equal(result.manifest.server.name, "fixture-server");
});

test("an allow scan proceeds to enumeration with the verdict alongside", async () => {
  const calls = [];
  const result = await inspectMcpServer(TARGET, {
    packageRef: "npm:fine-server@2.0.0",
    guard: fakeGuard("allow", calls),
    timeoutMs: 10_000
  });
  assert.deepEqual(calls, ["npm:fine-server@2.0.0"]);
  assert.equal(result.packageScan.verdict, "safe");
  assert.equal(result.manifest.tools.length, 2);
});

test("no packageRef: no scan runs, enumeration still works", async () => {
  const calls = [];
  const result = await inspectMcpServer(TARGET, {
    guard: fakeGuard("allow", calls),
    timeoutMs: 10_000
  });
  assert.deepEqual(calls, []);
  assert.equal(result.packageScan, null);
  assert.equal(result.manifest.tools.length, 2);
});

test("the final verdict folds worst-of over package scan and manifest audit", async () => {
  const result = await inspectMcpServer(TARGET, {
    packageRef: "npm:sketchy-server@1.0.0",
    guard: fakeGuard("review", []),
    timeoutMs: 10_000
  });
  assert.equal(result.manifestAudit.verdict, "safe", "fixture manifest is clean");
  assert.equal(result.verdict, "review", "package review verdict must win the fold");
});

test("audit:false skips the manifest audit and the fold sees only the package scan", async () => {
  const result = await inspectMcpServer(TARGET, {
    guard: fakeGuard("allow", []),
    audit: false,
    timeoutMs: 10_000
  });
  assert.equal(result.manifestAudit, null);
  assert.equal(result.verdict, "safe");
});

test("packageScan:false skips the scan even with a packageRef (the loud opt-out)", async () => {
  const calls = [];
  const result = await inspectMcpServer(TARGET, {
    packageRef: "npm:fine-server@2.0.0",
    packageScan: false,
    guard: fakeGuard("allow", calls),
    timeoutMs: 10_000
  });
  assert.deepEqual(calls, []);
  assert.equal(result.packageScan, null);
  assert.equal(result.manifest.tools.length, 2);
});
