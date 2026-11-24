"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  finalizeResult,
  finding,
  listFiles,
  readJson,
  readText,
  resolveInside
} = require("./common");

const DESCRIPTORS = new Set([
  ".mcp.json",
  "mcp.json",
  "server.json",
  ".codex-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  "package.json"
]);
const INSTALL_HOOKS = new Set(["preinstall", "install", "postinstall", "prepare", "prepack"]);
const SHELL_LAUNCHERS = new Set(["sh", "bash", "zsh", "cmd", "cmd.exe", "powershell", "pwsh"]);

function packageReference(registry, identifier, version) {
  if (!identifier) return null;
  if (registry === "npm") return `npm:${identifier}${version ? `@${version}` : ""}`;
  if (["pypi", "pip", "python"].includes(registry)) return `pypi:${identifier}${version ? `@${version}` : ""}`;
  if (["oci", "docker"].includes(registry)) return `oci:${identifier}${version ? `@${version}` : ""}`;
  return `${registry || "package"}:${identifier}${version ? `@${version}` : ""}`;
}

function addPackage(result, registry, identifier, version, file) {
  const reference = packageReference(String(registry || "").toLowerCase(), identifier, version);
  if (reference) result.components.push({ kind: "package", ecosystem: registry || "unknown", name: identifier, version: version || null, reference, file });
}

function recordCommand(result, file, name, command, args = []) {
  if (!command) return;
  const argv = Array.isArray(args) ? args.map(String) : [];
  const rendered = [String(command), ...argv].join(" ");
  result.entrypoints.push({ kind: "command", name, command: String(command), args: argv, file });
  if (SHELL_LAUNCHERS.has(path.basename(String(command)).toLowerCase()) || /(?:^|\s)(?:-c|\/c)(?:\s|$)/i.test(rendered)) {
    result.findings.push(finding("high", "agent-shell-launch", file, rendered,
      "The agent package launches through a general-purpose shell; review the complete command and argument construction."));
  } else if (["npx", "uvx", "pipx", "docker", "podman"].includes(path.basename(String(command)).toLowerCase())) {
    result.findings.push(finding("medium", "agent-package-launcher", file, rendered,
      "The launch command can acquire or execute another package; require an exact version or immutable digest and scan that package first."));
  }
  const tokens = [String(command), ...argv];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (/^(?:npm|pypi|oci):/.test(token)) result.components.push({ kind: "package", reference: token, name: token, file });
    if (/^[\w@./-]+@[~^*]|^[\w@./-]+@(?:latest|next|beta)$/i.test(token)) {
      result.findings.push(finding("medium", "agent-mutable-package-ref", file, token,
        "The launcher uses a mutable package version rather than an exact version or digest."));
    }
  }
  const launcher = path.basename(String(command)).toLowerCase().replace(/\.cmd$/, "");
  const positional = argv.filter(token => token && !token.startsWith("-") && token !== "run");
  const launched = positional[0];
  if (launched && ["npx", "npm"].includes(launcher)) {
    result.components.push({ kind: "agent-package-dependency", ecosystem: "npm", name: launched, reference: `npm:${launched}`, file });
  } else if (launched && ["uvx", "pipx"].includes(launcher)) {
    result.components.push({ kind: "agent-package-dependency", ecosystem: "pypi", name: launched, reference: `pypi:${launched}`, file });
  } else if (launched && ["docker", "podman"].includes(launcher)) {
    result.components.push({ kind: "agent-container-dependency", ecosystem: "oci", name: launched, reference: `oci:${launched}`, file });
  }
}

function inspectMcpConfig(result, root, file, config) {
  const servers = config && config.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return;
  for (const [name, server] of Object.entries(servers)) {
    if (!server || typeof server !== "object") continue;
    if (server.url) {
      result.entrypoints.push({ kind: "remote-mcp", name, url: String(server.url), file });
      result.findings.push(finding("medium", "agent-remote-server", file, server.url,
        "The package connects the agent to a remote MCP server; review its trust boundary, authentication, and data handling."));
    }
    recordCommand(result, file, name, server.command, server.args);
    const env = server.env && typeof server.env === "object" ? Object.keys(server.env) : [];
    if (env.length) result.findings.push(finding("medium", "agent-environment-grant", file, env.join(", "),
      "The MCP launcher requests environment variables; verify that secrets are not exposed unnecessarily."));
  }
  void root;
}

function inspectServerDescriptor(result, file, descriptor) {
  for (const remote of Array.isArray(descriptor.remotes) ? descriptor.remotes : []) {
    if (!remote || !remote.url) continue;
    result.entrypoints.push({ kind: "remote-mcp", name: descriptor.name || null, url: String(remote.url), transport: remote.type || null, file });
    result.findings.push(finding("medium", "agent-remote-server", file, remote.url,
      "The MCP registry descriptor sends agent traffic to a remote service; review its authentication and data-retention boundary."));
  }
  for (const pkg of Array.isArray(descriptor.packages) ? descriptor.packages : []) {
    if (!pkg || typeof pkg !== "object") continue;
    addPackage(result, pkg.registryType, pkg.identifier, pkg.version, file);
    const args = (pkg.packageArguments || []).map(item => item && item.value).filter(value => value !== undefined);
    result.entrypoints.push({ kind: "package-launch", name: pkg.identifier || null, runtime: pkg.runtimeHint || null, args, file });
    if (!pkg.version || /^(?:latest|next|beta|[~^*])$/i.test(String(pkg.version))) {
      result.findings.push(finding("medium", "agent-mutable-package-ref", file, `${pkg.identifier || "package"}@${pkg.version || "latest"}`,
        "The agent package is not pinned to an exact registry version."));
    }
  }
}

