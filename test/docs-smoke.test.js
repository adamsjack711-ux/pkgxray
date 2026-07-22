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
  for (const command of ["guard", "audit", "recheck", "mcp", "mcp-proxy"]) {
    assert.match(help, new RegExp(`pkgxray ${command.replace("-", "\\-")}`));
  }
  for (const flag of ["--file", "--format json"]) assert.match(help, new RegExp(flag));
});
