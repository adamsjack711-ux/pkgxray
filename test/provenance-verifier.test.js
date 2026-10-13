"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { parseAttestation, verifyFetchedProvenance } = require("../src/attestation");
const { auditEvidence } = require("../src/auditor");
const config = require("../src/config");
const { verifyProvenanceBundle, resolveVerifier, boundSubject, digestBytes, expectedIdentity, runVerifier } = require("../src/provenance-verifier");
const fixture = require("./fixtures/attestation-actions-core-1.11.1.json");
const signed = fixture.attestations.find(entry => parseAttestation(entry));
const primary = parseAttestation(signed);
const identity = "https://github.com/actions/toolkit/.github/workflows/releases.yml@refs/heads/main";
const options = { packageName: "@actions/core", version: "1.11.1", repository: "https://github.com/actions/toolkit",
  digests: { sha512: primary.subjectDigests[0].digest.sha512 } };

test("provenance binding requires exact package identity and full strong digests", () => {
  assert.equal(boundSubject(primary, options.packageName, options.version, options.digests), true);
  assert.equal(boundSubject(primary, options.packageName, "1.11.2", options.digests), false);
  assert.equal(boundSubject(primary, "@lookalike/core", options.version, options.digests), false);
  assert.equal(boundSubject(primary, options.packageName, options.version, { sha512: "00".repeat(64) }), false);
  assert.equal(boundSubject({ subjectDigests: [{ name: "pkg:npm/demo@1.0.0", digest: { sha1: "aa".repeat(20) } }] }, "demo", "1.0.0", { sha1: "aa".repeat(20) }), false);
  const bytes = crypto.createHash("sha512").update("inert artifact").digest();
  assert.deepEqual(digestBytes(bytes.toString("hex").toUpperCase(), "sha512"), bytes);
  assert.deepEqual(digestBytes(bytes.toString("base64"), "sha512"), bytes);
  assert.equal(digestBytes("deadbeef", "sha512"), null);
  // Base64 is case-sensitive; it cannot be compared after lowercasing.
  assert.notDeepEqual(digestBytes(bytes.toString("base64").toLowerCase(), "sha512"), bytes);
});

test("signer policy rejects unrelated repos, path escapes and ambiguous identities", () => {
  assert.equal(expectedIdentity(primary, options.repository), identity);
  assert.equal(expectedIdentity(primary, "git+https://github.com/actions/toolkit.git"), identity);
  for (const repository of ["https://github.com/other/toolkit", "https://github.com.attacker.invalid/actions/toolkit", "https://github.com/actions/toolkit/extra", "http://github.com/actions/toolkit"]) {
    assert.equal(expectedIdentity(primary, repository), null);
  }
  for (const extra of [{ workflowPath: ".github/workflows/../other.yml" }, { ref: "refs/heads/main@evil" }, { ref: "refs/heads/main\n" }]) {
    assert.equal(expectedIdentity({ ...primary, ...extra }, options.repository), null);
  }
});

test("replayed provenance fails artifact identity before invoking cryptography", async () => {
  let called = false;
  const result = await verifyProvenanceBundle(signed, { ...options, version: "1.11.2", backendRunner: async () => { called = true; } });
  assert.equal(result.status, "invalid");
  assert.equal(result.reason, "artifact-subject-mismatch");
  assert.equal(called, false);
});

test("a signed object must be an in-toto SLSA statement, not a lookalike payload", async () => {
  const altered = structuredClone(signed);
  const statement = JSON.parse(Buffer.from(altered.bundle.dsseEnvelope.payload, "base64"));
  delete statement.predicateType;
  altered.bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
  assert.equal((await verifyProvenanceBundle(altered, options)).reason, "invalid-statement-type");
});

test("missing verifiers and legacy cached claims cannot become authenticated", async () => {
  assert.equal(resolveVerifier("node_modules/sigstore"), null);
  const result = await verifyProvenanceBundle(signed, { ...options, modulePath: path.join(os.tmpdir(), "does-not-exist-pkgxray-verifier") });
  assert.equal(result.status, "unverified");
  const cached = await verifyFetchedProvenance({ attested: true, primary: { ...primary, cryptographicallyVerified: true } }, { ...options, required: true });
  assert.equal(cached.verification.status, "unverified");
  assert.equal(cached.primary.cryptographicallyVerified, false);
  const absent = await verifyFetchedProvenance({ attested: false, reason: "no-attestation" }, { required: true });
  assert.equal(absent.verification.status, "absent");
  assert.equal(absent.verification.required, true);
});

