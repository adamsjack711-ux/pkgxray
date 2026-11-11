#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { auditEvidence, renderMarkdown } = require("../src/auditor");
const { guardExtension, parseReference } = require("../src/quarantine");
const { auditLockfile, renderLockfileMarkdown, sanitizeForTerminal } = require("../src/lockfile");
const { triageLockfile } = require("../src/triage");
const cfg = require("../src/config");
const { scanInVm, exactVmReference } = require("../src/vm-scan");
const { toBinaryResult } = require("../src/automatic-flow");
// Before an immutable identity is known, preparation still needs a resource
// bound. Unique keys prohibit sharing caller-owned staging or side effects.
const guardAdmission = new (require('../src/shared-scans').SharedScans)({ concurrency: 4,
  maxQueue: 124, maxBytes: 16 * 1024 * 1024, timeoutMs: 60000, maxCacheBytes: 0 });

const AUDIT_TOOL_NAME = "audit_agent_extension_supply_chain";
const GUARD_TOOL_NAME = "guard_agent_extension_install";
const LOCKFILE_AUDIT_TOOL_NAME = "audit_lockfile_supply_chain";
const LOCKFILE_TRIAGE_TOOL_NAME = "triage_lockfile_supply_chain";
const COMPOSE_TOOL_NAME = "analyze_package_composition";
const COMPOSE_ENABLED = process.env.PKGXRAY_COMPOSE === "1";
let composeBusy = false;
const VM_TOOL_NAME = "scan_npm_package_in_vm";
// Read once from the trusted operator environment; callers cannot enable it.
const VM_ENABLED = process.env.PKGXRAY_VM_TESTS === "1";
let vmBusy = false;

// Always the published package version — a hardcoded string here drifted to
// 0.12.0 while the package shipped 0.17.0, so hosts (and pkgxray's own
// manifest pins) recorded a phantom version.
const SERVER_VERSION = require("../package.json").version;

// ---------------------------------------------------------------------------
// Shared config (`.pkgxray.json`) — loaded ONCE at startup. The MCP server is
// the agent-deployment surface, so it reads the same policy file every other
// surface reads (via src/config.js) and starts from the stricter `mcp` view.
// Warnings (loosenings, malformed entries, dropped un-pinned allows) go to
// stderr so they never contaminate the JSON-RPC stream on stdout.
//
// Config uses SHORT tool names ("audit" / "guard" / "recheck"); the MCP wire
// protocol uses the long, self-describing names. This table maps each MCP tool
// to the config short name that gates it, so `mcp.tools: ["audit","recheck"]`
// controls exposure without the config author having to know wire names:
//   guard   -> guard_agent_extension_install
//   audit   -> audit_agent_extension_supply_chain + audit_lockfile_supply_chain
//   recheck -> triage_lockfile_supply_chain   (recheck == re-triage a lockfile)
// A tool is exposed only when mcpToolAllowed(config, <shortName>) is true
// (mcp.tools null/omitted = all tools exposed).
// ---------------------------------------------------------------------------
const CONFIG_TOOL_KEY = Object.freeze({
  [GUARD_TOOL_NAME]: "guard",
  [AUDIT_TOOL_NAME]: "audit",
  [LOCKFILE_AUDIT_TOOL_NAME]: "audit",
  [LOCKFILE_TRIAGE_TOOL_NAME]: "recheck",
  [VM_TOOL_NAME]: "guard",
  [COMPOSE_TOOL_NAME]: "compose"
});

const { config: CONFIG, warnings: CONFIG_WARNINGS } = cfg.loadConfig({ cwd: process.cwd() });
for (const w of CONFIG_WARNINGS) {
  process.stderr.write(`pkgxray: ${w}\n`);
}
const MCP_CONFIG = cfg.mcpConfig(CONFIG);

// Whether an MCP tool is exposed under the effective config.
function toolExposed(mcpToolName) {
  if (mcpToolName === COMPOSE_TOOL_NAME && !COMPOSE_ENABLED) return false;
  if (mcpToolName === VM_TOOL_NAME && !VM_ENABLED) return false;
  const key = CONFIG_TOOL_KEY[mcpToolName];
  if (!key) return true; // unmapped tools are never hidden by config
  return cfg.mcpToolAllowed(CONFIG, key);
}

// SECURITY: cap the inbound stdin buffer so a hostile caller can't OOM us
// by sending gigabytes of payload with no newline. 4 MiB is comfortably
// larger than any realistic JSON-RPC frame.
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
let buffer = "";
let bufferOverflowed = false;

const HOME_DIR = os.homedir();
const ALLOWED_ROOTS_ENV = "PKGXRAY_MCP_ALLOWED_ROOTS";

// Filesystem-capable MCP tools are limited by the operator, never by a tool
// argument an LLM can set. The default is the server's startup directory.
// Multiple roots use the platform path delimiter (`:` on Unix, `;` on Windows).
function loadAllowedRoots() {
  const configured = process.env[ALLOWED_ROOTS_ENV];
  const values = configured === undefined
    ? [process.cwd()]
    : configured.split(path.delimiter).filter(Boolean);
  const roots = [];
  for (const value of values) {
    try {
      roots.push(fs.realpathSync(path.resolve(value)));
    } catch {
      process.stderr.write(
        `pkgxray: ignoring unreadable ${ALLOWED_ROOTS_ENV} entry\n`
      );
    }
  }
  return [...new Set(roots)];
}

const MCP_ALLOWED_ROOTS = loadAllowedRoots();

function send(message) {
  let encoded;
  try {
    encoded = JSON.stringify(message);
  } catch {
    encoded = JSON.stringify({ jsonrpc: "2.0", id: message && message.id,
      error: { code: -32603, message: "Response could not be serialized" } });
  }
  if (Buffer.byteLength(encoded) > MAX_RESPONSE_BYTES) {
    encoded = JSON.stringify({ jsonrpc: "2.0", id: message && message.id,
      error: { code: -32603, message: "Response exceeded the safe output limit" } });
  }
  if (process.stdout.writableLength > 8 * 1024 * 1024) {
    process.stdin.destroy(); process.exitCode = 1; return;
  }
  process.stdout.write(`${encoded}\n`);
}

