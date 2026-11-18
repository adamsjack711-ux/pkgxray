#!/usr/bin/env node
"use strict";

// Run this file from trusted scanner code. Both source trees are inert inputs.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { scanComposition } = require("../src/compose-scan");

const LIMITS = Object.freeze({ entries: 4096, bytes: 16 * 1024 * 1024, fileBytes: 2 * 1024 * 1024 });
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = value => String(value ?? "").slice(0, 500).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
  char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
// Inline HTML tags do not disable Markdown parsing inside their contents.
// Encode punctuation too, so links, mentions and Markdown cannot activate.
const code = value => `<code>${text(value).replace(/[^a-zA-Z0-9 ]/gu, char => `&#${char.codePointAt(0)};`)}</code>`;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const within = (parent, child) => { const rel = path.relative(parent, child); return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel)); };
function creationPath(value) {
  const absolute = path.resolve(value);
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
  const parent = path.dirname(absolute);
  if (parent === absolute) throw new Error("Output path is unavailable.");
  return path.join(creationPath(parent), path.basename(absolute));
}

function relative(value, allowDot = false) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    !/[\\:\x00-\x1f\x7f]/.test(value) && !path.posix.isAbsolute(value) &&
    (allowDot && value === "." || value.split("/").every(part => part && part !== "." && part !== ".."));
}

function regularBytes(file, maxBytes) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("Input exceeds regular-file limits.");
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0, read;
    while (length < buffer.length && (read = fs.readSync(fd, buffer, length, buffer.length - length, null))) length += read;
    if (length > maxBytes) throw new Error("Input exceeds regular-file limits.");
    return buffer.subarray(0, length);
  } finally { fs.closeSync(fd); }
}

function directory(root, relativePath) {
  let current = fs.realpathSync(root);
  for (const part of relativePath === "." ? [] : relativePath.split("/")) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Target root is missing or contains a link.");
  }
  return current;
}

function readConfig(base) {
  const configDir = directory(base, ".github");
  const config = JSON.parse(regularBytes(path.join(configDir, "compose-report.json"), 16384).toString("utf8"));
  if (!object(config) || config.schemaVersion !== 1 || Object.keys(config).some(k => !["schemaVersion", "targets"].includes(k)) ||
      !Array.isArray(config.targets) || !config.targets.length || config.targets.length > 4) throw new Error("Invalid trusted Compose report configuration.");
  const seen = new Set();
  for (const target of config.targets) {
    if (!object(target) || Object.keys(target).some(k => !["root", "entry", "allowRootOnly"].includes(k)) ||
        !relative(target.root, true) || !relative(target.entry) || !/\.[cm]?js$/.test(target.entry) ||
        typeof target.allowRootOnly !== "boolean") throw new Error("Invalid trusted Compose report target.");
    const key = JSON.stringify([target.root, target.entry]);
    if (seen.has(key)) throw new Error("Duplicate Compose report target.");
    seen.add(key);
  }
  return config.targets;
}

