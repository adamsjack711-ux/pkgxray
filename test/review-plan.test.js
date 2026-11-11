"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildReviewPlan, renderReviewPlan } = require("../src/review-plan");
const { reviewOutcome, rejectManualReviewOptions } = require("../src/review");
const { guardExtension } = require("../src/quarantine");
const { receiptAuthorizes } = require("../src/approval-policy");
const cfg = require("../src/config");
const { parseArgs } = require("../bin/audit");
const transport = require("../src/http-client");
const passive = { githubMetadata: false, githubDiff: false, provenance: false };

async function fixture(t, { scripts = false, missing = false, identity = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pkgxray-automatic-guard-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "package");
  await fs.mkdir(source);
  const manifest = { ...(identity ? { name: "automatic-guard-fixture", version: "1.0.0" } : {}), main: missing ? "missing.js" : "index.js",
    ...(scripts ? { scripts: { postinstall: "node install.js" } } : {}) };
  await fs.writeFile(path.join(source, "package.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(source, "index.js"), "module.exports = 42;\n");
  // Dynamic arguments deliberately stay outside the literal lifecycle proof.
  if (scripts) await fs.writeFile(path.join(source, "install.js"), "console.log('do not execute', process.platform);\n");
  const original = transport.requestJson;
  t.after(() => { transport.requestJson = original; });
  const requests = [];
  const reply = fn => { transport.requestJson = async (url, options) => {
    assert.equal(url, "https://api.osv.dev/v1/query"); requests.push({ body: JSON.parse(options.body), deadline: options.deadline, signal: options.signal });
    return fn(requests.length, options);
  }; };
  reply(async () => ({}));
  return { source, root, requests, reply };
}
const transient = () => Object.assign(new Error("HTTP 503 from intelligence service"), { statusCode: 503 });

test("missing transient intelligence retries once on the same identity and deadline", async t => {
  const f = await fixture(t);
  f.reply(async n => { if (n === 1) throw transient(); return {}; });
  const result = await guardExtension(f.source, passive);
  assert.equal(result.decision, "allow");
  assert.equal(result.allowed, true);
  assert.equal(result.outcome, "SAFE");
  assert.deepEqual(result.resolution.retry, { attempted: true, attempts: 1, check: "vulnerabilities" });
  assert.deepEqual(result.resolution.reasonCodes, []);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[0].body, f.requests[1].body);
  assert.equal(f.requests[0].deadline, f.requests[1].deadline);
  assert.equal(result.review, null);
  assert.equal(result.reviewPlan, null);
});

test("persistent missing intelligence blocks after two attempts even with fail-open", async t => {
  const f = await fixture(t);
  f.reply(async () => { throw transient(); });
  const result = await guardExtension(f.source, { ...passive, scanErrorPolicy: "fail-open", policy: "allow-review", promoteTo: path.join(f.root, "out") });
  assert.equal(f.requests.length, 2);
  assert.equal(result.decision, "block");
  assert.equal(result.allowed, false);
  assert.equal(result.outcome, "UNSAFE");
  assert.equal(result.promotedPath, null);
  assert.ok(result.resolution.reasonCodes.includes("vulnerability-check-unavailable"));
  assert.ok(result.report.findings.some(finding => finding.category === "vulnerability-data-unavailable"));
  await assert.rejects(fs.stat(path.join(f.root, "out")), { code: "ENOENT" });
});

test("a retry that discovers known vulnerability blocks and preserves the finding", async t => {
  const f = await fixture(t);
  f.reply(async n => { if (n === 1) throw transient(); return { vulns: [{ id: "SYNTHETIC-ADVISORY", summary: "Synthetic fixture" }] }; });
  const result = await guardExtension(f.source, passive);
  assert.equal(f.requests.length, 2);
  assert.equal(result.decision, "block");
  assert.ok(result.report.findings.some(finding => finding.category === "known-vulnerability"));
  assert.ok(result.resolution.reasonCodes.includes("blocking-findings"));
});

test("malformed evidence, permanent HTTP failures and missing identity do not loop", async t => {
  for (const response of [async () => ({ vulns: {} }), async () => { throw Object.assign(new Error("HTTP 403"), { statusCode: 403 }); }]) {
    const f = await fixture(t); f.reply(response);
    const result = await guardExtension(f.source, passive);
    assert.equal(f.requests.length, 1);
    assert.equal(result.decision, "block");
    assert.equal(result.resolution.retry.attempted, false);
  }
  const f = await fixture(t, { identity: false });
  const result = await guardExtension(f.source, passive);
  assert.equal(f.requests.length, 0);
  assert.equal(result.decision, "block");
  assert.equal(result.assessment.checks.vulnerabilities, "failed");
});

test("retry shares the original budget rather than doubling a timed-out check", async t => {
  const f = await fixture(t);
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  f.reply(async () => { now += 15001; throw Object.assign(new Error("HTTP request timed out"), { code: "ETIMEDOUT" }); });
  const result = await guardExtension(f.source, passive);
  assert.equal(f.requests.length, 1);
  assert.equal(result.decision, "block");
  assert.equal(result.resolution.retry.attempted, false);
});

test("cancellation prevents retry and promotion", async t => {
  const f = await fixture(t), controller = new AbortController();
  f.reply(async () => { controller.abort(); throw transient(); });
  await assert.rejects(guardExtension(f.source, { ...passive, signal: controller.signal, promoteTo: path.join(f.root, "out") }), { name: "AbortError" });
  assert.equal(f.requests.length, 1);
  await assert.rejects(fs.stat(path.join(f.root, "out")), { code: "ENOENT" });
});

test("disabled checks and incomplete source stay blocked without reenabling or repeated scans", async t => {
  const f = await fixture(t, { missing: true });
  const result = await guardExtension(f.source, { ...passive, vulnerabilityCheck: false, policy: "allow-review" });
  assert.equal(f.requests.length, 0);
  assert.equal(result.decision, "block");
  assert.equal(result.resolution.retry.attempted, false);
  assert.ok(result.resolution.reasonCodes.includes("vulnerability-check-disabled"));
  assert.ok(result.resolution.reasonCodes.includes("incomplete-source-scan"));
  const disabled = await guardExtension(f.source, { ...passive, sourceScan: false });
  assert.equal(disabled.decision, "block");
  assert.ok(disabled.resolution.reasonCodes.includes("source-check-disabled"));
});

test("heuristic uncertainty becomes a final block with raw findings and no manual plan", async t => {
  const f = await fixture(t, { scripts: true });
  const result = await guardExtension(f.source, passive);
  assert.equal(result.report.verdict, "review");
  assert.equal(result.assessment.rawVerdict, "review");
  assert.equal(result.decision, "block");
  assert.equal(result.outcome, "UNSAFE");
  assert.ok(result.resolution.reasonCodes.includes("uncertain-findings"));
  assert.equal(result.review, null); assert.equal(result.reviewPlan, null);
  assert.equal(f.requests.length, 1);
  assert.equal(buildReviewPlan(result), null);
  assert.deepEqual(renderReviewPlan(result), []);
});

test("legacy manual options and flags are rejected before reading or writing a store", async t => {
  const f = await fixture(t);
  for (const field of ["reviewId", "reviewChoice", "reviewDecisions", "reviewScope", "reviewAction"]) {
    await assert.rejects(guardExtension(f.source, { ...passive, [field]: "Proceed" }), /Manual REVIEW options have been removed/);
    assert.throws(() => rejectManualReviewOptions({ [field]: undefined }), /Manual REVIEW/);
  }
  for (const flag of ["--review-choice", "--review-id", "--review-for-install", "--review-choice=Proceed"]) {
    assert.throws(() => parseArgs(["guard", f.source, flag, "Proceed"]), /Manual REVIEW flags have been removed/);
  }
  assert.equal(f.requests.length, 0);
  assert.equal(require("../src/review").ReviewDecisions, undefined);
  assert.equal(require("../src/review").LocalReviewDecisions, undefined);
  assert.deepEqual(reviewOutcome("review", { decisions: { present: () => "Proceed" } }), { outcome: "UNSAFE", allowed: false, review: null });
});

test("old review receipts and operator overrides cannot clear mandatory holds", () => {
  const receipt = { schemaVersion: 2, decision: "allow", sourceComplete: true,
    checks: { source: "completed", vulnerabilities: "completed" },
    authorization: { mandatoryHoldReasons: [], behavioralCoverage: "completed", explicitOverride: false } };
  assert.equal(receiptAuthorizes(receipt), true);
  assert.equal(receiptAuthorizes({ ...receipt, decision: "review" }, { allowReview: true }), false);
  assert.equal(receiptAuthorizes({ ...receipt, authorization: { ...receipt.authorization, mandatoryHoldReasons: ["flow-analysis-gap"], explicitOverride: true } }), false);
  for (const options of [{ sourceScan: false }, { vulnerabilityCheck: false }, { vulnerabilityScanError: "network down", config: { scanErrorPolicy: "fail-open" } }, { sourceCoverage: { complete: false } }]) {
    assert.equal(cfg.guardDecision({ verdict: "safe", findings: [], configEffects: { allowlisted: {} } }, options), "block");
  }
});

test("guard CLI never returns success for disabled checks even with failOn never", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, ".pkgxray.json"), JSON.stringify({ failOn: "never", scanErrorPolicy: "fail-open", policy: "allow-review" }));
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../bin/audit.js"), "guard", f.source,
    "--no-vulnerability-check", "--no-github-diff", "--format", "json"], { cwd: f.root, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 2, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, "block");
  assert.equal(output.allowed, false);
  assert.ok(output.resolution.reasonCodes.includes("vulnerability-check-disabled"));
});
