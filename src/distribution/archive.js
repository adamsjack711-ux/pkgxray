"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const { integrityEntries } = require("../artifact");
const { createUpstreamPolicy, isPrivateOrLocalHost } = require("../cache-upstream-policy");
const { downloadFile } = require("../http-client");
const { parseTar } = require("./tar");

const DEFAULT_LIMITS = Object.freeze({
  maxArchiveBytes: 64 * 1024 * 1024,
  maxCompressedBytes: 64 * 1024 * 1024,
  maxUncompressedBytes: 256 * 1024 * 1024,
  maxEntryBytes: 64 * 1024 * 1024,
  maxEntries: 20000,
  maxCompressionRatio: 200
});

const ZIP = Object.freeze({
  LOCAL: 0x04034b50,
  DESCRIPTOR: 0x08074b50,
  CENTRAL: 0x02014b50,
  EOCD: 0x06054b50
});

function limitsFrom(options = {}) {
  const limits = {};
  for (const [key, fallback] of Object.entries(DEFAULT_LIMITS)) {
    const value = options[key] ?? fallback;
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
    limits[key] = value;
  }
  return limits;
}

function checkedAdd(a, b, label) {
  const sum = a + b;
  if (!Number.isSafeInteger(sum) || sum < a) throw new Error(`ZIP ${label} overflow`);
  return sum;
}

function within(buffer, offset, length, label) {
  const end = checkedAdd(offset, length, label);
  if (offset < 0 || end > buffer.length) throw new Error(`Truncated ZIP ${label}`);
  return end;
}

function u16(buffer, offset, label) {
  within(buffer, offset, 2, label);
  return buffer.readUInt16LE(offset);
}

function u32(buffer, offset, label) {
  within(buffer, offset, 4, label);
  return buffer.readUInt32LE(offset);
}

function unwrapArchive(buffer) {
  if (buffer.length < 4 || buffer.subarray(0, 4).toString("ascii") !== "Cr24") {
    return { zip: buffer, container: { type: "zip", signatureVerified: null, headerBytes: 0 } };
  }
  if (buffer.length < 12) throw new Error("Truncated CRX header");
  const version = u32(buffer, 4, "CRX version");
  let zipOffset;
  if (version === 2) {
    if (buffer.length < 16) throw new Error("Truncated CRX2 header");
    const publicKeyBytes = u32(buffer, 8, "CRX2 public-key length");
    const signatureBytes = u32(buffer, 12, "CRX2 signature length");
    zipOffset = checkedAdd(16, checkedAdd(publicKeyBytes, signatureBytes, "CRX2 header"), "CRX2 header");
  } else if (version === 3) {
    zipOffset = checkedAdd(12, u32(buffer, 8, "CRX3 header length"), "CRX3 header");
  } else {
    throw new Error(`Unsupported CRX version: ${version}`);
  }
  if (zipOffset >= buffer.length) throw new Error(`Truncated CRX${version} payload`);
  const zip = buffer.subarray(zipOffset);
  if (zip.length < 4 || u32(zip, 0, "local header") !== ZIP.LOCAL) throw new Error(`CRX${version} payload is not a ZIP archive`);
  return {
    zip,
    container: {
      type: "crx",
      version,
      signaturePresent: true,
      signatureVerified: false,
      headerBytes: zipOffset
    }
  };
}

function findEocd(buffer) {
  const earliest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (u32(buffer, offset, "EOCD search") !== ZIP.EOCD) continue;
    const commentBytes = u16(buffer, offset + 20, "EOCD comment length");
    if (offset + 22 + commentBytes === buffer.length) return offset;
  }
  throw new Error("ZIP end-of-central-directory record not found");
}

function decodeName(bytes, utf8) {
  if (!utf8 && bytes.some(byte => byte > 0x7f)) throw new Error("ZIP filename uses an ambiguous legacy encoding");
  const name = bytes.toString("utf8");
  if (Buffer.from(name, "utf8").compare(bytes) !== 0) throw new Error("ZIP filename is not valid UTF-8");
  return name;
}

