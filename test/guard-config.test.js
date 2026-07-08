"use strict";

// End-to-end tests for the shared config layer wired into bin/audit.js.
//
// These drive the actual CLI via child_process so the whole chain is exercised:
// loadConfig at startup → applyConfig on the report → renderConfigEffects in
// the output → exitCodeForVerdict for the process exit code. The single-file
// audit path (`--file` / stdin) is used because it runs fully offline from a
// crafted evidence JSON, so identity + sha256 are deterministic and no network
// or tarball staging is involved.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const AUDIT_BIN = path.join(__dirname, "..", "bin", "audit.js");

// A package whose only real signal is an install hook (medium → verdict
// "review"). Muting `install-hook` drops it and the package folds to "safe".
function evidenceWithInstallHook() {
  return {
    packageName: "demo-pkg",
    npmMetadata: {
      name: "demo-pkg",
      version: "1.0.0",
      repository: "https://github.com/example/demo-pkg"
    },
    version: "1.0.0",
    sourceFiles: {
      "package.json": JSON.stringify({
        name: "demo-pkg",
        version: "1.0.0",
        repository: "https://github.com/example/demo-pkg",
        scripts: { postinstall: "node setup.js" }
      })
    }
  };
}

// Run bin/audit.js in `cwd` with the given argv, feeding `stdin`. Returns
// { status, stdout, stderr, json? }.
function runAudit(cwd, argv, stdin) {
  const res = spawnSync(process.execPath, [AUDIT_BIN, ...argv], {
    cwd,
    input: stdin,
    encoding: "utf8"
  });
  if (res.error) throw res.error;
  const out = { status: res.status, stdout: res.stdout, stderr: res.stderr };
  return out;
}

async function tempProject(configObject) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pkgxray-cfg-"));
  if (configObject !== undefined) {
    fs.writeFileSync(path.join(dir, ".pkgxray.json"), JSON.stringify(configObject, null, 2));
  }
  return dir;
}

test("muted finding is surfaced in the report but excluded from the verdict", async () => {
  const dir = await tempProject({
    mute: [{ check: "install-hook", scope: "*", reason: "reviewed internally" }]
  });
  try {
    const evidence = evidenceWithInstallHook();

    // JSON output: the finding is kept (tagged muted:true) and configEffects
    // records the mute; the verdict is re-folded without it → "safe".
    const json = runAudit(dir, ["--format", "json"], JSON.stringify(evidence));
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.verdict, "safe", "muted install-hook should fold verdict to safe");

    const installHook = parsed.findings.find((f) => f.category === "install-hook");
    assert.ok(installHook, "the muted finding is still present in the report");
    assert.equal(installHook.muted, true, "the finding is tagged muted for transparency");

    assert.ok(parsed.configEffects, "configEffects is present in JSON output");
    assert.equal(parsed.configEffects.mutedCount, 1);

    // Exit 0 under the default failOn:"review" now that nothing survives.
    assert.equal(json.status, 0, "safe verdict exits 0");

    // Human/markdown output surfaces the mute loudly.
    const md = runAudit(dir, [], JSON.stringify(evidence));
    assert.match(md.stdout, /Config: 1 finding\(s\) muted by \.pkgxray\.json/);
    assert.match(md.stdout, /install-hook@package\.json/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("without a mute, the same install-hook finding produces review (exit 3)", async () => {
  // Baseline: no config file at all → maximum strictness, install-hook survives.
  const dir = await tempProject(undefined);
  try {
    const evidence = evidenceWithInstallHook();
    const res = runAudit(dir, ["--format", "json"], JSON.stringify(evidence));
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.verdict, "review");
    assert.equal(res.status, 3, "default config reproduces today's review→3 exit code");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("a pinned allow with a matching sha256 forces the verdict to safe", async () => {
  const evidence = evidenceWithInstallHook();
  const sha256 = "a".repeat(64);
  evidence.sha256 = sha256; // the single-file path reads evidence.sha256

  const dir = await tempProject({
    allow: [
      {
        pkg: "demo-pkg@1.0.0",
        sha256,
        reason: "vetted 2026-07"
      }
    ]
  });
  try {
    const res = runAudit(dir, ["--format", "json"], JSON.stringify(evidence));
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.verdict, "safe", "pinned+matching-sha allow forces safe");
    assert.ok(parsed.configEffects.allowlisted, "allowlist effect is recorded");
    assert.equal(parsed.configEffects.allowlisted.pkg, "demo-pkg@1.0.0");
    assert.equal(res.status, 0);

    // Markdown surfaces the allowlisting loudly.
    const md = runAudit(dir, [], JSON.stringify(evidence));
    assert.match(md.stdout, /Config: allowlisted `demo-pkg@1\.0\.0`/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("a pinned allow with a NON-matching sha256 does not apply", async () => {
  const evidence = evidenceWithInstallHook();
  evidence.sha256 = "b".repeat(64); // scanned bytes differ from the pin

  const dir = await tempProject({
    allow: [{ pkg: "demo-pkg@1.0.0", sha256: "a".repeat(64), reason: "vetted" }]
  });
  try {
    const res = runAudit(dir, ["--format", "json"], JSON.stringify(evidence));
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.verdict, "review", "sha mismatch → allow not applied, package scanned normally");
    assert.equal(parsed.configEffects.allowlisted, null);
    assert.equal(res.status, 3);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("failOn changes the exit code for the same verdict", async () => {
  const evidence = evidenceWithInstallHook(); // verdict "review"

  // failOn:"block" → review no longer fails the run (exit 0), block still 2.
  const blockDir = await tempProject({ failOn: "block" });
  // failOn:"never" → nothing fails the run.
  const neverDir = await tempProject({ failOn: "never" });
  try {
    const blockRes = runAudit(blockDir, ["--format", "json"], JSON.stringify(evidence));
    assert.equal(JSON.parse(blockRes.stdout).verdict, "review");
    assert.equal(blockRes.status, 0, 'failOn:"block" lets a review pass (exit 0)');

    const neverRes = runAudit(neverDir, ["--format", "json"], JSON.stringify(evidence));
    assert.equal(neverRes.status, 0, 'failOn:"never" never fails on the verdict');
  } finally {
    await fsp.rm(blockDir, { recursive: true, force: true });
    await fsp.rm(neverDir, { recursive: true, force: true });
  }
});

test("config warnings are printed loudly to stderr (loosening is never silent)", async () => {
  // policy "allow-review" is a loosening → the loader emits a warning.
  const dir = await tempProject({ policy: "allow-review" });
  try {
    const evidence = evidenceWithInstallHook();
    const res = runAudit(dir, ["--format", "json"], JSON.stringify(evidence));
    assert.match(res.stderr, /^pkgxray: /m, "warnings are prefixed and go to stderr");
    assert.match(res.stderr, /allow-review/);
    // allow-review promotes review-grade to "allow" → exit 0 (today's behavior).
    assert.equal(res.status, 0);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("--policy CLI flag overrides the config file policy", async () => {
  // File says safe-only; the flag loosens to allow-review, which must win and
  // warn. The review-grade package is then promoted → exit 0.
  const dir = await tempProject({ policy: "safe-only" });
  try {
    const evidence = evidenceWithInstallHook();
    const res = runAudit(dir, ["--policy", "allow-review", "--format", "json"], JSON.stringify(evidence));
    assert.match(res.stderr, /allow-review/, "CLI --policy override is applied and warns");
    assert.equal(res.status, 0, "allow-review promotes review → exit 0");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
