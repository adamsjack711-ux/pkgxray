"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ALGORITHMS = { sha1: 20, sha256: 32, sha384: 48, sha512: 64 };
function integrityEntries(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Artifact integrity is required");
  const entries = value.trim().split(/\s+/).map(token => {
    const match = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(token);
    if (!match) throw new Error("Unsupported or malformed artifact integrity");
    const digest = Buffer.from(match[2], "base64");
    if (digest.length !== ALGORITHMS[match[1]] || digest.toString("base64").replace(/=+$/, "") !== match[2].replace(/=+$/, "")) throw new Error("Malformed artifact digest");
    return { algorithm: match[1], digest };
  });
  const strongest = Math.max(...entries.map(e => ALGORITHMS[e.algorithm]));
  return entries.filter(e => ALGORITHMS[e.algorithm] === strongest);
}
async function verifyFile(file, integrity) {
  const entries = integrityEntries(integrity);
  const algorithm = entries[0].algorithm;
  const hash = crypto.createHash(algorithm);
  const sha256 = crypto.createHash("sha256");
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) {
    size += chunk.length;
    if (size > 64 * 1024 * 1024) throw new Error("Artifact exceeds 64 MiB limit");
    hash.update(chunk); sha256.update(chunk);
  }
  const digest = hash.digest();
  if (!entries.some(e => crypto.timingSafeEqual(e.digest, digest))) throw new Error("Artifact integrity mismatch");
  return { sha256: sha256.digest("hex"), size };
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, canonical(value[k])]));
  return value;
}
function fingerprint(value) { return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
// Identify this scanner build, including acquisition, policy and CLI behavior.
function computeBuildId(root) {
  const files = ["package.json"];
  function walk(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push(file);
      else throw new Error(`Non-regular runtime entry: ${file}`);
    }
  }
  // Include nested runtime code, vendored parsers, data and every entrypoint.
  // Never traverse node_modules or generated workspace/test output.
  walk("src"); walk("bin");
  const build = crypto.createHash("sha256");
  for (const file of files.sort()) {
    const bytes = fs.readFileSync(path.join(root, file));
    build.update(`${file}\0${bytes.length}\0`); build.update(bytes);
  }
  return build.digest("hex");
}
const BUILD_ID = computeBuildId(path.join(__dirname, ".."));
module.exports = { integrityEntries, verifyFile, fingerprint, computeBuildId, BUILD_ID };
