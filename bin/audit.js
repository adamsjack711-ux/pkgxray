#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { auditEvidence, renderMarkdown } = require("../src/auditor");
const { guardExtension } = require("../src/quarantine");
const { auditLockfile } = require("../src/lockfile");

function printUsage() {
  process.stderr.write(
    [
      "Usage:",
      "  pkgxray < evidence.json",
      "  pkgxray --format json < evidence.json",
      "  pkgxray --file evidence.json --format markdown",
      "  pkgxray guard <npm-package|npm:name@version|github:owner/repo[#ref]|./path> [--promote-to dir] [--no-source-scan]",
      "  pkgxray audit <package-lock.json|yarn.lock|pnpm-lock.yaml|package.json>  # batch OSV scan of every dep",
      "",
      "Evidence JSON fields:",
      "  packageName, npmMetadata, githubMetadata, webPresence, sourceFiles",
      ""
    ].join("\n")
  );
}

function parseArgs(argv) {
  const options = { command: "audit", format: "markdown", file: null };
  if (argv[0] === "guard") {
    options.command = "guard";
    options.reference = argv[1];
    argv = argv.slice(2);
  } else if (argv[0] === "audit") {
    options.command = "auditLockfile";
    options.lockfilePath = argv[1];
    argv = argv.slice(2);
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--format") {
      options.format = argv[++i];
    } else if (arg === "--file") {
      options.file = argv[++i];
    } else if (arg === "--quarantine-root") {
      options.quarantineRoot = argv[++i];
    } else if (arg === "--promote-to") {
      options.promoteTo = argv[++i];
    } else if (arg === "--policy") {
      options.policy = argv[++i];
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--no-source-scan") {
      options.sourceScan = false;
    } else if (arg === "--no-vulnerability-check") {
      options.vulnerabilityCheck = false;
    } else if (arg === "--no-github") {
      options.githubMetadata = false;
      options.githubDiff = false;
    } else if (arg === "--no-github-diff") {
      options.githubDiff = false;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!["json", "markdown"].includes(options.format)) {
    throw new Error("--format must be json or markdown");
  }
  return options;
}

function readInput(file) {
  if (file) {
    return fs.readFileSync(file, "utf8");
  }
  return fs.readFileSync(0, "utf8");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  if (options.command === "guard") {
    if (!options.reference) {
      throw new Error("guard requires an extension reference");
    }
    const result = await guardExtension(options.reference, options);
    if (options.format === "json") {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderGuardMarkdown(result)}\n`);
    }
    process.exitCode = result.decision === "block" ? 2 : result.decision === "review" ? 3 : 0;
    return;
  }

  if (options.command === "auditLockfile") {
    if (!options.lockfilePath) {
      throw new Error("audit requires a lockfile path (package-lock.json | yarn.lock | pnpm-lock.yaml | package.json)");
    }
    const result = await auditLockfile(options.lockfilePath, options);
    if (options.format === "json") {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderLockfileMarkdown(result)}\n`);
    }
    process.exitCode = result.worstDecision === "block" ? 2 : result.worstDecision === "review" ? 3 : 0;
    return;
  }

  const raw = readInput(options.file).trim();
  if (!raw) {
    throw new Error("No evidence JSON provided");
  }

  const evidence = JSON.parse(raw);
  const report = auditEvidence(evidence);

  if (options.format === "json") {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderMarkdown(report)}\n`);
  }

  process.exitCode = report.verdict === "block" ? 2 : report.verdict === "review" ? 3 : 0;
}

function renderLockfileMarkdown(result) {
  const lines = [];
  lines.push(`Lockfile: \`${result.file}\` (${result.format})`);
  lines.push(`Total deps: ${result.totalDeps}  ·  scan time: ${result.timings.totalMs} ms`);
  lines.push("");
  lines.push(`Decision: **${result.worstDecision.toUpperCase()}**`);
  lines.push(`  safe: ${result.summary.safe}  ·  review: ${result.summary.reviewed}  ·  block: ${result.summary.blocked}`);
  lines.push("");
  const blocked = result.results.filter((r) => r.decision === "block");
  if (blocked.length > 0) {
    lines.push("Blocked packages:");
    for (const r of blocked.slice(0, 25)) {
      const vulnIds = r.vulnerabilities.map((v) => v.id).join(", ");
      lines.push(`- **${r.name}@${r.version}** — ${vulnIds || "OSV vulnerabilities"}`);
      if (r.paths.length > 0) {
        lines.push(`  pulled in by: ${r.paths[0]}`);
      }
    }
    if (blocked.length > 25) {
      lines.push(`  ...and ${blocked.length - 25} more`);
    }
  } else {
    lines.push("No blocked packages.");
  }
  return lines.join("\n");
}

function renderGuardMarkdown(result) {
  const lines = [
    `Decision: **${result.decision.toUpperCase()}**`,
    `Reference: \`${result.reference}\``,
    `Quarantine: \`${result.quarantinePath}\``,
    ""
  ];

  if (result.promotedPath) {
    lines.push(`Promoted to: \`${result.promotedPath}\``, "");
  }

  lines.push(renderMarkdown(result.report));
  return lines.join("\n");
}

try {
  main().catch((error) => {
    process.stderr.write(`pkgxray: ${error.message}\n`);
    process.exitCode = 1;
  });
} catch (error) {
  process.stderr.write(`pkgxray: ${error.message}\n`);
  process.exitCode = 1;
}
