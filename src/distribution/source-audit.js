"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { auditEvidence } = require("../auditor");
const { createSourcePlan } = require("../source-plan");

const DEFAULT_MAX_FILES = 600;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_INVENTORY_FILES = 20_000;

function portable(value) { return value.split(path.sep).join("/"); }

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sourceFamilies(distribution) {
  const values = Array.isArray(distribution && distribution.families) ? distribution.families : [distribution];
  return values.filter(value => value && Array.isArray(value.entrypoints) && value.entrypoints.length > 0);
}

async function inventoryRoot(root, options, reasons) {
  const max = options.maxInventoryFiles ?? DEFAULT_MAX_INVENTORY_FILES;
  const inventory = new Map();
  const pending = [root];
  let entries = 0;
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    let listed;
    try { listed = await fsp.readdir(pending[cursor], { withFileTypes: true }); }
    catch (error) { reasons.push(`could not inventory ${portable(path.relative(root, pending[cursor]) || ".")}: ${error.message}`); continue; }
    listed.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of listed) {
      if (++entries > max) {
        reasons.push(`source inventory limit (${max}) reached`);
        return inventory;
      }
      const full = path.join(pending[cursor], entry.name);
      const relative = portable(path.relative(root, full));
      if (entry.isSymbolicLink()) reasons.push(`source symbolic link skipped: ${relative}`);
      else if (entry.isDirectory()) {
        if (!new Set([".git", "node_modules", "coverage", ".next", ".turbo"]).has(entry.name)) pending.push(full);
      } else if (entry.isFile()) inventory.set(relative, full);
    }
  }
  return inventory;
}

function payloadFor(family, root) {
  if (family.family === "editor-extension" && fs.existsSync(path.join(root, "extension", "package.json"))) {
    return { root: path.join(root, "extension"), prefix: "extension/" };
  }
  return { root, prefix: "" };
}

function declaredPaths(family) {
  return [...new Set((family.entrypoints || [])
    .filter(entry => entry && typeof entry.path === "string" && entry.path.trim() &&
      entry.exists !== false && (entry.exists === true || entry.withinRoot === true ||
        family.family === "agent-package" && entry.kind === "binary"))
    .map(entry => portable(entry.path)))].sort();
}

function mergeSource(target, key, content, reasons) {
  if (Object.hasOwn(target, key) && target[key] !== content) {
    reasons.push(`source path collision while combining families: ${key}`);
    return;
  }
  target[key] = content;
}

