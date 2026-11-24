"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  finalizeResult,
  finding,
  listFiles,
  portable,
  readText,
  resolveInside
} = require("./common");

const COMMIT_SHA = /^[a-f0-9]{40,64}$/i;
const OCI_DIGEST = /@sha256:[a-f0-9]{64}$/i;

function scalar(value) {
  let out = String(value || "").trim();
  let quote = null;
  for (let index = 0; index < out.length; index += 1) {
    const character = out[index];
    if (quote) {
      if (character === quote && out[index - 1] !== "\\") quote = null;
    } else if (character === "\"" || character === "'") quote = character;
    else if (character === "#" && (index === 0 || /\s/.test(out[index - 1]))) {
      out = out.slice(0, index).trim();
      break;
    }
  }
  if (out.length >= 2 && ((out[0] === "\"" && out.at(-1) === "\"") || (out[0] === "'" && out.at(-1) === "'"))) out = out.slice(1, -1);
  return out.trim();
}

function dynamic(value) {
  return /\$\{?|\{\{|!reference|\*\w/.test(String(value || ""));
}

function validSha256Integrity(value) {
  const match = /^sha256-([A-Za-z0-9+/]+={0,2})$/.exec(String(value || ""));
  if (!match) return false;
  const bytes = Buffer.from(match[1], "base64");
  return bytes.length === 32 && bytes.toString("base64").replace(/=+$/, "") === match[1].replace(/=+$/, "");
}

function yamlLines(source) {
  return source.split(/\r?\n/).map((raw, index) => ({
    raw,
    line: index + 1,
    indent: (/^\s*/.exec(raw) || [""])[0].length,
    text: raw.trim()
  }));
}

function extractGitLabIncludes(source) {
  const lines = yamlLines(source);
  const includes = [];
  for (let cursor = 0; cursor < lines.length; cursor += 1) {
    const head = /^(?:-\s*)?include\s*:\s*(.*)$/.exec(lines[cursor].text);
    if (!head) continue;
    if (head[1]) {
      includes.push({ kind: "local", value: scalar(head[1]), line: lines[cursor].line });
      continue;
    }
    const baseIndent = lines[cursor].indent;
    const items = [];
    let current = null;
    for (cursor += 1; cursor < lines.length; cursor += 1) {
      const item = lines[cursor];
      if (!item.text || item.text.startsWith("#")) continue;
      if (item.indent <= baseIndent) { cursor -= 1; break; }
      const keyed = /^(-\s*)?(local|remote|project|component|template|ref|file|integrity)\s*:\s*(.*)$/i.exec(item.text);
      if (keyed) {
        if (keyed[1] && current) items.push(current);
        if (keyed[1] || !current) current = { line: item.line };
        current[keyed[2].toLowerCase()] = scalar(keyed[3]);
        continue;
      }
      const bare = /^-\s*(.+)$/.exec(item.text);
      if (bare) {
        if (current) items.push(current);
        current = { kind: "local", value: scalar(bare[1]), line: item.line };
      }
    }
    if (current) items.push(current);
    for (const item of items) {
      const kind = item.kind || ["local", "remote", "project", "component", "template"].find(key => item[key] !== undefined);
      if (!kind) continue;
      includes.push({
        kind,
        value: item.value || item[kind],
        ref: item.ref || null,
        file: item.file || null,
        integrity: item.integrity || null,
        line: item.line
      });
    }
  }
  return includes;
}

function gitLabImages(source) {
  const lines = yamlLines(source);
  const images = [];
  let servicesIndent = null;
  for (let cursor = 0; cursor < lines.length; cursor += 1) {
    const item = lines[cursor];
    if (!item.text || item.text.startsWith("#")) continue;
    if (servicesIndent !== null && item.indent <= servicesIndent) servicesIndent = null;
    if (/^services\s*:\s*$/.test(item.text)) { servicesIndent = item.indent; continue; }
    const image = /^image\s*:\s*(.+)$/.exec(item.text);
    if (image) images.push({ kind: "gitlab-job-image", value: scalar(image[1]), line: item.line });
    if (servicesIndent !== null && item.indent > servicesIndent) {
      const service = /^(?:-\s*)?(?:name\s*:\s*)?([^\s].*)$/.exec(item.text);
      if (service && !/^(?:alias|command|entrypoint|variables)\s*:/.test(service[1])) {
        images.push({ kind: "gitlab-service-image", value: scalar(service[1]), line: item.line });
      }
    }
  }
  return images;
}

function scanGitLabCi(inputRoot, options = {}) {
  const root = fs.realpathSync(path.resolve(inputRoot));
  const maxFiles = options.maxFiles ?? 128;
  const maxDepth = options.maxDepth ?? 24;
  const maxTotalBytes = options.maxTotalBytes ?? 8 * 1024 * 1024;
  const maxFileBytes = options.maxFileBytes ?? 1024 * 1024;
  const result = {
    family: "gitlab-ci", root, components: [], entrypoints: [], findings: [],
    coverage: { complete: true, filesInspected: 0, reasons: [] },
    metadata: { format: "gitlab-ci" }
  };
  const states = new Map();
  let bytes = 0;

  function localTarget(reference, sourceFile, line) {
    const normalized = String(reference || "").startsWith("/") ? `.${reference}` : reference;
    let candidate;
    try { candidate = resolveInside(root, normalized); }
    catch (error) {
      result.findings.push(finding("high", "gitlab-local-path-escape", `${sourceFile}#L${line}`, reference, error.message, { blocking: true }));
      result.coverage.complete = false;
      result.coverage.reasons.push("a local GitLab include escaped the repository root");
      return null;
    }
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("target is not a regular file");
      return fs.realpathSync(candidate);
    } catch (error) {
      result.findings.push(finding("medium", "gitlab-local-include-missing", `${sourceFile}#L${line}`, reference,
        `The local GitLab include could not be read: ${error.message}`));
      result.coverage.complete = false;
      result.coverage.reasons.push(`local include was unavailable: ${reference}`);
      return null;
    }
  }

  function inspect(file, depth, ancestry = []) {
    const relative = portable(path.relative(root, file));
    if (depth > maxDepth) {
      result.findings.push(finding("medium", "gitlab-include-depth-limit", relative, depth,
        `Local GitLab include depth exceeds ${maxDepth}.`));
      result.coverage.complete = false;
      result.coverage.reasons.push(`local include traversal stopped at depth ${maxDepth}`);
      return;
    }
    if (states.get(file) === "done") return;
    if (states.get(file) === "visiting") {
      result.findings.push(finding("medium", "gitlab-include-cycle", relative, [...ancestry, relative].join(" -> "),
        "The local GitLab include graph contains a cycle."));
      return;
    }
    if (states.size >= maxFiles) {
      result.coverage.complete = false;
      result.coverage.reasons.push(`GitLab file limit (${maxFiles}) reached`);
      return;
    }
    states.set(file, "visiting");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxFileBytes || bytes + stat.size > maxTotalBytes) {
      result.findings.push(finding("medium", "gitlab-file-limit", relative, stat.size,
        "The GitLab CI file could not be inspected within the configured regular-file and byte limits."));
      result.coverage.complete = false;
      result.coverage.reasons.push(`GitLab file skipped: ${relative}`);
      states.set(file, "done");
      return;
    }
    const source = fs.readFileSync(file, "utf8");
    bytes += stat.size;
    result.coverage.filesInspected += 1;
    for (const include of extractGitLabIncludes(source)) {
      const evidence = `${relative}#L${include.line}`;
      const reference = include.value || "";
      const component = {
        kind: `gitlab-${include.kind}-include`, reference, file: relative, line: include.line,
        ref: include.ref, targetFile: include.file, integrity: include.integrity
      };
      result.components.push(component);
      if (!reference || dynamic(reference) || dynamic(include.ref)) {
        result.findings.push(finding("high", "gitlab-dynamic-include", evidence, reference || include.ref,
          "The include target is computed at pipeline runtime and cannot be resolved before execution."));
        result.coverage.complete = false;
        result.coverage.reasons.push("a dynamic GitLab include could not be resolved");
      } else if (include.kind === "local") {
        const target = localTarget(reference, relative, include.line);
        component.localPath = target ? portable(path.relative(root, target)) : null;
        if (target) {
          if (states.get(target) === "visiting") result.findings.push(finding("medium", "gitlab-include-cycle", evidence, reference,
            "The local GitLab include graph contains a cycle."));
          else inspect(target, depth + 1, [...ancestry, relative]);
        }
      } else if (include.kind === "project") {
        if (!include.ref || !COMMIT_SHA.test(include.ref)) result.findings.push(finding("medium", "gitlab-mutable-project-include", evidence,
          `${reference}@${include.ref || "default"}`, "The project include is not pinned to an immutable commit SHA."));
      } else if (include.kind === "component") {
        const ref = reference.includes("@") ? reference.slice(reference.lastIndexOf("@") + 1) : "";
        if (!COMMIT_SHA.test(ref)) result.findings.push(finding("medium", "gitlab-mutable-component-include", evidence, reference,
          "The CI component is not pinned to an immutable commit SHA."));
      } else if (include.kind === "remote") {
        if (!validSha256Integrity(include.integrity)) result.findings.push(finding("medium", "gitlab-unverified-remote-include", evidence,
          reference, "The remote include lacks a valid SHA-256 integrity value."));
      } else if (include.kind === "template") {
        result.findings.push(finding("low", "gitlab-instance-template", evidence, reference,
          "The pipeline depends on an instance-supplied template whose bytes are not present locally."));
      }
    }
    for (const image of gitLabImages(source)) {
      const evidence = `${relative}#L${image.line}`;
      result.components.push({ kind: image.kind, reference: image.value, file: relative, line: image.line, immutable: OCI_DIGEST.test(image.value) });
      if (dynamic(image.value)) {
        result.findings.push(finding("high", "gitlab-dynamic-image", evidence, image.value,
          "The container image is computed at pipeline runtime and cannot be resolved statically."));
        result.coverage.complete = false;
        result.coverage.reasons.push("a dynamic GitLab image could not be resolved");
      } else if (!OCI_DIGEST.test(image.value)) {
        result.findings.push(finding("medium", "gitlab-mutable-image", evidence, image.value,
          "The pipeline image is not pinned by SHA-256 digest."));
      }
    }
    states.set(file, "done");
  }

  const entry = options.file || ".gitlab-ci.yml";
  let entryFile;
  try { entryFile = resolveInside(root, entry); }
  catch (error) {
    result.coverage.complete = false;
    result.coverage.reasons.push(error.message);
    return finalizeResult(result);
  }
  if (!fs.existsSync(entryFile)) {
    result.coverage.complete = false;
    result.coverage.reasons.push(`GitLab entry file not found: ${entry}`);
    result.findings.push(finding("medium", "gitlab-entry-missing", entry, entry, "The GitLab CI entry file is absent."));
  } else {
    const stat = fs.lstatSync(entryFile);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      result.coverage.complete = false;
      result.coverage.reasons.push(`GitLab entry file is not a regular file: ${entry}`);
      result.findings.push(finding("medium", "gitlab-entry-unreadable", entry, entry, "The GitLab CI entry file is not a regular file."));
    } else inspect(fs.realpathSync(entryFile), 0);
  }
  result.coverage.reasons = [...new Set(result.coverage.reasons)];
  return finalizeResult(result);
}