function safeEntryName(name) {
  // ZIP uses slash separators. Treating backslashes as ordinary characters is
  // unsafe on Windows, so reject them on every platform.
  if (!name || name.includes("\\")) throw new Error(`Unsafe ZIP entry path: ${JSON.stringify(name)}`);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name) || name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new Error(`Unsafe ZIP entry path: ${JSON.stringify(name)}`);
  }
  const directory = name.endsWith("/");
  const trimmed = directory ? name.slice(0, -1) : name;
  const segments = trimmed.split("/");
  if (!trimmed || segments.some(segment => !segment || segment === "." || segment === "..")) {
    throw new Error(`Unsafe ZIP entry path: ${JSON.stringify(name)}`);
  }
  const normalized = trimmed.normalize("NFC");
  if (normalized !== trimmed) throw new Error(`ZIP entry path is not NFC-normalized: ${JSON.stringify(name)}`);
  return { path: normalized, directory };
}

function entryKind(versionMadeBy, externalAttributes, directoryName) {
  const platform = versionMadeBy >>> 8;
  const mode = externalAttributes >>> 16;
  const unixType = mode & 0xf000;
  if (platform === 3 && unixType && unixType !== 0x8000 && unixType !== 0x4000) return "special";
  if (platform === 3 && unixType === 0xa000) return "special";
  const directoryAttribute = Boolean(externalAttributes & 0x10);
  if (directoryName || directoryAttribute || unixType === 0x4000) return "directory";
  return "file";
}

function descriptorLength(buffer, offset, entry) {
  if (!(entry.flags & 0x0008)) return 0;
  let cursor = offset;
  if (u32(buffer, cursor, "data descriptor") === ZIP.DESCRIPTOR) cursor += 4;
  within(buffer, cursor, 12, "data descriptor");
  const crc = u32(buffer, cursor, "data descriptor CRC");
  const compressed = u32(buffer, cursor + 4, "data descriptor compressed size");
  const uncompressed = u32(buffer, cursor + 8, "data descriptor uncompressed size");
  if (crc !== entry.crc32 || compressed !== entry.compressedSize || uncompressed !== entry.uncompressedSize) {
    throw new Error(`ZIP data descriptor disagrees with central directory for ${entry.path}`);
  }
  return cursor + 12 - offset;
}

