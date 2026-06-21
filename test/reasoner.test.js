"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildEvidencePack, VERDICT_SCHEMA, SYSTEM_PROMPT } = require("../src/reasoner");

test("buildEvidencePack caps file count", () => {
  const sourceFiles = {};
  for (let i = 0; i < 50; i += 1) {
    sourceFiles[`f${i}.js`] = "x";
  }
  const { pack, truncation } = buildEvidencePack(
    { packageName: "x", sourceFiles },
    { maxFiles: 10 }
  );
  assert.equal(Object.keys(pack.sourceFiles).length, 10);
  assert.equal(truncation.filesIncluded, 10);
  assert.equal(truncation.filesTotal, 50);
  assert.equal(truncation.filesDropped.length, 40);
});

test("buildEvidencePack truncates oversized files", () => {
  const big = "a".repeat(200);
  const { pack } = buildEvidencePack(
    { sourceFiles: { "big.js": big } },
    { maxFileBytes: 64 }
  );
  assert.ok(pack.sourceFiles["big.js"].length <= 64);
  assert.match(pack.sourceFiles["big.js"], /truncated by agentguard --reason/);
});

test("buildEvidencePack respects total byte cap", () => {
  const sourceFiles = {};
  for (let i = 0; i < 10; i += 1) {
    sourceFiles[`f${i}.js`] = "y".repeat(50);
  }
  const { pack, truncation } = buildEvidencePack(
    { sourceFiles },
    { maxFiles: 100, maxFileBytes: 1024, maxTotalBytes: 150 }
  );
  assert.ok(truncation.totalSourceBytes <= 150);
  assert.ok(Object.keys(pack.sourceFiles).length < 10);
});

test("verdict schema enumerates the required verdicts", () => {
  assert.deepEqual(VERDICT_SCHEMA.properties.verdict.enum, ["safe", "review", "block"]);
});

test("system prompt mentions fail-closed and untrusted evidence", () => {
  assert.match(SYSTEM_PROMPT, /FAIL-CLOSED PRINCIPLE/);
  assert.match(SYSTEM_PROMPT, /UNTRUSTED data/);
  assert.match(SYSTEM_PROMPT, /injection-attempt/);
});
