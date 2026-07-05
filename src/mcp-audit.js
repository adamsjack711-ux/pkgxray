"use strict";

// MCP adapter orchestration — package-scan-first, then connect-and-enumerate,
// then route the manifest through the EXISTING scanner.
//
// The ordering is the point (see MCP_ADAPTER_PROMPT.md): enumerating a stdio
// server SPAWNS it, so when the server ships as a package/local ref the
// static, no-execution scan (guardExtension — the same call `pkgxray guard`
// makes) runs BEFORE any connection, and a `block` halts the connect step
// unless the caller force-accepts.
//
// T2 adds no detection logic of its own — the design test from the prompt.
// A tool manifest (names, descriptions, input schemas, and the server's
// `instructions` blurb) is just a new INPUT to the injection/concealment
// layer pkgxray already ships. Each tool is rendered as a doc-typed evidence
// file (.md), because `auditFiles` gives documentation exactly the scan set a
// manifest needs — tiered prompt-injection matching, unicode-tag smuggling,
// base64-envelope decode — and none of the code-malware heuristics that would
// false-positive on a description legitimately mentioning `process.env`.

const { auditEvidence, decideVerdict } = require("./auditor");
const { guardExtension } = require("./quarantine");
const { enumerateMcpServer } = require("./mcp-client");
const { worstVerdict } = require("./recheck");

// Findings about *package* evidence completeness. A manifest is a different
// input type: it has no package.json to be missing and no npm/GitHub
// provenance to cross-check, so these categories are inapplicable — without
// this filter a perfectly clean manifest could never reach `safe`
// (decideVerdict forces `review` on them). Detection findings are untouched.
const PACKAGE_EVIDENCE_CATEGORIES = new Set([
  "missing-evidence",
  "missing-package-json",
  "package-metadata",
  "missing-metadata",
  "supply-chain-signal",
  "github-fetch"
]);

// Tool names are attacker-controlled. They become evidence-map keys, and the
// auditor routes scans BY PATH SHAPE (doc extension, test-dir downgrade) — so
// a hostile name like `../lib/x.test.js` must not be able to change how its
// own description is scanned. Reduce to a conservative slug and dedupe.
function safeToolSlug(name, taken) {
  let slug = String(name).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "tool";
  if (taken.has(slug)) {
    let n = 2;
    while (taken.has(`${slug}-${n}`)) n += 1;
    slug = `${slug}-${n}`;
  }
  taken.add(slug);
  return slug;
}

function toolDocument(tool) {
  const lines = [`# Tool: ${tool.name}`, ""];
  if (tool.title) lines.push(tool.title, "");
  lines.push("## Description", "", tool.description || "(none)", "");
  if (tool.inputSchema) {
    lines.push("## Input schema", "", JSON.stringify(tool.inputSchema, null, 2), "");
  }
  return lines.join("\n");
}

function serverDocument(manifest) {
  const lines = [
    `# MCP server: ${manifest.server.name || "(unnamed)"}`,
    "",
    `Version: ${manifest.server.version || "(unknown)"}`,
    `Transport: ${manifest.transport}`,
    ""
  ];
  if (manifest.server.title) lines.push(manifest.server.title, "");
  // `instructions` is text the server asks the HOST to inject into the model's
  // context — the single most injection-shaped field in the protocol.
  if (manifest.instructions) {
    lines.push("## Server instructions", "", manifest.instructions, "");
  }
  return lines.join("\n");
}

// Pair every tool with its stable evidence path so the text scan (T2) and the
// capability-mismatch check (T3) cite the same file.
function manifestEntries(manifest) {
  const taken = new Set();
  return manifest.tools.map((tool) => ({
    tool,
    path: `mcp-manifest/tool-${safeToolSlug(tool.name, taken)}.md`
  }));
}

// Shape a normalized manifest into the `path → text` evidence input
// `auditEvidence` consumes. Doc-typed (.md) paths on purpose — see the module
// comment. Paths avoid every TEST_DIR_REGEX component so nothing the server
// controls can earn itself the test-fixture severity downgrade.
function manifestSourceFiles(manifest) {
  const files = {};
  files["mcp-manifest/server.md"] = serverDocument(manifest);
  for (const { tool, path } of manifestEntries(manifest)) {
    files[path] = toolDocument(tool);
  }
  return files;
}

