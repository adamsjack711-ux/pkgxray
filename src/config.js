"use strict";

// ---------------------------------------------------------------------------
// Shared configuration: `.pkgxray.json`
//
// One human-authored policy file, read by EVERY surface (CLI guard/audit,
// the MCP server, the proxy, the hook) so customization can never drift
// per-surface. It is deliberately distinct from `.pkgxray.lock`, which records
// machine state (computed verdicts, triage decisions, MCP pins); this file is
// *intent*.
//
// The governing rule is: tighten freely, loosen loudly.
//   • Zero config is fully safe — an empty/absent file = maximum strictness.
//   • You may make the policy STRICTER without limit.
//   • You may LOOSEN it (allow a package, mute a check) only explicitly, and
//     every loosening is surfaced in the report — never silent.
//
// Two invariants are structural, not conventions:
//   1. An `allow` entry MUST be pinned to `name@version` + `sha256`. A bare
//      name would blanket-trust every future version — exactly how a trojaned
//      update walks in. Un-pinned allows are dropped with a warning.
//   2. A published vulnerability (OSV `known-vulnerability`) can NEVER be muted
//      or allowed away. You can vouch for a package's code; you cannot vouch
//      away a CVE.
//
// Precedence (lowest -> highest):
//   DEFAULTS < project .pkgxray.json < local .pkgxray.local.json < overrides
// `allow`/`mute` lists CONCATENATE across layers (local adds personal entries);
// scalars are replaced.
// ---------------------------------------------------------------------------

const fs = require("node:fs");
const path = require("node:path");
const { decideVerdict } = require("./auditor");

const CONFIG_FILENAME = ".pkgxray.json";
const LOCAL_CONFIG_FILENAME = ".pkgxray.local.json";
const SCHEMA_VERSION = 1;

const VALID_POLICIES = new Set(["safe-only", "allow-review"]);
const VALID_FAIL_ON = new Set(["block", "review", "never"]);
const VALID_SCAN_ERROR = new Set(["fail-closed", "fail-open"]);

// Findings a human can never vouch away — a published vulnerability is not a
// matter of opinion. Mutes and allowlist entries are refused against these.
const IMMUTABLE_CATEGORIES = new Set(["known-vulnerability"]);

const DEFAULT_MCP = Object.freeze({
  tools: null, // null = expose all tools
  policy: "safe-only",
  packageScanFirst: true,
  timeoutMs: 15000
});

const DEFAULTS = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  policy: "safe-only",
  // CI exit threshold: fail the run at this verdict or worse. "review" (default)
  // is fail-closed for CI; "block" only fails on hard blocks; "never" never
  // fails on the verdict.
  failOn: "review",
  // What to do when a scan itself errors / times out. Default fail-closed:
  // an un-completable scan is treated as review, never silently safe.
  scanErrorPolicy: "fail-closed",
  allow: [],
  mute: [],
  mcp: DEFAULT_MCP
});

// --- loading ---------------------------------------------------------------

// Walk up from startDir to the filesystem root, returning the directory of the
// nearest file named `filename`, or null. Bounded by the natural root.
function findUp(filename, startDir) {
  let dir = path.resolve(startDir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (fs.existsSync(path.join(dir, filename))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readJsonFile(file, warnings) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      warnings.push(`could not read ${file}: ${err.message}`);
    }
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnings.push(`${file}: expected a JSON object, ignoring`);
      return null;
    }
    return parsed;
  } catch (err) {
    // A malformed config is a LOUD failure, never a silent fall-back to a
    // weaker policy — but we still return null so the safe DEFAULTS apply.
    warnings.push(`${file}: invalid JSON (${err.message}); using safe defaults`);
    return null;
  }
}

// Load and validate the effective config.
//   opts.cwd       — where to start the find-up walk (default process.cwd())
//   opts.overrides — highest-precedence scalar overrides (CLI flags)
//   opts.env       — environment object (default process.env)
// Returns { config, warnings, sources }.
function loadConfig(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const env = opts.env || process.env;
  const warnings = [];
  const sources = [];

  const layers = [];

  const projectDir = findUp(CONFIG_FILENAME, cwd);
  if (projectDir) {
    const file = path.join(projectDir, CONFIG_FILENAME);
    const raw = readJsonFile(file, warnings);
    if (raw) {
      layers.push(raw);
      sources.push(file);
    }
  }
  // Local override sits next to the project file (or in cwd if there's no
  // project file). Meant to be gitignored — personal, not team-shared.
  const localDir = projectDir || cwd;
  const localFile = path.join(localDir, LOCAL_CONFIG_FILENAME);
  const localRaw = readJsonFile(localFile, warnings);
  if (localRaw) {
    layers.push(localRaw);
    sources.push(localFile);
  }

  const fromEnv = readEnv(env);
  if (Object.keys(fromEnv).length > 0) layers.push(fromEnv);

  const overrides = stripUndefined(opts.overrides || {});
  if (Object.keys(overrides).length > 0) layers.push(overrides);

  const merged = mergeLayers(layers);
  const config = validateConfig(merged, warnings);
  return { config, warnings, sources };
}

