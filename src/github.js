"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const cacheClient = require("./cache-client");

const USER_AGENT = `pkgxray/${require("../package.json").version}`;
const CACHE_DIR = path.join(os.homedir(), ".cache", "pkgxray", "github");
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 3000;
// Ceiling on a GitHub JSON response body. Repo metadata is a few KB; a
// compromised cache / MITM serving a multi-GB JSON body would otherwise OOM
// the process as we accumulate `body +=`. 8MB is generous headroom.
const MAX_JSON_BYTES = 8 * 1024 * 1024;

// ---- SSRF guard (finding 1) ----
//
// A 3xx Location header is attacker-influenceable (a compromised cache, a
// hostile mirror, or GitHub itself if MITM'd). Following it blindly lets an
// on-path actor redirect a codeload download to `http://169.254.169.254/…`
// (cloud metadata), an internal service, or an http:// downgrade. We re-check
// every redirect hop using the shared origin/address policy. The lookup handed
// to the socket validates the actual DNS answers, not just hostname text.
//
// Node's WHATWG URL parser normalizes hex/octal/decimal IPv4 to dotted-quad,
// so numeric-host evasions (`http://0x08080808/`) are caught by these checks.
const { isPrivateOrLocalHost, createUpstreamPolicy } = require("./cache-upstream-policy");

// Throw if `parsed` (a URL) is not a safe redirect/download target: reject any
// non-https scheme (blocks http:// downgrade) and any private/loopback/
// link-local/metadata host.
function assertSafeRedirectTarget(parsed, context) {
  if (parsed.protocol !== "https:") {
    throw new Error(`Refusing non-https redirect (${parsed.protocol}//${parsed.host}) for ${context} (SSRF guard)`);
  }
  if (isPrivateOrLocalHost(parsed.hostname)) {
    throw new Error(`Refusing redirect to private/loopback address ${parsed.host} for ${context} (SSRF guard)`);
  }
}