function scanJenkins(inputRoot, options = {}) {
  const root = fs.realpathSync(path.resolve(inputRoot));
  const inventory = listFiles(root, options);
  const result = {
    family: "jenkins", root, components: [], entrypoints: [], findings: [],
    coverage: { complete: inventory.complete, filesInspected: 0, reasons: inventory.reasons || [] },
    metadata: { format: "jenkins-pipeline" }
  };
  const files = inventory.files.filter(file => /(?:^|\/)(?:Jenkinsfile(?:\.[^/]*)?|\.jenkinsfile)$/i.test(file));
  let totalBytes = 0;
  const maxTotalBytes = options.maxTotalBytes ?? 8 * 1024 * 1024;
  for (const file of files) {
    let source;
    try {
      const stat = fs.lstatSync(resolveInside(root, file));
      if (totalBytes + stat.size > maxTotalBytes) throw new Error(`Jenkins descriptor byte limit (${maxTotalBytes}) reached`);
      source = readText(root, file, options);
      totalBytes += stat.size;
    }
    catch (error) {
      result.coverage.complete = false;
      result.coverage.reasons.push(error.message);
      continue;
    }
    result.coverage.filesInspected += 1;
    const libraries = [];
    for (const match of source.matchAll(/@Library\s*\(\s*(?:\[([^\]]+)\]|["']([^"']+)["'])\s*\)/g)) {
      const raw = match[1] || `"${match[2]}"`;
      for (const item of raw.matchAll(/["']([^"']+)["']/g)) libraries.push(item[1]);
    }
    for (const match of source.matchAll(/\blibrary\s*(?:\(\s*)?(?:identifier\s*:\s*)?["']([^"']+)["']/g)) libraries.push(match[1]);
    for (const reference of libraries) {
      const at = reference.lastIndexOf("@");
      const ref = at > 0 ? reference.slice(at + 1) : null;
      result.components.push({ kind: "jenkins-shared-library", reference, file, immutable: !!ref && COMMIT_SHA.test(ref) });
      if (!ref || !COMMIT_SHA.test(ref)) result.findings.push(finding("medium", "jenkins-mutable-library", file, reference,
        "The Jenkins shared library is not pinned to an immutable commit SHA."));
    }
    for (const match of source.matchAll(/(?:\bimage\s+|docker\.image\s*\(\s*)["']([^"']+)["']/g)) {
      const reference = match[1];
      result.components.push({ kind: "jenkins-agent-image", reference, file, immutable: OCI_DIGEST.test(reference) });
      if (dynamic(reference)) result.findings.push(finding("high", "jenkins-dynamic-image", file, reference,
        "The Jenkins agent image is computed at runtime."));
      else if (!OCI_DIGEST.test(reference)) result.findings.push(finding("medium", "jenkins-mutable-image", file, reference,
        "The Jenkins agent image is not pinned by SHA-256 digest."));
    }
    for (const match of source.matchAll(/@Grab\s*\(\s*["']([^"']+)["']\s*\)/g)) {
      const reference = match[1];
      result.components.push({ kind: "jenkins-groovy-dependency", reference, file, immutable: reference.split(":").length >= 3 && !/[+*\[\]()]/.test(reference) });
    }
    for (const match of source.matchAll(/\bid\s+["']([^"']+)["']\s+version\s+["']([^"']+)["']/g)) {
      result.components.push({ kind: "jenkins-plugin", name: match[1], reference: `${match[1]}@${match[2]}`, version: match[2], file, immutable: !/[+*]/.test(match[2]) });
    }
    for (const match of source.matchAll(/\b(maven|jdk|gradle|nodejs|ant)\s+["']([^"']+)["']/gi)) {
      result.components.push({ kind: "jenkins-tool", name: match[1].toLowerCase(), reference: match[2], file, immutable: false });
      result.findings.push(finding("low", "jenkins-controller-tool", file, `${match[1]}: ${match[2]}`,
        "The pipeline selects a controller-configured tool whose installation bytes are not present locally."));
    }
    for (const match of source.matchAll(/(?:^|[;\n])\s*(sh|bat|powershell|pwsh)\s*(?:\(\s*)?(?:script\s*:\s*)?["']([^"'\n]*)/g)) {
      result.entrypoints.push({ kind: "jenkins-command", command: match[1], script: match[2], file });
      result.findings.push(finding("medium", "jenkins-command", file, `${match[1]} ${match[2]}`,
        "The pipeline executes a shell or PowerShell command; review its complete Groovy construction and environment."));
    }
    for (const match of source.matchAll(/\bwithCredentials\s*\(|\bcredentials\s*\(\s*["']([^"']*)["']/g)) {
      result.entrypoints.push({ kind: "jenkins-credential-binding", name: match[1] || "withCredentials", file });
      result.findings.push(finding("medium", "jenkins-credential-binding", file, match[1] || "withCredentials",
        "The pipeline exposes a Jenkins-managed credential to executable pipeline code."));
    }
  }
  if (!files.length) {
    result.coverage.complete = false;
    result.coverage.reasons.push("no Jenkinsfile was found");
  }
  return finalizeResult(result);
}

function xmlAttribute(source, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(source);
  return match ? match[1] : null;
}

function xmlText(source, tag) {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(source);
  return match ? match[1].replace(/<[^>]+>/g, " ").trim() : null;
}

function classPath(value) {
  return String(value || "").replace(/\./g, "/") + ".class";
}

function scanJetBrainsPlugin(inputRoot, options = {}) {
  const root = fs.realpathSync(path.resolve(inputRoot));
  const inventory = listFiles(root, options);
  const descriptors = inventory.files.filter(file => /(?:^|\/)META-INF\/plugin\.xml$/i.test(file) || /^plugin\.xml$/i.test(file));
  const classFiles = inventory.files.filter(file => /\.class$/i.test(file));
  const jarFiles = inventory.files.filter(file => /\.jar$/i.test(file));
  const result = {
    family: "jetbrains-plugin", root, components: [], entrypoints: [], findings: [],
    coverage: { complete: inventory.complete, filesInspected: 0, reasons: inventory.reasons || [] },
    metadata: { format: "jetbrains-plugin", plugins: [] }
  };
  let totalBytes = 0;
  const maxTotalBytes = options.maxTotalBytes ?? 8 * 1024 * 1024;
  function declarationPath(file, declared, kind) {
    if (!declared || !/[/.]/.test(declared)) return;
    if (path.isAbsolute(declared) || /^[A-Za-z]:[\\/]/.test(declared) || declared.split(/[\\/]+/).includes("..")) {
      result.findings.push(finding("high", "jetbrains-path-escape", file, declared,
        `The declared JetBrains ${kind} path escapes its descriptor directory.`, { blocking: true }));
      result.coverage.complete = false;
      result.coverage.reasons.push(`JetBrains ${kind} path escaped the plugin root`);
      return;
    }
    if (/\.xml$/i.test(declared) || declared.includes("/")) {
      let candidate;
      try { candidate = resolveInside(root, path.posix.join(path.posix.dirname(file), declared)); }
      catch (error) {
        result.findings.push(finding("high", "jetbrains-path-escape", file, declared, error.message, { blocking: true }));
        result.coverage.complete = false;
        result.coverage.reasons.push(`JetBrains ${kind} path escaped the plugin root`);
        return;
      }
      if (!fs.existsSync(candidate)) {
        result.findings.push(finding("medium", "jetbrains-resource-missing", file, declared,
          `The declared JetBrains ${kind} resource is missing from the extracted plugin.`));
        result.coverage.complete = false;
        result.coverage.reasons.push(`declared JetBrains resource missing: ${declared}`);
      }
    }
  }
  function recordClass(file, kind, value) {
    if (!value) return;
    if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.split(/[\\/]+/).includes("..")) {
      result.findings.push(finding("high", "jetbrains-path-escape", file, value,
        "The declared JetBrains implementation class contains an escaping path.", { blocking: true }));
      result.coverage.complete = false;
      result.coverage.reasons.push("JetBrains class path escaped the plugin root");
    }
    result.entrypoints.push({ kind, className: value, path: classPath(value), file });
    if (classFiles.length) {
      const suffix = classPath(value).replace("$-", "$");
      if (!classFiles.some(item => item.endsWith(suffix))) {
        result.findings.push(finding("medium", "jetbrains-class-missing", file, value,
          "The declared implementation class was not found in the extracted class inventory."));
        result.coverage.complete = false;
        result.coverage.reasons.push(`declared JetBrains class missing: ${value}`);
      }
    }
  }
  for (const file of descriptors) {
    let source;
    try {
      const stat = fs.lstatSync(resolveInside(root, file));
      if (totalBytes + stat.size > maxTotalBytes) throw new Error(`JetBrains descriptor byte limit (${maxTotalBytes}) reached`);
      source = readText(root, file, options);
      totalBytes += stat.size;
    }
    catch (error) {
      result.coverage.complete = false;
      result.coverage.reasons.push(error.message);
      continue;
    }
    result.coverage.filesInspected += 1;
    if (/<!DOCTYPE|<!ENTITY/i.test(source)) {
      result.findings.push(finding("high", "jetbrains-xml-external-entity", file, "DOCTYPE/ENTITY",
        "The plugin descriptor declares a DTD or entity; external entity expansion is not supported."));
      result.coverage.complete = false;
      result.coverage.reasons.push(`unsupported XML entity declaration in ${file}`);
    }
    if (!/<idea-plugin\b/i.test(source)) {
      result.findings.push(finding("medium", "jetbrains-invalid-descriptor", file, "missing <idea-plugin>",
        "The JetBrains plugin descriptor root could not be recognized."));
      result.coverage.complete = false;
      continue;
    }
    const idea = /<idea-version\b([^>]*)\/?\s*>/i.exec(source);
    result.metadata.plugins.push({
      id: xmlText(source, "id"), name: xmlText(source, "name"), version: xmlText(source, "version"),
      sinceBuild: idea ? xmlAttribute(idea[1], "since-build") : null,
      untilBuild: idea ? xmlAttribute(idea[1], "until-build") : null,
      file
    });
    for (const match of source.matchAll(/<depends\b([^>]*)>([\s\S]*?)<\/depends>/gi)) {
      const id = match[2].replace(/<[^>]+>/g, "").trim();
      const optional = /^true$/i.test(xmlAttribute(match[1], "optional") || "");
      const configFile = xmlAttribute(match[1], "config-file");
      result.components.push({ kind: "jetbrains-plugin-dependency", reference: id, optional, configFile, file, immutable: false });
      if (!optional) result.findings.push(finding("low", "jetbrains-required-plugin", file, id,
        "The plugin requires another JetBrains plugin whose version and bytes are not pinned here."));
      if (configFile) declarationPath(file, configFile, "optional dependency config");
    }
    const tagPattern = /<(applicationService|projectService|moduleService|action|group|listener|extension)\b([^>]*)>/gi;
    for (const match of source.matchAll(tagPattern)) {
      const attrs = match[2];
      for (const key of ["serviceImplementation", "implementation", "implementationClass", "class", "listenerClass", "factoryClass", "instance"]) {
        const value = xmlAttribute(attrs, key);
        if (value) recordClass(file, `jetbrains-${match[1]}`, value);
      }
    }
    for (const block of source.matchAll(/<extensions\b[^>]*>([\s\S]*?)<\/extensions>/gi)) {
      for (const match of block[1].matchAll(/<([A-Za-z_][\w.:-]*)\b([^>]*)>/g)) {
        result.components.push({ kind: "jetbrains-extension", reference: match[1], file, immutable: true });
        if (["applicationService", "projectService", "moduleService", "action", "group", "listener", "extension"].includes(match[1])) continue;
        for (const key of ["serviceImplementation", "implementation", "implementationClass", "class", "listenerClass", "factoryClass", "instance"]) {
          const value = xmlAttribute(match[2], key);
          if (value) recordClass(file, `jetbrains-extension:${match[1]}`, value);
        }
      }
    }
    for (const match of source.matchAll(/<(permission|capability)\b([^>]*)\/?\s*>/gi)) {
      const name = xmlAttribute(match[2], "name") || xmlAttribute(match[2], "id") || match[2].trim();
      result.components.push({ kind: `jetbrains-${match[1].toLowerCase()}`, reference: name, file, immutable: true });
      result.findings.push(finding("medium", "jetbrains-requested-capability", file, name,
        "The plugin declares a permission or capability that requires operator review."));
    }
  }
  for (const jar of jarFiles) result.components.push({ kind: "jetbrains-runtime-archive", reference: jar, file: jar, immutable: false });
  if (jarFiles.length) {
    result.coverage.complete = false;
    result.coverage.reasons.push("JetBrains executable or dependency classes remain inside unexpanded JAR archives");
  }
  if (!descriptors.length) {
    result.coverage.complete = false;
    result.coverage.reasons.push("no JetBrains META-INF/plugin.xml descriptor was found");
  }
  result.coverage.reasons = [...new Set(result.coverage.reasons)];
  return finalizeResult(result);
}

module.exports = {
  extractGitLabIncludes,
  validSha256Integrity,
  scanGitLabCi,
  scanJenkins,
  scanJetBrainsPlugin
};
