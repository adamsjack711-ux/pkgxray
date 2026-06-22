"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".github",
  ".vscode",
  ".idea",
  "coverage",
  "__pycache__"
]);

// File extensions/patterns that don't carry attack signal — we hash neither
// the npm copy nor the github copy, which keeps the diff fast on huge repos
// like TypeScript (thousands of .d.ts files in lib/). Anything that's
// minified, generated, or pure declarations falls here.
const HASH_SKIP_PATTERNS = [
  /\.d\.ts$/i,
  /\.d\.cts$/i,
  /\.d\.mts$/i,
  /\.min\.js$/i,
  /\.min\.mjs$/i,
  /\.min\.cjs$/i,
  /\.min\.css$/i,
  /\.js\.map$/i,
  /\.css\.map$/i,
  /\.tsbuildinfo$/i,
  /\.snap$/i
];

function shouldSkipHash(rel) {
  return HASH_SKIP_PATTERNS.some((re) => re.test(rel));
}

// File patterns that are expected to differ — never used to drive findings.
const ALWAYS_IGNORE = [
  /(?:^|\/)package\.json$/,
  /(?:^|\/)package-lock\.json$/,
  /(?:^|\/)yarn\.lock$/,
  /(?:^|\/)pnpm-lock\.yaml$/,
  /(?:^|\/)\.npmignore$/,
  /(?:^|\/)\.gitignore$/,
  /(?:^|\/)\.gitattributes$/,
  /(?:^|\/)CHANGELOG(?:\.md)?$/i,
  /(?:^|\/)CONTRIBUTING(?:\.md)?$/i,
  /(?:^|\/)\.npmrc$/
];

// Patterns that mean "this is build output" — only flagged if no build script
// exists. With a prepare/prepack script, extras here are expected.
const BUILD_OUTPUT_PATTERNS = [
  /(?:^|\/)dist\//,
  /(?:^|\/)build\//,
  /(?:^|\/)lib\//,
  /(?:^|\/)es\//,
  /(?:^|\/)esm\//,
  /(?:^|\/)cjs\//,
  /(?:^|\/)umd\//,
  /\.min\.js$/,
  /\.min\.mjs$/,
  /\.min\.css$/,
  /\.d\.ts$/,
  /\.d\.cts$/,
  /\.d\.mts$/,
  /\.js\.map$/,
  /\.css\.map$/
];

// Source extensions whose contents we care about most. Mismatches or extras
// here are the strongest ATO signal.
const SOURCE_EXTENSIONS = new Set([
  ".js", ".cjs", ".mjs", ".jsx",
  ".ts", ".tsx",
  ".vue", ".svelte",
  ".py", ".rb", ".go", ".rs", ".java", ".cs", ".php",
  ".sh", ".ps1", ".bash",
  ".json", ".toml", ".yaml", ".yml"
]);

function isAlwaysIgnored(relPath) {
  return ALWAYS_IGNORE.some((re) => re.test(relPath));
}

function isBuildOutput(relPath) {
  return BUILD_OUTPUT_PATTERNS.some((re) => re.test(relPath));
}

function isSourceFile(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  return SOURCE_EXTENSIONS.has(ext);
}

