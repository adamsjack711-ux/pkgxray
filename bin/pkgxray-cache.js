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
const { requestText, downloadFile } = require("../src/http-client");

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
    else if (arg === "--allow-private-upstream") options.allowPrivateUpstream = true;
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
      "                [--allow-private-upstream] # trust configured origins for private/HTTP access",
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
  return joinUnder(cacheDir, "github", "public-repos-v2", owner, `${repo}.json`);
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
const cacheReservations = new Map();

function dedup(key, factory) {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = factory().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

async function reserveCacheCapacity(cacheDir, maxCacheBytes) {
  const key = path.resolve(cacheDir);
  const used = await dirSizeBytes(key);
  const alreadyReserved = cacheReservations.get(key) || 0;
  const available = maxCacheBytes - used - alreadyReserved;
  if (available <= 0) return null;
  const bytes = Math.min(MAX_TARBALL_BYTES, available);
  cacheReservations.set(key, alreadyReserved + bytes);
  let released = false;
  return {
    bytes,
    release() {
      if (released) return;
      released = true;
      const remaining = (cacheReservations.get(key) || 0) - bytes;
      if (remaining > 0) cacheReservations.set(key, remaining);
      else cacheReservations.delete(key);
    }
  };
}

async function reserveExactCacheCapacity(cacheDir, maxCacheBytes, bytes) {
  const key = path.resolve(cacheDir);
  const used = await dirSizeBytes(key);
  const alreadyReserved = cacheReservations.get(key) || 0;
  if (bytes > maxCacheBytes - used - alreadyReserved) return null;
  cacheReservations.set(key, alreadyReserved + bytes);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      const remaining = (cacheReservations.get(key) || 0) - bytes;
      if (remaining > 0) cacheReservations.set(key, remaining);
      else cacheReservations.delete(key);
    }
  };
}

const { createUpstreamPolicy } = require("../src/cache-upstream-policy");

// --- Upstream fetch helpers ---

function pickTransport(url) {
  return url.protocol === "https:" ? https : http;
}

async function upstreamGetJson(urlString, headers, policy, timeoutMs = UPSTREAM_REPO_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let current = urlString;
  let currentHeaders = headers;
  for (let hops = 0; hops <= 4; hops += 1) {
    const { url, lookup } = policy(current);
    const response = await requestText(url, {
      transport: pickTransport(url),
      lookup,
      agent: false,
      headers: currentHeaders,
      timeoutMs,
      deadline,
      maxBytes: MAX_JSON_BYTES
    });
    if ([301, 302, 307, 308].includes(response.statusCode) && response.headers?.location) {
      const next = policy(new URL(response.headers.location, url)).url;
      // SECURITY: never forward credential-bearing headers across origins.
      if (next.origin !== url.origin) {
        currentHeaders = Object.fromEntries(Object.entries(currentHeaders).filter(([key]) =>
          !["authorization", "cookie", "proxy-authorization"].includes(key.toLowerCase())
        ));
      }
      current = next.toString();
      continue;
    }
    if (response.statusCode === 404) {
      const error = new Error("upstream 404");
      error.statusCode = 404;
      throw error;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const error = new Error(`upstream HTTP ${response.statusCode}: ${response.body.slice(0, 120)}`);
      error.statusCode = response.statusCode;
      throw error;
    }
    return response.body;
  }
  throw new Error("Too many upstream redirects");
}

// Streams the upstream tarball straight to a temp file, then renames into
// place on success. Lets the response also pipe to the live client when a
// writable was provided.
async function upstreamFetchTarball(urlString, destination, policy, timeoutMs = UPSTREAM_TARBALL_TIMEOUT_MS, maxBytes = MAX_TARBALL_BYTES) {
  const tempPath = `${destination}.tmp-${process.pid}-${Date.now()}`;
  try {
    const result = await downloadFile(urlString, tempPath, {
      validate: policy,
      timeoutMs,
      maxBytes,
      headers: { "user-agent": USER_AGENT }
    });
    await fsp.rename(tempPath, destination);
    return { bytes: result.bytes };
  } catch (error) {
    await fsp.unlink(tempPath).catch(() => {});
    throw error;
  }
}

// Streams an upstream tarball straight to `sink` (the live client response)
// WITHOUT writing to disk. Used when the disk cache is over its cap (finding
// 3c). Rejects (before any bytes reach the sink) on 404 / non-2xx so the
// caller can still send a proper error status. The MAX_TARBALL_BYTES ceiling
// still applies.
function upstreamStreamTarball(urlString, sink, policy, timeoutMs = UPSTREAM_TARBALL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let activeRequest;
    let activeResponse;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      activeResponse?.destroy();
      activeRequest?.destroy();
      reject(err);
    };
    const deadlineTimer = setTimeout(
      () => fail(new Error(`upstream tarball timed out after ${timeoutMs} ms`)),
      timeoutMs
    );
    sink.once("close", () => {
      if (!settled) fail(new Error("downstream client disconnected"));
    });
    const get = (currentUrl, hops) => {
      if (hops > 5) return fail(new Error("Too many redirects"));
      let url, lookup;
      try { ({ url, lookup } = policy(currentUrl)); }
      catch (error) { return fail(error); }
      const transport = pickTransport(url);
      const request = transport.get(
        {
          hostname: url.hostname.replace(/^\[|\]$/g, ""),
          lookup,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: url.pathname + url.search,
          headers: { "user-agent": USER_AGENT },
          timeout: Math.max(1, timeoutMs)
        },
        (response) => {
          activeResponse = response;
          if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
            response.resume();
            try { return get(new URL(response.headers.location, url).toString(), hops + 1); }
            catch (error) { return fail(error); }
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
          sink.writeHead(200, {
            "content-type": "application/gzip",
            "cache-control": "public, max-age=86400",
            "x-pkgxray-cache": "BYPASS"
          });
          response.pipe(sink);
          response.on("end", () => {
            if (!settled) {
              settled = true;
              clearTimeout(deadlineTimer);
              resolve({ bytes: written });
            }
          });
          response.on("error", fail);
          response.on("aborted", () => fail(new Error("Upstream tarball aborted")));
          response.on("close", () => {
            if (!settled && !response.complete) fail(new Error("Upstream tarball closed before completion"));
          });
        }
      );
      activeRequest = request;
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
    "cache-control": "no-store",
    ...extraHeaders
  });
  response.end(payload);
}

