"use strict";

const { parseLockfile, sanitizeForTerminal, formatEcosystem } = require("./lockfile");
const {
  loadDecisions,
  saveDecisions,
  lockPathForLockfile,
  isStale
} = require("./triage");
const { mapPool, defaultConcurrency } = require("./pool");
const { newerCandidates } = require("./semver");
const { newerPypiCandidates } = require("./pep440");
const { compareUpgradeFindings } = require("./upgrade-diff");

// ---------------------------------------------------------------------------
// recheck — the monitoring tier.
//
// A point-in-time guard verdict answers "is this safe to install now". recheck
// answers the follow-up a point-in-time scan can't: "has anything I already
// depend on become unsafe *since I installed it*". It walks a lockfile, re-runs
// the guard evaluation against current intelligence (OSV / provenance /
// divergence) for each pinned name@version, and diffs the new verdict against
// the baseline stored in .pkgxray.lock (the `verdict`/`checkedAt` fields from
// T1).
//
// This is an orchestration layer: the verdict comes from guardExtension, the
// fan-out from the shared worker pool, the baseline from the triage lock. No
// drift logic is forked into the CLI/hook/proxy surfaces — they call this.
// ---------------------------------------------------------------------------

// Worst-fold ranking, identical to the block>review>safe ordering already used
// inline by auditLockfile. Kept as one named helper so recheck, the exit-code
// mapping, and any surface agree on "worse".
const VERDICT_RANK = { safe: 0, review: 1, block: 2 };

function verdictRank(verdict) {
  return Object.prototype.hasOwnProperty.call(VERDICT_RANK, verdict)
    ? VERDICT_RANK[verdict]
    : -1;
}

// A summary SAFE string cannot clear an explicitly incomplete guard assessment.
// Older injected evaluators may return only a verdict; when assessment metadata
// is supplied, its mandatory coverage fields must agree with that verdict.
function evaluatedVerdict(outcome) {
  const verdict = verdictRank(outcome?.verdict) >= 0 ? outcome.verdict : "unknown";
  if (verdict !== "safe" || outcome.assessment == null) return { verdict, error: null };
  const { checks, authorization } = outcome.assessment;
  const reasons = [];
  if (checks?.source !== "completed") reasons.push("source-check-incomplete");
  if (checks?.vulnerabilities !== "completed") reasons.push("vulnerability-check-incomplete");
  if (authorization?.behavioralCoverage !== "completed") reasons.push("behavioral-coverage-incomplete");
  if (!Array.isArray(authorization?.mandatoryHoldReasons) || authorization.mandatoryHoldReasons.length) reasons.push("mandatory-review-hold");
  if (checks?.provenance === "invalid") reasons.push("invalid-provenance");
  return reasons.length
    ? { verdict: "unknown", error: `SAFE verdict conflicts with guard assessment: ${reasons.join(", ")}` }
    : { verdict, error: null };
}

// Fold a list of verdicts to the worst (order-independent).
function worstVerdict(verdicts) {
  let worst = "safe";
  for (const v of verdicts) {
    if (verdictRank(v) > verdictRank(worst)) worst = v;
  }
  return worst;
}

// Classify a single dep's drift given its stored baseline and fresh verdict.
// Returns one of: "regressed" | "improved" | "unchanged" | "no-baseline"
// | "unknown". "unknown" means the recheck itself errored — we could not
// compute a fresh verdict, so nothing is asserted about safety.
function classifyDrift(baseline, fresh) {
  if (fresh === "unknown" || verdictRank(fresh) < 0) return "unknown";
  if (baseline === null || baseline === undefined || verdictRank(baseline) < 0) {
    return "no-baseline";
  }
  const delta = verdictRank(fresh) - verdictRank(baseline);
  if (delta > 0) return "regressed";
  if (delta < 0) return "improved";
  return "unchanged";
}

// Default per-dep evaluator — lazy-requires quarantine to dodge the cycle and
// so tests can inject `options.evaluate` without pulling in the network stack.
// PKGXRAY_CACHE_URL is honoured automatically: guardExtension → github.js →
// cache-client reads the env var, so a warm cache is shared with `guard`. We do
// NOT pass anything that would disable it.
function makeDefaultEvaluator(options, scheme = "npm") {
  const { guardExtension } = require("./quarantine");
  return async (dep) => {
    const result = await guardExtension(`${scheme}:${dep.name}@${dep.version}`, {
      vulnerabilityCheck: true, // OSV is the primary drift signal
      githubMetadata: options.githubMetadata !== false,
      // divergence (npm-vs-GitHub) is part of the intelligence recheck compares;
      // leave it at guardExtension's default (enabled) unless the caller opts out.
      githubDiff: options.githubDiff === true ? true : options.githubDiff,
      quarantineRoot: options.quarantineRoot,
      typosquat: options.typosquat
    });
    return { verdict: result.decision === "allow" ? "safe" : "block", report: result.report, assessment: result.assessment };
  };
}