// --- T3: capability-surface mismatch ----------------------------------------
// The one genuinely new detector in the MCP adapter. The signal is the
// MISMATCH — a tool whose declared purpose is narrow and innocuous but whose
// input schema exposes a general-execution surface (get_weather taking a
// `command`) — never the powerful-looking parameter alone. A file reader
// taking `path`, an HTTP tool taking `url`, a DB tool taking `query`, and an
// honest `execute_shell` tool taking `command` are all coherent and stay
// unflagged; capability review of a *declared* executor is the host's job.

// Parameter names that mean "run this" with no plausible second reading.
// Deliberately NOT here: `code` (error/postal/status/currency code), `query`
// (every DB/search tool), `expression` (calculators), `path`/`url`/`sql`.
const EXEC_PARAM_NAMES = new Set([
  "command",
  "cmd",
  "cmdline",
  "command_line",
  "shell",
  "shell_command",
  "shell_cmd",
  "bash",
  "powershell",
  "exec",
  "eval",
  "script",
  "source_code",
  "code_to_run",
  "code_to_execute",
  "python_code",
  "js_code",
  "javascript_code"
]);

// A parameter whose own description says "this gets executed" is exec-shaped
// whatever it is named.
const EXEC_PARAM_DESC_RE =
  /\b(?:shell\s+command|command\s+(?:line\s+)?to\s+(?:run|execute)|(?:arbitrary|any)\s+(?:code|command|shell)|code\s+to\s+(?:run|execute|evaluate)|(?:run|execute[ds]?)\s+(?:as|in|via)\s+(?:a\s+)?(?:shell|subprocess|terminal|interpreter))\b/i;

// Vocabulary that DECLARES execution in the tool's stated purpose. When the
// purpose says "run/shell/script/...", an exec parameter is coherent, not a
// mismatch — this test keeps the detector conservative.
const EXEC_PURPOSE_RE =
  /\b(?:run|runs|running|execute[sd]?|executing|execution|shell|command|commands|terminal|console|repl|eval|interpret(?:er|s)?|script(?:s|ing)?|sandbox|compil(?:e|er|es)|subprocess|process)\b/i;

function normalizeParamName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// Walk a JSON Schema's named parameters (bounded — a hostile schema must not
// recurse us to death).
function collectParams(schema, out, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 5) return out;
  if (schema.properties && typeof schema.properties === "object") {
    for (const [name, spec] of Object.entries(schema.properties)) {
      out.push({ name, spec: spec && typeof spec === "object" ? spec : {} });
      collectParams(spec, out, depth + 1);
    }
  }
  if (schema.items && typeof schema.items === "object") {
    collectParams(schema.items, out, depth + 1);
  }
  return out;
}

function inspectCapabilityMismatch(tool, evidencePath) {
  if (!tool.inputSchema) return [];

  const purpose = [tool.name, tool.title || "", tool.description || ""].join(" ");
  // The purpose declares execution — a command param is what it says on the
  // tin. Not a mismatch, by construction.
  if (EXEC_PURPOSE_RE.test(purpose)) return [];

  const findings = [];
  const declaredPurpose = (tool.description || "").trim();
  for (const { name, spec } of collectParams(tool.inputSchema, [])) {
    const execName = EXEC_PARAM_NAMES.has(normalizeParamName(name));
    const execDesc =
      typeof spec.description === "string" && EXEC_PARAM_DESC_RE.test(spec.description);
    if (!execName && !execDesc) continue;

    // Unambiguous mismatch: a stated, innocuous purpose paired with a
    // general-execution parameter. With no stated purpose there is nothing
    // to contradict — that is uncertainty, and uncertainty routes to review.
    const hasStatedPurpose = declaredPurpose.length >= 10;
    findings.push({
      severity: hasStatedPurpose ? "high" : "medium",
      category: "capability-mismatch",
      file: evidencePath,
      snippet: `param "${name}"${spec.description ? ` ("${String(spec.description).slice(0, 120)}")` : ""} on tool "${tool.name}"${declaredPurpose ? ` — declared purpose: "${declaredPurpose.slice(0, 160)}"` : ""}`,
      rationale: hasStatedPurpose
        ? "The tool presents a narrow, innocuous purpose but its input schema accepts a general-execution parameter — the description says one thing, the surface says \"run anything\"."
        : "The tool exposes a general-execution parameter and declares no purpose that would justify it — flagged for human review."
    });
    break; // one finding per tool is enough evidence; don't pile on per param
  }
  return findings;
}