// Stage only file formats the static reader can consume. Never follow links,
// execute hooks, install dependencies, or read the target's configuration.
function snapshot(source, destination, allowRootOnly) {
  let entries = 0, bytes = 0, omitted = false, rootOnly = false;
  function copy(from, to, depth = 0) {
    if (depth > 32 || entries >= LIMITS.entries) { omitted = true; return; }
    const handle = fs.opendirSync(from), children = [];
    try {
      let entry;
      while ((entry = handle.readSync())) {
        if (children.length + entries >= LIMITS.entries) { omitted = true; break; }
        children.push(entry);
      }
    } finally { handle.closeSync(); }
    for (const entry of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git") continue;
      if (++entries > LIMITS.entries) { omitted = true; return; }
      const input = path.join(from, entry.name), output = path.join(to, entry.name);
      if (entry.isSymbolicLink()) { omitted = true; continue; }
      if (entry.isDirectory()) { fs.mkdirSync(output); copy(input, output, depth + 1); }
      else if (entry.isFile() && /\.(?:[cm]?js|json)$/.test(entry.name)) {
        try {
          const data = regularBytes(input, Math.min(LIMITS.fileBytes, LIMITS.bytes - bytes));
          fs.writeFileSync(output, data, { flag: "wx", mode: 0o600 }); bytes += data.length;
        } catch { omitted = true; }
      } else if (!entry.isFile()) omitted = true;
    }
  }
  fs.mkdirSync(destination);
  copy(source, destination);
  // Missing dependency sources are still missing. This synthetic root entry
  // enables own-source analysis only, and is always disclosed as incomplete.
  if (allowRootOnly && !fs.existsSync(path.join(source, "package-lock.json"))) {
    try {
      const manifest = JSON.parse(regularBytes(path.join(destination, "package.json"), LIMITS.fileBytes).toString("utf8"));
      if (!object(manifest)) throw new Error("Invalid manifest");
      const identity = {};
      for (const key of ["name", "version"]) if (typeof manifest[key] === "string") identity[key] = manifest[key];
      fs.writeFileSync(path.join(destination, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": identity } }), { flag: "wx" });
      rootOnly = true;
    } catch { omitted = true; }
  }
  return { rootOnly, omitted, filesAndDirectories: entries, bytes };
}

function summarize(report, staged) {
  const flows = report.compose?.findings || [];
  const packageFindings = (report.pkgxray?.packages || []).flatMap(pkg => (pkg.report?.findings || [])
    .filter(f => ["high", "medium"].includes(f.severity) && f.category !== "incomplete-source-scan")
    .map(f => ({ packageId: pkg.id, ...f })));
  const gaps = (report.gaps || []).map(g => ({ code: text(g.code), file: text(g.file), message: text(g.message) }));
  if (staged.rootOnly) gaps.unshift({ code: "root-only-source", file: "package-lock.json", message: "No committed npm lockfile: generated root identity only. Dependencies are not inventoried, acquired or verified." });
  if (staged.omitted) gaps.unshift({ code: "snapshot-omission", file: "", message: "Links, special files or snapshot budget limits prevented a complete input copy." });
  const result = {
    decision: report.decision === "block" ? "block" : "review",
    execution: gaps.length ? "partial" : report.execution || "partial",
    coverage: "partial", rootOnly: staged.rootOnly, installAllowed: false,
    scanner: { version: text(report.pkgxray?.engine?.version), buildId: text(report.pkgxray?.engine?.buildId) },
    lockfileSha256: text(report.compose?.lockfileSha256),
    selectedFiles: (report.compose?.packages || []).flatMap(pkg => (pkg.files || []).map(file => ({
      packageId: text(pkg.id), file: text(file.file), sha256: text(file.sha256)
    }))).slice(0, 256),
    flows: flows.slice(0, 100).map(f => ({
      fingerprint: hash([f.crossPackage, f.destination, (f.trace || []).map(s => [s.kind, s.label, s.package?.id, s.file])]),
      crossPackage: Boolean(f.crossPackage), destination: text(f.destination),
      trace: (f.trace || []).slice(0, 12).map(s => ({ kind: text(s.kind), label: text(s.label), packageId: text(s.package?.id), file: text(s.file), line: Number.isSafeInteger(s.line) ? s.line : 0 }))
    })),
    findings: packageFindings.slice(0, 100).map(f => ({
      fingerprint: hash([f.packageId, f.severity, f.category, f.file, f.rationale, f.snippet]),
      severity: text(f.severity), category: text(f.category), packageId: text(f.packageId), file: text(f.file), rationale: text(f.rationale)
    })),
    gaps: gaps.slice(0, 100),
    evidenceTruncated: flows.length > 100 || packageFindings.length > 100 || gaps.length > 100 || flows.some(f => (f.trace || []).length > 12) ||
      (report.compose?.packages || []).reduce((sum, pkg) => sum + (pkg.files || []).length, 0) > 256
  };
  return result;
}

function changes(before, after, key) {
  const old = new Map(before[key].map(f => [f.fingerprint, f])), fresh = new Map(after[key].map(f => [f.fingerprint, f]));
  const comparable = before.execution === "completed" && after.execution === "completed" && !before.evidenceTruncated && !after.evidenceTruncated;
  return { added: [...fresh.values()].filter(f => !old.has(f.fingerprint)),
    absenceStatus: comparable ? "compared" : "unavailable",
    absenceReason: comparable ? null : "One or both revisions have incomplete analysis or truncated evidence; absence cannot be compared.",
    noLongerObserved: comparable ? [...old.values()].filter(f => !fresh.has(f.fingerprint)) : null };
}

async function scanTarget(checkout, target, scratch, label, scan = scanComposition) {
  try {
    const source = directory(checkout, target.root), destination = path.join(scratch, label);
    const staged = snapshot(source, destination, target.allowRootOnly);
    const value = await scan(fs.realpathSync(destination), { entry: target.entry, timeoutMs: 30000 });
    return summarize(value.report || value, staged);
  } catch {
    return summarize({ decision: "review", execution: "partial", gaps: [{ code: "target-unavailable", message: "Target snapshot could not be prepared or analyzed within input limits." }] }, { rootOnly: false, omitted: false });
  }
}

async function buildReport({ base, head, baseSha, headSha }, scan) {
  if (![baseSha, headSha].every(v => typeof v === "string" && /^[a-f0-9]{40,64}$/.test(v))) throw new Error("Full immutable commit IDs are required.");
  const targets = readConfig(base), scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pkgxray-compose-pr-"));
  try {
    const results = [];
    for (const [i, target] of targets.entries()) {
      const before = await scanTarget(base, target, scratch, `${i}-base`, scan);
      const after = await scanTarget(head, target, scratch, `${i}-head`, scan);
      results.push({ target, base: before, head: after, flows: changes(before, after, "flows"), findings: changes(before, after, "findings") });
    }
    return { schemaVersion: 1, mode: "compose-pr-advisory", baseSha, headSha,
      authorization: { installAllowed: false }, targets: results };
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

function render(report) {
  const lines = ["# Compose pull-request evidence", "", "Advisory only. This report never approves installation or execution.", "",
    `Base: ${code(report.baseSha)} · Head: ${code(report.headSha)}`, "",
    "Both revisions use the same trusted base scanner and target configuration. PR code and installation scripts are not executed.", "",
    "Coverage is partial: only selected entrypoints and available local package sources are analyzed. Dependencies are never installed. No-longer-observed evidence does not prove a risk was fixed."];
  for (const result of report.targets) {
    lines.push("", `## ${code(result.target.root)} / ${code(result.target.entry)}`, "",
      `Head: **${result.head.decision.toUpperCase()}** · Analysis: **${result.head.execution}** · Coverage: **partial**`, "",
      `Dataflow signatures: **${result.flows.added.length} newly observed**${result.flows.absenceStatus === "compared" ? `, **${result.flows.noLongerObserved.length} no longer observed**` : "; **absence comparison unavailable**"}.`,
      `Package finding signatures: **${result.findings.added.length} newly observed**${result.findings.absenceStatus === "compared" ? `, **${result.findings.noLongerObserved.length} no longer observed**` : "; **absence comparison unavailable**"}.`, "",
      "### Added dataflow evidence");
    if (result.flows.absenceReason) lines.push("", result.flows.absenceReason, "Newly observed evidence may reflect a baseline gap rather than newly introduced behavior.");
    if (!result.flows.added.length) lines.push("No additional modeled flow observed; this is not a safety verdict.");
    for (const flow of result.flows.added.slice(0, 20)) {
      lines.push("", `- ${flow.crossPackage ? "Cross-package" : "Local"} environment data → network; destination ${code(flow.destination || "unknown")}`);
      for (const step of flow.trace) lines.push(`  - ${code(step.kind)} ${code(step.label)} at ${code(`${step.packageId}:${step.file}:${step.line}`)}`);
    }
    lines.push("", "### Added package findings");
    if (!result.findings.added.length) lines.push("No additional high/medium finding signature observed.");
    for (const f of result.findings.added.slice(0, 20)) lines.push(`- ${code(f.severity)} ${code(f.category)} at ${code(`${f.packageId}:${f.file}`)} — ${code(f.rationale)}`);
    lines.push("", "### Incomplete checks");
    for (const revision of ["base", "head"]) {
      lines.push("", `${revision === "base" ? "Base" : "Head"}:`);
      for (const gap of result[revision].gaps.slice(0, 20)) lines.push(`- ${code(gap.code)} ${code(gap.file)} — ${code(gap.message)}`);
      if (!result[revision].gaps.length) lines.push("- No parser gap recorded; selected-source coverage is still partial.");
    }
    lines.push("", "JSON artifact contains retained findings, flow evidence and selected-file hashes for both revisions. Summary lists at most 20 items per section; JSON lists at most 100 findings/gaps, 256 file hashes and 12 steps per trace.");
    if (result.base.evidenceTruncated || result.head.evidenceTruncated) lines.push("**Evidence was truncated. Counts describe retained evidence only; inspect source and rerun a narrower target.**");
  }
  return `${lines.join("\n")}\n`;
}

async function main(args = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = { "--base": "base", "--head": "head", "--base-sha": "baseSha", "--head-sha": "headSha", "--output": "output" }[args[i]];
    if (!key || options[key] || !args[i + 1]) throw new Error("Expected --base, --head, --base-sha, --head-sha and --output.");
    options[key] = args[i + 1];
  }
  if (Object.keys(options).length !== 5) throw new Error("All report options are required.");
  const output = creationPath(options.output);
  for (const root of [options.base, options.head]) if (within(fs.realpathSync(root), output)) throw new Error("Report output must be outside input checkouts.");
  const report = await buildReport(options);
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  fs.writeFileSync(path.join(output, "summary.md"), render(report), { flag: "wx" });
}

module.exports = { buildReport, render, readConfig, summarize, changes, snapshot, LIMITS, main };
if (require.main === module) main().catch(() => {
  // Do not print source-derived exception messages as Actions commands.
  process.stderr.write("Compose report setup failed; no approval was issued. Check the trusted configuration and input paths.\n");
  process.exitCode = 1;
});
