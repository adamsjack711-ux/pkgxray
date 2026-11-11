"use strict";

// T3 — version drift (newer-version pre-vetting). Registry (listVersions) and
// the guard (evaluate) are both mocked so these run offline.

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { recheckLockfile, recheckJson, renderRecheckText } = require("../src/recheck");
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

test("when EVERY newer candidate's guard errors, it is NOT reported as a clean update", async () => {
  const lockfilePath = await project(
    [["riskyupdate", "1.0.0"]],
    [{ name: "riskyupdate", version: "1.0.0", verdict: "safe" }]
  );
  const result = await recheckLockfile(lockfilePath, {
    write: false,
    listVersions: listVersionsFrom({ riskyupdate: ["1.0.0", "1.1.0", "2.0.0"] }),
    // pinned stays safe (isolates version drift); every newer candidate throws.
    evaluate: async (dep) => {
      if (dep.version === "1.0.0") return { verdict: "safe" };
      throw new Error("guard scan failed");
    }
  });
  // Fail-open guard: no candidate could be vetted => must NOT be updateAvailableSafe.
  assert.equal(result.counts.updateAvailableSafe, 0, "unvetted newer version is not a clean update");
  assert.equal(result.versionDrift.available.length, 0);
  assert.equal(result.versionDrift.unknown.length, 1);
  assert.equal(result.versionDrift.unknown[0].name, "riskyupdate");
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

test("one SAFE candidate cannot mask an unknown candidate in either order", async t => {
  const lockfilePath = await project([["widget", "1.0.0"]], []);
  t.after(() => fs.rm(path.dirname(lockfilePath), { recursive: true, force: true }));
  for (const unknownVersion of ["1.1.0", "2.0.0"]) {
    for (const failure of ["throw", "invalid-verdict"]) {
      const result = await recheckLockfile(lockfilePath, {
        write: false, failOnAvailableUpdates: true,
        listVersions: listVersionsFrom({ widget: ["1.0.0", "1.1.0", "2.0.0"] }),
        evaluate: async dep => {
          if (dep.version !== unknownVersion) return { verdict: "safe" };
          if (failure === "throw") throw new Error("scan failed");
          return { verdict: "SAFE-but-unverified" };
        }
      });
      assert.equal(result.versionDrift.available.length, 0);
      assert.equal(result.versionDrift.unknown.length, 1);
      assert.equal(result.counts.updateAvailableSafe, 0);
      assert.equal(result.exitCode, 3, "strict update check cannot pass incomplete vetting");
      const text = renderRecheckText(result);
      assert.match(text, /UPDATE CHECK INCOMPLETE/);
      assert.match(text, new RegExp(`${unknownVersion}=block`));
      assert.doesNotMatch(text, /Update available \(guards clean\)/);
    }
  }
});

test("known BLOCK is retained alongside unknown candidates and wins the strict exit", async t => {
  const lockfilePath = await project([["widget", "1.0.0"]], []);
  t.after(() => fs.rm(path.dirname(lockfilePath), { recursive: true, force: true }));
  const result = await recheckLockfile(lockfilePath, {
    write: false, failOnAvailableUpdates: true,
    listVersions: listVersionsFrom({ widget: ["1.0.0", "1.1.0", "2.0.0"] }),
    evaluate: async dep => ({ verdict: dep.version === "2.0.0" ? "block" : dep.version === "1.1.0" ? "unknown" : "safe" })
  });
  assert.equal(result.versionDrift.flagged[0].worst, "block");
  assert.equal(result.versionDrift.unknown.length, 1);
  assert.equal(result.exitCode, 2);
});

test("upgrade finding deltas use the fresh pinned scan, survive JSON, and do not auto-approve", async t => {
  const lockfilePath = await project([["widget", "1.0.0"]], [{ name: "widget", version: "1.0.0", verdict: "safe" }]);
  t.after(() => fs.rm(path.dirname(lockfilePath), { recursive: true, force: true }));
  const hook = { severity: "medium", category: "install-hook", file: "package.json", snippet: "node setup.js" };
  const newFinding = { severity: "medium", category: "remote-code-load", file: "index.js\u001b[2J", snippet: "untrusted-source-command" };
  const result = await recheckLockfile(lockfilePath, {
    write: false,
    listVersions: listVersionsFrom({ widget: ["1.0.0", "1.1.0"] }),
    evaluate: async dep => ({ verdict: "review", report: { findings: dep.version === "1.0.0" ? [hook] : [hook, newFinding] },
      assessment: { engine: { buildId: "fixture-build" }, policySha256: "fixture-policy",
        authorization: { behavioralCoverage: "completed", mandatoryHoldReasons: [], explicitOverride: false },
        checks: { source: "completed", vulnerabilities: "completed" } } })
  });
  const candidate = recheckJson(result).versionDrift.updateAvailableFlagged[0].candidates[0];
  assert.equal(candidate.verdict, "block");
  assert.equal(candidate.securityChanges.counts.added, 1);
  assert.equal(candidate.securityChanges.added[0].category, "remote-code-load");
  const text = renderRecheckText(result);
  assert.match(text, /Security changes:/);
  assert.match(text, /remote-code-load/);
  assert.equal(text.includes("\u001b"), false);
  assert.equal(JSON.stringify(candidate).includes("untrusted-source-command"), false);
});

test("unknown registry is informational normally but fails an explicitly strict update check", async t => {
  const lockfilePath = await project([["widget", "1.0.0"]], []);
  t.after(() => fs.rm(path.dirname(lockfilePath), { recursive: true, force: true }));
  for (const strict of [false, true]) {
    const result = await recheckLockfile(lockfilePath, {
      write: false, failOnAvailableUpdates: strict, listVersions: async () => { throw new Error("offline"); }, evaluate: evaluateFrom({})
    });
    assert.equal(result.exitCode, strict ? 3 : 0);
    assert.match(renderRecheckText(result), /offline/);
  }
});

test("invalid evaluator verdict cannot replace the pinned verdict baseline", async t => {
  const lockfilePath = await project([["widget", "1.0.0"]], [{ name: "widget", version: "1.0.0", verdict: "safe" }]);
  t.after(() => fs.rm(path.dirname(lockfilePath), { recursive: true, force: true }));
  const lockPath = lockPathForLockfile(lockfilePath);
  const before = await fs.readFile(lockPath, "utf8");
  const result = await recheckLockfile(lockfilePath, { versionDrift: false, evaluate: async () => ({ verdict: "unexpected" }) });
  assert.equal(result.buckets.unknown[0].verdict, "unknown");
  assert.equal(result.updated, 0);
  assert.equal(await fs.readFile(lockPath, "utf8"), before);
});

test("SAFE cannot contradict mandatory assessment coverage for candidates or pinned baselines", async t => {
  const lockfilePath = await project([["widget", "1.0.0"]], [{ name: "widget", version: "1.0.0", verdict: "safe" }]);
  t.after(() => fs.rm(path.dirname(lockfilePath), { recursive: true, force: true }));
  const complete = {
    checks: { source: "completed", vulnerabilities: "completed", provenance: "absent" },
    authorization: { behavioralCoverage: "completed", mandatoryHoldReasons: [], explicitOverride: false }
  };
  const variants = [
    { ...complete, checks: { ...complete.checks, source: "partial" } },
    { ...complete, checks: { ...complete.checks, source: "disabled" } },
    { ...complete, checks: { ...complete.checks, vulnerabilities: "failed" } },
    { ...complete, checks: { ...complete.checks, provenance: "invalid" } },
    { ...complete, authorization: { ...complete.authorization, behavioralCoverage: "partial" } },
    { ...complete, authorization: { ...complete.authorization, mandatoryHoldReasons: ["flow-analysis-gap"], explicitOverride: true } },
    {}
  ];
  for (const assessment of variants) {
    const result = await recheckLockfile(lockfilePath, {
      write: false, failOnAvailableUpdates: true,
      listVersions: listVersionsFrom({ widget: ["1.0.0", "1.1.0"] }),
      evaluate: async dep => ({ verdict: "safe", assessment: dep.version === "1.0.0" ? complete : assessment })
    });
    assert.equal(result.counts.updateAvailableSafe, 0);
    assert.equal(result.versionDrift.unknown.length, 1);
    assert.equal(result.versionDrift.unknown[0].candidates[0].verdict, "unknown");
    assert.match(result.versionDrift.unknown[0].candidates[0].error, /conflicts with guard assessment/);
    assert.equal(result.exitCode, 3);

    const lockPath = lockPathForLockfile(lockfilePath);
    const before = await fs.readFile(lockPath, "utf8");
    const pinned = await recheckLockfile(lockfilePath, { versionDrift: false, evaluate: async () => ({ verdict: "safe", assessment }) });
    assert.equal(pinned.buckets.unknown[0].verdict, "unknown");
    assert.equal(pinned.updated, 0);
    assert.equal(await fs.readFile(lockPath, "utf8"), before);
  }
  const clean = await recheckLockfile(lockfilePath, {
    write: false, failOnAvailableUpdates: true,
    listVersions: listVersionsFrom({ widget: ["1.0.0", "1.1.0"] }),
    evaluate: async () => ({ verdict: "safe", assessment: complete })
  });
  assert.equal(clean.counts.updateAvailableSafe, 1);
  assert.equal(clean.exitCode, 0);
});
