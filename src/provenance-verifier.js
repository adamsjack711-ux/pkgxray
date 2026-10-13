"use strict";

// Delegate PKI, transparency-log and TUF verification to the maintained
// Sigstore implementation. Never load a verifier from the audited project,
// NODE_PATH or PATH, and never implement a partial signature verifier here.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const ISSUER = "https://token.actions.githubusercontent.com";
const WORKER = `
  const fs = require('node:fs');
  (async () => {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const sdk = require(process.argv[1]);
    if (typeof sdk.verify !== 'function') throw new Error('Sigstore verify API unavailable');
    await sdk.verify(input.bundle, {
      certificateIssuer: input.issuer,
      certificateIdentityURI: new RegExp(input.identityPattern),
      ctLogThreshold: 1, tlogThreshold: 1,
      tufCachePath: process.cwd(), timeout: 3000, retry: 0
    });
    process.stdout.write(JSON.stringify({ verified: true }));
  })().catch(error => {
    process.stdout.write(JSON.stringify({ verified: false, code: String(error.code || ''),
      message: String(error.message || 'Verification failed').slice(0, 500) }));
    process.exitCode = 1;
  });
`;

function resolveVerifier(explicit = process.env.PKGXRAY_SIGSTORE_MODULE) {
  const candidates = [];
  if (explicit) {
    if (!path.isAbsolute(explicit)) return null;
    candidates.push(explicit);
  } else {
    // Only the npm shipped beside this trusted Node installation. An audited
    // directory cannot insert a dependency through ordinary module resolution.
    for (const executable of new Set([process.execPath, fs.realpathSync(process.execPath)])) {
      const prefix = path.dirname(path.dirname(executable));
      candidates.push(path.join(prefix, "lib/node_modules/npm/node_modules/sigstore"));
      candidates.push(path.join(prefix, "node_modules/npm/node_modules/sigstore"));
      // Homebrew's Node executable lives in Cellar, while npm is linked under
      // the same installation prefix. This is still runtime-owned resolution.
      const brew = executable.match(/^(\/opt\/homebrew|\/usr\/local)\/Cellar\/node(?:@\d+)?\//);
      if (brew) candidates.push(path.join(brew[1], "lib/node_modules/npm/node_modules/sigstore"));
    }
  }
  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync(candidate);
      const metadata = JSON.parse(fs.readFileSync(path.join(real, "package.json"), "utf8"));
      if (metadata.name !== "sigstore" || !/^[3-9]\./.test(metadata.version)) continue;
      return { modulePath: real, version: metadata.version };
    } catch { /* An unavailable backend cannot verify a claim. */ }
  }
  return null;
}

function digestBytes(value, algorithm) {
  const size = { sha256: 32, sha512: 64 }[algorithm];
  if (!size || typeof value !== "string") return null;
  if (new RegExp(`^[a-fA-F0-9]{${size * 2}}$`).test(value)) return Buffer.from(value, "hex");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.length === size && bytes.toString("base64").replace(/=+$/, "") === value.replace(/=+$/, "") ? bytes : null;
}

function boundSubject(primary, packageName, version, digests) {
  for (const subject of primary.subjectDigests || []) {
    let name;
    try { name = decodeURIComponent(subject.name || ""); } catch { continue; }
    if (name !== `pkg:npm/${packageName}@${version}`) continue;
    let matched = false;
    for (const algorithm of ["sha256", "sha512"]) {
      if (subject.digest?.[algorithm] === undefined) continue;
      const claim = digestBytes(subject.digest[algorithm], algorithm);
      const actual = digestBytes(digests?.[algorithm], algorithm);
      // Every supported digest in the selected subject must match actual bytes.
      if (!claim || !actual || !crypto.timingSafeEqual(claim, actual)) return false;
      matched = true;
    }
    if (matched) return true;
  }
  return false;
}

function expectedIdentity(primary, repository) {
  const value = typeof repository === "string" ? repository : repository?.url;
  let url;
  try { url = new URL(String(value).replace(/^git\+/, "")); } catch { return null; }
  const repoPath = url.pathname.replace(/\.git\/?$/, "").replace(/\/$/, "");
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password ||
      !/^\/[\w.-]+\/[\w.-]+$/.test(repoPath)) return null;
  let claimed;
  try { claimed = new URL(primary.repository); } catch { return null; }
  if (claimed.origin !== "https://github.com" || claimed.pathname.replace(/\/$/, "").toLowerCase() !== repoPath.toLowerCase()) return null;
  if (typeof primary.workflowPath !== "string" || !/^\.github\/workflows\/[\w./-]+\.ya?ml$/.test(primary.workflowPath) ||
      primary.workflowPath.split("/").includes("..") ||
      typeof primary.ref !== "string" || !/^refs\/(heads|tags)\/[^@\x00-\x20]+$/.test(primary.ref) || primary.ref.includes("..")) return null;
  // This checks consistency with the package's declared repo, not an operator
  // allowlist: even an authenticated build can be malicious.
  return `https://github.com${claimed.pathname.replace(/\/$/, "")}/${primary.workflowPath}@${primary.ref}`;
}

