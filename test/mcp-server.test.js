"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawn } = require("node:child_process");

const SERVER_PATH = path.join(__dirname, "..", "bin", "mcp-server.js");

// ---------------------------------------------------------------------------
// Tiny JSON-RPC over stdio client. We spawn the MCP server, feed it newline-
// delimited JSON, and collect responses line by line. The server uses
// `process.stdin` so killing it after the last response is the cleanest way
// to wind down.
// ---------------------------------------------------------------------------

function startServer() {
  const child = spawn(process.execPath, [SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  const responses = [];
  let stdoutBuf = "";
  let stderrBuf = "";

  const waitingFor = new Map(); // id -> resolver

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      responses.push(parsed);
      if (parsed.id !== undefined && waitingFor.has(parsed.id)) {
        const resolve = waitingFor.get(parsed.id);
        waitingFor.delete(parsed.id);
        resolve(parsed);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderrBuf += chunk; });

  function send(request) {
    child.stdin.write(`${JSON.stringify(request)}\n`);
  }

  function call(method, params, id) {
    const useId = id !== undefined ? id : Math.floor(Math.random() * 1e9);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waitingFor.delete(useId);
        reject(new Error(`MCP call timeout: ${method} (stderr: ${stderrBuf})`));
      }, 15000);
      waitingFor.set(useId, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      send({ jsonrpc: "2.0", id: useId, method, params });
    });
  }

  function stop() {
    return new Promise((resolve) => {
      child.once("exit", () => resolve({ stderr: stderrBuf, responses }));
      try { child.stdin.end(); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 200);
    });
  }

  return { call, send, stop, child };
}

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "pkgxray-mcp-"));
}

async function writeLockfile(dir, names) {
  const packages = { "": { name: "demo", version: "1.0.0" } };
  for (const { name, version } of names) {
    packages[`node_modules/${name}`] = { version };
  }
  const lockfilePath = path.join(dir, "package-lock.json");
  await fs.writeFile(lockfilePath, JSON.stringify({
    name: "demo",
    lockfileVersion: 3,
    packages
  }));
  return lockfilePath;
}

// ---------------------------------------------------------------------------
// initialize handshake bumps to 0.12.0
// ---------------------------------------------------------------------------

