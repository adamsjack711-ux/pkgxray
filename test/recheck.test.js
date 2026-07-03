"use strict";

// T2 — verdict-drift recheck. The intelligence layer (guardExtension) is mocked
// via options.evaluate so these run offline and deterministically.

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { recheckLockfile, classifyDrift, worstVerdict } = require("../src/recheck");
const { saveDecisions, loadDecisions, lockPathForLockfile } = require("../src/triage");

// Build a project dir with a package-lock.json and a seeded .pkgxray.lock.
async function project(deps, baselines) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pkgxray-recheck-"));
  const packages = { "": { name: "demo", version: "1.0.0" } };
  for (const [name, version] of deps) {
    packages[`node_modules/${name}`] = { version };
  }
  const lockfilePath = path.join(dir, "package-lock.json");
  await fs.writeFile(lockfilePath, JSON.stringify({ lockfileVersion: 3, packages }));

  if (baselines) {
    const map = new Map();
    for (const b of baselines) {
      map.set(`${b.name}@${b.version}`, {
        name: b.name,
        version: b.version,
        decision: b.decision || "allow",
        reason: "",
        decided_at: b.checkedAt || "2026-01-01T00:00:00.000Z",
        verdict: b.verdict,
        checkedAt: b.checkedAt || "2026-01-01T00:00:00.000Z"
      });
    }
    await saveDecisions(lockPathForLockfile(lockfilePath), map);
  }
  return lockfilePath;
}

// A mocked evaluator: fresh verdict looked up per name, or throws for "explode".
function evaluatorFrom(freshByName) {
  return async (dep) => {
    const v = freshByName[dep.name];
    if (v === "explode") throw new Error("network down");
    return { verdict: v };
  };
}

test("classifyDrift buckets correctly", () => {
  assert.equal(classifyDrift("safe", "block"), "regressed");
  assert.equal(classifyDrift("safe", "review"), "regressed");
  assert.equal(classifyDrift("review", "block"), "regressed");
  assert.equal(classifyDrift("block", "safe"), "improved");
  assert.equal(classifyDrift("review", "review"), "unchanged");
  assert.equal(classifyDrift("block", "block"), "unchanged");
  assert.equal(classifyDrift(null, "safe"), "no-baseline");
  assert.equal(classifyDrift("safe", "unknown"), "unknown");
});

test("worstVerdict folds to the worst", () => {
  assert.equal(worstVerdict(["safe", "review", "safe"]), "review");
  assert.equal(worstVerdict(["safe", "block", "review"]), "block");
  assert.equal(worstVerdict([]), "safe");
});

test("a dep whose OSV status flipped shows in regressed and sets exit 2", async () => {
  const lockfilePath = await project(
    [["good", "1.0.0"], ["gonebad", "2.0.0"]],
    [
      { name: "good", version: "1.0.0", verdict: "safe" },
      { name: "gonebad", version: "2.0.0", verdict: "safe" } // was safe at install
    ]
  );
  const result = await recheckLockfile(lockfilePath, {
    versionDrift: false,
    evaluate: evaluatorFrom({ good: "safe", gonebad: "block" })
  });

  assert.equal(result.counts.regressed, 1);
  assert.equal(result.buckets.regressed[0].name, "gonebad");
  assert.equal(result.buckets.regressed[0].baseline, "safe");
  assert.equal(result.buckets.regressed[0].verdict, "block");
  assert.equal(result.counts.unchanged, 1); // good stayed safe
  assert.equal(result.exitCode, 2);
});

test("a stable dep is unchanged with exit 0", async () => {
  const lockfilePath = await project(
    [["stable", "1.0.0"]],
    [{ name: "stable", version: "1.0.0", verdict: "safe" }]
  );
  const result = await recheckLockfile(lockfilePath, {
    versionDrift: false,
    evaluate: evaluatorFrom({ stable: "safe" })
  });
  assert.equal(result.counts.unchanged, 1);
  assert.equal(result.counts.regressed, 0);
  assert.equal(result.exitCode, 0);
});

test("regression only to review yields exit 3, not 2", async () => {
  const lockfilePath = await project(
    [["soft", "1.0.0"]],
    [{ name: "soft", version: "1.0.0", verdict: "safe" }]
  );
  const result = await recheckLockfile(lockfilePath, {
    versionDrift: false,
    evaluate: evaluatorFrom({ soft: "review" })
  });
  assert.equal(result.exitCode, 3);
  assert.equal(result.buckets.regressed[0].verdict, "review");
});

