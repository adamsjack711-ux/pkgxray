"use strict";

// Thin client for an optional self-hosted pkgxray cache server.
//
// When PKGXRAY_CACHE_URL is set, github.js routes its upstream HTTP calls
// through `${PKGXRAY_CACHE_URL}/github/...` instead of api.github.com /
// codeload.github.com. The cache server has the same on-disk layout as the
// local ~/.cache/pkgxray cache, just shared across a team's CI runners.
//
// When the env var is NOT set, this module is essentially inert — github.js
// short-circuits the cache path before any of these functions get called.
// That keeps the default path zero-cost (no extra hop, no extra parsing).

const http = require("node:http");
const https = require("node:https");

const USER_AGENT = "pkgxray-cache-client/0.10.0";

function rawCacheUrl() {
  const raw = process.env.PKGXRAY_CACHE_URL;
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed || null;
}

function isLoopbackHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1" || h.endsWith(".localhost");
}

// Plain http is acceptable ONLY for a loopback cache and ONLY with an explicit
// opt-in. A plaintext cache on a real network would (a) leak the forwarded
// GitHub token to anyone on-path and (b) serve unauthenticated poisoned content.
function insecureCacheAllowed(parsed) {
  return process.env.PKGXRAY_CACHE_ALLOW_INSECURE === "1" && isLoopbackHost(parsed.hostname);
}

let insecureCacheWarned = false;
function getCacheUrl() {
  const raw = rawCacheUrl();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null; // malformed -> cache disabled (safe default: direct upstream)
  }
  if (parsed.protocol === "https:") return raw;
  if (parsed.protocol === "http:" && insecureCacheAllowed(parsed)) return raw;
  // Refuse a non-https (or non-loopback http) cache so we never send the GitHub
  // token or trust content over plaintext. Fall back to direct GitHub upstream.
  if (!insecureCacheWarned) {
    insecureCacheWarned = true;
    try {
      process.stderr.write(
        `pkgxray: ignoring PKGXRAY_CACHE_URL=${parsed.protocol}//${parsed.host} — the cache must be https ` +
          `(or loopback http with PKGXRAY_CACHE_ALLOW_INSECURE=1). Falling back to direct upstream.\n`
      );
    } catch {
      /* stderr write must never break a scan */
    }
  }
  return null;
}

function isEnabled() {
  return getCacheUrl() !== null;
}

function pickTransport(parsedUrl) {
  return parsedUrl.protocol === "https:" ? https : http;
}

// Only forward the GitHub token when the connection can't expose it on the wire:
// https to any host, or http to loopback. getCacheUrl() already enforces this,
// so this is defense-in-depth in case a base URL is ever passed in directly.
function tokenSafeToForward(parsedUrl) {
  return parsedUrl.protocol === "https:" || isLoopbackHost(parsedUrl.hostname);
}

// GET <cache-url>/github/repos/<owner>/<repo>  →  JSON body
// Mirrors the shape of `https://api.github.com/repos/<owner>/<repo>` so
// callers can swap the upstream cleanly.
function getRepoJson(owner, repo, options = {}) {
  return new Promise((resolve, reject) => {
    const base = getCacheUrl();
    if (!base) return reject(new Error("PKGXRAY_CACHE_URL not set"));
    const target = new URL(`${base}/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
    const headers = {
      "user-agent": USER_AGENT,
      accept: "application/json"
    };
    if (options.token && tokenSafeToForward(target)) {
      headers["x-pkgxray-github-token"] = options.token;
    }
    const transport = pickTransport(target);
    const request = transport.get(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        headers,
        timeout: options.timeoutMs || 5000
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode === 404) {
            const err = new Error(`cache server 404: ${owner}/${repo}`);
            err.statusCode = 404;
            return reject(err);
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            return reject(new Error(`cache server HTTP ${response.statusCode}: ${body.slice(0, 120)}`));
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
    request.on("timeout", () => request.destroy(new Error("cache server timed out")));
  });
}

// Streams the tarball bytes from <cache-url>/github/tarball/<owner>/<repo>/<ref>
// straight into the supplied writable stream. The caller owns the writable.
// Resolves with `{ statusCode }` when the body is fully flushed.
function streamTarball(owner, repo, ref, writable, options = {}) {
  return new Promise((resolve, reject) => {
    const base = getCacheUrl();
    if (!base) return reject(new Error("PKGXRAY_CACHE_URL not set"));
    const target = new URL(
      `${base}/github/tarball/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}`
    );
    const headers = { "user-agent": USER_AGENT };
    const transport = pickTransport(target);
    const request = transport.get(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        headers,
        timeout: options.timeoutMs || 20000
      },
      (response) => {
        if (response.statusCode === 404) {
          response.resume();
          const err = new Error(`cache server tarball 404: ${owner}/${repo}@${ref}`);
          err.statusCode = 404;
          return reject(err);
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          return reject(new Error(`cache server tarball HTTP ${response.statusCode}`));
        }
        response.pipe(writable);
        writable.on("finish", () => resolve({ statusCode: response.statusCode }));
        writable.on("error", reject);
        response.on("error", reject);
      }
    );
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("cache server tarball timed out")));
  });
}

module.exports = {
  isEnabled,
  getCacheUrl,
  getRepoJson,
  streamTarball
};
