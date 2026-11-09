#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const roots = ["bin", "src", "scripts", "test", "benchmark", "website", "examples/pkgxray-proxy"];

function filesUnder(relative) {
  const root = path.join(ROOT, relative);
  if (!fs.existsSync(root)) return [];
  const out = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (["node_modules", ".git", "results"].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) out.push(file);
    }
  }
  walk(root);
  return out;
}

const failures = [];
for (const file of roots.flatMap(filesUnder).sort()) {
  const result = spawnSync(process.execPath, ["--check", file], { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) failures.push(`${path.relative(ROOT, file)}\n${result.stderr || result.stdout}`);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const server = JSON.parse(fs.readFileSync(path.join(ROOT, "server.json"), "utf8"));
if (Object.keys(pkg.dependencies || {}).length) failures.push("package.json must keep runtime dependencies empty");
if (server.version !== pkg.version || server.packages?.[0]?.version !== pkg.version) {
  failures.push("package.json and server.json versions are not synchronized");
}

const activeVersionFiles = [
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/incorrect_verdict.yml",
  ".github/workflows/pkgxray-audit.yml",
  "docs/integrations/coding-agents.md",
  "docs/integrations/github-actions.md",
  "docs/mcp.md",
  "examples/hookshot/README.md"
];
for (const relative of activeVersionFiles) {
  const text = fs.readFileSync(path.join(ROOT, relative), "utf8");
  const stale = [...text.matchAll(/pkgxray@(\d+\.\d+\.\d+)/g)]
    .map((match) => match[1])
    .filter((version) => version !== pkg.version);
  if (stale.length) failures.push(`${relative} contains stale pkgxray example version(s): ${[...new Set(stale)].join(", ")}`);
}

const bundle = spawnSync(process.execPath, [path.join(ROOT, "scripts/build-browser-extension.js"), "--check"], {
  cwd: ROOT, encoding: "utf8"
});
if (bundle.status !== 0) failures.push((bundle.stderr || bundle.stdout).trim());

if (failures.length) {
  process.stderr.write(`Lint failed (${failures.length}):\n\n${failures.join("\n\n")}\n`);
  process.exit(1);
}
process.stdout.write("Lint passed: syntax, zero-runtime-dependency policy, version sync and browser parity are current.\n");