test("verifier subprocess has a real deadline, bounded output and scrubbed credentials", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pkgxray-verifier-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, "index.js");
  const backend = { modulePath };
  await fs.writeFile(modulePath, "exports.verify=()=>new Promise(()=>setInterval(()=>{},10));");
  const started = Date.now();
  assert.equal((await runVerifier(backend, signed.bundle, identity, 150)).reason, "verification-timeout");
  assert.ok(Date.now() - started < 3000);
  await fs.writeFile(modulePath, "exports.verify=async()=>{process.stdout.write('x'.repeat(40000));};");
  assert.equal((await runVerifier(backend, signed.bundle, identity, 3000)).reason, "verification-output-limit");
  await fs.writeFile(modulePath, "exports.verify=async(b,o)=>{if(process.env.NODE_OPTIONS||process.env.GITHUB_TOKEN||o.tlogThreshold!==1||o.ctLogThreshold!==1||!o.certificateIdentityURI.test('https://github.com/actions/toolkit/.github/workflows/releases.yml@refs/heads/main')||o.certificateIdentityURI.test('https://githubXcom/actions/toolkit/.github/workflows/releases.yml@refs/heads/main'))throw Error('bad verification boundary');};");
  const previous = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "synthetic-secret";
  try { assert.equal((await runVerifier(backend, signed.bundle, identity, 3000)).status, "verified"); }
  finally { if (previous === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = previous; }
});

test("required provenance is a hold, invalid provenance blocks, authenticated provenance never offsets malware", () => {
  const clean = { sourceFiles: { "package.json": '{"name":"demo","version":"1.0.0"}', "index.js": "module.exports=1" } };
  for (const status of ["absent", "unverified"]) {
    const report = auditEvidence({ ...clean, provenanceAttestation: { attested: false, verification: { status, required: true } } });
    assert.equal(report.verdict, "review");
    assert.ok(report.findings.some(f => f.category === "unverified-provenance"));
  }
  assert.equal(auditEvidence({ ...clean, provenanceAttestation: { verification: { status: "invalid", reason: "SIGNATURE_VERIFICATION_ERROR" } } }).verdict, "block");
  const malicious = { ...clean, sourceFiles: { ...clean.sourceFiles, "index.js": "const fs=require('fs');fs.readFileSync('/tmp/.ssh/id_rsa');" } };
  const base = auditEvidence(malicious);
  const attested = auditEvidence({ ...malicious, provenanceAttestation: { attested: true, primary,
    verification: { status: "verified", artifactBound: true, verifier: "controlled boundary fixture" } } });
  assert.equal(attested.verdict, base.verdict);
  assert.equal(attested.score, base.score);
  for (const category of ["unverified-provenance", "provenance-invalid"]) {
    const report = auditEvidence({ ...clean, provenanceAttestation: {
      verification: { status: category === "provenance-invalid" ? "invalid" : "unverified", required: true }
    } });
    const applied = config.applyConfig(report, { packageName: "demo", version: "1.0.0", sha256: "a".repeat(64), config: {
      ...config.DEFAULTS, policy: "allow-review", allow: [{ name: "demo", version: "1.0.0", sha256: "a".repeat(64) }],
      mute: [{ check: category, scope: "all" }]
    } });
    assert.equal(applied.configEffects.allowlisted, null);
    assert.ok(applied.findings.some(f => f.category === category && !f.muted));
    assert.notEqual(config.guardDecision(applied, { policy: "allow-review" }), "allow");
  }
});

test("real Sigstore accepts signed historical bundle and rejects mutated signature and signer policy", {
  skip: process.env.PKGXRAY_TEST_SIGSTORE !== "1", timeout: 60000
}, async () => {
  assert.ok(resolveVerifier(), "this explicit integration check requires a maintained installed Sigstore SDK");
  assert.equal((await verifyProvenanceBundle(signed, options)).status, "verified");
  const altered = structuredClone(signed);
  const statement = JSON.parse(Buffer.from(altered.bundle.dsseEnvelope.payload, "base64"));
  statement.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/other.yml";
  altered.bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
  assert.equal((await verifyProvenanceBundle(altered, options)).status, "invalid");
  const backend = resolveVerifier();
  assert.equal((await runVerifier(backend, signed.bundle, identity + "-lookalike", 15000)).status, "invalid");
});

test("held historical npm archive supplies signer policy from acquired package bytes", {
  skip: process.env.PKGXRAY_TEST_SIGSTORE !== "1", timeout: 60000
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pkgxray-signed-archive-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archivePath = path.join(root, "core.tgz");
  await require("../src/http-client").downloadFile("https://registry.npmjs.org/@actions/core/-/core-1.11.1.tgz", archivePath, {
    maxBytes: 4 * 1024 * 1024,
    validate(raw) {
      const url = new URL(raw);
      if (url.origin !== "https://registry.npmjs.org") throw new Error("Unexpected historical archive origin");
      return { url };
    }
  });
  const bytes = await fs.readFile(archivePath);
  const result = await require("../src/quarantine").guardExtension("npm:@actions/core@1.11.1", {
    vulnerabilityCheck: false, githubMetadata: false, githubDiff: false, provenance: true,
    artifact: { archivePath, integrity: `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}` }
  });
  assert.equal(result.provenanceAttestation.verification.status, "verified");
  assert.equal(result.provenanceAttestation.verification.artifactBound, true);
  assert.equal(result.provenanceAttestation.verification.certificateIdentity, identity);
  assert.equal(result.resolved.npmMetadata.repository.url, "git+https://github.com/actions/toolkit.git");
  assert.equal(result.approval.artifactSha256, crypto.createHash("sha256").update(bytes).digest("hex"));
});
