"use strict";

// ---------------------------------------------------------------------------
// Minimal zero-dep PEP 440 — the PyPI counterpart to src/semver.js. Just enough
// for version-drift pre-vetting: parse, compare, and "is this a stable release
// newer than the pinned one".
//
// PyPI versions are NOT semver. PEP 440 has epochs (`1!2.0`), a fixed
// pre-release vocabulary (a/b/rc, with alpha/beta/c/pre/preview spellings),
// post-releases (`.post1`, or the `-1` shorthand), dev-releases (`.dev0`), and
// local versions (`+local`). Ordering follows the PEP 440 summary:
//
//   1.0.dev0 < 1.0a1 < 1.0b1 < 1.0rc1 < 1.0 < 1.0.post1
//
// The comparison key mirrors the reference `packaging._cmpkey`:
//   (epoch, release, preKey, postKey, devKey) — where a dev-only release sorts
//   BEFORE any pre-release, a final release sorts AFTER all pre-releases, and a
//   post-release sorts after its final release. Local versions are ignored for
//   ordering (drift treats `1.0` and `1.0+local` as equal), matching how
//   semver.js ignores +build metadata.
//
// Deliberately NOT a full PEP 440 range/specifier engine. Lockfiles pin exact
// versions, so recheck only needs ordering + a same-"major" approximation.
// ---------------------------------------------------------------------------

// PEP 440 grammar (case-insensitive, leading `v` and surrounding space tolerated):
//   [N!]  N(.N)*  [{a|b|c|rc|alpha|beta|pre|preview}[N]]  [ .postN | -N ]  [.devN]  [+local]
const PEP440_RE = new RegExp(
  "^\\s*v?" +
    "(?:(\\d+)!)?" + //                                          1: epoch
    "(\\d+(?:\\.\\d+)*)" + //                                    2: release
    "(?:[-_.]?(a|b|c|rc|alpha|beta|pre|preview)[-_.]?(\\d+)?)?" + // 3: pre label, 4: pre num
    "(?:(?:-(\\d+))|(?:[-_.]?(post|rev|r)[-_.]?(\\d+)?))?" + //   5: post shorthand, 6: post label, 7: post num
    "(?:[-_.]?(dev)[-_.]?(\\d+)?)?" + //                         8: dev label, 9: dev num
    "(?:\\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?" + //                10: local
    "\\s*$",
  "i"
);

// Normalize a pre-release spelling to its canonical short form: alpha→a, beta→b,
// c/pre/preview/rc→rc. Returns "a" | "b" | "rc".
function normalizePreLabel(label) {
  const l = String(label).toLowerCase();
  if (l === "alpha") return "a";
  if (l === "beta") return "b";
  if (l === "c" || l === "pre" || l === "preview" || l === "rc") return "rc";
  return l; // already "a" or "b"
}

// Rank the pre-release letters: a < b < rc.
function preLetterRank(letter) {
  return letter === "a" ? 0 : letter === "b" ? 1 : 2; // rc
}

// Parse a PEP 440 version string. Returns null for anything that isn't a clean
// PEP 440 version, so an unparseable string never masquerades as a real release.
//   { epoch, release[], pre: [letter, num]|null, post: num|null,
//     dev: num|null, local: string|null }
function parsePep440(version) {
  if (typeof version !== "string") return null;
  const m = version.match(PEP440_RE);
  if (!m) return null;

  const epoch = m[1] ? Number(m[1]) : 0;
  const release = m[2].split(".").map(Number);

  let pre = null;
  if (m[3]) pre = [normalizePreLabel(m[3]), m[4] ? Number(m[4]) : 0];

  let post = null;
  if (m[5] !== undefined) post = Number(m[5]); //           the `-N` post shorthand
  else if (m[6]) post = m[7] ? Number(m[7]) : 0; //         explicit post/rev/r

  const dev = m[8] ? (m[9] ? Number(m[9]) : 0) : null;
  const local = m[10] || null;

  return { epoch, release, pre, post, dev, local };
}

// A pre-release (aN/bN/rcN) OR a dev-release is "not a stable release". A
// post-release of a final version (1.0.post1) is stable. Mirrors the intent of
// semver.js isPrerelease (don't blind-suggest a non-final version as an update).
function isPrerelease(version) {
  const p = parsePep440(version);
  return Boolean(p && (p.pre !== null || p.dev !== null));
}

