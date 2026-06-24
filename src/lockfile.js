"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Lockfile parsers — return Map<name@version, { name, version, paths: [] }>
// `paths` is the dependency chain(s) that led to this dep (useful for "why is
// this here" output). Deduped — one entry per unique name+version.
// ---------------------------------------------------------------------------

function detectFormat(filePath) {
  const base = path.basename(filePath);
  if (base === "package-lock.json" || base === "npm-shrinkwrap.json") return "npm";
  if (base === "yarn.lock") return "yarn";
  if (base === "pnpm-lock.yaml" || base === "pnpm-lock.yml") return "pnpm";
  if (base === "package.json") return "package-json";
  return null;
}

async function parseLockfile(filePath) {
  const format = detectFormat(filePath);
  if (!format) {
    throw new Error(`Unsupported lockfile name: ${path.basename(filePath)}`);
  }
  const text = await fsp.readFile(filePath, "utf8");
  switch (format) {
    case "npm": return { format, deps: parseNpmLockfile(text) };
    case "yarn": return { format, deps: parseYarnLockfile(text) };
    case "pnpm": return { format, deps: parsePnpmLockfile(text) };
    case "package-json": return { format, deps: parsePackageJson(text) };
    default: throw new Error(`unreachable`);
  }
}

function parseNpmLockfile(text) {
  const json = JSON.parse(text);
  const deps = new Map();
  // npm v7+ lockfileVersion 2/3 stores everything under `packages`.
  if (json.packages) {
    for (const [key, entry] of Object.entries(json.packages)) {
      if (!key || key === "") continue; // root
      if (!entry || !entry.version) continue;
      // key looks like "node_modules/foo" or "node_modules/foo/node_modules/bar"
      const segments = key.split("node_modules/").slice(1);
      const name = entry.name || segments[segments.length - 1].replace(/\/$/, "");
      add(deps, name, entry.version, [key]);
    }
    return deps;
  }
  // Fallback for v1: `dependencies` tree.
  function walk(obj, chain) {
    if (!obj) return;
    for (const [name, entry] of Object.entries(obj)) {
      if (!entry || !entry.version) continue;
      add(deps, name, entry.version, [chain.concat(name).join(" > ")]);
      if (entry.dependencies) walk(entry.dependencies, chain.concat(name));
    }
  }
  if (json.dependencies) walk(json.dependencies, []);
  return deps;
}

function parseYarnLockfile(text) {
  // Both yarn v1 (custom format) and yarn berry (yaml-ish) start each entry
  // with the spec block followed by an indented `version "X.Y.Z"` line.
  const deps = new Map();
  const blocks = text.split(/\n(?=[^\s])/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const header = lines[0];
    if (!header || header.startsWith("#") || header.startsWith("__")) continue;
    const versionMatch = block.match(/^\s+version[:\s]+"?([^"\s]+)"?/m);
    if (!versionMatch) continue;
    const version = versionMatch[1];
    // Header is something like:
    //   "react@^18.0.0", "react@18.0.0":     (v1)
    //   "@scope/x@npm:^1.0.0":                (berry)
    // We extract the package name(s) — the part before the last @ that isn't a scope.
    const specs = header.replace(/:\s*$/, "").split(/\s*,\s*/);
    for (const spec of specs) {
      const cleaned = spec.replace(/^"|"$/g, "").trim();
      const name = extractYarnName(cleaned);
      if (name) add(deps, name, version, [cleaned]);
    }
  }
  return deps;
}

function extractYarnName(spec) {
  // Strip optional "npm:" protocol prefix on berry: "@scope/x@npm:1.2.3"
  const stripped = spec.replace(/@npm:/, "@");
  const at = stripped.startsWith("@")
    ? stripped.indexOf("@", 1)
    : stripped.indexOf("@");
  if (at === -1) return null;
  return stripped.slice(0, at);
}

function parsePnpmLockfile(text) {
  // pnpm-lock.yaml is YAML; rather than pull in a yaml parser we scrape the
  // `packages:` block whose keys are `/name@version` or `/@scope/name@version`.
  const deps = new Map();
  // Match keys like "/foo@1.2.3:" or "/@scope/foo@1.2.3(peer):"
  const re = /^\s+\/(@?[^@\n]+?)@([^():\n]+?)(?:\([^)]*\))?:\s*$/gm;
  let match;
  while ((match = re.exec(text)) !== null) {
    add(deps, match[1], match[2], [`${match[1]}@${match[2]}`]);
  }
  return deps;
}

function parsePackageJson(text) {
  const json = JSON.parse(text);
  const deps = new Map();
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const entries = json[section] || {};
    for (const [name, rawVersion] of Object.entries(entries)) {
      // package.json holds version ranges, not pinned versions. Strip the
      // common range prefixes so OSV gets something resolvable.
      const version = String(rawVersion).replace(/^[~^>=<]+/, "").trim();
      if (!version || version.startsWith("file:") || version.startsWith("github:") || version.startsWith("git+")) {
        continue;
      }
      add(deps, name, version, [section]);
    }
  }
  return deps;
}

function add(deps, name, version, paths) {
  const key = `${name}@${version}`;
  const existing = deps.get(key);
  if (existing) {
    if (paths) existing.paths.push(...paths);
  } else {
    deps.set(key, { name, version, paths: paths || [] });
  }
}

// ---------------------------------------------------------------------------
// Batch OSV
// ---------------------------------------------------------------------------

const https = require("node:https");

// Lockfiles >1000 deps fan out into multiple OSV chunks; keep-alive lets the
// second + third chunks reuse the first chunk's TLS session.
const OSV_AGENT = new https.Agent({ keepAlive: true, maxSockets: 10 });