async function collectFamily(family, distributionRoot, state, options) {
  const declared = declaredPaths(family);
  if (!declared.length) {
    state.reasons.push(`${family.family} declared no readable executable entrypoints`);
    return;
  }
  const selected = payloadFor(family, distributionRoot);
  let realRoot;
  try { realRoot = await fsp.realpath(selected.root); }
  catch (error) { state.reasons.push(`${family.family} payload root is unavailable: ${error.message}`); return; }
  if (!inside(distributionRoot, realRoot)) {
    state.reasons.push(`${family.family} payload root resolves outside the distribution`);
    return;
  }
  const inventory = await inventoryRoot(realRoot, options, state.reasons);
  const plan = createSourcePlan(inventory);
  let manifest = null;
  if (inventory.has("package.json")) {
    try {
      const manifestFile = inventory.get("package.json");
      const stat = await fsp.lstat(manifestFile);
      const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
      const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
      const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file");
      if (stat.size > maxFileBytes) throw new Error(`exceeds ${maxFileBytes} bytes`);
      if (state.filesRead >= maxFiles) throw new Error(`source file limit (${maxFiles}) reached`);
      if (state.bytesRead + stat.size > maxTotalBytes) throw new Error(`source byte limit (${maxTotalBytes}) reached`);
      const text = await fsp.readFile(manifestFile, "utf8");
      mergeSource(state.sourceFiles, `${selected.prefix}package.json`, text, state.reasons);
      state.bytesRead += stat.size;
      state.filesRead += 1;
      manifest = JSON.parse(text);
      plan.manifest(manifest);
    } catch (error) {
      state.reasons.push(`${selected.prefix}package.json could not seed source resolution: ${error.message}`);
    }
  }
  // Make every descriptor-declared entrypoint a runtime root while retaining
  // the package's real manifest metadata and lifecycle scripts above.
  plan.manifest({ bin: Object.fromEntries(declared.map((file, index) => [`declared-${index}`, file])) });
  for (const declaredPath of declared) {
    const normalized = path.posix.normalize(declaredPath.replace(/\\/g, "/"));
    if (normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
      state.reasons.push(`declared source escapes payload: ${declaredPath}`);
    }
  }

  const visited = new Set();
  while (true) {
    const relative = [...plan.required].sort().find(file => !visited.has(file));
    if (!relative) break;
    visited.add(relative);
    const full = inventory.get(relative);
    if (!full) { state.reasons.push(`declared runtime file was not inventoried: ${selected.prefix}${relative}`); continue; }
    if (state.filesRead >= (options.maxFiles ?? DEFAULT_MAX_FILES)) {
      state.reasons.push(`source file limit (${options.maxFiles ?? DEFAULT_MAX_FILES}) reached`);
      break;
    }
    let stat;
    try { stat = await fsp.lstat(full); }
    catch (error) { state.reasons.push(`could not stat ${selected.prefix}${relative}: ${error.message}`); continue; }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      state.reasons.push(`declared runtime path is not a regular file: ${selected.prefix}${relative}`);
      continue;
    }
    const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    if (stat.size > maxFileBytes) {
      state.reasons.push(`declared runtime file exceeds ${maxFileBytes} bytes: ${selected.prefix}${relative}`);
      continue;
    }
    if (state.bytesRead + stat.size > maxTotalBytes) {
      state.reasons.push(`source byte limit (${maxTotalBytes}) reached`);
      break;
    }
    const content = await fsp.readFile(full, "utf8");
    const evidencePath = `${selected.prefix}${relative}`;
    mergeSource(state.sourceFiles, evidencePath, content, state.reasons);
    state.bytesRead += stat.size;
    state.filesRead += 1;
    plan.imports(relative, content);
  }

  for (const gap of plan.gaps) state.reasons.push(`${selected.prefix}${gap}`);
  for (const file of plan.required) state.runtimeFiles.add(`${selected.prefix}${file}`);
  for (const file of plan.installTime) state.installTimeFiles.add(`${selected.prefix}${file}`);
  state.selectedEntrypoints.push(...declared.map(file => `${selected.prefix}${file}`));
}

/**
 * Audit code reachable from descriptor-declared VSIX/browser entrypoints.
 * Descriptor inspection alone never counts as source coverage.
 */
async function auditDeclaredSources(distribution, options = {}) {
  const inputRoot = options.root || distribution && distribution.root;
  if (!inputRoot) throw new Error("Declared source audit requires a distribution root");
  const root = await fsp.realpath(path.resolve(inputRoot));
  const families = sourceFamilies(distribution);
  const state = {
    sourceFiles: Object.create(null), reasons: [], runtimeFiles: new Set(), installTimeFiles: new Set(),
    selectedEntrypoints: [], filesRead: 0, bytesRead: 0
  };
  if (!families.length) state.reasons.push("no supported family supplied declared executable source entrypoints");
  for (const family of families) await collectFamily(family, root, state, options);
  if (!state.selectedEntrypoints.length) state.reasons.push("no declared executable files were selected for source analysis");
  const coverage = {
    complete: state.reasons.length === 0 && state.selectedEntrypoints.length > 0,
    scannedFiles: state.filesRead,
    scannedBytes: state.bytesRead,
    selectedEntrypoints: [...new Set(state.selectedEntrypoints)].sort(),
    runtimeFiles: [...state.runtimeFiles].sort(),
    installTimeFiles: [...state.installTimeFiles].sort(),
    reasons: [...new Set(state.reasons)].sort(),
    behavioralScope: "declared-distribution-entrypoints"
  };
  const packageName = families.map(family => family.metadata && family.metadata.name).find(Boolean) || null;
  const report = auditEvidence({
    packageName,
    sourceFiles: state.sourceFiles,
    sourceCoverage: coverage,
    ecosystem: "npm"
  }, { typosquat: options.typosquat });
  return {
    schemaVersion: 1,
    verdict: report.verdict,
    report,
    coverage,
    files: Object.keys(state.sourceFiles).sort()
  };
}

module.exports = {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_INVENTORY_FILES,
  DEFAULT_MAX_TOTAL_BYTES,
  auditDistributionSource: auditDeclaredSources,
  auditDeclaredSources,
  declaredPaths
};