// Compare the release-number tuples, padding the shorter with zeros (so 1.0 and
// 1.0.0 compare equal).
function compareRelease(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const ai = i < a.length ? a[i] : 0;
    const bi = i < b.length ? b[i] : 0;
    if (ai !== bi) return ai < bi ? -1 : 1;
  }
  return 0;
}

// Pre-release sort category, per PEP 440 _cmpkey:
//   - no pre, no post, but has dev  => sorts BEFORE everything (dev of a final)
//   - no pre (final or post-only)   => sorts AFTER all pre-releases
//   - an actual pre-release         => ordered by [letterRank, num]
function comparePre(pa, pb) {
  const cat = (p) => {
    if (p.pre === null && p.post === null && p.dev !== null) return 0; // -inf
    if (p.pre === null) return 2; // +inf
    return 1; // real pre-release
  };
  const ca = cat(pa);
  const cb = cat(pb);
  if (ca !== cb) return ca < cb ? -1 : 1;
  if (ca !== 1) return 0; // both -inf or both +inf
  const la = preLetterRank(pa.pre[0]);
  const lb = preLetterRank(pb.pre[0]);
  if (la !== lb) return la < lb ? -1 : 1;
  if (pa.pre[1] !== pb.pre[1]) return pa.pre[1] < pb.pre[1] ? -1 : 1;
  return 0;
}

// A missing post sorts before any real post (-inf); a missing dev sorts AFTER
// any real dev (+inf, i.e. a non-dev release is "later" than its dev builds).
function compareNullable(a, b, missing) {
  if (a === null && b === null) return 0;
  if (a === null) return missing === "low" ? -1 : 1;
  if (b === null) return missing === "low" ? 1 : -1;
  return a === b ? 0 : a < b ? -1 : 1;
}

// Compare two PEP 440 strings. Returns -1 / 0 / 1. Unparseable versions sort
// last (treated as greater-than a valid one) but equal to each other, so a
// malformed version never masquerades as a newer stable release — same policy
// as semver.js compare.
function comparePep440(a, b) {
  const pa = parsePep440(a);
  const pb = parsePep440(b);
  if (!pa && !pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;

  if (pa.epoch !== pb.epoch) return pa.epoch < pb.epoch ? -1 : 1;

  const rel = compareRelease(pa.release, pb.release);
  if (rel !== 0) return rel;

  const pre = comparePre(pa, pb);
  if (pre !== 0) return pre;

  const post = compareNullable(pa.post, pb.post, "low"); // missing post = -inf
  if (post !== 0) return post;

  const dev = compareNullable(pa.dev, pb.dev, "high"); // missing dev = +inf
  if (dev !== 0) return dev;

  // Local versions are ignored for drift ordering.
  return 0;
}

function gt(a, b) {
  return comparePep440(a, b) > 0;
}

// From a list of available versions, pick the pre-vetting candidates newer than
// `pinned`. Returns { latest, latestInMajor } (either may be null) with the SAME
// shape semver.newerCandidates returns, so recheck's version-drift pass is
// comparator-agnostic:
//   - latest        : highest stable version overall (skips pre/dev releases)
//   - latestInMajor : highest stable version sharing pinned's epoch + first
//                     release component (the PEP 440 analog of "same major"),
//                     only when it differs from `latest`.
// Pre/dev releases are excluded unless the pinned version is itself one.
function newerPypiCandidates(pinned, versions) {
  const pinnedParsed = parsePep440(pinned);
  const allowPre = Boolean(pinnedParsed && (pinnedParsed.pre !== null || pinnedParsed.dev !== null));

  const newer = versions
    .filter((v) => parsePep440(v))
    .filter((v) => allowPre || !isPrerelease(v))
    .filter((v) => gt(v, pinned));

  if (newer.length === 0) return { latest: null, latestInMajor: null };

  let latest = newer[0];
  for (const v of newer) if (gt(v, latest)) latest = v;

  let latestInMajor = null;
  if (pinnedParsed) {
    const pinnedMajor = pinnedParsed.release[0] || 0;
    for (const v of newer) {
      const p = parsePep440(v);
      if (p && p.epoch === pinnedParsed.epoch && (p.release[0] || 0) === pinnedMajor) {
        if (!latestInMajor || gt(v, latestInMajor)) latestInMajor = v;
      }
    }
  }
  if (latestInMajor && latestInMajor === latest) latestInMajor = null;

  return { latest, latestInMajor };
}

module.exports = { parsePep440, comparePep440, gt, isPrerelease, newerPypiCandidates };
