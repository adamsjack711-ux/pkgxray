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
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");

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
  // A digest avoids collisions such as `a/b` vs `a__b`, while keeping refs
  // with slashes in one safe path component.
  const safeRef = crypto.createHash("sha256").update(ref).digest("hex");
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

const { createUpstreamPolicy } = require("../src/cache-upstream-policy");

// --- Upstream fetch helpers ---

function pickTransport(url) {
  return url.protocol === "https:" ? https : http;
}

// One wall-clock budget covers DNS, headers, redirects and the entire body.
// Socket inactivity timeouts alone can be kept alive indefinitely by drips.
function consumeUpstream(urlString, headers, policy, timeoutMs, consume) {
  return new Promise((resolve, reject) => {
    let request, response, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        response?.destroy();
        request?.destroy();
        reject(error);
      } else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("upstream total deadline exceeded")), timeoutMs);
    timer.unref();
    const get = (currentUrl, currentHeaders, hops) => {
      if (settled) return;
      if (hops > 4) return finish(new Error("Too many upstream redirects"));
      let url, lookup;
      try { ({ url, lookup } = policy(currentUrl)); }
      catch (error) { return finish(error); }
      let redirected = false;
      try {
        request = pickTransport(url).get({
          hostname: url.hostname.replace(/^\[|\]$/g, ""),
          lookup,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: url.pathname + url.search,
          headers: currentHeaders,
        }, (incoming) => {
          if (settled) { incoming.destroy(); return; }
          response = incoming;
          // Install these on redirect bodies too; disposal must not emit an
          // unhandled error, but intentional redirect destruction is ignored.
          incoming.on("error", error => { if (!redirected) finish(error); });
          incoming.on("aborted", () => { if (!redirected) finish(new Error("upstream response aborted")); });
          if ([301, 302, 303, 307, 308].includes(incoming.statusCode) && incoming.headers.location) {
            let next;
            try { next = policy(new URL(incoming.headers.location, url)).url; }
            catch (error) { return finish(error); }
            // SECURITY: never forward credential-bearing headers across an
            // origin change. Same-origin path rewrites retain authentication.
            let nextHeaders = currentHeaders;
            if (next.origin !== url.origin) {
              nextHeaders = {};
              for (const [key, value] of Object.entries(currentHeaders)) {
                const lower = key.toLowerCase();
                if (lower === "authorization") continue;
                if (lower === "cookie") continue;
                if (lower === "proxy-authorization") continue;
                nextHeaders[key] = value;
              }
            }
            redirected = true;
            // Do not drain an unbounded redirect body or retain its socket.
            incoming.destroy();
            return get(next.toString(), nextHeaders, hops + 1);
          }
          try { consume(incoming, value => finish(null, value), error => finish(error)); }
          catch (error) { finish(error); }
        });
        request.on("error", error => { if (!redirected) finish(error); });
      } catch (error) { finish(error); }
    };
    get(urlString, headers, 0);
  });
}

