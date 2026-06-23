#!/usr/bin/env node
"use strict";

// Self-hostable pkgxray cache server.
//
// Acts as a transparent caching proxy in front of api.github.com and
// codeload.github.com. The on-disk layout intentionally mirrors the local
// per-user cache used by src/github.js so the same tooling can introspect
// either one.
//
// This is NOT an auth boundary. Run it inside a private network or fronted
// by your own reverse proxy with auth — see README "Self-hostable cache
// server".

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");

const VERSION = "0.10.0";
const USER_AGENT = `pkgxray-cache/${VERSION}`;

const REPO_TTL_MS = 60 * 60 * 1000; // 1h, matches src/github.js
const TARBALL_TTL_MS = 24 * 60 * 60 * 1000; // 24h, matches src/github.js
const UPSTREAM_REPO_TIMEOUT_MS = 8000;
const UPSTREAM_TARBALL_TIMEOUT_MS = 30000;
const MAX_TARBALL_BYTES = 200 * 1024 * 1024; // 200MB ceiling per artifact

function parseArgs(argv) {
  const options = {
    port: 8819,
    cacheDir: path.join(os.homedir(), ".cache", "pkgxray-server"),
    upstreamGithubApi: "https://api.github.com",
    upstreamCodeload: "https://codeload.github.com",
    host: "0.0.0.0"
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") options.port = Number(argv[++i]);
    else if (arg.startsWith("--port=")) options.port = Number(arg.slice("--port=".length));
    else if (arg === "--host") options.host = argv[++i];
    else if (arg.startsWith("--host=")) options.host = arg.slice("--host=".length);
    else if (arg === "--cache-dir") options.cacheDir = argv[++i];
    else if (arg.startsWith("--cache-dir=")) options.cacheDir = arg.slice("--cache-dir=".length);
    else if (arg === "--upstream-github-api") options.upstreamGithubApi = argv[++i];
    else if (arg.startsWith("--upstream-github-api=")) options.upstreamGithubApi = arg.slice("--upstream-github-api=".length);
    else if (arg === "--upstream-codeload") options.upstreamCodeload = argv[++i];
    else if (arg.startsWith("--upstream-codeload=")) options.upstreamCodeload = arg.slice("--upstream-codeload=".length);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  options.upstreamGithubApi = options.upstreamGithubApi.replace(/\/+$/, "");
  options.upstreamCodeload = options.upstreamCodeload.replace(/\/+$/, "");
  if (!Number.isFinite(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error(`Invalid --port value`);
  }
  return options;
}

function printUsage() {
  process.stderr.write(
    [
      "Usage:",
      "  pkgxray-cache [--port 8819] [--host 0.0.0.0] [--cache-dir DIR]",
      "                [--upstream-github-api URL] [--upstream-codeload URL]",
      "",
      "Routes:",
      "  GET /github/repos/{owner}/{repo}        proxy + cache api.github.com (1h TTL)",
      "  GET /github/tarball/{owner}/{repo}/{ref}  proxy + cache codeload tarball (24h TTL)",
      "  GET /healthz                            { ok: true, version }",
      "",
      "Not an auth boundary — run on a private network or behind your own proxy.",
      ""
    ].join("\n")
  );
}

// --- Path safety ---

// A single path segment that could appear as an owner, repo, or ref. We allow
// the GitHub-legal character set plus a handful (`.`, `-`, `_`) that show up
// in tags and branches. Refs may also contain `/` (e.g. `release/v1`), so the
// ref-specific check is looser.
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const SAFE_REF = /^[A-Za-z0-9._\/-]+$/;

function isSafeSegment(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && SAFE_SEGMENT.test(value);
}

function isSafeRef(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 250) return false;
  if (value.includes("..")) return false;
  if (value.startsWith("/") || value.startsWith(".")) return false;
  return SAFE_REF.test(value);
}

// Resolve a path strictly under the cache root. Any attempt to escape via
// .. or absolute paths is rejected.
function joinUnder(root, ...parts) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...parts);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error("path escapes cache root");
  }
  return resolved;
}

// --- Cache directory layout ---

function repoCachePath(cacheDir, owner, repo) {
  return joinUnder(cacheDir, "github", "repos", owner, `${repo}.json`);
}

