"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { acquireArchive } = require("./archive");
const { scanInfrastructureArtifacts } = require("./artifacts");
const { parseTar } = require("./tar");

const DIGEST = /^sha256:([a-f0-9]{64})$/i;
const MANIFEST_TYPES = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json"
]);
const CONFIG_TYPES = new Set([
  "application/vnd.oci.image.config.v1+json",
  "application/vnd.docker.container.image.v1+json"
]);
const LAYER_TYPES = new Map([
  ["application/vnd.oci.image.layer.v1.tar", "tar"],
  ["application/vnd.oci.image.layer.v1.tar+gzip", "gzip"],
  ["application/vnd.docker.image.rootfs.diff.tar", "tar"],
  ["application/vnd.docker.image.rootfs.diff.tar.gzip", "gzip"]
]);

const DEFAULTS = Object.freeze({
  maxManifestBytes: 4 * 1024 * 1024,
  maxConfigBytes: 4 * 1024 * 1024,
  maxLayerBytes: 128 * 1024 * 1024,
  maxLayerUncompressedBytes: 256 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxTotalUncompressedBytes: 512 * 1024 * 1024,
  maxLayers: 128,
  maxEntries: 100_000,
  timeoutMs: 60_000,
  maxRedirects: 5
});

function limits(options = {}) {
  const result = {};
  for (const [name, fallback] of Object.entries(DEFAULTS)) {
    const value = options[name] ?? fallback;
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    result[name] = value;
  }
  return result;
}

function exactDigest(value, label = "OCI digest") {
  const match = DIGEST.exec(String(value || ""));
  if (!match) throw new Error(`${label} must be an exact sha256 digest`);
  return `sha256:${match[1].toLowerCase()}`;
}

function parseOciReference(component) {
  const reference = String(component && component.reference || "");
  let digest = component && component.digest || null;
  let referenceDigest = null;
  let name = reference;
  if (name.startsWith("docker://")) name = name.slice(9);
  else if (name.startsWith("oci://")) name = name.slice(6);
  else if (name.startsWith("oci:")) name = name.slice(4);
  const at = name.lastIndexOf("@");
  if (at >= 0) {
    referenceDigest = name.slice(at + 1);
    name = name.slice(0, at);
  } else if (DIGEST.test(name)) {
    referenceDigest = name;
    name = "";
  }
  if (digest && referenceDigest && exactDigest(digest) !== exactDigest(referenceDigest)) {
    throw new Error("OCI component digest disagrees with its reference digest");
  }
  digest = digest || referenceDigest;
  digest = exactDigest(digest, "OCI reference");
  if (!name) return { digest, registry: null, repository: null };
  if (name.includes(":")) {
    const lastSlash = name.lastIndexOf("/");
    const lastColon = name.lastIndexOf(":");
    if (lastColon > lastSlash) throw new Error("OCI references must use @sha256, not a mutable tag");
  }
  const slash = name.indexOf("/");
  if (slash <= 0) throw new Error("OCI registry references must include an explicit registry host and repository");
  const registry = name.slice(0, slash).toLowerCase();
  const repository = name.slice(slash + 1);
  if (!/^[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(registry) ||
      !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(repository)) {
    throw new Error("OCI registry host or repository is malformed");
  }
  return { digest, registry, repository };
}

function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }

function verifyBytes(bytes, digest, expectedSize, label) {
  const expected = exactDigest(digest, `${label} digest`).slice(7);
  if (expectedSize !== undefined && expectedSize !== null &&
      (!Number.isSafeInteger(expectedSize) || expectedSize < 0)) {
    throw new Error(`${label} descriptor size must be a non-negative integer`);
  }
  if (expectedSize !== undefined && expectedSize !== null && bytes.length !== expectedSize) {
    throw new Error(`${label} size mismatch: expected ${expectedSize}, received ${bytes.length}`);
  }
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error(`${label} digest mismatch`);
}

async function readLocalBlob(root, digest, maxBytes, expectedSize, label) {
  const hex = exactDigest(digest, `${label} digest`).slice(7);
  const file = path.join(root, "blobs", "sha256", hex);
  let listed;
  try { listed = await fsp.lstat(file); }
  catch { throw new Error(`${label} blob is missing from the OCI layout: ${digest}`); }
  if (!listed.isFile() || listed.isSymbolicLink()) throw new Error(`${label} blob is not a regular file`);
  if (listed.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (stat.dev !== listed.dev || stat.ino !== listed.ino || stat.size !== listed.size) throw new Error(`${label} blob changed while opening`);
    const bytes = await handle.readFile();
    verifyBytes(bytes, digest, expectedSize, label);
    return bytes;
  } finally { await handle.close(); }
}

function registryUrl(reference, kind, digest) {
  const repository = reference.repository.split("/").map(encodeURIComponent).join("/");
  return `https://${reference.registry}/v2/${repository}/${kind}/${exactDigest(digest)}`;
}

