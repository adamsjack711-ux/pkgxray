"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const zlib = require("node:zlib");

const {
  acquireArchive,
  crc32,
  extractArchive,
  parseZip,
  unwrapArchive
} = require("../src/distribution/archive");
const { parseTar } = require("../src/distribution/tar");

function makeZip(specs, options = {}) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const spec of specs) {
    const name = Buffer.from(spec.name, "utf8");
    const content = Buffer.from(spec.content || "");
    const method = spec.method ?? (spec.directory ? 0 : 8);
    const compressed = method === 8 ? zlib.deflateRawSync(content) : content;
    const checksum = spec.crc32 ?? crc32(content);
    const flags = (spec.flags ?? 0x0800) | (spec.descriptor ? 0x0008 : 0);
    const extra = spec.extra || Buffer.alloc(0);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(spec.descriptor ? 0 : checksum, 14);
    header.writeUInt32LE(spec.descriptor ? 0 : compressed.length, 18);
    header.writeUInt32LE(spec.descriptor ? 0 : content.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(extra.length, 28);
    const descriptor = spec.descriptor ? Buffer.alloc(spec.descriptorSignature === false ? 12 : 16) : Buffer.alloc(0);
    if (spec.descriptor) {
      const start = spec.descriptorSignature === false ? 0 : 4;
      if (start) descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(checksum, start);
      descriptor.writeUInt32LE(compressed.length, start + 4);
      descriptor.writeUInt32LE(content.length, start + 8);
    }
    local.push(header, name, extra, compressed, descriptor);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE((3 << 8) | 20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(content.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(extra.length, 30);
    const attributes = spec.externalAttributes ??
      (((spec.directory ? 0o040700 : 0o100600) << 16) | (spec.directory ? 0x10 : 0));
    record.writeUInt32LE(attributes >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name, extra);
    offset += header.length + name.length + extra.length + compressed.length + descriptor.length;
  }
  const centralBytes = Buffer.concat(central);
  const localBytes = Buffer.concat(local);
  const comment = Buffer.from(options.comment || "");
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(specs.length, 8);
  eocd.writeUInt16LE(specs.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localBytes.length, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([localBytes, centralBytes, eocd, comment]);
}

function tarOctal(header, offset, length, value) {
  header.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length, "ascii");
}

function makeTar(specs) {
  const chunks = [];
  for (const spec of specs) {
    const content = Buffer.from(spec.content || "");
    const header = Buffer.alloc(512);
    header.write(spec.name, 0, 100, "utf8");
    tarOctal(header, 100, 8, spec.directory ? 0o755 : 0o600);
    tarOctal(header, 108, 8, 0); tarOctal(header, 116, 8, 0);
    tarOctal(header, 124, 12, content.length); tarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = (spec.type || (spec.directory ? "5" : "0")).charCodeAt(0);
    header.write("ustar\0", 257, 6, "ascii"); header.write("00", 263, 2, "ascii");
    let checksum = 0; for (const byte of header) checksum += byte;
    header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
    header[154] = 0; header[155] = 0x20;
    chunks.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function paxRecord(key, value) {
  const body = `${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 3;
  while (true) {
    const next = Buffer.byteLength(body) + String(length).length + 1;
    if (next === length) return `${length} ${body}`;
    length = next;
  }
}

function crx(zip, version) {
  if (version === 2) {
    const key = Buffer.from("public-key");
    const signature = Buffer.from("signature");
    const header = Buffer.alloc(16);
    header.write("Cr24", 0, "ascii");
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(key.length, 8);
    header.writeUInt32LE(signature.length, 12);
    return Buffer.concat([header, key, signature, zip]);
  }
  const signedHeader = Buffer.from("crx3-protobuf-placeholder");
  const header = Buffer.alloc(12);
  header.write("Cr24", 0, "ascii");
  header.writeUInt32LE(3, 4);
  header.writeUInt32LE(signedHeader.length, 8);
  return Buffer.concat([header, signedHeader, zip]);
}

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pkgxray-zip-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

test("extracts stored, deflated and data-descriptor entries transactionally", async t => {
  const root = await fixture(t);
  const archive = path.join(root, "fixture.vsix");
  const destination = path.join(root, "out");
  await fsp.writeFile(archive, makeZip([
    { name: "extension/", directory: true, method: 0 },
    { name: "extension/package.json", content: "{\"name\":\"fixture\"}", method: 0 },
    { name: "extension/main.js", content: "module.exports = 1;", descriptor: true },
    { name: "extension/readme.md", content: "read me", descriptor: true, descriptorSignature: false }
  ], { comment: "valid comment" }));
  const result = await extractArchive(archive, destination);
  assert.equal(result.entries, 4);
  assert.equal(result.container.type, "zip");
  assert.match(result.artifactSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.artifactSha256, result.zipSha256);
  assert.equal(await fsp.readFile(path.join(destination, "extension/main.js"), "utf8"), "module.exports = 1;");
  assert.equal((await fsp.stat(path.join(destination, "extension/main.js"))).mode & 0o777, 0o600);
});

test("recognizes CRX2 and CRX3 containers without claiming signature verification", async t => {
  const root = await fixture(t);
  const zip = makeZip([{ name: "manifest.json", content: "{}", method: 0 }]);
  for (const version of [2, 3]) {
    const wrapped = crx(zip, version);
    const unwrapped = unwrapArchive(wrapped);
    assert.equal(unwrapped.container.version, version);
    assert.equal(unwrapped.container.signaturePresent, true);
    assert.equal(unwrapped.container.signatureVerified, false);
    const archive = path.join(root, `fixture-${version}.crx`);
    const destination = path.join(root, `out-${version}`);
    await fsp.writeFile(archive, wrapped);
    const result = await extractArchive(archive, destination);
    assert.equal(result.container.version, version);
    assert.notEqual(result.artifactSha256, result.zipSha256);
    assert.equal(await fsp.readFile(path.join(destination, "manifest.json"), "utf8"), "{}");
  }
});

test("extracts bounded raw and gzip TAR archives without invoking system tar", async t => {
  const root = await fixture(t);
  const tar = makeTar([
    { name: "chart/", directory: true },
    { name: "chart/Chart.yaml", content: "apiVersion: v2\nname: fixture\n" },
    { name: "chart/templates/deployment.yaml", content: "image: registry.example/app@sha256:" + "a".repeat(64) }
  ]);
  for (const [name, bytes, type] of [["chart.tar", tar, "tar"], ["chart.tgz", zlib.gzipSync(tar), "tar+gzip"]]) {
    const archive = path.join(root, name);
    const destination = path.join(root, `${name}-out`);
    await fsp.writeFile(archive, bytes);
    const result = await extractArchive(archive, destination);
    assert.equal(result.container.type, type);
    assert.equal(result.entries, 3);
    assert.match(result.payloadSha256, /^[a-f0-9]{64}$/);
    assert.equal(await fsp.readFile(path.join(destination, "chart/Chart.yaml"), "utf8"), "apiVersion: v2\nname: fixture\n");
  }
});

test("TAR extraction rejects traversal, links, collisions and expansion limits transactionally", async t => {
  assert.throws(() => parseTar(makeTar([{ name: "../escape", content: "x" }])), /Unsafe TAR/);
  assert.throws(() => parseTar(makeTar([{ name: "link", type: "2", content: "target" }])), /links, devices/);
  assert.throws(() => parseTar(makeTar([{ name: "Foo/one", content: "1" }, { name: "foo/two", content: "2" }])), /case collision/);
  const root = await fixture(t);
  const archive = path.join(root, "large.tgz");
  const destination = path.join(root, "out");
  await fsp.writeFile(archive, zlib.gzipSync(makeTar([{ name: "large", content: "a".repeat(4096) }])));
  await assert.rejects(() => extractArchive(archive, destination, { maxEntryBytes: 100 }), /entry exceeds/);
  await assert.rejects(() => fsp.stat(destination), { code: "ENOENT" });
});

test("PAX and GNU long paths are applied exactly once and remain path-safe", async t => {
  const paxPath = `${"long/".repeat(22)}chart/Chart.yaml`;
  const pax = makeTar([
    { name: "PaxHeaders/Chart.yaml", type: "x", content: paxRecord("path", paxPath) },
    { name: "Chart.yaml", content: "apiVersion: v2\nname: pax\n" }
  ]);
  assert.equal(parseTar(pax)[0].path, paxPath);

  const gnuPath = `${"nested/".repeat(18)}manifest.json`;
  const gnu = makeTar([
    { name: "././@LongLink", type: "L", content: Buffer.concat([Buffer.from(gnuPath), Buffer.from([0])]) },
    { name: "manifest", content: "{}" }
  ]);
  assert.equal(parseTar(gnu)[0].path, gnuPath);

  const root = await fixture(t);
  const archive = path.join(root, "pax.tar");
  const destination = path.join(root, "out");
  await fsp.writeFile(archive, pax);
  await extractArchive(archive, destination);
  assert.equal(await fsp.readFile(path.join(destination, ...paxPath.split("/")), "utf8"), "apiVersion: v2\nname: pax\n");
});

test("PAX and GNU extensions reject traversal, links, sparse fields and ambiguity", () => {
  const traversal = makeTar([
    { name: "PaxHeaders/file", type: "x", content: paxRecord("path", "../escape") },
    { name: "file", content: "bad" }
  ]);
  assert.throws(() => parseTar(traversal), /Unsafe TAR entry path/);
  assert.throws(() => parseTar(makeTar([
    { name: "PaxHeaders/file", type: "x", content: paxRecord("linkpath", "target") },
    { name: "file", content: "bad" }
  ])), /security-sensitive PAX field/);
  assert.throws(() => parseTar(makeTar([
    { name: "PaxHeaders/file", type: "x", content: paxRecord("GNU.sparse.map", "0,1") },
    { name: "file", content: "bad" }
  ])), /security-sensitive PAX field/);
  assert.throws(() => parseTar(makeTar([
    { name: "PaxHeaders/file", type: "x", content: paxRecord("path", "one") },
    { name: "././@LongLink", type: "L", content: Buffer.from("two\0") },
    { name: "file", content: "bad" }
  ])), /Conflicting PAX and GNU/);
  assert.throws(() => parseTar(makeTar([{ name: "././@LongLink", type: "K", content: Buffer.from("target\0") }])), /long links/);
  assert.throws(() => parseTar(makeTar([
    { name: "PaxHeaders/file", type: "x", content: paxRecord("path", "long/file") },
    { name: "file", content: "bad" }
  ]), { maxExtendedBytes: 8 }), /extended header exceeds/);
  assert.throws(() => parseTar(makeTar([{ name: `${"a".repeat(99)}/file`, content: "bad" }]), { maxPathBytes: 32 }), /path-byte limit/);
});

test("rejects traversal, absolute, drive, backslash, control and non-normalized paths", () => {
  for (const name of ["../escape", "/absolute", "C:/drive", "dir\\file", "a\u0000b", "e\u0301.txt"]) {
    assert.throws(() => parseZip(makeZip([{ name, content: "x", method: 0 }])), /ZIP entry path|NFC-normalized/);
  }
});

test("rejects duplicate, case-colliding, file-parent and special entries", () => {
  assert.throws(() => parseZip(makeZip([
    { name: "a.txt", content: "1" }, { name: "A.txt", content: "2" }
  ])), /Duplicate or case-colliding/);
  assert.throws(() => parseZip(makeZip([
    { name: "parent", content: "file" }, { name: "parent/child", content: "child" }
  ])), /file as its parent/);
  assert.throws(() => parseZip(makeZip([
    { name: "link", content: "target", externalAttributes: (0o120777 << 16) >>> 0 }
  ])), /links and special/);
  // An explicit directory after an implicit parent is valid, but a second
  // explicit copy is still a duplicate.
  assert.doesNotThrow(() => parseZip(makeZip([
    { name: "dir/file", content: "x" }, { name: "dir/", directory: true, method: 0 }
  ])));
  assert.throws(() => parseZip(makeZip([
    { name: "dir/", directory: true, method: 0 }, { name: "dir/", directory: true, method: 0 }
  ])), /Duplicate or case-colliding/);
});

test("rejects encryption, unsupported methods, corrupt descriptors and ambiguous central bounds", () => {
  assert.throws(() => parseZip(makeZip([{ name: "encrypted", content: "x", flags: 0x0801 }])), /Encrypted/);
  assert.throws(() => parseZip(makeZip([{ name: "method", content: "x", method: 99 }])), /compression method/);
  const descriptor = makeZip([{ name: "descriptor", content: "x", descriptor: true }]);
  const dataDescriptor = descriptor.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]));
  descriptor.writeUInt32LE(7, dataDescriptor + 8);
  assert.throws(() => parseZip(descriptor), /data descriptor disagrees/);
  const bounds = makeZip([{ name: "file", content: "x" }]);
  const eocd = bounds.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  bounds.writeUInt32LE(bounds.readUInt32LE(eocd + 12) + 1, eocd + 12);
  assert.throws(() => parseZip(bounds), /central-directory bounds/);
});

test("enforces entry, total, count and compression-ratio limits", () => {
  const archive = makeZip([{ name: "large", content: "a".repeat(4096) }]);
  assert.throws(() => parseZip(archive, { maxEntryBytes: 100 }), /entry exceeds/);
  assert.throws(() => parseZip(archive, { maxUncompressedBytes: 100 }), /expands beyond/);
  assert.throws(() => parseZip(archive, { maxCompressionRatio: 2 }), /compression-ratio/);
  assert.throws(() => parseZip(makeZip([{ name: "a", content: "a" }, { name: "b", content: "b" }]), { maxEntries: 1 }), /exceeds 1 entries/);
});

test("CRC or decompression failure leaves no destination tree", async t => {
  const root = await fixture(t);
  const archive = makeZip([{ name: "payload.js", content: "safe", method: 0 }]);
  const data = 30 + Buffer.byteLength("payload.js");
  archive[data] ^= 0xff;
  const file = path.join(root, "bad.zip");
  const destination = path.join(root, "out");
  await fsp.writeFile(file, archive);
  await assert.rejects(() => extractArchive(file, destination), /CRC32 mismatch/);
  await assert.rejects(() => fsp.stat(destination), { code: "ENOENT" });
  assert.deepEqual((await fsp.readdir(root)).sort(), ["bad.zip"]);
});

test("existing destinations and symlink archive inputs are never overwritten or followed", async t => {
  const root = await fixture(t);
  const archive = path.join(root, "fixture.zip");
  const linked = path.join(root, "linked.zip");
  const destination = path.join(root, "out");
  await fsp.writeFile(archive, makeZip([{ name: "payload", content: "new" }]));
  await fsp.symlink(archive, linked);
  await fsp.mkdir(destination);
  await fsp.writeFile(path.join(destination, "keep"), "old");
  await assert.rejects(() => extractArchive(archive, destination), /already exists/);
  await assert.rejects(() => extractArchive(linked, path.join(root, "linked-out")));
  assert.equal(await fsp.readFile(path.join(destination, "keep"), "utf8"), "old");
});

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

test("acquisition is host-allowlisted, redirect-bounded, digest-bound and temporary", async t => {
  const root = await fixture(t);
  const bytes = makeZip([{ name: "manifest.json", content: "{}" }]);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const transport = fakeTransport({
    "https://store.example/start": { statusCode: 302, headers: { location: "https://cdn.example/item.zip" } },
    "https://cdn.example/item.zip": { body: bytes }
  });
  const acquired = await acquireArchive("https://store.example/start", {
    allowedHosts: ["store.example", "cdn.example"],
    expectedSha256: digest,
    tempRoot: root,
    transport,
    lookup(host, options, callback) { callback(null, [{ address: "93.184.216.34", family: 4 }]); }
  });
  t.after(acquired.cleanup);
  assert.equal(acquired.sha256, digest);
  assert.equal(acquired.resolvedUrl, "https://cdn.example/item.zip");
  assert.equal(acquired.integrityVerified, true);
  assert.equal(acquired.verification.status, "verified");
  assert.equal(await fsp.readFile(acquired.archivePath).then(value => value.equals(bytes)), true);
  await acquired.cleanup();
  await assert.rejects(() => fsp.stat(acquired.workspace), { code: "ENOENT" });
});

test("acquisition accepts SRI and validates requirements before opening a socket", async t => {
  const root = await fixture(t);
  const bytes = Buffer.from("archive");
  const integrity = `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
  let requests = 0;
  const transport = fakeTransport({ "https://allowed.example/item": { body: bytes } });
  const counted = { get(...args) { requests += 1; return transport.get(...args); } };
  const lookup = (host, options, callback) => callback(null, [{ address: "93.184.216.34", family: 4 }]);
  await assert.rejects(() => acquireArchive("https://allowed.example/item", {
    allowedHosts: ["allowed.example"], tempRoot: root, transport: counted, lookup
  }), /requires integrity/);
  assert.equal(requests, 0);
  const acquired = await acquireArchive("https://allowed.example/item", {
    allowedHosts: new Set(["allowed.example"]), integrity, tempRoot: root, transport: counted, lookup
  });
  assert.equal(acquired.integrityVerified, true);
  assert.equal(acquired.verification.integrity, integrity);
  await acquired.cleanup();
});

test("acquisition rejects private hosts, off-list redirects and integrity mismatches without residue", async t => {
  const root = await fixture(t);
  const bytes = Buffer.from("archive");
  const transport = fakeTransport({
    "https://allowed.example/start": { statusCode: 302, headers: { location: "https://evil.example/item" } },
    "https://allowed.example/item": { body: bytes }
  });
  const lookup = (host, options, callback) => callback(null, [{ address: "93.184.216.34", family: 4 }]);
  await assert.rejects(() => acquireArchive("https://127.0.0.1/item", {
    allowedHosts: ["127.0.0.1"], expectedSha256: "0".repeat(64), tempRoot: root, transport, lookup
  }), /private or local/);
  await assert.rejects(() => acquireArchive("https://allowed.example/start", {
    allowedHosts: ["allowed.example"], expectedSha256: "0".repeat(64), tempRoot: root, transport, lookup
  }), /not allowed/);
  await assert.rejects(() => acquireArchive("https://allowed.example/item", {
    allowedHosts: ["allowed.example"], expectedSha256: "0".repeat(64), tempRoot: root, transport, lookup
  }), /SHA-256 mismatch/);
  assert.deepEqual(await fsp.readdir(root), []);
});
