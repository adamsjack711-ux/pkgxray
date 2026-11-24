"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { finalizeResult, finding, listFiles } = require("./common");
const { scanAgentPackage } = require("./agent");
const { scanCiDependencies } = require("./ci");

const TYPES = new Set(["auto", "all", "ci", "gitlab", "jenkins", "agent", "vsix", "jetbrains", "browser", "infrastructure"]);
const BLOCKING_CATEGORIES = new Set([
  "agent-path-escape",
  "agent-skill-sensitive-data",
  "ci-local-path-escape",
  "extension-entrypoint-escape",
  "extension-path-escape",
  "oci-digest-mismatch"
]);

function normalizeFinding(item, family) {
  const category = item.category || item.code || `${family}-finding`;
  const blocking = item.blocking === true || BLOCKING_CATEGORIES.has(category);
  if (item.category && item.rationale) return blocking ? { ...item, blocking: true } : item;
  return finding(
    item.severity || "medium",
    category,
    item.file || family.toUpperCase(),
    item.snippet || item.reference || item.message || "",
    item.rationale || item.message || "The distribution descriptor requires review.",
    blocking ? { blocking: true } : {}
  );
}

function normalizeFamily(raw, family, root) {
  const coverage = raw.coverage || {};
  return finalizeResult({
    family,
    root: raw.root || root,
    components: raw.components || raw.references || [],
    entrypoints: raw.entrypoints || [],
    findings: (raw.findings || []).map(item => normalizeFinding(item, family)),
    coverage: {
      complete: coverage.complete !== false,
      filesInspected: coverage.filesInspected ?? coverage.scannedFiles ?? 0,
      reasons: Array.isArray(coverage.reasons) ? coverage.reasons : []
    },
    metadata: raw.metadata || (raw.format ? { format: raw.format } : undefined)
  });
}

function detectedTypes(root, files) {
  const found = new Set();
  const has = relative => files.includes(relative);
  if (files.some(file => /^\.github\/(?:workflows\/.*\.ya?ml|actions\/.*\/action\.ya?ml)$/i.test(file))) found.add("ci");
  if (has(".gitlab-ci.yml") || has(".gitlab-ci.yaml")) found.add("gitlab");
  if (files.some(file => /(?:^|\/)(?:Jenkinsfile|[^/]+\.jenkinsfile)$/i.test(file))) found.add("jenkins");
  if (has(".mcp.json") || has("mcp.json") || has("server.json") || has(".codex-plugin/plugin.json") ||
      has(".claude-plugin/plugin.json") || files.some(file => /(?:^|\/)skills\/[^/]+\/SKILL\.md$/i.test(file))) found.add("agent");
  if (has("manifest.json")) found.add("browser");
  if (files.some(file => /(?:^|\/)META-INF\/plugin\.xml$/i.test(file))) found.add("jetbrains");
  if (has("extension/package.json")) found.add("vsix");
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
      if (pkg.engines && pkg.engines.vscode) found.add("vsix");
      if (pkg.mcpName || pkg.bin && (pkg.bin["mcp-server"] || pkg.bin.mcp)) found.add("agent");
    } catch { /* individual analyzers report malformed descriptors */ }
  }
  if (files.some(file => /(?:^|\/)(?:Chart\.yaml|\.terraform\.lock\.hcl|oci-layout|snapcraft\.ya?ml)$/i.test(file) ||
      /\.(?:tf|formula\.rb|cask\.rb|flatpak(?:ref|repo)|appxmanifest\.xml)$/i.test(file))) found.add("infrastructure");
  return [...found];
}

function scannerFor(type) {
  if (type === "ci") return { family: "ci-dependencies", run: scanCiDependencies };
  if (["gitlab", "jenkins", "jetbrains"].includes(type)) {
    const ecosystems = require("./ecosystems");
    const run = type === "gitlab" ? ecosystems.scanGitLabCi : type === "jenkins" ? ecosystems.scanJenkins : ecosystems.scanJetBrainsPlugin;
    if (typeof run !== "function") throw new Error(`The ${type} analyzer is unavailable`);
    return { family: type === "gitlab" ? "gitlab-ci" : type === "jenkins" ? "jenkins" : "jetbrains-plugin", run };
  }
  if (type === "agent") return { family: "agent-package", run: scanAgentPackage };
  if (type === "vsix" || type === "browser") {
    const extensions = require("./extensions");
    const run = type === "vsix" ? extensions.scanVsix : extensions.scanBrowserExtension;
    if (typeof run !== "function") throw new Error(`The ${type} analyzer is unavailable`);
    return { family: type === "vsix" ? "editor-extension" : "browser-extension", run };
  }
  if (type === "infrastructure") {
    const artifacts = require("./artifacts");
    const run = artifacts.scanInfrastructureArtifacts || artifacts.scanArtifacts || artifacts.scanArtifactDescriptors;
    if (typeof run !== "function") throw new Error("The infrastructure analyzer is unavailable");
    return { family: "infrastructure-artifacts", run };
  }
  throw new Error(`Unsupported distribution type: ${type}`);
}

/**
 * Analyze already-extracted executable distribution descriptors. Acquisition
 * is intentionally separate: callers must provide a local directory and may
 * bind it to an immutable digest before invoking this scanner.
 */
function scanDistribution(inputRoot, options = {}) {
  const root = fs.realpathSync(path.resolve(inputRoot));
  if (!fs.statSync(root).isDirectory()) throw new Error("Distribution scan target must be an extracted directory");
  const requested = options.type || "auto";
  if (!TYPES.has(requested)) throw new Error(`--type must be one of: ${[...TYPES].join(", ")}`);
  const inventory = listFiles(root, options);
  let types = requested === "all"
    ? ["ci", "gitlab", "jenkins", "agent", "vsix", "jetbrains", "browser", "infrastructure"]
    : requested === "auto" ? detectedTypes(root, inventory.files) : [requested];
  types = [...new Set(types)];
  const families = [];
  const orchestrationFindings = [];
  const orchestrationReasons = inventory.reasons || (inventory.reason ? [inventory.reason] : []);
  for (const type of types) {
    try {
      const scanner = scannerFor(type);
      families.push(normalizeFamily(scanner.run(root, options), scanner.family, root));
    } catch (error) {
      orchestrationReasons.push(`${type} analyzer could not complete: ${error.message}`);
      orchestrationFindings.push(finding("medium", "distribution-analyzer-error", type.toUpperCase(), error.message,
        `The ${type} analyzer could not complete; do not treat this distribution as fully inspected.`));
    }
  }
  if (types.length === 0) orchestrationReasons.push("no supported executable-distribution descriptors were detected");
  const combined = finalizeResult({
    family: "executable-distribution",
    root,
    components: families.flatMap(result => result.components),
    entrypoints: families.flatMap(result => result.entrypoints),
    findings: [...families.flatMap(result => result.findings), ...orchestrationFindings],
    coverage: {
      complete: inventory.complete && families.every(result => result.coverage.complete) && orchestrationReasons.length === 0,
      filesInspected: families.reduce((sum, result) => sum + result.coverage.filesInspected, 0),
      reasons: [...families.flatMap(result => result.coverage.reasons), ...orchestrationReasons]
    },
    metadata: { detectedTypes: types, extractedDirectoryOnly: true }
  });
  return { ...combined, families };
}

module.exports = { TYPES, detectedTypes, normalizeFamily, scanDistribution };