async function runVerifier(backend, bundle, identity, timeoutMs = 15000) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error("Invalid provenance deadline");
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "pkgxray-provenance-"));
  await fsp.chmod(directory, 0o700);
  try {
    return await new Promise((resolve) => {
      const env = { PATH: process.platform === "win32" ? process.env.PATH || "" : "/usr/bin:/bin", HOME: directory,
        TMPDIR: directory, TMP: directory, TEMP: directory };
      if (process.platform === "win32" && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
      const child = spawn(process.execPath, ["-e", WORKER, backend.modulePath], {
        cwd: directory, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32"
      });
      const chunks = [];
      let bytes = 0, failure, stderrBytes = 0;
      const stop = (reason) => {
        failure ||= reason;
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch { /* Spawn failure or already exited. */ }
      };
      const timer = setTimeout(() => stop("verification-timeout"), timeoutMs);
      child.stdout.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 32768) stop("verification-output-limit");
        else chunks.push(chunk);
      });
      child.stderr.on("data", chunk => { stderrBytes += chunk.length; if (stderrBytes > 32768) stop("verification-output-limit"); });
      child.stdin.on("error", () => {});
      child.on("error", () => { failure ||= "verification-unavailable"; });
      child.on("close", code => {
        clearTimeout(timer);
        if (failure) return resolve({ status: "unverified", reason: failure });
        let output;
        try { output = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { return resolve({ status: "unverified", reason: "invalid-verifier-output" }); }
        if (code === 0 && output.verified === true) return resolve({ status: "verified" });
        return resolve({ status: /^TUF_|FETCH|TIMEOUT/.test(output.code || "") ? "unverified" : "invalid",
          reason: output.code || "signature-verification-failed" });
      });
      child.stdin.end(JSON.stringify({ bundle, issuer: ISSUER,
        identityPattern: `^${identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$` }));
    });
  } finally { await fsp.rm(directory, { recursive: true, force: true }); }
}

async function verifyProvenanceBundle(attestation, { packageName, version, digests, repository, modulePath, timeoutMs, backendRunner = runVerifier } = {}) {
  const { parseAttestation } = require("./attestation");
  const primary = parseAttestation(attestation);
  if (!primary) return { status: "invalid", reason: "malformed-provenance" };
  let statement;
  try { statement = JSON.parse(Buffer.from(attestation.bundle.dsseEnvelope.payload, "base64")); } catch { return { status: "invalid", reason: "malformed-provenance" }; }
  if (attestation.bundle.dsseEnvelope.payloadType !== "application/vnd.in-toto+json" ||
      !["https://in-toto.io/Statement/v0.1", "https://in-toto.io/Statement/v1"].includes(statement._type) ||
      !["https://slsa.dev/provenance/v0.2", "https://slsa.dev/provenance/v1"].includes(statement.predicateType)) {
    return { status: "invalid", reason: "invalid-statement-type" };
  }
  if (!digests?.sha256 && !digests?.sha512) return { status: "unverified", reason: "artifact-digest-unavailable" };
  if (!boundSubject(primary, packageName, version, digests)) return { status: "invalid", reason: "artifact-subject-mismatch" };
  const identity = expectedIdentity(primary, repository);
  if (!identity) return { status: "unverified", reason: "signer-policy-unavailable" };
  if (Buffer.byteLength(JSON.stringify(attestation.bundle)) > MAX_BUNDLE_BYTES) return { status: "invalid", reason: "bundle-too-large" };
  const backend = resolveVerifier(modulePath);
  if (!backend) return { status: "unverified", reason: "sigstore-verifier-unavailable" };
  const result = await backendRunner(backend, attestation.bundle, identity, timeoutMs);
  return { ...result, cryptographicallyVerified: result.status === "verified", artifactBound: result.status === "verified",
    certificateIdentity: identity, certificateIssuer: ISSUER, verifier: `sigstore@${backend.version}` };
}

module.exports = { verifyProvenanceBundle, resolveVerifier, boundSubject, digestBytes, expectedIdentity, runVerifier };
