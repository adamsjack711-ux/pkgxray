"use strict";

// recheck on a PyPI lockfile. Two things must hold that the npm path can't
// prove: (1) the default evaluator builds `pypi:` guard refs, not `npm:`, and
// (2) version drift uses the PEP 440 comparator — a `.post1` release that
// semver.js would discard as unparseable IS surfaced as a newer candidate.
// The registry and guard are mocked so these run offline.

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { recheckLockfile } = require("../src/recheck");
const { saveDecisions, lockPathForLockfile } = require("../src/triage");

// Write a requirements.txt (→ PyPI ecosystem) plus a .pkgxray.lock baseline.
async function pypiProject(deps, baselines) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pkgxray-recpypi-"));
  const reqPath = path.join(dir, "requirements.txt");
  await fs.writeFile(reqPath, deps.map(([n, v]) => `${n}==${v}`).join("\n") + "\n");
  const map = new Map();
  for (const b of baselines || []) {
    map.set(`${b.name}@${b.version}`, {
      name: b.name, version: b.version, decision: b.decision || "allow",
      reason: "", decided_at: "2026-01-01T00:00:00.000Z",
      verdict: b.verdict, checkedAt: "2026-01-01T00:00:00.000Z"
    });
  }
  await saveDecisions(lockPathForLockfile(reqPath), map);
  return reqPath;
}

function listVersionsFrom(byName) {
  return async (name) => ({ versions: byName[name] || [], latest: null });
}

function evaluateFrom(byKey) {
  return async (dep) => {
    const key = `${dep.name}@${dep.version}`;
    return { verdict: byKey[key] || "safe" };
  };
}

test("the default evaluator builds pypi: guard refs for a PyPI lockfile", async () => {
  const reqPath = await pypiProject(
    [["requests", "2.31.0"], ["flask", "3.0.0"]],
    [
      { name: "requests", version: "2.31.0", verdict: "safe" },
      { name: "flask", version: "3.0.0", verdict: "safe" }
    ]
  );

  // Mock quarantine (lazy-required inside makeDefaultEvaluator) to capture the
  // ref scheme without touching the network. Restore the cache entry after.
  const quarantinePath = require.resolve("../src/quarantine");
  const original = require.cache[quarantinePath];
  const captured = [];
  require.cache[quarantinePath] = {
    id: quarantinePath,
    filename: quarantinePath,
    loaded: true,
    exports: {
      guardExtension: async (ref) => {
        captured.push(ref);
        return { report: { verdict: "safe" } };
      }
    }
  };

  try {
    await recheckLockfile(reqPath, { write: false, versionDrift: false });
  } finally {
    if (original) require.cache[quarantinePath] = original;
    else delete require.cache[quarantinePath];
  }

  assert.equal(captured.length, 2, "both deps evaluated");
  for (const ref of captured) {
    assert.ok(ref.startsWith("pypi:"), `expected a pypi: ref, got ${ref}`);
  }
  assert.ok(captured.includes("pypi:requests@2.31.0"));
  assert.ok(captured.includes("pypi:flask@3.0.0"));
});

test("version drift uses the PEP 440 comparator: a .post release is a candidate", async () => {
  const reqPath = await pypiProject(
    [["demo", "1.0.0"]],
    [{ name: "demo", version: "1.0.0", verdict: "safe" }]
  );

  // "1.0.post1" is a valid PEP 440 post-release (newer than 1.0.0). semver.js
  // would parse it to null and drop it — so surfacing it proves the PyPI path
  // selected newerPypiCandidates.
  const result = await recheckLockfile(reqPath, {
    write: false,
    listVersions: listVersionsFrom({ demo: ["1.0.0", "1.0.post1"] }),
    evaluate: evaluateFrom({ "demo@1.0.0": "safe", "demo@1.0.post1": "block" })
  });

  assert.equal(result.counts.updateAvailableFlagged, 1, "the .post release is surfaced as a newer candidate");
  assert.equal(result.versionDrift.flagged[0].name, "demo");
  assert.equal(result.versionDrift.flagged[0].candidates[0].version, "1.0.post1");
  assert.equal(result.versionDrift.flagged[0].worst, "block");
  // Verdict drift is clean and version drift is informational → exit 0.
  assert.equal(result.counts.regressed, 0);
  assert.equal(result.exitCode, 0);
});

test("PEP 440 drift skips pre-releases when the pin is stable", async () => {
  const reqPath = await pypiProject(
    [["demo", "1.0.0"]],
    [{ name: "demo", version: "1.0.0", verdict: "safe" }]
  );
  const result = await recheckLockfile(reqPath, {
    write: false,
    listVersions: listVersionsFrom({ demo: ["1.0.0", "1.1.0rc1"] }),
    evaluate: evaluateFrom({ "demo@1.0.0": "safe" })
  });
  assert.equal(result.counts.updateAvailableSafe, 0);
  assert.equal(result.counts.updateAvailableFlagged, 0, "an rc is not offered against a stable pin");
});
