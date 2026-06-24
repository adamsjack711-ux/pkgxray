"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const { start } = require("../bin/pkgxray-cache");

// Tiny in-process upstream fake. Counts hits per path so the cache-hit assertion
// can prove the second request never reached the upstream.
function startFakeUpstream(handlers) {
  const counts = new Map();
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const key = url.pathname;
      counts.set(key, (counts.get(key) || 0) + 1);
      const handler = handlers[key] || handlers.__default;
      if (!handler) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "no fake handler" }));
        return;
      }
      handler(request, response, { count: counts.get(key) });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        counts,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          })
      });
    });
  });
}

function getJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const request = http.get(url, { headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          body,
          elapsedMs
        });
      });
    });
    request.on("error", reject);
  });
}

function getBuffer(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const request = http.get(url, { headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
          elapsedMs
        });
      });
    });
    request.on("error", reject);
  });
}

async function makeTempDir(label) {
  return fsp.mkdtemp(path.join(os.tmpdir(), `pkgxray-cache-${label}-`));
}

test("healthz returns 200 with version", async (t) => {
  const cacheDir = await makeTempDir("health");
  const { server, address } = await start({
    port: 0,
    host: "127.0.0.1",
    cacheDir,
    upstreamGithubApi: "http://127.0.0.1:1",
    upstreamCodeload: "http://127.0.0.1:1"
  });
  t.after(async () => {
    await new Promise((r) => server.close(() => r()));
    await fsp.rm(cacheDir, { recursive: true, force: true });
  });

  const result = await getJson(`http://127.0.0.1:${address.port}/healthz`);
  assert.equal(result.statusCode, 200);
  const parsed = JSON.parse(result.body);
  assert.equal(parsed.ok, true);
  assert.equal(typeof parsed.version, "string");
});

test("repo route: MISS on first hit, HIT on second, single upstream call", async (t) => {
  const upstream = await startFakeUpstream({
    "/repos/example/example": (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        full_name: "example/example",
        description: "a test repo",
        stargazers_count: 7,
        default_branch: "main",
        owner: { type: "User" },
        license: { spdx_id: "MIT" }
      }));
    }
  });
  const cacheDir = await makeTempDir("repo");
  const { server, address } = await start({
    port: 0,
    host: "127.0.0.1",
    cacheDir,
    upstreamGithubApi: upstream.url,
    upstreamCodeload: upstream.url
  });
  t.after(async () => {
    await new Promise((r) => server.close(() => r()));
    await upstream.close();
    await fsp.rm(cacheDir, { recursive: true, force: true });
  });

  const url = `http://127.0.0.1:${address.port}/github/repos/example/example`;
  const first = await getJson(url);
  assert.equal(first.statusCode, 200, `first: ${first.body}`);
  assert.equal(first.headers["x-pkgxray-cache"], "MISS");
  const firstJson = JSON.parse(first.body);
  assert.equal(firstJson.full_name, "example/example");
  assert.equal(firstJson.stargazers_count, 7);

  const second = await getJson(url);
  assert.equal(second.statusCode, 200);
  assert.equal(second.headers["x-pkgxray-cache"], "HIT");
  assert.equal(JSON.parse(second.body).full_name, "example/example");

  assert.equal(upstream.counts.get("/repos/example/example"), 1, "upstream should be hit exactly once");
  // The HIT response should be at least as fast as the MISS (and usually much
  // faster). We give plenty of slack here — the goal is to prove the path is
  // not slower, not to nail down a number.
  assert.ok(second.elapsedMs <= first.elapsedMs + 50, `HIT (${second.elapsedMs}ms) should not be > MISS (${first.elapsedMs}ms) + 50ms`);

  // Cache file should exist on disk in the documented layout.
  const cacheFile = path.join(cacheDir, "github", "repos", "example", "example.json");
  const cached = JSON.parse(await fsp.readFile(cacheFile, "utf8"));
  assert.equal(cached.full_name, "example/example");
});

