"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_FILES = 256;
const DEFAULT_MAX_DEPTH = 24;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;
const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/i;

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join("/") || ".";
}

function finding(code, severity, file, line, message) {
  return { code, severity, file, line, message };
}

// GitHub accepts a YAML scalar here, not a sequence or object. This deliberately
// implements only that bounded surface instead of pretending to be a YAML parser.
function scalar(value) {
  let comment = -1;
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") quote = null;
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === "#" && (index === 0 || /\s/.test(value[index - 1]))) {
      comment = index;
      break;
    }
  }
  let out = (comment === -1 ? value : value.slice(0, comment)).trim();
  if (out.length >= 2 && ((out[0] === "\"" && out.at(-1) === "\"") || (out[0] === "'" && out.at(-1) === "'"))) {
    out = out.slice(1, -1);
  }
  return out.trim();
}

function extractUses(source) {
  const references = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const match = /^\s*(?:-\s*)?uses\s*:\s*(.*?)\s*$/.exec(line);
    if (match) references.push({ value: scalar(match[1]), line: index + 1 });
  }
  return references;
}

function classifyReference(value) {
  if (!value || value.includes("${{")) {
    return { kind: "dynamic", pin: { type: "dynamic", value: null, immutable: false } };
  }
  if (value.startsWith("./") || value.startsWith("../")) {
    return { kind: "local", pin: { type: "local", value: null, immutable: true } };
  }
  if (value.startsWith("docker://")) {
    const image = value.slice("docker://".length);
    const at = image.lastIndexOf("@");
    const digest = at === -1 ? null : image.slice(at + 1);
    return {
      kind: "container-image",
      pin: digest && OCI_DIGEST.test(digest)
        ? { type: "digest", value: digest, immutable: true }
        : { type: at === -1 ? "tag" : "invalid-digest", value: digest, immutable: false }
    };
  }
  const at = value.lastIndexOf("@");
  const target = at === -1 ? value : value.slice(0, at);
  const ref = at === -1 ? null : value.slice(at + 1);
  const kind = /^(?:[^/]+\/){2}\.github\/workflows\/[^/]+\.ya?ml$/i.test(target)
    ? "reusable-workflow"
    : "remote-action";
  return {
    kind,
    pin: ref && COMMIT_SHA.test(ref)
      ? { type: "commit", value: ref, immutable: true }
      : { type: ref ? "ref" : "missing", value: ref, immutable: false }
  };
}

function discoverYaml(directory, accept, coverage, limits) {
  const files = [];
  if (!fs.existsSync(directory)) return files;
  function walk(current) {
    if (coverage.discoveredFiles >= limits.maxFiles) {
      coverage.complete = false;
      coverage.reasons.add(`discovery stopped at the ${limits.maxFiles}-file limit`);
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      coverage.complete = false;
      coverage.reasons.add(`could not enumerate ${relative(limits.root, current)}: ${error.message}`);
      return;
    }
    for (const entry of entries) {
      if (coverage.discoveredFiles >= limits.maxFiles) break;
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        coverage.skippedFiles += 1;
        coverage.complete = false;
        coverage.reasons.add(`symbolic link skipped: ${relative(limits.root, candidate)}`);
      } else if (entry.isDirectory()) {
        walk(candidate);
      } else if (entry.isFile() && accept(entry.name)) {
        coverage.discoveredFiles += 1;
        files.push(candidate);
      }
    }
  }
  walk(directory);
  return files;
}

/**
 * Build a bounded local dependency graph for GitHub Actions workflows and
 * composite actions. No referenced code is executed and no network is used.
 */
