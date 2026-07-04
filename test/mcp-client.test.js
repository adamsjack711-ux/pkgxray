"use strict";

// T1 — MCP client: stdio + streamable-HTTP enumeration against real
// transports (a fixture stdio server spawned as a child process, and an
// in-process HTTP server). No mocks of the code under test.

const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

const {
  enumerateMcpServer,
  parseSseMessages,
  scrubbedEnv
} = require("../src/mcp-client");

const FIXTURE = path.join(__dirname, "fixtures", "mcp-stdio-server.js");

function stdioTarget(mode) {
  return { command: process.execPath, args: [FIXTURE, ...(mode ? [mode] : [])] };
}

// ---------------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------------

test("stdio: enumerates the manifest via the read-only handshake", async () => {
  const manifest = await enumerateMcpServer(stdioTarget(), { timeoutMs: 10_000 });
  assert.equal(manifest.transport, "stdio");
  assert.equal(manifest.server.name, "fixture-server");
  assert.equal(manifest.server.version, "1.2.3");
  assert.equal(manifest.protocolVersion, "2025-06-18");
  assert.equal(manifest.tools.length, 2);
  assert.deepEqual(
    manifest.tools.map((t) => t.name).sort(),
    ["get_weather", "read_file"]
  );
  assert.equal(manifest.tools[0].inputSchema.type, "object");
});

test("stdio: tolerates a non-JSON banner line and records a warning", async () => {
  const manifest = await enumerateMcpServer(stdioTarget("banner"), { timeoutMs: 10_000 });
  assert.equal(manifest.tools.length, 2);
  assert.ok(
    manifest.diagnostics.warnings.some((w) => w.includes("non-JSON stdout line")),
    "expected a banner warning"
  );
});

test("stdio: follows nextCursor pagination to collect every page", async () => {
  const manifest = await enumerateMcpServer(stdioTarget("paginate"), { timeoutMs: 10_000 });
  assert.deepEqual(
    manifest.tools.map((t) => t.name).sort(),
    ["get_weather", "read_file"]
  );
});

test("stdio: a hung server hits the hard timeout and the child is killed", async () => {
  await assert.rejects(
    enumerateMcpServer(stdioTarget("hang"), { timeoutMs: 1_000 }),
    /timed out/
  );
});

test("stdio: early exit rejects with the stderr excerpt", async () => {
  await assert.rejects(
    enumerateMcpServer(stdioTarget("exit-early"), { timeoutMs: 10_000 }),
    /exited before enumeration.*crashing on purpose/s
  );
});

test("stdio: output past the cap fails enumeration instead of OOMing", async () => {
  await assert.rejects(
    enumerateMcpServer(stdioTarget("huge"), { timeoutMs: 10_000 }),
    /output cap/
  );
});

test("stdio: child env is scrubbed — secrets do not cross the spawn", async (t) => {
  process.env.PKGXRAY_TEST_SECRET_TOKEN = "hunter2";
  t.after(() => {
    delete process.env.PKGXRAY_TEST_SECRET_TOKEN;
  });
  const manifest = await enumerateMcpServer(stdioTarget("env-echo"), { timeoutMs: 10_000 });
  const report = manifest.tools[0].description;
  assert.ok(report.startsWith("visible env keys:"));
  assert.ok(!report.includes("PKGXRAY_TEST_SECRET_TOKEN"), "secret env var leaked to the child");
  assert.ok(report.includes("PATH"), "allowlisted PATH should survive");
});

test("stdio: extraEnv is an explicit opt-in channel", async () => {
  const manifest = await enumerateMcpServer(stdioTarget("env-echo"), {
    timeoutMs: 10_000,
    extraEnv: { PKGXRAY_FIXTURE_FLAG: "on" }
  });
  assert.ok(manifest.tools[0].description.includes("PKGXRAY_FIXTURE_FLAG"));
});

test("scrubbedEnv never carries common credential variables", () => {
  const env = scrubbedEnv();
  for (const key of Object.keys(env)) {
    assert.ok(
      !/TOKEN|SECRET|KEY|PASSWORD|AUTH/i.test(key),
      `credential-looking env var in scrubbed env: ${key}`
    );
  }
});

// ---------------------------------------------------------------------------
// streamable HTTP transport
// ---------------------------------------------------------------------------

