"use strict";

const { parseLockfile, sanitizeForTerminal } = require("./lockfile");
const {
  loadDecisions,
  saveDecisions,
  lockPathForLockfile,
  isStale
} = require("./triage");
const { mapPool, defaultConcurrency } = require("./pool");
const { newerCandidates } = require("./semver");

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
function makeDefaultEvaluator(options) {
  const { guardExtension } = require("./quarantine");
  return async (dep) => {
    const result = await guardExtension(`npm:${dep.name}@${dep.version}`, {
      vulnerabilityCheck: true, // OSV is the primary drift signal
      githubMetadata: options.githubMetadata !== false,
      // divergence (npm-vs-GitHub) is part of the intelligence recheck compares;
      // leave it at guardExtension's default (enabled) unless the caller opts out.
      githubDiff: options.githubDiff === true ? true : options.githubDiff,
      quarantineRoot: options.quarantineRoot
    });
    return { verdict: result.report.verdict, report: result.report };
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
async function versionDriftPass(depList, evaluate, options) {
  const listVersions = options.listVersions || defaultListVersions(options);
  const concurrency = options.concurrency || defaultConcurrency(depList.length);

  const results = await mapPool(depList, concurrency, async (dep) => {
    let candidates;
    try {
      const { versions } = await listVersions(dep.name);
      const picked = newerCandidates(dep.version, versions || []);
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
      try {
        const outcome = await evaluate({ name: dep.name, version: candidate, paths: [] }, { versionDrift: true });
        verdict = outcome && typeof outcome.verdict === "string" ? outcome.verdict : "unknown";
      } catch (err) {
        error = err && err.message ? err.message : String(err);
      }
      vetted.push({ version: candidate, verdict, ...(error ? { error } : {}) });
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
    // Fail-open guard: if EVERY candidate's guard scan errored (all "unknown"),
    // worstVerdict([]) is "safe" — do NOT report an unvetted newer version as a
    // clean/available update. Surface it as unknown so it isn't blind-installed.
    if (vettedVerdicts.length === 0) {
      unknown.push({
        name: r.name,
        version: r.version,
        candidates: r.candidates,
        error: "no candidate could be vetted"
      });
      continue;
    }
    const worst = worstVerdict(vettedVerdicts);
    const entry = { name: r.name, version: r.version, candidates: r.candidates, worst };
    if (worst === "review" || worst === "block") flagged.push(entry);
    else available.push(entry);
  }
  return { available, flagged, unknown };
}

function defaultListVersions(options) {
  const { listNpmVersions } = require("./registry");
  return (name) => listNpmVersions(name, { registry: options.registry });
}

async function recheckLockfile(lockfilePath, options = {}) {
  const { format, deps } = await parseLockfile(lockfilePath);
  const lockPath = options.lockPath || lockPathForLockfile(lockfilePath);
  const decisions = options.decisions || (await loadDecisions(lockPath));

  const evaluate = options.evaluate || makeDefaultEvaluator(options);
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
    try {
      const outcome = await evaluate(dep, { record });
      fresh = outcome && typeof outcome.verdict === "string" ? outcome.verdict : "unknown";
      report = outcome ? outcome.report || null : null;
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
      report
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
    versionDrift = await versionDriftPass(depList, evaluate, options);
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
    lines.push("No regressions. Nothing you already depend on became worse.");
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
    lines.push("UPDATE AVAILABLE BUT FLAGGED (don't blind-upgrade — newer version is review/block):");
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

  const verb = result.exitCode === 2 ? "BLOCK" : result.exitCode === 3 ? "REVIEW" : "OK";
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
  return {
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
  };
}

module.exports = {
  recheckLockfile,
  renderRecheckText,
  recheckJson,
  classifyDrift,
  verdictRank,
  worstVerdict,
  VERDICT_RANK
};
