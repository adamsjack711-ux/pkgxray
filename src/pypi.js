"use strict";

const https = require("node:https");
const { normalizePypiName } = require("./lockfile");

// ---------------------------------------------------------------------------
// PyPI registry client — the acquisition layer for the Python ecosystem, the
// counterpart to src/registry.js (npm packument) and the npm-registry bits of
// quarantine.js. Dependency-free: raw https against the PyPI JSON API.
//
//   - existence:  GET /pypi/<name>/json -> 404 means the package is NOT
//                 published. That 404 is the hallucinated / slopsquat signal
//                 — a lockfile pinning a name PyPI never served is the whole
//                 reason a supply-chain auditor exists.
//   - versions:   the `releases` map keys; latest = info.version.
//   - metadata:   info + ownership + release files, normalized by
//                 `pypiMetadataForEvidence` into the SAME shape
//                 `npmMetadataForEvidence` produces, so the heuristic engine
//                 (maintainer surface, deprecation, github cross-check) reuses
//                 unchanged.
//
// The actual download / extraction / host-allowlisting lives in quarantine.js
// (resolvePyPIPackage) — kept there so this module stays free of a require
// cycle with quarantine. This module only speaks to the registry.
// ---------------------------------------------------------------------------

const PYPI_BASE = "https://pypi.org";
const REGISTRY_AGENT = new https.Agent({ keepAlive: true, maxSockets: 8 });

// Raw GET returning { statusCode, body } without throwing on non-2xx, so
// existence checks can branch on 404 rather than catch an error.
function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "user-agent": "pkgxray", accept: "application/json", ...headers }, agent: REGISTRY_AGENT }, (res) => {
        const statusCode = res.statusCode;
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ statusCode, body }));
      })
      .on("error", reject);
  });
}

async function fetchJson(url, headers) {
  const { statusCode, body } = await httpGet(url, headers);
  if (statusCode < 200 || statusCode >= 300) {
    const err = new Error(`HTTP ${statusCode} from ${url}`);
    err.statusCode = statusCode;
    throw err;
  }
  return JSON.parse(body);
}

// Parse a `pypi:` guard specifier: `requests`, `requests@2.31.0`, or the pip
// `requests==2.31.0` form. Version is null when unpinned (resolve to latest).
function parsePypiSpecifier(specifier) {
  const s = String(specifier).trim();
  const eq = s.indexOf("==");
  if (eq > 0) return { name: normalizePypiName(s.slice(0, eq)), version: s.slice(eq + 2).trim() || null };
  const at = s.lastIndexOf("@");
  if (at > 0) return { name: normalizePypiName(s.slice(0, at)), version: s.slice(at + 1).trim() || null };
  return { name: normalizePypiName(s), version: null };
}

// True if published on PyPI, false on a definitive 404. Network / non-404
// errors propagate so a caller reports "unknown" rather than "does not exist".
async function pypiPackageExists(name) {
  const { statusCode } = await httpGet(`${PYPI_BASE}/pypi/${encodeURIComponent(normalizePypiName(name))}/json`);
  if (statusCode === 404) return false;
  if (statusCode >= 200 && statusCode < 300) return true;
  const err = new Error(`HTTP ${statusCode} checking existence of ${name}`);
  err.statusCode = statusCode;
  throw err;
}

// Full package metadata (all versions). Throws with .statusCode on 404.
async function fetchPypiMetadata(name, version) {
  const encoded = encodeURIComponent(normalizePypiName(name));
  const url = version
    ? `${PYPI_BASE}/pypi/${encoded}/${encodeURIComponent(version)}/json`
    : `${PYPI_BASE}/pypi/${encoded}/json`;
  return fetchJson(url);
}

// { versions: string[], latest: string|null } — parallels registry.js
// listNpmVersions. `latest` comes from info.version (authoritative), NOT from
// releases-key order (PyPI does not guarantee the map is version-sorted).
async function listPypiVersions(name) {
  const json = await fetchPypiMetadata(name);
  const versions = json && json.releases ? Object.keys(json.releases) : [];
  const latest = json && json.info && typeof json.info.version === "string" ? json.info.version : null;
  return { versions, latest };
}

