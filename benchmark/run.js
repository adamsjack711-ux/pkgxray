#!/usr/bin/env node
"use strict";

// pkgxray calibration benchmark
// ------------------------------
// Feeds a committed corpus of labelled fixtures through the REAL static engine
// (auditEvidence — no network, no execution) and reports how the verdicts line
// up with the labels. This regression corpus does not revalidate historical
// live-package scans or estimate accuracy across the package population.
//
//   node benchmark/run.js            # human report, exit 1 on a hard failure
//   node benchmark/run.js --json     # machine-readable summary for CI
//   node benchmark/run.js --verbose  # also list every correct case
//   node benchmark/run.js --cohort mcp   # only fixtures tagged "cohort": "mcp"
//
// A fixture without a "cohort" field belongs to the default "npm" cohort, so
// the no-flag invocation (what CI gates on) is unchanged by cohort tagging.
//
// Corpus layout: benchmark/corpus/{malicious,benign}/*.json — each file is one
// case (see benchmark/README.md for the schema and how to add one).
//
// Outcome classes and the gate:
//   FALSE_BLOCK  expect safe/review, got block  -> HARD FAIL (the FP the tool
//                                                   stakes its reputation on)
//   MISS         expect block,       got safe   -> HARD FAIL (malware passed)
//   RECALL_DROP  expect block,       got review -> HARD FAIL unless knownUnderflag
//   OVER_FLAG    expect safe,        got review -> warn (stricter than needed)
//   UNDER_FLAG   caught but under-classified    -> warn (still surfaced)
//   CORRECT      actual === expect
// Documented benign false positives are exempt from the gate, not the metrics.
// The full-corpus run also enforces the committed malicious-block count floor.

const fs = require("fs");
const path = require("path");
const { auditEvidence } = require("../src/auditor");

const VERDICTS = ["safe", "review", "block"];
const RANK = { safe: 0, review: 1, block: 2 };

// Retention minima from the 2026-10-04 fixture baseline. These prevent deleting
// evidence to make a regression pass; they are NOT sufficient-coverage targets.
// Raise deliberately as reviewed examples are added. MCP's zero records a gap.
const COHORT_MINIMUMS = {
  npm: { malicious: 25, benign: 32, blocking: 24 },
  pypi: { malicious: 5, benign: 7, blocking: 5 },
  mcp: { malicious: 0, benign: 1, blocking: 0 }
};
const COHORT_LIMITATIONS = {
  npm: "Hand-selected static fixtures do not establish accuracy across the npm registry.",
  pypi: "PyPI fixtures cover installation-manifest behavior, not general Python behavioral detection.",
  mcp: "The MCP corpus does not measure live protocol sessions or runtime tool behavior."
};

function loadCorpus(dir, label) {
  const full = path.join(__dirname, "corpus", dir);
  if (!fs.existsSync(full)) return [];
  return fs
    .readdirSync(full)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const raw = JSON.parse(fs.readFileSync(path.join(full, f), "utf8"));
      return { ...raw, corpus: label, fixture: `${dir}/${f}` };
    });
}

function classify(expect, actual) {
  if (actual === expect) return "CORRECT";
  if (actual === "block" && RANK[expect] < RANK.block) return "FALSE_BLOCK";
  if (expect === "block" && actual === "safe") return "MISS";
  if (expect === "safe" && actual === "review") return "OVER_FLAG";
  return "UNDER_FLAG";
}

// FALSE_BLOCK — a benign package wrongly blocked (the reputational risk).
// MISS       — malware passed as safe.
// RECALL_DROP — a caught malware sample demoted from block to review (recall
//               regression), unless it is an audited knownUnderflag.
const HARD_FAIL = new Set(["FALSE_BLOCK", "MISS", "RECALL_DROP"]);

function evaluateCase(c, report) {
  if (!VERDICTS.includes(c.expect)) {
    throw new Error(`${c.fixture}: invalid "expect" (${c.expect})`);
  }
  if (!VERDICTS.includes(report.verdict)) {
    throw new Error(`${c.fixture}: invalid actual verdict (${report.verdict})`);
  }
  // A benign false-positive exemption must never suppress a malicious miss or
  // recall regression, even if the fixture has been incorrectly annotated.
  if (c.knownFalsePositive && (c.corpus !== "benign" || c.expect === "block")) {
    throw new Error(`${c.fixture}: knownFalsePositive is allowed only for benign safe/review fixtures`);
  }
  const actual = report.verdict;
  const rawOutcome = classify(c.expect, actual);
  let outcome = rawOutcome;
  const xfail = Boolean(c.knownFalsePositive && outcome !== "CORRECT");
  const xpass = Boolean(c.knownFalsePositive && outcome === "CORRECT");
  if (xfail) outcome = "XFAIL";
  const recallRegression = outcome === "UNDER_FLAG" && c.expect === "block" &&
    actual === "review" && !c.knownUnderflag;
  if (recallRegression) outcome = "RECALL_DROP";
  const findingMatch = !c.expectFinding || report.findings.some((f) => f.category === c.expectFinding);
  return { ...c, actual, rawOutcome, outcome, xfail, xpass, recallRegression, findingMatch, report };
}