// ---------------------------------------------------------------------------
// Version drift — newer-version pre-vetting. For each dep, ask the registry for
// versions newer than the pinned one and guard the candidate(s) so a team sees
// the security verdict BEFORE upgrading (the trojaned-update catch: an update
// that's available but flagged shouldn't be blind-installed).
//
// Informational by DEFAULT — an available flagged update you haven't installed
// isn't an active exposure, so it does NOT move the exit code unless the caller
// passes failOnAvailableUpdates. Candidates are bounded (latest + latest-in-
// major, ≤2 per dep) to keep registry/OSV cost sane.
// ---------------------------------------------------------------------------
async function versionDriftPass(depList, evaluate, options, eco = { scheme: "npm" }, baselines = new Map()) {
  const listVersions = options.listVersions || defaultListVersions(options, eco);
  // PyPI versions are PEP 440, not semver — pick the matching newer-candidate
  // comparator so a `1!2.0.post1`-style version isn't mis-ordered as garbage.
  const pickNewer = eco.scheme === "pypi" ? newerPypiCandidates : newerCandidates;
  const concurrency = options.concurrency || defaultConcurrency(depList.length);

  const results = await mapPool(depList, concurrency, async (dep) => {
    let candidates;
    try {
      const { versions } = await listVersions(dep.name);
      const picked = pickNewer(dep.version, versions || []);
      candidates = [picked.latest, picked.latestInMajor].filter(Boolean);
    } catch (err) {
      // Registry unreachable — report as unknown, not "no update available".
      return { name: dep.name, version: dep.version, error: err && err.message ? err.message : String(err), candidates: [] };
    }
    if (candidates.length === 0) {
      return { name: dep.name, version: dep.version, candidates: [] };
    }
    const vetted = [];
    for (const candidate of candidates) {
      let verdict = "unknown";
      let error = null;
      let outcome = null;
      try {
        outcome = await evaluate({ name: dep.name, version: candidate, paths: [] }, { versionDrift: true });
        ({ verdict, error } = evaluatedVerdict(outcome));
      } catch (err) {
        error = err && err.message ? err.message : String(err);
      }
      vetted.push({ version: candidate, verdict, ...(error ? { error } : {}),
        securityChanges: compareUpgradeFindings(baselines.get(`${dep.name}@${dep.version}`), outcome) });
    }
    return { name: dep.name, version: dep.version, candidates: vetted };
  });

  const available = []; // newer version exists and guards clean
  const flagged = [];   // newer version exists but is review/block
  const unknown = [];    // registry/guard errored
  for (const r of results) {
    if (r.error) {
      unknown.push(r);
      continue;
    }
    if (r.candidates.length === 0) continue; // no newer version -> nothing
    const vettedVerdicts = r.candidates.map((c) => c.verdict).filter((v) => verdictRank(v) >= 0);
    // A successful in-major scan must not hide an unvetted latest release (or
    // vice versa). Preserve known risk while surfacing partial failure too.
    const hasUnknown = vettedVerdicts.length !== r.candidates.length;
    if (hasUnknown) {
      unknown.push({
        name: r.name,
        version: r.version,
        candidates: r.candidates,
        error: vettedVerdicts.length ? "some candidates could not be vetted" : "no candidate could be vetted"
      });
    }
    if (vettedVerdicts.length === 0) continue;
    const worst = worstVerdict(vettedVerdicts);
    const entry = { name: r.name, version: r.version, candidates: r.candidates, worst };
    if (worst === "review" || worst === "block") flagged.push(entry);
    else if (!hasUnknown) available.push(entry);
  }
  return { available, flagged, unknown };
}

function defaultListVersions(options, eco = { scheme: "npm" }) {
  if (eco.scheme === "pypi") {
    const { listPypiVersions } = require("./pypi");
    return (name) => listPypiVersions(name);
  }
  const { listNpmVersions } = require("./registry");
  return (name) => listNpmVersions(name, { registry: options.registry });
}

