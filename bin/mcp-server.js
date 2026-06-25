#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { auditEvidence, renderMarkdown } = require("../src/auditor");
const { guardExtension } = require("../src/quarantine");
const { auditLockfile, renderLockfileMarkdown, sanitizeForTerminal } = require("../src/lockfile");

const AUDIT_TOOL_NAME = "audit_agent_extension_supply_chain";
const GUARD_TOOL_NAME = "guard_agent_extension_install";
const LOCKFILE_AUDIT_TOOL_NAME = "audit_lockfile_supply_chain";

const SERVER_VERSION = "0.12.0";

let buffer = "";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function textContent(text) {
  return [{ type: "text", text }];
}

function auditToolDefinition() {
  return {
    name: AUDIT_TOOL_NAME,
    description:
      "Audit evidence for an AI coding-agent extension, Codex plugin, Claude Code extension, or MCP server and return a conservative supply-chain security verdict. Pure static analysis — accepts caller-supplied npm metadata, GitHub metadata, source files, vulnerability list, and optional npm provenance attestation. Use when you already have evidence in hand; for live npm packages prefer guard_agent_extension_install.",
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
    description:
      "Stage an agent extension or npm package in a local quarantine directory, audit it without installing or running it, and optionally promote it if policy allows. Performs OSV vuln pre-check, downloads the tarball, runs static heuristics, cross-checks GitHub metadata, and automatically pulls the npm provenance attestation. Use this for a single live package; for a whole project use audit_lockfile_supply_chain.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        reference: {
          type: "string",
          description:
            "Extension reference: npm package, npm:name@version, file:path, or local directory path."
        },
        quarantineRoot: {
          type: "string",
          description: "Optional quarantine root. Defaults to the OS temp directory."
        },
        promoteTo: {
          type: "string",
          description:
            "Optional destination directory. The staged package is copied here only when policy allows."
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
    description:
      "Batch-scan every dependency in a package-lock.json, yarn.lock, pnpm-lock.yaml, or package.json against OSV. Returns one decision (safe / review / block) per unique name@version. Pre-existing .pkgxray.lock triage decisions next to the lockfile are honored. Use this to audit a project's full dependency tree in one shot.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        lockfilePath: {
          type: "string",
          description:
            "Absolute or relative path to a package-lock.json, npm-shrinkwrap.json, yarn.lock, pnpm-lock.yaml, or package.json. Must exist."
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

function listTools() {
  return [
    auditToolDefinition(),
    guardToolDefinition(),
    lockfileAuditToolDefinition()
  ];
}

const TOOL_NAMES = new Set([
  AUDIT_TOOL_NAME,
  GUARD_TOOL_NAME,
  LOCKFILE_AUDIT_TOOL_NAME
]);

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

    const args = (params && params.arguments) || {};

    if (name === GUARD_TOOL_NAME) {
      if (typeof args.reference !== "string" || args.reference.length === 0) {
        return invalidParams(id, "reference must be a non-empty string");
      }
      return guardExtension(args.reference, args).then((guardResult) => {
        const text =
          args.outputFormat === "json"
            ? JSON.stringify(guardResult, null, 2)
            : renderGuardMarkdown(guardResult);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: textContent(text),
            structuredContent: guardResult
          }
        };
      });
    }

    if (name === LOCKFILE_AUDIT_TOOL_NAME) {
      const validationError = validateLockfilePath(args.lockfilePath);
      if (validationError) return invalidParams(id, validationError);
      return auditLockfile(args.lockfilePath, args).then((result) => {
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
      });
    }

    // audit_agent_extension_supply_chain
    const report = auditEvidence(args);
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

function validateLockfilePath(lockfilePath) {
  if (typeof lockfilePath !== "string" || lockfilePath.length === 0) {
    return "lockfilePath must be a non-empty string";
  }
  try {
    const stat = fs.statSync(lockfilePath);
    if (!stat.isFile()) {
      return `lockfilePath is not a regular file: ${lockfilePath}`;
    }
  } catch (error) {
    return `lockfilePath does not exist or is not readable: ${lockfilePath}`;
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
  return lines.join("\n");
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

  try {
    const response = handleRequest(request);
    if (response && typeof response.then === "function") {
      response.then(send).catch((error) => {
        send({
          jsonrpc: "2.0",
          id: request.id || null,
          error: { code: -32603, message: error.message }
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
      id: request.id || null,
      error: { code: -32603, message: error.message }
    });
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex = buffer.indexOf("\n");
  while (newlineIndex !== -1) {
    const line = buffer.slice(0, newlineIndex);
    buffer = buffer.slice(newlineIndex + 1);
    processLine(line);
    newlineIndex = buffer.indexOf("\n");
  }
});

process.stdin.on("end", () => {
  if (buffer.trim()) {
    processLine(buffer);
  }
});
