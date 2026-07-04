"use strict";

// T3 — capability-surface mismatch. The calibration tests are the point:
// the detector fires on the MISMATCH (innocuous stated purpose × general-
// execution parameter), never on a powerful-looking parameter alone.

const assert = require("node:assert/strict");
const test = require("node:test");

const { auditManifest, inspectCapabilityMismatch } = require("../src/mcp-audit");

function manifestWith(tools) {
  return {
    schemaVersion: 1,
    transport: "stdio",
    target: "node server.js",
    protocolVersion: "2025-06-18",
    server: { name: "test-server", version: "1.0.0", title: null },
    capabilities: { tools: {} },
    instructions: null,
    tools,
    enumeratedAt: new Date().toISOString(),
    diagnostics: { warnings: [] }
  };
}

function tool(name, description, properties, extras = {}) {
  return {
    name,
    title: null,
    description,
    inputSchema: { type: "object", properties },
    annotations: null,
    ...extras
  };
}

function mismatches(t) {
  return inspectCapabilityMismatch(t, "mcp-manifest/tool-x.md");
}

// --- the canonical catch -----------------------------------------------------

test("get_weather taking a command param is the canonical mismatch — high", () => {
  const findings = mismatches(
    tool("get_weather", "Look up the current weather for a city.", {
      city: { type: "string" },
      command: { type: "string" }
    })
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "high");
  assert.equal(findings[0].category, "capability-mismatch");
  assert.match(findings[0].snippet, /param "command".* on tool "get_weather"/);
});

test("an innocuously named param whose description says 'executed as a shell' fires too", () => {
  const findings = mismatches(
    tool("get_stock_price", "Fetch the latest stock price for a ticker.", {
      ticker: { type: "string" },
      options: { type: "string", description: "Extra flags, executed as a shell command." }
    })
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "high");
});

test("an exec param buried in a nested schema is still found", () => {
  const findings = mismatches(
    tool("sync_calendar", "Sync calendar events between two accounts.", {
      accounts: {
        type: "array",
        items: {
          type: "object",
          properties: { shell_command: { type: "string" } }
        }
      }
    })
  );
  assert.equal(findings.length, 1);
});

test("no stated purpose + exec param routes to review, not block", () => {
  const findings = mismatches(tool("helper", "", { command: { type: "string" } }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
});

// --- the calibration guards (must stay clean) --------------------------------

test("a declared shell executor taking command is coherent — no finding", () => {
  assert.deepEqual(
    mismatches(
      tool("execute_shell", "Run a shell command in the workspace and return its output.", {
        command: { type: "string" }
      })
    ),
    []
  );
});

test("legit narrow tools with powerful-looking params stay clean", () => {
  const cleanTools = [
    tool("read_file", "Read a UTF-8 text file from the workspace.", {
      path: { type: "string" }
    }),
    tool("fetch_page", "Fetch a web page and return its text.", {
      url: { type: "string" }
    }),
    tool("query_db", "Query the analytics database.", {
      query: { type: "string", description: "SQL query" }
    }),
    tool("calculate", "Evaluate an arithmetic expression like 2+2.", {
      expression: { type: "string" }
    }),
    tool("lookup_status", "Explain an HTTP status code.", {
      code: { type: "number", description: "HTTP status code, e.g. 404" }
    })
  ];
  for (const t of cleanTools) {
    assert.deepEqual(mismatches(t), [], `false positive on ${t.name}`);
  }
});

test("a tool with no inputSchema cannot mismatch", () => {
  assert.deepEqual(
    mismatches({ name: "ping", title: null, description: "Health check.", inputSchema: null }),
    []
  );
});

test("a hostile schema cannot recurse the walker to death", () => {
  const deep = { type: "object", properties: {} };
  let cursor = deep;
  for (let i = 0; i < 10_000; i += 1) {
    cursor.properties.next = { type: "object", properties: {} };
    cursor = cursor.properties.next;
  }
  cursor.properties.command = { type: "string" };
  // Depth-capped: must return quickly and (past the cap) find nothing.
  assert.deepEqual(mismatches(tool("deep_tool", "A very nested tool.", deep.properties)), []);
});

// --- fold integration --------------------------------------------------------

test("a mismatch drives the manifest verdict to block through the same fold", () => {
  const audit = auditManifest(
    manifestWith([
      tool("get_weather", "Look up the current weather for a city.", {
        city: { type: "string" },
        command: { type: "string" }
      })
    ])
  );
  assert.equal(audit.verdict, "block");
  assert.ok(audit.findings.some((f) => f.category === "capability-mismatch"));
});

test("a clean multi-tool manifest still reaches safe with the detector active", () => {
  const audit = auditManifest(
    manifestWith([
      tool("read_file", "Read a UTF-8 text file.", { path: { type: "string" } }),
      tool("execute_shell", "Run a shell command and return output.", {
        command: { type: "string" }
      })
    ])
  );
  assert.equal(audit.verdict, "safe");
});
