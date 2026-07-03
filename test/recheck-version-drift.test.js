"use strict";

// T3 — version drift (newer-version pre-vetting). Registry (listVersions) and
// the guard (evaluate) are both mocked so these run offline.

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { recheckLockfile } = require("../src/recheck");
const { saveDecisions, lockPathForLockfile } = require("../src/triage");

async function project(deps, baselines) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pkgxray-vd-"));
  const packages = { "": { name: "demo", version: "1.0.0" } };
  for (const [name, version] of deps) packages[`node_modules/${name}`] = { version };
  const lockfilePath = path.join(dir, "package-lock.json");
  await fs.writeFile(lockfilePath, JSON.stringify({ lockfileVersion: 3, packages }));
  const map = new Map();
  for (const b of baselines || []) {
    map.set(`${b.name}@${b.version}`, {
      name: b.name, version: b.version, decision: b.decision || "allow",
      reason: "", decided_at: "2026-01-01T00:00:00.000Z",
      verdict: b.verdict, checkedAt: "2026-01-01T00:00:00.000Z"
    });
  }
  await saveDecisions(lockPathForLockfile(lockfilePath), map);
  return lockfilePath;
}

// Mocked registry: versions per package name.
function listVersionsFrom(byName) {
  return async (name) => ({ versions: byName[name] || [], latest: null });
}

// Mocked guard: verdict looked up by "name@version"; pinned stays safe so
// verdict-drift never fires and we isolate version-drift behaviour.
function evaluateFrom(byKey) {
  return async (dep) => {
    const key = `${dep.name}@${dep.version}`;
    return { verdict: byKey[key] || "safe" };
  };
}

test("a dep with a newer flagged version surfaces in updateAvailableFlagged, exit unchanged", async () => {
  const lockfilePath = await project(
    [["widget", "1.0.0"]],
    [{ name: "widget", version: "1.0.0", verdict: "safe" }]
  );
  const result = await recheckLockfile(lockfilePath, {
    write: false,
    listVersions: listVersionsFrom({ widget: ["1.0.0", "1.1.0", "2.0.0"] }),
    // pinned 1.0.0 is safe; newer 2.0.0 (latest) is block, 1.1.0 (in-major) safe
    evaluate: evaluateFrom({ "widget@1.0.0": "safe", "widget@2.0.0": "block", "widget@1.1.0": "safe" })
  });

  assert.equal(result.counts.updateAvailableFlagged, 1);
  assert.equal(result.versionDrift.flagged[0].name, "widget");
  assert.equal(result.versionDrift.flagged[0].worst, "block");
  // Verdict drift is clean, and version drift is informational => exit 0.
  assert.equal(result.counts.regressed, 0);
  assert.equal(result.exitCode, 0, "available flagged update does not fail the run by default");
});

test("--fail-on-available-updates makes a flagged update count toward the exit code", async () => {
  const lockfilePath = await project(
    [["widget", "1.0.0"]],
    [{ name: "widget", version: "1.0.0", verdict: "safe" }]
  );
  const result = await recheckLockfile(lockfilePath, {
    write: false,
    failOnAvailableUpdates: true,
    listVersions: listVersionsFrom({ widget: ["1.0.0", "2.0.0"] }),
    evaluate: evaluateFrom({ "widget@1.0.0": "safe", "widget@2.0.0": "block" })
  });
  assert.equal(result.exitCode, 2, "flag folds worst flagged-update verdict (block) into exit");
});

test("--fail-on-available-updates with a review-only flagged update yields exit 3", async () => {
  const lockfilePath = await project(
    [["widget", "1.0.0"]],
    [{ name: "widget", version: "1.0.0", verdict: "safe" }]
  );
  const result = await recheckLockfile(lockfilePath, {
    write: false,
    failOnAvailableUpdates: true,
    listVersions: listVersionsFrom({ widget: ["1.0.0", "1.5.0"] }),
    evaluate: evaluateFrom({ "widget@1.0.0": "safe", "widget@1.5.0": "review" })
  });
  assert.equal(result.exitCode, 3);
});

test("a dep already on latest reports nothing for version drift", async () => {
  const lockfilePath = await project(
    [["settled", "3.0.0"]],
    [{ name: "settled", version: "3.0.0", verdict: "safe" }]
  );
  const result = await recheckLockfile(lockfilePath, {
    write: false,
    listVersions: listVersionsFrom({ settled: ["1.0.0", "2.0.0", "3.0.0"] }),
    evaluate: evaluateFrom({})
  });
  assert.equal(result.counts.updateAvailableSafe, 0);
  assert.equal(result.counts.updateAvailableFlagged, 0);
  assert.equal(result.versionDrift.available.length, 0);
  assert.equal(result.versionDrift.flagged.length, 0);
});

test("a newer version that guards clean is updateAvailableSafe", async () => {
  const lockfilePath = await project(
    [["fresh", "1.0.0"]],
    [{ name: "fresh", version: "1.0.0", verdict: "safe" }]
  );
  const result = await recheckLockfile(lockfilePath, {
    write: false,
    listVersions: listVersionsFrom({ fresh: ["1.0.0", "1.1.0"] }),
    evaluate: evaluateFrom({ "fresh@1.0.0": "safe", "fresh@1.1.0": "safe" })
  });
  assert.equal(result.counts.updateAvailableSafe, 1);
  assert.equal(result.counts.updateAvailableFlagged, 0);
  assert.equal(result.exitCode, 0);
});

test("registry error puts the dep in version-drift unknown, not a false 'no update'", async () => {
  const lockfilePath = await project(
    [["offline", "1.0.0"]],
    [{ name: "offline", version: "1.0.0", verdict: "safe" }]
  );
  const result = await recheckLockfile(lockfilePath, {
    write: false,
    listVersions: async () => { throw new Error("registry 503"); },
    evaluate: evaluateFrom({ "offline@1.0.0": "safe" })
  });
  assert.equal(result.versionDrift.unknown.length, 1);
  assert.equal(result.versionDrift.unknown[0].error, "registry 503");
  assert.equal(result.exitCode, 0);
});

test("version drift can be turned off entirely", async () => {
  const lockfilePath = await project(
    [["widget", "1.0.0"]],
    [{ name: "widget", version: "1.0.0", verdict: "safe" }]
  );
  let listCalled = false;
  const result = await recheckLockfile(lockfilePath, {
    write: false,
    versionDrift: false,
    listVersions: async () => { listCalled = true; return { versions: [] }; },
    evaluate: evaluateFrom({ "widget@1.0.0": "safe" })
  });
  assert.equal(listCalled, false, "registry not queried when version drift is off");
  assert.equal(result.versionDrift.flagged.length, 0);
});
