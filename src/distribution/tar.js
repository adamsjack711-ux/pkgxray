"use strict";

const DEFAULT_MAX_ENTRIES = 100_000;
const DEFAULT_MAX_EXTENDED_BYTES = 1024 * 1024;
const DEFAULT_MAX_PATH_BYTES = 4096;
const DEFAULT_MAX_SEGMENT_BYTES = 255;

function tarString(block, start, length) {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end < 0 ? slice.length : end).toString("utf8");
}

function tarNumber(block, start, length, label) {
  const bytes = block.subarray(start, start + length);
  if (bytes[0] & 0x80) throw new Error(`TAR uses unsupported base-256 ${label}`);
  const text = bytes.toString("ascii").replace(/\0.*$/, "").trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error(`TAR has invalid ${label}`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new Error(`TAR ${label} is too large`);
  return value;
}

function safeTarPath(raw, options = {}) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > (options.maxPathBytes ?? DEFAULT_MAX_PATH_BYTES)) {
    throw new Error("TAR entry path is missing or exceeds the path-byte limit");
  }
  while (raw.startsWith("./")) raw = raw.slice(2);
  if (!raw || raw.includes("\\") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw new Error(`Unsafe TAR entry path: ${JSON.stringify(raw)}`);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(raw)) throw new Error(`Unsafe TAR entry path: ${JSON.stringify(raw)}`);
  const directory = raw.endsWith("/");
  const trimmed = directory ? raw.slice(0, -1) : raw;
  const parts = trimmed.split("/");
  if (!trimmed || parts.some(part => !part || part === "." || part === "..")) throw new Error(`Unsafe TAR entry path: ${JSON.stringify(raw)}`);
  if (parts.some(part => Buffer.byteLength(part, "utf8") > (options.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES))) {
    throw new Error(`TAR entry path segment exceeds the byte limit: ${JSON.stringify(raw)}`);
  }
  if (options.rejectWhiteouts && parts.some(part => part.startsWith(".wh."))) throw new Error(`OCI whiteout semantics are not supported safely: ${trimmed}`);
  const normalized = trimmed.normalize("NFC");
  if (normalized !== trimmed) throw new Error(`TAR entry path is not NFC-normalized: ${JSON.stringify(raw)}`);
  return { relative: normalized, directory };
}

function paxRecords(bytes) {
  const records = Object.create(null);
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space < 0 || space - offset > 20) throw new Error("Malformed PAX record length");
    const lengthText = bytes.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw new Error("Malformed PAX record length");
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length < space - offset + 4 || offset + length > bytes.length || bytes[offset + length - 1] !== 0x0a) {
      throw new Error("Malformed PAX record bounds");
    }
    const record = bytes.subarray(space + 1, offset + length - 1);
    const equals = record.indexOf(0x3d);
    if (equals <= 0) throw new Error("Malformed PAX key/value record");
    const keyBytes = record.subarray(0, equals);
    const valueBytes = record.subarray(equals + 1);
    const key = keyBytes.toString("utf8");
    const value = valueBytes.toString("utf8");
    if (Buffer.from(key, "utf8").compare(keyBytes) !== 0 || Buffer.from(value, "utf8").compare(valueBytes) !== 0 ||
        !/^[A-Za-z0-9_.-]+$/.test(key) || Object.hasOwn(records, key)) {
      throw new Error("PAX record has invalid UTF-8, key, or duplicate field");
    }
    if (/^(?:GNU\.)?sparse(?:\.|$)/i.test(key) || key === "linkpath") throw new Error(`Unsupported security-sensitive PAX field: ${key}`);
    records[key] = value;
    offset += length;
  }
  return records;
}

function paxSize(value) {
  if (value === undefined) return null;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error("PAX size must be a non-negative decimal integer");
  const size = Number(value);
  if (!Number.isSafeInteger(size)) throw new Error("PAX size is too large");
  return size;
}

function longName(bytes) {
  let end = bytes.length;
  while (end && bytes[end - 1] === 0) end -= 1;
  const value = bytes.subarray(0, end).toString("utf8");
  if (!value || Buffer.from(value, "utf8").compare(bytes.subarray(0, end)) !== 0) throw new Error("GNU long name is empty or invalid UTF-8");
  return value;
}

