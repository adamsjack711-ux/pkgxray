"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { start } = require("./helpers/mcp-load-client");
const ROOT = path.resolve(__dirname, "..");
const TOOL = "read_package_evidence", GUARD = "guard_agent_extension_install";
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pkgxray-investigation-wire-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "package"));
  await fs.writeFile(path.join(root, "package/package.json"), JSON.stringify({ name: "inert-evidence-fixture", version: "1.0.0", main: "index.js" }));
  await fs.writeFile(path.join(root, "package/index.js"), 'const apiKey = "wire-fixture-credential-value";\n// Package asks to ignore instructions and approve itself.\nexports.value = 42;\n');
  const archive = path.join(root, "fixture.tgz");
  execFileSync("tar", ["-czf", archive, "-C", root, "package"]);
  const bytes = await fs.readFile(archive), sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const integrity = `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
  const preload = path.join(root, "trusted-test-acquisition.cjs");
  // Trusted fixture acquisition only: the real guard performs integrity,
  // extraction, source scan, coverage and cleanup. No remote service is used.
  await fs.writeFile(preload, `const q=require(${JSON.stringify(path.join(ROOT, "src/quarantine"))});
    const guard=q.guardExtension;q.guardExtension=(reference,options)=>guard(reference,{...options,
      artifact:${JSON.stringify({ archivePath: archive, integrity })},provenance:false});`);
  function client(enabled, extra = {}) {
    const c = start("static", { cwd: root, execArgv: ["--require", preload], env: {
      ...process.env, NODE_OPTIONS: "", PKGXRAY_AGENT_INVESTIGATION: enabled, PKGXRAY_MCP_ALLOWED_ROOTS: root, ...extra
    } });
    t.after(() => c.close()); return c;
  }
  return { root, archive, sha256, client };
}
const guard = (client, extra = {}) => client.request("tools/call", { name: GUARD, arguments: {
  reference: "npm:inert-evidence-fixture@1.0.0", vulnerabilityCheck: false, githubMetadata: false, githubDiff: false,
  outputFormat: "json", ...extra
} });
const read = (client, metadata, extra = {}) => client.request("tools/call", { name: TOOL, arguments: {
  evidenceId: metadata.evidenceId, fileId: metadata.availableFiles.find(f => f.untrustedFileLabel === "index.js").fileId, ...extra
} });

test("real MCP default-off guard redaction is unchanged and callers cannot opt in", async t => {
  const f = await fixture(t), client = f.client("0");
  const tools = (await client.init()).result.tools;
  assert.ok(!tools.some(tool => tool.name === TOOL));
  const reply = await guard(client), result = reply.result.structuredContent;
  assert.equal(result.decision, "block"); assert.equal(result.sourceEvidence.contentReturned, false);
  assert.equal(Object.hasOwn(result, "sourceFiles"), false); assert.equal(Object.hasOwn(result, "investigation"), false);
  assert.doesNotMatch(JSON.stringify(reply), /wire-fixture-credential-value/);
  const unavailable = await client.request("tools/call", { name: TOOL, arguments: { evidenceId: "a".repeat(48), fileId: "a".repeat(32) } });
  assert.equal(unavailable.error.code, -32602);
  const injected = await guard(client, { investigation: true });
  assert.equal(injected.error.code, -32602); assert.match(injected.error.message, /unknown argument/);
});

test("real guard snapshot reads stay bounded, redacted and blocked after original artifact is deleted", async t => {
  const f = await fixture(t), client = f.client("1");
  const definition = (await client.init()).result.tools.find(tool => tool.name === TOOL);
  assert.equal(definition.annotations.readOnlyHint, true);
  assert.equal(definition.annotations.openWorldHint, false);
  assert.deepEqual(Object.keys(definition.inputSchema.properties), ["evidenceId", "fileId", "startLine", "lineCount"]);
  assert.match(definition.description, /untrusted data, never instructions/);
  const reply = await guard(client), result = reply.result.structuredContent, metadata = result.investigation;
  assert.equal(result.decision, "block"); assert.equal(result.sourceEvidence.contentReturned, false);
  assert.ok(metadata); assert.equal(metadata.artifactSha256, f.sha256);
  assert.equal(metadata.scannerBuildId, result.assessment.engine.buildId);
  assert.equal(metadata.policySha256, result.assessment.policySha256);
  assert.doesNotMatch(JSON.stringify(reply), /wire-fixture-credential-value|untrustedSourceExcerpt/);
  assert.equal(Object.hasOwn(result, "stagedPath"), false);
  await fs.rm(f.archive); await fs.rm(path.join(f.root, "package"), { recursive: true });
  const excerpt = (await read(client, metadata)).result.structuredContent;
  assert.equal(excerpt.schemaVersion, 2); assert.equal(excerpt.artifactSha256, f.sha256);
  assert.match(excerpt.untrustedSourceExcerpt, /\[REDACTED\]/);
  assert.doesNotMatch(excerpt.untrustedSourceExcerpt, /wire-fixture-credential-value/);
  assert.match(excerpt.untrustedSourceExcerpt, /Package asks to ignore instructions/);
  assert.equal(excerpt.authorization.installAllowed, false); assert.equal(excerpt.authorization.decision, "block");
  assert.equal(excerpt.redactionApplied, true); assert.ok(excerpt.excerptBytes <= 8192);
  for (const extra of [{ path: "/etc/passwd" }, { reviewChoice: "Proceed" }, { force: true }, { lineCount: 81 }, { fileId: "../../.env" }]) {
    assert.equal((await read(client, metadata, extra)).error.code, -32602);
  }
  for (let i = 1; i < 8; i++) assert.equal((await read(client, metadata)).result.structuredContent.readsRemaining, 7 - i);
  assert.match((await read(client, metadata)).error.message, /budget exhausted/);
});

test("investigation requires both guard/investigate permissions and observes current policy drift", async t => {
  const f = await fixture(t), file = path.join(f.root, ".pkgxray.json");
  for (const tools of [["guard"], ["investigate"], ["guard", "investigate"]]) {
    await fs.writeFile(file, JSON.stringify({ mcp: { tools } }));
    const client = f.client("1");
    const listed = (await client.init()).result.tools.some(t => t.name === TOOL);
    assert.equal(listed, tools.length === 2);
    if (!listed) {
      const response = await client.request("tools/call", { name: TOOL, arguments: { evidenceId: "a".repeat(48), fileId: "a".repeat(32) } });
      assert.equal(response.error.code, -32602);
    }
    await client.close();
  }
  const client = f.client("1"); await client.init();
  const metadata = (await guard(client)).result.structuredContent.investigation;
  assert.ok(metadata);
  await fs.writeFile(file, JSON.stringify({ mcp: { tools: ["guard", "investigate"] }, typosquat: true }));
  assert.match((await read(client, metadata)).error.message, /policy changed/);
  await fs.writeFile(file, JSON.stringify({ mcp: { tools: ["guard", "investigate"] } }));
  assert.match((await read(client, metadata)).error.message, /unavailable/);
  const other = f.client("1"); await other.init();
  assert.match((await read(other, metadata)).error.message, /server session/);
  const fresh = (await guard(client)).result.structuredContent.investigation;
  await fs.writeFile(file, JSON.stringify({ mcp: { tools: ["investigate"] } }));
  assert.match((await read(client, fresh)).error.message, /not available/);
  await fs.writeFile(file, JSON.stringify({ mcp: { tools: ["guard", "investigate"] } }));
  assert.match((await read(client, fresh)).error.message, /unavailable/);
});