test("a pre-existing block that stays block is NOT a regression (exit 0)", async () => {
  const lockfilePath = await project(
    [["alwaysbad", "1.0.0"]],
    [{ name: "alwaysbad", version: "1.0.0", verdict: "block", decision: "block" }]
  );
  const result = await recheckLockfile(lockfilePath, {
    versionDrift: false,
    evaluate: evaluatorFrom({ alwaysbad: "block" })
  });
  assert.equal(result.counts.regressed, 0);
  assert.equal(result.counts.unchanged, 1);
  assert.equal(result.exitCode, 0);
});

test("an errored recheck is reported unknown and never overwrites a good stored verdict", async () => {
  const lockfilePath = await project(
    [["flaky", "1.0.0"]],
    [{ name: "flaky", version: "1.0.0", verdict: "safe", checkedAt: "2026-01-01T00:00:00.000Z" }]
  );
  const result = await recheckLockfile(lockfilePath, {
    versionDrift: false,
    evaluate: evaluatorFrom({ flaky: "explode" })
  });
  assert.equal(result.counts.unknown, 1);
  assert.equal(result.buckets.unknown[0].error, "network down");
  assert.equal(result.exitCode, 0);

  // The stored verdict must be untouched (still safe, original checkedAt).
  const reloaded = await loadDecisions(lockPathForLockfile(lockfilePath));
  const rec = reloaded.get("flaky@1.0.0");
  assert.equal(rec.verdict, "safe");
  assert.equal(rec.checkedAt, "2026-01-01T00:00:00.000Z");
});

test("successful recheck updates the stored verdict + checkedAt", async () => {
  const lockfilePath = await project(
    [["drifter", "1.0.0"]],
    [{ name: "drifter", version: "1.0.0", verdict: "safe", checkedAt: "2026-01-01T00:00:00.000Z" }]
  );
  const result = await recheckLockfile(lockfilePath, {
    versionDrift: false,
    evaluate: evaluatorFrom({ drifter: "block" })
  });
  assert.equal(result.updated, 1);
  const rec = (await loadDecisions(lockPathForLockfile(lockfilePath))).get("drifter@1.0.0");
  assert.equal(rec.verdict, "block");
  assert.notEqual(rec.checkedAt, "2026-01-01T00:00:00.000Z"); // moved forward
});

test("--no-write leaves the lock untouched", async () => {
  const lockfilePath = await project(
    [["x", "1.0.0"]],
    [{ name: "x", version: "1.0.0", verdict: "safe", checkedAt: "2026-01-01T00:00:00.000Z" }]
  );
  await recheckLockfile(lockfilePath, {
    versionDrift: false,
    write: false,
    evaluate: evaluatorFrom({ x: "block" })
  });
  const rec = (await loadDecisions(lockPathForLockfile(lockfilePath))).get("x@1.0.0");
  assert.equal(rec.verdict, "safe", "verdict not persisted under --no-write");
});

test("a dep with no stored baseline is reported no-baseline, not regressed", async () => {
  const lockfilePath = await project([["fresh", "1.0.0"]], []); // no .pkgxray.lock
  const result = await recheckLockfile(lockfilePath, {
    versionDrift: false,
    evaluate: evaluatorFrom({ fresh: "block" })
  });
  assert.equal(result.counts.noBaseline, 1);
  assert.equal(result.counts.regressed, 0);
  assert.equal(result.exitCode, 0);
});

test("concurrent recheck of N deps folds correctly (worst regression wins exit code)", async () => {
  const deps = Array.from({ length: 25 }, (_, i) => [`p${i}`, "1.0.0"]);
  const baselines = deps.map(([name, version]) => ({ name, version, verdict: "safe" }));
  const fresh = {};
  deps.forEach(([name], i) => {
    // one review regression, one block regression, rest stable
    fresh[name] = i === 7 ? "review" : i === 18 ? "block" : "safe";
  });
  const lockfilePath = await project(deps, baselines);
  const result = await recheckLockfile(lockfilePath, {
    versionDrift: false,
    concurrency: 8,
    evaluate: async (dep) => ({ verdict: fresh[dep.name] })
  });
  assert.equal(result.counts.regressed, 2);
  assert.equal(result.worstRegression, "block");
  assert.equal(result.exitCode, 2); // block beats review
});
