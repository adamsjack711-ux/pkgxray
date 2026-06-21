"use strict";

const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");

const USER_AGENT = "pkgxray/0.6.0";
const CACHE_DIR = path.join(os.homedir(), ".cache", "pkgxray", "github");
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 3000;

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
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/?#]+)/
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
      { hostname: "api.github.com", path: urlPath, headers, timeout: FETCH_TIMEOUT_MS },
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
    const repo = await githubApiGet(`/repos/${parsed.owner}/${parsed.repo}`, token);
    const result = {
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

module.exports = {
  parseGithubRepo,
  fetchRepoMetadata
};
