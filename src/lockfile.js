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
  // Berry npm-alias: "aliased@npm:realpkg@^1.0.0" — OSV must vet the REAL
  // published package (realpkg), NOT the local alias. The `version "X"` line
  // gives the resolved version, so we only need the true name here.
  const npmAt = spec.indexOf("@npm:");
  if (npmAt !== -1) {
    const target = spec.slice(npmAt + "@npm:".length); // "realpkg@^1.0.0" or "1.2.3"
    // Two shapes: `name@npm:VERSION` (same package, npm protocol) vs
    // `alias@npm:realpkg@RANGE` (an alias to a DIFFERENT published package).
    // A leading digit or range operator means it's a bare version → the true
    // name is the alias part before @npm:. Otherwise the target names the real
    // published package to vet.
    if (/^[\d~^><=v]/.test(target)) {
      return spec.slice(0, npmAt) || null;
    }
    const at = target.startsWith("@") ? target.indexOf("@", 1) : target.indexOf("@");
    const realName = at === -1 ? target : target.slice(0, at);
    return realName || null;
  }
  const at = spec.startsWith("@")
    ? spec.indexOf("@", 1)
    : spec.indexOf("@");
  if (at === -1) return null;
  return spec.slice(0, at);
}

function parsePnpmLockfile(text) {
  // pnpm-lock.yaml is YAML; rather than pull in a yaml parser we scrape the
  // package keys under `packages:` and (v9) `snapshots:`. The key shape drifted
  // across lockfile versions:
  //   v5:  `/lodash/4.17.21:`              (leading slash, name/version)
  //   v6:  `/lodash@4.17.21:`              (leading slash, name@version)
  //   v9:  `lodash@4.17.21:`               (NO slash — pnpm 9 default)
  //        `'@scope/pkg@1.0.0':`           (scoped, single-quoted)
  // Any of these may carry a `(peer@x)` suffix and may be single-quoted. v9
  // lists each dep in both `packages:` and `snapshots:`, so we de-dupe via the
  // shared `add` helper keyed on name@version.
  const deps = new Map();
  // Line-oriented: a package key is an indented line ending in `:` (no value).
  const keyLine = /^\s+(['"]?)([^\s].*?)\1:\s*$/;
  for (const raw of text.split("\n")) {
    const m = raw.match(keyLine);
    if (!m) continue;
    let key = m[2].trim();
    if (!key) continue;
    // Skip the section headers / metadata keys and anything that is clearly not
    // a package spec (contains no version separator once normalised).
    const parsed = parsePnpmKey(key);
    if (!parsed) continue;
    add(deps, parsed.name, parsed.version, [`${parsed.name}@${parsed.version}`]);
  }
  return deps;
}

// Parse a single pnpm package key into { name, version }, or null if it is not
// a package spec. Handles optional leading slash, the v5 `name/version` form,
// the v6/v9 `name@version` form, scoped names, and a trailing `(peer)` suffix.
function parsePnpmKey(key) {
  // Drop a trailing peer-deps suffix: `foo@1.0.0(react@18.0.0)` -> `foo@1.0.0`.
  let s = key.replace(/\(.*\)\s*$/, "").trim();
  // Optional leading slash (v5/v6).
  const hadSlash = s.startsWith("/");
  if (hadSlash) s = s.slice(1);
  if (!s) return null;

  // Scope prefix (@scope/...) is a name component, not a version separator.
  let scope = "";
  if (s.startsWith("@")) {
    const slash = s.indexOf("/");
    if (slash === -1) return null;
    scope = s.slice(0, slash + 1);
    s = s.slice(slash + 1);
  }

  // v6/v9 use `@` between name and version; v5 uses `/`.
  let name;
  let version;
  const at = s.indexOf("@");
  if (at > 0) {
    name = scope + s.slice(0, at);
    version = s.slice(at + 1);
  } else {
    // v5 `name/version` (only meaningful when there was a leading slash form).
    const slash = s.lastIndexOf("/");
    if (slash <= 0) return null;
    name = scope + s.slice(0, slash);
    version = s.slice(slash + 1);
  }
  version = version.trim();
  name = name.trim();
  // A version must look like a version (start with a digit) — this rejects
  // section headers or nested keys that happen to end in `:`.
  if (!name || !/^\d/.test(version)) return null;
  return { name, version };
}

function parsePackageJson(text) {
  const json = JSON.parse(text);
  const deps = new Map();
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const entries = json[section] || {};
    for (const [name, rawVersion] of Object.entries(entries)) {
      const resolved = resolvePackageJsonSpec(name, String(rawVersion));
      if (!resolved) continue; // nothing meaningful to record
      if (resolved.unresolved) {
        // A spec OSV can't resolve (workspace/catalog/url/git/file). Surface it
        // so it is NOT silently counted as clean — but never emit a bogus
        // pinned version that would read "safe".
        addUnresolved(deps, resolved.name, resolved.spec, [section], resolved.kind);
        continue;
      }
      add(deps, resolved.name, resolved.version, [section]);
    }
  }
  return deps;
}

// Map a package.json dependency spec to a resolvable { name, version } for OSV,
// or mark it unresolved. Handles npm aliases and non-registry protocols.
function resolvePackageJsonSpec(declaredName, rawVersion) {
  const raw = rawVersion.trim();
  if (!raw) return null;

  // npm alias: `npm:realpkg@^1.2.3` — OSV must vet the REAL published package,
  // not the local alias name. `npm:realpkg` (no version) resolves to the range
  // "latest", which OSV can't pin, so treat that as unresolved.
  if (raw.startsWith("npm:")) {
    const target = raw.slice(4);
    const at = target.startsWith("@") ? target.indexOf("@", 1) : target.indexOf("@");
    if (at > 0) {
      const realName = target.slice(0, at);
      const version = stripRange(target.slice(at + 1));
      if (realName && version) return { name: realName, version };
    }
    // Aliased but unpinnable — surface under the real name if we have one.
    const realName = at > 0 ? target.slice(0, at) : target;
    return { unresolved: true, name: realName || declaredName, spec: raw, kind: "alias" };
  }

  // Non-registry protocols OSV cannot query. Don't emit a bogus pinned version.
  if (
    raw.startsWith("workspace:") || raw.startsWith("catalog:") ||
    raw.startsWith("file:") || raw.startsWith("link:") || raw.startsWith("portal:") ||
    raw.startsWith("github:") || raw.startsWith("git+") || raw.startsWith("git:") ||
    /^https?:\/\//.test(raw) || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(raw)
  ) {
    return { unresolved: true, name: declaredName, spec: raw, kind: "protocol" };
  }

  const version = stripRange(raw);
  if (!version) return { unresolved: true, name: declaredName, spec: raw, kind: "unpinnable" };
  return { name: declaredName, version };
}

// Strip the common range prefixes so OSV gets something resolvable. Returns ""
// when what's left isn't a concrete-enough version (e.g. "*", "latest").
function stripRange(range) {
  const v = String(range).replace(/^[~^>=<\s]+/, "").trim();
  if (!v || v === "*" || v === "latest" || v === "x") return "";
  return v;
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

// Record a dep that cannot be OSV-queried (npm alias without a pin, workspace,
// catalog, url, git or file spec). It is flagged `unresolved` so the audit
// surfaces it as not-vetted rather than silently counting it clean. Keyed on
// the raw spec so distinct unresolved specs don't collide.
function addUnresolved(deps, name, spec, paths, kind) {
  const key = `${name}@${spec}`;
  const existing = deps.get(key);
  if (existing) {
    if (paths) existing.paths.push(...paths);
    return;
  }
  deps.set(key, {
    name,
    version: spec,
    paths: paths || [],
    unresolved: true,
    unresolvedKind: kind || "unresolved"
  });
}

// ---------------------------------------------------------------------------
// Batch OSV
// ---------------------------------------------------------------------------

const https = require("node:https");

// Lockfiles >1000 deps fan out into multiple OSV chunks; keep-alive lets the
// second + third chunks reuse the first chunk's TLS session.
const OSV_AGENT = new https.Agent({ keepAlive: true, maxSockets: 10 });

function batchOsvQuery(deps) {
  // Unresolved specs (workspace/catalog/url/git/alias-without-pin) carry a raw
  // spec in `version` that OSV cannot resolve — querying them would come back
  // empty and read "safe". Skip them here; the audit surfaces them separately.
  const queries = Array.from(deps.values())
    .filter((d) => !d.unresolved)
    .map((d) => ({
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
  if (Array.isArray(options.osvResults)) {
    // Test/injection hook: pre-computed OSV results, index-aligned with the
    // RESOLVED (non-unresolved) deps, in dep-map order. Lets callers exercise
    // the vuln/triage decision logic without hitting the network.
    osvResults = options.osvResults;
  } else if (options.vulnerabilityCheck !== false) {
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
  // osvResults are index-aligned with the RESOLVED deps only (batchOsvQuery
  // skips unresolved specs), so walk a separate cursor for OSV lookups.
  let osvIndex = 0;
  for (let i = 0; i < queries.length; i += 1) {
    const dep = queries[i];

    if (dep.unresolved) {
      // Not OSV-queryable (workspace/catalog/url/git/alias-without-pin). Do NOT
      // count it clean — surface it as review/not-vetted so it is visible.
      results.push({
        name: dep.name,
        version: dep.version,
        paths: dep.paths.slice(0, 3),
        decision: "review",
        vulnerabilities: [],
        unresolved: true,
        unresolvedKind: dep.unresolvedKind || "unresolved",
        deep: null,
        triaged: false
      });
      continue;
    }

    const osv = osvResults[osvIndex] || {};
    osvIndex += 1;
    const vulns = Array.isArray(osv.vulns) ? osv.vulns : [];
    const osvBlocked = vulns.length > 0;
    let decision = osvBlocked ? "block" : "safe";
    let triaged = false;
    const triageKey = `${dep.name}@${dep.version}`;
    const triageEntry = triageDecisions && triageDecisions.get
      ? triageDecisions.get(triageKey)
      : undefined;
    if (triageEntry) {
      triaged = true;
      if (triageEntry.decision === "allow") {
        // A stored `allow` may quiet static/deep heuristics, but it must NEVER
        // suppress a FRESH known-vulnerability finding from OSV. Otherwise
        // anyone who can commit .pkgxray.lock could drop an `allow` and neuter
        // the scan. OSV block wins; only when OSV is clean does the allow hold.
        decision = osvBlocked ? "block" : "safe";
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
  const { mapPool } = require("./pool");
  await mapPool(results, Math.min(DEEP_CONCURRENCY, results.length), async (r) => {
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
  });
}

// ---------------------------------------------------------------------------
// Markdown renderer — extracted so both the CLI and the MCP server can render
// the same `auditLockfile` result without duplicating the implementation.
// ---------------------------------------------------------------------------

// SECURITY: attacker-controlled strings (package names from a hostile
// lockfile, OSV vulnerability summaries, deep-scan band labels) reach this
// renderer's stdout. Without scrubbing, a name like "foo\x1b[2K\x1b[Aevil"
// rewrites the previous line of output. Strip every C0 control (0x00-0x1f),
// DEL (0x7f), and the C1 range (0x80-0x9f) — leaving newlines/tabs alone
// breaks lockfile names across rows so we drop those too. U+FFFD as the
// placeholder.
function sanitizeForTerminal(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(
    /[\x00-\x1f\x7f-\x9f]/g,
    "�"
  );
}

function renderLockfileMarkdown(result) {
  const lines = [];
  lines.push(`Lockfile: \`${sanitizeForTerminal(result.file)}\` (${result.format})`);
  lines.push(`Total deps: ${result.totalDeps}  ·  scan time: ${result.timings.totalMs} ms`);
  lines.push("");
  lines.push(`Decision: **${result.worstDecision.toUpperCase()}**`);
  lines.push(`  safe: ${result.summary.safe}  ·  review: ${result.summary.reviewed}  ·  block: ${result.summary.blocked}`);
  lines.push("");
  const blocked = result.results.filter((r) => r.decision === "block");
  if (blocked.length > 0) {
    lines.push("Blocked packages:");
    for (const r of blocked.slice(0, 25)) {
      const vulnIds = r.vulnerabilities.map((v) => sanitizeForTerminal(v.id)).join(", ");
      const triagedTag = r.triaged ? " _(triaged)_" : "";
      const name = sanitizeForTerminal(r.name);
      const version = sanitizeForTerminal(r.version);
      lines.push(`- **${name}@${version}**${triagedTag} — ${vulnIds || "OSV vulnerabilities"}`);
      if (r.paths.length > 0) {
        lines.push(`  pulled in by: ${sanitizeForTerminal(r.paths[0])}`);
      }
      if (r.deep && r.deep.riskBands && r.deep.riskBands.length > 0) {
        const bands = r.deep.riskBands
          .filter((b) => b.severity === "high" || b.severity === "medium")
          .map((b) => `${sanitizeForTerminal(b.severity)[0].toUpperCase()}:${sanitizeForTerminal(b.label)}`)
          .join(", ");
        if (bands) lines.push(`  deep scan: ${bands}`);
      }
    }
    if (blocked.length > 25) {
      lines.push(`  ...and ${blocked.length - 25} more`);
    }
  } else {
    lines.push("No blocked packages.");
  }
  if (result.timings.deepMs > 0) {
    lines.push("");
    lines.push(`Deep-scan added ${result.timings.deepMs} ms`);
  }
  return lines.join("\n");
}

module.exports = {
  auditLockfile,
  parseLockfile,
  detectFormat,
  batchOsvQuery,
  renderLockfileMarkdown,
  sanitizeForTerminal
};
