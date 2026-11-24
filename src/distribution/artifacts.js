"use strict";

// Pure, local descriptor inspection for executable-distribution formats. This
// module deliberately does not unpack archives or contact registries: callers
// hand it an extracted tree (or an OCI image layout) and it inventories the
// executable references and install hooks that are visible there.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_FILES = 10000;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const SHA256 = /^sha256:([a-f0-9]{64})$/i;

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function relativePath(root, file) {
  return path.relative(root, file).split(path.sep).join("/") || ".";
}

function walkFiles(root, limits) {
  const files = [];
  const coverage = { complete: true, scannedFiles: 0, skippedFiles: 0, bytesRead: 0, reasons: [] };
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      coverage.complete = false;
      coverage.reasons.push(`cannot read ${relativePath(root, directory)}: ${error.code || error.message}`);
      continue;
    }
    for (const entry of entries.reverse()) {
      const file = path.join(directory, entry.name);
      if (!inside(root, file)) continue;
      if (entry.isSymbolicLink()) {
        coverage.complete = false;
        coverage.skippedFiles += 1;
        coverage.reasons.push(`symbolic link skipped: ${relativePath(root, file)}`);
      } else if (entry.isDirectory()) {
        pending.push(file);
      } else if (entry.isFile()) {
        if (files.length >= limits.maxFiles) {
          coverage.complete = false;
          coverage.skippedFiles += 1;
          if (!coverage.reasons.includes("file limit reached")) coverage.reasons.push("file limit reached");
        } else {
          files.push(file);
        }
      }
    }
  }
  return { files: files.sort(), coverage };
}

function readText(state, file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  if (!stat.isFile()) return null;
  if (stat.size > state.limits.maxFileBytes) {
    state.coverage.complete = false;
    state.coverage.skippedFiles += 1;
    state.coverage.reasons.push(`oversized file skipped: ${relativePath(state.root, file)}`);
    return null;
  }
  if (state.coverage.bytesRead + stat.size > state.limits.maxTotalBytes) {
    state.coverage.complete = false;
    state.coverage.skippedFiles += 1;
    if (!state.coverage.reasons.includes("read-byte limit reached")) state.coverage.reasons.push("read-byte limit reached");
    return null;
  }
  const value = fs.readFileSync(file, "utf8");
  state.coverage.bytesRead += stat.size;
  state.coverage.scannedFiles += 1;
  return value;
}

function finding(state, severity, category, file, rationale, snippet) {
  state.findings.push({
    severity,
    category,
    file: relativePath(state.root, file),
    snippet: String(snippet || "").slice(0, 240),
    rationale
  });
}

function component(state, value) {
  state.components.push(value);
}

