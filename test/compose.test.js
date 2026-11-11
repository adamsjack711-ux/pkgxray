"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { scanComposition } = require("../src/compose-scan");
const repo = path.resolve(__dirname, "..");
const tool = "analyze_package_composition";
const serverCleanup = new WeakMap();
async function fixture(t, kind = "sensitive") {
  const { createScenario } = await import("../components/compose/examples/support/scenario.mjs");
  const f = createScenario(kind);
  t.after(async () => {
    // Windows holds a child's cwd open until the process exits. Stop servers
    // before deleting their source snapshots, even when an assertion fails.
    for (const close of serverCleanup.get(t) || []) await close();
    f.cleanup();
  });
  return f;
}
function server(t, cwd, enabled = "1") {
  const child = spawn(process.execPath, [path.join(repo, "bin/mcp-server.js")], {
    cwd, env: { ...process.env, PKGXRAY_COMPOSE: enabled, PKGXRAY_VM_TESTS: "0", PKGXRAY_MCP_ALLOWED_ROOTS: cwd },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const pending = new Map(); let buffer = "", id = 0;
  child.stderr.resume();
  child.stdout.on("data", chunk => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n"), value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      pending.get(value.id)?.(value); pending.delete(value.id);
    }
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  const cleanup = serverCleanup.get(t) || [];
  cleanup.push(async () => {
    const fallback = setTimeout(() => child.kill("SIGKILL"), 2000);
    try { child.stdin.end(); child.kill(); await closed; }
    finally { clearTimeout(fallback); }
  });
  serverCleanup.set(t, cleanup);
  const call = (method, params) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error("MCP timeout")); }, 10000);
    pending.set(key, value => { clearTimeout(timer); resolve(value); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: key, method, params }) + "\n");
  });
  return { call, scan: args => call("tools/call", { name: tool, arguments: args }) };
}
test("both Compose entrypoints use bundled package checks without a scanner path", async t => {
  const f = await fixture(t);
  for (const args of [["bin/audit.js", "compose"], ["bin/compose.js"]]) {
    const result = spawnSync(process.execPath, [...args, f.root, "--json"], { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 3, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.tool, "pkgxray-compose");
    assert.equal(report.pkgxray.status, "completed");
    assert.ok(report.compose.findings.some(f => f.crossPackage));
    assert.equal(report.authorization.installAllowed, false);
  }
});
test("bundled worker preserves package blocks and public controls remain review", async t => {
  for (const kind of ["blocked", "public", "unsupported"]) {
    const f = await fixture(t, kind), { report } = await scanComposition(fs.realpathSync(f.root));
    assert.equal(report.decision, kind === "blocked" ? "block" : "review");
    assert.equal(report.authorization.installAllowed, false);
    assert.equal(report.pkgxray.status, "completed");
    if (kind === "unsupported") assert.equal(report.execution, "partial");
  }
});
test("Compose MCP is hidden and uncallable unless the operator enables it", async t => {
  const f = await fixture(t), s = server(t, f.root, "0");
  assert.equal((await s.call("tools/list", {})).result.tools.some(t => t.name === tool), false);
  assert.equal((await s.scan({ projectPath: f.root })).error.code, -32602);
});
test("enabled Compose MCP retains findings and enforces paths and argument authority", async t => {
  const f = await fixture(t), s = server(t, f.root);
  assert.ok((await s.call("tools/list", {})).result.tools.some(t => t.name === tool));
  const response = await s.scan({ projectPath: f.root, outputFormat: "json" });
  const report = response.result.structuredContent;
  assert.equal(report.pkgxray.status, "completed");
  assert.equal(report.decision, "block");
  assert.equal(report.compose.analysisStatus, "flow-found");
  assert.equal(Object.hasOwn(report.compose, "verdict"), false);
  assert.ok(report.compose.findings.length);
  assert.equal(report.authorization.installAllowed, false);
  for (const args of [{}, { projectPath: os.tmpdir() }, { projectPath: f.root, scannerRoot: f.root },
    { projectPath: f.root, entry: "../index.js" }, { projectPath: f.root, entry: "C:/secret.js" },
    { projectPath: f.root, command: "node target.js" }, { projectPath: f.root, limits: {} },
    { projectPath: f.root, outputFormat: "html" }]) {
    assert.equal((await s.scan(args)).error.code, -32602, JSON.stringify(args));
  }
  f.put(".pkgxray.json", { schemaVersion: 1, mcp: { tools: ["audit"] } });
  assert.equal((await s.scan({ projectPath: f.root })).error.code, -32602, "current policy must be checked on every call");
});
test("Compose honors its separate config allowlist key", async t => {
  const f = await fixture(t); f.put(".pkgxray.json", { schemaVersion: 1, mcp: { tools: ["compose"] } });
  const s = server(t, f.root);
  assert.deepEqual((await s.call("tools/list", {})).result.tools.map(t => t.name), [tool]);
  assert.equal((await s.scan({ projectPath: f.root })).result.structuredContent.authorization.installAllowed, false);
});
test("Compose treats target code as data and rejects source links", async t => {
  const f = await fixture(t), marker = path.join(f.root, "executed");
  f.put("index.js", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad');`);
  const { report } = await scanComposition(fs.realpathSync(f.root));
  assert.equal(fs.existsSync(marker), false);
  assert.equal(report.authorization.installAllowed, false);
  if (process.platform === "win32") return; // unprivileged Windows cannot create file symlinks
  fs.unlinkSync(path.join(f.root, "index.js"));
  fs.symlinkSync(__filename, path.join(f.root, "index.js"));
  const linked = await scanComposition(fs.realpathSync(f.root));
  assert.ok(linked.report.gaps.some(g => g.code === "unsupported-symlink"));
});
test("worker deadlines and cancellation never produce a passing result", async t => {
  const f = await fixture(t);
  const result = await scanComposition(fs.realpathSync(f.root), { timeoutMs: 1 });
  assert.equal(result.decision, "review");
  assert.equal(result.authorization.installAllowed, false);
  const controller = new AbortController();
  const promise = scanComposition(fs.realpathSync(f.root), { signal: controller.signal });
  controller.abort(new Error("stop"));
  await assert.rejects(promise, /stop/);
});