function summarizeResults(results) {
  const count = (predicate) => results.filter(predicate).length;
  const matrix = Object.fromEntries(VERDICTS.map((v) => [v, { safe: 0, review: 0, block: 0 }]));
  for (const r of results) matrix[r.expect][r.actual]++;

  // Metrics include EVERY observation. An exemption changes the regression
  // gate only; documenting a false block does not make it a true positive.
  const tp = count((r) => r.expect === "block" && r.actual === "block");
  const fp = count((r) => r.expect !== "block" && r.actual === "block");
  const fn = count((r) => r.expect === "block" && r.actual !== "block");
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  const f1 = precision == null || recall == null ? null :
    (precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall));
  const benign = count((r) => r.corpus === "benign");
  const reviewCount = count((r) => r.actual === "review");
  const benignReviewCount = count((r) => r.corpus === "benign" && r.actual === "review");
  return {
    total: results.length,
    malicious: count((r) => r.corpus === "malicious"),
    benign,
    correct: count((r) => r.outcome === "CORRECT"),
    falseBlocks: fp,
    gatingFalseBlocks: count((r) => r.outcome === "FALSE_BLOCK"),
    exemptedFalseBlocks: count((r) => r.expect !== "block" && r.actual === "block" && r.xfail),
    knownFalsePositives: count((r) => r.xfail),
    xpasses: count((r) => r.xpass),
    misses: count((r) => r.outcome === "MISS"),
    recallDrops: count((r) => r.outcome === "RECALL_DROP"),
    maliciousBlocking: tp,
    blockMetricCounts: { truePositives: tp, falsePositives: fp, falseNegatives: fn,
      precisionDenominator: tp + fp, recallDenominator: tp + fn },
    blockPrecision: round(precision),
    blockRecall: round(recall),
    blockF1: round(f1),
    reviewCount,
    reviewRateDenominator: results.length,
    reviewRate: results.length ? round(reviewCount / results.length) : null,
    benignReviewCount,
    benignReviewRateDenominator: benign,
    benignReviewRate: benign ? round(benignReviewCount / benign) : null,
    matrix
  };
}

function assessCoverage(results, cohort = null) {
  const names = cohort ? [cohort] : [...new Set([
    ...Object.keys(COHORT_MINIMUMS), ...results.map((r) => r.cohort || "npm")
  ])].sort();
  const warnings = [];
  const failures = [];
  const cohorts = Object.fromEntries(names.map((name) => {
    const rows = results.filter((r) => (r.cohort || "npm") === name);
    const counts = {
      malicious: rows.filter((r) => r.corpus === "malicious").length,
      benign: rows.filter((r) => r.corpus === "benign").length,
      blocking: rows.filter((r) => r.expect === "block" && r.actual === "block").length
    };
    const minimums = COHORT_MINIMUMS[name] || null;
    const missingClasses = ["malicious", "benign"].filter((label) => counts[label] === 0);
    for (const label of missingClasses) {
      warnings.push(`${name}: no ${label} fixtures; ${label === "malicious" ? "detection recall" : "benign false-block behavior"} is not measured.`);
    }
    const limitation = COHORT_LIMITATIONS[name] || "Hand-selected static fixtures do not establish population accuracy.";
    warnings.push(`${name}: ${counts.malicious} malicious and ${counts.benign} benign fixtures. ${limitation}`);
    const deficient = minimums ? Object.keys(minimums).filter((key) => counts[key] < minimums[key]) : [];
    for (const key of deficient) {
      failures.push({
        fixture: `(cohort ${name} ${key} retention)`, outcome: "COVERAGE_DROP",
        expect: `>=${minimums[key]} ${key}`, actual: `${counts[key]} ${key}`,
        note: "Existing fixture evidence fell below its committed cohort minimum; this gate does not certify coverage sufficiency."
      });
    }
    return [name, { counts, retentionMinimums: minimums, retentionMet: deficient.length === 0,
      missingClasses, scope: "committed-static-fixtures", representsPopulationAccuracy: false, limitation }];
  }));
  return { cohorts, warnings, failures };
}

