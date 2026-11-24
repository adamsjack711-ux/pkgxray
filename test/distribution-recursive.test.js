"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { scanRecursiveComponents } = require("../src/distribution/recursive");

function component(reference, kind = "remote-action") { return { kind, reference }; }

test("recursive dispatch is deterministic, caches identities and terminates cycles", async () => {
  const calls = [];
  const result = await scanRecursiveComponents({ components: [component("a@pin"), component("a@pin")] }, {
    resolveComponent: async value => {
      calls.push(value.reference);
      return value.reference === "a@pin"
        ? { result: { verdict: "safe", components: [component("b@pin")] }, bytes: 10 }
        : { result: { verdict: "safe", components: [component("a@pin")] }, bytes: 20 };
    }
  });
  assert.deepEqual(calls, ["a@pin", "b@pin"]);
  assert.equal(result.nodes.length, 2);
  assert.equal(result.coverage.totalBytes, 30);
  assert.equal(result.coverage.complete, true);
  assert.ok(result.edges.some(edge => edge.cycle));
  assert.ok(result.findings.some(item => item.category === "recursive-component-cycle"));
  assert.equal(result.verdict, "safe");
});

test("missing resolvers and traversal limits fail visibly", async () => {
  const missing = await scanRecursiveComponents({ components: [component("missing@pin")] });
  assert.equal(missing.verdict, "review");
  assert.equal(missing.nodes[0].status, "error");
  assert.match(missing.coverage.reasons[0], /no resolver/);

  const depth = await scanRecursiveComponents({ components: [component("one@pin")] }, {
    maxDepth: 1,
    resolveComponent: async value => ({ result: { verdict: "safe", components: [component(`${value.reference}-child`)] } })
  });
  assert.equal(depth.verdict, "review");
  assert.match(depth.coverage.reasons.join("\n"), /depth limit/);

  const bytes = await scanRecursiveComponents({ components: [component("large@pin")] }, {
    maxTotalBytes: 8,
    resolveComponent: async () => ({ result: { verdict: "safe" }, bytes: 9 })
  });
  assert.equal(bytes.nodes[0].status, "error");
  assert.match(bytes.coverage.reasons[0], /byte limit/);
});

test("registry guards run only with explicit acquisition and exact versions", async () => {
  const calls = [];
  const guard = async (reference, options) => {
    calls.push({ reference, options });
    return { report: { verdict: "safe" }, decision: "allow" };
  };
  const disabled = await scanRecursiveComponents({ components: [component("npm:demo@1.2.3", "package")] }, { guard });
  assert.equal(calls.length, 0);
  assert.equal(disabled.verdict, "review");

  const enabled = await scanRecursiveComponents({ components: [component("npm:demo@1.2.3", "package")] }, {
    acquirePackages: true, guard, guardOptions: { vulnerabilityCheck: false }
  });
  assert.equal(enabled.verdict, "safe");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reference, "npm:demo@1.2.3");
  assert.equal(calls[0].options.keepStaging, false);
  assert.equal(calls[0].options.promoteTo, undefined);
  assert.equal(calls[0].options.allowExecution, false);
  assert.equal(calls[0].options.scanDependencies, true);

  const mutable = await scanRecursiveComponents({ components: [component("npm:demo@latest", "package")] }, {
    acquirePackages: true, guard
  });
  assert.equal(calls.length, 1);
  assert.equal(mutable.verdict, "review");
  assert.match(mutable.nodes[0].error, /exact version/);
});

test("registry output is summarized and valid exact PyPI versions are accepted", async () => {
  const guard = async () => ({
    decision: "review",
    report: { verdict: "review", findings: [{ severity: "medium", category: "fixture" }] },
    assessment: { artifact: { sha256: "a".repeat(64) } },
    sourceCoverage: { complete: true },
    sourceFiles: { "huge.js": "secret source bytes" },
    stagedPath: "/temporary/stage",
    quarantinePath: "/temporary"
  });
  const result = await scanRecursiveComponents({ components: [component("pypi:demo@1.0rc1", "package")] }, {
    acquirePackages: true, guard
  });
  assert.equal(result.verdict, "review");
  assert.equal(result.nodes[0].status, "scanned");
  assert.equal(result.nodes[0].result.assessment.artifact.sha256, "a".repeat(64));
  assert.equal(result.nodes[0].result.sourceFiles, undefined);
  assert.equal(result.nodes[0].result.stagedPath, undefined);
  assert.equal(result.nodes[0].result.quarantinePath, undefined);
});

test("immutable GitHub Actions dispatch through the existing GitHub guard", async () => {
  const calls = [];
  const sha = "a".repeat(40);
  const result = await scanRecursiveComponents({ components: [
    { kind: "remote-action", reference: `actions/checkout@${sha}` }
  ] }, {
    acquirePackages: true,
    guard: async reference => { calls.push(reference); return { decision: "allow", report: { verdict: "safe", findings: [] } }; }
  });
  assert.deepEqual(calls, [`github:actions/checkout#${sha}`]);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.verdict, "safe");
});

test("resolver results, cleanup and worst child verdict are preserved", async () => {
  let cleaned = 0;
  const child = { verdict: "block", findings: [{ severity: "high" }], components: [] };
  const result = await scanRecursiveComponents({ components: [component("blocked@pin")] }, {
    resolveComponent: async () => ({ distribution: child, source: "fixture", bytes: 4, cleanup: async () => { cleaned += 1; } })
  });
  assert.equal(result.verdict, "block");
  assert.equal(result.nodes[0].result, child);
  assert.equal(result.nodes[0].source, "fixture");
  assert.equal(cleaned, 1);
});

test("resolver work is bounded by the global deadline", async () => {
  const result = await scanRecursiveComponents({ components: [component("slow@pin")] }, {
    timeoutMs: 20,
    resolveComponent: async () => new Promise(resolve => setTimeout(() => resolve({ result: { verdict: "safe" } }), 80))
  });
  assert.equal(result.verdict, "review");
  assert.equal(result.nodes[0].status, "error");
  assert.match(result.nodes[0].error, /time limit/);
});

test("browser permissions and update metadata are not treated as recursive dependencies", async () => {
  let calls = 0;
  const result = await scanRecursiveComponents({ components: [
    { kind: "permission", reference: "nativeMessaging" },
    { kind: "host-permission", reference: "<all_urls>" },
    { kind: "update-channel", reference: "https://updates.example/extension.xml" }
  ] }, { resolveComponent: async () => { calls += 1; return { result: { verdict: "safe" } }; } });
  assert.equal(calls, 0);
  assert.equal(result.nodes.length, 0);
  assert.equal(result.findings.length, 0);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.ignoredMetadataComponents, 3);
  assert.equal(result.verdict, "safe");
});
