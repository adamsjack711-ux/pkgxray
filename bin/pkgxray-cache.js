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
const MAX_JSON_BYTES = 8 * 1024 * 1024; // 8MB ceiling for repo-metadata JSON

// Total on-disk cache ceiling (finding 3c). A never-evicting cache grows
// unbounded; once the tarball+repo tree exceeds this, new tarball writes are
// refused (the client still gets a live upstream stream — see handleTarball).
// Configurable via --max-cache-bytes / PKGXRAY_CACHE_MAX_BYTES; 0 disables.
const DEFAULT_MAX_CACHE_BYTES = 20 * 1024 * 1024 * 1024; // 20GB

function parseArgs(argv) {
  const options = {
    port: 8819,
    cacheDir: path.join(os.homedir(), ".cache", "pkgxray-server"),
    upstreamGithubApi: "https://api.github.com",
    upstreamCodeload: "https://codeload.github.com",
    // Bind loopback-only by default. This server is NOT an auth boundary (see
    // printUsage), so a careless deploy that exposes it should fail SAFE: the
    // operator must opt into a routable interface with --host 0.0.0.0 (or
    // PKGXRAY_CACHE_HOST) and put their own auth/network controls in front.
    host: process.env.PKGXRAY_CACHE_HOST || "127.0.0.1",
    maxCacheBytes: process.env.PKGXRAY_CACHE_MAX_BYTES
      ? Number(process.env.PKGXRAY_CACHE_MAX_BYTES)
      : DEFAULT_MAX_CACHE_BYTES
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
    else if (arg === "--max-cache-bytes") options.maxCacheBytes = Number(argv[++i]);
    else if (arg.startsWith("--max-cache-bytes=")) options.maxCacheBytes = Number(arg.slice("--max-cache-bytes=".length));
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  options.upstreamGithubApi = options.upstreamGithubApi.replace(/\/+$/, "");
  options.upstreamCodeload = options.upstreamCodeload.replace(/\/+$/, "");
  if (!Number.isFinite(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error(`Invalid --port value`);
  }
  if (!Number.isFinite(options.maxCacheBytes) || options.maxCacheBytes < 0) {
    throw new Error(`Invalid --max-cache-bytes value`);
  }
  return options;
}

function printUsage() {
  process.stderr.write(
    [
      "Usage:",
      "  pkgxray-cache [--port 8819] [--host 127.0.0.1] [--cache-dir DIR]",
      "                [--upstream-github-api URL] [--upstream-codeload URL]",
      "                [--max-cache-bytes N]",
      "",
      "Routes:",
      "  GET /github/repos/{owner}/{repo}        proxy + cache api.github.com (1h TTL)",
      "  GET /github/tarball/{owner}/{repo}/{ref}  proxy + cache codeload tarball (24h TTL)",
      "  GET /healthz                            { ok: true, version }",
      "",
      "Binds 127.0.0.1 by default. To serve a fleet, set --host 0.0.0.0 (or",
      "PKGXRAY_CACHE_HOST) explicitly — and note this is NOT an auth boundary:",
      "run it on a private network or behind your own authenticating proxy.",
      "The server never uses its own GitHub token for a client request; a client",
      "must present x-pkgxray-github-token to reach private repos.",
      "",
      "Disk: the cache never expires by mtime (only TTL-checks on read) so it can",
      "grow without bound. --max-cache-bytes (or PKGXRAY_CACHE_MAX_BYTES, default",
      "20GB, 0 to disable) caps total tarball+repo bytes; once exceeded, new",
      "tarballs are streamed live from upstream but not written to disk.",
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

// Best-effort total size of a directory tree, in bytes. Used to enforce the
// disk cap (finding 3c). Never throws — a stat error just skips that entry.
async function dirSizeBytes(root) {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      total += await dirSizeBytes(full);
    } else {
      try {
        total += (await fsp.stat(full)).size;
      } catch {
        // vanished/inaccessible — skip
      }
    }
  }
  return total;
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
          const next = new URL(response.headers.location, url);
          // SECURITY: never forward the Authorization (or token-bearing) header
          // across an origin change. A misconfigured / hostile upstream that
          // 302s api.github.com → attacker.example.com would otherwise leak
          // the GitHub bearer token in the rerequest. Same-origin redirects
          // (apex → www, path rewrites) keep the token so private repos still
          // work behind well-behaved CDNs.
          let nextHeaders = headers;
          if (next.host !== url.host) {
            nextHeaders = {};
            for (const [key, value] of Object.entries(headers)) {
              const lower = key.toLowerCase();
              if (lower === "authorization") continue;
              if (lower === "cookie") continue;
              if (lower === "proxy-authorization") continue;
              nextHeaders[key] = value;
            }
          }
          return upstreamGetJson(next.toString(), nextHeaders, hops + 1).then(resolve, reject);
        }
        let body = "";
        let size = 0;
        let aborted = false;
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          if (aborted) return;
          // Cap the upstream JSON body (finding 3b): a hostile/compromised
          // upstream serving a giant body would otherwise OOM the server.
          size += Buffer.byteLength(chunk);
          if (size > MAX_JSON_BYTES) {
            aborted = true;
            response.destroy();
            return reject(new Error(`upstream JSON exceeded ${MAX_JSON_BYTES} bytes`));
          }
          body += chunk;
        });
        response.on("end", () => {
          if (aborted) return;
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

// Streams an upstream tarball straight to `sink` (the live client response)
// WITHOUT writing to disk. Used when the disk cache is over its cap (finding
// 3c). Rejects (before any bytes reach the sink) on 404 / non-2xx so the
// caller can still send a proper error status. The MAX_TARBALL_BYTES ceiling
// still applies.
function upstreamStreamTarball(urlString, sink) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const get = (currentUrl, hops) => {
      if (hops > 5) return fail(new Error("Too many redirects"));
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
            return fail(err);
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            response.resume();
            const err = new Error(`upstream HTTP ${response.statusCode}`);
            err.statusCode = response.statusCode;
            return fail(err);
          }
          let written = 0;
          response.on("data", (chunk) => {
            written += chunk.length;
            if (written > MAX_TARBALL_BYTES) {
              response.destroy();
              fail(new Error(`Tarball exceeded ${MAX_TARBALL_BYTES} bytes`));
            }
          });
          response.pipe(sink);
          response.on("end", () => {
            if (!settled) {
              settled = true;
              resolve({ bytes: written });
            }
          });
          response.on("error", fail);
        }
      );
      request.on("error", fail);
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
      // Pass ONLY the client's own GitHub token upstream (finding 3a). We
      // deliberately DO NOT fall back to the server's PKGXRAY_CACHE_GITHUB_TOKEN
      // / GITHUB_TOKEN: doing so is a confused-deputy — an unauthenticated
      // client could make the server spend ITS token to fetch a private repo,
      // then retrieve the cached result later without any credentials. A
      // client that wants private-repo access must present its own token.
      const forwardedToken = request.headers["x-pkgxray-github-token"];
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

  // Disk cap (finding 3c): if the on-disk cache is already over the ceiling,
  // don't persist a new artifact — proxy it live from upstream instead so the
  // client still succeeds but the cache stops growing. `maxCacheBytes === 0`
  // disables the cap entirely.
  const upstreamUrl = `${options.upstreamCodeload}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tar.gz/${encodeURIComponent(ref)}`;
  if (options.maxCacheBytes > 0) {
    const used = await dirSizeBytes(options.cacheDir);
    if (used >= options.maxCacheBytes) {
      try {
        response.writeHead(200, {
          "content-type": "application/gzip",
          "cache-control": "public, max-age=86400",
          "x-pkgxray-cache": "BYPASS"
        });
        await upstreamStreamTarball(upstreamUrl, response);
      } catch (error) {
        if (!response.headersSent) {
          if (error.statusCode === 404) {
            return sendJson(response, 404, { error: "tarball not found", owner, repo, ref }, { "x-pkgxray-cache": "BYPASS" });
          }
          return sendJson(response, 502, { error: "upstream tarball fetch failed", message: error.message }, { "x-pkgxray-cache": "BYPASS" });
        }
        response.destroy();
      }
      return;
    }
  }

  const dedupKey = `tarball:${owner}/${repo}@${ref}`;
  try {
    await dedup(dedupKey, async () => {
      await fsp.mkdir(path.dirname(cachePath), { recursive: true, mode: 0o755 });
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
