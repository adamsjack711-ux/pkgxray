"use strict";

const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = resolve(__dirname, "..");
const README = readFileSync(resolve(ROOT, "README.md"), "utf8");
const PACKAGE = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
const CLI = resolve(ROOT, "bin", "audit.js");
const FIXTURE = resolve(ROOT, "examples", "onboarding-malicious.json");
const ACTIONS_GUIDE = readFileSync(
  resolve(ROOT, "docs", "integrations", "github-actions.md"),
  "utf8"
);
const AUDIT_WORKFLOW = readFileSync(
  resolve(ROOT, ".github", "workflows", "pkgxray-audit.yml"),
  "utf8"
);

test("README uses the canonical project description and zero-install command", () => {
  const canonical =
    "pkgxray — pre-install security for npm packages, MCP servers, and AI agents";
  assert.match(README, new RegExp(canonical));
  assert.ok(PACKAGE.description.startsWith(canonical));
  assert.match(
    README,
    /npx --yes pkgxray@1\.0\.3 guard npm:express@4\.21\.0/
  );
});

test("README relative links and image paths exist", () => {
  const targets = [
    ...README.matchAll(/!?\[[^\]]*]\(([^)]+)\)/g),
    ...README.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi),
  ].map((match) => match[1]);

  const missing = [];
  for (const target of targets) {
    if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
    const path = decodeURIComponent(target.split("#", 1)[0]);
    if (path && !existsSync(resolve(ROOT, path))) missing.push(target);
  }
  assert.deepEqual(missing, []);
});

test("documented onboarding fixture is inert evidence that produces BLOCK", () => {
  assert.ok(existsSync(FIXTURE));
  const result = spawnSync(
    process.execPath,
    [CLI, "--file", FIXTURE, "--format", "json"],
    { cwd: ROOT, encoding: "utf8" }
  );
  assert.equal(result.status, 2, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.verdict, "block");
  assert.ok(report.findings.some((finding) => finding.category === "credential-access"));
});

test("documented entry points remain present in CLI help", () => {
  const result = spawnSync(process.execPath, [CLI, "--help"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const help = `${result.stdout}\n${result.stderr}`;
  for (const command of ["guard", "audit", "recheck", "mcp", "mcp-proxy", "serve-mcp"]) {
    assert.match(help, new RegExp(`pkgxray ${command.replace("-", "\\-")}`));
  }
  for (const flag of ["--file", "--format json"]) assert.match(help, new RegExp(flag));
});

test("pkgxray --version reports the package version", () => {
  const result = spawnSync(process.execPath, [CLI, "--version"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), PACKAGE.version);
});

test("GitHub Actions documentation covers every supported manifest and package guard", () => {
  for (const target of [
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "pnpm-lock.yml",
    "yarn.lock",
    "package.json",
  ]) {
    assert.match(ACTIONS_GUIDE, new RegExp(target.replaceAll(".", "\\.")));
    assert.match(AUDIT_WORKFLOW, new RegExp(target.replaceAll(".", "\\.")));
  }
  assert.match(ACTIONS_GUIDE, /guard npm:express@4\.21\.0/);
  assert.match(AUDIT_WORKFLOW, /PACKAGE_REFERENCE/);
});

test("GitHub Actions examples pin dependencies and avoid global installs", () => {
  for (const source of [ACTIONS_GUIDE, AUDIT_WORKFLOW]) {
    const uses = [...source.matchAll(/uses:\s+\S+@([0-9a-f]{40})/g)];
    assert.ok(uses.length > 0, "expected at least one full-SHA action reference");
    assert.doesNotMatch(source, /uses:\s+\S+@(?:main|master|v\d+)/);
    assert.doesNotMatch(source, /npx[^\n]*pkgxray@latest|npm install -g pkgxray/);
  }
  assert.match(AUDIT_WORKFLOW, /persist-credentials:\s+false/);
  assert.match(AUDIT_WORKFLOW, /default:\s+"1\.0\.3"/);
});
