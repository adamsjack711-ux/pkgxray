"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { bindArtifact, createDistributionReceipt, verifyDistributionReceipt } = require("../src/distribution/receipt");

test("distribution receipts bind exact bytes and never authorize installation", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkgxray-receipt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "artifact.zip");
  fs.writeFileSync(file, "original bytes");
  const binding = await bindArtifact(file);
  const result = { schemaVersion: 1, family: "executable-distribution", verdict: "review", findings: [] };
  const receipt = createDistributionReceipt({
    artifact: binding,
    result,
    checks: { acquisition: "completed", extraction: "completed", descriptors: "completed", source: "partial", recursive: "partial", provenance: "unsupported" },
    provenance: { status: "unsupported", cryptographicallyVerified: false, identityBound: false }
  });
  assert.equal(receipt.artifact.sha256, binding.sha256);
  assert.equal(receipt.authorization.install, false);
  assert.equal((await verifyDistributionReceipt(file, receipt, { result })).valid, true);
  assert.equal((await verifyDistributionReceipt(file, receipt, { result: { ...result, verdict: "safe" } })).valid, false);
  fs.appendFileSync(file, "tamper");
  assert.equal((await verifyDistributionReceipt(file, receipt)).valid, false);
});

test("artifact binding enforces expected digest and byte limits", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkgxray-binding-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "artifact"); fs.writeFileSync(file, "12345");
  await assert.rejects(bindArtifact(file, { expectedSha256: "0".repeat(64) }), /mismatch/);
  await assert.rejects(bindArtifact(file, { maxArtifactBytes: 4 }), /exceeds/);
  const sri = `sha512-${crypto.createHash("sha512").update("12345").digest("base64")}`;
  assert.equal((await bindArtifact(file, { integrity: sri })).size, 5);
  await assert.rejects(bindArtifact(file, { integrity: `sha512-${Buffer.alloc(64).toString("base64")}` }), /integrity mismatch/);
});
