#!/usr/bin/env node
"use strict";

// pkgxray calibration benchmark
// ------------------------------
// Feeds a committed corpus of labelled fixtures through the REAL static engine
// (auditEvidence — no network, no execution) and reports how the verdicts line
// up with the labels. This turns the README's "validated with 0 false blocks"
// claim into something reproducible and regression-gated.
//
//   node benchmark/run.js            # human report, exit 1 on a hard failure
//   node benchmark/run.js --json     # machine-readable summary for CI
//   node benchmark/run.js --verbose  # also list every correct case
//
// Corpus layout: benchmark/corpus/{malicious,benign}/*.json — each file is one
// case (see benchmark/README.md for the schema and how to add one).
//
// Outcome classes and the gate:
//   FALSE_BLOCK  expect safe/review, got block  -> HARD FAIL (the FP the tool
//                                                   stakes its reputation on)
//   MISS         expect block,       got safe   -> HARD FAIL (malware passed)
//   OVER_FLAG    expect safe,        got review -> warn (stricter than needed)
//   UNDER_FLAG   caught but under-classified    -> warn (still surfaced)
//   CORRECT      actual === expect
// Exit is nonzero iff any HARD FAIL occurs, so CI fails on exactly the two
// outcomes that matter and tolerates benign calibration drift.

const fs = require("fs");
const path = require("path");
const { auditEvidence } = require("../src/auditor");

const VERDICTS = ["safe", "review", "block"];
const RANK = { safe: 0, review: 1, block: 2 };

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

const HARD_FAIL = new Set(["FALSE_BLOCK", "MISS"]);

function run() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const verbose = args.includes("--verbose");

  const cases = [...loadCorpus("malicious", "malicious"), ...loadCorpus("benign", "benign")];
  if (cases.length === 0) {
    process.stderr.write("no corpus cases found under benchmark/corpus/\n");
    process.exit(1);
  }

  const results = cases.map((c) => {
    if (!VERDICTS.includes(c.expect)) {
      throw new Error(`${c.fixture}: invalid "expect" (${c.expect})`);
    }
    const report = auditEvidence(c.evidence || {});
    const actual = report.verdict;
    const outcome = classify(c.expect, actual);
    const findingMatch =
      !c.expectFinding || report.findings.some((f) => f.category === c.expectFinding);
    return { ...c, actual, outcome, findingMatch, report };
  });

  // Confusion matrix expect x actual.
  const matrix = {};
  for (const e of VERDICTS) {
    matrix[e] = { safe: 0, review: 0, block: 0 };
  }
  for (const r of results) matrix[r.expect][r.actual]++;

  // "block" as the positive class, computed over the whole corpus.
  const tp = results.filter((r) => r.expect === "block" && r.actual === "block").length;
  const fp = results.filter((r) => r.expect !== "block" && r.actual === "block").length;
  const fn = results.filter((r) => r.expect === "block" && r.actual !== "block").length;
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  const hardFails = results.filter((r) => HARD_FAIL.has(r.outcome));
  const findingMisses = results.filter((r) => !r.findingMatch);
  const falseBlocks = results.filter((r) => r.outcome === "FALSE_BLOCK");

  const summary = {
    total: results.length,
    malicious: results.filter((r) => r.corpus === "malicious").length,
    benign: results.filter((r) => r.corpus === "benign").length,
    correct: results.filter((r) => r.outcome === "CORRECT").length,
    falseBlocks: falseBlocks.length,
    misses: results.filter((r) => r.outcome === "MISS").length,
    blockPrecision: round(precision),
    blockRecall: round(recall),
    blockF1: round(f1),
    matrix
  };

  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        {
          schemaVersion: 1,
          summary,
          hardFailures: hardFails.map((r) => pick(r)),
          findingMismatches: findingMisses.map((r) => ({ ...pick(r), expectFinding: r.expectFinding }))
        },
        null,
        2
      ) + "\n"
    );
  } else {
    printReport(results, summary, { verbose, hardFails, findingMisses });
  }

  process.exit(hardFails.length > 0 ? 1 : 0);
}

function printReport(results, s, { verbose, hardFails, findingMisses }) {
  const p = (line = "") => process.stdout.write(line + "\n");
  p("pkgxray calibration benchmark");
  p("=============================");
  p(`corpus: ${s.total} cases (${s.malicious} malicious, ${s.benign} benign)`);
  p("");
  p("confusion matrix (rows = expected, cols = actual verdict):");
  p("            safe   review  block");
  for (const e of VERDICTS) {
    const row = s.matrix[e];
    p(`  ${e.padEnd(8)}  ${String(row.safe).padStart(4)}   ${String(row.review).padStart(5)}  ${String(row.block).padStart(5)}`);
  }
  p("");
  p(`block precision : ${pct(s.blockPrecision)}   (of everything blocked, how much is truly malicious)`);
  p(`block recall    : ${pct(s.blockRecall)}   (of malicious cases, how much got blocked)`);
  p(`block F1        : ${pct(s.blockF1)}`);
  p(`false blocks    : ${s.falseBlocks}   (benign cases wrongly blocked — must be 0)`);
  p(`full misses     : ${s.misses}   (malicious cases that passed as safe — must be 0)`);
  p("");

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
  if (HARD_FAIL.has(outcome)) return "✗";
  return "~";
}

function pick(r) {
  return { fixture: r.fixture, expect: r.expect, actual: r.actual, outcome: r.outcome, note: r.note };
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

function pct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

run();
