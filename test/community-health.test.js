"use strict";

const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");

const ROOT = resolve(__dirname, "..");
const read = (...parts) => readFileSync(resolve(ROOT, ...parts), "utf8");

test("community health files and support policies exist", () => {
  for (const path of [
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    ".github/pull_request_template.md",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/incorrect_verdict.yml",
    ".github/ISSUE_TEMPLATE/calibration_dispute.yml",
    "docs/project-status.md",
    "docs/release.md",
  ]) {
    assert.ok(existsSync(resolve(ROOT, path)), `${path} should exist`);
  }
});

test("incorrect-verdict form collects the reproducibility contract", () => {
  const form = read(".github", "ISSUE_TEMPLATE", "incorrect_verdict.yml");
  for (const id of [
    "package",
    "command",
    "version",
    "verdict",
    "expected",
    "json",
    "reproduction",
    "live_malware",
  ]) {
    assert.match(form, new RegExp(`id: ${id}\\b`));
  }
  assert.match(form, /Do not attach active malware, credentials/);
  assert.match(form, /security\/advisories\/new/);
});

test("security policy distinguishes static and executing surfaces", () => {
  const security = read("SECURITY.md");
  assert.match(security, /Normal `guard`, `audit`, and evidence scans/);
  assert.match(security, /pkgxray canary --yes-run-untrusted-code/);
  assert.match(security, /pkgxray mcp-proxy/);
  assert.match(security, /false negative or bypass privately/);
});

test("Node compatibility floor and tested current release stay explicit", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.equal(packageJson.engines.node, ">=18");
  const workflow = read(".github", "workflows", "pkgxray-test.yml");
  assert.match(workflow, /node: \["18", "20", "22", "24", "26"\]/);
});