// Scan one tool RESULT's text through the same doc-typed evidence path the
// manifest audit uses (tiered prompt-injection, unicode-tag smuggling, base64
// envelopes — none of the code-malware heuristics). This is the per-call
// rug-pull surface: a server whose manifest was clean can still steer the
// model through poisoned tool OUTPUT. Caller bounds `text` (the proxy caps at
// RESULT_SCAN_CAP) so a huge result can't turn a µs gate into a stall.
function scanResultText(toolName, text) {
  const taken = new Set();
  const path = `mcp-result/${safeToolSlug(toolName, taken)}.md`;
  const report = auditEvidence({
    packageName: `mcp-result:${toolName}`,
    sourceFiles: { [path]: String(text) }
  });
  return report.findings.filter(
    (finding) => !PACKAGE_EVIDENCE_CATEGORIES.has(finding.category)
  );
}

// Route the manifest through the existing engine and fold a verdict over it.
// Same verdict vocabulary ({safe, review, block}), same severity fold
// (decideVerdict) — only the inapplicable package-evidence findings are
// dropped first.
function auditManifest(manifest) {
  const entries = manifestEntries(manifest);
  const sourceFiles = { "mcp-manifest/server.md": serverDocument(manifest) };
  for (const { tool, path } of entries) sourceFiles[path] = toolDocument(tool);

  const report = auditEvidence({
    packageName: manifest.server.name || manifest.target,
    sourceFiles
  });
  const findings = report.findings.filter(
    (finding) => !PACKAGE_EVIDENCE_CATEGORIES.has(finding.category)
  );
  // T3 — the one net-new analysis: schema shape vs. declared purpose.
  for (const { tool, path } of entries) {
    findings.push(...inspectCapabilityMismatch(tool, path));
  }
  const evidenceShape = {
    sourceFiles: Object.entries(sourceFiles).map(([path, content]) => ({ path, content }))
  };
  return {
    verdict: decideVerdict(findings, evidenceShape),
    findings,
    toolCount: manifest.tools.length,
    report
  };
}

// Inspect an MCP server: optionally package-scan it, then enumerate its tool
// manifest, then audit the manifest text.
//
// target  — { url } or { command, args } (see enumerateMcpServer)
// options —
//   packageRef     npm/github/local reference the server ships as; scanned
//                  with guardExtension before any connection.
//   packageScan    false to skip the scan even when packageRef is given
//                  (the CLI surfaces this as --no-package-scan, loudly).
//   force          connect even when the package scan says block.
//   audit          false to skip the manifest audit (enumerate-only).
//   guard          injectable guard implementation (tests); defaults to
//                  guardExtension.
//   timeoutMs, cwd, extraEnv — forwarded to the enumeration.
//
// Returns { packageScan, manifest, manifestAudit, verdict, halted }:
//   packageScan   — null when no scan ran, else { reference, decision,
//                   verdict, report } straight from the guard.
//   manifestAudit — null when skipped, else { verdict, findings, report }.
//   verdict       — worst of the package-scan verdict and the manifest
//                   verdict; "block" when halted.
//   halted        — true when a block package scan stopped us before
//                   connecting (manifest is null in that case).
async function inspectMcpServer(target, options = {}) {
  const guard = options.guard || guardExtension;
  let packageScan = null;

  if (options.packageRef && options.packageScan !== false) {
    const result = await guard(options.packageRef, {
      quarantineRoot: options.quarantineRoot,
      policy: options.policy
    });
    packageScan = {
      reference: options.packageRef,
      decision: result.decision,
      verdict: result.report ? result.report.verdict : null,
      report: result.report || null
    };
    if (result.decision === "block" && !options.force) {
      return { packageScan, manifest: null, manifestAudit: null, verdict: "block", halted: true };
    }
  }

  const manifest = await enumerateMcpServer(target, {
    timeoutMs: options.timeoutMs,
    cwd: options.cwd,
    extraEnv: options.extraEnv
  });

  const manifestAudit = options.audit === false ? null : auditManifest(manifest);

  const verdict = worstVerdict(
    [
      manifestAudit ? manifestAudit.verdict : "safe",
      packageScan && packageScan.verdict ? packageScan.verdict : "safe"
    ]
  );

  return { packageScan, manifest, manifestAudit, verdict, halted: false };
}

module.exports = {
  inspectMcpServer,
  auditManifest,
  manifestSourceFiles,
  manifestEntries,
  inspectCapabilityMismatch,
  scanResultText
};