function textContent(text) {
  return [{ type: "text", text }];
}

function auditToolDefinition() {
  return {
    name: AUDIT_TOOL_NAME,
    title: "Audit supplied package evidence",
    description:
      "Statically analyze caller-supplied package source and metadata. Returns a structured SAFE or BLOCK report with cited findings; incomplete or uncertain evidence is blocked without a manual decision; it does not read local files, install packages, or execute code. A SAFE result is defense in depth, not proof of harmlessness. For a live npm package, use guard_agent_extension_install.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        packageName: { type: "string" },
        npmMetadata: {},
        githubMetadata: {},
        webPresence: {},
        knownVulnerabilities: {
          type: "array",
          description: "Optional array of OSV-shaped vulnerability records (id, aliases, summary, references)."
        },
        provenanceAttestation: {
          description:
            "Optional npm SLSA provenance attestation object (as returned by registry.npmjs.org/-/npm/v1/attestations). When provided, the auditor cross-checks the attested source repo against the declared package.json repository and emits a provenance-attested or provenance-mismatch band.",
          type: "object"
        },
        npmVsGithubDiff: {
          description: "Optional pre-computed npm-vs-github file diff (see guard output for shape).",
          type: "object"
        },
        sourceFiles: {
          description:
            "Map of file path to source text, or an array of objects with path/name and content/text.",
          anyOf: [
            { type: "object", additionalProperties: { type: "string" } },
            {
              type: "array",
              items: {
                type: "object",
                additionalProperties: true,
                properties: {
                  path: { type: "string" },
                  name: { type: "string" },
                  content: { type: "string" },
                  text: { type: "string" }
                }
              }
            }
          ]
        },
        outputFormat: {
          type: "string",
          enum: ["markdown", "json"],
          default: "markdown"
        }
      },
      required: ["sourceFiles"]
    }
  };
}

function guardToolDefinition() {
  return {
    name: GUARD_TOOL_NAME,
    title: "Guard a package before installation",
    description:
      "Fetch and inspect one package reference, then return a redacted SAFE or BLOCK decision. Automatically retry an eligible missing check once against the same acquired artifact, then block if required checks or findings remain uncertain. No manual approval or decision prompts. Never runs package code or writes package files outside temporary quarantine. Local references are confined to operator-approved roots.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        reference: {
          type: "string",
          description:
            "Exact package reference, preferably npm:name@version. Local file:path or directory references must resolve under an operator-approved root."
        },
        quarantineRoot: {
          type: "string",
          description: "Optional staging root under an operator-approved filesystem root. Omit to use an internally selected OS temporary directory."
        },
        policy: {
          type: "string",
          enum: ["safe-only"],
          default: "safe-only"
        },
        sourceScan: {
          type: "boolean",
          default: true,
          description: "Set false to stage and vulnerability-check without collecting source files."
        },
        vulnerabilityCheck: {
          type: "boolean",
          default: true,
          description: "Set false to skip OSV vulnerability intelligence checks."
        },
        githubMetadata: {
          type: "boolean",
          default: true,
          description: "Set false to skip the GitHub provenance cross-check."
        },
        githubDiff: {
          type: "boolean",
          default: true,
          description: "Set false to skip the npm-vs-GitHub source diff (saves a tarball download)."
        },
        deep: {
          type: "boolean",
          default: false,
          description: "Reserved — guard already runs the full pipeline; passed through for parity with audit_lockfile_supply_chain."
        },
        outputFormat: {
          type: "string",
          enum: ["markdown", "json"],
          default: "markdown"
        }
      },
      required: ["reference"]
    }
  };
}

function lockfileAuditToolDefinition() {
  return {
    name: LOCKFILE_AUDIT_TOOL_NAME,
    title: "Audit a dependency manifest",
    description:
      "Read a dependency manifest under an operator-approved root and query OSV for each resolved dependency. Returns structured SAFE or BLOCK decisions and honors a sibling .pkgxray.lock. Unresolved versions or incomplete checks are blocked. Does not install dependencies or execute package code. deep/deepAll add npm and GitHub network scans.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        lockfilePath: {
          type: "string",
          description:
            "Path to a package-lock.json, npm-shrinkwrap.json, yarn.lock, pnpm-lock.yaml, or package.json under an operator-approved root. Must be a readable regular file."
        },
        deep: {
          type: "boolean",
          default: false,
          description:
            "Run the full guard pipeline (static heuristics + GitHub metadata) on every OSV-blocked dep. Slower but surfaces more bands."
        },
        deepAll: {
          type: "boolean",
          default: false,
          description: "Run the deep pipeline on every dep, not just blocked ones. Much slower; use sparingly."
        },
        vulnerabilityCheck: {
          type: "boolean",
          default: true,
          description: "Set false to skip the OSV query (useful when offline or pre-supplied)."
        },
        outputFormat: {
          type: "string",
          enum: ["markdown", "json"],
          default: "markdown"
        }
      },
      required: ["lockfilePath"]
    }
  };
}

function lockfileTriageToolDefinition() {
  return {
    name: LOCKFILE_TRIAGE_TOOL_NAME,
    title: "Record dependency triage decisions",
    description:
      "Read a manifest under an operator-approved root and write bulk allow or block decisions to its sibling .pkgxray.lock. This changes future audit policy for every selected dependency: auto=allow suppresses those findings, while auto=block preserves rejection. MCP has no interactive confirmation, so review the target and mode before calling.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        lockfilePath: {
          type: "string",
          description:
            "Path to a package-lock.json, npm-shrinkwrap.json, yarn.lock, pnpm-lock.yaml, or package.json under an operator-approved root. A sibling .pkgxray.lock will be written."
        },
        auto: {
          type: "string",
          enum: ["allow", "block"],
          description:
            "Required. Decision to apply to every package in the worklist. 'block' records each flagged dep as blocked (preserves OSV findings as documented suppressions); 'allow' accepts every dep and silences it on subsequent audits."
        },
        includeSafe: {
          type: "boolean",
          default: false,
          description:
            "If true, every dep (including OSV-safe ones) enters the worklist. Default false — only flagged or blocked deps are decided."
        },
        vulnerabilityCheck: {
          type: "boolean",
          default: true,
          description: "Set false for offline triage; vulnerability coverage is explicitly reported as disabled."
        },
        outputFormat: {
          type: "string",
          enum: ["markdown", "json"],
          default: "markdown"
        }
      },
      required: ["lockfilePath", "auto"]
    }
  };
}

