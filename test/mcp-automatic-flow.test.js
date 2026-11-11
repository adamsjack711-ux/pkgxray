"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { analyzeSuppliedEvidence, publicCompositionResult, scanErrorResult, listTools, validateToolCall } = require("../bin/mcp-server");
const { start, evidence, call } = require("./helpers/mcp-load-client");

test("MCP advertises binary outcomes and refuses retired manual decision controls", () => {
  const tools = listTools(), guard = tools.find(tool => tool.name === "guard_agent_extension_install");
  assert.ok(!Object.hasOwn(guard.inputSchema.properties, "reviewId"));
  assert.ok(!Object.hasOwn(guard.inputSchema.properties, "reviewChoice"));
  assert.deepEqual(guard.inputSchema.properties.policy.enum, ["safe-only"]);
  for (const tool of tools) {
    assert.doesNotMatch(tool.description, /pending REVIEW|Proceed|Decline|reviewPlan|SAFE, REVIEW/);
    for (const key of ["reviewId", "reviewChoice", "reviewScope", "reviewDecisions", "reviewAction"]) {
      assert.match(validateToolCall(tool.name, { [key]: null }), /no longer supported/);
    }
  }
  assert.match(validateToolCall(guard.name, { reference: "npm:test@1.0.0", policy: "allow-review" }), /safe-only/);
});

test("supplied evidence retries once with identical bytes after transient failure", async () => {
  const input = { sourceFiles: { "index.js": "exports.value=1" }, npmMetadata: { name: "inert" } };
  const analysis = { typosquat: false }, expected = structuredClone(input);
  let attempts = 0;
  const result = await analyzeSuppliedEvidence(input, analysis, { analyze: async (actual, options) => {
    attempts++;
    assert.deepEqual(actual, expected);
    assert.deepEqual(options, { typosquat: false });
    if (attempts === 1) {
      actual.sourceFiles["index.js"] = "changed locally";
      input.sourceFiles["index.js"] = "caller changed input during wait";
      analysis.typosquat = true;
      throw Object.assign(new Error("worker failed"), { code: "SCAN_ERROR" });
    }
    return { evidence: { verdict: "safe" }, source: "scan" };
  } });
  assert.equal(attempts, 2);
  assert.equal(result.retryAttempts, 1);
  assert.equal(result.evidence.verdict, "safe");
});

test("retry exhaustion becomes an explicit scan-gap block without unsafe diagnostics", async () => {
  let attempts = 0, failure;
  try {
    await analyzeSuppliedEvidence({ sourceFiles: {} }, {}, { analyze: async () => {
      attempts++; throw Object.assign(new Error("failed /private/secret/source.js"), { code: "SCAN_TIMEOUT" });
    } });
  } catch (error) { failure = error; }
  assert.equal(attempts, 2);
  const reply = scanErrorResult(1, "audit_agent_extension_supply_chain", failure, "json");
  assert.equal(reply.result.structuredContent.verdict, "block");
  assert.equal(reply.result.structuredContent.resolution.retry.attempts, 1);
  assert.deepEqual(reply.result.structuredContent.resolution.reasonCodes, ["incomplete-checks"]);
  assert.match(reply.result.structuredContent.message, /does not establish malicious behavior/);
  assert.doesNotMatch(reply.result.content[0].text, /\/private\/secret/);
});

test("findings, queue pressure, cancellation and changed builds never trigger retries", async () => {
  for (const verdict of ["safe", "review", "block"]) {
    let attempts = 0;
    const result = await analyzeSuppliedEvidence({ sourceFiles: {} }, {}, { analyze: async () => {
      attempts++; return { evidence: { verdict }, source: "scan" };
    } });
    assert.equal(attempts, 1);
    assert.equal(result.retryAttempts, 0);
  }
  for (const code of ["SCAN_OVERLOADED", "SCAN_CANCELLED", "SCANNER_CHANGED", "ERR_WORKER_OUT_OF_MEMORY"]) {
    let attempts = 0;
    await assert.rejects(analyzeSuppliedEvidence({ sourceFiles: {} }, {}, { analyze: async () => {
      attempts++; throw Object.assign(new Error("cannot scan"), { code });
    } }), { code });
    assert.equal(attempts, 1);
  }
  const controller = new AbortController();
  let attempts = 0;
  await assert.rejects(analyzeSuppliedEvidence({ sourceFiles: {} }, {}, { signal: controller.signal, analyze: async () => {
    attempts++; controller.abort(); throw Object.assign(new Error("worker failed"), { code: "SCAN_ERROR" });
  } }), { name: "AbortError" });
  assert.equal(attempts, 1);
});

test("Compose blocks authorization without renaming raw flow categories as safety", () => {
  const raw = { decision: "review", authorization: { installAllowed: false }, coverage: { status: "partial" },
    compose: { verdict: "no-flow-found", findings: [] }, reviewPlan: { state: "pending" } };
  const result = publicCompositionResult(raw);
  assert.equal(result.decision, "block");
  assert.equal(result.compose.analysisStatus, "no-flow-found");
  assert.equal(Object.hasOwn(result.compose, "verdict"), false);
  assert.equal(Object.hasOwn(result, "reviewPlan"), false);
  assert.match(result.summary, /not a confirmed malware finding/);
  assert.equal(result.authorization.installAllowed, false);
  assert.equal(raw.decision, "review");
});

