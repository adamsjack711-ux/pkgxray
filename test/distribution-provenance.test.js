"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { extensionId, verifyArtifactProvenance, verifyCrxBuffer } = require("../src/distribution/provenance");
const { verifyDistributionProvenanceBundle } = require("../src/provenance-verifier");

function sigstoreBundle(sha256, name = "artifact.zip") {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name, digest: { sha256 } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {}
  };
  return {
    mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.3",
    verificationMaterial: {},
    dsseEnvelope: {
      payloadType: "application/vnd.in-toto+json",
      payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
      signatures: [{ sig: "synthetic-test-signature" }]
    }
  };
}

function fakeVerifier(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkgxray-distribution-sigstore-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "sigstore", version: "3.0.0" }));
  fs.writeFileSync(path.join(root, "index.js"), "exports.verify=async()=>{};");
  return root;
}

function crx2(archive, tamper = false) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
  const key = publicKey.export({ format: "der", type: "spki" });
  const signature = crypto.sign("RSA-SHA1", archive, privateKey);
  const header = Buffer.alloc(16);
  header.write("Cr24"); header.writeUInt32LE(2, 4); header.writeUInt32LE(key.length, 8); header.writeUInt32LE(signature.length, 12);
  const bytes = Buffer.concat([header, key, signature, archive]);
  if (tamper) bytes[bytes.length - 1] ^= 1;
  return { bytes, id: extensionId(key) };
}

function varint(value) {
  const bytes = [];
  do { bytes.push((value & 0x7f) | (value > 0x7f ? 0x80 : 0)); value = Math.floor(value / 128); } while (value);
  return Buffer.from(bytes);
}

function bytesField(number, value) {
  return Buffer.concat([varint(number * 8 + 2), varint(value.length), value]);
}

function crx3(archive) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
  const key = publicKey.export({ format: "der", type: "spki" });
  const id = crypto.createHash("sha256").update(key).digest().subarray(0, 16);
  const signedHeader = bytesField(1, id);
  const prefix = Buffer.from("CRX3 SignedData\0", "binary");
  const length = Buffer.alloc(4); length.writeUInt32LE(signedHeader.length);
  const signature = crypto.sign("sha256", Buffer.concat([prefix, length, signedHeader, archive]), privateKey);
  const proof = Buffer.concat([bytesField(1, key), bytesField(2, signature)]);
  const protobuf = Buffer.concat([bytesField(2, proof), bytesField(10000, signedHeader)]);
  const header = Buffer.alloc(12); header.write("Cr24"); header.writeUInt32LE(3, 4); header.writeUInt32LE(protobuf.length, 8);
  return { bytes: Buffer.concat([header, protobuf, archive]), id: extensionId(key) };
}

test("CRX2 signatures bind the embedded archive and extension identity", () => {
  const fixture = crx2(Buffer.from("PK\x03\x04fixture"));
  const result = verifyCrxBuffer(fixture.bytes);
  assert.equal(result.status, "verified");
  assert.equal(result.cryptographicallyVerified, true);
  assert.equal(result.identityBound, true);
  assert.equal(result.extensionId, fixture.id);
  assert.ok(result.archiveOffset > 16);
});

test("tampered and unsupported CRX inputs never claim verification", () => {
  assert.equal(verifyCrxBuffer(crx2(Buffer.from("PK fixture"), true).bytes).status, "invalid");
  const unsupported = Buffer.alloc(8); unsupported.write("Cr24"); unsupported.writeUInt32LE(9, 4);
  assert.equal(verifyCrxBuffer(unsupported).status, "unsupported");
  assert.equal(verifyCrxBuffer(Buffer.from("ordinary zip")).status, "not-applicable");
});

test("CRX3 proofs bind the signed header identity and embedded archive", () => {
  const fixture = crx3(Buffer.from("PK\x03\x04crx3 fixture"));
  const result = verifyCrxBuffer(fixture.bytes);
  assert.equal(result.status, "verified");
  assert.equal(result.extensionId, fixture.id);
  assert.equal(result.algorithm, "RSA-SHA256");
  const tampered = Buffer.from(fixture.bytes); tampered[tampered.length - 1] ^= 1;
  assert.equal(verifyCrxBuffer(tampered).status, "invalid");
});

