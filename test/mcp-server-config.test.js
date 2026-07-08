"use strict";

// ---------------------------------------------------------------------------
// Tests for the shared-config (.pkgxray.json) wiring in bin/mcp-server.js.
//
// Two seams are exercised:
//   1. Tool EXPOSURE — a spawned server whose cwd contains a .pkgxray.json with
//      `mcp.tools` must list (and honor) only the permitted tools. This drives
//      the real JSON-RPC wire path, fully offline.
//   2. Config APPLICATION — a pinned allowlist entry whose sha256 matches the
//      resolved artifact forces the guard verdict to `safe` AND surfaces an
//      allowlist notice in the response text. We require the server module and
//      call its pure `applyConfigToGuardResult` helper against a synthetic
//      guard result, so the assertion is deterministic and needs no network.
// ---------------------------------------------------------------------------

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawn } = require("node:child_process");

const SERVER_PATH = path.join(__dirname, "..", "bin", "mcp-server.js");

// Minimal JSON-RPC-over-stdio client, spawned with a controllable cwd so the
// server picks up the temp .pkgxray.json we planted (config find-up walks from
// process.cwd()).
function startServer(cwd) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd
  });
  let stdoutBuf = "";
  let stderrBuf = "";
  const waitingFor = new Map();

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
      if (parsed.id !== undefined && waitingFor.has(parsed.id)) {
        const resolve = waitingFor.get(parsed.id);
        waitingFor.delete(parsed.id);
        resolve(parsed);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderrBuf += chunk; });

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
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: useId, method, params })}\n`);
    });
  }

  function stop() {
    return new Promise((resolve) => {
      child.once("exit", () => resolve({ stderr: stderrBuf }));
      try { child.stdin.end(); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 200);
    });
  }

  return { call, stop, child };
}

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "pkgxray-mcp-cfg-"));
}

async function writeConfig(dir, config) {
  await fs.writeFile(path.join(dir, ".pkgxray.json"), JSON.stringify(config));
}

// ---------------------------------------------------------------------------
// 1. mcp.tools restricts which tools the server advertises AND will run.
//    Config short names map: guard<->guard_agent_extension_install,
//    audit<->audit_* , recheck<->triage_lockfile_supply_chain.
// ---------------------------------------------------------------------------

test("mcp.tools restricts tools/list to the permitted tools (guard dropped)", async () => {
  const dir = await tmpDir();
  await writeConfig(dir, { mcp: { tools: ["audit", "recheck"] } });

  const server = startServer(dir);
  try {
    await server.call("initialize", { protocolVersion: "2024-11-05" });
    const res = await server.call("tools/list", {});
    const names = res.result.tools.map((t) => t.name).sort();

    // guard is NOT permitted -> must not appear.
    assert.ok(
      !names.includes("guard_agent_extension_install"),
      `guard should be filtered out, got: ${names.join(", ")}`
    );
    // audit maps to both audit tools; recheck maps to triage.
    assert.deepEqual(names, [
      "audit_agent_extension_supply_chain",
      "audit_lockfile_supply_chain",
      "triage_lockfile_supply_chain"
    ]);
  } finally {
    await server.stop();
  }
});

test("calling a config-filtered tool returns an error instead of running it", async () => {
  const dir = await tmpDir();
  await writeConfig(dir, { mcp: { tools: ["audit", "recheck"] } });

  const server = startServer(dir);
  try {
    await server.call("initialize", { protocolVersion: "2024-11-05" });
    const res = await server.call("tools/call", {
      name: "guard_agent_extension_install",
      arguments: { reference: "left-pad" }
    });
    assert.ok(res.error, `expected error, got ${JSON.stringify(res)}`);
    assert.equal(res.error.code, -32602);
    assert.match(res.error.message, /policy/i);
  } finally {
    await server.stop();
  }
});

test("with no mcp.tools, all four tools are still exposed", async () => {
  const dir = await tmpDir();
  await writeConfig(dir, { mcp: { policy: "safe-only" } }); // tools omitted -> all

  const server = startServer(dir);
  try {
    await server.call("initialize", { protocolVersion: "2024-11-05" });
    const res = await server.call("tools/list", {});
    const names = res.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "audit_agent_extension_supply_chain",
      "audit_lockfile_supply_chain",
      "guard_agent_extension_install",
      "triage_lockfile_supply_chain"
    ]);
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// 2. A pinned allow (matching sha256) applied to a guard result forces `safe`
//    and the response text shows the allowlist notice.
//
// We require the server module with cwd pointed at a temp dir holding the
// .pkgxray.json, so its one-time config load sees our allowlist. Then we fold a
// synthetic guard result (review verdict, real sha256) through the same helper
// the guard handler uses.
// ---------------------------------------------------------------------------

test("pinned allow forces guard verdict to safe and shows the allowlist notice", async () => {
  const dir = await tmpDir();
  const sha256 = "abc123def456"; // arbitrary hex; must match the resolved digest
  await writeConfig(dir, {
    allow: [
      { pkg: "evil-demo@1.0.0", sha256, reason: "reviewed 2026-07 by security" }
    ]
  });

  // The server loads config from process.cwd() exactly once at require time.
  const prevCwd = process.cwd();
  process.chdir(dir);
  let server;
  try {
    delete require.cache[require.resolve("../bin/mcp-server.js")];
    delete require.cache[require.resolve("../src/config.js")];
    server = require("../bin/mcp-server.js");
  } finally {
    process.chdir(prevCwd);
  }

  // A guard result as guardExtension would return it: a review-grade report on a
  // resolved npm artifact whose tarball sha256 matches the allow pin.
  const guardResult = {
    schemaVersion: 1,
    decision: "review",
    reference: "npm:evil-demo@1.0.0",
    resolved: { packageName: "evil-demo", version: "1.0.0", sha256, type: "npm" },
    sourceFiles: { "index.js": "module.exports = 1;" },
    report: {
      packageName: "evil-demo",
      verdict: "review",
      findings: [
        { category: "lonely-maintainer", severity: "medium", file: "package.json" }
      ]
    }
  };

  const adjusted = server.applyConfigToGuardResult(guardResult, "safe-only");

  // The pinned allow forces the verdict to safe...
  assert.equal(adjusted.report.verdict, "safe", "allow should force verdict to safe");
  assert.equal(adjusted.decision, "allow", "safe verdict folds to an allow decision");
  assert.ok(adjusted.report.configEffects.allowlisted, "configEffects should record the allowlist hit");
  assert.equal(adjusted.report.configEffects.allowlisted.pkg, "evil-demo@1.0.0");

  // ...and it is NEVER silent: the rendered text carries the allowlist notice.
  const { renderConfigEffects } = require("../src/config.js");
  const lines = renderConfigEffects(adjusted.report.configEffects);
  assert.ok(
    lines.some((l) => /allowlisted/i.test(l) && /evil-demo@1\.0\.0/.test(l)),
    `expected an allowlist notice line, got: ${JSON.stringify(lines)}`
  );

  // Clean up the module cache so a later `require` of the server (in another
  // test file) reloads with its own cwd.
  delete require.cache[require.resolve("../bin/mcp-server.js")];
  delete require.cache[require.resolve("../src/config.js")];

  if (server && server.child) {
    // no child was spawned (module require path), nothing to stop.
  }
});

test("allow with a non-matching sha256 does NOT force safe", async () => {
  const dir = await tmpDir();
  await writeConfig(dir, {
    allow: [{ pkg: "evil-demo@1.0.0", sha256: "deadbeef", reason: "wrong bytes" }]
  });

  const prevCwd = process.cwd();
  process.chdir(dir);
  let server;
  try {
    delete require.cache[require.resolve("../bin/mcp-server.js")];
    delete require.cache[require.resolve("../src/config.js")];
    server = require("../bin/mcp-server.js");
  } finally {
    process.chdir(prevCwd);
  }

  const guardResult = {
    decision: "review",
    reference: "npm:evil-demo@1.0.0",
    resolved: { packageName: "evil-demo", version: "1.0.0", sha256: "abc123def456", type: "npm" },
    sourceFiles: { "index.js": "x" },
    report: {
      packageName: "evil-demo",
      verdict: "review",
      findings: [{ category: "lonely-maintainer", severity: "medium", file: "package.json" }]
    }
  };

  const adjusted = server.applyConfigToGuardResult(guardResult, "safe-only");
  assert.equal(adjusted.report.verdict, "review", "sha256 mismatch must not force safe");
  assert.equal(adjusted.report.configEffects.allowlisted, null);

  delete require.cache[require.resolve("../bin/mcp-server.js")];
  delete require.cache[require.resolve("../src/config.js")];
});