function readEnv(env) {
  const out = {};
  if (env.PKGXRAY_POLICY) out.policy = env.PKGXRAY_POLICY;
  if (env.PKGXRAY_FAIL_ON) out.failOn = env.PKGXRAY_FAIL_ON;
  if (env.PKGXRAY_SCAN_ERROR_POLICY) out.scanErrorPolicy = env.PKGXRAY_SCAN_ERROR_POLICY;
  return out;
}

function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

// Merge config layers. Scalars replace; `allow`/`mute` arrays concatenate; the
// `mcp` object shallow-merges.
function mergeLayers(layers) {
  const merged = { allow: [], mute: [], mcp: {} };
  for (const layer of layers) {
    if (!layer || typeof layer !== "object") continue;
    for (const [k, v] of Object.entries(layer)) {
      if (k === "allow" || k === "mute") {
        if (Array.isArray(v)) merged[k] = merged[k].concat(v);
      } else if (k === "mcp") {
        if (v && typeof v === "object") merged.mcp = { ...merged.mcp, ...v };
      } else {
        merged[k] = v;
      }
    }
  }
  return merged;
}

// --- validation ------------------------------------------------------------

function validateEnum(value, valid, fallback, label, warnings) {
  if (value === undefined) return fallback;
  if (typeof value === "string" && valid.has(value)) return value;
  warnings.push(`${label}: "${value}" is not one of ${[...valid].join(" | ")}; using "${fallback}"`);
  return fallback;
}

const NAME_AT_VERSION_RE = /^(@?[^@\s]+)@([^@\s]+)$/;

// An allow entry is honored ONLY if fully pinned: name@version + a non-empty
// sha256. Anything less is dropped with a warning (invariant #1).
function validateAllowEntry(entry, warnings) {
  if (!entry || typeof entry !== "object") {
    warnings.push("allow: entry is not an object; ignored");
    return null;
  }
  const m = typeof entry.pkg === "string" ? entry.pkg.match(NAME_AT_VERSION_RE) : null;
  if (!m) {
    warnings.push(`allow: "${entry.pkg}" must be pinned as name@version; ignored`);
    return null;
  }
  if (typeof entry.sha256 !== "string" || entry.sha256.trim() === "") {
    warnings.push(`allow: ${entry.pkg} has no sha256 pin; ignored (a bare-name/version allow would trust future bytes)`);
    return null;
  }
  return {
    name: m[1],
    version: m[2],
    pkg: entry.pkg,
    sha256: entry.sha256.trim().toLowerCase(),
    reason: typeof entry.reason === "string" ? entry.reason : "",
    expires: typeof entry.expires === "string" ? entry.expires : null
  };
}

function validateMuteEntry(entry, warnings) {
  if (!entry || typeof entry !== "object") {
    warnings.push("mute: entry is not an object; ignored");
    return null;
  }
  if (typeof entry.check !== "string" || entry.check.trim() === "") {
    warnings.push("mute: entry has no `check` category; ignored");
    return null;
  }
  if (IMMUTABLE_CATEGORIES.has(entry.check)) {
    warnings.push(`mute: "${entry.check}" can never be muted (published vulnerabilities always surface); ignored`);
    return null;
  }
  return {
    check: entry.check,
    scope: typeof entry.scope === "string" && entry.scope ? entry.scope : "*",
    files: typeof entry.files === "string" && entry.files ? entry.files : null,
    reason: typeof entry.reason === "string" ? entry.reason : ""
  };
}

function validateMcp(raw, warnings) {
  const mcp = { ...DEFAULT_MCP };
  if (!raw || typeof raw !== "object") return mcp;
  if (raw.tools !== undefined) {
    if (Array.isArray(raw.tools) && raw.tools.every((t) => typeof t === "string")) {
      mcp.tools = raw.tools.slice();
    } else if (raw.tools !== null) {
      warnings.push("mcp.tools: expected an array of tool names or null; exposing all tools");
    }
  }
  mcp.policy = validateEnum(raw.policy, VALID_POLICIES, DEFAULT_MCP.policy, "mcp.policy", warnings);
  if (raw.packageScanFirst !== undefined) {
    mcp.packageScanFirst = raw.packageScanFirst !== false; // default true; only explicit false disables
    if (raw.packageScanFirst === false) {
      warnings.push("mcp.packageScanFirst: disabled — servers will be connected without a static package scan first");
    }
  }
  if (raw.timeoutMs !== undefined) {
    const n = Number(raw.timeoutMs);
    if (Number.isFinite(n) && n > 0) mcp.timeoutMs = n;
    else warnings.push(`mcp.timeoutMs: "${raw.timeoutMs}" is not a positive number; using ${DEFAULT_MCP.timeoutMs}`);
  }
  return mcp;
}