async function recheckLockfile(lockfilePath, options = {}) {
  const { format, deps } = await parseLockfile(lockfilePath);
  // One lockfile = one ecosystem. This decides the guard scheme (npm:/pypi:),
  // the registry version-lister, and the version-drift comparator (semver vs
  // PEP 440), so a Python lockfile is never mis-scanned as npm.
  const eco = formatEcosystem(format);
  const lockPath = options.lockPath || lockPathForLockfile(lockfilePath);
  const decisions = options.decisions || (await loadDecisions(lockPath));

  const evaluate = options.evaluate || makeDefaultEvaluator(options, eco.scheme);
  const depList = Array.from(deps.values());
  const concurrency = options.concurrency || defaultConcurrency(depList.length);
  const nowIso = () => new Date().toISOString();

  // A baseline older than this (or with no checkedAt) is not trusted as the
  // drift-comparison point — a stale/crafted verdict must not hide a live block.
  // Default: any verdict lacking a checkedAt is stale; an explicit
  // baselineTtlMs also ages out old-but-timestamped verdicts.
  const baselineTtlMs = options.baselineTtlMs;

  const perDep = await mapPool(depList, concurrency, async (dep) => {
    const key = `${dep.name}@${dep.version}`;
    const record = decisions.get(key) || null;
    // Treat a stale or checkedAt-less baseline as NO baseline: recheck must not
    // trust an ancient/crafted stored verdict as the comparison point, or a live
    // block could be reported "unchanged" and hidden. isStale() returns true for
    // a missing/unparseable checkedAt (and for one older than baselineTtlMs).
    const baselineStale = !record || isStale(record, baselineTtlMs);
    const baseline = record && !baselineStale ? record.verdict : null;

    let fresh = "unknown";
    let error = null;
    let report = null;
    let assessment = null;
    try {
      const outcome = await evaluate(dep, { record });
      ({ verdict: fresh, error } = evaluatedVerdict(outcome));
      report = outcome ? outcome.report || null : null;
      assessment = outcome ? outcome.assessment || null : null;
    } catch (err) {
      fresh = "unknown";
      error = err && err.message ? err.message : String(err);
    }

    const drift = classifyDrift(baseline, fresh);

    return {
      name: dep.name,
      version: dep.version,
      paths: dep.paths ? dep.paths.slice(0, 1) : [],
      baseline,           // stored verdict (may be null)
      verdict: fresh,     // fresh verdict, or "unknown" on error
      drift,
      checkedAt: record ? record.checkedAt : null, // baseline age
      decision: record ? record.decision : null,   // human triage choice, if any
      error,
      report,
      assessment
    };
  });

  // Write back fresh baselines. An errored ("unknown") recheck must NEVER
  // overwrite a good stored verdict — we only touch records we could actually
  // re-evaluate, and only records that already exist (recheck does not fabricate
  // a human allow/block decision for an untriaged dep).
  let updated = 0;
  if (options.write !== false) {
    const when = nowIso();
    for (const d of perDep) {
      if (d.verdict === "unknown") continue;
      const key = `${d.name}@${d.version}`;
      const record = decisions.get(key);
      if (!record) continue;
      record.verdict = d.verdict;
      record.checkedAt = when;
      updated += 1;
    }
    if (updated > 0) {
      await saveDecisions(lockPath, decisions);
    }
  }

  const buckets = { regressed: [], improved: [], unchanged: [], noBaseline: [], unknown: [] };
  for (const d of perDep) {
    if (d.drift === "regressed") buckets.regressed.push(d);
    else if (d.drift === "improved") buckets.improved.push(d);
    else if (d.drift === "no-baseline") buckets.noBaseline.push(d);
    else if (d.drift === "unknown") buckets.unknown.push(d);
    else buckets.unchanged.push(d);
  }

  // Version drift — informational newer-version pre-vetting. On by default;
  // skip with { versionDrift: false }.
  let versionDrift = { available: [], flagged: [], unknown: [] };
  if (options.versionDrift !== false) {
    const freshBaselines = new Map(perDep.map(dep => [`${dep.name}@${dep.version}`, dep]));
    versionDrift = await versionDriftPass(depList, evaluate, options, eco, freshBaselines);
  }

  // Exit code keys off the worst *regression* target — not the worst absolute
  // verdict. A dep that was block at install and is still block is not a NEW
  // regression and must not fail a monitoring run.
  const regressionTargets = buckets.regressed.map((d) => d.verdict);
  const worstRegression = buckets.regressed.length > 0 ? worstVerdict(regressionTargets) : null;
  let exitCode = worstRegression === "block" ? 2 : worstRegression === "review" ? 3 : 0;

  // Version drift stays OUT of the exit code by default (an available flagged
  // update isn't an active exposure). Only fold it in when explicitly asked.
  if (options.failOnAvailableUpdates && versionDrift.flagged.length > 0) {
    const worstFlagged = worstVerdict(versionDrift.flagged.map((f) => f.worst));
    const flaggedExit = worstFlagged === "block" ? 2 : worstFlagged === "review" ? 3 : 0;
    // Worst (lowest-tolerance) exit wins: block(2) over review(3) over ok(0).
    exitCode = mergeExit(exitCode, flaggedExit);
  }
  if (options.failOnAvailableUpdates && versionDrift.unknown.length > 0) {
    exitCode = mergeExit(exitCode, 3);
  }

  return {
    schemaVersion: 1,
    file: lockfilePath,
    format,
    lockPath,
    totalDeps: depList.length,
    updated,
    buckets,
    versionDrift,
    counts: {
      regressed: buckets.regressed.length,
      improved: buckets.improved.length,
      unchanged: buckets.unchanged.length,
      noBaseline: buckets.noBaseline.length,
      unknown: buckets.unknown.length,
      updateAvailableSafe: versionDrift.available.length,
      updateAvailableFlagged: versionDrift.flagged.length
    },
    worstRegression,
    exitCode
  };
}