function composeToolDefinition() {
  return {
    name: COMPOSE_TOOL_NAME, title: "Trace data between local packages",
    description: "Experimental static composition analysis of a stable local npm source snapshot plus bundled pkgxray evidence checks. Requires package-lock.json v2/v3 and matching source files. Reads only under operator-approved roots; never executes target code, downloads packages, or authorizes installation. Incomplete coverage blocks installation without a manual decision; package BLOCK findings are preserved.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", additionalProperties: false, required: ["projectPath"], properties: {
      projectPath: { type: "string", description: "Local source directory under an operator-approved root" },
      entry: { type: "string", description: "Relative JavaScript entrypoint", default: "index.js" },
      outputFormat: { type: "string", enum: ["markdown", "json"], default: "markdown" }
    } }
  };
}

function vmToolDefinition() {
  return {
    name: VM_TOOL_NAME, title: "Observe an npm package in a disposable VM",
    description: "EXECUTES one exact public npm version's lifecycle scripts and root import in a new local hardware-accelerated VM. No network adapter or host mounts. Observes synthetic credential access, DNS attempts and honeypot changes. Requires operator setup and opt-in. Never approves installation; a quiet run does not prove safety. No dependency download or arbitrary commands.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: { type: "object", additionalProperties: false, required: ["reference"], properties: {
      reference: { type: "string", description: "npm:name@exact-version only" },
      profile: { type: "string", enum: ["developer", "ci"], default: "developer" }
    } }
  };
}

function listTools() {
  // Only advertise tools the config permits. A config with
  // `mcp.tools: ["audit","recheck"]` drops guard from the listing entirely, so
  // an agent never even sees a tool it isn't allowed to invoke.
  return [
    auditToolDefinition(),
    guardToolDefinition(),
    lockfileAuditToolDefinition(),
    lockfileTriageToolDefinition(), vmToolDefinition(), composeToolDefinition()
  ].filter((t) => toolExposed(t.name));
}

const TOOL_NAMES = new Set([
  AUDIT_TOOL_NAME,
  GUARD_TOOL_NAME,
  LOCKFILE_AUDIT_TOOL_NAME,
  LOCKFILE_TRIAGE_TOOL_NAME, VM_TOOL_NAME, COMPOSE_TOOL_NAME
]);

// Acquisition's parser is the authority for classification AND path semantics.
// In particular, do not separately decode URLs or maintain a prefix allowlist.
const TOOL_SCHEMAS = new Map([
  auditToolDefinition(), guardToolDefinition(), lockfileAuditToolDefinition(), lockfileTriageToolDefinition(), vmToolDefinition(), composeToolDefinition()
].map(tool => [tool.name, tool.inputSchema]));

function toolOptions(toolName, args) {
  return Object.fromEntries(Object.keys(TOOL_SCHEMAS.get(toolName).properties)
    .filter(key => Object.hasOwn(args, key)).map(key => [key, args[key]]));
}

function isWithinAllowedRoot(candidate) {
  return MCP_ALLOWED_ROOTS.some((root) => {
    const relative = path.relative(root, candidate);
    return relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative));
  });
}

// Resolve symlinks in the existing prefix. This also handles destinations that
// do not exist yet without letting a symlinked parent escape an approved root.
function canonicalPath(candidate, mustExist) {
  const absolute = path.resolve(candidate);
  if (mustExist) return fs.realpathSync(absolute);

  let existing = absolute;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error("no readable parent");
    existing = parent;
  }
  const resolvedParent = fs.realpathSync(existing);
  return path.resolve(resolvedParent, path.relative(existing, absolute));
}

function resolveOperatorPath(candidate, { mustExist = true } = {}) {
  try {
    const resolved = canonicalPath(candidate, mustExist);
    if (!isWithinAllowedRoot(resolved)) return null;
    return resolved;
  } catch {
    return null;
  }
}