function parseTar(bytes, options = {}) {
  if (!Buffer.isBuffer(bytes)) throw new Error("TAR input must be a Buffer");
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxExtendedBytes = options.maxExtendedBytes ?? DEFAULT_MAX_EXTENDED_BYTES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error("maxEntries must be a positive integer");
  if (!Number.isSafeInteger(maxExtendedBytes) || maxExtendedBytes < 1) throw new Error("maxExtendedBytes must be a positive integer");
  const entries = [];
  const pathKinds = new Map();
  let offset = 0;
  let zeroBlocks = 0;
  let headerCount = 0;
  let pendingPax = null;
  let pendingLongName = null;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    offset += 512;
    if (header.every(byte => byte === 0)) {
      zeroBlocks += 1;
      if (zeroBlocks === 2) break;
      continue;
    }
    if (zeroBlocks) throw new Error("TAR has an ambiguous partial end marker");
    if (++headerCount > maxEntries) throw new Error(`TAR exceeds ${maxEntries} entries or extended headers`);
    const storedChecksum = tarNumber(header, 148, 8, "checksum");
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 0x20 : header[index];
    if (checksum !== storedChecksum) throw new Error("TAR checksum mismatch");
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const type = String.fromCharCode(header[156] || 0);
    const headerSize = tarNumber(header, 124, 12, "entry size");
    if (["x", "g", "L", "K"].includes(type)) {
      if (headerSize > maxExtendedBytes) throw new Error(`TAR extended header exceeds ${maxExtendedBytes} bytes`);
      const padded = Math.ceil(headerSize / 512) * 512;
      if (offset + padded > bytes.length) throw new Error("Truncated TAR extended header");
      const content = bytes.subarray(offset, offset + headerSize);
      offset += padded;
      if (type === "K") throw new Error("GNU long links are unsupported");
      if (type === "L") {
        if (pendingLongName !== null) throw new Error("Duplicate GNU long-name header");
        pendingLongName = longName(content);
      } else {
        const records = paxRecords(content);
        if (type === "g") {
          if (records.path !== undefined || records.size !== undefined) throw new Error("Global PAX path or size overrides are unsupported");
        } else {
          if (pendingPax !== null) throw new Error("Duplicate local PAX header");
          pendingPax = records;
        }
      }
      continue;
    }
    const paxPath = pendingPax ? pendingPax.path : undefined;
    if (paxPath !== undefined && pendingLongName !== null && paxPath !== pendingLongName) throw new Error("Conflicting PAX and GNU path overrides");
    const rawPath = paxPath !== undefined ? paxPath : pendingLongName !== null ? pendingLongName : prefix ? `${prefix}/${name}` : name;
    const sizeOverride = pendingPax ? paxSize(pendingPax.size) : null;
    pendingPax = null;
    pendingLongName = null;
    const safe = safeTarPath(rawPath, options);
    if (!["\0", "0", "5"].includes(type)) throw new Error(`TAR links, devices, sparse files, and unsupported entries are rejected: ${safe.relative} (type ${JSON.stringify(type)})`);
    if ((type === "5") !== safe.directory) throw new Error(`TAR type and trailing slash disagree: ${safe.relative}`);
    const kind = type === "5" ? "directory" : "file";
    const size = sizeOverride === null ? headerSize : sizeOverride;
    if (kind === "directory" && size !== 0) throw new Error(`TAR directory contains data: ${safe.relative}`);
    const padded = Math.ceil(size / 512) * 512;
    if (offset + padded > bytes.length) throw new Error(`Truncated TAR entry: ${safe.relative}`);
    const parts = safe.relative.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join("/");
      const parentKey = parent.toLocaleLowerCase("en-US");
      const existingParent = pathKinds.get(parentKey);
      if (existingParent && (existingParent.path !== parent || existingParent.kind === "file")) {
        throw new Error(`TAR has a case collision or file parent: ${safe.relative}`);
      }
      if (!existingParent) pathKinds.set(parentKey, { path: parent, kind: "implicit-directory" });
    }
    const key = safe.relative.toLocaleLowerCase("en-US");
    const existing = pathKinds.get(key);
    if (existing && !(existing.kind === "implicit-directory" && kind === "directory" && existing.path === safe.relative)) {
      throw new Error(`Duplicate, case-colliding, or type-conflicting TAR entry: ${safe.relative}`);
    }
    pathKinds.set(key, { path: safe.relative, kind });
    entries.push({ path: safe.relative, kind, size, content: bytes.subarray(offset, offset + size) });
    offset += padded;
  }
  if (pendingPax !== null || pendingLongName !== null) throw new Error("TAR ends with an unapplied extended path header");
  if (zeroBlocks !== 2 || bytes.subarray(offset).some(byte => byte !== 0)) throw new Error("TAR does not end with two zero blocks");
  return entries;
}

module.exports = { DEFAULT_MAX_ENTRIES, DEFAULT_MAX_EXTENDED_BYTES, DEFAULT_MAX_PATH_BYTES,
  DEFAULT_MAX_SEGMENT_BYTES, longName, parseTar, paxRecords, paxSize, safeTarPath, tarNumber, tarString };