function upstreamGetJson(urlString, headers, policy, timeoutMs = UPSTREAM_REPO_TIMEOUT_MS) {
  return consumeUpstream(urlString, headers, policy, timeoutMs, (response, resolve, reject) => {
    let body = "";
    let size = 0;
    let aborted = false;
    response.setEncoding("utf8");
    response.on("data", (chunk) => {
      if (aborted) return;
      // Cap the upstream JSON body: a hostile upstream serving a giant body
      // would otherwise exhaust the server's memory.
      size += Buffer.byteLength(chunk);
      if (size > MAX_JSON_BYTES) {
        aborted = true;
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
  });
}

// Streams the upstream tarball to a temp file, then renames on success.
async function upstreamFetchTarball(urlString, destination, policy, timeoutMs = UPSTREAM_TARBALL_TIMEOUT_MS) {
  const tempPath = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let file;
  try {
    const result = await consumeUpstream(urlString, { "user-agent": USER_AGENT }, policy, timeoutMs,
      (response, resolve, reject) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(`upstream HTTP ${response.statusCode}`);
          error.statusCode = response.statusCode;
          reject(error); return;
        }
        file = fs.createWriteStream(tempPath, { mode: 0o644 });
        let written = 0;
        response.on("data", chunk => {
          written += chunk.length;
          if (written > MAX_TARBALL_BYTES) reject(new Error(`Tarball exceeded ${MAX_TARBALL_BYTES} bytes`));
        });
        pipeline(response, file).then(() => resolve({ bytes: written }), reject);
      });
    // Only a complete, closed file may become a cache hit.
    await fsp.rename(tempPath, destination);
    return result;
  } catch (error) {
    if (file && !file.closed) {
      await new Promise(resolve => { file.once("close", resolve); file.destroy(); });
    }
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
  return consumeUpstream(urlString, { "user-agent": USER_AGENT }, policy, timeoutMs,
    (response, resolve, reject) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        const error = new Error(`upstream HTTP ${response.statusCode}`);
        error.statusCode = response.statusCode;
        reject(error); return;
      }
      let written = 0;
      response.on("data", (chunk) => {
        written += chunk.length;
        if (written > MAX_TARBALL_BYTES) {
          reject(new Error(`Tarball exceeded ${MAX_TARBALL_BYTES} bytes`));
        }
      });
      sink.writeHead(200, {
        "content-type": "application/gzip",
        "cache-control": "public, max-age=86400",
        "x-pkgxray-cache": "BYPASS"
      });
      // pipeline also cancels the upstream when the client disconnects.
      pipeline(response, sink).then(() => resolve({ bytes: written }), reject);
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
      const text = await upstreamGetJson(upstreamUrl, headers, options.repoPolicy, options.upstreamRepoTimeoutMs);
      if (forwardedToken) return text; // Never persist credentials-scoped metadata.
      await fsp.mkdir(path.dirname(cachePath), { recursive: true, mode: 0o755 });
      const tempPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
      await fsp.writeFile(tempPath, text, { mode: 0o644 });
      await fsp.rename(tempPath, cachePath);
      return text;
    };
    const body = forwardedToken ? await fetchRepo() : await dedup(`${options.cacheDir}:${dedupKey}`, fetchRepo);
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": forwardedToken ? "private, no-store" : "public, max-age=3600",
      "x-pkgxray-cache": forwardedToken ? "BYPASS" : "MISS"
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
    await deliverCachedTarball(cachePath, response, options.upstreamTarballTimeoutMs);
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
        await upstreamStreamTarball(upstreamUrl, response, options.tarballPolicy, options.upstreamTarballTimeoutMs);
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
    await dedup(`${options.cacheDir}:${dedupKey}`, async () => {
      await fsp.mkdir(path.dirname(cachePath), { recursive: true, mode: 0o755 });
      await upstreamFetchTarball(upstreamUrl, cachePath, options.tarballPolicy, options.upstreamTarballTimeoutMs);
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
    await deliverCachedTarball(cachePath, response, options.upstreamTarballTimeoutMs);
  } catch (error) {
    if (response.headersSent) { response.destroy(); return; }
    if (error.statusCode === 404) {
      return sendJson(response, 404, { error: "tarball not found", owner, repo, ref }, { "x-pkgxray-cache": "MISS" });
    }
    return sendJson(response, 502, { error: "upstream tarball fetch failed", message: error.message }, { "x-pkgxray-cache": "MISS" });
  }
}

async function deliverCachedTarball(cachePath, response, timeoutMs) {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  timer.unref();
  try { await pipeline(fs.createReadStream(cachePath), response, { signal: abortController.signal }); }
  finally { clearTimeout(timer); }
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
  // Embedders may shorten the deadlines (also useful for local regression
  // fixtures), but may not disable or extend the service's resource limits.
  for (const [key, ceiling] of [["upstreamRepoTimeoutMs", UPSTREAM_REPO_TIMEOUT_MS],
    ["upstreamTarballTimeoutMs", UPSTREAM_TARBALL_TIMEOUT_MS]]) {
    const value = options[key] ?? ceiling;
    if (!Number.isFinite(value) || value <= 0 || value > ceiling) throw new Error(`Invalid ${key}`);
    options[key] = value;
  }
  options = { ...options,
    repoPolicy: createUpstreamPolicy(options.upstreamGithubApi, options),
    tarballPolicy: createUpstreamPolicy(options.upstreamCodeload, { ...options, codeload: true })
  };
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
    let decoded;
    const decode = (value) => {
      try { return decodeURIComponent(value); }
      catch { decoded = false; return null; }
    };

    if (pathname === "/healthz") return handleHealth(response);

    // /github/repos/{owner}/{repo}
    const repoMatch = pathname.match(/^\/github\/repos\/([^\/]+)\/([^\/]+)\/?$/);
    if (repoMatch) {
      decoded = true;
      const owner = decode(repoMatch[1]), repo = decode(repoMatch[2]);
      if (!decoded) return sendJson(response, 400, { error: "invalid percent-encoding" });
      return handleRepo(request, response, options, owner, repo);
    }

    // /github/tarball/{owner}/{repo}/{ref...}
    // Refs can contain slashes (release/v1 etc.), so match everything after
    // the third segment as the ref.
    const tarballMatch = pathname.match(/^\/github\/tarball\/([^\/]+)\/([^\/]+)\/(.+?)\/?$/);
    if (tarballMatch) {
      decoded = true;
      const owner = decode(tarballMatch[1]), repo = decode(tarballMatch[2]), ref = decode(tarballMatch[3]);
      if (!decoded) return sendJson(response, 400, { error: "invalid percent-encoding" });
      return handleTarball(
        request,
        response,
        options,
        owner,
        repo,
        ref
      );
    }

    return notFound(response);
  };
}

// --- Server bootstrap ---

async function start(options) {
  await fsp.mkdir(options.cacheDir, { recursive: true, mode: 0o700 });
  const router = buildRouter(options);
  const server = http.createServer((request, response) => {
    Promise.resolve(router(request, response)).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: "internal cache error" });
      else response.destroy();
    });
  });
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