function startHttpFixture(behavior) {
  const seen = { sessionHeaders: [], deletes: 0 };
  const server = http.createServer((request, response) => {
    if (request.method === "DELETE") {
      seen.deletes += 1;
      response.writeHead(200).end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const message = JSON.parse(body);
      seen.sessionHeaders.push(request.headers["mcp-session-id"] || null);
      behavior(message, response, seen);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        url: `http://127.0.0.1:${server.address().port}/mcp`,
        seen,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

function jsonReply(response, message, result, headers = {}) {
  response.writeHead(200, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
}

const HTTP_TOOLS = [
  { name: "search_docs", description: "Search the documentation.", inputSchema: { type: "object" } }
];

test("http: enumerates over JSON responses and threads the session id", async () => {
  const fixture = await startHttpFixture((message, response) => {
    if (message.method === "initialize") {
      jsonReply(
        response,
        message,
        {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "http-fixture", version: "2.0.0" }
        },
        { "mcp-session-id": "session-abc" }
      );
    } else if (message.method === "notifications/initialized") {
      response.writeHead(202).end();
    } else if (message.method === "tools/list") {
      jsonReply(response, message, { tools: HTTP_TOOLS });
    }
  });

  try {
    const manifest = await enumerateMcpServer({ url: fixture.url }, { timeoutMs: 10_000 });
    assert.equal(manifest.transport, "http");
    assert.equal(manifest.server.name, "http-fixture");
    assert.deepEqual(manifest.tools.map((t) => t.name), ["search_docs"]);
    // initialize has no session yet; every later request must carry it.
    assert.equal(fixture.seen.sessionHeaders[0], null);
    assert.ok(fixture.seen.sessionHeaders.slice(1).every((h) => h === "session-abc"));
    assert.equal(fixture.seen.deletes, 1, "session should be terminated after enumeration");
  } finally {
    await fixture.close();
  }
});

test("http: parses an SSE-framed response", async () => {
  const fixture = await startHttpFixture((message, response) => {
    if (message.method === "notifications/initialized") {
      response.writeHead(202).end();
      return;
    }
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            capabilities: {},
            serverInfo: { name: "sse-fixture", version: "1.0.0" }
          }
        : { tools: HTTP_TOOLS };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
  });

  try {
    const manifest = await enumerateMcpServer({ url: fixture.url }, { timeoutMs: 10_000 });
    assert.equal(manifest.server.name, "sse-fixture");
    assert.deepEqual(manifest.tools.map((t) => t.name), ["search_docs"]);
  } finally {
    await fixture.close();
  }
});

test("http: follows nextCursor pagination", async () => {
  const fixture = await startHttpFixture((message, response) => {
    if (message.method === "initialize") {
      jsonReply(response, message, {
        protocolVersion: "2025-06-18",
        capabilities: {},
        serverInfo: { name: "paged", version: "1.0.0" }
      });
    } else if (message.method === "notifications/initialized") {
      response.writeHead(202).end();
    } else if (message.method === "tools/list") {
      const cursor = message.params && message.params.cursor;
      if (!cursor) {
        jsonReply(response, message, { tools: [{ name: "a", description: "" }], nextCursor: "2" });
      } else {
        jsonReply(response, message, { tools: [{ name: "b", description: "" }] });
      }
    }
  });

  try {
    const manifest = await enumerateMcpServer({ url: fixture.url }, { timeoutMs: 10_000 });
    assert.deepEqual(manifest.tools.map((t) => t.name).sort(), ["a", "b"]);
  } finally {
    await fixture.close();
  }
});

test("http: an HTTP error status rejects the enumeration", async () => {
  const fixture = await startHttpFixture((message, response) => {
    response.writeHead(500, { "content-type": "text/plain" }).end("boom");
  });
  try {
    await assert.rejects(
      enumerateMcpServer({ url: fixture.url }, { timeoutMs: 10_000 }),
      /HTTP 500/
    );
  } finally {
    await fixture.close();
  }
});

test("http: non-http(s) URLs are refused", async () => {
  await assert.rejects(
    enumerateMcpServer({ url: "file:///etc/passwd" }, { timeoutMs: 1_000 }),
    /unsupported URL protocol/
  );
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

test("parseSseMessages extracts JSON payloads and skips noise", () => {
  const body = [
    "event: message",
    'data: {"jsonrpc":"2.0","id":1,"result":{}}',
    "",
    "data: not-json",
    "",
    ": keep-alive comment",
    ""
  ].join("\n");
  const messages = parseSseMessages(body);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 1);
});

test("enumerateMcpServer validates its target shape", async () => {
  await assert.rejects(enumerateMcpServer({}, {}), /requires \{ url \} or \{ command/);
});
