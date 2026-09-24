"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { guardExtension } = require("../src/quarantine");
const { DEFAULTS } = require("../src/config");

async function fixture(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pkgxray-completeness-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  await fs.mkdir(source);
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(source, name), content);
  return { root, source };
}
const offline = { vulnerabilityCheck: false, githubMetadata: false, githubDiff: false, provenance: false };
const manifest = JSON.stringify({ name: "demo", version: "1.0.0", main: "z.js" });

test("unread files force review and cannot promote under allow-review", async t => {
  const { source, root } = await fixture(t, { "package.json": manifest, "z.js": "require('fs').readFileSync(process.env.HOME+'/.ssh/id_rsa');" });
  const result = await guardExtension(source, { ...offline, maxFiles: 1, policy: "allow-review", promoteTo: path.join(root, "out") });
  assert.equal(result.decision, "review");
  assert.equal(result.sourceCoverage.skippedFiles, 1);
  assert.equal(result.sourceCoverage.complete, false);
  assert.equal(result.promotedPath, null);
  const muted = await guardExtension(source, { ...offline, maxFiles: 1, config: {
    ...DEFAULTS, policy: "allow-review", mute: [{ check: "incomplete-source-scan", scope: "*" }]
  } });
  assert.equal(muted.report.verdict, "review");
  assert.equal(muted.decision, "review");
  assert.ok(result.report.findings.some(f => f.category === "incomplete-source-scan"));
  const full = await guardExtension(source, offline);
  assert.equal(full.decision, "block");
});

test("truncated files and exhausted byte budgets cannot clear a package", async t => {
  const { source } = await fixture(t, { "package.json": manifest, "z.js": " ".repeat(6 * 1024 * 1024) });
  for (const limits of [{}, { maxTotalScanBytes: Buffer.byteLength(manifest) }]) {
    const result = await guardExtension(source, { ...offline, ...limits });
    assert.equal(result.decision, "review");
    assert.equal(result.sourceCoverage.complete, false);
  }
});

test("promotion uses config-adjusted verdict before copying", async t => {
  const { source, root } = await fixture(t, {
    "package.json": JSON.stringify({ name: "demo", version: "1.0.0", scripts: { postinstall: "node z.js" } }),
    "z.js": "console.log('setup');"
  });
  const result = await guardExtension(source, { ...offline, promoteTo: path.join(root, "out"), config: {
    ...DEFAULTS, mute: [{ check: "install-hook", scope: "*", reason: "reviewed setup" }]
  } });
  assert.equal(result.report.verdict, "safe");
  assert.equal(result.decision, "allow");
  assert.ok(result.promotedPath);
  assert.equal(await fs.readFile(path.join(result.promotedPath, "z.js"), "utf8"), "console.log('setup');");
});

test("deep scan failure changes safe to review and preserves an existing block", async t => {
  const q = require("../src/quarantine");
  const original = q.guardExtension;
  q.guardExtension = async () => { throw new Error("download unavailable"); };
  t.after(() => { q.guardExtension = original; });
  const { source } = await fixture(t, { "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/demo": { version: "1.0.0", resolved: "https://registry.npmjs.org/demo/-/demo-1.0.0.tgz", integrity: "sha256-" + Buffer.alloc(32).toString("base64") } } }) });
  const { auditLockfile } = require("../src/lockfile");
  for (const [osv, expected] of [[{}, "review"], [{ vulns: [{ id: "TEST-1" }] }, "block"]]) {
    const r = await auditLockfile(path.join(source, "package-lock.json"), { osvResults: [osv], deepAll: true, triageDecisions: false });
    assert.equal(r.worstDecision, expected);
    assert.equal(r.coverage.deepFailures, 1);
    assert.equal(r.results[0].deep.error, "download unavailable");
  }
});

const credentialRead = "require('fs').readFileSync(process.env.HOME+'/.ssh/id_rsa');";

test("declared runtime files are scanned regardless of extension or filename", async t => {
  for (const name of ["payload.dat", "payload", "payload.txt", "payload.bin"]) {
    for (const field of ["main", "bin", "exports", "scripts"]) {
      const pkg = { name: "demo", version: "1.0.0" };
      pkg[field] = field === "scripts" ? { postinstall: `node ${name}` } : field === "exports" ? { ".": `./${name}` } : name;
      const { source, root } = await fixture(t, { "package.json": JSON.stringify(pkg), [name]: credentialRead });
      const result = await guardExtension(source, { ...offline, promoteTo: path.join(root, "out") });
      assert.equal(result.report.verdict, "block", `${field}: ${name}`);
      assert.ok(result.sourceCoverage.runtimeFiles.includes(name));
      assert.equal(result.promotedPath, null);
    }
  }
});

test("literal import chains reach unusual filenames beyond the old two-hop graph", async t => {
  const files = { "package.json": manifest, "z.js": "module.exports = require('./step0.dat');" };
  for (let i = 0; i < 5; i++) files[`step${i}.dat`] = `module.exports = require('./step${i+1}.dat');`;
  files["step5.dat"] = credentialRead;
  const { source } = await fixture(t, files);
  const result = await guardExtension(source, offline);
  assert.equal(result.report.verdict, "block");
  assert.ok(result.sourceCoverage.runtimeFiles.includes("step5.dat"));
});

test("missing, escaped and binary runtime targets remain review under allow-review", async t => {
  for (const [main, extra] of [["missing.dat", {}], ["../outside.js", {}], ["native.node", { "native.node": "\0binary" }]]) {
    const { source, root } = await fixture(t, { "package.json": JSON.stringify({ name: "demo", version: "1.0.0", main }), ...extra });
    const result = await guardExtension(source, { ...offline, policy: "allow-review", promoteTo: path.join(root, "out") });
    assert.equal(result.decision, "review", main);
    assert.equal(result.sourceCoverage.complete, false);
    assert.equal(result.promotedPath, null);
  }
});

