#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { auditEvidence, renderMarkdown } = require("../src/auditor");
const { guardExtension, decisionForReport } = require("../src/quarantine");
const { auditLockfile, renderLockfileMarkdown, sanitizeForTerminal } = require("../src/lockfile");
const { triageLockfile } = require("../src/triage");
const cfg = require("../src/config");

const AUDIT_TOOL_NAME = "audit_agent_extension_supply_chain";
const GUARD_TOOL_NAME = "guard_agent_extension_install";
const LOCKFILE_AUDIT_TOOL_NAME = "audit_lockfile_supply_chain";
const LOCKFILE_TRIAGE_TOOL_NAME = "triage_lockfile_supply_chain";

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
  [LOCKFILE_TRIAGE_TOOL_NAME]: "recheck"
});

const { config: CONFIG, warnings: CONFIG_WARNINGS } = cfg.loadConfig({ cwd: process.cwd() });
for (const w of CONFIG_WARNINGS) {
  process.stderr.write(`pkgxray: ${w}\n`);
}
const MCP_CONFIG = cfg.mcpConfig(CONFIG);

// Whether an MCP tool is exposed under the effective config.
function toolExposed(mcpToolName) {
  const key = CONFIG_TOOL_KEY[mcpToolName];
  if (!key) return true; // unmapped tools are never hidden by config
  return cfg.mcpToolAllowed(CONFIG, key);
}

// SECURITY: cap the inbound stdin buffer so a hostile caller can't OOM us
// by sending gigabytes of payload with no newline. 4 MiB is comfortably
// larger than any realistic JSON-RPC frame.
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
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
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function textContent(text) {
  return [{ type: "text", text }];
}

