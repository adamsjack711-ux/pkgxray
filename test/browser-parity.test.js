"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { auditEvidence } = require("../src/auditor");

test("browser engine agrees with Node on calibration and adversarial corpora without Node globals", () => {
  const root = path.join(__dirname, "..");
  const context = vm.createContext({ window: {}, atob, btoa, TextEncoder, TextDecoder, URL });
  vm.runInContext(fs.readFileSync(path.join(root, "browser-extension/auditor.browser.js"), "utf8"), context);
  const fixtures = [];
  for (const cohort of ["benign", "malicious"]) {
    const dir = path.join(root, "benchmark/corpus", cohort);
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) {
      fixtures.push({ id: file, ...JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) });
    }
  }
  for (const name of ["cases.json", "holdout.json"]) fixtures.push(...JSON.parse(fs.readFileSync(path.join(root, "benchmark/adversarial", name))).cases);
  for (const { evidence, id: file } of fixtures) {
      const browser = context.window.SupplyChainAuditor.auditEvidence(evidence);
      const node = auditEvidence(evidence);
      assert.equal(browser.verdict, node.verdict, file);
      assert.equal(browser.score, node.score, file);
      assert.equal(JSON.stringify(browser.findings), JSON.stringify(node.findings), file);
  }
});
