"use strict";

// T1 — `.pkgxray.lock` record gains a `checkedAt` baseline + stored `verdict`
// for the recheck monitoring tier. Legacy records without them must still load.

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  loadDecisions,
  loadDecisionsSync,
  saveDecisions,
  normalizeRecord,
  isStale,
  lockPathForLockfile
} = require("../src/triage");

async function tmpLock(contents) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pkgxray-rec-"));
  const lockPath = path.join(dir, ".pkgxray.lock");
  if (contents !== undefined) {
    await fs.writeFile(lockPath, JSON.stringify(contents, null, 2));
  }
  return lockPath;
}

test("record roundtrips with checkedAt + verdict", async () => {
  const lockPath = await tmpLock();
  const checkedAt = "2026-07-01T00:00:00.000Z";
  const map = new Map([
    ["lodash@4.17.21", {
      name: "lodash",
      version: "4.17.21",
      decision: "allow",
      reason: "",
      decided_at: checkedAt,
      verdict: "safe",
      checkedAt
    }]
  ]);
  await saveDecisions(lockPath, map);

  const reloaded = await loadDecisions(lockPath);
  const rec = reloaded.get("lodash@4.17.21");
  assert.equal(rec.verdict, "safe");
  assert.equal(rec.checkedAt, checkedAt);
  // Sync loader must agree with the async one.
  const recSync = loadDecisionsSync(lockPath).get("lodash@4.17.21");
  assert.equal(recSync.verdict, "safe");
  assert.equal(recSync.checkedAt, checkedAt);

  // The serialized JSON actually carries the new fields.
  const raw = JSON.parse(await fs.readFile(lockPath, "utf8"));
  assert.equal(raw.schemaVersion, 1); // additive — no bump
  assert.equal(raw.decisions[0].verdict, "safe");
  assert.equal(raw.decisions[0].checkedAt, checkedAt);
});

test("legacy record without checkedAt loads and is reported stale", async () => {
  // A record written by an older pkgxray — human decision only, no compute
  // baseline. It must load without crashing.
  const lockPath = await tmpLock({
    schemaVersion: 1,
    decisions: [
      { name: "left-pad", version: "1.3.0", decision: "allow", reason: "", decided_at: "2026-01-01T00:00:00.000Z" }
    ]
  });

  const map = await loadDecisions(lockPath);
  const rec = map.get("left-pad@1.3.0");
  assert.ok(rec, "legacy record still loads");
  assert.equal(rec.verdict, null, "no stored verdict => unknown");
  assert.equal(rec.checkedAt, null, "missing checkedAt is preserved as null, not fabricated");
  assert.equal(isStale(rec), true, "unknown-age verdict is stale");
});

test("isStale honours a TTL when checkedAt is present", () => {
  const fresh = normalizeRecord({
    name: "a", version: "1.0.0", decision: "allow",
    checkedAt: new Date().toISOString(), verdict: "safe"
  });
  const old = normalizeRecord({
    name: "b", version: "1.0.0", decision: "allow",
    checkedAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(), verdict: "safe"
  });
  const dayMs = 24 * 3600 * 1000;
  assert.equal(isStale(fresh, dayMs), false, "recent verdict within TTL is fresh");
  assert.equal(isStale(old, dayMs), true, "verdict older than TTL is stale");
  assert.equal(isStale(fresh), false, "no TTL + valid checkedAt => not stale");
  assert.equal(isStale(old), false, "no TTL => age irrelevant, only presence matters");
});

test("normalizeRecord rejects invalid records and ignores bad verdicts", () => {
  assert.equal(normalizeRecord(null), null);
  assert.equal(normalizeRecord({ name: "x" }), null, "missing version");
  assert.equal(normalizeRecord({ name: "x", version: "1", decision: "maybe" }), null, "bad decision");
  const rec = normalizeRecord({ name: "x", version: "1", decision: "allow", verdict: "bogus" });
  assert.equal(rec.verdict, null, "unknown verdict string is dropped to null");
});

test("saveDecisions omits verdict/checkedAt for human-only records", async () => {
  const lockPath = await tmpLock();
  await saveDecisions(lockPath, new Map([
    ["x@1.0.0", { name: "x", version: "1.0.0", decision: "block", reason: "", decided_at: "2026-01-01T00:00:00.000Z" }]
  ]));
  const raw = JSON.parse(await fs.readFile(lockPath, "utf8"));
  assert.equal("verdict" in raw.decisions[0], false, "no null verdict field");
  assert.equal("checkedAt" in raw.decisions[0], false, "no null checkedAt field");
});

test("lockPathForLockfile resolves alongside the lockfile", () => {
  assert.equal(
    lockPathForLockfile("/proj/package-lock.json"),
    path.join("/proj", ".pkgxray.lock")
  );
});