// SECURITY: error messages from auditor / quarantine paths can include
// absolute filesystem paths. The MCP reply goes back to a possibly-hostile
// caller (an LLM whose context an attacker influenced). Strip absolute paths
// and the homedir before they leave so error messages can't be used to map
// the box.
function sanitizeErrorMessage(message) {
  if (typeof message !== "string") return "internal error";
  let out = message;
  if (HOME_DIR && HOME_DIR.length > 0) {
    out = out.split(HOME_DIR).join("~");
  }
  // OS temp prefix (macOS: /private/var/folders/...; linux: /tmp/...).
  out = out.replace(/\/(?:private\/)?(?:var|tmp)\/[^\s'"`)]+/g, "<path>");
  // Remaining absolute-looking tokens — keep the basename for context.
  out = out.replace(/(?:^|\s)\/(?:[^\s/]+\/)+([^\s/'"`)]+)/g, " <path>/$1");
  // Windows absolute paths: drive-letter roots (C:\… or C:/…) and UNC shares
  // (\\host\share\…). Neither pattern above matches a backslash path or a drive
  // letter, so on win32 the whole path survived into the reply — the temp dir
  // and the user profile with it, which is exactly the box-mapping this function
  // exists to prevent. The negative lookbehind stops a URL scheme ("http://…")
  // from reading as a drive letter; the basename is kept for context, matching
  // the POSIX branch above.
  out = out.replace(
    /(?<![A-Za-z])(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])(?:[^\s'"`)]*[\\/])?([^\s\\/'"`)]+)/g,
    "<path>/$1"
  );
  return out;
}

// SECURITY: validate tool-call arguments before passing them through.
// `inputSchema` is descriptive; this is the actual enforcement layer.
function validateToolCall(toolName, args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return "arguments must be an object";
  }
  const schema = TOOL_SCHEMAS.get(toolName);
  if (!schema) return "unknown tool";
  // Deprecated manual approval arguments cannot enter the automatic flow.
  if (["reviewId", "reviewChoice", "reviewScope", "reviewDecisions", "reviewAction"].some(key => Object.hasOwn(args, key))) return "manual decision arguments are no longer supported; unresolved uncertainty is blocked automatically";
  // Preserve the helpful diagnostics for formerly accepted authority knobs.
  if (args.artifact !== undefined) return "artifact is reserved for trusted acquisition callers";
  if (args.allowLocalReferences !== undefined) return "allowLocalReferences is not supported; only the server operator can grant filesystem roots";
  if (args.promoteTo !== undefined || args.force !== undefined) {
    return "promotion is not available over MCP; use the trusted local CLI after reviewing the result";
  }
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(schema.properties, key)) return `unknown argument: ${key}`;
    const spec = schema.properties[key], value = args[key];
    if (value === undefined) continue;
    if (spec.type && (spec.type === "array" ? !Array.isArray(value) :
      spec.type === "object" ? !value || typeof value !== "object" || Array.isArray(value) : typeof value !== spec.type)) {
      return `${key} must be ${spec.type === "object" || spec.type === "array" ? "an" : "a"} ${spec.type}`;
    }
    if (spec.enum && !spec.enum.includes(value)) return `${key} must be ${spec.enum.map(v => `'${v}'`).join(" or ")}`;
  }
  if (toolName === COMPOSE_TOOL_NAME) {
    if (typeof args.projectPath !== "string" || !args.projectPath || args.projectPath.length > 4096 || args.projectPath.includes("\0")) return "projectPath must be a non-empty local path";
    const resolved = resolveOperatorPath(args.projectPath);
    if (!resolved) return "projectPath is unreadable or outside the operator-approved filesystem roots";
    if (!fs.statSync(resolved).isDirectory()) return "projectPath must be a directory";
    if (args.entry !== undefined && (!args.entry || args.entry.length > 4096 || args.entry.includes("\0") || args.entry.includes("\\") || path.posix.isAbsolute(args.entry) || /^[A-Za-z]:/.test(args.entry) || args.entry.split("/").includes(".."))) return "entry must be a relative path within the project";
    args.projectPath = resolved;
  } else if (toolName === VM_TOOL_NAME) {
    try { exactVmReference(args.reference); } catch { return "VM scans require npm:name@exact-version"; }
  } else if (toolName === GUARD_TOOL_NAME) {
    if (args.artifact !== undefined) return "artifact is reserved for trusted acquisition callers";
    if (typeof args.reference !== "string" || args.reference.length === 0) {
      return "reference must be a non-empty string";
    }
    if (args.reference.includes("\0")) {
      return "reference must not contain a NUL byte";
    }
    if (args.allowLocalReferences !== undefined) {
      return "allowLocalReferences is not supported; only the server operator can grant filesystem roots";
    }
    let parsed;
    try { parsed = parseReference(args.reference); }
    catch { return "invalid package reference"; }
    if (parsed.type === "local") {
      const resolved = resolveOperatorPath(parsed.path);
      if (!resolved) {
        return "local reference is unreadable or outside the operator-approved filesystem roots";
      }
      args.reference = `file:${resolved}`;
    }
    for (const k of ["quarantineRoot"]) {
      if (args[k] !== undefined && (typeof args[k] !== "string" || args[k].includes("\0"))) {
        return `${k} must be a string without a NUL byte`;
      }
      if (args[k] !== undefined) {
        const resolved = resolveOperatorPath(args[k], { mustExist: false });
        if (!resolved) {
          return `${k} is outside the operator-approved filesystem roots`;
        }
        args[k] = resolved;
      }
    }
    for (const k of ["sourceScan", "vulnerabilityCheck", "githubMetadata", "githubDiff", "deep"]) {
      if (args[k] !== undefined && typeof args[k] !== "boolean") {
        return `${k} must be a boolean`;
      }
    }
    if (args.policy !== undefined && args.policy !== "safe-only") {
      return "policy must be 'safe-only'; uncertainty cannot be approved manually";
    }
  } else if (toolName === AUDIT_TOOL_NAME) {
    if (args.sourceFiles === undefined || args.sourceFiles === null) {
      return "sourceFiles is required";
    }
    if (typeof args.sourceFiles !== "object") {
      return "sourceFiles must be an object map or an array";
    }
    if (args.packageName !== undefined && typeof args.packageName !== "string") {
      return "packageName must be a string";
    }
  } else if (toolName === LOCKFILE_AUDIT_TOOL_NAME || toolName === LOCKFILE_TRIAGE_TOOL_NAME) {
    if (typeof args.lockfilePath !== "string" || args.lockfilePath.length === 0) {
      return "lockfilePath must be a non-empty string";
    }
    if (args.lockfilePath.includes("\0")) {
      return "lockfilePath must not contain a NUL byte";
    }
    const resolved = resolveOperatorPath(args.lockfilePath);
    if (!resolved) {
      return "lockfilePath is unreadable or outside the operator-approved filesystem roots";
    }
    args.lockfilePath = resolved;
    if (toolName === LOCKFILE_TRIAGE_TOOL_NAME) {
      if (args.auto !== "allow" && args.auto !== "block") {
        return "auto must be 'allow' or 'block' (MCP transport has no TTY for interactive mode)";
      }
    }
    for (const k of ["deep", "deepAll", "vulnerabilityCheck", "includeSafe"]) {
      if (args[k] !== undefined && typeof args[k] !== "boolean") {
        return `${k} must be a boolean`;
      }
    }
  }
  if (args.outputFormat !== undefined && args.outputFormat !== "markdown" && args.outputFormat !== "json") {
    return "outputFormat must be 'markdown' or 'json'";
  }
  return null;
}

async function handleRequest(request, signal) {
  const { id, method, params } = request;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params && params.protocolVersion ? params.protocolVersion : "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: "pkgxray",
          version: SERVER_VERSION
        }
      }
    };
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: listTools()
      }
    };
  }

  if (method === "tools/call") {
    const currentConfig = cfg.loadConfig({ cwd: process.cwd() }).config;
    const currentMcpConfig = cfg.mcpConfig(currentConfig);
    const name = params && params.name;
    if (!TOOL_NAMES.has(name)) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32602,
          message: `Unknown tool: ${name}`
        }
      };
    }

    // A tool the config filtered out of tools/list must not run even if a
    // client calls it directly — treat it as if it doesn't exist.
    if (!toolExposed(name) || !cfg.mcpToolAllowed(currentConfig, CONFIG_TOOL_KEY[name])) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32602,
          message: `Tool not available under current .pkgxray.json policy: ${name}`
        }
      };
    }

    const args = (params && params.arguments) || {};

    const validationError = validateToolCall(name, args);
    if (validationError) {
      return invalidParams(id, validationError);
    }

    if (name === COMPOSE_TOOL_NAME) {
      if (composeBusy) return invalidParams(id, "Composition scanner is busy; retry after the current scan");
      composeBusy = true;
      try {
        // Recheck authorization after admission; target paths never select code.
        if (resolveOperatorPath(args.projectPath) !== args.projectPath) return invalidParams(id, "Source root changed; retry");
        const output = await require("../src/compose-scan").scanComposition(args.projectPath, { entry: args.entry, signal });
        signal?.throwIfAborted();
        const report = publicCompositionResult(output.report || output);
        const text = args.outputFormat === "json" ? JSON.stringify(report) : renderCompositionMarkdown(report);
        return { jsonrpc: "2.0", id, result: { content: textContent(text), structuredContent: report } };
      } finally { composeBusy = false; }
    }

    if (name === VM_TOOL_NAME) {
      if (vmBusy) return invalidParams(id, "VM runner is busy; retry after the current scan completes");
      vmBusy = true;
      return scanInVm(args.reference, { profile: args.profile, config: currentConfig, allowExecution: true })
        .then(raw => { const report = toBinaryResult(raw); return { jsonrpc: "2.0", id, result: {
          content: textContent(JSON.stringify(report)), structuredContent: report
        } }; }).catch(error => {
          signal?.throwIfAborted();
          return scanErrorResult(id, VM_TOOL_NAME, error, "json");
        }).finally(() => { vmBusy = false; });
    }

    if (name === GUARD_TOOL_NAME) {
      // Stricter MCP defaults: when the caller doesn't pin a policy, fall back
      // to the (stricter) MCP-view policy rather than guard's own safe-only
      // default, so the agent surface can be tightened centrally in config.
      const guardOpts = { ...toolOptions(name, args), config: currentConfig, keepStaging: false, signal, sharedAnalysis: true };
      if (guardOpts.policy === undefined) guardOpts.policy = currentMcpConfig.policy;
      // The opt-in typosquat heuristic is a config knob, not a tool argument —
      // .pkgxray.json is the single switch for the agent surface.
      guardOpts.typosquat = currentConfig.typosquat;
      guardOpts.validatePolicy = () => {
        const { fingerprint } = require('../src/artifact');
        if (fingerprint(cfg.loadConfig({ cwd: process.cwd() }).config) !== fingerprint(currentConfig)) throw new Error('Policy changed during scan; no action authorized');
      };
      // Set AFTER the spread on purpose: `args` is caller-controlled, and a
      // scan-error policy is the server operator's decision, not the calling
      // agent's. This also stops a caller from passing scanErrorPolicy:
      // "fail-open" to talk the server out of a scan-gap block.
      guardOpts.scanErrorPolicy = currentConfig.scanErrorPolicy;
      // packageScanFirst (default true): the agent surface insists on a static
      // package scan before it will vouch for anything. Only when config
      // explicitly disables it (and the caller didn't ask for a scan) do we let
      // guard stage without collecting source.
      if (guardOpts.sourceScan === undefined) guardOpts.sourceScan = currentMcpConfig.packageScanFirst !== false;
      // MCP staging is ephemeral and this surface never promotes package files.
      return guardAdmission.get(Symbol('caller-owned-guard'), jobSignal =>
        guardExtension(args.reference, { ...guardOpts, signal: jobSignal }),
        { signal, bytes: Buffer.byteLength(JSON.stringify(args)), cache: false }).then(({ evidence: guardResult }) => {
        // Apply shared config to the resolved artifact: mutes, and — since guard
        // resolved a real sha256 — a pinned allowlist that can force `safe`.
        // applyConfig never changes a verdict silently; renderConfigEffects
        // surfaces every suppression in the response text below.
        const adjusted = publicGuardResult(guardResult);
        const text =
          args.outputFormat === "json"
            ? JSON.stringify(adjusted, null, 2)
            : renderGuardMarkdown(adjusted);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: textContent(text),
            structuredContent: adjusted
          }
        };
      }).catch(error => {
        signal?.throwIfAborted();
        if (["SCAN_CANCELLED", "SCAN_OVERLOADED", "SCANNER_CHANGED"].includes(error.code)) throw error;
        // Acquisition is never repeated here: a reference could resolve to
        // different bytes. A failed required check blocks without a prompt.
        return scanErrorResult(id, GUARD_TOOL_NAME, error, args.outputFormat);
      });
    }

    if (name === LOCKFILE_AUDIT_TOOL_NAME) {
      const fileError = validateLockfileExists(args.lockfilePath);
      if (fileError) return invalidParams(id, fileError);
      // Thread the config's typosquat setting into the deep-scan path (the
      // shallow pass is OSV-only; typosquat applies wherever auditEvidence runs).
      return auditLockfile(args.lockfilePath, { ...toolOptions(name, args), typosquat: currentConfig.typosquat, signal }).then((raw) => {
        const result = toBinaryResult(raw);
        const text =
          args.outputFormat === "json"
            ? JSON.stringify(result, null, 2)
            : renderLockfileMarkdown(result);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: textContent(text),
            structuredContent: result
          }
        };
      }).catch((error) => scanErrorResult(id, LOCKFILE_AUDIT_TOOL_NAME, error, args.outputFormat));
    }

    if (name === LOCKFILE_TRIAGE_TOOL_NAME) {
      const fileError = validateLockfileExists(args.lockfilePath);
      if (fileError) return invalidParams(id, fileError);
      // MCP has no TTY — we have to force non-interactive mode. The triage
      // runner inspects `auto` first, so the fake streams below are only used
      // for the summary line.
      const stdoutBuf = [];
      const fakeStdout = {
        isTTY: false,
        write(chunk) {
          stdoutBuf.push(String(chunk));
          return true;
        }
      };
      const fakeStderr = {
        isTTY: false,
        write() { return true; }
      };
      return triageLockfile(args.lockfilePath, {
        ...toolOptions(name, args),
        signal,
        // Honor the config typosquat setting through triage's deep scan
        // (triageLockfile spreads options into auditLockfile → runDeep).
        typosquat: currentConfig.typosquat,
        stdout: fakeStdout,
        stderr: fakeStderr,
        isTTY: true // skip the !isTTY refusal — auto mode runs without input
      }).then((raw) => {
        const result = toBinaryResult(raw);
        const text =
          args.outputFormat === "json"
            ? JSON.stringify(result, null, 2)
            : renderTriageMarkdown(result, args, stdoutBuf.join(""));
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: textContent(text),
            structuredContent: result
          }
        };
      });
    }

    // audit_agent_extension_supply_chain
    const { outputFormat, ...evidence } = args;
    let shared;
    try { shared = await analyzeSuppliedEvidence(evidence, { typosquat: currentConfig.typosquat }, { signal }); }
    catch (error) {
      signal?.throwIfAborted();
      if (['SCAN_CANCELLED', 'SCAN_OVERLOADED', 'SCANNER_CHANGED'].includes(error.code)) throw error;
      return scanErrorResult(id, AUDIT_TOOL_NAME, error, outputFormat);
    }
    signal?.throwIfAborted();
    const report = toBinaryResult({ ...cfg.applyConfig(shared.evidence, { config: currentConfig, packageName: evidence.packageName,
      evidence: { sourceFiles: Object.keys(evidence.sourceFiles || {}) } }), scanSource: shared.source });
    report.resolution = { ...report.resolution, retry: { attempted: shared.retryAttempts > 0, attempts: shared.retryAttempts,
      check: shared.retryAttempts ? 'source' : null } };
    const text =
      args.outputFormat === "json"
        ? JSON.stringify(report, null, 2)
        : renderMarkdown(report);

    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: textContent(text),
        structuredContent: report
      }
    };
  }

  if (method && method.startsWith("notifications/")) {
    return null;
  }

  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32601,
      message: `Method not found: ${method}`
    }
  };
}