function parseZip(buffer, options = {}) {
  const limits = limitsFrom(options);
  if (buffer.length > limits.maxArchiveBytes) throw new Error(`Archive exceeds ${limits.maxArchiveBytes} bytes`);
  const { zip, container } = unwrapArchive(buffer);
  if (zip.length > limits.maxArchiveBytes) throw new Error(`ZIP payload exceeds ${limits.maxArchiveBytes} bytes`);
  const eocd = findEocd(zip);
  const disk = u16(zip, eocd + 4, "EOCD disk");
  const centralDisk = u16(zip, eocd + 6, "EOCD central disk");
  const entriesOnDisk = u16(zip, eocd + 8, "EOCD entry count");
  const entryCount = u16(zip, eocd + 10, "EOCD total entry count");
  const centralSize = u32(zip, eocd + 12, "EOCD central size");
  const centralOffset = u32(zip, eocd + 16, "EOCD central offset");
  if (disk || centralDisk || entriesOnDisk !== entryCount) throw new Error("Multi-disk ZIP archives are not supported");
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error("ZIP64 archives are not supported");
  if (entryCount > limits.maxEntries) throw new Error(`ZIP exceeds ${limits.maxEntries} entries`);
  if (checkedAdd(centralOffset, centralSize, "central directory") !== eocd) throw new Error("ZIP central-directory bounds are ambiguous");

  const entries = [];
  const pathKinds = new Map();
  let cursor = centralOffset;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (u32(zip, cursor, "central header") !== ZIP.CENTRAL) throw new Error("Malformed ZIP central directory");
    within(zip, cursor, 46, "central header");
    const versionMadeBy = u16(zip, cursor + 4, "version made by");
    const flags = u16(zip, cursor + 8, "flags");
    const method = u16(zip, cursor + 10, "compression method");
    const crc32 = u32(zip, cursor + 16, "CRC32");
    const compressedSize = u32(zip, cursor + 20, "compressed size");
    const uncompressedSize = u32(zip, cursor + 24, "uncompressed size");
    const nameBytes = u16(zip, cursor + 28, "filename length");
    const extraBytes = u16(zip, cursor + 30, "extra length");
    const commentBytes = u16(zip, cursor + 32, "comment length");
    const startDisk = u16(zip, cursor + 34, "entry disk");
    const externalAttributes = u32(zip, cursor + 38, "external attributes");
    const localOffset = u32(zip, cursor + 42, "local offset");
    const recordEnd = within(zip, cursor, 46 + nameBytes + extraBytes + commentBytes, "central record");
    if (startDisk || localOffset === 0xffffffff || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error("ZIP64 or multi-disk entries are not supported");
    }
    if (flags & 0x0001) throw new Error("Encrypted ZIP entries are not supported");
    if (flags & ~0x080e) throw new Error(`Unsupported ZIP general-purpose flags: 0x${flags.toString(16)}`);
    if (method !== 0 && method !== 8) throw new Error(`Unsupported ZIP compression method: ${method}`);
    const rawName = zip.subarray(cursor + 46, cursor + 46 + nameBytes);
    const safe = safeEntryName(decodeName(rawName, Boolean(flags & 0x0800)));
    const kind = entryKind(versionMadeBy, externalAttributes, safe.directory);
    if (kind === "special") throw new Error(`ZIP links and special entries are not supported: ${safe.path}`);
    if ((kind === "directory") !== safe.directory) throw new Error(`ZIP directory attributes disagree with filename: ${safe.path}`);
    if (kind === "directory" && (compressedSize || uncompressedSize)) throw new Error(`ZIP directory contains data: ${safe.path}`);
    if (kind === "file" && uncompressedSize > limits.maxEntryBytes) throw new Error(`ZIP entry exceeds ${limits.maxEntryBytes} bytes: ${safe.path}`);
    if (uncompressedSize && uncompressedSize / Math.max(1, compressedSize) > limits.maxCompressionRatio) {
      throw new Error(`ZIP entry exceeds compression-ratio limit: ${safe.path}`);
    }
    totalCompressed = checkedAdd(totalCompressed, compressedSize, "compressed total");
    totalUncompressed = checkedAdd(totalUncompressed, uncompressedSize, "uncompressed total");
    if (totalCompressed > limits.maxCompressedBytes) throw new Error(`ZIP compressed data exceeds ${limits.maxCompressedBytes} bytes`);
    if (totalUncompressed > limits.maxUncompressedBytes) throw new Error(`ZIP expands beyond ${limits.maxUncompressedBytes} bytes`);

    const collisionKey = safe.path.toLocaleLowerCase("en-US");
    const existingKind = pathKinds.get(collisionKey);
    if (existingKind && !(existingKind === "implicit-directory" && kind === "directory")) {
      throw new Error(`Duplicate or case-colliding ZIP entry: ${safe.path}`);
    }
    const segments = safe.path.split("/");
    for (let part = 1; part < segments.length; part += 1) {
      const parent = segments.slice(0, part).join("/").toLocaleLowerCase("en-US");
      if (pathKinds.get(parent) === "file") throw new Error(`ZIP entry has a file as its parent: ${safe.path}`);
      if (!pathKinds.has(parent)) pathKinds.set(parent, "implicit-directory");
    }
    if (pathKinds.get(collisionKey) === "directory" && kind === "file") throw new Error(`ZIP file collides with an implicit directory: ${safe.path}`);
    pathKinds.set(collisionKey, kind);

    entries.push({
      path: safe.path,
      kind,
      flags,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      localOffset,
      rawName
    });
    cursor = recordEnd;
  }
  if (cursor !== eocd) throw new Error("ZIP central-directory entry count or size is inconsistent");

  const occupied = [];
  for (const entry of entries) {
    const local = entry.localOffset;
    if (local >= centralOffset || u32(zip, local, "local header") !== ZIP.LOCAL) throw new Error(`Missing ZIP local header for ${entry.path}`);
    within(zip, local, 30, "local header");
    const flags = u16(zip, local + 6, "local flags");
    const method = u16(zip, local + 8, "local method");
    const localCrc = u32(zip, local + 14, "local CRC");
    const localCompressed = u32(zip, local + 18, "local compressed size");
    const localUncompressed = u32(zip, local + 22, "local uncompressed size");
    const nameBytes = u16(zip, local + 26, "local filename length");
    const extraBytes = u16(zip, local + 28, "local extra length");
    const dataStart = within(zip, local, 30 + nameBytes + extraBytes, "local record");
    if (flags !== entry.flags || method !== entry.method) throw new Error(`ZIP local header disagrees with central directory for ${entry.path}`);
    if (zip.subarray(local + 30, local + 30 + nameBytes).compare(entry.rawName) !== 0) throw new Error(`ZIP local filename disagrees with central directory for ${entry.path}`);
    if (!(flags & 0x0008) && (localCrc !== entry.crc32 || localCompressed !== entry.compressedSize || localUncompressed !== entry.uncompressedSize)) {
      throw new Error(`ZIP local sizes or CRC disagree with central directory for ${entry.path}`);
    }
    if ((flags & 0x0008) && ((localCrc && localCrc !== entry.crc32) || (localCompressed && localCompressed !== entry.compressedSize) || (localUncompressed && localUncompressed !== entry.uncompressedSize))) {
      throw new Error(`ZIP data-descriptor local header is ambiguous for ${entry.path}`);
    }
    const dataEnd = within(zip, dataStart, entry.compressedSize, `data for ${entry.path}`);
    const descriptorBytes = descriptorLength(zip, dataEnd, entry);
    const recordEnd = checkedAdd(dataEnd, descriptorBytes, `record for ${entry.path}`);
    if (recordEnd > centralOffset) throw new Error(`ZIP entry overlaps central directory: ${entry.path}`);
    entry.dataStart = dataStart;
    entry.recordEnd = recordEnd;
    occupied.push({ start: local, end: recordEnd, path: entry.path });
  }
  occupied.sort((a, b) => a.start - b.start);
  for (let index = 1; index < occupied.length; index += 1) {
    if (occupied[index].start < occupied[index - 1].end) throw new Error(`Overlapping ZIP entries: ${occupied[index - 1].path} and ${occupied[index].path}`);
  }
  return { zip, container, entries, limits, totals: { compressedBytes: totalCompressed, uncompressedBytes: totalUncompressed } };
}