// Merge two exit codes where 2 (block) is worst, then 3 (review), then 0 (ok).
function mergeExit(a, b) {
  const sev = (c) => (c === 2 ? 2 : c === 3 ? 1 : 0);
  return sev(a) >= sev(b) ? a : b;
}

// ---------------------------------------------------------------------------
// Renderers. Concise diff by default — regressed is the actionable bucket.
// ---------------------------------------------------------------------------

function driftArrow(d) {
  const from = d.baseline || "unknown";
  return `${sanitizeForTerminal(from)} → ${sanitizeForTerminal(d.verdict)}`;
}

function renderRecheckText(result, options = {}) {
  result = require("./automatic-flow").toBinaryResult(result);
  const verbose = Boolean(options.verbose);
  const lines = [];
  lines.push(`Recheck: \`${sanitizeForTerminal(result.file)}\` (${result.format}) — ${result.totalDeps} pinned dep(s)`);
  const c = result.counts;
  lines.push(
    `  regressed: ${c.regressed}  ·  improved: ${c.improved}  ·  unchanged: ${c.unchanged}` +
    `  ·  no-baseline: ${c.noBaseline}  ·  unknown: ${c.unknown}`
  );
  lines.push("");

  if (result.buckets.regressed.length > 0) {
    lines.push("REGRESSED (verdict got worse since checkedAt — you may already be exposed):");
    for (const d of result.buckets.regressed) {
      const since = d.checkedAt ? ` (baseline ${sanitizeForTerminal(d.checkedAt)})` : "";
      lines.push(`- ${sanitizeForTerminal(d.name)}@${sanitizeForTerminal(d.version)}  ${driftArrow(d)}${since}`);
    }
    lines.push("");
  } else {
    lines.push("No verdict regressions observed in completed baseline comparisons.");
    lines.push("");
  }

  if (result.buckets.improved.length > 0) {
    lines.push("Improved:");
    for (const d of result.buckets.improved) {
      lines.push(`- ${sanitizeForTerminal(d.name)}@${sanitizeForTerminal(d.version)}  ${driftArrow(d)}`);
    }
    lines.push("");
  }

  if (result.buckets.unknown.length > 0) {
    lines.push("Unknown (recheck could not evaluate — stored verdict left untouched):");
    for (const d of result.buckets.unknown) {
      const why = d.error ? ` — ${sanitizeForTerminal(d.error)}` : "";
      lines.push(`- ${sanitizeForTerminal(d.name)}@${sanitizeForTerminal(d.version)}${why}`);
    }
    lines.push("");
  }

  if (verbose && result.buckets.unchanged.length > 0) {
    lines.push("Unchanged:");
    for (const d of result.buckets.unchanged) {
      lines.push(`- ${sanitizeForTerminal(d.name)}@${sanitizeForTerminal(d.version)}  (${sanitizeForTerminal(d.verdict)})`);
    }
    lines.push("");
  }

  const vd = result.versionDrift || { available: [], flagged: [], unknown: [] };
  if (vd.flagged.length > 0) {
    lines.push("UPDATE AVAILABLE BUT BLOCKED (newer version has findings or incomplete checks):");
    for (const f of vd.flagged) {
      const cs = f.candidates
        .map((c) => `${sanitizeForTerminal(c.version)}=${sanitizeForTerminal(c.verdict)}`)
        .join(", ");
      lines.push(`- ${sanitizeForTerminal(f.name)} (pinned ${sanitizeForTerminal(f.version)}) → ${cs}`);
    }
    lines.push("");
  }
  if (verbose && vd.available.length > 0) {
    lines.push("Update available (guards clean):");
    for (const a of vd.available) {
      const newest = a.candidates[0] ? sanitizeForTerminal(a.candidates[0].version) : "";
      lines.push(`- ${sanitizeForTerminal(a.name)} (pinned ${sanitizeForTerminal(a.version)}) → ${newest}`);
    }
    lines.push("");
  }
  if (vd.unknown.length > 0) {
    lines.push("UPDATE CHECK INCOMPLETE (these releases are not cleared for upgrade):");
    for (const update of vd.unknown) {
      const candidates = update.candidates.map(candidate => `${sanitizeForTerminal(candidate.version)}=${sanitizeForTerminal(candidate.verdict)}`).join(", ");
      lines.push(`- ${sanitizeForTerminal(update.name)} (pinned ${sanitizeForTerminal(update.version)})${candidates ? ` → ${candidates}` : ""} — ${sanitizeForTerminal(update.error)}`);
    }
    lines.push("");
  }
  const displayed = new Set();
  for (const update of [...vd.flagged, ...vd.available, ...vd.unknown]) {
    for (const candidate of update.candidates) {
      const key = `${update.name}@${update.version}->${candidate.version}`;
      if (displayed.has(key)) continue;
      displayed.add(key);
      const changes = candidate.securityChanges;
      if (!changes || (!verbose && !changes.counts?.added)) continue;
      lines.push(`Security changes: ${sanitizeForTerminal(update.name)} ${sanitizeForTerminal(update.version)} → ${sanitizeForTerminal(candidate.version)} (${changes.status})`);
      for (const finding of changes.added) {
        lines.push(`  + ${sanitizeForTerminal(finding.severity)} ${sanitizeForTerminal(finding.category)} at ${sanitizeForTerminal(finding.file)} (${finding.count})`);
      }
      if (changes.notObserved) lines.push(`  ${changes.counts.notObserved} prior finding(s) not observed; this is not proof of remediation.`);
      if (changes.limitations.length) lines.push(`  Comparison limits: ${changes.limitations.join(", ")}`);
      if (changes.truncated) lines.push("  Finding details truncated; counts include omitted entries.");
    }
  }

  const verb = result.exitCode === 2 ? "BLOCK" : "OK";
  lines.push(`Result: **${verb}** (exit ${result.exitCode})`);
  return lines.join("\n");
}

