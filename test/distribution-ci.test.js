"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { scanCiDependencies, extractUses, classifyReference } = require("../src/distribution/ci");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkgxray-ci-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    put(relative, source) {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, source);
      return file;
    }
  };
}

test("extractUses handles quoted scalars and comments without treating hashes as comments", () => {
  const uses = extractUses([
    "- uses: actions/checkout@" + "a".repeat(40) + " # immutable",
    "- uses: 'owner/repo@feature#one'",
    "  uses: \"docker://alpine@sha256:" + "b".repeat(64) + "\""
  ].join("\n"));
  assert.deepEqual(uses, [
    { value: "actions/checkout@" + "a".repeat(40), line: 1 },
    { value: "owner/repo@feature#one", line: 2 },
    { value: "docker://alpine@sha256:" + "b".repeat(64), line: 3 }
  ]);
});

test("classifyReference distinguishes immutable commits, workflows, containers and dynamic refs", () => {
  assert.deepEqual(classifyReference("actions/checkout@" + "a".repeat(40)), {
    kind: "remote-action", pin: { type: "commit", value: "a".repeat(40), immutable: true }
  });
  assert.equal(classifyReference("owner/repo/.github/workflows/reuse.yml@main").kind, "reusable-workflow");
  assert.equal(classifyReference("docker://alpine@sha256:" + "b".repeat(64)).pin.immutable, true);
  assert.equal(classifyReference("docker://alpine:3.20").pin.immutable, false);
  assert.equal(classifyReference("${{ matrix.action }}").kind, "dynamic");
  assert.equal(classifyReference("./.github/actions/check").kind, "local");
});

test("scan inventories reference kinds and reports mutable, unpinned and dynamic dependencies", t => {
  const f = fixture(t);
  const commit = "a".repeat(40);
  const digest = "b".repeat(64);
  f.put(".github/workflows/main.yml", [
    "jobs:",
    "  scan:",
    "    uses: owner/repo/.github/workflows/reuse.yml@main",
    "    steps:",
    `      - uses: actions/checkout@${commit}`,
    "      - uses: owner/action@v4",
    "      - uses: owner/unpinned",
    `      - uses: docker://alpine@sha256:${digest}`,
    "      - uses: docker://alpine:3.20",
    "      - uses: ${{ matrix.action }}"
  ].join("\n"));

  const result = scanCiDependencies(f.root);
  assert.equal(result.coverage.scannedFiles, 1);
  assert.equal(result.coverage.extractedReferences, 7);
  assert.deepEqual(new Set(result.components.map(component => component.kind)), new Set([
    "remote-action", "reusable-workflow", "container-image", "dynamic"
  ]));
  assert.equal(result.components.find(component => component.reference.includes(commit)).pin.type, "commit");
  assert.equal(result.components.find(component => component.reference.includes(digest)).pin.type, "digest");
  assert.deepEqual(result.findings.map(item => item.code), [
    "ci-mutable-reference",
    "ci-mutable-reference",
    "ci-unpinned-reference",
    "ci-mutable-container-image",
    "ci-dynamic-reference"
  ]);
  assert.equal(result.coverage.complete, false);
});

test("scan recursively follows local composite actions and reports missing targets and cycles", t => {
  const f = fixture(t);
  f.put(".github/workflows/main.yaml", [
    "steps:",
    "  - uses: ./.github/actions/outer"
  ].join("\n"));
  f.put(".github/actions/outer/action.yml", [
    "name: outer",
    "runs:",
    "  using: composite",
    "  steps:",
    "    - uses: ./.github/actions/inner",
    "    - uses: ./.github/actions/missing"
  ].join("\n"));
  f.put(".github/actions/inner/action.yaml", [
    "name: inner",
    "runs:",
    "  using: composite",
    "  steps:",
    "    - uses: ./.github/actions/outer"
  ].join("\n"));

  const result = scanCiDependencies(f.root);
  assert.equal(result.coverage.scannedFiles, 3);
  assert.equal(result.coverage.extractedReferences, 4);
  assert.ok(result.findings.some(item => item.code === "ci-reference-cycle"));
  assert.ok(result.findings.some(item => item.code === "ci-local-target-missing"));
  assert.equal(result.components.find(component => component.reference.endsWith("/inner")).localPath, ".github/actions/inner/action.yaml");
  assert.equal(result.coverage.complete, false);
});

test("scan discovers unreferenced repository composite actions", t => {
  const f = fixture(t);
  f.put(".github/actions/standalone/action.yml", [
    "runs:",
    "  using: composite",
    "  steps:",
    "    - uses: actions/setup-node@v4"
  ].join("\n"));
  const result = scanCiDependencies(f.root);
  assert.equal(result.coverage.scannedFiles, 1);
  assert.equal(result.components[0].source, ".github/actions/standalone/action.yml");
  assert.equal(result.findings[0].code, "ci-mutable-reference");
});

test("scan rejects repository escapes and exposes depth and size truncation", t => {
  const f = fixture(t);
  f.put(".github/workflows/main.yml", [
    "steps:",
    "  - uses: ../outside",
    "  - uses: ./.github/actions/one"
  ].join("\n"));
  f.put(".github/actions/one/action.yml", "steps:\n  - uses: ./.github/actions/two\n");
  f.put(".github/actions/two/action.yml", "steps:\n  - uses: actions/checkout@v4\n");

  const depthResult = scanCiDependencies(f.root, { maxDepth: 0 });
  assert.ok(depthResult.findings.some(item => item.code === "ci-local-path-escape"));
  assert.ok(depthResult.findings.some(item => item.code === "ci-reference-depth-limit"));
  assert.ok(depthResult.coverage.reasons.some(reason => reason.includes("depth 0")));

  const sizeResult = scanCiDependencies(f.root, { maxFileBytes: 8 });
  assert.ok(sizeResult.findings.some(item => item.code === "ci-file-size-limit"));
  assert.equal(sizeResult.coverage.complete, false);
});
