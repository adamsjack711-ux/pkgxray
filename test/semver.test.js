"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { parse, compare, gt, isPrerelease, newerCandidates } = require("../src/semver");

test("parse handles core, prerelease, v-prefix, build metadata", () => {
  assert.deepEqual(parse("1.2.3"), { major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.deepEqual(parse("v1.2.3"), { major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.deepEqual(parse("1.2.3-beta.1"), { major: 1, minor: 2, patch: 3, prerelease: ["beta", "1"] });
  assert.deepEqual(parse("1.2.3+build"), { major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.equal(parse("not-semver"), null);
});

test("compare orders by major.minor.patch and prerelease precedence", () => {
  assert.equal(compare("1.0.0", "2.0.0"), -1);
  assert.equal(compare("1.2.0", "1.1.9"), 1);
  assert.equal(compare("1.0.0", "1.0.0"), 0);
  assert.equal(compare("1.0.0-rc.1", "1.0.0"), -1, "prerelease < release");
  assert.equal(compare("1.0.0-alpha", "1.0.0-beta"), -1);
  assert.equal(compare("1.0.0-alpha.1", "1.0.0-alpha"), 1, "more identifiers = higher");
});

test("gt / isPrerelease", () => {
  assert.equal(gt("2.0.0", "1.9.9"), true);
  assert.equal(gt("1.0.0", "1.0.0"), false);
  assert.equal(isPrerelease("1.0.0-rc.1"), true);
  assert.equal(isPrerelease("1.0.0"), false);
});

test("newerCandidates picks latest + latest-in-major, skipping prereleases", () => {
  const versions = ["1.0.0", "1.1.0", "1.2.0", "2.0.0", "2.1.0", "2.2.0-beta.1"];
  const { latest, latestInMajor } = newerCandidates("1.0.0", versions);
  assert.equal(latest, "2.1.0", "highest stable overall (beta skipped)");
  assert.equal(latestInMajor, "1.2.0", "highest stable sharing pinned major 1");
});

test("newerCandidates returns nulls when pinned is already latest", () => {
  const { latest, latestInMajor } = newerCandidates("3.0.0", ["1.0.0", "2.0.0", "3.0.0"]);
  assert.equal(latest, null);
  assert.equal(latestInMajor, null);
});

test("newerCandidates collapses latestInMajor when it equals latest", () => {
  // Only the same major has newer versions => latest and latest-in-major are the
  // same version, so latestInMajor is dropped to avoid a duplicate candidate.
  const { latest, latestInMajor } = newerCandidates("1.0.0", ["1.0.0", "1.1.0", "1.2.0"]);
  assert.equal(latest, "1.2.0");
  assert.equal(latestInMajor, null);
});

test("newerCandidates surfaces prereleases only when pinned is itself a prerelease", () => {
  const versions = ["1.0.0-rc.1", "1.0.0-rc.2", "1.0.0"];
  const stablePinned = newerCandidates("1.0.0", ["1.0.0", "1.1.0-rc.1"]);
  assert.equal(stablePinned.latest, null, "no stable newer version");
  const prePinned = newerCandidates("1.0.0-rc.1", versions);
  assert.equal(prePinned.latest, "1.0.0", "release is newer than the pinned rc");
});
