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

// Shape a normalized manifest into the `path → text` evidence input
// `auditEvidence` consumes. Doc-typed (.md) paths on purpose — see the module
// comment. Paths avoid every TEST_DIR_REGEX component so nothing the server
// controls can earn itself the test-fixture severity downgrade.
function manifestSourceFiles(manifest) {
  const files = {};
  files["mcp-manifest/server.md"] = serverDocument(manifest);
  const taken = new Set();
  for (const tool of manifest.tools) {
    files[`mcp-manifest/tool-${safeToolSlug(tool.name, taken)}.md`] = toolDocument(tool);
  }
  return files;
}

// Route the manifest through the existing engine and fold a verdict over it.
// Same verdict vocabulary ({safe, review, block}), same severity fold
// (decideVerdict) — only the inapplicable package-evidence findings are
// dropped first.
function auditManifest(manifest) {
  const sourceFiles = manifestSourceFiles(manifest);
  const report = auditEvidence({
    packageName: manifest.server.name || manifest.target,
    sourceFiles
  });
  const findings = report.findings.filter(
    (finding) => !PACKAGE_EVIDENCE_CATEGORIES.has(finding.category)
  );
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
  manifestSourceFiles
};