function tarballCachePath(cacheDir, owner, repo, ref) {
  // Refs may contain slashes; flatten them with a safe separator so the
  // tarball still lives at a single file path.
  const safeRef = ref.replace(/\//g, "__");
  return joinUnder(cacheDir, "github", "tarballs", owner, repo, `${safeRef}.tgz`);
}

async function statFresh(filePath, ttlMs) {
  try {
    const stat = await fsp.stat(filePath);
    if (Date.now() - stat.mtimeMs < ttlMs) return stat;
    return null;
  } catch {
    return null;
  }
}

// --- In-flight dedup ---
//
// Two CI runners can hit the cache at the same instant for an uncached repo.
// Without dedup that fires two upstream fetches; with it the second arriver
// awaits the same promise. Map<key, Promise>.
const inFlight = new Map();

function dedup(key, factory) {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = factory().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

// --- Upstream fetch helpers ---

function pickTransport(url) {
  return url.protocol === "https:" ? https : http;
}

function upstreamGetJson(urlString, headers, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 4) return reject(new Error("Too many upstream redirects"));
    const url = new URL(urlString);
    const transport = pickTransport(url);
    const request = transport.get(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        headers,
        timeout: UPSTREAM_REPO_TIMEOUT_MS
      },
      (response) => {
        if ([301, 302, 307, 308].includes(response.statusCode) && response.headers.location) {
          response.resume();
          const next = new URL(response.headers.location, url).toString();
          return upstreamGetJson(next, headers, hops + 1).then(resolve, reject);
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode === 404) {
            const err = new Error("upstream 404");
            err.statusCode = 404;
            return reject(err);
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            const err = new Error(`upstream HTTP ${response.statusCode}: ${body.slice(0, 120)}`);
            err.statusCode = response.statusCode;
            return reject(err);
          }
          resolve(body);
        });
      }
    );
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("upstream timed out")));
  });
}

// Streams the upstream tarball straight to a temp file, then renames into
// place on success. Lets the response also pipe to the live client when a
// writable was provided.
function upstreamFetchTarball(urlString, destination, options = {}) {
  return new Promise((resolve, reject) => {
    const tempPath = `${destination}.tmp-${process.pid}-${Date.now()}`;
    const file = fs.createWriteStream(tempPath, { mode: 0o644 });
    let written = 0;
    let cleanedUp = false;
    const cleanup = (err) => {
      if (cleanedUp) return;
      cleanedUp = true;
      file.destroy();
      fs.unlink(tempPath, () => reject(err));
    };
    file.on("error", cleanup);

    const get = (currentUrl, hops) => {
      if (hops > 5) return cleanup(new Error("Too many redirects"));
      const url = new URL(currentUrl);
      const transport = pickTransport(url);
      const request = transport.get(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: url.pathname + url.search,
          headers: { "user-agent": USER_AGENT },
          timeout: UPSTREAM_TARBALL_TIMEOUT_MS
        },
        (response) => {
          if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
            response.resume();
            return get(new URL(response.headers.location, url).toString(), hops + 1);
          }
          if (response.statusCode === 404) {
            response.resume();
            const err = new Error("upstream 404");
            err.statusCode = 404;
            return cleanup(err);
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            response.resume();
            const err = new Error(`upstream HTTP ${response.statusCode}`);
            err.statusCode = response.statusCode;
            return cleanup(err);
          }
          response.on("data", (chunk) => {
            written += chunk.length;
            if (written > MAX_TARBALL_BYTES) {
              response.destroy();
              cleanup(new Error(`Tarball exceeded ${MAX_TARBALL_BYTES} bytes`));
            }
          });
          response.pipe(file);
          file.on("finish", () => {
            file.close((closeErr) => {
              if (closeErr) return cleanup(closeErr);
              fsp.rename(tempPath, destination).then(
                () => resolve({ bytes: written }),
                cleanup
              );
            });
          });
        }
      );
      request.on("error", cleanup);
      request.on("timeout", () => request.destroy(new Error("upstream tarball timed out")));
    };
    get(urlString, 0);
  });
}

// --- Route handlers ---

function sendJson(response, statusCode, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.length,
    "cache-control": "public, max-age=3600",
    ...extraHeaders
  });
  response.end(payload);
}

