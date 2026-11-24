"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { parseArgs } = require("../bin/audit");
const { crc32 } = require("../src/distribution/archive");

function oneFileZip(filename, value) {
  const name = Buffer.from(filename);
  const content = Buffer.from(value);
  const checksum = crc32(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE((3 << 8) | 20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE((0o100600 << 16) >>> 0, 38);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + content.length, 16);
  return Buffer.concat([local, name, content, central, name, end]);
}

test("scan-distribution arguments are explicit and bounded to known formats", () => {
  assert.deepEqual(parseArgs(["scan-distribution", "./root", "--type", "ci", "--format", "json"]), {
    command: "scanDistribution", format: "json", file: null, distributionRoot: "./root", distributionType: "ci"
  });
  assert.throws(() => parseArgs(["scan-distribution", ".", "--network"]), /Unknown scan-distribution/);
  assert.throws(() => parseArgs(["scan-distribution", ".", "--type"]), /--type requires/);
  assert.throws(() => parseArgs(["scan-distribution", ".", "--sha256", "short"]), /64 hexadecimal/);
  assert.throws(() => parseArgs(["scan-distribution", ".", "--allow-host"]), /hostname/);
  assert.throws(() => parseArgs(["scan-distribution", ".", "--acquire-packages"]), /requires --recursive/);
  assert.throws(() => parseArgs(["scan-distribution", ".", "--target-platform", "linux-x64"]), /requires an Open VSX/);
  assert.throws(() => parseArgs(["scan-distribution", "openvsx:example.fixture@1.2.3", "--allow-host", "open-vsx.org"]), /fixed built-in host policy/);
  assert.throws(() => parseArgs(["scan-distribution", "vscode:example.fixture@1.2.3", "--integrity", "sha256-AA=="]), /accept --sha256/);
  const registry = parseArgs(["scan-distribution", "openvsx:example.fixture@1.2.3", "--target-platform", "linux-x64"]);
  assert.equal(registry.targetPlatform, "linux-x64");
  assert.throws(() => parseArgs(["scan-distribution", "x.zip", "--sigstore-bundle", "bundle.json"]), /requires --sigstore-bundle.*certificate-identity.*certificate-issuer/);
  assert.throws(() => parseArgs(["scan-distribution", "x.zip", "--sigstore-bundle", "bundle.json",
    "--certificate-identity", "not-a-uri", "--certificate-issuer", "https://issuer.example"]), /exact HTTPS URI/);
  const signed = parseArgs(["scan-distribution", "x.zip", "--sigstore-bundle", "bundle.json",
    "--sigstore-subject", "artifact.zip", "--certificate-identity", "https://github.com/example/project/.github/workflows/release.yml@refs/tags/v1",
    "--certificate-issuer", "https://token.actions.githubusercontent.com"]);
  assert.equal(signed.sigstoreBundle, "bundle.json");
  assert.equal(signed.sigstoreSubject, "artifact.zip");
});

test("scan-distribution CLI emits one JSON object and review exit code", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkgxray-cli-distribution-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workflow = path.join(root, ".github/workflows/build.yml");
  fs.mkdirSync(path.dirname(workflow), { recursive: true });
  fs.writeFileSync(workflow, "steps:\n  - uses: actions/checkout@v4\n");
  const run = spawnSync(process.execPath, [path.join(__dirname, "../bin/audit.js"), "scan-distribution", root, "--format", "json"], {
    encoding: "utf8"
  });
  assert.equal(run.status, 3, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.verdict, "review");
  assert.ok(result.findings.some(item => item.category === "ci-mutable-reference"));
});

test("scan-distribution Markdown states its extraction and execution limits", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkgxray-cli-agent-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { local: { command: "node", args: ["server.js"] } } }));
  const run = spawnSync(process.execPath, [path.join(__dirname, "../bin/audit.js"), "scan-distribution", root], { encoding: "utf8" });
  assert.match(run.stdout, /never installs or executes/);
  assert.match(run.stdout, /bounded temporary directory/);
});

test("scan-distribution CLI binds and scans a local archive end to end", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkgxray-cli-archive-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, "extension.zip");
  fs.writeFileSync(archive, oneFileZip("manifest.json", JSON.stringify({
    manifest_version: 3, name: "fixture", version: "1", permissions: ["nativeMessaging"]
  })));
  const run = spawnSync(process.execPath, [path.join(__dirname, "../bin/audit.js"), "scan-distribution", archive, "--format", "json"], {
    encoding: "utf8"
  });
  assert.equal(run.status, 3, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.match(result.artifact.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.extraction.entries, 1);
  assert.equal(result.receipt.artifact.sha256, result.artifact.sha256);
  assert.equal(result.receipt.authorization.install, false);
});