test("declared custom-extension benign entrypoint stays clear and reports check scope", async t => {
  const { source } = await fixture(t, { "package.json": JSON.stringify({ name: "demo", version: "1.0.0", main: "payload.dat" }), "payload.dat": "module.exports = 42;" });
  const result = await guardExtension(source, offline);
  assert.equal(result.report.verdict, "safe");
  assert.equal(result.sourceCoverage.complete, true);
  assert.equal(result.assessment.checks.source, "completed");
  assert.equal(result.assessment.checks.vulnerabilities, "disabled");
  assert.equal(result.vulnerabilityPrecheck.completed, false);
  assert.equal(result.assessment.artifact.sha256, null);
  assert.match(result.assessment.policySha256, /^[a-f0-9]{64}$/);
});

test('local subprocess targets are collected even when their extension looks inert', async t => {
  const {source} = await fixture(t, {
    'package.json': manifest,
    'z.js': "require('child_process').fork(require('path').join(__dirname,'worker.dat'),[],{detached:true});",
    'worker.dat': "const words=['events','util','a','b','c','d','e','f']; words.push(words.shift()); function word(i){return words[i]} require(word(0));"
  });
  const result = await guardExtension(source,offline);
  assert.ok(result.sourceCoverage.runtimeFiles.includes('worker.dat'));
  assert.equal(result.sourceCoverage.complete,true);
  assert.equal(result.decision,'block');
  assert.ok(result.report.findings.some(f=>f.category==='hidden-local-loader'));
});

test("dependency findings and failures affect the decision before promotion", async t => {
  const lock = require("../src/lockfile");
  const original = lock.batchOsvQuery;
  t.after(() => { lock.batchOsvQuery = original; });
  for (const [mode, expected] of [["vulnerable", "block"], ["offline", "review"], ["incomplete", "review"], ["clean", "allow"]]) {
    lock.batchOsvQuery = async () => {
      if (mode === "offline") throw new Error("OSV unavailable");
      if (mode === "incomplete") return [];
      return [mode === "vulnerable" ? { vulns: [{ id: "LOCAL-TEST-VULN" }] } : {}];
    };
    const { source, root } = await fixture(t, { "package.json": JSON.stringify({ name: "demo", version: "1.0.0", dependencies: { dep: "1.0.0" } }) });
    const result = await guardExtension(source, { ...offline, scanDependencies: true, policy: "allow-review", promoteTo: path.join(root, "out") });
    assert.equal(result.decision, expected, mode);
    assert.equal(Boolean(result.promotedPath), mode === "clean");
    if (mode === "vulnerable") assert.ok(result.report.findings.some(f => f.category === "known-vulnerability"));
  }
});

test("ranges and non-registry dependencies cannot be cleared by stripping their prefix", async t => {
  const { source } = await fixture(t, { "package.json": JSON.stringify({ name: "demo", version: "1.0.0", dependencies: { dep: "^1.0.0", local: "file:../local" } }) });
  const result = await guardExtension(source, { ...offline, scanDependencies: true, policy: "allow-review" });
  assert.equal(result.dependencyAudit.scanned, 0);
  assert.equal(result.dependencyAudit.unresolved.length, 2);
  assert.equal(result.decision, "review");
  assert.equal(result.assessment.checks.directDependencies, "partial");
});

test("exact npm aliases are checked under the real package identity", async t => {
  const lock = require("../src/lockfile");
  const original = lock.batchOsvQuery;
  t.after(() => { lock.batchOsvQuery = original; });
  lock.batchOsvQuery = async deps => {
    assert.deepEqual([...deps.values()].map(d => [d.name, d.version]), [["@scope/real", "1.2.3"]]);
    return [{ vulns: [{ id: "LOCAL-ALIAS-VULN" }] }];
  };
  const { source } = await fixture(t, { "package.json": JSON.stringify({ name: "demo", version: "1.0.0", dependencies: { alias: "npm:@scope/real@1.2.3" } }) });
  const result = await guardExtension(source, { ...offline, scanDependencies: true });
  assert.equal(result.decision, "block");
  assert.equal(result.dependencyAudit.flagged[0].name, "@scope/real");
});

test("cyclic imports terminate and directory entrypoints resolve deterministically", async t => {
  const { source } = await fixture(t, { "package.json": JSON.stringify({ name: "demo", version: "1.0.0", main: "." }),
    "index.js": "require('./a.dat');", "a.dat": "require('./index.js');" });
  const result = await guardExtension(source, offline);
  assert.equal(result.sourceCoverage.complete, true);
  assert.equal(result.sourceCoverage.runtimeFiles.length, 2);
  assert.equal(result.report.verdict, "review");
  assert.ok(result.report.findings.some(f => f.category === "flow-analysis-gap"));
});

test("external import mappings are not mistaken for missing artifact files", async t => {
  const { source } = await fixture(t, { "package.json": JSON.stringify({ name: "demo", version: "1.0.0",
    imports: { "#external": "external-package", "#local": "./entry.dat" },
    browser: { fs: false, stream: "stream-browserify" } }), "entry.dat": "module.exports = 42;" });
  const result = await guardExtension(source, offline);
  assert.equal(result.sourceCoverage.complete, true);
  assert.deepEqual(result.sourceCoverage.runtimeFiles, ["entry.dat"]);
  assert.equal(result.report.verdict, "safe");
});
