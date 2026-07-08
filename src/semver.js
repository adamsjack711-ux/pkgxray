"use strict";

// ---------------------------------------------------------------------------
// Minimal zero-dep semver — just enough for version-drift pre-vetting:
// parse, compare, and "is this a stable release newer than the pinned one".
//
// Deliberately NOT a full semver range engine. Lockfiles pin exact versions, so
// recheck only needs ordering + a same-major approximation of the install range.
// ---------------------------------------------------------------------------

// Parse "1.2.3", "1.2.3-beta.1", "v1.2.3+build" → {major,minor,patch,prerelease[]}
// Returns null for anything that isn't a clean semver core.
function parse(version) {
  if (typeof version !== "string") return null;
  const m = version
    .trim()
    .replace(/^v/, "")
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : []
  };
}

function isPrerelease(version) {
  const p = parse(version);
  return Boolean(p && p.prerelease.length > 0);
}

// Compare two semver strings. Returns -1 / 0 / 1. Unparseable versions sort
// last (treated as greater-than a valid one) but equal to each other, so they
// never masquerade as a newer stable release. Prerelease < its release
// (1.0.0-rc < 1.0.0), per semver §11.
function compare(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa && !pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;

  for (const key of ["major", "minor", "patch"]) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  // Numeric core equal — a prerelease has lower precedence than the release.
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1; // a is release, b is prerelease
  if (pb.prerelease.length === 0) return -1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

function comparePrerelease(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (i >= a.length) return -1; // shorter set of identifiers = lower precedence
    if (i >= b.length) return 1;
    const ai = a[i];
    const bi = b[i];
    // Per semver §11.4, a numeric identifier has NO leading zeros. Treating a
    // leading-zero form (e.g. "01") as numeric would coalesce "1" and "01" to
    // equal via Number(); classify it as alphanumeric so they order distinctly.
    const an = /^(0|[1-9]\d*)$/.test(ai);
    const bn = /^(0|[1-9]\d*)$/.test(bi);
    if (an && bn) {
      const d = Number(ai) - Number(bi);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (an !== bn) {
      return an ? -1 : 1; // numeric identifiers have lower precedence than alphanumeric
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

function gt(a, b) {
  return compare(a, b) > 0;
}

// From a list of available versions, pick the pre-vetting candidates that are
// newer than `pinned`. Returns { latest, latestInMajor } (either may be null):
//   - latest       : highest stable version overall (skips prereleases)
//   - latestInMajor: highest stable version sharing pinned's major (an approx of
//                    the install range, e.g. ^pinned), only when it differs from
//                    `latest`.
// Prereleases are excluded unless the pinned version is itself a prerelease.
function newerCandidates(pinned, versions) {
  const pinnedParsed = parse(pinned);
  const allowPre = Boolean(pinnedParsed && pinnedParsed.prerelease.length > 0);

  const newer = versions
    .filter((v) => parse(v))
    .filter((v) => allowPre || !isPrerelease(v))
    .filter((v) => gt(v, pinned));

  if (newer.length === 0) return { latest: null, latestInMajor: null };

  let latest = newer[0];
  for (const v of newer) if (gt(v, latest)) latest = v;

  let latestInMajor = null;
  if (pinnedParsed) {
    for (const v of newer) {
      const p = parse(v);
      if (p && p.major === pinnedParsed.major) {
        if (!latestInMajor || gt(v, latestInMajor)) latestInMajor = v;
      }
    }
  }
  // Only surface latestInMajor when it's a distinct candidate from latest.
  if (latestInMajor && latestInMajor === latest) latestInMajor = null;

  return { latest, latestInMajor };
}

module.exports = { parse, compare, gt, isPrerelease, newerCandidates };