function run() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const verbose = args.includes("--verbose");
  const cohortIx = args.indexOf("--cohort");
  const cohort = cohortIx !== -1 ? args[cohortIx + 1] : null;
  if (cohortIx !== -1 && (!cohort || cohort.startsWith("--"))) {
    process.stderr.write("--cohort requires a cohort name\n");
    process.exit(2);
  }

  let cases = [...loadCorpus("malicious", "malicious"), ...loadCorpus("benign", "benign")];
  if (cohort) cases = cases.filter((c) => (c.cohort || "npm") === cohort);
  if (cases.length === 0) {
    process.stderr.write(`no corpus cases found under benchmark/corpus/${cohort ? ` for cohort "${cohort}"` : ""}\n`);
    process.exit(1);
  }

  const results = cases.map((c) => evaluateCase(c, auditEvidence(c.evidence || {})));
  const metrics = summarizeResults(results);
  const hardFails = results.filter((r) => HARD_FAIL.has(r.outcome));
  const coverage = assessCoverage(results, cohort);
  hardFails.push(...coverage.failures);
  const findingMisses = results.filter((r) => !r.findingMatch);
  const xfails = results.filter((r) => r.xfail);
  const xpasses = results.filter((r) => r.xpass);

  // Recall floor: number of malicious fixtures that actually block. The
  // committed floor is defined over the FULL corpus; under a --cohort filter
  // only a subset runs, so the floor check is skipped (per-cohort recall is
  // still reported as a count).
  const maliciousBlocking = results.filter((r) => r.expect === "block" && r.actual === "block").length;
  const recallFloorMet = cohort ? true : maliciousBlocking >= BLOCK_RECALL_FLOOR;
  if (!recallFloorMet) {
    hardFails.push({ fixture: "(recall floor)", outcome: "RECALL_FLOOR", expect: `>=${BLOCK_RECALL_FLOOR} blocking`, actual: `${maliciousBlocking} blocking`,
      note: `malicious-block count ${maliciousBlocking} is below the committed floor ${BLOCK_RECALL_FLOOR}` });
  }

  const summary = {
    cohort: cohort || "all",
    ...metrics,
    blockRecallFloor: cohort ? null : BLOCK_RECALL_FLOOR,
    recallFloorMet
  };
  const cohorts = Object.fromEntries(
    [...new Set(results.map((r) => r.cohort || "npm"))].sort().map((name) => [
      name, summarizeResults(results.filter((r) => (r.cohort || "npm") === name))
    ])
  );

  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        {
          schemaVersion: 2,
          metadata: {
            scope: "committed-static-fixtures",
            engine: "auditEvidence",
            networkAccess: false,
            packageExecution: false,
            livePackagesScanned: 0,
            representsPopulationAccuracy: false,
            blockPositiveLabel: "expect:block",
            reviewRateDenominator: "all evaluated fixtures in the reported scope"
          },
          summary,
          cohorts,
          coverage: { cohorts: coverage.cohorts, warnings: coverage.warnings,
            retentionGatePassed: coverage.failures.length === 0 },
          hardFailures: hardFails.map((r) => pick(r)),
          findingMismatches: findingMisses.map((r) => ({ ...pick(r), expectFinding: r.expectFinding }))
        },
        null,
        2
      ) + "\n"
    );
  } else {
    printReport(results, summary, { verbose, hardFails, findingMisses, xfails, xpasses, cohorts, coverage });
  }

  process.exit(hardFails.length > 0 ? 1 : 0);
}