// A failed worker may be retried once with the identical captured input. No
// acquisition is repeated, no budget is raised, and findings never trigger a
// retry. Queue pressure, cancellation and changed scanner builds are not
// transient evidence failures and must preserve their existing control paths.
async function analyzeSuppliedEvidence(evidence, analysis, { signal, analyze = require("../src/shared-scans").analyzeShared } = {}) {
  const capturedEvidence = JSON.stringify(evidence), capturedAnalysis = JSON.stringify(analysis);
  const retryable = new Set(["SCAN_ERROR", "SCAN_TIMEOUT", "EAGAIN", "EPIPE"]);
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    try {
      const result = await analyze(JSON.parse(capturedEvidence), JSON.parse(capturedAnalysis), { signal });
      return { ...result, retryAttempts: attempt };
    } catch (error) {
      signal?.throwIfAborted();
      if (attempt === 0 && retryable.has(error?.code)) continue;
      throw Object.assign(new Error(error?.message || "Static evidence scan failed"), { code: error?.code, retryAttempts: attempt });
    }
  }
}

function publicCompositionResult(raw) {
  const report = { ...raw };
  if (raw.compose) {
    const { verdict, ...flow } = raw.compose;
    // The flow engine describes modeled routes, not a safety verdict. Keep its
    // status under a non-authorizing analysis field on the public MCP surface.
    report.compose = { ...flow, analysisStatus: verdict === "review" ? "flow-found" : verdict };
  }
  report.summary = raw.blockingPackages?.length
    ? "Blocked: package findings prevent use; composition evidence cannot clear them."
    : "Blocked: selected-entry analysis cannot establish complete safety coverage. This does not establish malicious behavior.";
  return toBinaryResult(report);
}