async function hashTree(root, subdir, limits, options = {}) {
  const baseDir = subdir ? path.join(root, subdir) : root;
  try {
    await fsp.access(baseDir);
  } catch {
    return null;
  }
  const result = new Map();
  const dirs = new Set();
  const queue = [""];
  let totalBytes = 0;
  let totalFiles = 0;
  const maxFiles = limits.maxFiles || 5000;
  const maxBytes = limits.maxBytes || 50 * 1024 * 1024;
  const maxFileBytes = limits.maxFileBytes || 1024 * 1024;
  // When `onlyHashPaths` is provided, walk the whole tree (to learn the
  // directory set used by the parent-dir-exists check downstream) but
  // ONLY hash files whose path appears in the set. This is what keeps the
  // diff fast on huge repos like TypeScript where the github source tree
  // has 10x more files than the npm tarball.
  const onlyHashPaths = options.onlyHashPaths || null;

  while (queue.length > 0 && totalFiles < maxFiles && totalBytes < maxBytes) {
    const rel = queue.shift();
    const full = path.join(baseDir, rel);
    let entries;
    try {
      entries = await fsp.readdir(full, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        dirs.add(childRel);
        queue.push(childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (shouldSkipHash(childRel)) continue;
      // Skip files we'll never use a hash for. Saves the stat + sha256.
      if (onlyHashPaths && !onlyHashPaths.has(childRel)) continue;
      const childFull = path.join(baseDir, childRel);
      let stat;
      try {
        stat = await fsp.stat(childFull);
      } catch {
        continue;
      }
      if (stat.size > maxFileBytes) {
        result.set(childRel, { size: stat.size, sha256: "skipped:too-large" });
        continue;
      }
      if (totalBytes + stat.size > maxBytes) {
        result.set(childRel, { size: stat.size, sha256: "skipped:tree-budget" });
        continue;
      }
      const hash = await hashFile(childFull);
      result.set(childRel, { size: stat.size, sha256: hash });
      totalBytes += stat.size;
      totalFiles += 1;
      if (totalFiles >= maxFiles) break;
    }
  }
  result.__dirs = dirs;
  return result;
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

// Compare a staged npm package against the matching GitHub repo subtree.
// Returns null if the comparison wasn't possible.
async function diffNpmVsGithub({ npmStagedPath, githubStagedPath, subdir, hasBuildScript }) {
  const limits = { maxFiles: 5000, maxBytes: 50 * 1024 * 1024 };
  // Walk npm first to learn which paths matter; then walk github only
  // hashing files at those exact paths. For typescript this drops the
  // github tree walk from 10k+ files to ~30.
  const npmTree = await hashTree(npmStagedPath, "", limits);
  const onlyHashPaths = npmTree ? new Set(npmTree.keys()) : null;
  const ghTree = await hashTree(githubStagedPath, subdir || "", limits, {
    onlyHashPaths
  });
  if (!npmTree || !ghTree) {
    return {
      compared: false,
      reason: !ghTree ? "github-subdir-missing" : "npm-tree-missing"
    };
  }

  // Directory set from the github walk (populated as a side-channel on the
  // result Map). Used to decide whether an extra file is in a "real source
  // dir" (sibling source files exist in github) or in a path github
  // doesn't have at all (more likely build output).
  const ghDirs = ghTree.__dirs || new Set();

  const extraInNpm = [];
  const mismatched = [];
  const matched = [];

  for (const [rel, npmEntry] of npmTree.entries()) {
    if (isAlwaysIgnored(rel)) continue;
    const ghEntry = ghTree.get(rel);
    if (!ghEntry) {
      const parentDir = rel.includes("/") ? rel.split("/").slice(0, -1).join("/") : "";
      const parentExistsInGh = parentDir === "" || ghDirs.has(parentDir);
      // An extra file inside a directory that exists in github is the strong
      // ATO signal — github has the dir, the attacker just dropped one more
      // file in it. An extra file at a path github doesn't have at all is
      // more likely build output the repo never committed.
      const inLikelySourceDir = /^(?:src|tests?|scripts|spec)\//.test(rel);
      let category;
      if (parentExistsInGh && isSourceFile(rel)) {
        category = "extra-source";
      } else if (isBuildOutput(rel)) {
        category = hasBuildScript ? "expected-build-output" : "extra-build-output";
      } else if (isSourceFile(rel)) {
        category = hasBuildScript && !inLikelySourceDir
          ? "expected-build-output"
          : "extra-source";
      } else {
        category = "extra-other";
      }
      extraInNpm.push({ path: rel, category, size: npmEntry.size });
      continue;
    }
    if (npmEntry.sha256 !== ghEntry.sha256) {
      // skipped hashes don't count as a mismatch
      if (npmEntry.sha256.startsWith("skipped") || ghEntry.sha256.startsWith("skipped")) {
        continue;
      }
      const inLikelySourceDir = /^(?:src|tests?|scripts|spec)\//.test(rel);
      const category = isBuildOutput(rel)
        ? hasBuildScript ? "expected-build-output" : "content-mismatch-build"
        : isSourceFile(rel)
          ? hasBuildScript && !inLikelySourceDir
            ? "expected-build-output"
            : "content-mismatch-source"
          : "content-mismatch-other";
      mismatched.push({ path: rel, category, npmSize: npmEntry.size, ghSize: ghEntry.size });
    } else {
      matched.push(rel);
    }
  }

  const extraSource = extraInNpm.filter((f) => f.category === "extra-source");
  const extraBuild = extraInNpm.filter((f) => f.category === "extra-build-output");
  const mismatchedSource = mismatched.filter((f) => f.category === "content-mismatch-source");

  // Tree-overlap sanity check. Many real packages don't publish a 1:1 mirror
  // of their repo (lodash publishes flat per-function modules, react bundles
  // src/ to root, monorepos publish a subtree). If the npm tarball and the
  // github tree have very little overlap at matching paths, comparing them
  // produces mostly noise. Bail out with an honest "no-overlap" reason rather
  // than firing HIGH on legit packages.
  const consideredFiles = npmTree.size; // already excludes node_modules etc.
  const overlapRatio = consideredFiles > 0 ? (matched.length + mismatched.length) / consideredFiles : 0;
  const MIN_OVERLAP_RATIO = 0.3;

  if (overlapRatio < MIN_OVERLAP_RATIO && extraSource.length > 20) {
    return {
      compared: false,
      reason: "tree-layout-differs",
      hasBuildScript,
      subdir: subdir || null,
      overlapRatio: Number(overlapRatio.toFixed(2)),
      counts: {
        npmFiles: npmTree.size,
        ghFiles: ghTree.size,
        matched: matched.length,
        mismatched: mismatched.length,
        extraInNpm: extraInNpm.length
      },
      note:
        "npm tarball and GitHub tree have very little overlap at matching paths — the package is likely built / bundled before publish. Diff would be unreliable; skipping."
    };
  }

  // Second skip case: of the files that DO exist at matching paths, most
  // mismatch. That means the published artifacts are generated from the repo
  // source (typical of `prepublish` / `release-please` / `changesets` build
  // flows that minify or transform entry files). Diff is unreliable here.
  const overlapCount = matched.length + mismatched.length;
  if (overlapCount >= 5 && mismatched.length > matched.length * 2) {
    return {
      compared: false,
      reason: "tree-mostly-generated",
      hasBuildScript,
      subdir: subdir || null,
      overlapRatio: Number(overlapRatio.toFixed(2)),
      counts: {
        npmFiles: npmTree.size,
        ghFiles: ghTree.size,
        matched: matched.length,
        mismatched: mismatched.length,
        extraInNpm: extraInNpm.length
      },
      note:
        "Most overlapping files differ in content — published artifacts are likely generated from the repo source (e.g. bundling, transpilation). Diff would be unreliable; skipping."
    };
  }

  return {
    compared: true,
    hasBuildScript,
    subdir: subdir || null,
    overlapRatio: Number(overlapRatio.toFixed(2)),
    counts: {
      npmFiles: npmTree.size,
      ghFiles: ghTree.size,
      matched: matched.length,
      mismatched: mismatched.length,
      extraInNpm: extraInNpm.length,
      extraSource: extraSource.length,
      mismatchedSource: mismatchedSource.length
    },
    suspiciousExtras: extraSource.concat(extraBuild).slice(0, 25),
    suspiciousMismatches: mismatchedSource.concat(
      mismatched.filter((f) => f.category === "content-mismatch-build")
    ).slice(0, 25)
  };
}

module.exports = { diffNpmVsGithub };
