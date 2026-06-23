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
// We do NOT cryptographically verify the sigstore signature — that's a full
// sigstore client (Fulcio chain, Rekor log inclusion proof, certificate
// transparency, etc.) which would be ~hundreds of KB of dependency weight
// against a "zero-dep" goal. npm verified the signature when it accepted
// the attestation at publish time; we trust npm's verification and parse
// what the bundle claims.
//
// Cache: ~/.cache/pkgxray/attestations/<name>@<version>.json, 24h TTL. We
// cache 404s too (most packages don't have attestations — caching the
// negative result means we don't re-hit npm on every audit).

const fs = require("node:fs/promises");
const fssync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");

const USER_AGENT = "pkgxray/0.10.0";
const CACHE_DIR = path.join(os.homedir(), ".cache", "pkgxray", "attestations");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 4000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // attestations are JSON, ~10-50KB each
const REGISTRY_BASE = "https://registry.npmjs.org/-/npm/v1/attestations";

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
        timeout: FETCH_TIMEOUT_MS
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
function decodePayload(envelope) {
  if (!envelope || typeof envelope.payload !== "string") return null;
  try {
    const decoded = Buffer.from(envelope.payload, "base64").toString("utf8");
    return JSON.parse(decoded);
  } catch {
    return null;
  }
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
  // exported for tests
  _internal: {
    decodePayload,
    parseGithubUrl,
    extractSlsaV1,
    extractSlsaV02,
    stripGitUri,
    refFromGitUri,
    CACHE_DIR
  }
};