function renderCompositionMarkdown(report) {
  const lines = ["Decision: **BLOCK**", report.summary, "Installation approval: not issued.", "",
    `Execution: ${sanitizeForTerminal(report.execution)}; coverage: ${sanitizeForTerminal(report.coverage?.status || "partial")}.`,
    `Modeled dataflow routes: ${report.compose?.findings?.length || 0}.`];
  for (const finding of report.compose?.findings || []) {
    lines.push("", `Dataflow: ${finding.crossPackage ? "cross-package" : "local"}`);
    for (const step of finding.trace || []) lines.push(`- ${sanitizeForTerminal(step.kind)}: ${sanitizeForTerminal(step.label)} at ${sanitizeForTerminal(step.file)}:${step.line}`);
  }
  for (const item of report.pkgxray?.packages || []) for (const finding of item.report?.findings || []) {
    if (["high", "medium"].includes(finding.severity)) lines.push(`- ${sanitizeForTerminal(finding.severity)} ${sanitizeForTerminal(finding.category)}: ${sanitizeForTerminal(finding.rationale)}`);
  }
  for (const gap of report.gaps || []) lines.push(`Incomplete check: ${sanitizeForTerminal(gap.code)} — ${sanitizeForTerminal(gap.message)}`);
  return lines.join("\n");
}