function inspectPackageJson(result, file, pkg) {
  if (pkg.name) addPackage(result, "npm", pkg.name, pkg.version, file);
  for (const [name, value] of Object.entries(pkg.bin && typeof pkg.bin === "object" ? pkg.bin : {})) {
    result.entrypoints.push({ kind: "binary", name, path: String(value), file });
  }
  for (const [name, value] of Object.entries(pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {})) {
    if (!INSTALL_HOOKS.has(name)) continue;
    result.entrypoints.push({ kind: "install-hook", name, command: String(value), file });
    result.findings.push(finding("high", "agent-install-hook", file, `${name}: ${value}`,
      "This package executes a lifecycle hook during acquisition or installation; scan the referenced code before use."));
  }
}

function inspectPlugin(result, root, file, plugin) {
  const caps = plugin.interface && Array.isArray(plugin.interface.capabilities) ? plugin.interface.capabilities : [];
  for (const capability of caps) {
    result.findings.push(finding("low", "agent-capability", file, capability,
      "The plugin declares an agent capability; compare it with the package's stated purpose."));
  }
  for (const key of ["permissions", "requestedPermissions", "tools"]) {
    const declared = plugin[key];
    if (!declared) continue;
    const values = Array.isArray(declared) ? declared : Object.keys(declared);
    for (const value of values) result.findings.push(finding("medium", "agent-permission", file, `${key}: ${value}`,
      "The plugin requests an agent permission or tool surface that requires operator review."));
  }
  for (const key of ["mcpServers", "skills"]) {
    const relative = plugin[key];
    if (typeof relative !== "string") continue;
    try {
      // Codex/Claude plugin manifest paths are package-root-relative even
      // though the manifest itself lives below .codex-plugin/.claude-plugin.
      const target = resolveInside(root, relative);
      if (!fs.existsSync(target)) result.findings.push(finding("medium", "agent-missing-declaration", file, `${key}: ${relative}`,
        "The plugin references a declaration that is absent from the package."));
    } catch (error) {
      result.findings.push(finding("high", "agent-path-escape", file, `${key}: ${relative}`, error.message, { blocking: true }));
    }
  }
}

function inspectSkill(result, root, file) {
  let text;
  try { text = readText(root, file); }
  catch (error) {
    result.coverage.reasons.push(error.message);
    return;
  }
  const frontmatter = /^---\s*\n([\s\S]*?)\n---/.exec(text);
  const name = frontmatter && /^name:\s*(.+)$/m.exec(frontmatter[1]);
  result.components.push({ kind: "skill", name: name ? name[1].trim() : path.basename(path.dirname(file)), reference: file, file });
  if (/\b(?:read|send|upload|exfiltrat\w*)\b[^\n]{0,100}(?:\bsecrets?\b|\bcredentials?\b|\.ssh\b|\.aws\b|\.env\b)/i.test(text)) {
    result.findings.push(finding("high", "agent-skill-sensitive-data", file, "skill requests access or transfer of sensitive data",
      "The skill text asks the agent to access or transmit credentials or other sensitive data; treat its instructions as untrusted.", { blocking: true }));
  }
  if (/\b(?:curl|wget|Invoke-WebRequest|bash\s+-c|powershell|rm\s+-rf)\b/i.test(text)) {
    result.findings.push(finding("medium", "agent-skill-command", file, "skill contains direct shell or download commands",
      "The skill instructs the agent to run shell or download commands; review command targets and authority before activation."));
  }
}

function scanAgentPackage(root, options = {}) {
  const absolute = path.resolve(root);
  const inventory = listFiles(absolute, options);
  const result = {
    family: "agent-package",
    root: absolute,
    components: [], entrypoints: [], findings: [],
    coverage: { complete: inventory.complete, filesInspected: 0, reasons: inventory.reasons || (inventory.reason ? [inventory.reason] : []) }
  };
  for (const file of inventory.files) {
    if (/^(?:skills\/[^/]+\/)?SKILL\.md$/i.test(file) || /\/skills\/[^/]+\/SKILL\.md$/i.test(`/${file}`)) {
      inspectSkill(result, absolute, file);
      result.coverage.filesInspected += 1;
      continue;
    }
    if (!DESCRIPTORS.has(file)) continue;
    let descriptor;
    try { descriptor = readJson(absolute, file, options); }
    catch (error) {
      result.coverage.reasons.push(error.message);
      result.findings.push(finding("medium", "agent-invalid-descriptor", file, error.message,
        "The agent package descriptor could not be parsed, so its launch and permission surface is incomplete."));
      continue;
    }
    result.coverage.filesInspected += 1;
    if (file === ".mcp.json" || file === "mcp.json") inspectMcpConfig(result, absolute, file, descriptor);
    else if (file === "server.json") inspectServerDescriptor(result, file, descriptor);
    else if (file === "package.json") inspectPackageJson(result, file, descriptor);
    else inspectPlugin(result, absolute, file, descriptor);
  }
  if (result.coverage.filesInspected === 0) {
    result.coverage.reasons.push("no recognized agent package descriptors were found");
  }
  return finalizeResult(result);
}

module.exports = { scanAgentPackage };