// Machine-readable diff. Drops the heavy per-dep `report` object (full guard
// evidence) and keeps only the drift-relevant fields, so CI can key off buckets
// + per-dep detail without wading through evidence blobs.
function recheckJson(result) {
  const slim = (d) => ({
    name: d.name,
    version: d.version,
    baseline: d.baseline,
    verdict: d.verdict,
    drift: d.drift,
    checkedAt: d.checkedAt,
    decision: d.decision,
    ...(d.error ? { error: d.error } : {})
  });
  const vd = result.versionDrift || { available: [], flagged: [], unknown: [] };
  return require("./automatic-flow").toBinaryResult({
    schemaVersion: result.schemaVersion,
    file: result.file,
    format: result.format,
    totalDeps: result.totalDeps,
    updated: result.updated,
    counts: result.counts,
    worstRegression: result.worstRegression,
    exitCode: result.exitCode,
    buckets: {
      regressed: result.buckets.regressed.map(slim),
      improved: result.buckets.improved.map(slim),
      unchanged: result.buckets.unchanged.map(slim),
      noBaseline: result.buckets.noBaseline.map(slim),
      unknown: result.buckets.unknown.map(slim)
    },
    versionDrift: {
      updateAvailableSafe: vd.available,
      updateAvailableFlagged: vd.flagged,
      unknown: vd.unknown
    }
  });
}

module.exports = {
  recheckLockfile,
  renderRecheckText,
  recheckJson,
  classifyDrift,
  verdictRank,
  worstVerdict,
  VERDICT_RANK,
  // exported for tests
  makeDefaultEvaluator
};