// Filesystem existence check — runs AFTER validateToolCall has checked the
// shape. We don't include the path in the error message so the caller can't
// use error replies as a fs-probe oracle.
function validateLockfileExists(lockfilePath) {
  try {
    const stat = fs.statSync(lockfilePath);
    if (!stat.isFile()) {
      return "lockfilePath is not a regular file";
    }
  } catch (error) {
    return "lockfilePath does not exist or is not readable";
  }
  return null;
}

function invalidParams(id, message) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32602, message }
  };
}

// Failed required checks return an explicit block, not an opaque absence of
// findings. Uncertainty is reported separately from confirmed malicious code.
function scanErrorResult(id, toolName, error, outputFormat) {
  const verdict = "block";
  const reason = sanitizeErrorMessage(error && error.message);
  const structured = {
    schemaVersion: 1,
    tool: toolName,
    scanError: true,
    verdict,
    scanErrorPolicy: "fail-closed",
    resolution: { reasonCodes: ["incomplete-checks"], retry: { attempted: error?.retryAttempts > 0, attempts: error?.retryAttempts || 0, check: error?.retryAttempts ? "source" : null } },
    message: `Required checks did not complete; this does not establish malicious behavior. ${reason}`
  };
  const text =
    outputFormat === "json"
      ? JSON.stringify(structured, null, 2)
      : `Scan error: verdict **BLOCK**. ${structured.message}`;
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: textContent(text),
      structuredContent: structured,
      isError: true
    }
  };
}

// Fold the shared config into a guard result. Guard has already resolved the
// artifact, so we have name@version + the tarball sha256 — everything applyConfig
// needs to honor a pinned allow. Returns a NEW result with the config-adjusted
// report, the re-derived decision, and a `configEffects` block. When config
// changes nothing the result is materially unchanged (empty effects).
function applyConfigToGuardResult(result, policy) {
  if (!result || !result.report) return result;
  const resolved = result.resolved || {};
  const adjustedReport = cfg.applyConfig(result.report, {
    config: CONFIG,
    packageName: resolved.packageName || result.report.packageName || null,
    version: resolved.version || null,
    sha256: resolved.sha256 || null,
    // Pass the original source files so the verdict re-fold sees the same
    // evidence completeness the initial audit did (avoids a spurious review
    // from an empty-evidence placeholder).
    evidence: { sourceFiles: sourceFilesEvidence(result.sourceFiles) }
  });
  // Re-derive the policy-folded decision from the (possibly allowlisted) verdict
  // so the top-line Decision can't disagree with the adjusted report verdict.
  // Re-apply the scan-gap floor afterwards — this re-derivation would otherwise
  // drop the floor guardExtension set (e.g. OSV unreachable). An explicit
  // pinned allowlist entry still wins; that's a human decision on record.
  const decision = cfg.guardDecision(adjustedReport, { policy: policy || "safe-only", config: CONFIG,
    vulnerabilityScanError: result.vulnerabilityPrecheck && result.vulnerabilityPrecheck.error,
    sourceCoverage: result.sourceCoverage, dependencyAudit: result.dependencyAudit });
  return { ...result, decision, report: adjustedReport, configEffects: adjustedReport.configEffects };
}

// applyConfig only reads `evidence.sourceFiles.length` (the incomplete-evidence
// gate). Guard stores sourceFiles as a path->text map; hand decideVerdict an
// array of the same cardinality so a fully-scanned package doesn't look empty.
function sourceFilesEvidence(sourceFiles) {
  if (Array.isArray(sourceFiles)) return sourceFiles;
  if (sourceFiles && typeof sourceFiles === "object") {
    return Object.keys(sourceFiles).map(() => ({}));
  }
  return [{}];
}

// The scanner needs raw package text internally, but an MCP caller does not.
// Returning sourceFiles made local scans a file-read primitive (including
// `.env` contents) and allowed a single response to grow to hundreds of MiB.
function publicGuardResult(result) {
  if (!result || typeof result !== "object") return result;
  const { sourceFiles, quarantinePath, stagedPath, promotedPath, ...safe } = result;
  safe.sourceEvidence = {
    fileCount: sourceFiles && typeof sourceFiles === "object" ? Object.keys(sourceFiles).length : 0,
    contentReturned: false
  };
  return toBinaryResult(redactSourceExcerpts(safe));
}

function redactSourceExcerpts(value, location = []) {
  if (Array.isArray(value)) return value.map((child, index) => redactSourceExcerpts(child, [...location, String(index)]));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    // These two scanner-authored fields describe coverage; they are not
    // package source text. Only preserve recognized statuses at exact paths.
    const coverageStatus = key === "source" && location.length === 2 &&
      ["assessment", "approval"].includes(location[0]) && location[1] === "checks" &&
      ["completed", "partial", "disabled", "skipped", "failed", "not-requested"].includes(child);
    if (coverageStatus) out[key] = child;
    else if (["content", "source", "sourceText", "snippet", "excerpt"].includes(key) && typeof child === "string") {
      out[key] = "<redacted>";
    } else {
      out[key] = redactSourceExcerpts(child, [...location, key]);
    }
  }
  return out;
}

function renderGuardMarkdown(result) {
  const lines = [
    `Decision: **${result.decision === "allow" ? "SAFE" : "BLOCK"}**`,
    `Reference: \`${sanitizeForTerminal(result.reference)}\``,
    ""
  ];

  if (result.resolution?.reasonCodes?.length) lines.push(`Reason: ${result.resolution.reasonCodes.map(sanitizeForTerminal).join(", ")}.`,
    "A block can reflect uncertainty or incomplete checks; it does not by itself establish malicious behavior.", "");
  if (result.assessment) {
    const checks = result.assessment.checks;
    lines.push(`Checks: source ${checks.source}; vulnerabilities ${checks.vulnerabilities}; direct dependencies ${checks.directDependencies}.`,
      "A passing verdict means no blocking findings within these checks; it is not proof of harmlessness.", "");
  }

  if (result.sourceCoverage) {
    const c = result.sourceCoverage;
    lines.push(`Source coverage: ${c.complete ? "complete" : "incomplete"}; ${c.scannedFiles} files read, ${c.skippedFiles} skipped, ${c.truncatedFiles} truncated.`,
      `Behavioral scope: ${sanitizeForTerminal(c.behavioralScope || "unspecified")}.`, "");
  }

  if (result.promotedPath) {
    lines.push(`Promoted to: \`${sanitizeForTerminal(result.promotedPath)}\``, "");
  }

  lines.push(renderMarkdown(result.report));

  // Surface what config suppressed (mutes / allowlist force-to-safe). Never let
  // a loosening be invisible: these lines always accompany a changed verdict.
  const effectLines = cfg.renderConfigEffects(result.configEffects);
  if (effectLines.length > 0) {
    lines.push("", ...effectLines);
  }
  return lines.join("\n");
}

