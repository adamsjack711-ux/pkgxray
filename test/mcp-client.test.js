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
  scrubbedEnv,
  isBlockedIp,
  MINIMAL_PATH
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

// FIX 2 — the timeout→kill path must actually reap the child. The old code
// unref'd the SIGKILL timer, so the process could exit after SIGTERM but before
// SIGKILL landed, leaking the child. Here we prove the child is dead once
// enumeration rejects on timeout.
test("stdio: timeout kills the child — it is not left alive", async () => {
  const os = require("node:os");
  const fs = require("node:fs");
  const pidFile = path.join(os.tmpdir(), `pkgxray-pid-${process.pid}-${Date.now()}`);
  const target = { command: process.execPath, args: [FIXTURE, "hang", pidFile] };

  await assert.rejects(enumerateMcpServer(target, { timeoutMs: 800 }), /timed out/);

  // The fixture wrote its PID before hanging. After the timeout resolves, the
  // client must have SIGTERM/SIGKILL'd it. Poll briefly for the process to die.
  const pid = parseInt(fs.readFileSync(pidFile, "utf8"), 10);
  fs.rmSync(pidFile, { force: true });
  assert.ok(Number.isInteger(pid) && pid > 0, "fixture did not record its pid");

  let alive = true;
  for (let i = 0; i < 40; i += 1) {
    try {
      process.kill(pid, 0); // signal 0 = liveness probe, does not kill
    } catch {
      alive = false;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(alive, false, "child survived the enumeration timeout — kill did not land");
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

// FIX 1 — PATH hijack: the child must NOT inherit the operator's PATH (a
// package-writable dir on it would let the untrusted command pick its binary).
test("scrubbedEnv sets a fixed minimal PATH, never the operator's", () => {
  const marker = "/tmp/pkgxray-evil-path-marker-xyz";
  const savedPath = process.env.PATH;
  process.env.PATH = `${marker}:${savedPath}`;
  try {
    const env = scrubbedEnv();
    assert.equal(env.PATH, MINIMAL_PATH, "child PATH should be the fixed minimal PATH");
    assert.ok(!env.PATH.includes(marker), "operator PATH entry leaked to the child");
  } finally {
    process.env.PATH = savedPath;
  }
});

test("stdio: the child sees the minimal PATH, not the operator's", async () => {
  const marker = "/tmp/pkgxray-evil-path-marker-abc";
  const savedPath = process.env.PATH;
  process.env.PATH = `${marker}:${savedPath}`;
  try {
    const manifest = await enumerateMcpServer(stdioTarget("env-path"), { timeoutMs: 10_000 });
    const desc = manifest.tools[0].description;
    assert.ok(desc.startsWith("child PATH:"));
    assert.ok(!desc.includes(marker), "operator PATH leaked into the spawned child");
    assert.ok(desc.includes(MINIMAL_PATH), "child did not receive the fixed minimal PATH");
  } finally {
    process.env.PATH = savedPath;
  }
});

// FIX 1 — extraEnv denylist: a caller must not be able to reintroduce PATH,
// LD_PRELOAD, or NODE_OPTIONS through the opt-in channel and undo the scrub.
test("scrubbedEnv denylist blocks PATH/LD_PRELOAD/NODE_OPTIONS via extraEnv", () => {
  const env = scrubbedEnv({
    PATH: "/attacker/bin",
    LD_PRELOAD: "/tmp/evil.so",
    NODE_OPTIONS: "--require /tmp/evil.js",
    HARMLESS_CONFIG: "ok"
  });
  assert.equal(env.PATH, MINIMAL_PATH, "extraEnv must not override the fixed PATH");
  assert.ok(!("LD_PRELOAD" in env), "LD_PRELOAD must be denylisted");
  assert.ok(!("NODE_OPTIONS" in env), "NODE_OPTIONS must be denylisted");
  assert.equal(env.HARMLESS_CONFIG, "ok", "a harmless extraEnv var should still pass");
});

// ---------------------------------------------------------------------------
// streamable HTTP transport
// ---------------------------------------------------------------------------

function startHttpFixture(behavior) {
  // The fixtures bind to loopback (127.0.0.1) over plain http — exactly what
  // the SSRF guard refuses by default. These are trusted in-process servers,
  // so opt in for the HTTP-transport tests. The SSRF guard itself is covered
  // by its own dedicated tests below.
  process.env.PKGXRAY_MCP_ALLOW_PRIVATE = "1";
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
        // close() also clears the opt-in so it never leaks into the SSRF tests,
        // which must run with the guard fully armed.
        close: () =>
          new Promise((done) => {
            delete process.env.PKGXRAY_MCP_ALLOW_PRIVATE;
            server.close(done);
          })
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
// FIX 3 — SSRF guard
// ---------------------------------------------------------------------------

test("isBlockedIp flags loopback, private, link-local, metadata, and IPv6 ranges", () => {
  // Must block:
  for (const ip of [
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.1",
    "169.254.169.254", // the cloud-metadata IP
    "169.254.0.1",
    "100.64.0.1", // CGNAT
    "0.0.0.0",
    "::1",
    "fe80::1", // link-local
    "fc00::1", // ULA
    "fd12:3456::1", // ULA
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:169.254.169.254"
  ]) {
    assert.equal(isBlockedIp(ip), true, `${ip} should be blocked`);
  }
  // Must allow (public):
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) {
    assert.equal(isBlockedIp(ip), false, `${ip} should be allowed`);
  }
});

// These must run with the guard fully armed — defensively clear the opt-in.
function armSsrfGuard() {
  delete process.env.PKGXRAY_MCP_ALLOW_PRIVATE;
}

test("http: the cloud-metadata IP is refused (SSRF)", async () => {
  armSsrfGuard();
  await assert.rejects(
    enumerateMcpServer({ url: "http://169.254.169.254/latest/meta-data/" }, { timeoutMs: 1_000 }),
    /private\/loopback\/link-local|plain http/
  );
});

test("http: a private-range IP is refused (SSRF)", async () => {
  armSsrfGuard();
  await assert.rejects(
    enumerateMcpServer({ url: "https://10.0.0.5/mcp" }, { timeoutMs: 1_000 }),
    /private\/loopback\/link-local/
  );
});

test("http: plain http:// to a non-loopback host is refused without opt-in", async () => {
  armSsrfGuard();
  await assert.rejects(
    enumerateMcpServer({ url: "http://example.com/mcp" }, { timeoutMs: 1_000 }),
    /plain http/
  );
});

test("http: localhost is refused as a loopback host", async () => {
  armSsrfGuard();
  await assert.rejects(
    enumerateMcpServer({ url: "https://localhost/mcp" }, { timeoutMs: 1_000 }),
    /loopback host/
  );
});

test("http: a normal https URL passes the SSRF guard and is attempted", async () => {
  armSsrfGuard();
  // We don't need a live server — only proof the SSRF guard does NOT reject a
  // public https host. It should fail LATER (DNS/connect/transport), never with
  // an ssrf-phase rejection. Use a reserved-for-docs domain that resolves but
  // won't answer MCP.
  await enumerateMcpServer({ url: "https://example.com/mcp" }, { timeoutMs: 1_500 }).then(
    () => {
      throw new Error("expected the fixture-less request to fail at the transport layer");
    },
    (err) => {
      assert.ok(
        !/private\/loopback\/link-local|plain http|loopback host/.test(err.message),
        `SSRF guard wrongly rejected a public https host: ${err.message}`
      );
    }
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
