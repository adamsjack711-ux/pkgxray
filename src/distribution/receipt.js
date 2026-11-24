"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const artifact = require("../artifact");

const DEFAULT_MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

async function bindArtifact(file, options = {}) {
  const limit = options.maxArtifactBytes || DEFAULT_MAX_ARTIFACT_BYTES;
  const hash = crypto.createHash("sha256");
  const integrity = options.integrity ? artifact.integrityEntries(options.integrity) : null;
  const integrityHash = integrity ? crypto.createHash(integrity[0].algorithm) : null;
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) {
    size += chunk.length;
    if (size > limit) throw new Error(`Artifact exceeds ${limit} bytes`);
    hash.update(chunk);
    if (integrityHash) integrityHash.update(chunk);
  }
  const sha256 = hash.digest("hex");
  if (options.expectedSha256) {
    const expected = String(options.expectedSha256).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expected) || !crypto.timingSafeEqual(Buffer.from(sha256, "hex"), Buffer.from(expected, "hex"))) {
      throw new Error("Artifact SHA-256 mismatch");
    }
  }
  if (integrity) {
    const digest = integrityHash.digest();
    if (!integrity.some(entry => crypto.timingSafeEqual(entry.digest, digest))) throw new Error("Artifact integrity mismatch");
  }
  return { path: file, size, sha256 };
}

function normalizeChecks(checks = {}) {
  const allowed = new Set(["completed", "partial", "failed", "unsupported", "not-requested"]);
  return Object.fromEntries(["acquisition", "extraction", "descriptors", "source", "recursive", "provenance"].map(name => {
    const value = checks[name] || "not-requested";
    if (!allowed.has(value)) throw new Error(`Invalid ${name} check state: ${value}`);
    return [name, value];
  }));
}

function receiptEvidence(result) {
  if (!result || typeof result !== "object") return result;
  const copy = { ...result };
  delete copy.receipt;
  delete copy.extractedRoot;
  return copy;
}

function createDistributionReceipt({ artifact: binding, result, checks, provenance, policy = null }) {
  if (!binding || !/^[a-f0-9]{64}$/.test(binding.sha256) || !Number.isSafeInteger(binding.size)) throw new Error("A SHA-256 artifact binding is required");
  if (!result || result.schemaVersion !== 1 || !result.verdict) throw new Error("A completed distribution result is required");
  const normalizedChecks = normalizeChecks(checks);
  const evidenceSha256 = artifact.fingerprint(receiptEvidence(result));
  const analysisSha256 = artifact.fingerprint({ family: result.family, metadata: result.metadata || null, checks: normalizedChecks });
  const policySha256 = artifact.fingerprint(policy || {});
  return {
    schemaVersion: 1,
    kind: "pkgxray-distribution-receipt",
    artifact: { sha256: binding.sha256, size: binding.size },
    scannerBuildId: artifact.BUILD_ID,
    analysisSha256,
    evidenceSha256,
    policySha256,
    verdict: result.verdict,
    checks: normalizedChecks,
    provenance: provenance || { status: "not-requested", cryptographicallyVerified: false, identityBound: false },
    authorization: { install: false, reason: "distribution receipts bind evidence but do not approve installation" },
    issuedAt: new Date().toISOString()
  };
}

async function verifyDistributionReceipt(file, receipt, options = {}) {
  if (!receipt || receipt.schemaVersion !== 1 || receipt.kind !== "pkgxray-distribution-receipt") return { valid: false, reason: "unsupported receipt" };
  let binding;
  try { binding = await bindArtifact(file, options); }
  catch (error) { return { valid: false, reason: error.message }; }
  if (binding.sha256 !== receipt.artifact?.sha256 || binding.size !== receipt.artifact?.size) return { valid: false, reason: "artifact bytes do not match receipt" };
  const scannerMatches = receipt.scannerBuildId === artifact.BUILD_ID;
  const evidenceMatches = options.result ? receipt.evidenceSha256 === artifact.fingerprint(receiptEvidence(options.result)) : null;
  const policyMatches = options.policy ? receipt.policySha256 === artifact.fingerprint(options.policy) : null;
  if (evidenceMatches === false) return { valid: false, reason: "scan evidence does not match receipt", binding, scannerMatches, evidenceMatches };
  if (policyMatches === false) return { valid: false, reason: "policy does not match receipt", binding, scannerMatches, evidenceMatches, policyMatches };
  return { valid: true, binding, scannerMatches, evidenceMatches, policyMatches };
}

module.exports = { bindArtifact, createDistributionReceipt, normalizeChecks, receiptEvidence, verifyDistributionReceipt };