function auditToolDefinition() {
  return {
    name: AUDIT_TOOL_NAME,
    title: "Audit supplied package evidence",
    description:
      "Statically analyze caller-supplied package source and metadata. Returns a structured SAFE, REVIEW, or BLOCK report with cited findings; it does not read local files, install packages, or execute code. A SAFE result is defense in depth, not proof of harmlessness. For a live npm package, use guard_agent_extension_install.",
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
      "Fetch and stage one package reference (pin an exact version for reproducibility), then return a structured SAFE, REVIEW, or BLOCK report without running lifecycle scripts or package code. It performs network requests to npm, OSV, and optionally GitHub. promoteTo writes files only after policy allows; force may replace an existing destination. Local references and caller-supplied paths are confined to operator-approved roots.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
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
        promoteTo: {
          type: "string",
          description:
            "Optional destination under an operator-approved root. Files are copied only when policy allows; force can replace an existing destination."
        },
        policy: {
          type: "string",
          enum: ["safe-only", "allow-review"],
          default: "safe-only"
        },
        force: {
          type: "boolean",
          default: false
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
      "Read a dependency manifest under an operator-approved root and query OSV for each resolved dependency. Returns structured SAFE, REVIEW, or BLOCK decisions and honors a sibling .pkgxray.lock; it does not install dependencies or execute package code. deep/deepAll add npm and GitHub network scans.",
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
            "If true, every dep (including OSV-safe ones) enters the worklist. Default false — only block/review deps are decided."
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

function listTools() {
  // Only advertise tools the config permits. A config with
  // `mcp.tools: ["audit","recheck"]` drops guard from the listing entirely, so
  // an agent never even sees a tool it isn't allowed to invoke.
  return [
    auditToolDefinition(),
    guardToolDefinition(),
    lockfileAuditToolDefinition(),
    lockfileTriageToolDefinition()
  ].filter((t) => toolExposed(t.name));
}

const TOOL_NAMES = new Set([
  AUDIT_TOOL_NAME,
  GUARD_TOOL_NAME,
  LOCKFILE_AUDIT_TOOL_NAME,
  LOCKFILE_TRIAGE_TOOL_NAME
]);

// SECURITY: a reference is "local" when it lets the resolver walk the
// filesystem instead of fetching from a registry. Mirrors parseReference
// in src/quarantine.js. Blocked by default over MCP because an LLM-driven
// host could otherwise use guard as a remote-file-read primitive.
function isLocalReference(reference) {
  if (typeof reference !== "string") return false;
  if (reference.startsWith("file:")) return true;
  if (reference.startsWith("./") || reference.startsWith("../") || reference === "." || reference === "..") return true;
  if (reference.startsWith("/")) return true;
  if (reference.startsWith("~/") || reference === "~") return true;
  return false;
}

function localReferencePath(reference) {
  let value = reference.startsWith("file:") ? reference.slice(5) : reference;
  if (value === "~") value = HOME_DIR;
  else if (value.startsWith("~/")) value = path.join(HOME_DIR, value.slice(2));
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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
  if (toolName === GUARD_TOOL_NAME) {
    if (typeof args.reference !== "string" || args.reference.length === 0) {
      return "reference must be a non-empty string";
    }
    if (args.reference.includes("\0")) {
      return "reference must not contain a NUL byte";
    }
    if (args.allowLocalReferences !== undefined) {
      return "allowLocalReferences is not supported; only the server operator can grant filesystem roots";
    }
    if (isLocalReference(args.reference)) {
      const resolved = resolveOperatorPath(localReferencePath(args.reference));
      if (!resolved) {
        return "local reference is unreadable or outside the operator-approved filesystem roots";
      }
      args.reference = resolved;
    }
    for (const k of ["quarantineRoot", "promoteTo"]) {
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
    for (const k of ["sourceScan", "vulnerabilityCheck", "githubMetadata", "githubDiff", "force", "deep"]) {
      if (args[k] !== undefined && typeof args[k] !== "boolean") {
        return `${k} must be a boolean`;
      }
    }
    if (args.policy !== undefined && args.policy !== "safe-only" && args.policy !== "allow-review") {
      return "policy must be 'safe-only' or 'allow-review'";
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

function handleRequest(request) {
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
    if (!toolExposed(name)) {
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

    if (name === GUARD_TOOL_NAME) {
      // Stricter MCP defaults: when the caller doesn't pin a policy, fall back
      // to the (stricter) MCP-view policy rather than guard's own safe-only
      // default, so the agent surface can be tightened centrally in config.
      const guardOpts = { ...args, keepStaging: true };
      if (guardOpts.policy === undefined) guardOpts.policy = MCP_CONFIG.policy;
      // The opt-in typosquat heuristic is a config knob, not a tool argument —
      // .pkgxray.json is the single switch for the agent surface.
      guardOpts.typosquat = CONFIG.typosquat;
      // Set AFTER the spread on purpose: `args` is caller-controlled, and a
      // scan-error policy is the server operator's decision, not the calling
      // agent's. This also stops a caller from passing scanErrorPolicy:
      // "fail-open" to talk the server out of a scan-gap review.
      guardOpts.scanErrorPolicy = CONFIG.scanErrorPolicy;
      // packageScanFirst (default true): the agent surface insists on a static
      // package scan before it will vouch for anything. Only when config
      // explicitly disables it (and the caller didn't ask for a scan) do we let
      // guard stage without collecting source.
      if (guardOpts.sourceScan === undefined) guardOpts.sourceScan = MCP_CONFIG.packageScanFirst !== false;
      // Keep the staging tree so the returned Quarantine path stays valid for
      // inspection / promotion; non-interactive callers reap it by default.
      return guardExtension(args.reference, guardOpts).then((guardResult) => {
        // Apply shared config to the resolved artifact: mutes, and — since guard
        // resolved a real sha256 — a pinned allowlist that can force `safe`.
        // applyConfig never changes a verdict silently; renderConfigEffects
        // surfaces every suppression in the response text below.
        const adjusted = applyConfigToGuardResult(guardResult, guardOpts.policy);
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
      });
      // NOTE: guard rejections (bad reference, promote-collision, network) are
      // caller/usage errors, not scan errors, and fall through to the central
      // handler, which returns a sanitized -32603. verdictForScanError is
      // applied on the batch-scan surface (audit_lockfile) below, where an
      // errored scan genuinely warrants a fail-closed verdict.
    }

    if (name === LOCKFILE_AUDIT_TOOL_NAME) {
      const fileError = validateLockfileExists(args.lockfilePath);
      if (fileError) return invalidParams(id, fileError);
      // Thread the config's typosquat setting into the deep-scan path (the
      // shallow pass is OSV-only; typosquat applies wherever auditEvidence runs).
      return auditLockfile(args.lockfilePath, { ...args, typosquat: CONFIG.typosquat }).then((result) => {
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
        ...args,
        // Honor the config typosquat setting through triage's deep scan
        // (triageLockfile spreads options into auditLockfile → runDeep).
        typosquat: CONFIG.typosquat,
        stdout: fakeStdout,
        stderr: fakeStderr,
        isTTY: true // skip the !isTTY refusal — auto mode runs without input
      }).then((result) => {
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
    const report = auditEvidence(args, { typosquat: CONFIG.typosquat });
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

// A batch scan (audit_lockfile) that ERRORS or times out must not be reported
// as an opaque transport failure the agent might treat as "nothing to worry
// about". Route it through the config's scan-error policy (default fail-closed
// → "review") and hand the agent an explicit, sanitized verdict it can act on
// conservatively. (Guard's own rejections are caller/usage errors and keep the
// -32603 path.)
function scanErrorResult(id, toolName, error, outputFormat) {
  const verdict = cfg.verdictForScanError(CONFIG);
  const reason = sanitizeErrorMessage(error && error.message);
  const structured = {
    schemaVersion: 1,
    tool: toolName,
    scanError: true,
    verdict,
    scanErrorPolicy: CONFIG.scanErrorPolicy,
    message: reason
  };
  const text =
    outputFormat === "json"
      ? JSON.stringify(structured, null, 2)
      : `Scan error: verdict **${verdict.toUpperCase()}** (scanErrorPolicy=${CONFIG.scanErrorPolicy}). ${reason}`;
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
  const rederived = decisionForReport(adjustedReport, policy || "safe-only");
  const decision =
    adjustedReport.configEffects && adjustedReport.configEffects.allowlisted
      ? rederived
      : cfg.floorVerdictForScanGap(
          rederived,
          Boolean(result.vulnerabilityPrecheck && result.vulnerabilityPrecheck.error),
          CONFIG
        );
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

function renderGuardMarkdown(result) {
  const lines = [
    `Decision: **${result.decision.toUpperCase()}**`,
    `Reference: \`${sanitizeForTerminal(result.reference)}\``,
    `Quarantine: \`${sanitizeForTerminal(result.quarantinePath)}\``,
    ""
  ];

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

function processLine(line) {
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
    const response = handleRequest(request);
    if (response && typeof response.then === "function") {
      response.then(send).catch((error) => {
        send({
          jsonrpc: "2.0",
          id: requestId(request),
          error: { code: -32603, message: sanitizeErrorMessage(error.message) }
        });
      });
      return;
    }
    if (response) {
      send(response);
    }
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: requestId(request),
      error: { code: -32603, message: sanitizeErrorMessage(error.message) }
    });
  }
}

// Wire up the stdin JSON-RPC loop. Kept behind a function (and only invoked
// when this file is the process entrypoint) so tests can `require` the module
// to exercise the pure config-folding helpers without the server attaching a
// stdin listener and hanging.
function attachStdin() {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    // SECURITY: drop bytes once the buffer is past the cap, but keep reading
    // so the stream drains normally. Emit ONE parse-error reply per overflow
    // event and then reset on the next newline.
    if (bufferOverflowed) {
      const nl = chunk.indexOf("\n");
      if (nl === -1) return;
      buffer = "";
      bufferOverflowed = false;
      const tail = chunk.slice(nl + 1);
      if (tail.length === 0) return;
      chunk = tail;
    }
    buffer += chunk;
    if (buffer.length > MAX_BUFFER_BYTES) {
      bufferOverflowed = true;
      buffer = "";
      send({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: `Parse error: JSON-RPC frame exceeded ${MAX_BUFFER_BYTES} bytes without a newline`
        }
      });
      return;
    }
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      processLine(line);
      newlineIndex = buffer.indexOf("\n");
    }
  });

  process.stdin.on("end", () => {
    if (bufferOverflowed) {
      buffer = "";
      return;
    }
    if (buffer.trim()) {
      processLine(buffer);
    }
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
  applyConfigToGuardResult,
  toolExposed,
  listTools,
  CONFIG_TOOL_KEY,
  startStdioServer: attachStdin,
  attachStdin,
  resolveOperatorPath,
  // Exported for direct unit testing. The end-to-end leak test can only
  // exercise whichever path shape the host platform produces, so a Windows
  // path leak was invisible to a Linux-only suite; testing the pure function
  // lets every platform assert every shape.
  sanitizeErrorMessage
};
