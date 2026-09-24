"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const bin = path.join(__dirname, "../bin/audit.js");
const script = `console.error('ENV_PROBE=' + JSON.stringify({
  secret: process.env.PKGXRAY_TEST_SECRET,
  other: process.env.PKGXRAY_TEST_OTHER,
  options: process.env.NODE_OPTIONS,
  path: process.env.PATH
}));`;
function probe(flags = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, "mcp-proxy", ...flags, "--", process.execPath, "-e", script], {
      stdio: ["pipe", "pipe", "pipe"], timeout: 10000,
      env: { ...process.env, NODE_OPTIONS: "--no-warnings", PKGXRAY_TEST_SECRET: "synthetic-secret",
        PKGXRAY_TEST_OTHER: "synthetic-other" }
    });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.stdout.resume();
    child.on("error", reject);
    child.on("close", status => resolve({ status, stderr }));
  });
}
function observed(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stderr.match(/ENV_PROBE=(\{[^\n]+\})/)[1]);
}
test("MCP child cannot read ambient credentials or runtime injection options at startup", async () => {
  const env = observed(await probe());
  assert.equal(env.secret, undefined);
  assert.equal(env.other, undefined);
  assert.equal(env.options, undefined);
  assert.equal(env.path, require("../src/mcp-client").MINIMAL_PATH);
});
test("MCP --env forwards only the named credential and supports repeated names", async () => {
  assert.equal(observed(await probe(["--env", "PKGXRAY_TEST_SECRET"])).other, undefined);
  const env = observed(await probe(["--env", "PKGXRAY_TEST_SECRET", "--env", "PKGXRAY_TEST_OTHER"]));
  assert.equal(env.secret, "synthetic-secret");
  assert.equal(env.other, "synthetic-other");
});
test("MCP rejects forbidden, missing and malformed environment opt-ins before launch", async () => {
  for (const name of ["NODE_OPTIONS", "PATH", "LD_PRELOAD", "PKGXRAY_NONEXISTENT_TEST_VAR", "KEY=value"]) {
    const result = await probe(["--env", name]);
    assert.notEqual(result.status, 0, name);
    assert.doesNotMatch(result.stderr, /ENV_PROBE=/);
    assert.doesNotMatch(result.stderr, /synthetic-secret/);
  }
});