test("tarball route: streams bytes, HIT on second call, dedups concurrent requests", async (t) => {
  // Build a tiny gzipped payload that masquerades as a tarball.
  const payload = zlib.gzipSync(Buffer.from("hello pkgxray cache server\n".repeat(64)));
  const upstream = await startFakeUpstream({
    "/example/example/tar.gz/v1.0.0": (_req, res, ctx) => {
      // Slow the first response down enough that a parallel second request
      // would race the first if dedup were broken. Dedup means only one
      // upstream fetch — counts.get(key) stays at 1 even for many clients.
      const delay = ctx.count === 1 ? 80 : 0;
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/gzip", "content-length": payload.length });
        res.end(payload);
      }, delay);
    }
  });
  const cacheDir = await makeTempDir("tarball");
  const { server, address } = await start({
    port: 0,
    host: "127.0.0.1",
    cacheDir,
    upstreamGithubApi: upstream.url,
    upstreamCodeload: upstream.url
  });
  t.after(async () => {
    await new Promise((r) => server.close(() => r()));
    await upstream.close();
    await fsp.rm(cacheDir, { recursive: true, force: true });
  });

  const url = `http://127.0.0.1:${address.port}/github/tarball/example/example/v1.0.0`;

  // Fire two requests in parallel BEFORE either resolves. Dedup should
  // collapse them onto one upstream fetch.
  const [first, second] = await Promise.all([getBuffer(url), getBuffer(url)]);
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(first.body, payload);
  assert.deepEqual(second.body, payload);
  assert.equal(upstream.counts.get("/example/example/tar.gz/v1.0.0"), 1, "concurrent requests should dedup");

  // Third request lands after the cache is warm.
  const third = await getBuffer(url);
  assert.equal(third.statusCode, 200);
  assert.equal(third.headers["x-pkgxray-cache"], "HIT");
  assert.deepEqual(third.body, payload);
  assert.equal(upstream.counts.get("/example/example/tar.gz/v1.0.0"), 1, "cache hit should not re-call upstream");

  // The cached file lives at the documented path.
  const cacheFile = path.join(cacheDir, "github", "tarballs", "example", "example", "v1.0.0.tgz");
  const stat = await fs.promises.stat(cacheFile);
  assert.equal(stat.size, payload.length);
});

test("rejects path-traversal in owner/repo segments", async (t) => {
  const cacheDir = await makeTempDir("safety");
  const { server, address } = await start({
    port: 0,
    host: "127.0.0.1",
    cacheDir,
    upstreamGithubApi: "http://127.0.0.1:1",
    upstreamCodeload: "http://127.0.0.1:1"
  });
  t.after(async () => {
    await new Promise((r) => server.close(() => r()));
    await fsp.rm(cacheDir, { recursive: true, force: true });
  });

  // Encoded slashes (%2F) survive URL parsing, so after route-decode the
  // segment would contain "/" — which would let a crafted segment escape the
  // cache root if we did not validate. The route must reject these as 400.
  const bad = await getJson(`http://127.0.0.1:${address.port}/github/repos/foo%2F..%2Fbar/baz`);
  assert.equal(bad.statusCode, 400);

  // A double-dot segment is collapsed by the URL parser before it reaches
  // our route, so the resulting path simply does not match → 404. Either
  // outcome is safe (the upstream is never called and no file is touched)
  // but we lock in the 404 so a regression flipping it to a 200 would fail.
  const traversed = await getJson(`http://127.0.0.1:${address.port}/github/repos/%2E%2E/etc`);
  assert.equal(traversed.statusCode, 404);
});

