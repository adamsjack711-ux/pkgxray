"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const cacheClient = require("./cache-client");

const USER_AGENT = "pkgxray/0.6.0";
const CACHE_DIR = path.join(os.homedir(), ".cache", "pkgxray", "github");
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 3000;

// Module-local keep-alive agent for api.github.com + codeload.github.com.
// In lockfile-mode + --deep we hit api.github.com many times in a row for
// repo metadata; the first call pays the TLS handshake, subsequent ones
// reuse the socket. Single-package guard runs see one or two API calls so
// the agent mostly pays off in the lockfile path.
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 10 });

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

function githubApiGet(urlPath, token, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 3) return reject(new Error("Too many GitHub redirects"));
    const headers = {
      "user-agent": USER_AGENT,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28"
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const request = https.get(
      { hostname: "api.github.com", path: urlPath, headers, timeout: FETCH_TIMEOUT_MS, agent: HTTPS_AGENT },
      (response) => {
        // Follow GitHub's 301 redirects (repo transferred / renamed)
        if ([301, 302, 307, 308].includes(response.statusCode) && response.headers.location) {
          response.resume();
          const nextUrl = new URL(response.headers.location, `https://api.github.com${urlPath}`);
          return githubApiGet(nextUrl.pathname + nextUrl.search, token, hops + 1).then(resolve, reject);
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode === 404) {
            const error = new Error(`GitHub 404: ${urlPath}`);
            error.statusCode = 404;
            return reject(error);
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            return reject(new Error(`GitHub HTTP ${response.statusCode}: ${body.slice(0, 120)}`));
          }
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
      request.destroy(new Error("GitHub request timed out"));
    });
  });
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
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination, { mode: 0o600 });
    let written = 0;
    let cleanedUp = false;
    const cleanup = (err) => {
      if (cleanedUp) return;
      cleanedUp = true;
      file.destroy();
      fs.unlink(destination, () => reject(err));
    };
    const get = (currentUrl, hops) => {
      if (hops > 5) return cleanup(new Error("Too many redirects"));
      const parsed = new URL(currentUrl);
      const request = https.get(
        {
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          headers: { "user-agent": USER_AGENT },
          timeout: TARBALL_TIMEOUT_MS,
          agent: HTTPS_AGENT
        },
        (response) => {
          if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
            response.resume();
            return get(new URL(response.headers.location, currentUrl).toString(), hops + 1);
          }
          if (response.statusCode === 404) {
            response.resume();
            const err = new Error(`GitHub codeload 404: ${currentUrl}`);
            err.statusCode = 404;
            return cleanup(err);
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            response.resume();
            return cleanup(new Error(`Codeload HTTP ${response.statusCode}`));
          }
          response.on("data", (chunk) => {
            written += chunk.length;
            if (written > MAX_TARBALL_BYTES) {
              response.destroy();
              cleanup(new Error(`Codeload exceeded ${MAX_TARBALL_BYTES} bytes`));
            }
          });
          response.pipe(file);
          file.on("finish", () => file.close(() => resolve()));
        }
      );
      request.on("error", cleanup);
      request.on("timeout", () => request.destroy(new Error("Codeload request timed out")));
    };
    get(url, 0);
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`));
    });
  });
}

function runCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`));
    });
  });
}

async function extractTarball(archivePath, destination) {
  await fsp.mkdir(destination, { recursive: true, mode: 0o700 });
  return run("tar", [
    "-xzf", archivePath,
    "-C", destination,
    "--strip-components", "1",
    "--no-same-owner", "--no-same-permissions"
  ]);
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
  const lines = listing.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) {
    return { prefix: null, entries: new Set(), fileEntries: new Set(), dirEntries: new Set() };
  }

  // GitHub codeload tarballs always wrap everything under one top-level dir
  // like "microsoft-TypeScript-abc123def/". Use the first entry's first
  // segment as the prefix.
  const firstSlash = lines[0].indexOf("/");
  const prefix = firstSlash > 0 ? lines[0].slice(0, firstSlash + 1) : null;

  const entries = new Set();
  const fileEntries = new Set();
  const dirEntries = new Set();
  for (const raw of lines) {
    // Reject anything that doesn't sit under the detected prefix — defensive
    // against odd archives mixing roots.
    if (prefix && !raw.startsWith(prefix)) continue;
    const stripped = prefix ? raw.slice(prefix.length) : raw;
    if (stripped.length === 0) continue;
    // Reject path-traversal — same checks the main extractor does.
    if (stripped.startsWith("/") || stripped.split("/").includes("..")) continue;
    const isDir = stripped.endsWith("/");
    const cleanPath = isDir ? stripped.slice(0, -1) : stripped;
    if (cleanPath.length === 0) continue;
    entries.add(cleanPath);
    if (isDir) {
      dirEntries.add(cleanPath);
    } else {
      fileEntries.add(cleanPath);
      // Add every parent dir of this file — some tarballs omit explicit dir
      // entries and we still need a complete parent-dir set for the
      // "parent-exists" check downstream.
      const parts = cleanPath.split("/");
      for (let i = 1; i < parts.length; i++) {
        dirEntries.add(parts.slice(0, i).join("/"));
      }
    }
  }
  return { prefix, entries, fileEntries, dirEntries };
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

  const baseArgs = [
    "-xzf", archivePath,
    "-C", destination,
    "--strip-components", "1",
    "--no-same-owner", "--no-same-permissions"
  ];

  if (archivePaths.length <= TAR_ARGV_PATH_LIMIT) {
    return run("tar", baseArgs.concat(archivePaths));
  }

  // Larger sets: write the path list to a file and use `tar -T`. Works on
  // both macOS bsdtar and GNU tar.
  const listFile = path.join(destination, ".pkgxray-extract-list");
  await fsp.writeFile(listFile, archivePaths.join("\n") + "\n", { mode: 0o600 });
  try {
    return await run("tar", baseArgs.concat(["-T", listFile]));
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
    try {
      if (useTeamCache) {
        await downloadFromCacheServer(owner, repo, ref, cachePath);
      } else {
        const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(ref)}`;
        await downloadCodeload(url, cachePath);
      }
      return { ref, archivePath: cachePath, fromCache: false };
    } catch (error) {
      if (error.statusCode === 404) continue;
      throw error;
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
  extractTarballSubset
};