test("MCP initialize reports server version 0.12.0", async () => {
  const server = startServer();
  try {
    const res = await server.call("initialize", { protocolVersion: "2024-11-05" });
    assert.equal(res.result.serverInfo.name, "pkgxray");
    assert.equal(res.result.serverInfo.version, "0.12.0");
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// tools/list returns the lockfile audit tool with the correct schema
// ---------------------------------------------------------------------------

test("MCP tools/list exposes all 4 tools", async () => {
  const server = startServer();
  try {
    await server.call("initialize", { protocolVersion: "2024-11-05" });
    const res = await server.call("tools/list", {});
    const tools = res.result.tools;
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "audit_agent_extension_supply_chain",
      "audit_lockfile_supply_chain",
      "guard_agent_extension_install",
      "triage_lockfile_supply_chain"
    ]);

    for (const t of tools) {
      assert.equal(typeof t.description, "string");
      assert.ok(t.description.length > 0, `${t.name} has empty description`);
      assert.equal(t.inputSchema.type, "object");
      assert.ok(Array.isArray(t.inputSchema.required), `${t.name} missing required[]`);
    }

    const lockTool = tools.find((t) => t.name === "audit_lockfile_supply_chain");
    assert.deepEqual(lockTool.inputSchema.required, ["lockfilePath"]);
    assert.ok(lockTool.inputSchema.properties.deep);
    assert.ok(lockTool.inputSchema.properties.deepAll);

    // audit tool now exposes provenanceAttestation in its schema.
    const auditTool = tools.find((t) => t.name === "audit_agent_extension_supply_chain");
    assert.ok(
      auditTool.inputSchema.properties.provenanceAttestation,
      "provenanceAttestation must appear in audit tool schema"
    );

    // guard tool exposes deep.
    const guardTool = tools.find((t) => t.name === "guard_agent_extension_install");
    assert.ok(
      guardTool.inputSchema.properties.deep,
      "deep must appear in guard tool schema"
    );

    // triage tool requires both lockfilePath and auto with strict enum.
    const triageTool = tools.find((t) => t.name === "triage_lockfile_supply_chain");
    assert.deepEqual(triageTool.inputSchema.required.sort(), ["auto", "lockfilePath"]);
    assert.deepEqual(triageTool.inputSchema.properties.auto.enum, ["allow", "block"]);
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// audit_lockfile_supply_chain runs against a real lockfile
// ---------------------------------------------------------------------------

test("MCP audit_lockfile_supply_chain returns a structured result", async () => {
  const dir = await tmpDir();
  const lockfilePath = await writeLockfile(dir, [
    { name: "lodash", version: "4.17.21" },
    { name: "react", version: "19.0.0" }
  ]);

  const server = startServer();
  try {
    await server.call("initialize", { protocolVersion: "2024-11-05" });
    const res = await server.call("tools/call", {
      name: "audit_lockfile_supply_chain",
      arguments: {
        lockfilePath,
        outputFormat: "json",
        vulnerabilityCheck: false // keep the test offline
      }
    });

    assert.ok(res.result, `expected result, got ${JSON.stringify(res)}`);
    const structured = res.result.structuredContent;
    assert.equal(structured.schemaVersion, 1);
    assert.equal(structured.totalDeps, 2);
    assert.equal(structured.format, "npm");
    assert.ok(Array.isArray(structured.results));
    assert.ok(Array.isArray(res.result.content));
    assert.equal(res.result.content[0].type, "text");
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// Bad input produces a clean JSON-RPC error (not a crash)
// ---------------------------------------------------------------------------

test("MCP returns invalid-params error for missing lockfilePath", async () => {
  const server = startServer();
  try {
    await server.call("initialize", { protocolVersion: "2024-11-05" });
    const res = await server.call("tools/call", {
      name: "audit_lockfile_supply_chain",
      arguments: { outputFormat: "json" }
    });
    assert.ok(res.error, `expected error, got ${JSON.stringify(res)}`);
    assert.equal(res.error.code, -32602);
    assert.match(res.error.message, /lockfilePath/);
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// triage_lockfile_supply_chain auto:"block" writes a .pkgxray.lock
// ---------------------------------------------------------------------------

test("MCP triage_lockfile_supply_chain writes .pkgxray.lock with auto:\"block\"", async () => {
  const dir = await tmpDir();
  const lockfilePath = await writeLockfile(dir, [
    { name: "lodash", version: "4.17.21" },
    { name: "react", version: "19.0.0" }
  ]);

  const server = startServer();
  try {
    await server.call("initialize", { protocolVersion: "2024-11-05" });
    const res = await server.call("tools/call", {
      name: "triage_lockfile_supply_chain",
      arguments: {
        lockfilePath,
        auto: "block",
        includeSafe: true, // every dep enters the worklist when OSV is off
        outputFormat: "json",
        vulnerabilityCheck: false
      }
    });

    assert.ok(res.result, `expected result, got ${JSON.stringify(res)}`);
    const structured = res.result.structuredContent;
    assert.equal(structured.counts.blocked, 2);
    assert.equal(structured.counts.allowed, 0);

    const saved = JSON.parse(await fs.readFile(path.join(dir, ".pkgxray.lock"), "utf8"));
    assert.equal(saved.schemaVersion, 1);
    assert.equal(saved.decisions.length, 2);
    assert.ok(saved.decisions.every((d) => d.decision === "block"));
  } finally {
    await server.stop();
  }
});

test("MCP returns invalid-params error for triage without auto", async () => {
  const dir = await tmpDir();
  const lockfilePath = await writeLockfile(dir, [{ name: "lodash", version: "4.17.21" }]);

  const server = startServer();
  try {
    await server.call("initialize", { protocolVersion: "2024-11-05" });
    const res = await server.call("tools/call", {
      name: "triage_lockfile_supply_chain",
      arguments: { lockfilePath, outputFormat: "json" }
    });
    assert.ok(res.error, `expected error, got ${JSON.stringify(res)}`);
    assert.equal(res.error.code, -32602);
    assert.match(res.error.message, /auto/);
  } finally {
    await server.stop();
  }
});

test("MCP returns invalid-params error for nonexistent lockfile", async () => {
  const server = startServer();
  try {
    await server.call("initialize", { protocolVersion: "2024-11-05" });
    const res = await server.call("tools/call", {
      name: "audit_lockfile_supply_chain",
      arguments: { lockfilePath: "/does/not/exist/package-lock.json", outputFormat: "json" }
    });
    assert.ok(res.error, `expected error, got ${JSON.stringify(res)}`);
    assert.equal(res.error.code, -32602);
  } finally {
    await server.stop();
  }
});

test("MCP returns method-not-found error for unknown tool", async () => {
  const server = startServer();
  try {
    await server.call("initialize", { protocolVersion: "2024-11-05" });
    const res = await server.call("tools/call", {
      name: "no_such_tool",
      arguments: {}
    });
    assert.ok(res.error, `expected error, got ${JSON.stringify(res)}`);
    assert.equal(res.error.code, -32602);
    assert.match(res.error.message, /Unknown tool/);
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// Provenance attestation passes through audit_agent_extension_supply_chain
// ---------------------------------------------------------------------------

test("MCP audit_agent_extension_supply_chain accepts provenanceAttestation", async () => {
  const server = startServer();
  try {
    await server.call("initialize", { protocolVersion: "2024-11-05" });
    const res = await server.call("tools/call", {
      name: "audit_agent_extension_supply_chain",
      arguments: {
        sourceFiles: {
          "package.json": JSON.stringify({ name: "demo", version: "1.0.0" })
        },
        provenanceAttestation: { attested: false }, // shape is permissive; no findings emitted
        outputFormat: "json"
      }
    });
    assert.ok(res.result, `expected result, got ${JSON.stringify(res)}`);
    assert.equal(res.result.structuredContent.schemaVersion, 1);
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// Malformed JSON-RPC input doesn't crash the server
// ---------------------------------------------------------------------------

test("MCP parses malformed input as -32700 without crashing", async () => {
  const server = startServer();
  try {
    // Send garbage; server should respond with a parse-error and stay alive.
    server.child.stdin.write("this is not json\n");
    // After the garbage, send a real initialize to confirm the server is still up.
    const initRes = await server.call("initialize", { protocolVersion: "2024-11-05" });
    assert.equal(initRes.result.serverInfo.name, "pkgxray");
    const { responses } = await server.stop();
    const parseError = responses.find((r) => r.error && r.error.code === -32700);
    assert.ok(parseError, "expected a -32700 parse error in responses");
  } finally {
    // stop() may already have been called above; double-stop is safe (the
    // child has exited and stop() returns immediately).
  }
});
