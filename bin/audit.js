#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { auditEvidence, renderMarkdown } = require("../src/auditor");
const { guardExtension } = require("../src/quarantine");
const { auditLockfile, renderLockfileMarkdown, sanitizeForTerminal } = require("../src/lockfile");
const { triageLockfile } = require("../src/triage");

function printUsage() {
  process.stderr.write(
    [
      "Usage:",
      "  pkgxray < evidence.json",
      "  pkgxray --format json < evidence.json",
      "  pkgxray --file evidence.json --format markdown",
      "  pkgxray guard <npm-package|npm:name@version|github:owner/repo[#ref]|./path> [--promote-to dir] [--no-source-scan]",
      "  pkgxray audit <package-lock.json|yarn.lock|pnpm-lock.yaml|package.json>  # batch OSV scan of every dep",
      "  pkgxray triage <lockfile> [--include-safe] [--auto allow|block]          # interactive allow/block walkthrough",
      "  pkgxray triage --resume                                                  # resume interrupted triage",
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
  } else if (argv[0] === "triage") {
    options.command = "triage";
    // Allow `pkgxray triage --resume` with no lockfile path (we resolve at
    // run time from CWD's .pkgxray.lock if it exists; otherwise we still
    // require a lockfile path).
    if (argv[1] && !argv[1].startsWith("--")) {
      options.lockfilePath = argv[1];
      argv = argv.slice(2);
    } else {
      argv = argv.slice(1);
    }
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
    } else if (arg === "--deep") {
      options.deep = true;
    } else if (arg === "--deep-all") {
      options.deep = true;
      options.deepAll = true;
    } else if (arg === "--include-safe") {
      options.includeSafe = true;
    } else if (arg === "--resume") {
      options.resume = true;
    } else if (arg === "--auto") {
      options.auto = argv[++i];
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

  if (options.command === "triage") {
    if (!options.lockfilePath) {
      throw new Error("triage requires a lockfile path (package-lock.json | yarn.lock | pnpm-lock.yaml | package.json)");
    }
    try {
      const result = await triageLockfile(options.lockfilePath, options);
      // Exit 0 when triage completes (or auto-mode runs) — the user has
      // exercised judgment, so a blocked count isn't an error here.
      process.exitCode = 0;
      // result intentionally not printed beyond the in-loop output.
      void result;
    } catch (error) {
      if (error && error.code === "ENOTTY") {
        process.exitCode = 1;
        return;
      }
      throw error;
    }
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

function renderGuardMarkdown(result) {
  const lines = [
    `Decision: **${result.decision.toUpperCase()}**`,
    `Reference: \`${sanitizeForTerminal(result.reference)}\``,
    `Quarantine: \`${sanitizeForTerminal(result.quarantinePath)}\``,
    ""
  ];

  if (result.promotedPath) {
    lines.push(`Promoted to: \`${sanitizeForTerminal(result.promotedPath)}\``, "");
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
