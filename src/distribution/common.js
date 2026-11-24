"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_FILES = 5000;

function portable(relative) {
  return relative.split(path.sep).join("/");
}

function resolveInside(root, relative) {
  const base = path.resolve(root);
  const candidate = path.resolve(base, relative || ".");
  const rel = path.relative(base, candidate);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Path escapes scan root: ${relative}`);
  }
  return candidate;
}

function readText(root, relative, options = {}) {
  const full = resolveInside(root, relative);
  const stat = fs.lstatSync(full);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular file: ${relative}`);
  const limit = options.maxFileBytes || DEFAULT_MAX_FILE_BYTES;
  if (stat.size > limit) throw new Error(`Descriptor exceeds ${limit} bytes: ${relative}`);
  return fs.readFileSync(full, "utf8");
}

function readJson(root, relative, options = {}) {
  try {
    return JSON.parse(readText(root, relative, options));
  } catch (error) {
    throw new Error(`Could not parse ${portable(relative)}: ${error.message}`);
  }
}

function listFiles(root, options = {}) {
  const base = path.resolve(root);
  const maxFiles = options.maxFiles || DEFAULT_MAX_FILES;
  const skip = new Set(options.skipDirectories || [".git", "node_modules"]);
  const files = [];
  const directories = [base];
  const reasons = [];
  let entries = 0;
  for (let cursor = 0; cursor < directories.length; cursor += 1) {
    const directory = directories[cursor];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > maxFiles) {
        reasons.push(`file inventory limit (${maxFiles}) reached`);
        return { files: files.sort(), complete: false, reason: reasons[0], reasons };
      }
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        reasons.push(`symbolic link skipped: ${portable(path.relative(base, full))}`);
        continue;
      }
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) directories.push(full);
      } else if (entry.isFile()) {
        files.push(portable(path.relative(base, full)));
      }
    }
  }
  return { files: files.sort(), complete: reasons.length === 0, reason: reasons[0] || null, reasons };
}

function finding(severity, category, file, snippet, rationale, extra = {}) {
  return {
    severity,
    category,
    file: portable(file || "SCAN"),
    snippet: String(snippet || "").slice(0, 240),
    rationale,
    ...extra
  };
}

const SEVERITY = { info: 0, low: 1, medium: 2, high: 3 };

function stableUnique(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function finalizeResult(result) {
  const findings = stableUnique(result.findings || []).sort((a, b) =>
    (SEVERITY[b.severity] || 0) - (SEVERITY[a.severity] || 0) ||
    String(a.file).localeCompare(String(b.file)) ||
    String(a.category).localeCompare(String(b.category))
  );
  const components = stableUnique(result.components || []).sort((a, b) =>
    String(a.reference || a.name || "").localeCompare(String(b.reference || b.name || ""))
  );
  const entrypoints = stableUnique(result.entrypoints || []).sort((a, b) =>
    String(a.file || "").localeCompare(String(b.file || "")) ||
    String(a.command || a.path || "").localeCompare(String(b.command || b.path || ""))
  );
  const reasons = [...new Set(result.coverage?.reasons || [])].sort();
  const blocking = findings.some(item => item.blocking === true);
  const requiresReview = findings.some(item => (SEVERITY[item.severity] || 0) >= SEVERITY.medium);
  return {
    schemaVersion: 1,
    family: result.family || "distribution",
    root: result.root,
    verdict: blocking ? "block" : requiresReview || reasons.length ? "review" : "safe",
    components,
    entrypoints,
    findings,
    coverage: {
      complete: result.coverage?.complete !== false && reasons.length === 0,
      filesInspected: result.coverage?.filesInspected || 0,
      reasons
    },
    ...(result.metadata ? { metadata: result.metadata } : {})
  };
}

module.exports = {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES,
  finalizeResult,
  finding,
  listFiles,
  portable,
  readJson,
  readText,
  resolveInside
};