function renderTriageMarkdown(result, args, captured) {
  const lines = [
    `Triage mode: **auto-${args.auto}**`,
    `Lockfile: \`${sanitizeForTerminal(args.lockfilePath)}\``,
    `Decisions written to: \`${sanitizeForTerminal(result.lockPath)}\``,
    "",
    `Allowed: ${result.counts.allowed}  ·  Blocked: ${result.counts.blocked}  ·  Skipped: ${result.counts.skipped}`,
    `Total decisions on disk: ${result.decisions.length}`
  ];
  if (captured) {
    lines.push("", captured.trim());
  }
  return lines.join("\n");
}

// SECURITY: pull id out of a request even when the caller sent something
// that isn't an object — JSON-RPC says invalid-request id is `null`.
function requestId(request) {
  if (request && typeof request === "object" && !Array.isArray(request)) {
    return request.id != null ? request.id : null;
  }
  return null;
}

async function processLine(line, controller = new AbortController()) {
  if (!line.trim()) {
    return;
  }
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: `Parse error: ${error.message}` }
    });
    return;
  }

  // SECURITY: a bare JSON value (null, number, string, array) is valid
  // JSON but NOT a JSON-RPC request. Reject as -32600 instead of letting
  // `handleRequest` destructure it and crash the server.
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request: expected JSON-RPC object" }
    });
    return;
  }

  try {
    controller.signal.throwIfAborted();
    const response = await handleRequest(request, controller.signal);
    controller.signal.throwIfAborted();
    if (response) {
      send(response);
    }
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: requestId(request),
      error: { code: error.code === 'SCAN_OVERLOADED' ? -32001 : error.code === 'SCAN_TIMEOUT' ? -32002 : controller.signal.aborted || error.code === 'SCAN_CANCELLED' ? -32800 : -32603, message: sanitizeErrorMessage(error.message) }
    });
  }
}

// Wire up the stdin JSON-RPC loop. Kept behind a function (and only invoked
// when this file is the process entrypoint) so tests can `require` the module
// to exercise the pure config-folding helpers without the server attaching a
// stdin listener and hanging.
function attachStdin() {
  const { BoundedQueue } = require("../src/bounded-queue");
  const queue = new BoundedQueue({ concurrency: 128, maxTasks: 256, maxBytes: 16 * 1024 * 1024 });
  const controllers = new Map();
  const submit = line => {
    if (!line.trim()) return;
    let request;
    try { request = JSON.parse(line); } catch { /* processLine returns parse error */ }
    if (request?.method === 'notifications/cancelled') {
      controllers.get(request.params?.requestId)?.abort(); return;
    }
    const id = requestId(request || {});
    if (id !== null && controllers.has(id)) {
      send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Duplicate active request ID' } }); return;
    }
    const controller = new AbortController();
    if (id !== null) controllers.set(id, controller);
    const run = async () => {
      const timer = setTimeout(() => controller.abort(), 60000);
      try { await processLine(line, controller); }
      finally { clearTimeout(timer); if (id !== null) controllers.delete(id); }
    };
    if (!queue.enqueue(run, Buffer.byteLength(line))) {
      if (id !== null) controllers.delete(id);
      send({ jsonrpc: '2.0', id, error: { code: -32001, message: 'MCP request capacity exceeded; no action authorized; retry later' } });
    }
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    let start = 0;
    while (start < chunk.length && !queue.closed) {
      const newline = chunk.indexOf("\n", start);
      const part = chunk.slice(start, newline < 0 ? undefined : newline);
      if (!bufferOverflowed) {
        buffer += part;
        if (Buffer.byteLength(buffer) > MAX_BUFFER_BYTES) {
          bufferOverflowed = true; buffer = "";
          send({ jsonrpc: "2.0", id: null, error: { code: -32700,
            message: `Parse error: JSON-RPC frame exceeded ${MAX_BUFFER_BYTES} bytes without a newline` } });
        }
      }
      if (newline < 0) break;
      if (!bufferOverflowed) submit(buffer);
      buffer = ""; bufferOverflowed = false; start = newline + 1;
    }
  });
  process.stdin.on("end", () => {
    if (!bufferOverflowed) submit(buffer);
    buffer = "";
  });
}

if (require.main === module) {
  attachStdin();
}

// `startStdioServer` is the same entry the `pkgxray-mcp` bin runs on direct
// invocation; it is exported so `pkgxray mcp-server` (bin/audit.js) can launch
// this server in-process without a separate package. The rest are exported for
// tests only — the wire behavior is unchanged whether or not they are consumed;
// they let the offline suite unit-test the config seam.
module.exports = {
  publicGuardResult,
  publicCompositionResult,
  analyzeSuppliedEvidence,
  scanErrorResult,
  guardAdmission,
  applyConfigToGuardResult,
  toolExposed,
  listTools,
  CONFIG_TOOL_KEY,
  startStdioServer: attachStdin,
  attachStdin,
  resolveOperatorPath,
  validateToolCall,
  // Exported for direct unit testing. The end-to-end leak test can only
  // exercise whichever path shape the host platform produces, so a Windows
  // path leak was invisible to a Linux-only suite; testing the pure function
  // lets every platform assert every shape.
  sanitizeErrorMessage
};