function immutableImage(reference) { return /@sha256:[a-f0-9]{64}$/i.test(reference); }
function mutableVersion(value) {
  return !value || /(?:^|[\s,])(?:latest|main|master|HEAD|\*|x|>=|<=|>|<|\^|~)/i.test(value) || /\|\||\$\{|\{\{/.test(value);
}

function extractHclBlocks(text, kind) {
  const blocks = [];
  const re = new RegExp(`\\b${kind}\\s+"([^"]+)"\\s*\\{`, "g");
  for (let match; (match = re.exec(text)); ) {
    let depth = 1, quote = null, escaped = false, i = re.lastIndex;
    for (; i < text.length && depth; i += 1) {
      const ch = text[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }
    blocks.push({ name: match[1], body: text.slice(re.lastIndex, Math.max(re.lastIndex, i - 1)) });
    re.lastIndex = i;
  }
  return blocks;
}

function extractHclBodies(text, keyword) {
  const bodies = [];
  const re = new RegExp(`\\b${keyword}\\s*\\{`, "g");
  for (let match; (match = re.exec(text)); ) {
    let depth = 1, quote = null, escaped = false, i = re.lastIndex;
    for (; i < text.length && depth; i += 1) {
      const ch = text[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }
    bodies.push(text.slice(re.lastIndex, Math.max(re.lastIndex, i - 1)));
    re.lastIndex = i;
  }
  return bodies;
}

function assignment(body, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]+)"`).exec(body);
  return match && match[1];
}

function analyzeTerraform(state, files) {
  for (const file of files.filter(f => /(?:^|\/)(?:\.terraform\.lock\.hcl|[^/]+\.tf)$/.test(f.split(path.sep).join("/")))) {
    const text = readText(state, file);
    if (text === null) continue;
    if (file.endsWith(".terraform.lock.hcl")) {
      for (const block of extractHclBlocks(text, "provider")) {
        const version = assignment(block.body, "version");
        const hashes = [...block.body.matchAll(/"((?:h1|zh):[^"]+)"/g)].map(m => m[1]);
        component(state, { kind: "terraform-provider", name: block.name, reference: version || block.name, file: relativePath(state.root, file), immutable: hashes.length > 0, digests: hashes });
        if (!hashes.length) finding(state, "medium", "mutable-reference", file, "Terraform provider lock entry has no content hash.", block.name);
      }
      continue;
    }
    for (const block of extractHclBlocks(text, "module")) {
      const source = assignment(block.body, "source");
      const version = assignment(block.body, "version");
      if (!source) continue;
      const local = /^(?:\.{0,2}\/|\/)/.test(source);
      const commit = /(?:[?&]ref=|#)([a-f0-9]{40})(?:$|[&#])/i.test(source);
      const exactRegistryVersion = !!version && !mutableVersion(version);
      component(state, { kind: "terraform-module", name: block.name, reference: source, version: version || null, file: relativePath(state.root, file), immutable: local || commit || exactRegistryVersion });
      if (!local && !commit && !exactRegistryVersion) finding(state, "medium", "mutable-reference", file, "Terraform module is not pinned to an exact registry version or commit SHA.", source);
    }
    // required_providers entries are nested maps rather than provider blocks.
    for (const body of extractHclBodies(text, "required_providers")) {
      const entries = /([A-Za-z0-9_-]+)\s*=\s*\{([\s\S]*?)\}/g;
      for (let entry; (entry = entries.exec(body)); ) {
        const source = assignment(entry[2], "source") || entry[1];
        const version = assignment(entry[2], "version");
        component(state, { kind: "terraform-provider", name: entry[1], reference: source, version: version || null, file: relativePath(state.root, file), immutable: false });
        finding(state, "low", "unlocked-reference", file, "Terraform provider constraint requires a matching hashed lock entry for immutable acquisition.", source);
      }
    }
  }
}

function parseYamlScalar(value) {
  return String(value || "").trim().replace(/^['"]|['"]$/g, "").split(/\s+#/)[0].trim();
}

function imageComponent(state, file, reference, origin) {
  const ref = parseYamlScalar(reference);
  if (!ref || /\{\{/.test(ref)) return;
  const immutable = immutableImage(ref);
  component(state, { kind: "oci-image", reference: ref, file: relativePath(state.root, file), immutable, origin });
  if (!immutable) finding(state, "medium", "mutable-image", file, "Container image is not pinned by sha256 digest.", ref);
}

function analyzeHelm(state, files) {
  for (const file of files) {
    const rel = relativePath(state.root, file);
    const base = path.basename(file);
    if (base === "Chart.yaml") {
      const text = readText(state, file); if (text === null) continue;
      const dependencyChunks = text.split(/^\s*-\s+name:\s*/m).slice(1);
      for (const chunk of dependencyChunks) {
        const name = parseYamlScalar((/^([^\n]+)/.exec(chunk) || [])[1]);
        const version = parseYamlScalar((/^\s*version:\s*(.+)$/m.exec(chunk) || [])[1]);
        const repository = parseYamlScalar((/^\s*repository:\s*(.+)$/m.exec(chunk) || [])[1]);
        if (!name) continue;
        const immutable = !!version && !mutableVersion(version);
        component(state, { kind: "helm-dependency", name, reference: repository || name, version: version || null, file: rel, immutable });
        if (!immutable) finding(state, "medium", "mutable-reference", file, "Helm dependency version is missing or expressed as a range.", `${name}@${version || "unversioned"}`);
      }
    } else if (/^(?:values[^/]*\.ya?ml)$/.test(base)) {
      const text = readText(state, file); if (text === null) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const repository = /^(\s*)repository:\s*(.+)$/.exec(lines[i]);
        if (!repository) continue;
        const indent = repository[1].length;
        const siblings = [];
        for (let j = i + 1; j < lines.length; j += 1) {
          if (!lines[j].trim()) continue;
          const nextIndent = (/^\s*/.exec(lines[j]) || [""])[0].length;
          if (nextIndent < indent || (nextIndent === indent && !/^\s*(?:tag|digest):/.test(lines[j]))) break;
          siblings.push(lines[j]);
        }
        const window = siblings.join("\n");
        const digest = /^\s*digest:\s*(.+)$/m.exec(window);
        const tag = /^\s*tag:\s*(.+)$/m.exec(window);
        const repo = parseYamlScalar(repository[2]);
        imageComponent(state, file, digest ? `${repo}@${parseYamlScalar(digest[1])}` : `${repo}:${parseYamlScalar(tag && tag[1]) || "latest"}`, "helm-values");
      }
    } else if (/\/(?:templates|crds)\//.test(`/${rel}`) && /\.ya?ml$/.test(base)) {
      const text = readText(state, file); if (text === null) continue;
      for (const match of text.matchAll(/^\s*image:\s*([^\s#]+).*$/gm)) imageComponent(state, file, match[1], "helm-template");
    }
  }
}

function readJson(state, file) {
  const text = readText(state, file);
  if (text === null) return null;
  try { return JSON.parse(text); }
  catch (error) { finding(state, "medium", "invalid-descriptor", file, "Descriptor is not valid JSON.", error.message); return null; }
}

function ociBlobPath(state, digest) {
  const match = SHA256.exec(String(digest || ""));
  if (!match) return null;
  const file = path.resolve(state.root, "blobs", "sha256", match[1].toLowerCase());
  return inside(state.root, file) ? file : null;
}

function verifyOciBlob(state, file, digest, evidenceFile) {
  const expected = SHA256.exec(String(digest || ""));
  if (!expected) return false;
  const stat = fs.statSync(file);
  if (stat.size > state.limits.maxFileBytes || state.coverage.bytesRead + stat.size > state.limits.maxTotalBytes) {
    state.coverage.complete = false;
    state.coverage.reasons.push(`OCI blob digest not verified within limits: ${relativePath(state.root, file)}`);
    finding(state, "low", "unverified-oci-blob", evidenceFile, "OCI blob exists but exceeded the local digest-verification read limit.", digest);
    return true;
  }
  const bytes = fs.readFileSync(file);
  state.coverage.bytesRead += stat.size;
  state.coverage.scannedFiles += 1;
  const actual = crypto.createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected[1].toLowerCase()) {
    finding(state, "high", "oci-digest-mismatch", evidenceFile, "OCI blob bytes do not match the descriptor digest.", digest);
    return false;
  }
  return true;
}

function analyzeOciLayout(state, files) {
  const indexFile = files.find(file => relativePath(state.root, file) === "index.json");
  const layoutFile = files.find(file => relativePath(state.root, file) === "oci-layout");
  if (!layoutFile && !indexFile) return;
  if (!layoutFile || !indexFile) finding(state, "high", "incomplete-oci-layout", layoutFile || indexFile || state.root, "OCI layout requires both oci-layout and index.json.", "");
  if (layoutFile) readJson(state, layoutFile);
  if (!indexFile) return;
  const index = readJson(state, indexFile);
  if (!index || !Array.isArray(index.manifests)) return;
  for (const descriptor of index.manifests) {
    const digest = descriptor && descriptor.digest;
    const blob = ociBlobPath(state, digest);
    component(state, { kind: "oci-manifest", reference: digest || null, digest: digest || null, mediaType: descriptor && descriptor.mediaType || null, file: "index.json", immutable: !!blob });
    if (!blob || !fs.existsSync(blob)) {
      finding(state, "high", "missing-oci-blob", indexFile, "OCI index references a missing or malformed digest blob.", digest);
      continue;
    }
    verifyOciBlob(state, blob, digest, indexFile);
    const manifest = readJson(state, blob);
    if (!manifest) continue;
    if (manifest.config && manifest.config.digest) component(state, { kind: "oci-config", reference: manifest.config.digest, digest: manifest.config.digest, mediaType: manifest.config.mediaType || null, file: relativePath(state.root, blob), immutable: !!SHA256.exec(manifest.config.digest) });
    for (const [position, layer] of (manifest.layers || []).entries()) {
      const layerBlob = ociBlobPath(state, layer.digest);
      component(state, { kind: "oci-layer", reference: layer.digest || null, digest: layer.digest || null, mediaType: layer.mediaType || null, size: layer.size || null, position, file: relativePath(state.root, blob), immutable: !!layerBlob });
      if (!layerBlob || !fs.existsSync(layerBlob)) finding(state, "high", "missing-oci-blob", blob, "OCI manifest references a missing or malformed layer blob.", layer.digest);
      else verifyOciBlob(state, layerBlob, layer.digest, blob);
    }
  }
}

const DEB_SCRIPTS = new Set(["preinst", "postinst", "prerm", "postrm", "config", "triggers"]);
const APK_SCRIPTS = /\.(?:pre|post)-(?:install|upgrade|deinstall)$|\.trigger$/;
function analyzeLinuxPackages(state, files) {
  for (const file of files) {
    const rel = relativePath(state.root, file);
    const base = path.basename(file);
    if (/^(?:DEBIAN|control)\//.test(rel) && DEB_SCRIPTS.has(base)) {
      component(state, { kind: "deb-install-script", name: base, reference: rel, file: rel, immutable: true });
      finding(state, "medium", "install-script", file, "DEB maintainer script executes during package installation or removal.", rel);
    } else if (APK_SCRIPTS.test(base)) {
      component(state, { kind: "apk-install-script", name: base, reference: rel, file: rel, immutable: true });
      finding(state, "medium", "install-script", file, "APK package script executes during package lifecycle events.", rel);
    } else if (/\.spec$/i.test(base)) {
      const text = readText(state, file); if (text === null) continue;
      for (const match of text.matchAll(/^%(pre|post|preun|postun|pretrans|posttrans|transfiletrigger\w*)\b/gm)) {
        component(state, { kind: "rpm-install-script", name: `%${match[1]}`, reference: rel, file: rel, immutable: true });
        finding(state, "medium", "install-script", file, "RPM scriptlet executes during package lifecycle events.", `%${match[1]}`);
      }
    }
  }
}

function analyzeHomebrew(state, files) {
  for (const file of files.filter(file => /\.rb$/.test(file))) {
    const text = readText(state, file); if (text === null || !/class\s+\w+\s*<\s*(?:Formula|Cask)\b|\bcask\s+["']/.test(text)) continue;
    const kind = /\bCask\b|\bcask\s+["']/.test(text) ? "homebrew-cask" : "homebrew-formula";
    const urls = [...text.matchAll(/^\s*url\s+["']([^"']+)/gm)].map(m => m[1]);
    const hashes = [...text.matchAll(/^\s*sha256\s+(?::no_check|["']([a-f0-9]{64})["'])/gmi)].map(m => m[1]).filter(Boolean);
    for (const url of urls.length ? urls : [null]) component(state, { kind, reference: url, file: relativePath(state.root, file), digests: hashes.map(h => `sha256:${h}`), immutable: hashes.length > 0 });
    if (!hashes.length) finding(state, "medium", "missing-checksum", file, "Homebrew download has no sha256 checksum (or uses :no_check).", urls[0] || kind);
    for (const hook of text.matchAll(/^\s*(postflight|preflight|uninstall|zap)\b/gm)) finding(state, "medium", "install-script", file, "Homebrew cask declares an executable lifecycle stanza.", hook[1]);
  }
}

function analyzeDesktop(state, files) {
  for (const file of files) {
    const rel = relativePath(state.root, file);
    const base = path.basename(file);
    if (/^(?:Scripts|scripts)\//.test(rel) || /\/(?:Scripts|scripts)\//.test(`/${rel}`)) {
      component(state, { kind: "macos-pkg-install-script", name: base, reference: rel, file: rel, immutable: true });
      finding(state, "medium", "install-script", file, "macOS PKG lifecycle script executes during installation.", rel);
    } else if (base === "AppRun") {
      component(state, { kind: "appimage-launcher", name: base, reference: rel, file: rel, immutable: true });
      finding(state, "low", "launch-command", file, "AppImage AppRun is the executable launch entrypoint.", rel);
    } else if (/\.desktop$/.test(base)) {
      const text = readText(state, file); if (text === null) continue;
      const exec = (/^Exec=(.+)$/m.exec(text) || [])[1];
      component(state, { kind: "desktop-entry", name: base, reference: exec || rel, file: rel, immutable: true });
    } else if (/snapcraft\.ya?ml$/.test(base)) {
      const text = readText(state, file); if (text === null) continue;
      for (const match of text.matchAll(/^\s+(command|daemon|command-chain):\s*(.+)$/gm)) {
        component(state, { kind: "snap-launch-command", name: match[1], reference: parseYamlScalar(match[2]), file: rel, immutable: true });
        finding(state, match[1] === "daemon" ? "medium" : "low", "launch-command", file, "Snap declares an executable application or service command.", match[0].trim());
      }
    } else if (/AppxManifest\.xml$/i.test(base)) {
      const text = readText(state, file); if (text === null) continue;
      for (const match of text.matchAll(/<Application\b[^>]*\bExecutable="([^"]+)"[^>]*>/gi)) component(state, { kind: "msix-application", reference: match[1], file: rel, immutable: true });
      for (const match of text.matchAll(/<(?:[A-Za-z0-9_-]+:)?Capability\b[^>]*\bName="([^"]+)"/gi)) finding(state, /runFullTrust|broadFileSystemAccess|enterpriseAuthentication/i.test(match[1]) ? "high" : "low", "desktop-capability", file, "MSIX application requests an operating-system capability.", match[1]);
    } else if (/\.(?:flatpak|flatpakref|flatpakrepo)$/.test(base) || /(?:^|\.)flatpak(?:manifest)?\.(?:json|ya?ml)$/.test(base) || /\.(?:json|ya?ml)$/.test(base)) {
      const text = readText(state, file); if (text === null) continue;
      if (!/^(?:\s*|\s*["'])app-id["']?\s*[:=]/m.test(text) && !/\.(?:flatpak|flatpakref|flatpakrepo)$/.test(base) && !/(?:^|\.)flatpak(?:manifest)?\./.test(base)) continue;
      component(state, { kind: "flatpak-manifest", name: base, reference: rel, file: rel, immutable: true });
      for (const match of text.matchAll(/(?:url|path)["']?\s*[:=]\s*["']?([^"'\s]+)/g)) {
        if (/^https?:/.test(match[1]) && !/sha256/.test(text.slice(match.index, match.index + 500))) finding(state, "medium", "missing-checksum", file, "Flatpak remote source is not accompanied by a nearby sha256 checksum.", match[1]);
      }
    } else if (/\.(?:msi|msix|pkg|dmg|AppImage)$/i.test(base)) {
      const kind = path.extname(base).slice(1).toLowerCase();
      component(state, { kind: `${kind}-package`, name: base, reference: rel, file: rel, immutable: false });
      finding(state, "medium", "opaque-package", file, "Binary desktop package requires extraction before install hooks and executable metadata can be inspected.", base);
    }
  }
}

function sortResult(state) {
  state.components.sort((a, b) => `${a.file}\0${a.kind}\0${a.reference || ""}`.localeCompare(`${b.file}\0${b.kind}\0${b.reference || ""}`));
  state.findings.sort((a, b) => `${a.file}\0${a.category}\0${a.snippet}`.localeCompare(`${b.file}\0${b.category}\0${b.snippet}`));
  state.coverage.reasons = [...new Set(state.coverage.reasons)].sort();
}

function analyzeArtifactDescriptors(root, options = {}) {
  const resolved = path.resolve(root);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error("Artifact descriptor scan requires an extracted directory");
  const limits = {
    maxFiles: options.maxFiles || DEFAULT_MAX_FILES,
    maxFileBytes: options.maxFileBytes || DEFAULT_MAX_FILE_BYTES,
    maxTotalBytes: options.maxTotalBytes || DEFAULT_MAX_TOTAL_BYTES
  };
  const walked = walkFiles(resolved, limits);
  const state = { root: resolved, limits, coverage: walked.coverage, components: [], findings: [] };
  analyzeTerraform(state, walked.files);
  analyzeHelm(state, walked.files);
  analyzeOciLayout(state, walked.files);
  analyzeLinuxPackages(state, walked.files);
  analyzeHomebrew(state, walked.files);
  analyzeDesktop(state, walked.files);
  sortResult(state);
  return { schemaVersion: 1, family: "artifact-descriptors", root: resolved, components: state.components, findings: state.findings, coverage: state.coverage };
}

const scanInfrastructureArtifacts = analyzeArtifactDescriptors;

module.exports = {
  analyzeArtifactDescriptors,
  scanInfrastructureArtifacts,
  analyzeTerraform,
  analyzeHelm,
  analyzeOciLayout,
  analyzeLinuxPackages,
  analyzeHomebrew,
  analyzeDesktop
};
