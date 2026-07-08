"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  loadConfig,
  validateConfig,
  applyConfig,
  exitCodeForVerdict,
  verdictForScanError,
  renderConfigEffects,
  mcpConfig,
  mcpToolAllowed,
  DEFAULTS
} = require("../src/config");

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pkgxray-cfg-"));
}

function report(findings, extra = {}) {
  return { schemaVersion: 1, verdict: "review", findings, packageName: "demo", ...extra };
}

// --- defaults & loading ----------------------------------------------------

test("absent config yields safe defaults, no warnings", () => {
  const dir = tmpdir();
  const { config, warnings, sources } = loadConfig({ cwd: dir, env: {} });
  assert.equal(config.policy, "safe-only");
  assert.equal(config.failOn, "review");
  assert.equal(config.scanErrorPolicy, "fail-closed");
  assert.deepEqual(config.allow, []);
  assert.deepEqual(config.mute, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(sources, []);
});

test("malformed JSON is a loud warning, not a silent weaken", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, ".pkgxray.json"), "{ not json");
  const { config, warnings } = loadConfig({ cwd: dir, env: {} });
  assert.equal(config.policy, "safe-only"); // fell back to safe default
  assert.ok(warnings.some((w) => /invalid JSON/.test(w)));
});

test("project config is found by walking up from a nested dir", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, ".pkgxray.json"), JSON.stringify({ failOn: "block" }));
  const nested = path.join(dir, "a", "b");
  fs.mkdirSync(nested, { recursive: true });
  const { config, sources } = loadConfig({ cwd: nested, env: {} });
  assert.equal(config.failOn, "block");
  assert.equal(sources.length, 1);
});

test("local override beats project, and allow/mute concatenate across layers", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, ".pkgxray.json"),
    JSON.stringify({ policy: "safe-only", mute: [{ check: "install-hook", reason: "a" }] })
  );
  fs.writeFileSync(
    path.join(dir, ".pkgxray.local.json"),
    JSON.stringify({ policy: "allow-review", mute: [{ check: "github-stale", reason: "b" }] })
  );
  const { config } = loadConfig({ cwd: dir, env: {} });
  assert.equal(config.policy, "allow-review"); // local wins
  assert.equal(config.mute.length, 2); // concatenated
});

test("env vars override file scalars", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, ".pkgxray.json"), JSON.stringify({ failOn: "block" }));
  const { config } = loadConfig({ cwd: dir, env: { PKGXRAY_FAIL_ON: "review" } });
  assert.equal(config.failOn, "review");
});

// --- validation invariants -------------------------------------------------

test("invariant 1: an un-pinned allow entry is dropped with a warning", () => {
  const warnings = [];
  const c = validateConfig({ allow: [{ pkg: "left-pad@1.3.0" /* no sha256 */, reason: "x" }] }, warnings);
  assert.equal(c.allow.length, 0);
  assert.ok(warnings.some((w) => /no sha256 pin/.test(w)));
});

test("invariant 1: a bare-name allow (no version) is dropped", () => {
  const warnings = [];
  const c = validateConfig({ allow: [{ pkg: "left-pad", sha256: "abc" }] }, warnings);
  assert.equal(c.allow.length, 0);
  assert.ok(warnings.some((w) => /pinned as name@version/.test(w)));
});

test("a fully-pinned allow entry is accepted and normalized", () => {
  const warnings = [];
  const c = validateConfig({ allow: [{ pkg: "@scope/x@2.0.0", sha256: "ABC123", reason: "vetted" }] }, warnings);
  assert.equal(c.allow.length, 1);
  assert.equal(c.allow[0].name, "@scope/x");
  assert.equal(c.allow[0].version, "2.0.0");
  assert.equal(c.allow[0].sha256, "abc123"); // lowercased
});

test("invariant 2: muting known-vulnerability is refused", () => {
  const warnings = [];
  const c = validateConfig({ mute: [{ check: "known-vulnerability" }] }, warnings);
  assert.equal(c.mute.length, 0);
  assert.ok(warnings.some((w) => /never be muted/.test(w)));
});

test("invalid enum values fall back to the safe default with a warning", () => {
  const warnings = [];
  const c = validateConfig({ policy: "yolo", failOn: "sometimes" }, warnings);
  assert.equal(c.policy, "safe-only");
  assert.equal(c.failOn, "review");
  assert.equal(warnings.length, 2);
});

test("policy allow-review emits a loosening warning", () => {
  const warnings = [];
  validateConfig({ policy: "allow-review" }, warnings);
  assert.ok(warnings.some((w) => /loosening/.test(w)));
});

// --- applyConfig: mutes ----------------------------------------------------

test("a matching mute tags the finding, keeps it visible, and re-folds the verdict", () => {
  const warnings = [];
  const config = validateConfig({ mute: [{ check: "install-hook", reason: "trusted build" }] }, warnings);
  const r = applyConfig(
    report([{ severity: "medium", category: "install-hook", file: "package.json", rationale: "x" }]),
    { config, packageName: "demo" }
  );
  assert.equal(r.verdict, "safe"); // the only gating finding was muted
  assert.equal(r.findings[0].muted, true); // still present, just tagged
  assert.equal(r.configEffects.mutedCount, 1);
});

test("mute scope glob limits which packages it applies to", () => {
  const config = validateConfig({ mute: [{ check: "lonely-maintainer", scope: "@myorg/*" }] }, []);
  const finding = { severity: "medium", category: "lonely-maintainer", file: "NPM_METADATA" };
  const inScope = applyConfig(report([{ ...finding }]), { config, packageName: "@myorg/tool" });
  const outScope = applyConfig(report([{ ...finding }]), { config, packageName: "random-pkg" });
  assert.equal(inScope.findings[0].muted, true);
  assert.equal(outScope.findings[0].muted, undefined);
});

