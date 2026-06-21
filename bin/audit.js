#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { auditEvidence, renderMarkdown } = require("../src/auditor");
const { guardExtension } = require("../src/quarantine");
const { reasonAbout } = require("../src/reasoner");
const { detectAvailableProvider, reasoningSetupHint } = require("../src/providers");

function printUsage() {
  process.stderr.write(
    [
      "Usage:",
      "  pkgxray < evidence.json",
      "  pkgxray --format json < evidence.json",
      "  pkgxray --file evidence.json --format markdown",
      "  pkgxray --reason --file evidence.json",
      "  pkgxray guard <npm-package|npm:name@version|./path> [--reason] [--promote-to dir] [--no-source-scan]",
      "",
      "Evidence JSON fields:",
      "  packageName, npmMetadata, githubMetadata, webPresence, sourceFiles",
      "",
      "LLM reasoning runs automatically when any of ANTHROPIC_API_KEY,",
      "OPENAI_API_KEY, or GEMINI_API_KEY is set AND the matching SDK is",
      "installed (@anthropic-ai/sdk, openai, or @google/generative-ai).",
      "Use --no-reason to force static-only, --reason-provider <name> to pin a",
      "provider, --reason-model <id> to pin a model.",
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
    } else if (arg === "--reason") {
      options.reason = true;
    } else if (arg === "--no-reason") {
      options.reason = false;
      options.reasonExplicitOff = true;
    } else if (arg === "--reason-model") {
      options.reasonModel = argv[++i];
    } else if (arg === "--reason-provider") {
      options.reasonProvider = argv[++i];
    } else if (arg === "--reason-max-files") {
      options.reasonMaxFiles = Number(argv[++i]);
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

function resolveReasonMode(options) {
  if (options.reasonExplicitOff) return { enabled: false, autoDetected: false };
  if (options.reason) return { enabled: true, autoDetected: false };
  const detected = detectAvailableProvider();
  if (detected) {
    return { enabled: true, autoDetected: true, detectedProvider: detected.name };
  }
  return { enabled: false, autoDetected: false };
}

async function maybeReason(evidence, options, mode) {
  if (!mode || !mode.enabled) return null;
  try {
    return await reasonAbout(evidence, {
      provider: options.reasonProvider || mode.detectedProvider,
      model: options.reasonModel,
      maxFiles: options.reasonMaxFiles
    });
  } catch (error) {
    return { error: { code: error.code || "REASONER_ERROR", message: error.message } };
  }
}

function reasoningExitCode(reasoning) {
  if (!reasoning || reasoning.error) return null;
  if (reasoning.verdict === "block") return 2;
  if (reasoning.verdict === "review") return 3;
  return 0;
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
    const reasonMode = resolveReasonMode(options);
    if (reasonMode.enabled) {
      const evidenceForReason = {
        packageName: result.resolved && result.resolved.packageName,
        npmMetadata: result.resolved && result.resolved.npmMetadata,
        githubMetadata: null,
        webPresence: null,
        sourceFiles: result.sourceFiles || {}
      };
      const reasoning = await maybeReason(evidenceForReason, options, reasonMode);
      result.reasoning = reasoning;
      if (reasoning && !reasoning.error && reasoning.verdict) {
        result.decision = reasoning.verdict === "block"
          ? "block"
          : reasoning.verdict === "safe"
            ? "allow"
            : "review";
      }
    } else {
      result.reasoningHint = reasoningSetupHint();
    }
    if (options.format === "json") {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderGuardMarkdown(result)}\n`);
    }
    process.exitCode = result.decision === "block" ? 2 : result.decision === "review" ? 3 : 0;
    return;
  }

  const raw = readInput(options.file).trim();
  if (!raw) {
    throw new Error("No evidence JSON provided");
  }

  const evidence = JSON.parse(raw);
  const report = auditEvidence(evidence);
  const reasonMode = resolveReasonMode(options);
  const reasoning = await maybeReason(evidence, options, reasonMode);
  const hint = reasonMode.enabled ? null : reasoningSetupHint();

  const payload = reasoning
    ? { report, reasoning }
    : hint
      ? { report, reasoningHint: hint }
      : report;

  if (options.format === "json") {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (reasoning) {
    process.stdout.write(`${renderMarkdown(report)}\n\n---\n\n${renderReasoningMarkdown(reasoning)}\n`);
  } else if (hint) {
    process.stdout.write(`${renderMarkdown(report)}\n\n💡 ${hint}\n`);
  } else {
    process.stdout.write(`${renderMarkdown(report)}\n`);
  }

  const exitFromReason = reasoningExitCode(reasoning);
  if (exitFromReason !== null) {
    process.exitCode = exitFromReason;
  }
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

  if (result.reasoning) {
    lines.push("", "---", "", renderReasoningMarkdown(result.reasoning));
  } else if (result.reasoningHint) {
    lines.push("", `💡 ${result.reasoningHint}`);
  }

  return lines.join("\n");
}

function renderReasoningMarkdown(reasoning) {
  if (reasoning.error) {
    return `Reasoning: **unavailable** (${reasoning.error.code}: ${reasoning.error.message})`;
  }
  const lines = [
    `Reasoning verdict: **${(reasoning.verdict || "?").toUpperCase()}**`,
    `Provider: \`${reasoning.provider || "?"}\` · Model: \`${reasoning.model}\` · latency: ${reasoning.latencyMs} ms`,
    "",
    reasoning.summary || "",
    ""
  ];
  if (reasoning.usage) {
    const u = reasoning.usage;
    const parts = [
      `in=${u.input_tokens ?? "?"}`,
      `out=${u.output_tokens ?? "?"}`,
      `cache_read=${u.cache_read_input_tokens ?? 0}`,
      `cache_write=${u.cache_creation_input_tokens ?? 0}`
    ];
    lines.push(`Tokens: ${parts.join(" · ")}`, "");
  }
  if (reasoning.findings && reasoning.findings.length > 0) {
    lines.push("Findings:");
    for (const finding of reasoning.findings) {
      lines.push(
        `- **${finding.severity.toUpperCase()} - ${finding.category}**: ${finding.reasoning}`,
        `  Evidence: \`${finding.evidence}\``
      );
    }
    lines.push("");
  } else {
    lines.push("Findings: none reported.", "");
  }
  if (reasoning.evidenceGaps && reasoning.evidenceGaps.length > 0) {
    lines.push("Evidence gaps:");
    for (const gap of reasoning.evidenceGaps) {
      lines.push(`- ${gap}`);
    }
  }
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