test("strips Authorization header on cross-host upstream redirects", async (t) => {
  // Start two fake upstreams. The "primary" upstream 302s any request to the
  // "exfil" upstream. If we forwarded the Authorization header across hosts,
  // the exfil upstream would receive the bearer token — a HIGH severity
  // GITHUB_TOKEN leak. The test asserts the cross-host hop arrives with no
  // Authorization header.
  let exfilSeenAuth = null;
  let exfilHits = 0;
  const exfil = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      exfilHits += 1;
      exfilSeenAuth = req.headers["authorization"] || null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ full_name: "exfil/repo" }));
    });
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => s.close(() => r())) });
    });
  });

  const primary = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      // 302 → exfil host (different origin)
      res.writeHead(302, { location: `${exfil.url}/whatever` });
      res.end();
    });
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => s.close(() => r())) });
    });
  });

  const cacheDir = await makeTempDir("auth-leak");
  const { server, address } = await start({
    port: 0,
    host: "127.0.0.1",
    cacheDir,
    upstreamGithubApi: primary.url,
    upstreamCodeload: primary.url
  });
  t.after(async () => {
    await new Promise((r) => server.close(() => r()));
    await primary.close();
    await exfil.close();
    await fsp.rm(cacheDir, { recursive: true, force: true });
  });

  const url = `http://127.0.0.1:${address.port}/github/repos/example/example`;
  const result = await getJson(url, { "x-pkgxray-github-token": "ghp_secret_token_xyz" });
  assert.equal(result.statusCode, 200);
  assert.equal(exfilHits, 1, "exfil host should have received the redirected request");
  assert.equal(
    exfilSeenAuth,
    null,
    `Authorization header leaked across origin: ${exfilSeenAuth}`
  );
});

test("upstream 404 is propagated to client and not cached", async (t) => {
  const upstream = await startFakeUpstream({
    __default: (_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Not Found" }));
    }
  });
  const cacheDir = await makeTempDir("notfound");
  const { server, address } = await start({
    port: 0,
    host: "127.0.0.1",
    cacheDir,
    upstreamGithubApi: upstream.url,
    upstreamCodeload: upstream.url
  });
  t.after(async () => {
    await new Promise((r) => server.close(() => r()));
    await upstream.close();
    await fsp.rm(cacheDir, { recursive: true, force: true });
  });

  const result = await getJson(`http://127.0.0.1:${address.port}/github/repos/nope/nope`);
  assert.equal(result.statusCode, 404);
  // 404 responses are not persisted; the cache file should not exist.
  const cacheFile = path.join(cacheDir, "github", "repos", "nope", "nope.json");
  await assert.rejects(() => fsp.stat(cacheFile));
});

test("cache-client + github.js end-to-end via cache server", async (t) => {
  // Reset module cache so cache-client picks up the env var, then restore.
  const previous = process.env.PKGXRAY_CACHE_URL;
  t.after(() => {
    if (previous === undefined) delete process.env.PKGXRAY_CACHE_URL;
    else process.env.PKGXRAY_CACHE_URL = previous;
  });

  const upstream = await startFakeUpstream({
    "/repos/lodash/lodash": (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        full_name: "lodash/lodash",
        description: "lodash",
        stargazers_count: 50000,
        forks_count: 5000,
        default_branch: "main",
        owner: { type: "Organization" },
        license: { spdx_id: "MIT" },
        html_url: "https://github.com/lodash/lodash",
        archived: false,
        disabled: false,
        fork: false
      }));
    }
  });
  const cacheDir = await makeTempDir("e2e");
  const { server, address } = await start({
    port: 0,
    host: "127.0.0.1",
    cacheDir,
    upstreamGithubApi: upstream.url,
    upstreamCodeload: upstream.url
  });
  process.env.PKGXRAY_CACHE_URL = `http://127.0.0.1:${address.port}`;

  // Force a re-require of github.js so it loads the env var afresh. (The
  // cache-client itself re-reads env on each call, but re-requiring keeps
  // the test hermetic if other tests mutated the module cache.)
  delete require.cache[require.resolve("../src/github.js")];
  delete require.cache[require.resolve("../src/cache-client.js")];
  const { fetchRepoMetadata } = require("../src/github.js");

  t.after(async () => {
    await new Promise((r) => server.close(() => r()));
    await upstream.close();
    await fsp.rm(cacheDir, { recursive: true, force: true });
    delete require.cache[require.resolve("../src/github.js")];
    delete require.cache[require.resolve("../src/cache-client.js")];
  });

  const meta = await fetchRepoMetadata("https://github.com/lodash/lodash", { useCache: false });
  assert.equal(meta.found, true);
  assert.equal(meta.full_name, "lodash/lodash");
  assert.equal(meta.stars, 50000);
  assert.equal(meta.owner_type, "Organization");
  assert.equal(upstream.counts.get("/repos/lodash/lodash"), 1);
});
