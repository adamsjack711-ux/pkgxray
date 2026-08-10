"use strict";

// npm provenance attestation fetch + parse.
//
// When a package is published via `npm publish --provenance` from a GitHub
// Action, npm stores a sigstore-signed SLSA Provenance attestation that
// cryptographically links the tarball to the commit + workflow that built it.
// pkgxray surfaces this as a positive trust signal (~10% of top packages
// have it as of 2026: TypeScript-adjacent tooling, vite/vitest, sigstore,
// @actions/*, @octokit/*, etc.).
//
// IMPORTANT — pkgxray does NOT cryptographically verify these attestations.
// We base64-decode the DSSE payload and read the self-reported fields. We do
// NOT check the sigstore signature, the Fulcio certificate chain, the Rekor
// transparency-log inclusion proof, or that the subject digest binds to the
// tarball we actually downloaded. A full sigstore client (Fulcio + Rekor +
// certificate transparency) is ~hundreds of KB against a "zero-dep" goal, so
// it is deliberately out of scope.
//
// Consequently `attested:true` means ONLY "a parseable, SLSA-shaped provenance
// document is present" — NOT "verified provenance". Anyone can hand-craft an
// unsigned bundle whose payload claims any repo/workflow; this module would
// parse it. That is why provenance is surfaced at severity INFO and is
// excluded from scoring (see the non-offsetting invariant in auditor.js): a
// parseable-but-unsigned attestation must never move a verdict toward "safe".
//
// If a caller has the downloaded tarball's digest, it can call
// verifySubjectDigest() to check the attestation's subject[].digest actually
// binds to that artifact — but even a match is not a signature check.
//
// Cache: ~/.cache/pkgxray/attestations/<name>@<version>.json, 24h TTL. We
// cache 404s too (most packages don't have attestations — caching the
// negative result means we don't re-hit npm on every audit).

const fs = require("node:fs/promises");
const fssync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");

const USER_AGENT = `pkgxray/${require("../package.json").version}`;
const CACHE_DIR = path.join(os.homedir(), ".cache", "pkgxray", "attestations");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 4000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // attestations are JSON, ~10-50KB each
// Cap on a single DSSE payload after base64-decode. Real in-toto Statements
// are a few KB; refusing anything larger stops a crafted bundle from decoding
// a huge base64 blob and blowing up JSON.parse. (finding 4a)
const MAX_DECODED_PAYLOAD_BYTES = 1 * 1024 * 1024;
const REGISTRY_BASE = "https://registry.npmjs.org/-/npm/v1/attestations";

// Module-local keep-alive agent so the provenance fetch can re-use a socket
// across the same audit (e.g. lockfile mode → batch attestation fetches) or
// across back-to-back runs in the same process.
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 10 });

// Predicate types we recognise. SLSA v1 is what npm currently emits (2024+);
// v0.2 is the older format that some packages still have on disk from
// earlier releases. We accept either.
const SLSA_V1 = "https://slsa.dev/provenance/v1";
const SLSA_V02 = "https://slsa.dev/provenance/v0.2";

function cacheKeyFor(name, version) {
  // Encode the whole `name@version` so scoped packages and version specifiers
  // become a single safe filename. e.g. "@actions/core@1.11.1" →
  // "%40actions%2Fcore%401.11.1.json".
  return `${encodeURIComponent(`${name}@${version}`)}.json`;
}

async function readCache(name, version) {
  try {
    const file = path.join(CACHE_DIR, cacheKeyFor(name, version));
    const stat = await fs.stat(file);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function writeCache(name, version, value) {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
    const file = path.join(CACHE_DIR, cacheKeyFor(name, version));
    await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
  } catch {
    // best-effort cache — never fail the audit because of a cache miss/write
  }
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "user-agent": USER_AGENT,
          accept: "application/json"
        },
        timeout: FETCH_TIMEOUT_MS,
        agent: HTTPS_AGENT
      },
      (response) => {
        if (response.statusCode === 404) {
          response.resume();
          const error = new Error(`HTTP 404 from ${url}`);
          error.statusCode = 404;
          return reject(error);
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          const error = new Error(`HTTP ${response.statusCode} from ${url}`);
          error.statusCode = response.statusCode;
          return reject(error);
        }
        let body = "";
        let size = 0;
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          size += Buffer.byteLength(chunk);
          if (size > MAX_RESPONSE_BYTES) {
            response.destroy();
            return reject(new Error(`Attestation response exceeded ${MAX_RESPONSE_BYTES} bytes`));
          }
          body += chunk;
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (parseError) {
            reject(parseError);
          }
        });
      }
    );
    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy(new Error("Attestation request timed out"));
    });
  });
}