function printReport(results, s, { verbose, hardFails, findingMisses, xfails = [], xpasses = [], cohorts = {}, coverage }) {
  const p = (line = "") => process.stdout.write(line + "\n");
  p("pkgxray calibration benchmark");
  p("=============================");
  p(`corpus: ${s.total} cases (${s.malicious} malicious, ${s.benign} benign)${s.cohort !== "all" ? ` — cohort "${s.cohort}"` : ""}`);
  p("");
  p("scope: committed static fixtures; no live packages scanned; not population accuracy");
  p("confusion matrix (rows = expected, cols = actual verdict):");
  p("            safe   review  block");
  for (const e of VERDICTS) {
    const row = s.matrix[e];
    p(`  ${e.padEnd(8)}  ${String(row.safe).padStart(4)}   ${String(row.review).padStart(5)}  ${String(row.block).padStart(5)}`);
  }
  p("");
  p(`block precision : ${pct(s.blockPrecision)}   (${s.blockMetricCounts.truePositives}/${s.blockMetricCounts.precisionDenominator} blocked fixtures expected to block)`);
  p(`block recall    : ${pct(s.blockRecall)}   (${s.blockMetricCounts.truePositives}/${s.blockMetricCounts.recallDenominator} expected-block fixtures actually blocked)`);
  p(`block F1        : ${pct(s.blockF1)}`);
  p(`false blocks    : ${s.falseBlocks}   (raw total, including ${s.exemptedFalseBlocks} documented exemptions)`);
  p(`gating FP blocks: ${s.gatingFalseBlocks}   (undocumented false blocks — must be 0)`);
  p(`review rate     : ${pct(s.reviewRate)}   (${s.reviewCount}/${s.reviewRateDenominator} evaluated fixtures)`);
  p(`benign reviews  : ${pct(s.benignReviewRate)}   (${s.benignReviewCount}/${s.benignReviewRateDenominator} benign fixtures)`);
  p(`full misses     : ${s.misses}   (malicious cases that passed as safe — must be 0)`);
  p(`recall drops    : ${s.recallDrops}   (malware demoted block->review, non-allowlisted — must be 0)`);
  if (s.blockRecallFloor == null) {
    p(`recall floor    : skipped (cohort "${s.cohort}" — floor is defined over the full corpus)`);
  } else {
    p(`recall floor    : ${s.maliciousBlocking}/${s.blockRecallFloor} malicious blocking ${s.recallFloorMet ? "✓" : "✗ BELOW FLOOR"}`);
  }
  p(`known FPs (xfail): ${s.knownFalsePositives}   (documented heuristic misfires, not yet retuned — tracked, non-gating)`);
  p("");

  for (const [name, metrics] of Object.entries(cohorts)) {
    p(`cohort ${name}: ${metrics.total} fixtures (${metrics.malicious} malicious, ${metrics.benign} benign); block precision ${pct(metrics.blockPrecision)}, recall ${pct(metrics.blockRecall)}; review ${metrics.reviewCount}/${metrics.reviewRateDenominator} (${pct(metrics.reviewRate)})`);
  }
  p("");

  p("Coverage limits (passing retention gates does not establish sufficient coverage):");
  for (const warning of coverage.warnings) p(`  - ${warning}`);
  p("");

  if (xfails.length) {
    p(`KNOWN FALSE POSITIVES (${xfails.length}) — documented misfires awaiting a heuristic retune:`);
    for (const r of xfails) {
      p(`  ○ ${r.fixture.padEnd(44)} expect ${r.expect} -> ${r.actual}${r.note ? "  — " + r.note : ""}`);
    }
    p("");
  }
  if (xpasses.length) {
    p(`XPASS (${xpasses.length}) — a known-FP fixture now behaves correctly; remove its "knownFalsePositive" marker:`);
    for (const r of xpasses) p(`  ✓ ${r.fixture}`);
    p("");
  }

  if (verbose) {
    for (const r of results) {
      p(`  ${glyph(r.outcome)} ${r.fixture.padEnd(40)} expect ${r.expect} -> ${r.actual}`);
    }
    p("");
  }

  if (findingMisses.length) {
    p("finding-category mismatches (verdict may still be right):");
    for (const r of findingMisses) {
      p(`  - ${r.fixture}: expected a "${r.expectFinding}" finding, none present`);
    }
    p("");
  }

  if (hardFails.length) {
    p(`HARD FAILURES (${hardFails.length}):`);
    for (const r of hardFails) {
      p(`  ✗ [${r.outcome}] ${r.fixture} — expected ${r.expect}, got ${r.actual}`);
      if (r.note) p(`      ${r.note}`);
    }
    p("");
    p("Benchmark FAILED.");
  } else {
    p("All hard-gate checks passed ✓");
  }
}

function glyph(outcome) {
  if (outcome === "CORRECT") return "✓";
  if (outcome === "XFAIL") return "○";
  if (HARD_FAIL.has(outcome)) return "✗";
  return "~";
}

// Recall floor: the count of malicious (expect:block) fixtures that MUST reach
// `block`. Committed so a change that lowers it fails CI even if it stays above
// any percentage threshold. Update deliberately (upward) when adding malicious
// fixtures; never lower it to make a regression pass.
const BLOCK_RECALL_FLOOR = 23;

function pick(r) {
  return { fixture: r.fixture, expect: r.expect, actual: r.actual, outcome: r.outcome, note: r.note };
}

function round(n) {
  return n == null ? null : Math.round(n * 1000) / 1000;
}

function pct(n) {
  return n == null ? "N/A (not measured)" : `${(n * 100).toFixed(1)}%`;
}

if (require.main === module) run();

module.exports = { evaluateCase, summarizeResults, assessCoverage };