test("distribution Sigstore policy binds exact bytes, subject, identity and issuer", async t => {
  const bytes = Buffer.from("exact distribution bytes");
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const bundle = sigstoreBundle(digest);
  const calls = [];
  const result = await verifyDistributionProvenanceBundle(bundle, {
    artifactSha256: digest,
    subjectName: "artifact.zip",
    certificateIdentity: "https://github.com/example/project/.github/workflows/release.yml@refs/tags/v1",
    certificateIssuer: "https://token.actions.githubusercontent.com",
    modulePath: fakeVerifier(t),
    backendRunner: async (...args) => {
      calls.push(args);
      return { status: "verified" };
    }
  });
  assert.equal(result.status, "verified");
  assert.equal(result.cryptographicallyVerified, true);
  assert.equal(result.artifactBound, true);
  assert.equal(result.subjectName, "artifact.zip");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], result.certificateIdentity);
  assert.equal(calls[0][6], result.certificateIssuer);

  let invoked = false;
  const mismatch = await verifyDistributionProvenanceBundle(bundle, {
    artifactSha256: "0".repeat(64),
    subjectName: "artifact.zip",
    certificateIdentity: result.certificateIdentity,
    certificateIssuer: result.certificateIssuer,
    modulePath: fakeVerifier(t),
    backendRunner: async () => { invoked = true; return { status: "verified" }; }
  });
  assert.equal(mismatch.status, "invalid");
  assert.equal(mismatch.reason, "artifact-subject-mismatch");
  assert.equal(invoked, false);

  const wrongPredicate = structuredClone(bundle);
  const statement = JSON.parse(Buffer.from(wrongPredicate.dsseEnvelope.payload, "base64"));
  statement.predicateType = "https://cyclonedx.org/bom";
  wrongPredicate.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
  const notProvenance = await verifyDistributionProvenanceBundle(wrongPredicate, {
    artifactSha256: digest,
    subjectName: "artifact.zip",
    certificateIdentity: result.certificateIdentity,
    certificateIssuer: result.certificateIssuer,
    modulePath: fakeVerifier(t),
    backendRunner: async () => { invoked = true; return { status: "verified" }; }
  });
  assert.equal(notProvenance.status, "invalid");
  assert.equal(notProvenance.reason, "invalid-statement-type");
});

test("artifact provenance reads a bounded regular bundle and never trusts policy from it", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkgxray-provenance-artifact-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifact = path.join(root, "artifact.zip");
  const bytes = Buffer.from("artifact bytes");
  fs.writeFileSync(artifact, bytes);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const bundle = path.join(root, "bundle.json");
  fs.writeFileSync(bundle, JSON.stringify(sigstoreBundle(sha256)));
  const verified = await verifyArtifactProvenance(artifact, { sha256, size: bytes.length }, {
    sigstoreBundle: bundle,
    sigstoreSubject: "artifact.zip",
    certificateIdentity: "https://github.com/example/project/.github/workflows/release.yml@refs/tags/v1",
    certificateIssuer: "https://token.actions.githubusercontent.com",
    sigstoreModulePath: fakeVerifier(t),
    backendRunner: async () => ({ status: "verified" })
  });
  assert.equal(verified.status, "verified");
  assert.equal(verified.archive.status, "absent");

  const link = path.join(root, "bundle-link.json");
  fs.symlinkSync(bundle, link);
  const rejected = await verifyArtifactProvenance(artifact, { sha256, size: bytes.length }, {
    sigstoreBundle: link,
    certificateIdentity: verified.certificateIdentity,
    certificateIssuer: verified.certificateIssuer
  });
  assert.equal(rejected.status, "invalid");
  assert.match(rejected.reason, /regular file/);
});

test("external provenance cannot override a failed embedded CRX signature", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkgxray-crx-provenance-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifact = path.join(root, "extension.crx");
  const bytes = crx2(Buffer.from("PK\x03\x04tampered"), true).bytes;
  fs.writeFileSync(artifact, bytes);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const bundle = path.join(root, "bundle.json");
  fs.writeFileSync(bundle, JSON.stringify(sigstoreBundle(sha256, "extension.crx")));
  const result = await verifyArtifactProvenance(artifact, { sha256, size: bytes.length }, {
    sigstoreBundle: bundle,
    sigstoreSubject: "extension.crx",
    certificateIdentity: "https://github.com/example/project/.github/workflows/release.yml@refs/tags/v1",
    certificateIssuer: "https://token.actions.githubusercontent.com",
    sigstoreModulePath: fakeVerifier(t),
    backendRunner: async () => ({ status: "verified" })
  });
  assert.equal(result.status, "invalid");
  assert.equal(result.sigstore.status, "verified");
  assert.match(result.reason, /cannot be overridden/);
});
