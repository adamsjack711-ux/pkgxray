"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");

const CRX_MAGIC = Buffer.from("Cr24");
const DEFAULT_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

function extensionId(publicKey) {
  return crypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 32)
    .replace(/[0-9a-f]/g, nibble => String.fromCharCode(97 + Number.parseInt(nibble, 16)));
}

function readVarint(buffer, start) {
  let value = 0;
  let shift = 0;
  let offset = start;
  while (offset < buffer.length && shift <= 49) {
    const byte = buffer[offset++];
    value += (byte & 0x7f) * (2 ** shift);
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7;
  }
  throw new Error("Malformed protobuf varint");
}

function protobufFields(buffer) {
  const fields = [];
  let offset = 0;
  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset);
    offset = tag.offset;
    const number = Math.floor(tag.value / 8);
    const wire = tag.value & 7;
    if (number <= 0) throw new Error("Malformed protobuf field number");
    if (wire === 0) {
      const value = readVarint(buffer, offset);
      fields.push({ number, wire, value: value.value });
      offset = value.offset;
    } else if (wire === 1) {
      if (offset + 8 > buffer.length) throw new Error("Truncated protobuf fixed64 field");
      fields.push({ number, wire, value: buffer.subarray(offset, offset + 8) });
      offset += 8;
    } else if (wire === 2) {
      const length = readVarint(buffer, offset);
      offset = length.offset;
      if (!Number.isSafeInteger(length.value) || length.value < 0 || offset + length.value > buffer.length) throw new Error("Truncated protobuf bytes field");
      fields.push({ number, wire, value: buffer.subarray(offset, offset + length.value) });
      offset += length.value;
    } else if (wire === 5) {
      if (offset + 4 > buffer.length) throw new Error("Truncated protobuf fixed32 field");
      fields.push({ number, wire, value: buffer.subarray(offset, offset + 4) });
      offset += 4;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wire}`);
    }
  }
  return fields;
}

function fieldBytes(fields, number) {
  const item = fields.find(field => field.number === number && field.wire === 2);
  return item ? item.value : null;
}

function crx2(buffer) {
  if (buffer.length < 16) throw new Error("Truncated CRX2 header");
  const publicKeyLength = buffer.readUInt32LE(8);
  const signatureLength = buffer.readUInt32LE(12);
  const zipOffset = 16 + publicKeyLength + signatureLength;
  if (zipOffset > buffer.length || publicKeyLength === 0 || signatureLength === 0) throw new Error("Malformed CRX2 header lengths");
  const publicKey = buffer.subarray(16, 16 + publicKeyLength);
  const signature = buffer.subarray(16 + publicKeyLength, zipOffset);
  const archive = buffer.subarray(zipOffset);
  const key = crypto.createPublicKey({ key: publicKey, format: "der", type: "spki" });
  const verified = crypto.verify("RSA-SHA1", archive, key, signature);
  return {
    format: "crx2",
    status: verified ? "verified" : "invalid",
    cryptographicallyVerified: verified,
    identityBound: verified,
    extensionId: extensionId(publicKey),
    archiveOffset: zipOffset,
    algorithm: "RSA-SHA1",
    reason: verified ? null : "CRX2 signature did not verify"
  };
}

function crx3(buffer) {
  if (buffer.length < 12) throw new Error("Truncated CRX3 header");
  const headerLength = buffer.readUInt32LE(8);
  const zipOffset = 12 + headerLength;
  if (headerLength === 0 || zipOffset > buffer.length) throw new Error("Malformed CRX3 header length");
  const header = protobufFields(buffer.subarray(12, zipOffset));
  const signedHeaderData = fieldBytes(header, 10000);
  if (!signedHeaderData) throw new Error("CRX3 signed_header_data is missing");
  const signedFields = protobufFields(signedHeaderData);
  const crxId = fieldBytes(signedFields, 1);
  if (!crxId || crxId.length !== 16) throw new Error("CRX3 id is missing or malformed");
  const prefix = Buffer.from("CRX3 SignedData\0", "binary");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedHeaderData.length);
  const signed = Buffer.concat([prefix, length, signedHeaderData, buffer.subarray(zipOffset)]);
  const proofs = [];
  for (const [fieldNumber, algorithm, keyType, label] of [[2, "sha256", "rsa", "RSA-SHA256"], [3, "sha256", "ec", "ECDSA-SHA256"]]) {
    for (const field of header.filter(item => item.number === fieldNumber && item.wire === 2)) {
      try {
        const proof = protobufFields(field.value);
        const publicKey = fieldBytes(proof, 1);
        const signature = fieldBytes(proof, 2);
        if (!publicKey || !signature) continue;
        const keyHash = crypto.createHash("sha256").update(publicKey).digest().subarray(0, 16);
        const identityMatches = crypto.timingSafeEqual(keyHash, crxId);
        const key = crypto.createPublicKey({ key: publicKey, format: "der", type: "spki" });
        const signatureValid = crypto.verify(algorithm, signed, key, signature);
        proofs.push({ publicKey, keyType, label, identityMatches, signatureValid });
      } catch { /* retain other valid proofs */ }
    }
  }
  const valid = proofs.find(proof => proof.identityMatches && proof.signatureValid);
  return {
    format: "crx3",
    status: valid ? "verified" : "invalid",
    cryptographicallyVerified: Boolean(valid),
    identityBound: Boolean(valid),
    extensionId: valid ? extensionId(valid.publicKey) : null,
    archiveOffset: zipOffset,
    algorithm: valid ? valid.label : null,
    reason: valid ? null : "No CRX3 proof verified both the signature and CRX id"
  };
}

function verifyCrxBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(0, 4).equals(CRX_MAGIC)) {
    return { format: null, status: "not-applicable", cryptographicallyVerified: false, identityBound: false, reason: "artifact is not CRX" };
  }
  const version = buffer.readUInt32LE(4);
  try {
    if (version === 2) return crx2(buffer);
    if (version === 3) return crx3(buffer);
    return { format: `crx${version}`, status: "unsupported", cryptographicallyVerified: false, identityBound: false, reason: `unsupported CRX version ${version}` };
  } catch (error) {
    return { format: `crx${version}`, status: "invalid", cryptographicallyVerified: false, identityBound: false, reason: error.message };
  }
}

function archiveSignatureHints(buffer, filename = "") {
  const lower = String(filename).toLowerCase();
  const text = buffer.toString("latin1");
  if (/\.vsix$/.test(lower) && /_xmlsignatures\/[^\0]{0,128}\.xml/i.test(text)) {
    return { format: "vsix", status: "present-unverified", cryptographicallyVerified: false, identityBound: false,
      reason: "VSIX contains an OPC signature part, but XML signature verification is not implemented" };
  }
  if (/\.(?:xpi|zip)$/.test(lower) && /META-INF\/(?:mozilla\.(?:rsa|sf)|cose\.sig)/i.test(text)) {
    return { format: "xpi", status: "present-unverified", cryptographicallyVerified: false, identityBound: false,
      reason: "extension signature material is present, but CMS/COSE verification is not implemented" };
  }
  if (/\.(?:jar|zip)$/.test(lower) && /META-INF\/[^\0]{0,128}\.(?:RSA|DSA|EC)/.test(text)) {
    return { format: "jar", status: "present-unverified", cryptographicallyVerified: false, identityBound: false,
      reason: "JAR signature material is present, but JAR signature verification is not implemented" };
  }
  return { format: null, status: "absent", cryptographicallyVerified: false, identityBound: false, reason: "no supported archive signature was verified" };
}

function inspectArtifactProvenance(file, options = {}) {
  const stat = fs.statSync(file);
  const limit = options.maxArtifactBytes || DEFAULT_MAX_ARTIFACT_BYTES;
  if (!stat.isFile()) throw new Error("Provenance target must be a regular file");
  if (stat.size > limit) return { format: null, status: "unverified", cryptographicallyVerified: false, identityBound: false,
    reason: `artifact exceeds the ${limit}-byte provenance verification limit` };
  const buffer = fs.readFileSync(file);
  const crx = verifyCrxBuffer(buffer);
  return crx.status !== "not-applicable" ? crx : archiveSignatureHints(buffer, file);
}

async function readProvenanceBundle(file, options = {}) {
  const limit = options.maxBundleBytes || 2 * 1024 * 1024;
  const listed = await fsp.lstat(file);
  if (!listed.isFile() || listed.isSymbolicLink()) throw new Error("Sigstore bundle must be a regular file, not a symbolic link");
  if (listed.size > limit) throw new Error(`Sigstore bundle exceeds ${limit} bytes`);
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== listed.dev || stat.ino !== listed.ino || stat.size !== listed.size) {
      throw new Error("Sigstore bundle changed while opening");
    }
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size) throw new Error("Sigstore bundle changed while reading");
    try { return JSON.parse(bytes.toString("utf8")); }
    catch (error) { throw new Error(`Sigstore bundle is not valid JSON: ${error.message}`); }
  } finally { await handle.close(); }
}

async function verifyArtifactProvenance(file, binding, options = {}) {
  const archive = inspectArtifactProvenance(file, options);
  if (!options.sigstoreBundle) return archive;
  if (!binding || !/^[a-f0-9]{64}$/.test(String(binding.sha256 || ""))) {
    throw new Error("Sigstore verification requires an exact artifact SHA-256 binding");
  }
  let attestation;
  try { attestation = await readProvenanceBundle(options.sigstoreBundle, options); }
  catch (error) {
    return { format: "sigstore-bundle", status: "invalid", cryptographicallyVerified: false,
      artifactBound: false, identityBound: false, reason: error.message, archive };
  }
  const verification = await require("../provenance-verifier").verifyDistributionProvenanceBundle(attestation, {
    artifactSha256: binding.sha256,
    subjectName: options.sigstoreSubject,
    certificateIdentity: options.certificateIdentity,
    certificateIssuer: options.certificateIssuer,
    modulePath: options.sigstoreModulePath,
    timeoutMs: options.timeoutMs,
    backendRunner: options.backendRunner
  });
  if (archive.status === "invalid") {
    return { ...archive, status: "invalid", sigstore: verification,
      reason: `${archive.reason || "archive signature verification failed"}; the container failure cannot be overridden by external provenance` };
  }
  return { ...verification, archive };
}

module.exports = {
  DEFAULT_MAX_ARTIFACT_BYTES,
  archiveSignatureHints,
  extensionId,
  inspectArtifactProvenance,
  readProvenanceBundle,
  protobufFields,
  verifyArtifactProvenance,
  verifyCrxBuffer
};
