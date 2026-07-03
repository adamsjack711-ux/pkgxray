"use strict";

const { parseLockfile, sanitizeForTerminal } = require("./lockfile");
const {
  loadDecisions,
  saveDecisions,
  lockPathForLockfile
} = require("./triage");
const { mapPool, defaultConcurrency } = require("./pool");

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

async function recheckLockfile(lockfilePath, options = {}) {
  const { format, deps } = await parseLockfile(lockfilePath);
  const lockPath = options.lockPath || lockPathForLockfile(lockfilePath);
  const decisions = options.decisions || (await loadDecisions(lockPath));

  const evaluate = options.evaluate || makeDefaultEvaluator(options);
  const depList = Array.from(deps.values());
  const concurrency = options.concurrency || defaultConcurrency(depList.length);
  const nowIso = () => new Date().toISOString();

  const perDep = await mapPool(depList, concurrency, async (dep) => {
    const key = `${dep.name}@${dep.version}`;
    const record = decisions.get(key) || null;
    const baseline = record ? record.verdict : null;

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

  // Exit code keys off the worst *regression* target — not the worst absolute
  // verdict. A dep that was block at install and is still block is not a NEW
  // regression and must not fail a monitoring run.
  const regressionTargets = buckets.regressed.map((d) => d.verdict);
  const worstRegression = buckets.regressed.length > 0 ? worstVerdict(regressionTargets) : null;
  const exitCode = worstRegression === "block" ? 2 : worstRegression === "review" ? 3 : 0;

  return {
    schemaVersion: 1,
    file: lockfilePath,
    format,
    lockPath,
    totalDeps: depList.length,
    updated,
    buckets,
    counts: {
      regressed: buckets.regressed.length,
      improved: buckets.improved.length,
      unchanged: buckets.unchanged.length,
      noBaseline: buckets.noBaseline.length,
      unknown: buckets.unknown.length
    },
    worstRegression,
    exitCode
  };
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