// ---------------------------------------------------------------------------
// Evidence shaping — map PyPI's metadata onto the exact shape the auditor's
// heuristics consume (same as npmMetadataForEvidence):
//   { name, version, repository, maintainers, dist, deprecated }
// ---------------------------------------------------------------------------

const REPO_HOST_RE = /github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|sr\.ht/i;

// Find a source-repository URL from project_urls / home_page so the GitHub
// reputation + npm-vs-source cross-checks have something to work with. Prefers
// a link explicitly labelled source/repository/code over a bare homepage.
function extractRepository(info) {
  const urls = (info && info.project_urls) || {};
  for (const [label, url] of Object.entries(urls)) {
    if (typeof url === "string" && /source|repo|code|git|tracker/i.test(label) && REPO_HOST_RE.test(url)) {
      return { url, type: "git" };
    }
  }
  for (const url of Object.values(urls)) {
    if (typeof url === "string" && REPO_HOST_RE.test(url)) return { url, type: "git" };
  }
  if (info && typeof info.home_page === "string" && REPO_HOST_RE.test(info.home_page)) {
    return { url: info.home_page, type: "git" };
  }
  return null;
}

// Maintainer accounts. PyPI's `ownership.roles` (a newer field) names the
// actual owner/maintainer usernames — the closest analog to npm's maintainers
// array. Falls back to the free-text maintainer/author fields (often null).
function extractMaintainers(json) {
  const roles = json && json.ownership && Array.isArray(json.ownership.roles) ? json.ownership.roles : [];
  if (roles.length) {
    return roles
      .filter((r) => r && r.user)
      .map((r) => ({ name: r.user, role: r.role || null }));
  }
  const info = (json && json.info) || {};
  if (info.maintainer) return [{ name: info.maintainer, email: info.maintainer_email || null }];
  if (info.author) return [{ name: info.author, email: info.author_email || null }];
  return [];
}

function pypiMetadataForEvidence(json) {
  const info = (json && json.info) || {};
  return {
    name: info.name || null,
    version: info.version || null,
    repository: extractRepository(info),
    maintainers: extractMaintainers(json),
    dist: null, // PyPI has no npm-style dist object; provenance is deferred to v2
    // A yanked release is PyPI's equivalent of npm's `deprecated` — surface the
    // reason so inspectMetadataObject flags it.
    deprecated: info.yanked ? (info.yanked_reason || "yanked") : null
  };
}

// ---------------------------------------------------------------------------
// Release-file selection — choose which artifact to download for source
// inspection. Prefer the sdist (a .tar.gz of the actual source, including
// setup.py — the exec surface) over a wheel (a zip of built files). Returns
// null when the version has no usable, un-yanked file with a sha256 digest.
// ---------------------------------------------------------------------------

function releaseFileForVersion(json, version) {
  const releases = (json && json.releases) || {};
  // `version` may be omitted when the caller fetched the single-version
  // endpoint, which puts the files in top-level `urls`.
  let files = version && releases[version] ? releases[version] : json && json.urls;
  if (!Array.isArray(files)) files = [];
  const usable = files.filter((f) => f && !f.yanked && f.url && f.digests && f.digests.sha256);
  if (usable.length === 0) return null;
  const chosen =
    usable.find((f) => f.packagetype === "sdist") ||
    usable.find((f) => f.packagetype === "bdist_wheel") ||
    usable[0];
  return {
    url: chosen.url,
    filename: chosen.filename,
    packagetype: chosen.packagetype,
    sha256: chosen.digests.sha256,
    size: typeof chosen.size === "number" ? chosen.size : null,
    uploadTime: chosen.upload_time_iso_8601 || chosen.upload_time || null
  };
}

// Convert PyPI's hex sha256 into an npm SRI integrity string ("sha256-<b64>")
// so quarantine's existing verifyNpmTarballIntegrity path can verify a PyPI
// download with no new hashing code.
function sha256ToSri(hex) {
  return "sha256-" + Buffer.from(String(hex), "hex").toString("base64");
}

module.exports = {
  PYPI_BASE,
  parsePypiSpecifier,
  pypiPackageExists,
  fetchPypiMetadata,
  listPypiVersions,
  pypiMetadataForEvidence,
  extractRepository,
  extractMaintainers,
  releaseFileForVersion,
  sha256ToSri
};