let crcTable;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      crcTable[index] = value >>> 0;
    }
  }
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

async function readBoundedArchive(archivePath, options = {}) {
  const limits = limitsFrom(options);
  const listed = await fsp.lstat(archivePath);
  if (!listed.isFile() || listed.isSymbolicLink()) throw new Error("Archive must be a regular file, not a symbolic link");
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const handle = await fsp.open(archivePath, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Archive must be a regular file");
    if (listed.dev !== stat.dev || listed.ino !== stat.ino) throw new Error("Archive changed before it could be opened safely");
    if (stat.size > limits.maxArchiveBytes) throw new Error(`Archive exceeds ${limits.maxArchiveBytes} bytes`);
    const buffer = await handle.readFile();
    if (buffer.length !== stat.size) throw new Error("Archive changed while it was being read");
    return buffer;
  } finally {
    await handle.close();
  }
}

async function extractArchive(archivePath, destination, options = {}) {
  const bytes = await readBoundedArchive(archivePath, options);
  const limits = limitsFrom(options);
  let parsed;
  let format;
  if (bytes.length >= 4 && (bytes.subarray(0, 4).toString("ascii") === "Cr24" || u32(bytes, 0, "archive signature") === ZIP.LOCAL)) {
    parsed = parseZip(bytes, options);
    format = "zip";
  } else {
    let tar = bytes;
    let gzip = false;
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      gzip = true;
      if (bytes.length > limits.maxCompressedBytes) throw new Error(`TAR compressed data exceeds ${limits.maxCompressedBytes} bytes`);
      try { tar = zlib.gunzipSync(bytes, { maxOutputLength: limits.maxUncompressedBytes + 1 }); }
      catch (error) { throw new Error(`Could not decompress TAR archive: ${error.message}`); }
      if (tar.length / Math.max(1, bytes.length) > limits.maxCompressionRatio) throw new Error("TAR exceeds compression-ratio limit");
    }
    if (tar.length > limits.maxUncompressedBytes) throw new Error(`TAR expands beyond ${limits.maxUncompressedBytes} bytes`);
    const entries = parseTar(tar, { maxEntries: limits.maxEntries });
    let totalUncompressed = 0;
    for (const entry of entries) {
      if (entry.kind === "file" && entry.size > limits.maxEntryBytes) throw new Error(`TAR entry exceeds ${limits.maxEntryBytes} bytes: ${entry.path}`);
      totalUncompressed = checkedAdd(totalUncompressed, entry.size, "TAR uncompressed total");
      if (totalUncompressed > limits.maxUncompressedBytes) throw new Error(`TAR expands beyond ${limits.maxUncompressedBytes} bytes`);
    }
    parsed = {
      tar,
      entries,
      container: { type: gzip ? "tar+gzip" : "tar", signatureVerified: null, headerBytes: 0 },
      totals: { compressedBytes: gzip ? bytes.length : tar.length, uncompressedBytes: totalUncompressed }
    };
    format = "tar";
  }
  const requested = path.resolve(destination);
  const parent = await fsp.realpath(path.dirname(requested));
  const target = path.join(parent, path.basename(requested));
  try {
    await fsp.lstat(target);
    throw new Error(`Extraction destination already exists: ${target}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const transaction = await fsp.mkdtemp(path.join(parent, `.${path.basename(target)}.extract-`));
  const payload = path.join(transaction, "payload");
  await fsp.mkdir(payload, { mode: 0o700 });
  try {
    for (const entry of parsed.entries) {
      const output = path.join(payload, ...entry.path.split("/"));
      if (entry.kind === "directory") {
        await fsp.mkdir(output, { recursive: true, mode: 0o700 });
        continue;
      }
      await fsp.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
      let content;
      if (format === "tar") content = Buffer.from(entry.content);
      else {
        const compressed = parsed.zip.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
        if (entry.method === 0) content = Buffer.from(compressed);
        else {
          try { content = zlib.inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize + 1 }); }
          catch (error) { throw new Error(`Could not inflate ZIP entry ${entry.path}: ${error.message}`); }
        }
        if (content.length !== entry.uncompressedSize) throw new Error(`ZIP entry size mismatch: ${entry.path}`);
        if (crc32(content) !== entry.crc32) throw new Error(`ZIP entry CRC32 mismatch: ${entry.path}`);
      }
      await fsp.writeFile(output, content, { mode: 0o600, flag: "wx" });
    }
    await fsp.rename(payload, target);
    return {
      destination: target,
      container: parsed.container,
      artifactSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      artifactBytes: bytes.length,
      payloadSha256: crypto.createHash("sha256").update(format === "zip" ? parsed.zip : parsed.tar).digest("hex"),
      ...(format === "zip" ? { zipSha256: crypto.createHash("sha256").update(parsed.zip).digest("hex") } : {}),
      entries: parsed.entries.length,
      compressedBytes: parsed.totals.compressedBytes,
      uncompressedBytes: parsed.totals.uncompressedBytes
    };
  } finally {
    await fsp.rm(transaction, { recursive: true, force: true });
  }
}

async function verifyDownloadedFile(file, options) {
  const algorithms = new Set(["sha256"]);
  let sri = null;
  if (options.integrity) {
    sri = integrityEntries(options.integrity);
    algorithms.add(sri[0].algorithm);
  }
  let expectedSha256 = null;
  if (options.expectedSha256) {
    if (!/^[a-f0-9]{64}$/i.test(options.expectedSha256)) throw new Error("expectedSha256 must be 64 hexadecimal characters");
    expectedSha256 = Buffer.from(options.expectedSha256, "hex");
  }
  if (!sri && !expectedSha256 && options.requireExpected !== false) {
    throw new Error("Archive acquisition requires integrity or expectedSha256");
  }
  const hashes = new Map([...algorithms].map(algorithm => [algorithm, crypto.createHash(algorithm)]));
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) {
    size += chunk.length;
    if (size > options.maxBytes) throw new Error(`Downloaded archive exceeds ${options.maxBytes} bytes`);
    for (const hash of hashes.values()) hash.update(chunk);
  }
  const digests = new Map([...hashes].map(([algorithm, hash]) => [algorithm, hash.digest()]));
  if (sri && !sri.some(entry => crypto.timingSafeEqual(entry.digest, digests.get(entry.algorithm)))) throw new Error("Downloaded archive integrity mismatch");
  if (expectedSha256 && !crypto.timingSafeEqual(expectedSha256, digests.get("sha256"))) throw new Error("Downloaded archive SHA-256 mismatch");
  return {
    size,
    sha256: digests.get("sha256").toString("hex"),
    integrityVerified: Boolean(sri || expectedSha256)
  };
}

async function acquireArchive(url, options = {}) {
  const allowedHosts = new Set(Array.from(options.allowedHosts || [], host => String(host).toLowerCase()));
  if (!allowedHosts.size) throw new Error("Archive acquisition requires a non-empty allowedHosts list");
  if (options.integrity) integrityEntries(options.integrity);
  if (options.expectedSha256 && !/^[a-f0-9]{64}$/i.test(options.expectedSha256)) {
    throw new Error("expectedSha256 must be 64 hexadecimal characters");
  }
  if (!options.integrity && !options.expectedSha256) throw new Error("Archive acquisition requires integrity or expectedSha256");
  const maxBytes = options.maxBytes || DEFAULT_LIMITS.maxArchiveBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive integer");
  const initial = new URL(url);
  const tempRoot = options.tempRoot ? path.resolve(options.tempRoot) : os.tmpdir();
  const workspace = await fsp.mkdtemp(path.join(tempRoot, "pkgxray-archive-"));
  const archivePath = path.join(workspace, "artifact");
  let resolvedUrl = initial.href;
  try {
    await downloadFile(initial.href, archivePath, {
      timeoutMs: options.timeoutMs || 30000,
      maxBytes,
      maxRedirects: options.maxRedirects ?? 5,
      transport: options.transport,
      headers: { "user-agent": `pkgxray/${require("../../package.json").version}` },
      validate(value) {
        const parsed = new URL(value);
        resolvedUrl = parsed.href;
        if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("Archive URL must use credential-free HTTPS");
        const host = parsed.host.toLowerCase();
        const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
        if (!allowedHosts.has(host) && !allowedHosts.has(hostname)) throw new Error(`Archive host is not allowed: ${parsed.host}`);
        if (isPrivateOrLocalHost(hostname)) throw new Error(`Archive host is private or local: ${parsed.host}`);
        return createUpstreamPolicy(parsed.origin, { lookup: options.lookup })(parsed);
      }
    });
    const verified = await verifyDownloadedFile(archivePath, { ...options, maxBytes });
    return {
      archivePath,
      workspace,
      sourceUrl: initial.href,
      resolvedUrl,
      ...verified,
      verification: {
        status: "verified",
        sha256: verified.sha256,
        expectedSha256: options.expectedSha256 || null,
        integrity: options.integrity || null
      },
      cleanup: () => fsp.rm(workspace, { recursive: true, force: true })
    };
  } catch (error) {
    await fsp.rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

module.exports = {
  DEFAULT_LIMITS,
  ZIP,
  acquireArchive,
  acquireDistributionArchive: acquireArchive,
  crc32,
  extractArchive,
  extractDistributionArchive: extractArchive,
  parseZip,
  readBoundedArchive,
  unwrapArchive,
  verifyDownloadedFile
};
