#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { auditEvidence, renderMarkdown } = require("../src/auditor");
const { guardExtension } = require("../src/quarantine");
const { auditLockfile, renderLockfileMarkdown, sanitizeForTerminal } = require("../src/lockfile");
const { triageLockfile } = require("../src/triage");
const { recheckLockfile, renderRecheckText, recheckJson } = require("../src/recheck");
const { inspectMcpServer } = require("../src/mcp-audit");

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
      "  pkgxray recheck <lockfile> [--verbose] [--no-write]                      # re-evaluate pinned deps; diff verdict vs. stored baseline",
      "                     [--no-version-drift] [--fail-on-available-updates]     #   + pre-vet newer versions (informational unless --fail-on-...)",
      "  pkgxray mcp [flags] <https-url | command [args...]>                       # enumerate an MCP server's tool manifest (read-only handshake)",
      "                     [--package <ref>] [--no-package-scan] [--force]        #   package-scan-first: guard the ref BEFORE connecting; block halts",
      "                     [--timeout <ms>]                                       #   NOTE: enumerating a stdio server SPAWNS it — scan first",
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
  } else if (argv[0] === "recheck") {
    options.command = "recheck";
    options.lockfilePath = argv[1];
    argv = argv.slice(2);
  } else if (argv[0] === "mcp") {
    options.command = "mcp";
    argv = argv.slice(1);
    // Own flags come first; the first non-flag token starts the target —
    // an https URL, or a stdio command whose remaining argv (flags included)
    // belongs to the server, not to us.
    while (argv.length > 0 && argv[0].startsWith("--")) {
      const arg = argv.shift();
      if (arg === "--package") {
        options.packageRef = argv.shift();
      } else if (arg === "--no-package-scan") {
        options.packageScan = false;
      } else if (arg === "--no-audit") {
        options.audit = false;
      } else if (arg === "--force") {
        options.force = true;
      } else if (arg === "--timeout") {
        options.timeoutMs = Number(argv.shift());
        if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
          throw new Error("--timeout must be a positive number of milliseconds");
        }
      } else if (arg === "--format") {
        options.format = argv.shift();
      } else if (arg === "--help" || arg === "-h") {
        options.help = true;
      } else {
        throw new Error(`Unknown mcp argument: ${arg}`);
      }
    }
    if (argv.length > 0) {
      if (/^https?:\/\//i.test(argv[0])) {
        options.mcpTarget = { url: argv[0] };
        if (argv.length > 1) {
          throw new Error("an HTTP MCP target takes no further arguments");
        }
      } else {
        options.mcpTarget = { command: argv[0], args: argv.slice(1) };
      }
    }
    argv = [];
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
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "--no-write") {
      options.write = false;
    } else if (arg === "--no-version-drift") {
      options.versionDrift = false;
    } else if (arg === "--fail-on-available-updates") {
      options.failOnAvailableUpdates = true;
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
    // Keep the staging tree so the user can inspect / promote it from the
    // printed Quarantine path; non-interactive callers reap it by default.
    const result = await guardExtension(options.reference, { ...options, keepStaging: true });
    if (options.format === "json") {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderGuardMarkdown(result)}\n`);
    }
    process.exitCode = result.decision === "block" ? 2 : result.decision === "review" ? 3 : 0;
    return;
  }

  if (options.command === "mcp") {
    if (!options.mcpTarget) {
      throw new Error("mcp requires a target: an https:// URL or a stdio command");
    }
    // The caveat, said out loud every time it applies: enumerating a stdio
    // server runs it. A prior package scan is the safe order.
    if (options.mcpTarget.command && !options.packageRef) {
      process.stderr.write(
        "pkgxray: note — enumerating a stdio MCP server SPAWNS it. No package scan was requested; pass --package <ref> to statically vet the server first.\n"
      );
    } else if (options.packageScan === false) {
      process.stderr.write(
        "pkgxray: note — package scan skipped (--no-package-scan); connecting to an unvetted server.\n"
      );
    }
    const result = await inspectMcpServer(options.mcpTarget, options);
    if (options.format === "json") {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderMcpMarkdown(result)}\n`);
    }
    process.exitCode =
      result.verdict === "block" ? 2 : result.verdict === "review" ? 3 : 0;
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

  if (options.command === "recheck") {
    if (!options.lockfilePath) {
      throw new Error("recheck requires a lockfile path (package-lock.json | yarn.lock | pnpm-lock.yaml | package.json)");
    }
    const result = await recheckLockfile(options.lockfilePath, options);
    if (options.format === "json") {
      process.stdout.write(`${JSON.stringify(recheckJson(result), null, 2)}\n`);
    } else {
      process.stdout.write(`${renderRecheckText(result, { verbose: options.verbose })}\n`);
    }
    // Exit code reflects the worst *regression*, never the worst absolute
    // verdict — a still-block dep that was already block is not a new exposure.
    process.exitCode = result.exitCode;
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

// Every string in the manifest is attacker-controlled (a hostile server names
// its own tools) — strip control bytes before it reaches a terminal.
function renderMcpMarkdown(result) {
  const lines = [];

  if (result.packageScan) {
    lines.push(
      `Package scan: **${result.packageScan.decision.toUpperCase()}** — \`${sanitizeForTerminal(result.packageScan.reference)}\``
    );
  }
  if (result.halted) {
    lines.push(
      "",
      "Enumeration halted: the package scan says **BLOCK**. Pass --force to connect anyway (not recommended)."
    );
    return lines.join("\n");
  }

  const manifest = result.manifest;
  lines.push(
    `Server: **${sanitizeForTerminal(manifest.server.name || "(unnamed)")}** v${sanitizeForTerminal(manifest.server.version || "?")}`,
    `Transport: ${manifest.transport} — \`${sanitizeForTerminal(manifest.target)}\``,
    `Protocol: ${sanitizeForTerminal(manifest.protocolVersion || "unknown")}`,
    "",
    `Tools (${manifest.tools.length}):`
  );
  for (const tool of manifest.tools) {
    const params = tool.inputSchema && tool.inputSchema.properties
      ? Object.keys(tool.inputSchema.properties).join(", ")
      : "";
    lines.push(
      `- \`${sanitizeForTerminal(tool.name)}\`${params ? ` (${sanitizeForTerminal(params)})` : ""} — ${sanitizeForTerminal(tool.description || "(no description)")}`
    );
  }
  for (const warning of manifest.diagnostics.warnings || []) {
    lines.push(`> warning: ${sanitizeForTerminal(warning)}`);
  }

  if (result.manifestAudit) {
    lines.push("", `Manifest verdict: **${result.verdict.toUpperCase()}**`);
    const visible = result.manifestAudit.findings.filter((f) => f.severity !== "info");
    for (const finding of visible) {
      lines.push(
        `- [${finding.severity.toUpperCase()}] ${sanitizeForTerminal(finding.category)} in \`${sanitizeForTerminal(finding.file)}\`: ${sanitizeForTerminal(finding.rationale)}`
      );
    }
    if (visible.length === 0) {
      lines.push("- no findings in the tool manifest");
    }
  }
  return lines.join("\n");
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