async function readRemoteBlob(reference, kind, digest, maxBytes, expectedSize, label, options) {
  const allowedHosts = options.allowedHosts || options.ociAllowedHosts;
  if (!allowedHosts || !Array.from(allowedHosts).length) throw new Error("OCI registry acquisition requires an explicit allowedHosts list");
  let acquired;
  try {
    acquired = await acquireArchive(registryUrl(reference, kind, digest), {
      allowedHosts,
      expectedSha256: exactDigest(digest).slice(7),
      maxBytes,
      timeoutMs: options.timeoutMs,
      maxRedirects: options.maxRedirects,
      transport: options.transport,
      lookup: options.lookup,
      tempRoot: options.tempRoot
    });
    const bytes = await fsp.readFile(acquired.archivePath);
    verifyBytes(bytes, digest, expectedSize, label);
    return bytes;
  } catch (error) {
    if (error && error.statusCode === 401) throw new Error("OCI registry authentication is not supported by the built-in resolver");
    throw error;
  } finally {
    if (acquired) await acquired.cleanup();
  }
}

async function makeReader(reference, root, options, state) {
  return async (kind, digest, maxBytes, expectedSize, label) => {
    let bytes;
    if (root) bytes = await readLocalBlob(root, digest, maxBytes, expectedSize, label);
    else bytes = await readRemoteBlob(reference, kind, digest, maxBytes, expectedSize, label, options);
    state.totalBytes += bytes.length;
    if (state.totalBytes > state.limits.maxTotalBytes) throw new Error(`OCI objects exceed ${state.limits.maxTotalBytes} total bytes`);
    return bytes;
  };
}