function scanCiDependencies(inputRoot, options = {}) {
  const root = fs.realpathSync(path.resolve(inputRoot));
  const limits = {
    root,
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
  };
  for (const [name, value] of Object.entries(limits)) {
    if (name !== "root" && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`${name} must be a non-negative integer`);
  }

  const coverage = {
    complete: true,
    discoveredFiles: 0,
    scannedFiles: 0,
    skippedFiles: 0,
    scannedBytes: 0,
    extractedReferences: 0,
    reasons: new Set()
  };
  const references = [];
  const findings = [];
  const states = new Map();

  const workflows = discoverYaml(
    path.join(root, ".github", "workflows"),
    name => /\.ya?ml$/i.test(name),
    coverage,
    limits
  );
  const actions = discoverYaml(
    path.join(root, ".github", "actions"),
    name => /^action\.ya?ml$/i.test(name),
    coverage,
    limits
  );

  function localTarget(reference, sourceFile, line) {
    const requested = path.resolve(root, reference);
    if (!inside(root, requested)) {
      findings.push(finding("ci-local-path-escape", "high", relative(root, sourceFile), line, `Local action path escapes the repository: ${reference}`));
      coverage.complete = false;
      coverage.reasons.add("a local reference escaped the repository root");
      return null;
    }
    let candidate = requested;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      const manifests = [path.join(candidate, "action.yml"), path.join(candidate, "action.yaml")];
      candidate = manifests.find(file => fs.existsSync(file)) || manifests[0];
    }
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      findings.push(finding("ci-local-target-missing", "high", relative(root, sourceFile), line, `Local action or workflow does not exist: ${reference}`));
      coverage.complete = false;
      coverage.reasons.add("a local action or workflow target was missing");
      return null;
    }
    let real;
    try {
      real = fs.realpathSync(candidate);
    } catch (error) {
      findings.push(finding("ci-local-target-unreadable", "high", relative(root, sourceFile), line, `Local target could not be resolved: ${error.message}`));
      coverage.complete = false;
      coverage.reasons.add("a local target could not be resolved");
      return null;
    }
    if (!inside(root, real)) {
      findings.push(finding("ci-local-path-escape", "high", relative(root, sourceFile), line, `Local target resolves outside the repository: ${reference}`));
      coverage.complete = false;
      coverage.reasons.add("a local reference resolved outside the repository root");
      return null;
    }
    return real;
  }

  function inspect(file, depth, ancestry = []) {
    const display = relative(root, file);
    if (depth > limits.maxDepth) {
      findings.push(finding("ci-reference-depth-limit", "medium", display, null, `Local dependency depth exceeds ${limits.maxDepth}`));
      coverage.complete = false;
      coverage.reasons.add(`local dependency traversal stopped at depth ${limits.maxDepth}`);
      return;
    }
    const state = states.get(file);
    if (state === "done") return;
    if (state === "visiting") {
      const cycle = [...ancestry, display].join(" -> ");
      findings.push(finding("ci-reference-cycle", "medium", display, null, `Local action dependency cycle: ${cycle}`));
      return;
    }
    if (states.size >= limits.maxFiles) {
      findings.push(finding("ci-file-limit", "medium", display, null, `CI scan stopped at the ${limits.maxFiles}-file limit`));
      coverage.complete = false;
      coverage.reasons.add(`scan stopped at the ${limits.maxFiles}-file limit`);
      return;
    }
    states.set(file, "visiting");
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (error) {
      findings.push(finding("ci-file-unreadable", "high", display, null, error.message));
      coverage.skippedFiles += 1;
      coverage.complete = false;
      coverage.reasons.add(`could not stat ${display}`);
      states.set(file, "done");
      return;
    }
    if (stat.size > limits.maxFileBytes || coverage.scannedBytes + stat.size > limits.maxTotalBytes) {
      const boundary = stat.size > limits.maxFileBytes ? `${limits.maxFileBytes}-byte per-file` : `${limits.maxTotalBytes}-byte total`;
      findings.push(finding("ci-file-size-limit", "medium", display, null, `CI manifest exceeds the ${boundary} scan limit`));
      coverage.skippedFiles += 1;
      coverage.complete = false;
      coverage.reasons.add(`size limit skipped ${display}`);
      states.set(file, "done");
      return;
    }
    let source;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch (error) {
      findings.push(finding("ci-file-unreadable", "high", display, null, error.message));
      coverage.skippedFiles += 1;
      coverage.complete = false;
      coverage.reasons.add(`could not read ${display}`);
      states.set(file, "done");
      return;
    }
    coverage.scannedFiles += 1;
    coverage.scannedBytes += stat.size;

    for (const use of extractUses(source)) {
      const classified = classifyReference(use.value);
      const component = {
        kind: classified.kind,
        reference: use.value,
        source: display,
        line: use.line,
        pin: classified.pin
      };
      references.push(component);
      coverage.extractedReferences += 1;

      if (classified.kind === "dynamic") {
        findings.push(finding("ci-dynamic-reference", "high", display, use.line, "Dynamic uses: reference cannot be resolved before execution"));
        coverage.complete = false;
        coverage.reasons.add("a dynamic uses reference could not be resolved");
      } else if (classified.kind === "container-image" && !classified.pin.immutable) {
        findings.push(finding("ci-mutable-container-image", "medium", display, use.line, `Container image is not pinned by SHA-256 digest: ${use.value}`));
      } else if ((classified.kind === "remote-action" || classified.kind === "reusable-workflow") && classified.pin.type === "missing") {
        findings.push(finding("ci-unpinned-reference", "high", display, use.line, `Remote ${classified.kind} has no @ref: ${use.value}`));
      } else if ((classified.kind === "remote-action" || classified.kind === "reusable-workflow") && !classified.pin.immutable) {
        findings.push(finding("ci-mutable-reference", "medium", display, use.line, `Remote ${classified.kind} is not pinned to a full commit SHA: ${use.value}`));
      } else if (classified.kind === "local") {
        const target = localTarget(use.value, file, use.line);
        component.localPath = target ? relative(root, target) : null;
        if (target) {
          if (states.get(target) === "visiting") {
            const cycle = [...ancestry, display, relative(root, target)].join(" -> ");
            findings.push(finding("ci-reference-cycle", "medium", display, use.line, `Local action dependency cycle: ${cycle}`));
          } else {
            inspect(target, depth + 1, [...ancestry, display]);
          }
        }
      }
    }
    states.set(file, "done");
  }

  for (const file of [...new Set([...workflows, ...actions])].sort()) inspect(fs.realpathSync(file), 0);
  const normalizedCoverage = { ...coverage, reasons: [...coverage.reasons].sort() };
  return {
    format: "github-actions",
    root,
    components: references,
    references,
    findings,
    coverage: normalizedCoverage
  };
}

module.exports = { scanCiDependencies, extractUses, classifyReference };