async function handleRepo(request, response, options, owner, repo) {
  if (!isSafeSegment(owner) || !isSafeSegment(repo)) {
    return sendJson(response, 400, { error: "invalid owner or repo" });
  }
  const cachePath = repoCachePath(options.cacheDir, owner, repo);
  const fresh = await statFresh(cachePath, REPO_TTL_MS);
  if (fresh) {
    try {
      const body = await fsp.readFile(cachePath);
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": body.length,
        "cache-control": "public, max-age=3600",
        "x-pkgxray-cache": "HIT",
        "x-pkgxray-cache-age-ms": String(Date.now() - fresh.mtimeMs)
      });
      response.end(body);
      return;
    } catch {
      // fall through to refetch
    }
  }

  const dedupKey = `repo:${owner}/${repo}`;
  try {
    const body = await dedup(dedupKey, async () => {
      const headers = {
        "user-agent": USER_AGENT,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28"
      };
      // Pass the client's optional GitHub token through to upstream so
      // private repos work and rate limits scale per-team-token.
      const forwardedToken =
        request.headers["x-pkgxray-github-token"] || process.env.PKGXRAY_CACHE_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
      if (forwardedToken) headers.authorization = `Bearer ${forwardedToken}`;
      const upstreamUrl = `${options.upstreamGithubApi}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
      const text = await upstreamGetJson(upstreamUrl, headers);
      await fsp.mkdir(path.dirname(cachePath), { recursive: true, mode: 0o755 });
      const tempPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
      await fsp.writeFile(tempPath, text, { mode: 0o644 });
      await fsp.rename(tempPath, cachePath);
      return text;
    });
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "public, max-age=3600",
      "x-pkgxray-cache": "MISS"
    });
    response.end(body);
  } catch (error) {
    if (error.statusCode === 404) {
      return sendJson(response, 404, { error: "repo not found", owner, repo }, { "x-pkgxray-cache": "MISS" });
    }
    return sendJson(response, 502, { error: "upstream fetch failed", message: error.message }, { "x-pkgxray-cache": "MISS" });
  }
}

async function handleTarball(request, response, options, owner, repo, ref) {
  if (!isSafeSegment(owner) || !isSafeSegment(repo) || !isSafeRef(ref)) {
    return sendJson(response, 400, { error: "invalid owner, repo, or ref" });
  }
  const cachePath = tarballCachePath(options.cacheDir, owner, repo, ref);
  const fresh = await statFresh(cachePath, TARBALL_TTL_MS);
  if (fresh) {
    response.writeHead(200, {
      "content-type": "application/gzip",
      "content-length": fresh.size,
      "cache-control": "public, max-age=86400",
      "x-pkgxray-cache": "HIT",
      "x-pkgxray-cache-age-ms": String(Date.now() - fresh.mtimeMs)
    });
    fs.createReadStream(cachePath).pipe(response);
    return;
  }

  const dedupKey = `tarball:${owner}/${repo}@${ref}`;
  try {
    await dedup(dedupKey, async () => {
      await fsp.mkdir(path.dirname(cachePath), { recursive: true, mode: 0o755 });
      const upstreamUrl = `${options.upstreamCodeload}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tar.gz/${encodeURIComponent(ref)}`;
      await upstreamFetchTarball(upstreamUrl, cachePath);
    });
    // After dedup resolves, the file is fully on disk. Stream it to the
    // client like a HIT — but mark MISS so the client sees the first-arrival
    // semantics.
    const stat = await fsp.stat(cachePath);
    response.writeHead(200, {
      "content-type": "application/gzip",
      "content-length": stat.size,
      "cache-control": "public, max-age=86400",
      "x-pkgxray-cache": "MISS"
    });
    fs.createReadStream(cachePath).pipe(response);
  } catch (error) {
    if (error.statusCode === 404) {
      return sendJson(response, 404, { error: "tarball not found", owner, repo, ref }, { "x-pkgxray-cache": "MISS" });
    }
    return sendJson(response, 502, { error: "upstream tarball fetch failed", message: error.message }, { "x-pkgxray-cache": "MISS" });
  }
}

function handleHealth(response) {
  sendJson(response, 200, { ok: true, version: VERSION });
}

function notFound(response) {
  sendJson(response, 404, { error: "not found" });
}

// --- Request router ---

function buildRouter(options) {
  return async function onRequest(request, response) {
    // Only GET (and HEAD as a convenience for liveness probes).
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { "content-type": "application/json", allow: "GET" });
      response.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    let parsed;
    try {
      parsed = new URL(request.url, "http://placeholder");
    } catch {
      return sendJson(response, 400, { error: "invalid url" });
    }
    const pathname = parsed.pathname;

    if (pathname === "/healthz") return handleHealth(response);

    // /github/repos/{owner}/{repo}
    const repoMatch = pathname.match(/^\/github\/repos\/([^\/]+)\/([^\/]+)\/?$/);
    if (repoMatch) {
      return handleRepo(request, response, options, decodeURIComponent(repoMatch[1]), decodeURIComponent(repoMatch[2]));
    }

    // /github/tarball/{owner}/{repo}/{ref...}
    // Refs can contain slashes (release/v1 etc.), so match everything after
    // the third segment as the ref.
    const tarballMatch = pathname.match(/^\/github\/tarball\/([^\/]+)\/([^\/]+)\/(.+?)\/?$/);
    if (tarballMatch) {
      return handleTarball(
        request,
        response,
        options,
        decodeURIComponent(tarballMatch[1]),
        decodeURIComponent(tarballMatch[2]),
        decodeURIComponent(tarballMatch[3])
      );
    }

    return notFound(response);
  };
}

// --- Server bootstrap ---

async function start(options) {
  await fsp.mkdir(options.cacheDir, { recursive: true, mode: 0o755 });
  const server = http.createServer(buildRouter(options));
  server.keepAliveTimeout = 30_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      const address = server.address();
      resolve({ server, address });
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  const { server, address } = await start(options);
  const port = typeof address === "object" && address ? address.port : options.port;
  process.stdout.write(
    `pkgxray-cache v${VERSION} listening on http://${options.host}:${port} (cache-dir=${options.cacheDir})\n`
  );
  const shutdown = (signal) => {
    process.stderr.write(`pkgxray-cache: received ${signal}, shutting down\n`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

module.exports = { start, parseArgs, buildRouter };

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`pkgxray-cache: ${error.message}\n`);
    process.exit(1);
  });
}