function validateConfig(raw, warnings) {
  const config = {
    schemaVersion: SCHEMA_VERSION,
    policy: validateEnum(raw.policy, VALID_POLICIES, DEFAULTS.policy, "policy", warnings),
    failOn: validateEnum(raw.failOn, VALID_FAIL_ON, DEFAULTS.failOn, "failOn", warnings),
    scanErrorPolicy: validateEnum(
      raw.scanErrorPolicy,
      VALID_SCAN_ERROR,
      DEFAULTS.scanErrorPolicy,
      "scanErrorPolicy",
      warnings
    ),
    allow: [],
    mute: [],
    mcp: validateMcp(raw.mcp, warnings)
  };
  if (config.policy === "allow-review") {
    warnings.push('policy "allow-review" promotes review-grade packages — this is a loosening of the default safe-only.');
  }
  for (const entry of Array.isArray(raw.allow) ? raw.allow : []) {
    const v = validateAllowEntry(entry, warnings);
    if (v) config.allow.push(v);
  }
  for (const entry of Array.isArray(raw.mute) ? raw.mute : []) {
    const v = validateMuteEntry(entry, warnings);
    if (v) config.mute.push(v);
  }
  return config;
}

// --- applying config to a report -------------------------------------------

function globToRegExp(glob) {
  const escaped = String(glob).replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + escaped + "$");
}

function globMatches(glob, value) {
  if (glob === "*") return true;
  return globToRegExp(glob).test(String(value == null ? "" : value));
}

function findMuteFor(mutes, finding, packageName) {
  for (const mute of mutes) {
    if (mute.check !== finding.category) continue;
    if (!globMatches(mute.scope, packageName || "")) continue;
    if (mute.files && !globMatches(mute.files, finding.file || "")) continue;
    return mute;
  }
  return null;
}

function findAllowFor(allows, packageName, version, sha256, nowMs) {
  for (const allow of allows) {
    if (allow.name !== packageName || allow.version !== version) continue;
    // The pin must match the artifact actually being scanned. No sha256 in
    // hand → we cannot confirm the bytes → the allow does not apply.
    if (!sha256 || allow.sha256 !== String(sha256).toLowerCase()) continue;
    if (allow.expires) {
      const exp = Date.parse(allow.expires);
      if (Number.isFinite(exp) && exp < nowMs) {
        return { allow, expired: true };
      }
    }
    return { allow, expired: false };
  }
  return null;
}

// Apply the effective config to an audit report. Returns a NEW report object
// with:
//   • muted findings tagged `muted:true` (kept for transparency, excluded from
//     the verdict) — so a report always SHOWS what config suppressed,
//   • the verdict re-folded over the surviving (non-muted) findings,
//   • an optional allowlist force-to-safe (pinned + unexpired, and never when a
//     known-vulnerability survives),
//   • a `configEffects` block describing every change, for rendering.
//
// context: { config, packageName, version, sha256, evidence?, now? }
function applyConfig(report, context = {}) {
  const config = context.config || DEFAULTS;
  const packageName = context.packageName || report.packageName || null;
  const version = context.version || null;
  const sha256 = context.sha256 || null;
  const nowMs = typeof context.now === "number" ? context.now : Date.now();

  const findings = Array.isArray(report.findings) ? report.findings.map((f) => ({ ...f })) : [];
  const muted = [];
  const surviving = [];
  for (const finding of findings) {
    if (IMMUTABLE_CATEGORIES.has(finding.category)) {
      surviving.push(finding);
      continue;
    }
    const mute = findMuteFor(config.mute, finding, packageName);
    if (mute) {
      finding.muted = true;
      finding.mutedReason = mute.reason || `muted by config (check=${mute.check}, scope=${mute.scope})`;
      muted.push({ category: finding.category, file: finding.file, reason: mute.reason });
      continue;
    }
    surviving.push(finding);
  }

  const effects = {
    muted,
    mutedCount: muted.length,
    allowlisted: null,
    ignoredAllow: null,
    notices: []
  };

  // Re-fold the verdict over surviving findings. Reuse the canonical
  // decideVerdict so this never drifts from the engine. sourceFiles length only
  // affects the incomplete-evidence path; pass the original evidence if the
  // caller has it, else a non-empty placeholder so we don't fabricate a review.
  const evidence = context.evidence || { sourceFiles: [{}] };
  let verdict = decideVerdict(surviving, evidence);

  // Allowlist: a pinned, unexpired allow forces safe — UNLESS a published
  // vulnerability survives (invariant #2), which no allow can wave away.
  const allowHit = findAllowFor(config.allow, packageName, version, sha256, nowMs);
  if (allowHit && allowHit.expired) {
    effects.ignoredAllow = { pkg: allowHit.allow.pkg, reason: "expired" };
    effects.notices.push(`allowlist entry ${allowHit.allow.pkg} is expired (${allowHit.allow.expires}); not applied.`);
  } else if (allowHit) {
    const survivingVuln = surviving.some((f) => IMMUTABLE_CATEGORIES.has(f.category));
    if (survivingVuln) {
      effects.ignoredAllow = { pkg: allowHit.allow.pkg, reason: "known-vulnerability" };
      effects.notices.push(
        `allowlist entry ${allowHit.allow.pkg} NOT applied: the package has a published vulnerability, which cannot be allowed away.`
      );
    } else {
      verdict = "safe";
      effects.allowlisted = {
        pkg: allowHit.allow.pkg,
        reason: allowHit.allow.reason,
        suppressedFindings: surviving.filter((f) => f.severity === "high" || f.severity === "medium").length
      };
      effects.notices.push(
        `allowlisted ${allowHit.allow.pkg}${allowHit.allow.reason ? ` (${allowHit.allow.reason})` : ""} — pinned sha256 matched; verdict forced to safe.`
      );
    }
  }

  return { ...report, findings, verdict, configEffects: effects };
}