function batchOsvQuery(deps) {
  const queries = Array.from(deps.values()).map((d) => ({
    package: { name: d.name, ecosystem: "npm" },
    version: d.version
  }));
  if (queries.length === 0) return Promise.resolve([]);
  // OSV /v1/querybatch accepts up to 1000 per call. Split if larger.
  const chunks = [];
  for (let i = 0; i < queries.length; i += 1000) {
    chunks.push(queries.slice(i, i + 1000));
  }
  return Promise.all(chunks.map(postBatch)).then((results) => results.flat());
}

function postBatch(queries) {
  const body = JSON.stringify({ queries });
  return new Promise((resolve, reject) => {
    const req = https.request(
      "https://api.osv.dev/v1/querybatch",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "user-agent": "pkgxray/0.9.0"
        },
        agent: OSV_AGENT
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`OSV HTTP ${res.statusCode}`));
        }
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(buf);
            resolve(parsed.results || []);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Main audit
// ---------------------------------------------------------------------------

const DEEP_CONCURRENCY = 4;

async function auditLockfile(filePath, options = {}) {
  const { format, deps } = await parseLockfile(filePath);
  const start = Date.now();
  const queries = Array.from(deps.values());

  let osvResults = [];
  if (options.vulnerabilityCheck !== false) {
    osvResults = await batchOsvQuery(deps);
  }
  const osvMs = Date.now() - start;

  // Triage decisions can be passed in explicitly or implicitly loaded from
  // <lockfile-dir>/.pkgxray.lock. Explicit takes precedence; pass false to
  // disable lookup entirely (used internally to avoid recursion).
  let triageDecisions = options.triageDecisions;
  if (triageDecisions === undefined) {
    try {
      const { loadDecisionsSync, lockPathForLockfile } = require("./triage");
      triageDecisions = loadDecisionsSync(lockPathForLockfile(filePath));
    } catch {
      triageDecisions = new Map();
    }
  } else if (triageDecisions === false || triageDecisions === null) {
    triageDecisions = new Map();
  }

  const results = [];
  for (let i = 0; i < queries.length; i += 1) {
    const dep = queries[i];
    const osv = osvResults[i] || {};
    const vulns = Array.isArray(osv.vulns) ? osv.vulns : [];
    let decision = vulns.length > 0 ? "block" : "safe";
    let triaged = false;
    const triageKey = `${dep.name}@${dep.version}`;
    const triageEntry = triageDecisions && triageDecisions.get
      ? triageDecisions.get(triageKey)
      : undefined;
    if (triageEntry) {
      triaged = true;
      if (triageEntry.decision === "allow") {
        // Allowed packages do not contribute to the block count regardless of
        // OSV findings.
        decision = "safe";
      } else if (triageEntry.decision === "block") {
        // Block stays block; if OSV said safe, still surface as block.
        decision = "block";
      }
    }
    results.push({
      name: dep.name,
      version: dep.version,
      paths: dep.paths.slice(0, 3),
      decision,
      vulnerabilities: vulns.map((v) => ({ id: v.id, aliases: v.aliases || [] })),
      deep: null,
      triaged
    });
  }

  // --deep: for any package OSV blocked (or, configurably, every package),
  // run full guardExtension to surface richer bands. Bounded concurrency
  // keeps it fast on large lockfiles.
  let deepMs = 0;
  if (options.deep) {
    const deepStart = Date.now();
    const targets = options.deepAll
      ? results
      : results.filter((r) => r.decision === "block");
    await runDeep(targets, options);
    deepMs = Date.now() - deepStart;
  }

  // Re-tally after possible upgrades from deep mode (e.g. OSV missed it but
  // static heuristics fired).
  let blocked = 0;
  let reviewed = 0;
  let safe = 0;
  for (const r of results) {
    if (r.decision === "block") blocked += 1;
    else if (r.decision === "review") reviewed += 1;
    else safe += 1;
  }

  return {
    schemaVersion: 1,
    file: filePath,
    format,
    totalDeps: queries.length,
    uniqueDeps: queries.length,
    timings: { osvMs, deepMs, totalMs: Date.now() - start },
    summary: { safe, reviewed, blocked },
    worstDecision: blocked > 0 ? "block" : reviewed > 0 ? "review" : "safe",
    results
  };
}

async function runDeep(results, options) {
  if (results.length === 0) return;
  // Lazy-require to avoid a cycle (lockfile -> quarantine -> lockfile).
  const { guardExtension } = require("./quarantine");
  const queue = results.slice();
  const workers = Array.from({ length: Math.min(DEEP_CONCURRENCY, queue.length) }, () => worker());
  await Promise.all(workers);

  async function worker() {
    while (queue.length > 0) {
      const r = queue.shift();
      try {
        const result = await guardExtension(`npm:${r.name}@${r.version}`, {
          vulnerabilityCheck: false, // already done by the lockfile pass
          githubMetadata: options.githubMetadata !== false,
          githubDiff: false, // diff is the slow path; skip in deep-mode aggregate
          quarantineRoot: options.quarantineRoot
        });
        r.deep = {
          verdict: result.report.verdict,
          grade: result.report.grade,
          riskBands: result.report.riskBands || []
        };
        // Upgrade the decision if deep found something worse than OSV did.
        if (result.report.verdict === "block" && r.decision !== "block") {
          r.decision = "block";
        } else if (result.report.verdict === "review" && r.decision === "safe") {
          r.decision = "review";
        }
      } catch (error) {
        r.deep = { error: error.message };
      }
    }
  }
}

module.exports = {
  auditLockfile,
  parseLockfile,
  detectFormat,
  batchOsvQuery
};