// Decode a DSSE envelope payload (base64-encoded in-toto Statement JSON).
// NOTE: this only decodes/parses — it does NOT verify the DSSE signature.
function decodePayload(envelope) {
  if (!envelope || typeof envelope.payload !== "string") return null;
  // Cheap pre-check on the encoded length so we never even allocate the
  // decoded buffer for an oversized payload (base64 is ~4/3 the raw size).
  if (envelope.payload.length > Math.ceil((MAX_DECODED_PAYLOAD_BYTES * 4) / 3) + 4) {
    return null;
  }
  try {
    const buf = Buffer.from(envelope.payload, "base64");
    if (buf.length > MAX_DECODED_PAYLOAD_BYTES) return null; // finding 4a
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
}

// Extract the raw subject[].digest map(s) from a decoded in-toto Statement.
// Returns an array of { name, digest } so a caller with the tarball's digest
// can check that the attestation actually binds to the artifact it downloaded.
function extractSubjectDigests(payload) {
  if (!payload || !Array.isArray(payload.subject)) return [];
  return payload.subject
    .filter((s) => s && typeof s === "object")
    .map((s) => ({
      name: typeof s.name === "string" ? s.name : null,
      digest: s.digest && typeof s.digest === "object" ? s.digest : {}
    }));
}

// Given a parsed attestation (or its subjectDigests array) and the digest of
// the tarball we actually downloaded, return true only if some subject digest
// binds to it. `downloadedDigest` is { algorithm, value } e.g.
// { algorithm: "sha512", value: "abc..." }. Comparison is case-insensitive
// hex/base64-agnostic exact-string. This is a BINDING check, NOT a signature
// check — a matching digest on an unsigned bundle still proves nothing about
// authenticity, only that this artifact is the one the (unverified) claim
// names.
function verifySubjectDigest(parsedOrDigests, downloadedDigest) {
  if (!downloadedDigest || !downloadedDigest.algorithm || !downloadedDigest.value) return false;
  const wantAlg = String(downloadedDigest.algorithm).toLowerCase();
  const wantVal = String(downloadedDigest.value).toLowerCase();
  const subjects = Array.isArray(parsedOrDigests)
    ? parsedOrDigests
    : (parsedOrDigests && parsedOrDigests.subjectDigests) || [];
  for (const subj of subjects) {
    const digest = (subj && subj.digest) || {};
    for (const [alg, val] of Object.entries(digest)) {
      if (String(alg).toLowerCase() === wantAlg && String(val).toLowerCase() === wantVal) {
        return true;
      }
    }
  }
  return false;
}

// Pull `owner/repo` out of a `https://github.com/owner/repo` URL or a
// `git+https://github.com/owner/repo.git` URL. Returns null if the URL isn't
// a GitHub URL.
function parseGithubUrl(url) {
  if (typeof url !== "string") return null;
  const cleaned = url.replace(/^git\+/, "").replace(/\.git(?:[#?].*)?$/, "");
  const match = cleaned.match(/^(?:https?|git):\/\/github\.com\/([^/]+)\/([^/?#@]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], url: `https://github.com/${match[1]}/${match[2]}` };
}

// Normalise a string for repo-vs-repo comparison. Strips protocol, .git
// suffix, trailing slash, and lowercases.
function canonicalGithubKey(url) {
  const parsed = parseGithubUrl(url);
  if (!parsed) return null;
  return `${parsed.owner.toLowerCase()}/${parsed.repo.toLowerCase()}`;
}

// SLSA v1 layout:
//   predicate.buildDefinition.externalParameters.workflow.{repository,ref,path}
//   predicate.buildDefinition.resolvedDependencies[0].{uri,digest.gitCommit}
//   predicate.runDetails.builder.id
//   predicate.runDetails.metadata.invocationId
function extractSlsaV1(predicate) {
  const bd = (predicate && predicate.buildDefinition) || {};
  const rd = (predicate && predicate.runDetails) || {};
  const wf = (bd.externalParameters && bd.externalParameters.workflow) || {};
  const dep = Array.isArray(bd.resolvedDependencies) && bd.resolvedDependencies[0]
    ? bd.resolvedDependencies[0]
    : null;
  return {
    slsaVersion: "v1",
    buildType: bd.buildType || null,
    repository: wf.repository || (dep && stripGitUri(dep.uri)) || null,
    ref: wf.ref || (dep && refFromGitUri(dep.uri)) || null,
    commitSha: dep && dep.digest ? dep.digest.gitCommit || null : null,
    workflowPath: wf.path || null,
    builderId: (rd.builder && rd.builder.id) || null,
    invocationId: (rd.metadata && rd.metadata.invocationId) || null
  };
}

// SLSA v0.2 layout:
//   predicate.builder.id
//   predicate.buildType
//   predicate.invocation.configSource.{uri,digest.sha1,entryPoint}
function extractSlsaV02(predicate) {
  const inv = (predicate && predicate.invocation) || {};
  const cfg = (inv.configSource) || {};
  return {
    slsaVersion: "v0.2",
    buildType: predicate.buildType || null,
    repository: stripGitUri(cfg.uri) || null,
    ref: refFromGitUri(cfg.uri) || null,
    commitSha: cfg.digest ? cfg.digest.sha1 || cfg.digest.gitCommit || null : null,
    workflowPath: cfg.entryPoint || null,
    builderId: (predicate.builder && predicate.builder.id) || null,
    invocationId: null
  };
}

// `git+https://github.com/owner/repo@refs/heads/main` → `https://github.com/owner/repo`
function stripGitUri(uri) {
  if (typeof uri !== "string") return null;
  const noPrefix = uri.replace(/^git\+/, "");
  const atIdx = noPrefix.lastIndexOf("@");
  // Keep the protocol://host/path part, drop @ref suffix if present
  const protoEnd = noPrefix.indexOf("://");
  if (protoEnd !== -1 && atIdx > protoEnd) {
    return noPrefix.slice(0, atIdx).replace(/\.git$/, "");
  }
  return noPrefix.replace(/\.git$/, "");
}

function refFromGitUri(uri) {
  if (typeof uri !== "string") return null;
  const noPrefix = uri.replace(/^git\+/, "");
  const protoEnd = noPrefix.indexOf("://");
  const atIdx = noPrefix.lastIndexOf("@");
  if (protoEnd !== -1 && atIdx > protoEnd) {
    return noPrefix.slice(atIdx + 1) || null;
  }
  return null;
}

// Parse a single attestation entry. Returns null for non-SLSA-provenance
// attestations (e.g. the npm publish-attestation, which we ignore — it just
// re-states what was published, no build provenance).
function parseAttestation(attestation) {
  if (!attestation || typeof attestation !== "object") return null;
  const bundle = attestation.bundle;
  if (!bundle || typeof bundle !== "object") return null;

  const envelope = bundle.dsseEnvelope;
  const payload = decodePayload(envelope);
  if (!payload || typeof payload !== "object") return null;

  const predicateType = payload.predicateType || attestation.predicateType;
  if (predicateType !== SLSA_V1 && predicateType !== SLSA_V02) return null;

  const predicate = payload.predicate || {};
  const extracted = predicateType === SLSA_V1
    ? extractSlsaV1(predicate)
    : extractSlsaV02(predicate);

  const tlogEntries = (bundle.verificationMaterial && bundle.verificationMaterial.tlogEntries) || [];
  const hasTlog = Array.isArray(tlogEntries) && tlogEntries.length > 0;
  const subjects = Array.isArray(payload.subject)
    ? payload.subject.map((s) => s && s.name).filter(Boolean)
    : [];

  return {
    predicateType,
    subjects,
    // Raw subject digests so a caller can bind the claim to the artifact it
    // actually downloaded via verifySubjectDigest(). Presence of a tlog entry
    // is NOT verification — we never check the inclusion proof.
    subjectDigests: extractSubjectDigests(payload),
    // Explicit: this field is parsed, not cryptographically verified. `true`
    // here means "SLSA-shaped provenance was parseable", never "signature ok".
    cryptographicallyVerified: false,
    hasTlogEntry: hasTlog,
    tlogEntryCount: tlogEntries.length,
    mediaType: bundle.mediaType || null,
    ...extracted
  };
}

// Fetch + parse provenance for one (name, version). Returns a normalised
// shape that the auditor can consume directly. Never throws — every failure
// mode is surfaced via `attested:false` + a reason.
async function fetchProvenanceAttestation(name, version, options = {}) {
  if (!name || !version) {
    return { attested: false, reason: "missing-identity" };
  }

  if (options.useCache !== false) {
    const cached = await readCache(name, version);
    if (cached) {
      return { ...cached, fromCache: true };
    }
  }

  const url = `${REGISTRY_BASE}/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
  let raw;
  try {
    raw = await fetchJson(url);
  } catch (error) {
    if (error.statusCode === 404) {
      const result = { attested: false, reason: "no-attestation", checkedAt: new Date().toISOString() };
      await writeCache(name, version, result);
      return result;
    }
    // Network / timeout / parse error — don't cache (transient).
    return { attested: false, reason: "fetch-error", message: error.message };
  }

  const attestations = Array.isArray(raw && raw.attestations) ? raw.attestations : [];
  if (attestations.length === 0) {
    const result = { attested: false, reason: "no-attestation", checkedAt: new Date().toISOString() };
    await writeCache(name, version, result);
    return result;
  }

  const provenance = [];
  for (const att of attestations) {
    const parsed = parseAttestation(att);
    if (parsed) provenance.push(parsed);
  }

  if (provenance.length === 0) {
    // Has attestations (e.g. npm's own publish-attestation) but no SLSA
    // provenance — still useful, but we can't surface build-provenance signal.
    const result = {
      attested: false,
      reason: "no-slsa-provenance",
      attestationCount: attestations.length,
      checkedAt: new Date().toISOString()
    };
    await writeCache(name, version, result);
    return result;
  }

  // Prefer the most specific provenance (v1 over v0.2) when both are present.
  // npm packages typically have exactly one SLSA attestation per version, so
  // this just picks the right one in the rare case both exist.
  provenance.sort((a, b) => {
    if (a.slsaVersion === b.slsaVersion) return 0;
    return a.slsaVersion === "v1" ? -1 : 1;
  });
  const primary = provenance[0];

  const result = {
    attested: true,
    primary,
    all: provenance,
    attestationCount: attestations.length,
    checkedAt: new Date().toISOString()
  };
  await writeCache(name, version, result);
  return result;
}

// Helper for the auditor: given a parsed primary provenance + the
// package.json's declared repository URL, decide whether they agree.
// Returns one of: "match" | "mismatch" | "unknown" (one side missing).
function compareProvenanceToRepository(primary, declaredRepository) {
  const provenanceKey = primary && canonicalGithubKey(primary.repository);
  const declaredKey = declaredRepository && canonicalGithubKey(
    typeof declaredRepository === "string" ? declaredRepository : declaredRepository.url
  );
  if (!provenanceKey || !declaredKey) return "unknown";
  return provenanceKey === declaredKey ? "match" : "mismatch";
}

module.exports = {
  fetchProvenanceAttestation,
  parseAttestation,
  compareProvenanceToRepository,
  canonicalGithubKey,
  verifySubjectDigest,
  // exported for tests
  _internal: {
    decodePayload,
    parseGithubUrl,
    extractSlsaV1,
    extractSlsaV02,
    extractSubjectDigests,
    stripGitUri,
    refFromGitUri,
    MAX_DECODED_PAYLOAD_BYTES,
    CACHE_DIR
  }
};
