"use strict";

// PEP 440 comparator — the PyPI counterpart to semver.js, used by recheck's
// version-drift pass. Covers epochs, the pre/post/dev ordering, spelling
// normalization, and newer-candidate selection.

const assert = require("node:assert/strict");
const test = require("node:test");

const { parsePep440, comparePep440, gt, isPrerelease, newerPypiCandidates } = require("../src/pep440");

test("parses the core release + epoch", () => {
  assert.deepEqual(parsePep440("2.31.0").release, [2, 31, 0]);
  assert.equal(parsePep440("2.31.0").epoch, 0);
  const epoched = parsePep440("1!2.0");
  assert.equal(epoched.epoch, 1);
  assert.deepEqual(epoched.release, [2, 0]);
  assert.equal(parsePep440("v1.2.3").release.join("."), "1.2.3", "leading v tolerated");
});

test("normalizes pre-release spellings a/b/rc", () => {
  assert.deepEqual(parsePep440("1.0alpha1").pre, ["a", 1]);
  assert.deepEqual(parsePep440("1.0beta2").pre, ["b", 2]);
  assert.deepEqual(parsePep440("1.0c3").pre, ["rc", 3]);
  assert.deepEqual(parsePep440("1.0preview0").pre, ["rc", 0]);
  assert.deepEqual(parsePep440("1.0.rc4").pre, ["rc", 4], "dot separator");
  assert.deepEqual(parsePep440("1.0-a5").pre, ["a", 5], "dash separator");
});

test("parses post (both forms) and dev", () => {
  assert.equal(parsePep440("1.0.post1").post, 1);
  assert.equal(parsePep440("1.0-2").post, 2, "the -N post shorthand");
  assert.equal(parsePep440("1.0.rev3").post, 3);
  assert.equal(parsePep440("1.0.dev0").dev, 0);
  assert.equal(parsePep440("1.0").post, null);
  assert.equal(parsePep440("1.0").dev, null);
});

test("rejects non-PEP-440 strings", () => {
  assert.equal(parsePep440(""), null);
  assert.equal(parsePep440("not-a-version"), null);
  assert.equal(parsePep440(null), null);
  assert.equal(parsePep440("1.x"), null);
});

test("full ordering: dev < pre < final < post", () => {
  const ordered = [
    "1.0.dev0",
    "1.0.dev1",
    "1.0a1",
    "1.0a2",
    "1.0b1",
    "1.0rc1",
    "1.0",
    "1.0.post0",
    "1.0.post1"
  ];
  for (let i = 0; i < ordered.length - 1; i += 1) {
    assert.equal(
      comparePep440(ordered[i], ordered[i + 1]),
      -1,
      `${ordered[i]} should be < ${ordered[i + 1]}`
    );
    assert.equal(comparePep440(ordered[i + 1], ordered[i]), 1);
  }
});

test("a dev of a pre-release sorts before that pre-release", () => {
  assert.equal(comparePep440("1.0a1.dev0", "1.0a1"), -1);
  assert.equal(comparePep440("1.0.post1.dev0", "1.0.post1"), -1);
});

test("epoch dominates the release number", () => {
  // 1!1.0 is newer than 2.0 despite a smaller release number.
  assert.equal(gt("1!1.0", "2.0"), true);
  assert.equal(comparePep440("1.0", "1!0.1"), -1);
});

test("release padding treats 1.0 and 1.0.0 as equal", () => {
  assert.equal(comparePep440("1.0", "1.0.0"), 0);
  assert.equal(comparePep440("1.2", "1.2.0.0"), 0);
});

test("local versions are ignored for ordering", () => {
  assert.equal(comparePep440("1.0+local", "1.0"), 0);
});

test("unparseable versions sort last but equal to each other", () => {
  assert.equal(comparePep440("garbage", "1.0"), 1, "invalid sorts after valid");
  assert.equal(comparePep440("1.0", "garbage"), -1);
  assert.equal(comparePep440("garbage", "junk"), 0);
});

test("isPrerelease: pre and dev are unstable, post and final are stable", () => {
  assert.equal(isPrerelease("1.0rc1"), true);
  assert.equal(isPrerelease("1.0.dev3"), true);
  assert.equal(isPrerelease("1.0"), false);
  assert.equal(isPrerelease("1.0.post2"), false, "a post of a final release is stable");
});

test("newerPypiCandidates skips pre-releases and picks latest + latest-in-major", () => {
  const picked = newerPypiCandidates("1.0.0", ["1.0.0", "1.1.0", "1.2.0rc1", "2.0.0"]);
  assert.equal(picked.latest, "2.0.0", "highest stable overall");
  assert.equal(picked.latestInMajor, "1.1.0", "highest stable sharing the first release component");
});

test("newerPypiCandidates collapses latestInMajor when it equals latest", () => {
  const picked = newerPypiCandidates("1.0.0", ["1.0.0", "1.5.0"]);
  assert.equal(picked.latest, "1.5.0");
  assert.equal(picked.latestInMajor, null, "not surfaced twice");
});

test("newerPypiCandidates allows pre-releases only when the pin is itself a pre-release", () => {
  const fromStable = newerPypiCandidates("1.0.0", ["1.0.0", "1.1.0rc1"]);
  assert.equal(fromStable.latest, null, "a stable pin ignores newer pre-releases");

  const fromPre = newerPypiCandidates("2.0.0rc1", ["2.0.0rc1", "2.0.0rc2", "2.0.0"]);
  assert.equal(fromPre.latest, "2.0.0", "a pre-release pin can see newer pre + final");
});

test("newerPypiCandidates respects epochs when grouping latestInMajor", () => {
  const picked = newerPypiCandidates("1.0.0", ["1.0.0", "1.4.0", "1!1.0.0"]);
  assert.equal(picked.latest, "1!1.0.0", "the epoch-1 release is newest overall");
  assert.equal(picked.latestInMajor, "1.4.0", "in-major stays within the pinned epoch+major");
});