async function handleRepo(request, response, options, owner, repo) {
  if (!isSafeSegment(owner) || !isSafeSegment(repo)) {
    return sendJson(response, 400, { error: "invalid owner or repo" });
  }
  const cachePath = repoCachePath(options.cacheDir, owner, repo);
  const forwardedToken = request.headers["x-pkgxray-github-token"];
  const fresh = forwardedToken ? null : await statFresh(cachePath, REPO_TTL_MS);
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
    const fetchRepo = async () => {
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
      if (forwardedToken) headers.authorization = `Bearer ${forwardedToken}`;
      const upstreamUrl = `${options.upstreamGithubApi}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
      const text = await upstreamGetJson(
        upstreamUrl,
        headers,
        options.repoPolicy,
        options.upstreamRepoTimeoutMs || UPSTREAM_REPO_TIMEOUT_MS
      );
      if (forwardedToken) return { body: text, cacheStatus: "BYPASS" }; // Never persist credentials-scoped metadata.
      const bytes = Buffer.byteLength(text);
      const reservation = options.maxCacheBytes > 0
        ? await reserveExactCacheCapacity(options.cacheDir, options.maxCacheBytes, bytes)
        : null;
      if (options.maxCacheBytes > 0 && !reservation) {
        return { body: text, cacheStatus: "BYPASS" };
      }
      const tempPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
      try {
        await fsp.mkdir(path.dirname(cachePath), { recursive: true, mode: 0o755 });
        await fsp.writeFile(tempPath, text, { mode: 0o644 });
        await fsp.rename(tempPath, cachePath);
        return { body: text, cacheStatus: "MISS" };
      } catch (error) {
        await fsp.unlink(tempPath).catch(() => {});
        throw error;
      } finally {
        reservation?.release();
      }
    };
    const fetched = forwardedToken ? await fetchRepo() : await dedup(`${options.cacheDir}:${dedupKey}`, fetchRepo);
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(fetched.body),
      "cache-control": forwardedToken ? "private, no-store" : "public, max-age=3600",
      "x-pkgxray-cache": fetched.cacheStatus
    });
    response.end(fetched.body);
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

  const upstreamUrl = `${options.upstreamCodeload}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tar.gz/${encodeURIComponent(ref)}`;

  const dedupKey = `tarball:${owner}/${repo}@${ref}`;
  try {
    await dedup(`${options.cacheDir}:${dedupKey}`, async () => {
      const reservation = options.maxCacheBytes > 0
        ? await reserveCacheCapacity(options.cacheDir, options.maxCacheBytes)
        : null;
      if (options.maxCacheBytes > 0 && !reservation) {
        const error = new Error("cache capacity exhausted");
        error.cacheBypass = true;
        throw error;
      }
      try {
        await fsp.mkdir(path.dirname(cachePath), { recursive: true, mode: 0o755 });
        await upstreamFetchTarball(
          upstreamUrl,
          cachePath,
          options.tarballPolicy,
          options.upstreamTarballTimeoutMs || UPSTREAM_TARBALL_TIMEOUT_MS,
          reservation?.bytes || MAX_TARBALL_BYTES
        );
      } catch (error) {
        if (reservation && reservation.bytes < MAX_TARBALL_BYTES && /response exceeded/.test(error.message)) {
          error.cacheBypass = true;
        }
        throw error;
      } finally {
        reservation?.release();
      }
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
    if (error.cacheBypass) {
      try {
        await upstreamStreamTarball(
          upstreamUrl,
          response,
          options.tarballPolicy,
          options.upstreamTarballTimeoutMs || UPSTREAM_TARBALL_TIMEOUT_MS
        );
      } catch (streamError) {
        if (!response.headersSent) {
          if (streamError.statusCode === 404) {
            return sendJson(response, 404, { error: "tarball not found", owner, repo, ref }, { "x-pkgxray-cache": "BYPASS" });
          }
          return sendJson(response, 502, { error: "upstream tarball fetch failed", message: streamError.message }, { "x-pkgxray-cache": "BYPASS" });
        }
        response.destroy();
      }
      return;
    }
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
  options = { upstreamGithubApi: "https://api.github.com", upstreamCodeload: "https://codeload.github.com", ...options };
  options = { ...options,
    repoPolicy: createUpstreamPolicy(options.upstreamGithubApi, options),
    tarballPolicy: createUpstreamPolicy(options.upstreamCodeload, { ...options, codeload: true })
  };
  return async function onRequest(request, response) {
    try {
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
    } catch (error) {
      // Node's HTTP server does not observe a rejected promise returned by an
      // async request listener. Without this boundary, a malformed escape such
      // as "%ZZ" makes decodeURIComponent throw and becomes an unhandled
      // rejection, which terminates Node under the default rejection mode.
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof URIError) {
        return sendJson(response, 400, { error: "invalid url encoding" });
      }
      return sendJson(response, 500, { error: "internal cache error" });
    }
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
