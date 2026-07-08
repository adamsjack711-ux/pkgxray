#!/usr/bin/env node
"use strict";

// Test fixture: a minimal stdio MCP server with scriptable failure modes.
// Mode is the first argv (env is scrubbed by the client under test, so argv
// is the only reliable channel):
//   default   — initialize + 2 tools
//   banner    — prints a non-JSON log line to stdout before speaking JSON-RPC
//   paginate  — tools/list answers in 2 pages via nextCursor
//   hang      — accepts initialize, never answers tools/list
//   exit-early— exits after initialize with a stderr message
//   huge      — answers tools/list with a single frame larger than the cap
//   env-echo  — tool description reports which env var names are visible

// `node --test` discovers every .js under test/ and would run this file as a
// "test", where its stdin listener hangs the whole suite. The runner marks its
// children with NODE_TEST_CONTEXT; the client under test scrubs the child env,
// so a real spawn never carries it.
if (process.env.NODE_TEST_CONTEXT) {
  process.exit(0);
}

const mode = process.argv[2] || "default";

// Optional PID file (argv[3]) — env is scrubbed, so a test that needs to prove
// the child was actually killed after a timeout passes the path via argv and
// then polls that this PID is dead.
if (process.argv[3]) {
  try {
    require("node:fs").writeFileSync(process.argv[3], String(process.pid));
  } catch {
    /* best-effort */
  }
}

const TOOLS = [
  {
    name: "get_weather",
    description: "Look up the current weather for a city.",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"]
    }
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file from the workspace.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"]
    }
  }
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

if (mode === "banner") {
  process.stdout.write("mcp-fixture starting up...\n");
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    handle(JSON.parse(line));
  }
});

function handle(message) {
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture-server", version: "1.2.3" }
      }
    });
    if (mode === "exit-early") {
      process.stderr.write("fixture: crashing on purpose\n");
      process.exit(7);
    }
    return;
  }

  if (message.method === "notifications/initialized") return;

  if (message.method === "tools/list") {
    if (mode === "hang") return;

    if (mode === "huge") {
      const blob = "x".repeat(5 * 1024 * 1024);
      send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "t", description: blob }] } });
      return;
    }

    if (mode === "env-echo") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            {
              name: "env_report",
              description: `visible env keys: ${Object.keys(process.env).sort().join(",")}`,
              inputSchema: { type: "object", properties: {} }
            }
          ]
        }
      });
      return;
    }

    if (mode === "env-path") {
      // Echo the literal PATH value the child received, so the client test can
      // assert it is the minimal fixed PATH, NOT the operator's inherited one.
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            {
              name: "path_report",
              description: `child PATH: ${process.env.PATH || "(unset)"}`,
              inputSchema: { type: "object", properties: {} }
            }
          ]
        }
      });
      return;
    }

    if (mode === "paginate") {
      const cursor = message.params && message.params.cursor;
      if (!cursor) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: { tools: [TOOLS[0]], nextCursor: "page-2" }
        });
      } else {
        send({ jsonrpc: "2.0", id: message.id, result: { tools: [TOOLS[1]] } });
      }
      return;
    }

    send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
    return;
  }

  if (message.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `method not found: ${message.method}` }
    });
  }
}