function parseJson(bytes, label) {
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw new Error(`${label} is not valid JSON: ${error.message}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

async function applyTarLayer(bytes, root, options = {}) {
  const entries = parseTar(bytes, { ...options, rejectWhiteouts: true });
  const pathKinds = options.pathKinds || new Map();
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join("/");
      const parentKey = parent.toLocaleLowerCase("en-US");
      const existingParent = pathKinds.get(parentKey);
      if (existingParent && (existingParent.path !== parent || existingParent.kind === "file")) {
        throw new Error(`OCI layer has a cross-layer case collision or file parent: ${entry.path}`);
      }
      if (!existingParent) pathKinds.set(parentKey, { path: parent, kind: "implicit-directory" });
    }
    const collisionKey = entry.path.toLocaleLowerCase("en-US");
    const prior = pathKinds.get(collisionKey);
    if (prior && (prior.path !== entry.path ||
        (prior.kind !== entry.kind && !(prior.kind === "implicit-directory" && entry.kind === "directory")))) {
      throw new Error(`OCI layer path collision or type replacement is ambiguous: ${entry.path}`);
    }
    pathKinds.set(collisionKey, { path: entry.path, kind: entry.kind });
    const output = path.join(root, ...entry.path.split("/"));
    const relative = path.relative(root, output);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`OCI layer path escapes root: ${entry.path}`);
    let existing = null;
    try { existing = await fsp.lstat(output); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (existing && existing.isSymbolicLink()) throw new Error(`OCI layer destination became a symbolic link: ${entry.path}`);
    if (entry.kind === "directory") {
      if (existing && !existing.isDirectory()) throw new Error(`OCI layer file/directory replacement is ambiguous: ${entry.path}`);
      await fsp.mkdir(output, { recursive: true, mode: 0o700 });
    } else {
      if (existing && !existing.isFile()) throw new Error(`OCI layer file/directory replacement is ambiguous: ${entry.path}`);
      await fsp.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
      await fsp.writeFile(output, entry.content, { mode: 0o600, flag: existing ? "w" : "wx" });
    }
  }
  return entries.length;
}

function verdictForAnalysis(analysis) {
  if (analysis.coverage && analysis.coverage.complete === false) return "review";
  if ((analysis.findings || []).some(item => item.blocking === true)) return "block";
  if ((analysis.findings || []).some(item => ["medium", "high"].includes(item.severity))) return "review";
  return "safe";
}

async function resolveOciComponent(component, options = {}) {
  const kind = String(component && component.kind || "");
  if (!["oci-image", "container-image", "oci-manifest"].includes(kind)) return null;
  const reference = parseOciReference(component);
  const l = limits(options);
  let localRoot = options.root || options.ociRoot || null;
  if (localRoot) {
    localRoot = await fsp.realpath(path.resolve(localRoot));
    if (!fs.existsSync(path.join(localRoot, "oci-layout")) || !fs.existsSync(path.join(localRoot, "index.json"))) localRoot = null;
  }
  if (kind === "oci-manifest" && !localRoot) {
    throw new Error("OCI manifest components require a matching local OCI layout context");
  }
  if (!localRoot && (!reference.registry || !reference.repository)) {
    throw new Error("OCI digest has no registry repository and no matching local OCI layout");
  }
  const state = { totalBytes: 0, totalUncompressedBytes: 0, totalEntries: 0, limits: l };
  const read = await makeReader(reference, localRoot, { ...options, ...l }, state);
  const workspace = await fsp.mkdtemp(path.join(options.tempRoot || os.tmpdir(), "pkgxray-oci-"));
  const rootfs = path.join(workspace, "rootfs");
  await fsp.mkdir(rootfs, { mode: 0o700 });
  try {
    const manifestBytes = await read("manifests", reference.digest, l.maxManifestBytes, component.size, "OCI manifest");
    const manifest = parseJson(manifestBytes, "OCI manifest");
    if (manifest.schemaVersion !== 2 || !MANIFEST_TYPES.has(manifest.mediaType)) {
      throw new Error(`Unsupported OCI manifest media type: ${manifest.mediaType || "missing"}`);
    }
    if (!manifest.config || !CONFIG_TYPES.has(manifest.config.mediaType)) {
      throw new Error(`Unsupported OCI config media type: ${manifest.config && manifest.config.mediaType || "missing"}`);
    }
    if (!Array.isArray(manifest.layers)) throw new Error("OCI manifest layers must be an array");
    if (manifest.layers.length > l.maxLayers) throw new Error(`OCI manifest exceeds ${l.maxLayers} layers`);
    const configBytes = await read("blobs", manifest.config.digest, l.maxConfigBytes, manifest.config.size, "OCI config");
    const config = parseJson(configBytes, "OCI config");
    const diffIds = config.rootfs && Array.isArray(config.rootfs.diff_ids) ? config.rootfs.diff_ids : null;
    if (!diffIds || diffIds.length !== manifest.layers.length) throw new Error("OCI config diff_ids do not cover every manifest layer");
    const verifiedLayers = [];
    let extractedEntries = 0;
    const pathKinds = new Map();
    for (let index = 0; index < manifest.layers.length; index += 1) {
      const layer = manifest.layers[index];
      const compression = layer && LAYER_TYPES.get(layer.mediaType);
      if (!compression) throw new Error(`Unsupported OCI layer media type: ${layer && layer.mediaType || "missing"}`);
      const compressed = await read("blobs", layer.digest, l.maxLayerBytes, layer.size, `OCI layer ${index}`);
      let tar;
      if (compression === "tar") tar = compressed;
      else {
        try { tar = zlib.gunzipSync(compressed, { maxOutputLength: l.maxLayerUncompressedBytes + 1 }); }
        catch (error) { throw new Error(`Could not decompress OCI layer ${index}: ${error.message}`); }
      }
      if (tar.length > l.maxLayerUncompressedBytes) throw new Error(`OCI layer ${index} expands beyond ${l.maxLayerUncompressedBytes} bytes`);
      state.totalUncompressedBytes += tar.length;
      if (state.totalUncompressedBytes > l.maxTotalUncompressedBytes) {
        throw new Error(`OCI layers expand beyond ${l.maxTotalUncompressedBytes} total bytes`);
      }
      verifyBytes(tar, diffIds[index], null, `OCI layer ${index} diff-id`);
      const remainingEntries = l.maxEntries - state.totalEntries;
      if (remainingEntries < 1) throw new Error(`OCI layers exceed ${l.maxEntries} total entries`);
      const layerEntries = await applyTarLayer(tar, rootfs, { maxEntries: remainingEntries, pathKinds });
      state.totalEntries += layerEntries;
      extractedEntries += layerEntries;
      verifiedLayers.push({ digest: exactDigest(layer.digest), diffId: exactDigest(diffIds[index]), size: compressed.length, uncompressedSize: tar.length, mediaType: layer.mediaType });
    }
    const analysis = scanInfrastructureArtifacts(rootfs, options.scannerOptions || {});
    const result = {
      schemaVersion: 1,
      family: "oci-recursive",
      verdict: verdictForAnalysis(analysis),
      components: analysis.components,
      findings: analysis.findings,
      coverage: analysis.coverage,
      verification: {
        manifest: reference.digest,
        config: exactDigest(manifest.config.digest),
        layers: verifiedLayers,
        extractedEntries,
        uncompressedBytes: state.totalUncompressedBytes,
        extractedRootRetained: false,
        source: localRoot ? "local-oci-layout" : "anonymous-oci-registry"
      }
    };
    return {
      result,
      components: analysis.components,
      bytes: state.totalBytes,
      source: result.verification.source,
      cleanup: () => fsp.rm(workspace, { recursive: true, force: true })
    };
  } catch (error) {
    await fsp.rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

module.exports = {
  CONFIG_TYPES,
  DEFAULTS,
  LAYER_TYPES,
  MANIFEST_TYPES,
  applyTarLayer,
  parseOciReference,
  parseTar,
  resolveOciComponent
};