test("real MCP supplied evidence is binary and repeated safe evidence still shares cache", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-automatic-flow-"));
  const client = start("static", { cwd: root });
  t.after(async () => { await client.close(); await fs.rm(root, { recursive: true, force: true }); });
  await client.init();
  const first = await call(client, evidence(73)), second = await call(client, evidence(73));
  assert.equal(first.result.structuredContent.verdict, "safe");
  assert.equal(second.result.structuredContent.scanSource, "cache");
  assert.equal(first.result.structuredContent.resolution.retry.attempts, 0);
  for (const outputFormat of ["json", "markdown"]) {
    const response = await call(client, { sourceFiles: { "index.js": "module.exports = 1" }, outputFormat });
    assert.equal(response.result.structuredContent.verdict, "block");
    assert.ok(response.result.structuredContent.resolution.reasonCodes.length > 0);
    assert.equal(response.result.structuredContent.resolution.retry.attempts, 0);
    assert.doesNotMatch(response.result.content[0].text, /Proceed|Decline|Pending decision|reviewPlan/);
  }
});

test("real MCP disabled or malformed lockfile checks produce block, not pending approval", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auto-lock-"));
  const file = path.join(root, "package.json");
  await fs.writeFile(file, JSON.stringify({ name: "inert", dependencies: { "inert-dependency": "1.0.0" } }));
  const client = start("static", { cwd: root, env: { ...process.env, PKGXRAY_MCP_ALLOWED_ROOTS: root } });
  t.after(async () => { await client.close(); await fs.rm(root, { recursive: true, force: true }); });
  const response = await client.request("tools/call", { name: "audit_lockfile_supply_chain", arguments: { lockfilePath: file, vulnerabilityCheck: false } });
  assert.equal(response.result.structuredContent.worstDecision, "block");
  assert.deepEqual(response.result.structuredContent.summary, { safe: 0, blocked: 1, inconclusive: 1 });
  assert.doesNotMatch(response.result.content[0].text, /review:|REVIEW|Proceed|Decline/);
  await fs.writeFile(file, "not json");
  const malformed = await client.request("tools/call", { name: "audit_lockfile_supply_chain", arguments: { lockfilePath: file } });
  assert.equal(malformed.result.structuredContent.verdict, "block");
  assert.equal(malformed.result.isError, true);
});

test("guard acquisition failure becomes BLOCK without retrying a mutable package reference", () => {
  const program = `
    let calls=0;
    const guard=require('./src/quarantine');
    guard.guardExtension=async()=>{calls++;throw new Error('required network check unavailable');};
    process.on('exit',()=>process.stderr.write('calls='+calls));
    require('./bin/mcp-server').startStdioServer();
  `;
  const child = spawnSync(process.execPath, ["-e", program], {
    cwd: path.resolve(__dirname, ".."), encoding: "utf8", timeout: 10000,
    input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "guard_agent_extension_install", arguments: { reference: "npm:inert-fixture@latest", outputFormat: "json" }
    } }) + "\n"
  });
  assert.equal(child.status, 0, child.stderr);
  const reply = JSON.parse(child.stdout.trim());
  assert.equal(reply.result.structuredContent.verdict, "block");
  assert.ok(reply.result.structuredContent.resolution.reasonCodes.includes("incomplete-checks"));
  assert.equal(reply.result.isError, true);
  assert.match(child.stderr, /calls=1$/);
});


test("source retry shares one deadline and caller signal across both attempts", async () => {
  const signals = [];
  let attempts = 0;
  const started = Date.now();
  await assert.rejects(analyzeSuppliedEvidence({ sourceFiles: {} }, {}, {
    timeoutMs: 300,
    analyze: async (evidence, analysis, { signal }) => {
      signals.push(signal);
      attempts++;
      if (attempts === 1) {
        await new Promise(resolve => setTimeout(resolve, 60));
        throw Object.assign(new Error("temporary worker failure"), { code: "SCAN_ERROR" });
      }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 280);
        signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
      return { evidence: { verdict: "safe" }, source: "scan" };
    }
  }), error => error.code === "SCAN_TIMEOUT" && error.retryAttempts === 1);
  assert.equal(attempts, 2);
  assert.equal(signals[0], signals[1]);
  assert.equal(signals[1].aborted, true);
  assert.ok(Date.now() - started < 1000, "deadline bounds the whole retry operation");
});

test("exhausted source deadline neither retries nor releases a late success", async () => {
  for (const fail of [false, true]) {
    let attempts = 0;
    await assert.rejects(analyzeSuppliedEvidence({ sourceFiles: {} }, {}, {
      timeoutMs: 10,
      analyze: async () => {
        attempts++;
        // Deliberately ignore cancellation: the caller must still reject late
        // evidence or avoid retrying even a retryable error after its deadline.
        await new Promise(resolve => setTimeout(resolve, 25));
        if (fail) throw Object.assign(new Error("worker failed"), { code: "SCAN_ERROR" });
        return { evidence: { verdict: "safe" }, source: "scan" };
      }
    }), error => error.code === "SCAN_TIMEOUT" && error.retryAttempts === 0);
    assert.equal(attempts, 1);
  }
});

test("source retry cancellation detaches one waiter without cancelling shared peers", async () => {
  const { SharedScans } = require("../src/shared-scans");
  const service = new SharedScans({ timeoutMs: 1000 });
  const caller = new AbortController();
  let release, workerSignal;
  const held = new Promise(resolve => { release = resolve; });
  const scan = async signal => { workerSignal = signal; await held; return { verdict: "safe" }; };
  try {
    const peer = service.get("same-source", scan);
    const cancelled = analyzeSuppliedEvidence({ sourceFiles: {} }, {}, {
      signal: caller.signal,
      analyze: (evidence, analysis, { signal }) => service.get("same-source", scan, { signal })
    });
    caller.abort();
    await assert.rejects(cancelled, { name: "AbortError" });
    assert.equal(workerSignal.aborted, false);
    release();
    assert.equal((await peer).evidence.verdict, "safe");
    assert.equal(service.snapshot().scans, 1);
    assert.equal(service.snapshot().waiters, 0);
  } finally { release(); service.close(); }
});
