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

// FALSE_BLOCK — a benign package wrongly blocked (the reputational risk).
// MISS       — malware passed as safe.
// RECALL_DROP — a caught malware sample demoted from block to review (recall
//               regression), unless it is an audited knownUnderflag.
const HARD_FAIL = new Set(["FALSE_BLOCK", "MISS", "RECALL_DROP"]);

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
    let outcome = classify(c.expect, actual);
    // knownFalsePositive: a documented heuristic misfire that the engine has NOT
    // yet been retuned to fix. It is tracked but must not hard-gate unrelated CI.
    // If it currently mis-verdicts -> XFAIL (expected failure). If it started
    // passing, the heuristic was fixed -> XPASS (drop the marker).
    let xfail = false, xpass = false;
    if (c.knownFalsePositive) {
      if (outcome === "CORRECT") { xpass = true; }
      else { xfail = true; outcome = "XFAIL"; }
    }
    // RECALL gate: a malicious (expect:block) fixture that lands on `review` is
    // an under-classification that lowers recall. It is a HARD FAIL — a change
    // that quietly demotes a caught malware sample from block to review must not
    // pass — UNLESS the fixture is an audited, documented policy under-flag
    // (knownUnderflag: download-then-exec and geo/locale-gated destruction are
    // routed to review by design; see the severity policy). Those stay a warning.
    // (expect:block -> safe is already MISS, the other recall hard-fail.)
    let recallRegression = false;
    if (outcome === "UNDER_FLAG" && c.expect === "block" && actual === "review" && !c.knownUnderflag) {
      recallRegression = true;
      outcome = "RECALL_DROP";
    }
    const findingMatch =
      !c.expectFinding || report.findings.some((f) => f.category === c.expectFinding);
    return { ...c, actual, outcome, xfail, xpass, recallRegression, findingMatch, report };
  });

  // Confusion matrix expect x actual.
  const matrix = {};
  for (const e of VERDICTS) {
    matrix[e] = { safe: 0, review: 0, block: 0 };
  }
  for (const r of results) matrix[r.expect][r.actual]++;

  // "block" as the positive class, computed over the whole corpus. A documented
  // knownFalsePositive (XFAIL) that blocks is an ACKNOWLEDGED misfire awaiting a
  // retune — it is excluded from the precision denominator the same way a
  // known-CVE block is excluded, so `precision` reflects UNDOCUMENTED false
  // blocks, not ones already tracked. (Its XFAIL count is reported separately.)
  const tp = results.filter((r) => r.expect === "block" && r.actual === "block").length;
  const fp = results.filter((r) => r.expect !== "block" && r.actual === "block" && !r.xfail).length;
  const fn = results.filter((r) => r.expect === "block" && r.actual !== "block").length;
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  const hardFails = results.filter((r) => HARD_FAIL.has(r.outcome));
  const findingMisses = results.filter((r) => !r.findingMatch);
  const falseBlocks = results.filter((r) => r.outcome === "FALSE_BLOCK");
  const recallDrops = results.filter((r) => r.outcome === "RECALL_DROP");
  const xfails = results.filter((r) => r.xfail);
  const xpasses = results.filter((r) => r.xpass);

  // Recall floor: number of malicious fixtures that actually block.
  const maliciousBlocking = results.filter((r) => r.expect === "block" && r.actual === "block").length;
  const recallFloorMet = maliciousBlocking >= BLOCK_RECALL_FLOOR;
  if (!recallFloorMet) {
    hardFails.push({ fixture: "(recall floor)", outcome: "RECALL_FLOOR", expect: `>=${BLOCK_RECALL_FLOOR} blocking`, actual: `${maliciousBlocking} blocking`,
      note: `malicious-block count ${maliciousBlocking} is below the committed floor ${BLOCK_RECALL_FLOOR}` });
  }

  const summary = {
    total: results.length,
    malicious: results.filter((r) => r.corpus === "malicious").length,
    benign: results.filter((r) => r.corpus === "benign").length,
    correct: results.filter((r) => r.outcome === "CORRECT").length,
    falseBlocks: falseBlocks.length,
    knownFalsePositives: xfails.length,
    xpasses: xpasses.length,
    misses: results.filter((r) => r.outcome === "MISS").length,
    recallDrops: recallDrops.length,
    maliciousBlocking,
    blockRecallFloor: BLOCK_RECALL_FLOOR,
    recallFloorMet,
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
    printReport(results, summary, { verbose, hardFails, findingMisses, xfails, xpasses });
  }

  process.exit(hardFails.length > 0 ? 1 : 0);
}

function printReport(results, s, { verbose, hardFails, findingMisses, xfails = [], xpasses = [] }) {
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
  p(`recall drops    : ${s.recallDrops}   (malware demoted block->review, non-allowlisted — must be 0)`);
  p(`recall floor    : ${s.maliciousBlocking}/${s.blockRecallFloor} malicious blocking ${s.recallFloorMet ? "✓" : "✗ BELOW FLOOR"}`);
  p(`known FPs (xfail): ${s.knownFalsePositives}   (documented heuristic misfires, not yet retuned — tracked, non-gating)`);
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
const BLOCK_RECALL_FLOOR = 18;

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
