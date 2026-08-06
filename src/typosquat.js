"use strict";

// Opt-in typosquat / name-similarity heuristic.
//
// Disabled by default: edit-distance against popular package names has a high
// false-positive rate on intentional short names. Enable with CLI `--typosquat`
// or `.pkgxray.json` `{ "typosquat": true }` (the object form
// `{ "typosquat": { "maxDistance": 2, "minLen": 6 } }` tunes the heuristic).
//
// Defaults are deliberately high-precision so the opt-in signal is worth acting
// on: maxDistance 1 (single insertion/deletion/substitution — the dominant
// typosquat shape) and minLen 5 (a Levenshtein match on a 3-4 char name is
// mostly noise). Loosen to `{ "maxDistance": 2 }` to also catch transpositions
// (e.g. lodahs→lodash, which plain Levenshtein scores as distance 2) and
// two-character edits, at the cost of more false positives.

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_DISTANCE = 1;
const DEFAULT_MIN_LEN = 5;

// Lives under src/data/ so the "src/" entry in package.json "files" ships it
// in the packed tarball — installed copies must get the full list, not the
// emergency fallback below.
const POPULAR_LIST_PATH = path.join(__dirname, "data", "top1000.txt");

let cachedPopular = null;
let cachedPopularSet = null;

function loadPopularNames() {
  if (cachedPopular) return cachedPopular;
  try {
    const text = fs.readFileSync(POPULAR_LIST_PATH, "utf8");
    cachedPopular = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch (error) {
    // Never degrade silently: the fallback covers 14 names, not ~1000, so
    // near-misses of everything else would go unflagged. Caching means this
    // warns once per process.
    process.stderr.write(
      `pkgxray: could not load popular-package list (${error.message}); typosquat detection degraded to a minimal built-in list\n`
    );
    cachedPopular = [
      "lodash", "react", "express", "chalk", "commander", "axios", "vue",
      "webpack", "typescript", "eslint", "prettier", "next", "jest", "mocha"
    ];
  }
  return cachedPopular;
}

// Normalized lookup set, built once per process for the default list (it never
// changes after load). Caller-supplied lists are never cached into module state.
function popularNameSet(popular) {
  if (popular === cachedPopular) {
    if (!cachedPopularSet) cachedPopularSet = new Set(popular.map((p) => baseName(p)));
    return cachedPopularSet;
  }
  return new Set(popular.map((p) => baseName(p)));
}

function levenshtein(a, b) {
  const s = String(a);
  const t = String(b);
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  const prev = new Array(t.length + 1);
  const cur = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= t.length; j++) prev[j] = cur[j];
  }
  return prev[t.length];
}

function baseName(packageName) {
  const n = String(packageName || "").trim().toLowerCase();
  if (!n) return "";
  if (n.startsWith("@")) {
    const parts = n.split("/");
    return parts[1] || parts[0].slice(1);
  }
  return n;
}

/**
 * Returns zero or more findings when `packageName` is suspiciously close to a
 * popular package name and is not itself on the popular list.
 */
function typosquatFindings(packageName, options = {}) {
  const name = baseName(packageName);
  if (!name || name.length < (options.minLen || DEFAULT_MIN_LEN)) return [];

  const popular = options.popularNames || loadPopularNames();
  const popularSet = popularNameSet(popular);
  if (popularSet.has(name)) return [];

  const maxDist = Number.isFinite(options.maxDistance) ? options.maxDistance : DEFAULT_DISTANCE;
  const hits = [];
  for (const candidate of popular) {
    const c = baseName(candidate);
    if (!c || Math.abs(c.length - name.length) > maxDist) continue;
    const d = levenshtein(name, c);
    if (d > 0 && d <= maxDist) {
      hits.push({ name: c, distance: d });
    }
  }
  if (hits.length === 0) return [];

  hits.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
  const top = hits.slice(0, 5);
  const examples = top.map((h) => `${h.name} (d=${h.distance})`).join(", ");

  return [
    {
      severity: "medium",
      category: "typosquat-similarity",
      file: "package.json",
      snippet: String(packageName),
      rationale:
        `Package name "${packageName}" is within edit-distance ${maxDist} of popular package(s): ${examples}. ` +
        "Opt-in typosquat heuristic — confirm the intended package before installing. " +
        "Disable by omitting --typosquat / config typosquat:false."
    }
  ];
}

module.exports = {
  typosquatFindings,
  levenshtein,
  baseName,
  loadPopularNames,
  // exported for tests
  popularNameSet,
  POPULAR_LIST_PATH
};
