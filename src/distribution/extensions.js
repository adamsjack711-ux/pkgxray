"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_MANIFEST_BYTES = 1024 * 1024;

const HIGH_RISK_BROWSER_PERMISSIONS = new Set([
  "debugger",
  "management",
  "nativeMessaging",
  "proxy"
]);
const REVIEW_BROWSER_PERMISSIONS = new Set([
  "browsingData",
  "clipboardRead",
  "clipboardWrite",
  "contentSettings",
  "cookies",
  "downloads",
  "geolocation",
  "history",
  "privacy",
  "sessions",
  "tabs",
  "webNavigation",
  "webRequest",
  "webRequestBlocking"
]);

function portable(relative) {
  return String(relative).replaceAll(path.sep, "/");
}

function inside(root, relative) {
  if (typeof relative !== "string" || !relative.trim() || path.isAbsolute(relative)) return null;
  const resolved = path.resolve(root, relative);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

function evidencePath(manifestPath, field) {
  return field ? `${portable(manifestPath)}#${field}` : portable(manifestPath);
}

function finding(severity, category, file, snippet, rationale) {
  return { severity, category, file: portable(file), snippet: String(snippet), rationale };
}

function makeReader(root, options, coverage, findings) {
  const maxBytes = options.maxManifestBytes || DEFAULT_MAX_MANIFEST_BYTES;
  return function readJson(relative, required = true) {
    const absolute = inside(root, relative);
    if (!absolute) {
      coverage.complete = false;
      coverage.reasons.push(`unsafe manifest path: ${relative}`);
      findings.push(finding("high", "extension-path-escape", relative, relative,
        "The manifest path resolves outside the extracted extension root."));
      return null;
    }
    let stat;
    try {
      stat = fs.lstatSync(absolute);
    } catch (error) {
      if (error.code === "ENOENT") {
        if (required) {
          coverage.complete = false;
          coverage.reasons.push(`missing manifest: ${portable(relative)}`);
        }
        return null;
      }
      throw error;
    }
    if (!stat.isFile()) {
      coverage.complete = false;
      coverage.reasons.push(`manifest is not a regular file: ${portable(relative)}`);
      findings.push(finding("high", "extension-non-regular-manifest", relative, relative,
        "The manifest is not a regular file; symlinks and special files are not followed."));
      return null;
    }
    if (stat.size > maxBytes) {
      coverage.complete = false;
      coverage.reasons.push(`manifest exceeds ${maxBytes} bytes: ${portable(relative)}`);
      findings.push(finding("high", "extension-manifest-too-large", relative, stat.size,
        `The manifest exceeds the bounded ${maxBytes}-byte read limit.`));
      return null;
    }
    let value;
    try {
      value = JSON.parse(fs.readFileSync(absolute, "utf8"));
    } catch (error) {
      coverage.complete = false;
      coverage.reasons.push(`invalid JSON: ${portable(relative)}`);
      findings.push(finding("high", "extension-invalid-manifest", relative, error.message,
        "The extension manifest is not valid JSON and could not be completely analyzed."));
      return null;
    }
    coverage.filesRead += 1;
    coverage.bytesRead += stat.size;
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  };
}

function regularFile(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

function resolveModuleEntrypoint(root, absolute) {
  const candidates = [absolute, ...[".js", ".cjs", ".mjs", ".ts", ".tsx", ".jsx"].map(extension => `${absolute}${extension}`)];
  for (const candidate of candidates) {
    if (inside(root, path.relative(root, candidate)) && regularFile(candidate)) return candidate;
  }
  let directory = false;
  try { directory = fs.lstatSync(absolute).isDirectory(); } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
  }
  if (directory) {
    for (const extension of [".js", ".cjs", ".mjs", ".ts", ".tsx", ".jsx"]) {
      const candidate = path.join(absolute, `index${extension}`);
      if (regularFile(candidate)) return candidate;
    }
  }
  return null;
}

function entrypoint(root, manifestPath, kind, declaredPath, findings, options = {}) {
  const evidence = evidencePath(manifestPath, kind);
  if (typeof declaredPath !== "string" || !declaredPath.trim()) return null;
  const absolute = inside(root, declaredPath);
  if (!absolute) {
    findings.push(finding("high", "extension-entrypoint-escape", evidence, declaredPath,
      "The declared executable entrypoint resolves outside the extracted extension root."));
    return { kind, path: declaredPath, evidence, exists: false, withinRoot: false };
  }
  const resolved = options.nodeModule === true ? resolveModuleEntrypoint(root, absolute) : regularFile(absolute) ? absolute : null;
  const exists = Boolean(resolved);
  if (!exists) {
    findings.push(finding("medium", "extension-entrypoint-missing", evidence, declaredPath,
      "The manifest declares an executable entrypoint that is missing or not a regular file."));
  }
  const actualPath = resolved ? portable(path.relative(root, resolved)) : portable(declaredPath);
  return {
    kind,
    path: actualPath,
    ...(actualPath !== portable(declaredPath) ? { declaredPath: portable(declaredPath) } : {}),
    evidence,
    exists,
    withinRoot: true
  };
}

function sortResult(result) {
  result.components.sort((a, b) =>
    `${a.kind}\0${a.reference}\0${a.evidence}`.localeCompare(`${b.kind}\0${b.reference}\0${b.evidence}`));
  result.entrypoints.sort((a, b) =>
    `${a.kind}\0${a.path}\0${a.evidence}`.localeCompare(`${b.kind}\0${b.path}\0${b.evidence}`));
  result.findings.sort((a, b) =>
    `${a.file}\0${a.category}\0${a.snippet}`.localeCompare(`${b.file}\0${b.category}\0${b.snippet}`));
  result.coverage.reasons = [...new Set(result.coverage.reasons)].sort();
  return result;
}

function resultBase(format) {
  return {
    schemaVersion: 1,
    family: format === "vsix" ? "editor-extension" : "browser-extension",
    format,
    components: [],
    entrypoints: [],
    findings: [],
    metadata: {},
    coverage: { complete: true, filesRead: 0, bytesRead: 0, reasons: [] }
  };
}

function scanVsix(extensionRoot, options = {}) {
  const root = path.resolve(extensionRoot);
  const result = resultBase("vsix");
  const readJson = makeReader(root, options, result.coverage, result.findings);
  const nested = readJson("extension/package.json", false);
  const manifestPath = nested ? "extension/package.json" : "package.json";
  const manifest = nested || readJson(manifestPath, true);
  if (!manifest) {
    result.findings.push(finding("high", "vsix-manifest-missing", manifestPath, manifestPath,
      "An extracted VSIX must contain extension/package.json (or a package-root package.json)."));
    return sortResult(result);
  }

  result.metadata = {
    name: typeof manifest.name === "string" ? manifest.name : null,
    publisher: typeof manifest.publisher === "string" ? manifest.publisher : null,
    version: typeof manifest.version === "string" ? manifest.version : null,
    engines: manifest.engines && typeof manifest.engines === "object" ? manifest.engines : {},
    activationEvents: Array.isArray(manifest.activationEvents) ? [...manifest.activationEvents] : [],
    capabilities: manifest.capabilities && typeof manifest.capabilities === "object" ? manifest.capabilities : {}
  };

  // VSIX archives put the extension payload below extension/. package.json
  // entrypoints are relative to that payload, not to the archive root.
  const payloadRoot = nested ? path.join(root, "extension") : root;
  for (const [kind, value] of [["main", manifest.main], ["browser", manifest.browser]]) {
    const item = entrypoint(payloadRoot, manifestPath, kind, value, result.findings, { nodeModule: true });
    if (item) result.entrypoints.push(item);
  }

  for (const [kind, values] of [
    ["extension-dependency", manifest.extensionDependencies],
    ["extension-pack-member", manifest.extensionPack]
  ]) {
    if (!Array.isArray(values)) continue;
    for (let index = 0; index < values.length; index += 1) {
      if (typeof values[index] !== "string") continue;
      result.components.push({
        kind,
        reference: values[index],
        evidence: evidencePath(manifestPath, `${kind}[${index}]`)
      });
    }
  }

  if (manifest.scripts && typeof manifest.scripts === "object" && !Array.isArray(manifest.scripts)) {
    for (const [name, command] of Object.entries(manifest.scripts)) {
      if (typeof command !== "string") continue;
      result.entrypoints.push({
        kind: "script",
        name,
        path: command,
        evidence: evidencePath(manifestPath, `scripts.${name}`),
        exists: null,
        withinRoot: null
      });
      if (/^(?:preinstall|install|postinstall|prepare|prepublishOnly)$/i.test(name)) {
        result.findings.push(finding("medium", "vsix-install-script",
          evidencePath(manifestPath, `scripts.${name}`), command,
          "This package declares an install or publication lifecycle command; review it before packaging or installing the extension."));
      }
    }
  }

  const caps = result.metadata.capabilities;
  if (caps.untrustedWorkspaces && caps.untrustedWorkspaces.supported === false) {
    result.findings.push(finding("medium", "vsix-requires-trusted-workspace",
      evidencePath(manifestPath, "capabilities.untrustedWorkspaces.supported"), "false",
      "The extension opts out of restricted mode and requires a trusted workspace to activate fully."));
  }
  if (caps.virtualWorkspaces && caps.virtualWorkspaces.supported === false) {
    result.findings.push(finding("low", "vsix-no-virtual-workspace-support",
      evidencePath(manifestPath, "capabilities.virtualWorkspaces.supported"), "false",
      "The extension declares that it cannot operate in virtual workspaces."));
  }
  return sortResult(result);
}

function permissionFinding(result, manifestPath, permission, field, index, optional) {
  const evidence = evidencePath(manifestPath, `${field}[${index}]`);
  if (typeof permission !== "string") return;
  result.components.push({
    kind: optional ? "optional-permission" : "permission",
    reference: permission,
    evidence
  });
  if (HIGH_RISK_BROWSER_PERMISSIONS.has(permission)) {
    result.findings.push(finding("high", "browser-high-risk-permission", evidence, permission,
      "This permission can expose privileged browser or native-host control and requires explicit review."));
  } else if (REVIEW_BROWSER_PERMISSIONS.has(permission)) {
    result.findings.push(finding("medium", "browser-sensitive-permission", evidence, permission,
      "This permission grants access to sensitive browsing data or browser behavior."));
  }
}

function hostPermissionFinding(result, manifestPath, pattern, field, index, optional) {
  const evidence = evidencePath(manifestPath, `${field}[${index}]`);
  if (typeof pattern !== "string") return;
  result.components.push({
    kind: optional ? "optional-host-permission" : "host-permission",
    reference: pattern,
    evidence
  });
  if (pattern === "<all_urls>" || /^\*:\/\/\*\//.test(pattern)) {
    result.findings.push(finding(optional ? "medium" : "high", "browser-broad-host-access", evidence, pattern,
      "The extension requests access to every or nearly every website."));
  }
}

function scanBrowserExtension(extensionRoot, options = {}) {
  const root = path.resolve(extensionRoot);
  const result = resultBase("browser-extension");
  const readJson = makeReader(root, options, result.coverage, result.findings);
  const manifestPath = "manifest.json";
  const manifest = readJson(manifestPath, true);
  if (!manifest) {
    result.findings.push(finding("high", "browser-manifest-missing", manifestPath, manifestPath,
      "An extracted Chrome or Firefox extension must contain manifest.json."));
    return sortResult(result);
  }
  result.metadata = {
    name: typeof manifest.name === "string" ? manifest.name : null,
    version: typeof manifest.version === "string" ? manifest.version : null,
    manifestVersion: manifest.manifest_version || null,
    browserSpecificSettings: manifest.browser_specific_settings || manifest.applications || null
  };

  const executable = [];
  if (manifest.background && typeof manifest.background === "object") {
    if (typeof manifest.background.service_worker === "string") executable.push(["background-service-worker", manifest.background.service_worker, "background.service_worker"]);
    if (typeof manifest.background.page === "string") executable.push(["background-page", manifest.background.page, "background.page"]);
    if (Array.isArray(manifest.background.scripts)) {
      manifest.background.scripts.forEach((value, index) => executable.push(["background-script", value, `background.scripts[${index}]`]));
    }
  }
  if (Array.isArray(manifest.content_scripts)) {
    manifest.content_scripts.forEach((group, groupIndex) => {
      if (!group || typeof group !== "object") return;
      if (Array.isArray(group.js)) {
        group.js.forEach((value, index) => executable.push(["content-script", value, `content_scripts[${groupIndex}].js[${index}]`]));
      }
      if (Array.isArray(group.matches)) {
        group.matches.forEach((value, index) => hostPermissionFinding(
          result, manifestPath, value, `content_scripts[${groupIndex}].matches`, index, false));
      }
    });
  }
  for (const [kind, value, field] of executable) {
    const item = entrypoint(root, manifestPath, kind, value, result.findings);
    if (item) item.evidence = evidencePath(manifestPath, field);
    if (item) result.entrypoints.push(item);
  }

  const permissionFields = [
    ["permissions", false],
    ["optional_permissions", true]
  ];
  for (const [field, optional] of permissionFields) {
    const values = Array.isArray(manifest[field]) ? manifest[field] : [];
    values.forEach((value, index) => {
      if (typeof value === "string" && (value === "<all_urls>" || /^(?:\*|https?|file|ftp):/.test(value))) {
        hostPermissionFinding(result, manifestPath, value, field, index, optional);
      } else {
        permissionFinding(result, manifestPath, value, field, index, optional);
      }
    });
  }
  for (const [field, optional] of [["host_permissions", false], ["optional_host_permissions", true]]) {
    const values = Array.isArray(manifest[field]) ? manifest[field] : [];
    values.forEach((value, index) => hostPermissionFinding(result, manifestPath, value, field, index, optional));
  }

  if (manifest.externally_connectable && typeof manifest.externally_connectable === "object") {
    const external = manifest.externally_connectable;
    for (const [field, values] of [["ids", external.ids], ["matches", external.matches]]) {
      if (!Array.isArray(values)) continue;
      values.forEach((value, index) => {
        if (typeof value !== "string") return;
        const evidence = evidencePath(manifestPath, `externally_connectable.${field}[${index}]`);
        result.components.push({ kind: "external-connection", reference: value, evidence });
        if (value === "*" || value === "<all_urls>" || /^\*:\/\/\*\//.test(value)) {
          result.findings.push(finding("high", "browser-broad-external-connectivity", evidence, value,
            "Any extension or website can connect to this extension under the declared pattern."));
        }
      });
    }
  }

  if (typeof manifest.update_url === "string") {
    result.components.push({
      kind: "update-channel",
      reference: manifest.update_url,
      evidence: evidencePath(manifestPath, "update_url")
    });
    let secure = false;
    try { secure = new URL(manifest.update_url).protocol === "https:"; } catch { /* finding below */ }
    if (!secure) {
      result.findings.push(finding("high", "browser-insecure-update-channel",
        evidencePath(manifestPath, "update_url"), manifest.update_url,
        "The extension update channel is invalid or does not use HTTPS."));
    } else {
      result.findings.push(finding("low", "browser-custom-update-channel",
        evidencePath(manifestPath, "update_url"), manifest.update_url,
        "The extension can receive code through this declared update endpoint; verify its ownership and signing path."));
    }
  }

  return sortResult(result);
}

module.exports = {
  DEFAULT_MAX_MANIFEST_BYTES,
  scanVsix,
  scanVsixExtension: scanVsix,
  scanBrowserExtension
};
