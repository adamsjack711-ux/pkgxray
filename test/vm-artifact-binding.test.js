"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { scanInVm } = require("../src/vm-scan");

test("VM follow-up validates the expected digest before acquiring an artifact", async () => {
  for (const digest of [null, 42, "", "a".repeat(63), "z".repeat(64)]) {
    await assert.rejects(scanInVm("npm:fixture@1.0.0", {
      allowExecution: true, expectedSha256: digest,
      guard: () => assert.fail("invalid digest must not acquire an artifact")
    }), /expectedSha256/);
  }
});

test("VM follow-up executes only a matching artifact and always removes staging", async () => {
  const sha = "a".repeat(64);
  for (const actual of [sha, "b".repeat(64), undefined]) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pkgxray-vm-binding-"));
    let executed = false;
    const operation = scanInVm("npm:fixture@1.0.0", {
      allowExecution: true, expectedSha256: sha.toUpperCase(),
      guard: async () => ({ quarantinePath: directory, stagedPath: path.join(directory, "package"),
        resolved: { sha256: actual }, decision: "block", report: {},
        assessment: { engine: { buildId: "c".repeat(64) }, policySha256: "d".repeat(64) } }),
      runVm: async options => {
        executed = true;
        assert.equal(options.artifactSha256, sha);
        return { verdict: "not-observed", findings: [] };
      }
    });
    if (actual === sha) {
      const result = await operation;
      assert.equal(result.installationApproved, false);
      assert.equal(result.verdict, "block");
    } else await assert.rejects(operation, /does not match expectedSha256/);
    assert.equal(executed, actual === sha);
    await assert.rejects(fs.stat(directory), { code: "ENOENT" });
  }
});