async function readCache(key) {
  try {
    const file = path.join(CACHE_DIR, `${encodeURIComponent(key)}.json`);
    const stat = await fsp.stat(file);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function writeCache(key, value) {
  try {
    await fsp.mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
    const file = path.join(CACHE_DIR, `${encodeURIComponent(key)}.json`);
    await fsp.writeFile(file, JSON.stringify(value), { mode: 0o600 });
  } catch {
    // best-effort cache; never fail the audit because of a cache write
  }
}

// Pull owner/repo from common repository.url shapes:
//   git+https://github.com/owner/repo.git
//   https://github.com/owner/repo
//   git@github.com:owner/repo.git
//   github:owner/repo
//   git+ssh://git@github.com/owner/repo.git
function parseGithubRepo(repository) {
  if (!repository) return null;
  const url = typeof repository === "string" ? repository : repository.url;
  if (!url || typeof url !== "string") return null;
  const cleaned = url.replace(/^git\+/, "").replace(/\.git$/, "");
  const patterns = [
    /^github:([^/]+)\/(.+)$/,
    /^(?:https?|git):\/\/github\.com\/([^/]+)\/([^/?#]+)/,
    /^git@github\.com:([^/]+)\/([^/?#]+)/,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/?#]+)/,
    // npm shorthand: bare "owner/repo" defaults to GitHub
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/
  ];
  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match) {
      return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
    }
  }
  return null;
}

// Use GITHUB_TOKEN if the user has set it (5000 req/hr). Otherwise fall back
// to unauthenticated calls (60 req/hr — fine for occasional use). We
// deliberately do NOT shell out to `gh auth token` — that adds ~150ms on
// cold runs and speed is a goal.
function loadToken() {
  return process.env.GITHUB_TOKEN || process.env.PKGXRAY_GITHUB_TOKEN || null;
}

async function githubApiGet(urlPath, token) {
  const validate = createUpstreamPolicy("https://api.github.com");
  const deadline = Date.now() + FETCH_TIMEOUT_MS;
  let url = new URL(urlPath, "https://api.github.com");
  const headers = { "user-agent": USER_AGENT, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  if (token) headers.authorization = `Bearer ${token}`;
  for (let hop = 0; hop <= 3; hop++) {
    const checked = validate(url);
    const response = await require("./http-client").requestText(checked.url, {
      headers, lookup: checked.lookup, agent: false, timeoutMs: FETCH_TIMEOUT_MS, deadline, maxBytes: MAX_JSON_BYTES
    });
    if ([301, 302, 307, 308].includes(response.statusCode) && response.headers?.location) {
      url = new URL(response.headers.location, url);
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const error = new Error(`GitHub HTTP ${response.statusCode}`);
      error.statusCode = response.statusCode; throw error;
    }
    return JSON.parse(response.body);
  }
  throw new Error("Too many GitHub redirects");
}

function reshapeRepo(parsed, repo) {
  return {
    found: true,
    owner: parsed.owner,
    repo: parsed.repo,
    full_name: repo.full_name,
    description: repo.description,
    archived: Boolean(repo.archived),
    disabled: Boolean(repo.disabled),
    fork: Boolean(repo.fork),
    stars: repo.stargazers_count || 0,
    forks: repo.forks_count || 0,
    open_issues: repo.open_issues_count || 0,
    watchers: repo.watchers_count || 0,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    default_branch: repo.default_branch,
    html_url: repo.html_url,
    license: repo.license && repo.license.spdx_id,
    owner_type: repo.owner && repo.owner.type
  };
}

async function fetchRepoMetadata(repository, options = {}) {
  const parsed = parseGithubRepo(repository);
  if (!parsed) return { found: false, reason: "not-github" };

  const cacheKey = `${parsed.owner}/${parsed.repo}`;
  if (options.useCache !== false) {
    const cached = await readCache(cacheKey);
    if (cached) return { ...cached, fromCache: true };
  }

  const token = options.token === undefined ? loadToken() : options.token;

  try {
    // Route through the team cache server when configured. Falls through to a
    // direct GitHub call only when PKGXRAY_CACHE_URL is unset, so the default
    // path stays at zero overhead.
    const repo = cacheClient.isEnabled()
      ? await cacheClient.getRepoJson(parsed.owner, parsed.repo, { token })
      : await githubApiGet(`/repos/${parsed.owner}/${parsed.repo}`, token);
    const result = reshapeRepo(parsed, repo);
    await writeCache(cacheKey, result);
    return result;
  } catch (error) {
    if (error.statusCode === 404) {
      const result = { found: false, reason: "not-found", owner: parsed.owner, repo: parsed.repo };
      await writeCache(cacheKey, result);
      return result;
    }
    // Don't cache transient errors — next call should retry.
    return { found: false, reason: "fetch-error", message: error.message, owner: parsed.owner, repo: parsed.repo };
  }
}

// ---- Tarball download + ref resolution ----

const TARBALL_CACHE_DIR = path.join(os.homedir(), ".cache", "pkgxray", "tarballs");
const TARBALL_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const TARBALL_TIMEOUT_MS = 15000;
const MAX_TARBALL_BYTES = 100 * 1024 * 1024; // 100MB

function tarballCachePath(owner, repo, ref) {
  const key = crypto
    .createHash("sha1")
    .update(`${owner}/${repo}@${ref}`)
    .digest("hex");
  return path.join(TARBALL_CACHE_DIR, `${key}.tgz`);
}

async function downloadCodeload(url, destination) {
  assertSafeRedirectTarget(new URL(url), "codeload download");
  const validate = createUpstreamPolicy("https://codeload.github.com", { codeload: true });
  return require("./http-client").downloadFile(url, destination, {
    validate, headers: { "user-agent": USER_AGENT }, timeoutMs: TARBALL_TIMEOUT_MS, maxBytes: MAX_TARBALL_BYTES
  });
}

function run(command, args, options = {}) {
  return require("./bounded-process").runCapture(command, args, { spawnOptions: options });
}

function runCapture(command, args, options) {
  return require("./bounded-process").runCapture(command, args, options);
}

async function extractTarball(archivePath, destination) {
  await fsp.mkdir(destination, { recursive: true, mode: 0o700 });
  return require("./quarantine").extractTarball(archivePath, destination);
}

// Cap on how many paths we'll pass on the command line before falling back to
// a `-T file` listing. macOS ARG_MAX is ~256KB; we leave a wide margin since
// some github paths are long (TypeScript has src/compiler/transformers/...).
const TAR_ARGV_PATH_LIMIT = 400;

// List entries in the tarball without unpacking. Cheap — `tar -tzf` reads the
// archive headers but doesn't write any files to disk.
//
// Returns:
//   prefix         — the leading "github-owner-repo-sha/" segment (or null if
//                    the archive has no common prefix — codeload always uses
//                    one, but we tolerate odd archives).
//   entries        — Set of every path inside the archive (prefix stripped).
//   fileEntries    — Set of file paths inside the archive (prefix stripped,
//                    no trailing slash).
//   dirEntries     — Set of directory paths inside the archive (prefix
//                    stripped, no trailing slash) — including parents of
//                    every file even when the archive doesn't emit explicit
//                    directory entries.
async function listTarballEntries(archivePath) {
  const listing = await runCapture("tar", ["-tzf", archivePath]);
  if (listing.length === 0) {
    return { prefix: null, entries: new Set(), fileEntries: new Set(), dirEntries: new Set() };
  }

  // Detect the codeload-style top-level prefix from the first non-empty line.
  // Avoids materialising the whole `lines` array up front.
  const firstNl = listing.indexOf("\n");
  const firstLine = firstNl === -1 ? listing : listing.slice(0, firstNl);
  const firstSlash = firstLine.indexOf("/");
  const prefix = firstSlash > 0 ? firstLine.slice(0, firstSlash + 1) : null;
  const prefixLen = prefix ? prefix.length : 0;

  const entries = new Set();
  const fileEntries = new Set();
  const dirEntries = new Set();

  // Scan the listing string in place. For typescript this is ~10k lines —
  // skipping the intermediate split() saves a 10k-entry array allocation
  // and matching GC pressure.
  let i = 0;
  const len = listing.length;
  while (i < len) {
    const nl = listing.indexOf("\n", i);
    const lineEnd = nl === -1 ? len : nl;
    if (lineEnd === i) {
      i = lineEnd + 1;
      continue;
    }
    // Reject anything that doesn't sit under the detected prefix — defensive
    // against odd archives mixing roots.
    if (prefix && (listing.charCodeAt(i) !== prefix.charCodeAt(0) || !listing.startsWith(prefix, i))) {
      i = lineEnd + 1;
      continue;
    }
    const strippedStart = i + prefixLen;
    if (strippedStart >= lineEnd) {
      i = lineEnd + 1;
      continue;
    }
    // Reject path-traversal — same checks the main extractor does.
    if (listing.charCodeAt(strippedStart) === 0x2f /* "/" */) {
      i = lineEnd + 1;
      continue;
    }
    // Check for "/.." or "../" segments without splitting the string.
    if (hasParentSegment(listing, strippedStart, lineEnd)) {
      i = lineEnd + 1;
      continue;
    }
    const isDir = listing.charCodeAt(lineEnd - 1) === 0x2f /* "/" */;
    const cleanEnd = isDir ? lineEnd - 1 : lineEnd;
    if (cleanEnd <= strippedStart) {
      i = lineEnd + 1;
      continue;
    }
    const cleanPath = listing.slice(strippedStart, cleanEnd);
    entries.add(cleanPath);
    if (isDir) {
      dirEntries.add(cleanPath);
    } else {
      fileEntries.add(cleanPath);
      // Add every parent dir of this file without split/slice/join. Walk
      // forward through the path and emit each prefix ending at a "/".
      let slash = cleanPath.indexOf("/");
      while (slash !== -1) {
        dirEntries.add(cleanPath.slice(0, slash));
        slash = cleanPath.indexOf("/", slash + 1);
      }
    }
    i = lineEnd + 1;
  }
  return { prefix, entries, fileEntries, dirEntries };
}

// Returns true if any segment between `start` and `end` (within `s`) is "..".
function hasParentSegment(s, start, end) {
  let segStart = start;
  for (let j = start; j < end; j++) {
    if (s.charCodeAt(j) === 0x2f /* "/" */) {
      if (j - segStart === 2 && s.charCodeAt(segStart) === 0x2e && s.charCodeAt(segStart + 1) === 0x2e) {
        return true;
      }
      segStart = j + 1;
    }
  }
  if (end - segStart === 2 && s.charCodeAt(segStart) === 0x2e && s.charCodeAt(segStart + 1) === 0x2e) {
    return true;
  }
  return false;
}

// Extract a specific subset of files from `archivePath` into `destination`,
// with `--strip-components 1` so the codeload prefix is removed. `archivePaths`
// is the list of paths INSIDE the tarball (with prefix still attached).
//
// Falls back to `-T file` when the argv would get unwieldy.
async function extractTarballSubset(archivePath, destination, archivePaths) {
  await fsp.mkdir(destination, { recursive: true, mode: 0o700 });
  if (archivePaths.length === 0) {
    // Nothing to extract — leave destination empty. Caller still gets an
    // empty tree which is correctly "no overlap" downstream.
    return;
  }
  const quarantine = require("./quarantine");
  const listing = await runCapture("tar", ["-tvzf", archivePath], { maxLines: 20000 });
  quarantine.validateTarListing(listing.split("\n").filter(line => line.trim()), 256 * 1024 * 1024, 20000);

  const baseArgs = [
    "-xzf", archivePath,
    "-C", destination,
    "--strip-components", "1",
    "--no-same-owner", "--no-same-permissions"
  ];

  if (archivePaths.length <= TAR_ARGV_PATH_LIMIT) {
    await run("tar", baseArgs.concat(["--", ...archivePaths]));
    await quarantine.normalizeTreePermissions(destination);
    return quarantine.validateExtractedTree(destination);
  }

  // Larger sets: write the path list to a file and use `tar -T`. Works on
  // both macOS bsdtar and GNU tar.
  const listFile = path.join(destination, ".pkgxray-extract-list");
  await fsp.writeFile(listFile, archivePaths.join("\n") + "\n", { mode: 0o600 });
  try {
    await run("tar", baseArgs.concat(["-T", listFile]));
    await quarantine.normalizeTreePermissions(destination);
    await quarantine.validateExtractedTree(destination);
  } finally {
    await fsp.rm(listFile, { force: true }).catch(() => {});
  }
}

// Streams a tarball from the team cache server straight to disk. Uses the
// same write semantics (mode 0o600, unlink-on-error) as downloadCodeload so
// downstream extraction code does not need to know which source served it.
function downloadFromCacheServer(owner, repo, ref, destination) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination, { mode: 0o600 });
    let cleanedUp = false;
    const cleanup = (err) => {
      if (cleanedUp) return;
      cleanedUp = true;
      file.destroy();
      fs.unlink(destination, () => reject(err));
    };
    file.on("error", cleanup);
    cacheClient
      .streamTarball(owner, repo, ref, file, { timeoutMs: TARBALL_TIMEOUT_MS })
      .then(() => file.close(() => resolve()))
      .catch(cleanup);
  });
}

// Try refs in order until one downloads. Caches the first successful one.
async function fetchRepoTarballForVersion(owner, repo, version, defaultBranch) {
  await fsp.mkdir(TARBALL_CACHE_DIR, { recursive: true, mode: 0o700 });
  const candidates = [];
  if (version) {
    candidates.push(`v${version}`);
    candidates.push(version);
  }
  if (defaultBranch) candidates.push(defaultBranch);

  const useTeamCache = cacheClient.isEnabled();

  for (const ref of candidates) {
    const cachePath = tarballCachePath(owner, repo, ref);
    try {
      const stat = await fsp.stat(cachePath);
      if (Date.now() - stat.mtimeMs < TARBALL_TTL_MS) {
        return { ref, archivePath: cachePath, fromCache: true };
      }
    } catch {
      // not cached, fall through to download
    }
    const downloadDir = await fsp.mkdtemp(path.join(TARBALL_CACHE_DIR, ".download-"));
    const downloadPath = path.join(downloadDir, "archive.tgz");
    try {
      if (useTeamCache) {
        await downloadFromCacheServer(owner, repo, ref, downloadPath);
      } else {
        const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(ref)}`;
        await downloadCodeload(url, downloadPath);
      }
      await fsp.rename(downloadPath, cachePath);
      return { ref, archivePath: cachePath, fromCache: false };
    } catch (error) {
      if (error.statusCode === 404) continue;
      throw error;
    } finally {
      await fsp.rm(downloadDir, { recursive: true, force: true });
    }
  }
  return null;
}

module.exports = {
  parseGithubRepo,
  fetchRepoMetadata,
  fetchRepoTarballForVersion,
  extractTarball,
  listTarballEntries,
  extractTarballSubset,
  // exported for tests
  _internal: {
    isPrivateOrLocalHost,
    assertSafeRedirectTarget,
    downloadCodeload,
    MAX_JSON_BYTES
  }
};
