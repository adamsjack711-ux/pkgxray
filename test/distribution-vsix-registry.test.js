"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const zlib = require("node:zlib");

const { crc32 } = require("../src/distribution/archive");
const { scanDistributionTarget } = require("../src/distribution/pipeline");
const {
  acquireVsixRegistry,
  parseVsixRegistryReference,
  registryDownload,
  registryHostAllowed
} = require("../src/distribution/vsix-registry");

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

function fakeTransport(routes) {
  return {
    get(url, options, receive) {
      const request = new EventEmitter();
      request.destroy = () => {};
      queueMicrotask(() => {
        const route = routes[new URL(url).href];
        if (!route) return request.emit("error", new Error(`unexpected URL: ${url}`));
        const response = new PassThrough();
        response.statusCode = route.statusCode || 200;
        response.headers = route.headers || {};
        receive(response);
        response.end(route.body || Buffer.alloc(0));
      });
      void options;
      return request;
    }
  };
}

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pkgxray-vsix-registry-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

test("VSIX registry references require exact bounded coordinates and build fixed official URLs", () => {
  assert.deepEqual(parseVsixRegistryReference("openvsx:redhat.java@1.30.0"), {
    registry: "openvsx", publisher: "redhat", name: "java", version: "1.30.0"
  });
  assert.throws(() => parseVsixRegistryReference("openvsx:redhat.java@latest"), /exact version/);
  assert.throws(() => parseVsixRegistryReference("vscode:redhat.java"), /must be/);
  assert.equal(registryDownload("openvsx:redhat.java@1.30.0", "universal").url,
    "https://open-vsx.org/api/redhat/java/universal/1.30.0/file/download");
  assert.equal(registryDownload("vscode:esbenp.prettier-vscode@10.2.0", "linux-x64").url,
    "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/esbenp/vsextensions/prettier-vscode/10.2.0/vspackage?targetPlatform=linux-x64");
  assert.throws(() => registryDownload("vscode:esbenp.prettier-vscode@10.2.0", "unknown"), /Unsupported/);
  assert.equal(registryHostAllowed("vscode", "esbenp.gallery.vsassets.io"), true);
  assert.equal(registryHostAllowed("openvsx", "openvsx.eclipsecontent.org"), true);
  assert.equal(registryHostAllowed("openvsx", "evil.example"), false);
});

test("registry acquisition is bounded, temporary and honest about transport-only integrity", async t => {
  const root = await fixture(t);
  const bytes = storedZip({ "extension/package.json": JSON.stringify({ publisher: "redhat", name: "java", version: "1.30.0" }) });
  const url = "https://open-vsx.org/api/redhat/java/1.30.0/file/download";
  const acquired = await acquireVsixRegistry("openvsx:redhat.java@1.30.0", {
    tempRoot: root,
    transport: fakeTransport({ [url]: { body: bytes } })
  });
  assert.equal(acquired.integrityVerified, false);
  assert.equal(acquired.verification.status, "transport-only");
  assert.equal(acquired.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.equal(path.extname(acquired.archivePath), ".vsix");
  await acquired.cleanup();
  await assert.rejects(() => fsp.stat(acquired.workspace), { code: "ENOENT" });
});

test("registry acquisition enforces optional digest and redirect host policy", async t => {
  const root = await fixture(t);
  const url = "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/example/vsextensions/fixture/1.2.3/vspackage";
  const bytes = Buffer.from("not the expected artifact");
  await assert.rejects(() => acquireVsixRegistry("vscode:example.fixture@1.2.3", {
    expectedSha256: "0".repeat(64), tempRoot: root, transport: fakeTransport({ [url]: { body: bytes } })
  }), /SHA-256 mismatch/);
  await assert.rejects(() => acquireVsixRegistry("vscode:example.fixture@1.2.3", {
    tempRoot: root,
    transport: fakeTransport({ [url]: { statusCode: 302, headers: { location: "https://evil.example/fixture.vsix" } } })
  }), /redirect host is not allowed/);
  assert.deepEqual(await fsp.readdir(root), []);
});

test("Marketplace HTTP gzip is decoded within the artifact bound before hashing", async t => {
  const root = await fixture(t);
  const url = "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/example/vsextensions/fixture/1.2.3/vspackage?targetPlatform=linux-x64";
  const bytes = storedZip({ "extension/package.json": JSON.stringify({ publisher: "example", name: "fixture", version: "1.2.3" }) });
  const encoded = zlib.gzipSync(bytes);
  const acquired = await acquireVsixRegistry("vscode:example.fixture@1.2.3", {
    targetPlatform: "linux-x64",
    expectedSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    tempRoot: root,
    transport: fakeTransport({ [url]: { body: encoded, headers: { "content-encoding": "gzip" } } })
  });
  assert.equal((await fsp.readFile(acquired.archivePath)).equals(bytes), true);
  assert.deepEqual(acquired.transfer, { bytes: encoded.length, contentEncoding: "gzip", decoded: true });
  assert.equal(acquired.integrityVerified, true);
  await acquired.cleanup();
});

test("registry pipeline verifies requested coordinates and records partial acquisition without a pinned digest", async t => {
  const root = await fixture(t);
  const reference = "openvsx:example.fixture@1.2.3";
  const url = "https://open-vsx.org/api/example/fixture/1.2.3/file/download";
  const bytes = storedZip({
    "extension/package.json": JSON.stringify({ publisher: "example", name: "fixture", version: "1.2.3", engines: { vscode: "*" }, main: "main.js" }),
    "extension/main.js": "module.exports = {};"
  });
  const result = await scanDistributionTarget(reference, {
    sourceAudit: false, tempRoot: root, transport: fakeTransport({ [url]: { body: bytes } })
  });
  assert.equal(result.acquisition.registry, "openvsx");
  assert.equal(result.acquisition.manifestIdentityVerified, true);
  assert.equal(result.acquisition.integrityVerified, false);
  assert.equal(result.receipt.checks.acquisition, "partial");
  assert.equal(result.verdict, "review");
});

test("registry pipeline blocks a package whose manifest does not match requested coordinates", async t => {
  const root = await fixture(t);
  const reference = "vscode:example.fixture@1.2.3";
  const url = "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/example/vsextensions/fixture/1.2.3/vspackage";
  const bytes = storedZip({
    "extension/package.json": JSON.stringify({ publisher: "attacker", name: "other", version: "9.9.9", engines: { vscode: "*" } })
  });
  const result = await scanDistributionTarget(reference, {
    sourceAudit: false, tempRoot: root, transport: fakeTransport({ [url]: { body: bytes } })
  });
  assert.equal(result.verdict, "block");
  assert.equal(result.acquisition.manifestIdentityVerified, false);
  assert.ok(result.findings.some(item => item.category === "vsix-registry-coordinate-mismatch" && item.blocking));
  assert.equal(result.coverage.complete, false);
});