// --- verdict / exit-code / scan-error helpers ------------------------------

const VERDICT_RANK = { safe: 0, allow: 0, review: 1, block: 2 };

// The CI exit code for a verdict under this config's failOn threshold.
// 0 = pass, 3 = review-grade fail, 2 = block-grade fail.
function exitCodeForVerdict(verdict, config) {
  const failOn = (config && config.failOn) || DEFAULTS.failOn;
  const rank = VERDICT_RANK[verdict] == null ? 1 : VERDICT_RANK[verdict];
  if (failOn === "never") return 0;
  if (failOn === "block") return rank >= 2 ? 2 : 0;
  // failOn === "review"
  if (rank >= 2) return 2;
  if (rank >= 1) return 3;
  return 0;
}

// What verdict a scan ERROR (crash / timeout / unparseable input) maps to under
// this config. Default fail-closed → review, so an un-completable scan is never
// silently safe. Callers route every error path through this.
function verdictForScanError(config) {
  return (config && config.scanErrorPolicy) === "fail-open" ? "safe" : "review";
}

// --- rendering -------------------------------------------------------------

// Lines describing what the config changed, to append to EVERY report so a
// loosening is never invisible. Returns [] when nothing was touched.
function renderConfigEffects(configEffects) {
  if (!configEffects) return [];
  const lines = [];
  if (configEffects.mutedCount > 0) {
    const detail = configEffects.muted
      .slice(0, 5)
      .map((m) => `${m.category}${m.file ? `@${m.file}` : ""}`)
      .join(", ");
    const more = configEffects.mutedCount > 5 ? `, +${configEffects.mutedCount - 5} more` : "";
    lines.push(`Config: ${configEffects.mutedCount} finding(s) muted by .pkgxray.json (${detail}${more}).`);
  }
  if (configEffects.allowlisted) {
    lines.push(
      `Config: allowlisted \`${configEffects.allowlisted.pkg}\`${
        configEffects.allowlisted.reason ? ` — ${configEffects.allowlisted.reason}` : ""
      } (pinned; verdict forced to safe).`
    );
  }
  for (const notice of configEffects.notices || []) {
    if (!configEffects.allowlisted || !notice.startsWith("allowlisted")) lines.push(`Config: ${notice}`);
  }
  return lines;
}

// --- MCP accessor ----------------------------------------------------------

// The MCP-server view of the config: the same policy, but the agent deployment
// starts stricter. `tools` filters which tools are served (null = all).
function mcpConfig(config) {
  const base = (config && config.mcp) || DEFAULT_MCP;
  return { ...DEFAULT_MCP, ...base };
}

// Whether an MCP tool name is exposed under this config.
function mcpToolAllowed(config, toolName) {
  const mcp = mcpConfig(config);
  if (!mcp.tools) return true;
  return mcp.tools.includes(toolName);
}

module.exports = {
  CONFIG_FILENAME,
  LOCAL_CONFIG_FILENAME,
  SCHEMA_VERSION,
  DEFAULTS,
  IMMUTABLE_CATEGORIES,
  loadConfig,
  validateConfig,
  applyConfig,
  exitCodeForVerdict,
  verdictForScanError,
  renderConfigEffects,
  mcpConfig,
  mcpToolAllowed,
  // exported for tests
  findAllowFor,
  findMuteFor,
  globMatches
};