test("a mute never suppresses a known-vulnerability (immutable)", () => {
  // Even if a config somehow carried the category, applyConfig refuses it.
  const config = { ...DEFAULTS, mute: [{ check: "known-vulnerability", scope: "*", reason: "hidden" }] };
  const r = applyConfig(
    report([{ severity: "high", category: "known-vulnerability", file: "VULN" }]),
    { config, packageName: "demo" }
  );
  assert.equal(r.verdict, "block");
  assert.equal(r.findings[0].muted, undefined);
});

// --- applyConfig: allowlist ------------------------------------------------

const HIGH_CRED = [{ severity: "high", category: "credential-access", file: "index.js", rationale: "reads .ssh" }];

test("a pinned, matching allow forces safe", () => {
  const config = validateConfig(
    { allow: [{ pkg: "demo@1.0.0", sha256: "deadbeef", reason: "reviewed" }] },
    []
  );
  const r = applyConfig(report(HIGH_CRED.map((f) => ({ ...f }))), {
    config,
    packageName: "demo",
    version: "1.0.0",
    sha256: "DEADBEEF"
  });
  assert.equal(r.verdict, "safe");
  assert.ok(r.configEffects.allowlisted);
  assert.equal(r.configEffects.allowlisted.pkg, "demo@1.0.0");
});

test("allow does NOT apply when the sha256 pin mismatches (different bytes)", () => {
  const config = validateConfig({ allow: [{ pkg: "demo@1.0.0", sha256: "deadbeef" }] }, []);
  const r = applyConfig(report(HIGH_CRED.map((f) => ({ ...f }))), {
    config,
    packageName: "demo",
    version: "1.0.0",
    sha256: "0ther0ther"
  });
  assert.equal(r.verdict, "block"); // pin didn't match → allow ignored
  assert.equal(r.configEffects.allowlisted, null);
});

test("allow does NOT apply to a different version (pinned to reviewed bytes)", () => {
  const config = validateConfig({ allow: [{ pkg: "demo@1.0.0", sha256: "deadbeef" }] }, []);
  const r = applyConfig(report(HIGH_CRED.map((f) => ({ ...f }))), {
    config,
    packageName: "demo",
    version: "1.1.0",
    sha256: "deadbeef"
  });
  assert.equal(r.verdict, "block");
});

test("invariant 2: an allow cannot wave away a published vulnerability", () => {
  const config = validateConfig({ allow: [{ pkg: "demo@1.0.0", sha256: "deadbeef" }] }, []);
  const findings = [
    { severity: "high", category: "known-vulnerability", file: "VULN" },
    { severity: "high", category: "credential-access", file: "index.js" }
  ];
  const r = applyConfig(report(findings), { config, packageName: "demo", version: "1.0.0", sha256: "deadbeef" });
  assert.equal(r.verdict, "block");
  assert.equal(r.configEffects.allowlisted, null);
  assert.ok(r.configEffects.ignoredAllow);
  assert.equal(r.configEffects.ignoredAllow.reason, "known-vulnerability");
});

test("an expired allow is not applied", () => {
  const config = validateConfig(
    { allow: [{ pkg: "demo@1.0.0", sha256: "deadbeef", expires: "2000-01-01" }] },
    []
  );
  const r = applyConfig(report(HIGH_CRED.map((f) => ({ ...f }))), {
    config,
    packageName: "demo",
    version: "1.0.0",
    sha256: "deadbeef",
    now: Date.parse("2026-01-01")
  });
  assert.equal(r.verdict, "block");
  assert.equal(r.configEffects.ignoredAllow.reason, "expired");
});

// --- exit codes & scan-error policy ---------------------------------------

test("exitCodeForVerdict honors failOn thresholds", () => {
  assert.equal(exitCodeForVerdict("block", { failOn: "review" }), 2);
  assert.equal(exitCodeForVerdict("review", { failOn: "review" }), 3);
  assert.equal(exitCodeForVerdict("review", { failOn: "block" }), 0);
  assert.equal(exitCodeForVerdict("safe", { failOn: "review" }), 0);
  assert.equal(exitCodeForVerdict("block", { failOn: "never" }), 0);
});

test("scan errors are fail-closed (review) by default, fail-open only when set", () => {
  assert.equal(verdictForScanError({ scanErrorPolicy: "fail-closed" }), "review");
  assert.equal(verdictForScanError({}), "review");
  assert.equal(verdictForScanError({ scanErrorPolicy: "fail-open" }), "safe");
});

// --- rendering & MCP -------------------------------------------------------

test("renderConfigEffects surfaces mutes and allowlists in the report", () => {
  const effects = {
    mutedCount: 1,
    muted: [{ category: "install-hook", file: "package.json" }],
    allowlisted: { pkg: "demo@1.0.0", reason: "reviewed" },
    notices: []
  };
  const lines = renderConfigEffects(effects);
  assert.ok(lines.some((l) => /muted/.test(l)));
  assert.ok(lines.some((l) => /allowlisted/.test(l)));
});

test("MCP config starts stricter and can filter exposed tools", () => {
  const config = validateConfig({ mcp: { tools: ["audit"], packageScanFirst: true } }, []);
  const mcp = mcpConfig(config);
  assert.equal(mcp.packageScanFirst, true);
  assert.equal(mcpToolAllowed(config, "audit"), true);
  assert.equal(mcpToolAllowed(config, "guard"), false);
});

test("disabling mcp.packageScanFirst is a loud warning", () => {
  const warnings = [];
  validateConfig({ mcp: { packageScanFirst: false } }, warnings);
  assert.ok(warnings.some((w) => /without a static package scan/.test(w)));
});
