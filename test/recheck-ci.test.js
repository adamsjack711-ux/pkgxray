"use strict";

// T4 — CI-cron surface: exit-code mapping keys off the worst *regression*, not
// the worst absolute verdict; and the --format json output is a stable,
// machine-readable diff.

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { recheckLockfile, recheckJson } = require("../src/recheck");
const { saveDecisions, lockPathForLockfile } = require("../src/triage");

async function project(deps, baselines) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pkgxray-ci-"));
  const packages = { "": { name: "demo", version: "1.0.0" } };
  for (const [name, version] of deps) packages[`node_modules/${name}`] = { version };
  const lockfilePath = path.join(dir, "package-lock.json");
  await fs.writeFile(lockfilePath, JSON.stringify({ lockfileVersion: 3, packages }));
  const map = new Map();
  for (const b of baselines) {
    map.set(`${b.name}@${b.version}`, {
      name: b.name, version: b.version, decision: b.decision || "allow",
      reason: "", decided_at: "2026-01-01T00:00:00.000Z",
      verdict: b.verdict, checkedAt: "2026-01-01T00:00:00.000Z"
    });
  }
  await saveDecisions(lockPathForLockfile(lockfilePath), map);
  return lockfilePath;
}

test("worst absolute verdict is block but the only regression is to review => exit 3", async () => {
  // alwaysbad: block at install, still block  -> NOT a regression (would be the
  //   worst ABSOLUTE verdict, block, if we naively folded verdicts).
  // slipped:   safe at install, now review    -> the ONLY new regression.
  // Correct monitoring exit code is 3 (review), not 2 (block).
  const lockfilePath = await project(
    [["alwaysbad", "1.0.0"], ["slipped", "2.0.0"]],
    [
      { name: "alwaysbad", version: "1.0.0", verdict: "block", decision: "block" },
      { name: "slipped", version: "2.0.0", verdict: "safe" }
    ]
  );
  const fresh = { alwaysbad: "block", slipped: "review" };
  const result = await recheckLockfile(lockfilePath, {
    write: false,
    evaluate: async (dep) => ({ verdict: fresh[dep.name] })
  });

  assert.equal(result.counts.regressed, 1, "only 'slipped' is a new regression");
  assert.equal(result.buckets.regressed[0].name, "slipped");
  assert.equal(result.counts.unchanged, 1, "'alwaysbad' block→block is unchanged");
  assert.equal(result.worstRegression, "review");
  assert.equal(result.exitCode, 3, "exit reflects worst regression (review), not worst absolute (block)");
});

test("recheckJson is a stable machine-readable diff", async () => {
  const lockfilePath = await project(
    [["a", "1.0.0"], ["b", "1.0.0"]],
    [
      { name: "a", version: "1.0.0", verdict: "safe" },
      { name: "b", version: "1.0.0", verdict: "safe" }
    ]
  );
  const fresh = { a: "block", b: "safe" };
  const result = await recheckLockfile(lockfilePath, {
    write: false,
    evaluate: async (dep) => ({ verdict: fresh[dep.name] })
  });

  // Round-trips through JSON (no circular refs / non-serializable fields).
  const json = JSON.parse(JSON.stringify(recheckJson(result)));
  assert.equal(json.exitCode, 2);
  assert.equal(json.worstRegression, "block");
  assert.deepEqual(json.counts, {
    regressed: 1, improved: 0, unchanged: 1, noBaseline: 0, unknown: 0
  });
  // Per-dep detail present in the bucket, heavy `report` blob stripped.
  const reg = json.buckets.regressed[0];
  assert.equal(reg.name, "a");
  assert.equal(reg.baseline, "safe");
  assert.equal(reg.verdict, "block");
  assert.equal(reg.drift, "regressed");
  assert.equal("report" in reg, false, "evidence blob not included in JSON diff");
});

test("clean recheck exits 0 with empty regressed bucket", async () => {
  const lockfilePath = await project(
    [["ok", "1.0.0"]],
    [{ name: "ok", version: "1.0.0", verdict: "safe" }]
  );
  const result = await recheckLockfile(lockfilePath, {
    write: false,
    evaluate: async () => ({ verdict: "safe" })
  });
  assert.equal(recheckJson(result).exitCode, 0);
  assert.equal(recheckJson(result).buckets.regressed.length, 0);
});
