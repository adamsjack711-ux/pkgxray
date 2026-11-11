#!/usr/bin/env node
"use strict";

// Measures the cost of the binary policy on authored static controls. This is
// separate from the raw analyzer calibration gate and does not certify that a
// blocked benign control is acceptable or estimate a production error rate.
const fs = require("node:fs");
const path = require("node:path");
const { auditEvidence } = require("../src/auditor");
const { applyConfig, DEFAULTS } = require("../src/config");
const { toBinaryResult } = require("../src/automatic-flow");

const totals = {}, benignStops = [];
for (const label of ["benign", "malicious"]) {
  totals[label] = { total: 0, safe: 0, block: 0, internallyInconclusive: 0 };
  const directory = path.join(__dirname, "corpus", label);
  for (const file of fs.readdirSync(directory).filter(name => name.endsWith(".json")).sort()) {
    const fixture = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
    const evidence = fixture.evidence || {};
    const raw = applyConfig(auditEvidence(evidence), { config: DEFAULTS,
      packageName: evidence.packageName, evidence: { sourceFiles: Object.keys(evidence.sourceFiles || {}) } });
    const result = toBinaryResult(raw);
    if (!["safe", "block"].includes(result.verdict)) throw new Error(`Nonbinary result: ${label}/${file}`);
    totals[label].total++;
    totals[label][result.verdict]++;
    if (raw.verdict === "review") totals[label].internallyInconclusive++;
    if (label === "benign" && result.verdict === "block") benignStops.push({
      fixture: `${label}/${file}`, rawVerdict: raw.verdict, decision: "block",
      reasonCodes: result.resolution?.reasonCodes || ["blocking-findings"],
      categories: [...new Set(raw.findings.filter(f => ["high", "medium"].includes(f.severity)).map(f => f.category))]
    });
  }
}
console.log(JSON.stringify({ measuredAt: new Date().toISOString(),
  packageVersion: require("../package.json").version,
  scannerBuildId: require("../src/artifact").BUILD_ID,
  scope: "Authored static evidence fixtures; no package execution or network requests.",
  limitations: ["Not a real-world error-rate estimate.",
    "Measures binary supplied-evidence decisions, not complete registry/OSV installation checks.",
    "The existing raw analyzer calibration gate measures a different three-way contract.",
    "A successful benchmark invocation does not establish acceptable benign-stop rates."],
  totals, benignStops }, null, 2));
