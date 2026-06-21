#!/usr/bin/env node
"use strict";

const { auditEvidence, renderMarkdown } = require("../src/auditor");
const { guardExtension } = require("../src/quarantine");

const TOOL_NAME = "audit_agent_extension_supply_chain";
const GUARD_TOOL_NAME = "guard_agent_extension_install";
let buffer = "";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function textContent(text) {
  return [{ type: "text", text }];
}

function toolDefinition() {
  return {
    name: TOOL_NAME,
    description:
      "Audit evidence for an AI coding-agent extension, Codex plugin, Claude Code extension, or MCP server and return a conservative supply-chain security verdict.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        packageName: { type: "string" },
        npmMetadata: {},
        githubMetadata: {},
        webPresence: {},
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
      "Stage an agent extension in a local quarantine directory, audit it without installing or running it, and optionally promote it if policy allows.",
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
          version: "0.1.0"
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
        tools: [toolDefinition(), guardToolDefinition()]
      }
    };
  }

  if (method === "tools/call") {
    const name = params && params.name;
    if (name !== TOOL_NAME && name !== GUARD_TOOL_NAME) {
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

function renderGuardMarkdown(result) {
  const lines = [
    `Decision: **${result.decision.toUpperCase()}**`,
    `Reference: \`${result.reference}\``,
    `Quarantine: \`${result.quarantinePath}\``,
    ""
  ];

  if (result.promotedPath) {
    lines.push(`Promoted to: \`${result.promotedPath}\``, "");
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
