"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { auditEvidence } = require("./auditor");
const {
  fetchRepoMetadata,
  fetchRepoTarballForVersion,
  extractTarball: extractTarballGh,
  listTarballEntries,
  extractTarballSubset
} = require("./github");
const { diffNpmVsGithub } = require("./diff");
const { fetchProvenanceAttestation } = require("./attestation");
const cfg = require("./config");

// Identifies pkgxray to the registries/APIs it queries. Derived from
// package.json so it tracks releases instead of drifting.
const USER_AGENT = `pkgxray/${require("../package.json").version}`;

// Shared keep-alive HTTPS agent. Three of the four network layers (npm
// metadata, npm tarball download, npm provenance) all hit registry.npmjs.org
// inside a single audit. Without keep-alive each call pays a fresh TLS
// handshake (~50-100ms). With keep-alive the second + third calls reuse
// the first call's socket. Default maxSockets=10 is plenty.
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 10 });

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
// Files larger than DEFAULT_MAX_FILE_BYTES used to be dropped entirely (replaced
// with an "[omitted]" marker) and never scanned — so a payload padded past
// 256 KB became invisible and the package scored safe. Instead of omitting we
// now read a BOUNDED slice of any oversized file so its content still reaches
// the auditor. For a file bigger than the hard read cap we take a prefix + a
// suffix (payloads hide at either end — top-of-file `require`/credential reads
// or bottom-of-file appended blobs) so both extremities are scanned while total
// memory stays bounded. SCAN_SLICE_BYTES is the hard per-file read ceiling.
const SCAN_SLICE_BYTES = 5 * 1024 * 1024;
// Half the slice is read from the head, half from the tail of a very large file.
const SCAN_SLICE_HALF_BYTES = SCAN_SLICE_BYTES / 2;
// Whole-package read budget so a package of many multi-MB files can't OOM us
// even within maxFiles. Once exceeded, remaining files are recorded as skipped
// rather than read (fail-visible, not silently dropped).
const DEFAULT_MAX_TOTAL_SCAN_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_FILES = 600;
const DEFAULT_TARBALL_MAX_BYTES = 256 * 1024 * 1024;
// The 256 MB uncompressed byte cap above is the real zip-bomb defense; this
// entry count is a secondary work bound. 5000 was too low — legitimately large
// packages (next ~8k entries, date-fns ~5.1k, many monorepo bundles) tripped it
// and couldn't be scanned at all. 20000 covers them while still rejecting the
// pathological millions-of-tiny-files case.
const DEFAULT_TARBALL_MAX_ENTRIES = 20000;
const DEFAULT_DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_DOWNLOAD_MAX_REDIRECTS = 5;
// NOTE: `dist` / `build` are deliberately NOT skipped. In a *source repo* those
// are throwaway build output, but in a *published npm tarball* they are the
// shipped, executed code — `"main": "dist/index.js"` is ubiquitous, and many
// packages publish ONLY their compiled `dist/`. Skipping them meant the entire
// heuristic layer (de-obfuscation, exec/exfil correlation, artifact-diff) never
// ran on the code that actually runs at install/require time — a trivial evasion
// (drop the payload in `dist/`, point `main` at it). We keep skipping genuine
// non-code noise: VCS, vendored deps, framework caches, coverage, py caches.
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "coverage",
  ".next",
  ".turbo",
  "__pycache__"
]);

const TEXT_FILE_PATTERNS = [
  "package.json",
  "README",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".json",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".sh",
  ".ps1",
  ".rb",
  ".toml",
  ".yaml",
  ".yml",
  ".md",
  ".txt",
  ".env",
  // Native-build and auto-execution surfaces (install-time / agent / IDE).
  // These aren't "source" in the usual sense, but node-gyp runs binding.gyp
  // at install, `gem install` runs extconf.rb, an agent runs .claude hooks,
  // and VS Code runs a folderOpen task — so they must reach the auditor.
  ".gyp",
  ".gypi"
];

async function guardExtension(reference, options = {}) {
  if (!reference) {
    throw new Error("Missing extension reference");
  }

  const quarantineRoot = path.resolve(
    options.quarantineRoot || path.join(os.tmpdir(), "supply-chain-auditor")
  );
  await fsp.mkdir(quarantineRoot, { recursive: true, mode: 0o700 });

  const workspace = await fsp.mkdtemp(path.join(quarantineRoot, "stage-"));
  await fsp.chmod(workspace, 0o700);
  const stagedPath = path.join(workspace, "package");
  const timings = {};

  // The per-audit staging tree is scratch space — extract, scan, decide, done.
  // Left behind it accumulates one `stage-*` dir per call (the lockfile deep
  // pass alone stages every dependency), so clean it up on completion unless
  // the caller wants it kept for inspection/promotion (the interactive `guard`
  // entry points pass keepStaging:true). A promoted package is already copied
  // out to promoteTo, so removing the workspace never destroys a kept artifact.
  const keepStaging = options.keepStaging === true;
  try {

  const stageStart = now();
  const resolved = await stageReference(reference, stagedPath, options);
  timings.stageMs = elapsed(stageStart);

  // Start the GitHub metadata fetch the moment we have npm metadata. It runs
  // concurrently with vuln-check and tarball download so it only adds latency
  // if it's slower than everything else combined (rare — usually <250ms).
  const githubStart = now();
  const githubMetadataPromise = options.githubMetadata === false
    ? Promise.resolve(null)
    : fetchRepoMetadata(resolved.npmMetadata && resolved.npmMetadata.repository)
        .catch(() => null);

  // Provenance attestation — runs concurrently with OSV + GitHub metadata so
  // it adds zero latency on the critical path. Only meaningful for npm
  // packages (GitHub-direct and local refs have no npm attestation by
  // definition). Cached on disk for 24h (positive and negative results).
  // We track when the promise *resolves* (not when we eventually await it)
  // so the timings.provenanceMs reflects the actual network/cache cost,
  // not the wall-clock until the auditor needs the result.
  const provenanceStart = now();
  let provenanceResolveTime = null;
  const provenancePromise =
    options.provenance === false || resolved.type !== "npm" || !resolved.packageName || !resolved.version
      ? Promise.resolve(null)
      : fetchProvenanceAttestation(resolved.packageName, resolved.version)
          .then((value) => {
            provenanceResolveTime = elapsed(provenanceStart);
            return value;
          })
          .catch(() => {
            provenanceResolveTime = elapsed(provenanceStart);
            return null;
          });

  const vulnerabilityStart = now();
  // OSV is a REMOTE service; the rest of this pipeline is local. Letting an OSV
  // failure throw would unwind the whole guard before the tarball is even read
  // (the download and source scan below are gated on this result), so a
  // third-party outage — or an air-gapped / proxied network — would silently
  // cost us the ENTIRE static analysis and report a bare "review" with zero
  // findings. Worse, under scanErrorPolicy=fail-open it reported live malware
  // as SAFE. Every other network fetch here already degrades (GitHub metadata,
  // provenance, dependency scan); this one now matches. The gap is recorded as
  // evidence and re-applied as a verdict floor once the report exists.
  let vulnerabilities = [];
  let vulnerabilityScanError = null;
  if (options.vulnerabilityCheck !== false) {
    try {
      vulnerabilities = await precheckVulnerabilities(resolved, stagedPath);
    } catch (error) {
      vulnerabilityScanError = error.message;
    }
  }
  timings.vulnerabilityPrecheckMs = elapsed(vulnerabilityStart);

  if (vulnerabilities.length === 0 && resolved.needsDownload) {
    const downloadStart = now();
    await downloadResolvedPackage(resolved, stagedPath);
    timings.downloadMs = elapsed(downloadStart);
  } else {
    timings.downloadMs = 0;
  }

  let sourceFiles = {};
  if (vulnerabilities.length === 0 && !resolved.skipSourceScan && options.sourceScan !== false) {
    const scanStart = now();
    sourceFiles = await collectSourceFiles(stagedPath, options);
    timings.sourceCollectionMs = elapsed(scanStart);
  } else {
    timings.sourceCollectionMs = 0;
  }

  // By now the GitHub fetch is either done or has been running concurrently
  // with everything above; await whatever remains.
  const githubMetadata = await githubMetadataPromise;
  timings.githubMetadataMs = elapsed(githubStart);

  // Likewise for provenance — it ran concurrently with everything above.
  // provenanceResolveTime is set by the .then handler so it reflects the
  // actual cost of the fetch/parse, not the wait until we awaited.
  const provenanceAttestation = await provenancePromise;
  timings.provenanceMs = provenanceResolveTime !== null ? provenanceResolveTime : 0;

  // npm vs GitHub diff (Phase 3) — only for npm packages where we have repo
  // metadata. Runs serially after we have both trees; tarballs are cached so
  // re-runs are fast.
  let npmVsGithubDiff = null;
  if (
    options.githubDiff !== false &&
    (resolved.type === "npm" || resolved.type === "local") &&
    githubMetadata && githubMetadata.found &&
    vulnerabilities.length === 0 &&
    Object.keys(sourceFiles).length > 0
  ) {
    const diffStart = now();
    try {
      npmVsGithubDiff = await runNpmVsGithubDiff({
        resolved,
        npmStagedPath: stagedPath,
        githubMetadata,
        workspace
      });
    } catch (error) {
      npmVsGithubDiff = { compared: false, reason: "diff-error", message: error.message };
    }
    timings.diffMs = elapsed(diffStart);
  } else {
    timings.diffMs = 0;
  }

  const evidence = {
    packageName: resolved.packageName || reference,
    npmMetadata: resolved.npmMetadata || null,
    githubMetadata,
    webPresence: null,
    knownVulnerabilities: vulnerabilities,
    // Non-null when the CVE lookup could not run. The auditor turns this into a
    // cited evidence gap so the report says WHY it can't clear the package,
    // rather than implying the CVE feed came back clean.
    vulnerabilityScanError,
    sourceFiles,
    npmVsGithubDiff,
    provenanceAttestation,
    // Registry of origin — lets the auditor scope the JS-primitive behavioral
    // suite to npm packages (a PyPI sdist's bundled foreign-language files are
    // vendored, not its audited surface). `resolved.ecosystem` is "PyPI" on the
    // PyPI path; npm/local resolutions leave it unset → defaults to npm.
    ecosystem: resolved.ecosystem || "npm"
  };
  const auditStart = now();
  // typosquat is scan CONFIG, not evidence: `true` from the CLI flag, or the
  // validated tuning object from .pkgxray.json — passed through unchanged.
  const report = auditEvidence(evidence, { typosquat: options.typosquat });
  timings.auditMs = elapsed(auditStart);
  // A missing CVE check can't clear a package, but it must not un-block one
  // either — static evidence stands on its own. See floorVerdictForScanGap.
  const decision = cfg.floorVerdictForScanGap(
    decisionForReport(report, options.policy || "safe-only"),
    Boolean(vulnerabilityScanError),
    options
  );

  const result = {
    schemaVersion: 1,
    decision,
    reference,
    resolved,
    sourceFiles,
    githubMetadata,
    npmVsGithubDiff,
    provenanceAttestation,
    vulnerabilityPrecheck: {
      enabled: options.vulnerabilityCheck !== false,
      database: "OSV",
      // `completed: false` distinguishes "OSV said this version is clean" from
      // "OSV never answered". A JSON consumer that only reads vulnerabilityCount
      // would otherwise read an outage as a clean bill of health.
      completed: vulnerabilityScanError === null,
      error: vulnerabilityScanError,
      vulnerabilityCount: vulnerabilities.length,
      vulnerabilities
    },
    timings,
    quarantinePath: workspace,
    stagedPath,
    promotedPath: null,
    report
  };

  // Dependency-tree scan (#7). A single-package guard only inspects the named
  // package; almost every real supply-chain compromise arrives TRANSITIVELY,
  // through a dependency you never named. `--deps` OSV-scans the package's
  // DIRECT dependencies (best-effort, ranges stripped — not a full resolver).
  // The complete transitive path is `pkgxray audit <lockfile>`, which resolves
  // and scans the whole tree; we say so in the result so the user isn't lulled.
  if (options.scanDependencies && vulnerabilities.length === 0) {
    const depStart = now();
    result.dependencyAudit = await scanDirectDependencies(stagedPath).catch((error) => ({
      scanned: 0,
      flagged: [],
      error: error.message
    }));
    timings.dependencyScanMs = elapsed(depStart);
  }

  if (options.promoteTo && shouldPromote(decision)) {
    result.promotedPath = await promoteStagedPackage(stagedPath, options.promoteTo, options);
  }

  // When we're about to reap the workspace, don't hand back paths that point
  // at a directory that no longer exists.
  if (!keepStaging) {
    result.quarantinePath = null;
    result.stagedPath = null;
  }

  return result;
  } finally {
    if (!keepStaging) {
      await fsp.rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function runNpmVsGithubDiff({ resolved, npmStagedPath, githubMetadata, workspace }) {
  const version = resolved.version;
  const tarball = await fetchRepoTarballForVersion(
    githubMetadata.owner,
    githubMetadata.repo,
    version,
    githubMetadata.default_branch
  );
  if (!tarball) {
    return { compared: false, reason: "no-matching-ref", versionTried: version };
  }

  // package.json may set repository.directory for monorepos — narrow the
  // comparison to that subpath if present.
  const pkgRepo = resolved.npmMetadata && resolved.npmMetadata.repository;
  const subdir = pkgRepo && typeof pkgRepo === "object" ? pkgRepo.directory || null : null;

  // Detect a publish-time build script (means built artifacts ≠ repo is normal)
  const scripts = await readScripts(npmStagedPath);
  const hasBuildScript = Boolean(scripts.prepare || scripts.prepack || scripts.build);

  const ghStagePath = path.join(workspace, "github-tree");

  // Selective extract: read the npm tarball's paths up front, then ask tar to
  // unpack ONLY those same paths from the github archive. For huge repos
  // (TypeScript: ~100MB / 10k files) this drops extraction from ~10s to <100ms
  // because we never write the 99% of files the diff would skip anyway.
  //
  // The fallback path (extract everything) only runs if the listing pass fails
  // — e.g. malformed archive or some bsdtar quirk we haven't seen yet.
  let selectiveExtract = null;
  try {
    selectiveExtract = await selectivelyExtractGithubTarball({
      archivePath: tarball.archivePath,
      destination: ghStagePath,
      npmStagedPath,
      subdir
    });
  } catch (error) {
    selectiveExtract = { reason: "selective-extract-failed", message: error.message };
  }

  if (!selectiveExtract || selectiveExtract.reason) {
    await extractTarballGh(tarball.archivePath, ghStagePath);
  }

  const diff = await diffNpmVsGithub({
    npmStagedPath,
    githubStagedPath: ghStagePath,
    subdir,
    hasBuildScript,
    prepopulatedGhDirs: selectiveExtract && !selectiveExtract.reason ? selectiveExtract.dirsRelativeToSubdir : null,
    // Caller has already computed the npm-vs-github path intersection during
    // selective extract; reuse it so the npm-side hashTree only sha256s the
    // paired files (the others can't possibly match anything in ghTree, so
    // their hash is unused).
    npmPairedPaths: selectiveExtract && !selectiveExtract.reason ? selectiveExtract.pairedNpmPaths : null,
    npmFileList: selectiveExtract && !selectiveExtract.reason ? selectiveExtract.npmFileList : null
  });

  return {
    ...diff,
    githubRef: tarball.ref,
    tarballFromCache: tarball.fromCache
  };
}

// Walks the npm-staged tree, intersects with the github tarball's listing,
// and asks tar to extract only the overlapping files. Returns the directory
// set (relative to `subdir`) so the diff's "is this extra file inside a
// directory github also has?" check still works.
async function selectivelyExtractGithubTarball({ archivePath, destination, npmStagedPath, subdir }) {
  const listing = await listTarballEntries(archivePath);
  if (!listing.prefix) {
    // No common prefix detected — fall back to full extract. Codeload always
    // has one, so this is the "weird tarball" escape hatch.
    return { reason: "no-prefix" };
  }

  const npmPaths = await collectRelativeFilePaths(npmStagedPath);
  if (npmPaths.length === 0) {
    return { reason: "empty-npm-tree" };
  }

  // Build the archive-internal paths to extract. With subdir, the github
  // tarball stores files at `prefix/subdir/<npm-rel>`; without subdir, just
  // `prefix/<npm-rel>`.
  const subdirSlash = subdir ? `${subdir.replace(/\/+$/, "")}/` : "";
  const archivePaths = [];
  // Track which npm-relative paths actually exist in the github tarball.
  // Downstream the diff uses this as the "skip hashing npm files that aren't
  // in github" set — for lodash that's 1000+ files we no longer SHA256.
  const pairedNpmPaths = new Set();
  for (const rel of npmPaths) {
    const inTarballRelToSubdir = subdirSlash + rel;
    // Only extract paths the tarball actually has. Passing a missing path to
    // bsdtar fails the whole command — GNU tar prints a warning per missing
    // file but exits non-zero too. Filter first.
    if (!listing.fileEntries.has(inTarballRelToSubdir)) continue;
    archivePaths.push(listing.prefix + inTarballRelToSubdir);
    pairedNpmPaths.add(rel);
  }

  // Always include the package.json at the comparison root — diff downstream
  // reads it to detect build scripts, and the .pkgxray-extract-list lives in
  // the same dir anyway.
  // (Optional belt-and-braces; npm tarballs always have package.json so the
  // overlap above already covers it. Left as a no-op note.)

  await extractTarballSubset(archivePath, destination, archivePaths);

  // Build the directory set in the same shape `hashTree` would have produced:
  // paths relative to `subdir`. Strip the subdir prefix from each dir.
  const dirsRelativeToSubdir = new Set();
  for (const d of listing.dirEntries) {
    if (subdirSlash) {
      if (d === subdir) continue; // the subdir root itself maps to "" — skip
      if (!d.startsWith(subdirSlash)) continue;
      const rel = d.slice(subdirSlash.length);
      if (rel.length > 0) dirsRelativeToSubdir.add(rel);
    } else {
      dirsRelativeToSubdir.add(d);
    }
  }

  return {
    dirsRelativeToSubdir,
    pairedNpmPaths,
    npmFileList: npmPaths,
    extractedFileCount: archivePaths.length,
    listingEntryCount: listing.entries.size
  };
}

// Cheap recursive file-path walk — no stat, no hash. Mirrors hashTree's
// SKIP_DIRS so we don't list paths that diff would later ignore.
const DIFF_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".github",
  ".vscode",
  ".idea",
  "coverage",
  "__pycache__"
]);

async function collectRelativeFilePaths(root) {
  const result = [];
  // Index cursor instead of Array#shift (O(n) per call) — matters on
  // wide trees like typescript where the queue can hold thousands of dirs.
  const queue = [""];
  let cursor = 0;
  while (cursor < queue.length) {
    const rel = queue[cursor++];
    const full = rel ? path.join(root, rel) : root;
    let entries;
    try {
      entries = await fsp.readdir(full, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      // SECURITY: skip symlinks and other non-regular entries. These would
      // otherwise be passed to `tar` as paths to extract from the GitHub
      // archive — if the github tarball happened to contain a matching
      // symlink at that path, extracting it would seed the staged tree with
      // an attacker-pointed link the diff would then read through.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (DIFF_SKIP_DIRS.has(entry.name)) continue;
        queue.push(childRel);
      } else if (entry.isFile()) {
        result.push(childRel);
      }
    }
  }
  return result;
}

// Read a file ONLY if it's a regular file at the time of read. Refuses to
// follow symlinks (defends against the staged tree containing a
// `package.json` that's actually a link to `~/.aws/credentials` etc.). The
// lstat is racy in theory, but combined with the symlink-rejecting cp in
// copyLocalPath it gives us defence in depth at every read site.
async function safeReadFile(filePath) {
  const stat = await fsp.lstat(filePath);
  if (!stat.isFile()) {
    const err = new Error(`refusing to read non-regular file: ${filePath}`);
    err.code = "ENOTREG";
    throw err;
  }
  return fsp.readFile(filePath, "utf8");
}

async function readScripts(stagedPath) {
  try {
    const pkg = JSON.parse(await safeReadFile(path.join(stagedPath, "package.json")));
    return pkg.scripts || {};
  } catch {
    return {};
  }
}

async function stageReference(reference, stagedPath, options) {
  const parsed = parseReference(reference);
  if (parsed.type === "local") {
    await copyLocalPath(parsed.path, stagedPath);
    // Populate npmMetadata from the staged package.json so downstream phases
    // (github metadata cross-check, npm-vs-github diff) can work on local
    // packages too.
    let npmMetadata = null;
    let packageName = path.basename(parsed.path);
    let version = null;
    try {
      const pkg = JSON.parse(await safeReadFile(path.join(stagedPath, "package.json")));
      packageName = pkg.name || packageName;
      version = pkg.version || null;
      if (pkg.repository) {
        npmMetadata = {
          name: pkg.name || packageName,
          version: pkg.version || null,
          repository: pkg.repository,
          maintainers: []
        };
      }
    } catch {
      // no package.json or unparseable — fine, just no metadata
    }
    return {
      type: "local",
      source: parsed.path,
      packageName,
      version,
      npmMetadata
    };
  }

  if (parsed.type === "npm") {
    return resolveNpmPackage(parsed.specifier, options);
  }

  if (parsed.type === "pypi") {
    return resolvePyPIPackage(parsed.specifier, options);
  }

  if (parsed.type === "github") {
    return resolveGithubRepo(parsed, options);
  }

  throw new Error(`Unsupported reference type: ${reference}`);
}

function parseReference(reference) {
  if (reference.startsWith("npm:")) {
    return { type: "npm", specifier: reference.slice("npm:".length) };
  }

  if (reference.startsWith("pypi:")) {
    return { type: "pypi", specifier: reference.slice("pypi:".length) };
  }

  if (reference.startsWith("file:")) {
    return { type: "local", path: path.resolve(reference.slice("file:".length)) };
  }

  if (reference.startsWith("github:")) {
    return parseGithubReference(reference.slice("github:".length));
  }

  // github.com URLs as a convenience shorthand
  const ghMatch = reference.match(/^https?:\/\/github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?(?:#(.+))?$/);
  if (ghMatch) {
    return {
      type: "github",
      owner: ghMatch[1],
      repo: ghMatch[2],
      ref: ghMatch[3] || null
    };
  }

  // A bare filesystem path. `path.isAbsolute` is used rather than a literal
  // `startsWith("/")` because on Windows an absolute path is `C:\dir` or a UNC
  // `\\server\share`, neither of which begins with a slash. Without this the
  // reference fell through to the npm branch and pkgxray asked the registry for
  // a package literally named `C:\Users\...` — an observed HTTP 405 from
  // `registry.npmjs.org/C%3A%5CUsers%5C...`, i.e. scanning a local directory by
  // absolute path simply did not work on Windows. On POSIX `path.isAbsolute` is
  // exactly `startsWith("/")`, so this is a no-op there.
  if (
    reference.startsWith(".") ||
    path.isAbsolute(reference) ||
    reference.startsWith("~")
  ) {
    const expanded = reference.startsWith("~/")
      ? path.join(os.homedir(), reference.slice(2))
      : reference;
    return { type: "local", path: path.resolve(expanded) };
  }

  return { type: "npm", specifier: reference };
}

function parseGithubReference(spec) {
  // Supports owner/repo[#ref] and owner/repo[@ref]
  const match = spec.match(/^([^/#@]+)\/([^/#@]+?)(?:[#@](.+))?$/);
  if (!match) throw new Error(`Invalid github reference: github:${spec}`);
  return {
    type: "github",
    owner: match[1],
    repo: match[2].replace(/\.git$/, ""),
    ref: match[3] || null
  };
}

async function resolveGithubRepo(parsed, options) {
  // Resolve default branch if no ref pinned. Uses the existing GitHub metadata
  // helper which is already cached + parallel-safe.
  const { fetchRepoMetadata } = require("./github");
  let ref = parsed.ref;
  let resolvedMeta = null;
  if (!ref) {
    const meta = await fetchRepoMetadata(`https://github.com/${parsed.owner}/${parsed.repo}`).catch(() => null);
    if (meta && meta.found === false && meta.reason === "not-found") {
      throw new Error(`GitHub repository not found: ${parsed.owner}/${parsed.repo}`);
    }
    if (meta && meta.found) {
      ref = meta.default_branch || "HEAD";
      resolvedMeta = meta;
    } else {
      ref = "HEAD";
    }
  }

  // GitHub's "codeload" endpoint returns a .tar.gz of the repo at the given
  // ref. Works for branch names, tags, and commit SHAs.
  const tarballUrl = `https://codeload.github.com/${parsed.owner}/${parsed.repo}/tar.gz/${encodeURIComponent(ref)}`;

  return {
    type: "github",
    owner: parsed.owner,
    repo: parsed.repo,
    ref,
    needsDownload: true,
    tarballUrl,
    // Initial host is fixed (codeload); allow GitHub's own hosts and any public
    // redirect target, but block redirects to private/loopback addresses.
    allowedHosts: tarballHostAllowlist(["codeload.github.com", "github.com", "objects.githubusercontent.com"]),
    strictHosts: false,
    packageName: `${parsed.owner}/${parsed.repo}`,
    githubArchive: true,
    npmMetadata: resolvedMeta
      ? {
          // Synthetic shape so the downstream auditor still sees a repository
          // URL and the github cross-check finds the same data we already have.
          name: parsed.repo,
          repository: { url: resolvedMeta.html_url, type: "git" },
          maintainers: []
        }
      : null
  };
}

async function copyLocalPath(sourcePath, stagedPath) {
  const stat = await fsp.stat(sourcePath);
  if (!stat.isDirectory()) {
    throw new Error("Local extension reference must be a directory");
  }

  // SECURITY: refuse to copy symlinks (and other non-regular entries) into
  // the quarantine. With `dereference: false`, `fsp.cp` preserves the link
  // and any subsequent `fsp.readFile(stagedPath/<link>)` would then read the
  // attacker-chosen target — a file-read primitive (e.g. `package.json` →
  // `~/.aws/credentials`). The same filter blocks block-device / FIFO / etc.
  // entries that would crash the stat pass downstream.
  //
  // Use the SOURCE path with `lstat` (NOT stat) so symlinks themselves are
  // identified, regardless of where they point.
  await fsp.cp(sourcePath, stagedPath, {
    recursive: true,
    dereference: false,
    filter: async (source) => {
      const base = path.basename(source);
      if (SKIP_DIRS.has(base)) return false;
      try {
        const entryStat = await fsp.lstat(source);
        if (!entryStat.isDirectory() && !entryStat.isFile()) {
          // Skip symlinks, block devices, FIFOs, sockets, etc.
          return false;
        }
      } catch {
        return false;
      }
      return true;
    }
  });
}

async function resolveNpmPackage(specifier, options) {
  const registry = options.registry || "https://registry.npmjs.org";
  const metadata = await fetchNpmMetadata(specifier, registry);
  const tarballUrl = metadata.dist && metadata.dist.tarball;
  if (!tarballUrl) {
    throw new Error(`No npm tarball URL found for ${specifier}`);
  }

  // Pin the tarball to the registry origin (dist.tarball is attacker-
  // influenceable). Fail fast with a clear error before any download/cache work.
  const allowedHosts = tarballHostAllowlist([registryHostOf(registry)]);
  try {
    assertDownloadHostAllowed(new URL(tarballUrl), { allowedHosts, strictHosts: true, originalUrl: tarballUrl });
  } catch (err) {
    throw new Error(`Unsafe npm tarball URL for ${specifier}: ${err.message}`);
  }

  return {
    type: "npm",
    packageName: metadata.name,
    version: metadata.version,
    needsDownload: true,
    tarballUrl,
    allowedHosts,
    strictHosts: true,
    integrity: (metadata.dist && metadata.dist.integrity) || null,
    shasum: (metadata.dist && metadata.dist.shasum) || null,
    npmMetadata: npmMetadataForEvidence(metadata)
  };
}

// PyPI counterpart of resolveNpmPackage. Resolves a `pypi:` reference to a
// downloadable sdist (a .tar.gz — the same format the npm download/extract path
// already handles) so the whole acquisition + extraction pipeline is reused.
// A 404 is the slopsquat/hallucination signal: a name PyPI never published.
// Wheel-only or fileless versions fall back to a metadata-only audit (existence
// + maintainers + repo cross-check + OSV) — wheel (ZIP) source inspection is v2.
async function resolvePyPIPackage(specifier, options) {
  const pypi = require("./pypi");
  const { name, version } = pypi.parsePypiSpecifier(specifier);

  let json;
  try {
    json = await pypi.fetchPypiMetadata(name, version);
  } catch (error) {
    if (error && error.statusCode === 404) {
      throw new Error(
        version
          ? `Version not found on PyPI: ${name}==${version} (unpublished, yanked, or a typosquat/hallucinated name)`
          : `Package not found on PyPI: ${name} (possible typosquat or hallucinated dependency)`
      );
    }
    throw error;
  }

  const info = (json && json.info) || {};
  const resolvedVersion = version || info.version || null;
  const evidenceMeta = pypi.pypiMetadataForEvidence(json);
  const file = pypi.releaseFileForVersion(json, resolvedVersion);

  // Only sdists are a .tar.gz we can extract and scan. Prefer them; wheel-only
  // or fileless versions get a metadata-only audit.
  if (file && file.packagetype === "sdist") {
    // Pin the download to PyPI's file host. Do NOT trust the URL's own host
    // (poisoned metadata could point it at an attacker) — mirror how the npm
    // path pins to the registry origin. Private indexes: PKGXRAY_TARBALL_HOSTS.
    const allowedHosts = tarballHostAllowlist(["files.pythonhosted.org"]);
    try {
      assertDownloadHostAllowed(new URL(file.url), { allowedHosts, strictHosts: true, originalUrl: file.url });
    } catch (err) {
      throw new Error(`Unsafe PyPI sdist URL for ${name}: ${err.message}`);
    }
    return {
      type: "pypi",
      ecosystem: "PyPI",
      packageName: info.name || name,
      version: resolvedVersion,
      needsDownload: true,
      tarballUrl: file.url,
      allowedHosts,
      strictHosts: true,
      // PyPI publishes a hex sha256; sha256ToSri makes it the npm SRI form the
      // existing verifyNpmTarballIntegrity path checks with no new code.
      integrity: pypi.sha256ToSri(file.sha256),
      shasum: null,
      npmMetadata: evidenceMeta
    };
  }

  return {
    type: "pypi",
    ecosystem: "PyPI",
    packageName: info.name || name,
    version: resolvedVersion,
    needsDownload: false,
    skipSourceScan: true,
    npmMetadata: evidenceMeta,
    noSourceReason: file
      ? "only a wheel is published for this version; sdist source inspection lands in v1, wheel unzip in v2"
      : "no downloadable sdist/wheel for this version (yanked or fileless)"
  };
}

// Content-addressed cache for npm tarballs. The npm registry's integrity
// field is a deterministic content hash of the .tgz bytes, so we can use it
// as the cache filename. Subsequent runs of the same `name@version` re-use
// the local copy and skip the 60-300ms registry download. Integrity is still
// re-verified on every read — a corrupted / poisoned cache entry would fail
// the check and trigger a fresh download, never get extracted.
const NPM_TARBALL_CACHE_DIR = path.join(os.homedir(), ".cache", "pkgxray", "npm-tarballs");
const NPM_TARBALL_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function npmTarballCachePath(resolved) {
  // Use the integrity field as the cache key when present (it's content-
  // addressed). Fall back to shasum, then to a hash of the URL — the last
  // case is exotic (tarballs without published integrity) and we still
  // verify on read.
  const integrity = resolved.integrity ? String(resolved.integrity).trim().split(/\s+/)[0] : null;
  let key;
  if (integrity) {
    key = integrity.replace(/[^A-Za-z0-9._-]/g, "_");
  } else if (resolved.shasum) {
    key = `sha1-${String(resolved.shasum).trim().toLowerCase()}`;
  } else {
    key = crypto.createHash("sha256").update(String(resolved.tarballUrl)).digest("hex");
  }
  return path.join(NPM_TARBALL_CACHE_DIR, `${key}.tgz`);
}

async function downloadResolvedPackage(resolved, stagedPath) {
  const archivePath = `${stagedPath}.tgz`;
  await fsp.mkdir(path.dirname(stagedPath), { recursive: true, mode: 0o700 });

  // Try the content-addressed cache first. If we have a fresh-enough copy,
  // hard-link or copy it into the staging area; integrity is still verified
  // below. Cache misses fall through to a fresh download.
  const cachePath = npmTarballCachePath(resolved);
  let servedFromCache = false;
  try {
    const stat = await fsp.stat(cachePath);
    if (Date.now() - stat.mtimeMs < NPM_TARBALL_CACHE_TTL_MS) {
      // Copy to the per-audit stage so we don't share the cached inode's
      // mode (cache dir is 0o700, but the stage workspace owns its tree).
      await fsp.copyFile(cachePath, archivePath);
      servedFromCache = true;
    }
  } catch {
    // No cache hit — fall through.
  }

  const downloadOptions = { allowedHosts: resolved.allowedHosts, strictHosts: resolved.strictHosts };
  if (!servedFromCache) {
    await downloadFile(resolved.tarballUrl, archivePath, downloadOptions);
  }

  // Single tarball read feeds BOTH the sha256 telemetry digest and the
  // integrity-verification digest (sha512 typically, sometimes sha1). Without
  // this we read the file twice — once for sha256, once for integrity — which
  // for a 30MB lodash tarball is ~100ms wasted per audit.
  const algos = ["sha256"];
  const integrityAlgo = pickIntegrityAlgo(resolved);
  if (integrityAlgo && integrityAlgo !== "sha256") {
    algos.push(integrityAlgo);
  }
  const digests = await hashFileMulti(archivePath, algos);
  resolved.sha256 = digests.sha256.toString("hex");

  // Verify against the npm registry's published integrity field BEFORE
  // extracting. Delete the partial file on mismatch so we never leave a
  // hostile tarball on disk.
  try {
    verifyNpmTarballIntegrity(resolved, digests);
  } catch (error) {
    await fsp.rm(archivePath, { force: true });
    // If the failure was a cache-corrupted copy, retry once via the network.
    if (servedFromCache) {
      await fsp.rm(cachePath, { force: true }).catch(() => {});
      await downloadFile(resolved.tarballUrl, archivePath, downloadOptions);
      const fresh = await hashFileMulti(archivePath, algos);
      try {
        verifyNpmTarballIntegrity(resolved, fresh);
      } catch (verifyError) {
        await fsp.rm(archivePath, { force: true });
        throw verifyError;
      }
      resolved.sha256 = fresh.sha256.toString("hex");
    } else {
      throw error;
    }
  }

  // Populate the cache after a successful verify (and skip if it already
  // came from there). Best-effort — never fail the audit because of a cache
  // write error.
  if (!servedFromCache) {
    try {
      await fsp.mkdir(NPM_TARBALL_CACHE_DIR, { recursive: true, mode: 0o700 });
      await fsp.copyFile(archivePath, cachePath);
    } catch {
      // ignore — cache is opportunistic
    }
  }

  await fsp.mkdir(stagedPath, { recursive: true, mode: 0o700 });
  await extractTarball(archivePath, stagedPath);
}

function pickIntegrityAlgo(resolved) {
  if (resolved.integrity) {
    const firstEntry = String(resolved.integrity).trim().split(/\s+/)[0];
    const dashIndex = firstEntry.indexOf("-");
    if (dashIndex > 0) return firstEntry.slice(0, dashIndex);
  }
  if (resolved.shasum) return "sha1";
  return null;
}

function verifyNpmTarballIntegrity(resolved, digests) {
  if (resolved.integrity) {
    const firstEntry = String(resolved.integrity).trim().split(/\s+/)[0];
    const dashIndex = firstEntry.indexOf("-");
    if (dashIndex <= 0) {
      throw new Error(`npm tarball integrity field is malformed: ${resolved.integrity}`);
    }
    const algo = firstEntry.slice(0, dashIndex);
    const expectedBase64 = firstEntry.slice(dashIndex + 1);
    const buffer = digests[algo];
    if (!buffer) {
      // Shouldn't happen — pickIntegrityAlgo would have included it. Fall back
      // to recomputing rather than failing the audit.
      throw new Error(`internal: missing digest for algorithm ${algo}`);
    }
    const actualBase64 = buffer.toString("base64");
    if (actualBase64 !== expectedBase64) {
      throw new Error(
        `npm tarball integrity mismatch: expected ${firstEntry} got ${algo}-${actualBase64}`
      );
    }
    return;
  }
  if (resolved.shasum) {
    const expectedHex = String(resolved.shasum).trim().toLowerCase();
    const buffer = digests.sha1;
    if (!buffer) {
      throw new Error("internal: missing sha1 digest for shasum check");
    }
    const actualHex = buffer.toString("hex").toLowerCase();
    if (actualHex !== expectedHex) {
      throw new Error(
        `npm tarball integrity mismatch: expected sha1-${expectedHex} got sha1-${actualHex}`
      );
    }
    return;
  }
  throw new Error("npm tarball has no published integrity field");
}

// Stream the file ONCE through every requested hash. Returns a map of
// algorithm → Buffer digest (caller chooses the output encoding).
function hashFileMulti(filePath, algorithms) {
  return new Promise((resolve, reject) => {
    let hashes;
    try {
      hashes = algorithms.map((a) => ({ algo: a, hash: crypto.createHash(a) }));
    } catch (error) {
      return reject(error);
    }
    fs.createReadStream(filePath)
      .on("data", (chunk) => {
        for (const h of hashes) h.hash.update(chunk);
      })
      .on("error", reject)
      .on("end", () => {
        const out = {};
        for (const h of hashes) out[h.algo] = h.hash.digest();
        resolve(out);
      });
  });
}

function npmMetadataForEvidence(metadata) {
  return {
    name: metadata.name,
    version: metadata.version,
    repository: metadata.repository || null,
    maintainers: metadata.maintainers || [],
    dist: metadata.dist || null,
    deprecated: metadata.deprecated || null
  };
}

// fix-5: fetch the single version metadata endpoint instead of the full
// packument. For popular packages (lodash, react) this is the difference
// between a 10MB+ download and a few KB.
async function fetchNpmMetadata(specifier, registry) {
  const parsed = parseNpmSpecifier(specifier);
  const encodedName = encodeURIComponent(parsed.name);
  const versionPath = parsed.version
    ? encodeURIComponent(parsed.version)
    : "latest";
  const url = `${registry.replace(/\/$/, "")}/${encodedName}/${versionPath}`;
  try {
    return await fetchJson(url);
  } catch (error) {
    if (error && error.statusCode === 404) {
      throw new Error(`Version not found for npm package: ${specifier}`);
    }
    throw error;
  }
}

function parseNpmSpecifier(specifier) {
  if (specifier.startsWith("@")) {
    const secondAt = specifier.indexOf("@", 1);
    if (secondAt === -1) {
      return { name: specifier, version: null };
    }
    return {
      name: specifier.slice(0, secondAt),
      version: specifier.slice(secondAt + 1)
    };
  }

  const at = specifier.lastIndexOf("@");
  if (at > 0) {
    return {
      name: specifier.slice(0, at),
      version: specifier.slice(at + 1)
    };
  }
  return { name: specifier, version: null };
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "user-agent": USER_AGENT }, agent: HTTPS_AGENT }, (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(`HTTP ${response.statusCode} from ${url}`);
          error.statusCode = response.statusCode;
          reject(error);
          response.resume();
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on("error", reject);
  });
}

async function precheckVulnerabilities(resolved, stagedPath) {
  if (Array.isArray(resolved.precheckedVulnerabilities)) {
    return resolved.precheckedVulnerabilities;
  }

  if (resolved.type === "npm" && resolved.packageName && resolved.version) {
    return queryOsvPackage(resolved.packageName, resolved.version, "npm");
  }

  if (resolved.type === "pypi" && resolved.packageName && resolved.version) {
    return queryOsvPackage(resolved.packageName, resolved.version, "PyPI");
  }

  const identity = await readPackageIdentity(stagedPath);
  if (!identity || !identity.name || !identity.version) {
    return [];
  }

  return queryOsvPackage(identity.name, identity.version, "npm");
}

// Best-effort OSV scan of a package's DIRECT dependencies (#7). Reads the
// staged package.json, strips version ranges (like the lockfile package-json
// parser does), and runs one batched OSV query. This is deliberately shallow —
// direct deps only, ranges not resolved to concrete versions — and is honest
// about it: the note steers the user to `pkgxray audit <lockfile>` for the full
// resolved transitive tree. Reuses the lockfile module's batch OSV client, so
// large dependency sets still cost a single fan-out.
async function scanDirectDependencies(stagedPath) {
  let pkg;
  try {
    pkg = JSON.parse(await safeReadFile(path.join(stagedPath, "package.json")));
  } catch {
    return { scanned: 0, flagged: [], note: "no readable package.json in the staged package" };
  }
  const deps = new Map();
  for (const section of ["dependencies", "optionalDependencies"]) {
    const entries = pkg[section] || {};
    for (const [name, rawRange] of Object.entries(entries)) {
      const range = String(rawRange);
      // Skip non-registry specifiers OSV can't resolve (file:/git+/workspace:).
      if (/^(?:file:|link:|git\+|github:|workspace:|npm:@?[^@]+@)/.test(range)) continue;
      const version = range.replace(/^[~^>=<\s]+/, "").trim();
      if (!version) continue;
      deps.set(`${name}@${version}`, { name, version, range, paths: [name] });
    }
  }
  if (deps.size === 0) return { scanned: 0, flagged: [] };

  const { batchOsvQuery } = require("./lockfile");
  const osv = await batchOsvQuery(deps);
  const values = Array.from(deps.values());
  const flagged = [];
  for (let i = 0; i < values.length; i += 1) {
    const vulns = osv[i] && Array.isArray(osv[i].vulns) ? osv[i].vulns : [];
    if (vulns.length > 0) {
      flagged.push({
        name: values[i].name,
        range: values[i].range,
        version: values[i].version,
        vulnerabilities: vulns.map((v) => ({ id: v.id, aliases: v.aliases || [] }))
      });
    }
  }
  return {
    scanned: deps.size,
    flagged,
    note:
      "Direct dependencies only, version ranges stripped (not fully resolved). For the complete transitive tree run `pkgxray audit <package-lock.json | yarn.lock | pnpm-lock.yaml>`."
  };
}

async function readPackageIdentity(stagedPath) {
  try {
    const packageJson = JSON.parse(
      await safeReadFile(path.join(stagedPath, "package.json"))
    );
    return {
      name: packageJson.name,
      version: packageJson.version
    };
  } catch {
    return null;
  }
}

async function queryOsvPackage(name, version, ecosystem) {
  const payload = {
    package: {
      name,
      ecosystem
    },
    version
  };
  const response = await postJson("https://api.osv.dev/v1/query", payload);
  return Array.isArray(response.vulns) ? response.vulns : [];
}

function postJson(url, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "user-agent": "supply-chain-auditor/0.1.0"
        },
        agent: HTTPS_AGENT
      },
      (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode} from ${url}`));
          response.resume();
          return;
        }
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(responseBody || "{}"));
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

// --- SSRF guard for tarball downloads -------------------------------------
//
// `dist.tarball` comes from the (attacker-influenceable) registry packument, and
// redirects can point anywhere. Without a host check, a poisoned/mirrored
// registry can make pkgxray fetch `http://169.254.169.254/…` (cloud metadata) or
// an internal service from a CI runner. We therefore (a) require https by
// default, (b) pin the npm tarball host to the registry origin (strict), and
// (c) block redirects to private/loopback/link-local addresses on every path.
// Node's WHATWG URL parser normalizes hex/octal/decimal IPv4 to dotted-quad, so
// the numeric-host evasions (`http://0x08080808/`) are caught by these checks.

function ipv4IsPrivate(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return false;
  const [a, b, c] = o;
  if (a === 0 || a === 10 || a === 127) return true;          // this-host / private / loopback
  if (a === 169 && b === 254) return true;                    // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16/12
  if (a === 192 && b === 168) return true;                    // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT 100.64/10
  if (a === 192 && b === 0 && c === 0) return true;           // 192.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true;       // benchmarking 198.18/15
  if (a >= 224) return true;                                  // multicast / reserved
  return false;
}

function isPrivateOrLocalHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.startsWith("[") && host.endsWith("]")) {
    const v6 = host.slice(1, -1);
    if (v6 === "::1" || v6 === "::") return true;
    const mapped = /^::ffff:(.+)$/.exec(v6);
    if (mapped) {
      if (mapped[1].includes(".")) return ipv4IsPrivate(mapped[1]);
      const hx = mapped[1].split(":");
      if (hx.length === 2) {
        const hi = parseInt(hx[0], 16);
        const lo = parseInt(hx[1], 16);
        if (Number.isFinite(hi) && Number.isFinite(lo)) {
          return ipv4IsPrivate(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
        }
      }
    }
    if (/^f[cd][0-9a-f]{2}:/.test(v6)) return true;   // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/.test(v6)) return true;   // fe80::/10 link-local
    return false;
  }
  return ipv4IsPrivate(host);
}

// Build the allowlist of hosts a tarball may be served from. `PKGXRAY_TARBALL_HOSTS`
// (comma-separated) extends it for registries that serve tarballs off-origin.
function tarballHostAllowlist(baseHosts) {
  const hosts = new Set();
  for (const h of baseHosts) {
    if (h) hosts.add(String(h).toLowerCase());
  }
  const extra = process.env.PKGXRAY_TARBALL_HOSTS;
  if (extra) {
    for (const part of extra.split(",")) {
      const t = part.trim().toLowerCase();
      if (t) hosts.add(t);
    }
  }
  return hosts;
}

function registryHostOf(registryUrl) {
  try {
    return new URL(registryUrl).host.toLowerCase();
  } catch {
    return null;
  }
}

// Throws if `parsed` is not an allowed download target. `allowedHosts` is a Set
// of trusted hosts (with or without port). `strictHosts` requires membership in
// that set (npm path, pinned to the registry origin); when false (GitHub path,
// whose initial host is fixed) any public host is allowed but private/loopback
// targets are rejected.
function assertDownloadHostAllowed(parsed, { allowedHosts, strictHosts, originalUrl }) {
  const allowInsecure = process.env.PKGXRAY_ALLOW_INSECURE_DOWNLOADS === "1";
  if (parsed.protocol !== "https:" && !(allowInsecure && parsed.protocol === "http:")) {
    throw new Error(
      `Refusing non-https download URL (${parsed.protocol}//${parsed.host}) for ${originalUrl}; ` +
        `set PKGXRAY_ALLOW_INSECURE_DOWNLOADS=1 to allow http (local testing only)`
    );
  }
  const host = parsed.host.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  if (allowedHosts && (allowedHosts.has(host) || allowedHosts.has(hostname))) {
    return; // explicitly trusted origin (allowed even if it's a private-registry IP)
  }
  if (strictHosts) {
    throw new Error(
      `Refusing to download tarball from ${parsed.host}: not an allowed host ` +
        `(${allowedHosts ? [...allowedHosts].join(", ") : "none"}). ` +
        `If your registry serves tarballs from a different host, set PKGXRAY_TARBALL_HOSTS=${hostname}`
    );
  }
  if (isPrivateOrLocalHost(hostname)) {
    throw new Error(`Refusing to download from private/loopback address ${parsed.host} (SSRF guard) for ${originalUrl}`);
  }
}

function downloadFile(url, destination, options = {}) {
  const maxBytes = options.maxBytes || DEFAULT_DOWNLOAD_MAX_BYTES;
  const maxRedirects = options.maxRedirects || DEFAULT_DOWNLOAD_MAX_REDIRECTS;
  const allowedHosts = options.allowedHosts || null;
  const strictHosts = Boolean(options.strictHosts);
  const originalUrl = url;
  const http = require("node:http");

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination, { mode: 0o600 });
    let written = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      file.destroy();
      fs.unlink(destination, () => reject(err));
    };
    // Attach the error handler at creation, not inside the response callback: an
    // open-time error (EACCES/ENOSPC) or a write-after-destroy race would
    // otherwise be an unhandled 'error' event that crashes the process.
    file.on("error", fail);
    const succeed = () => {
      if (settled) return;
      settled = true;
      file.close(() => resolve());
    };

    const get = (currentUrl, hops) => {
      if (hops > maxRedirects) {
        return fail(new Error(`Too many redirects from ${originalUrl}`));
      }
      let parsed;
      try {
        parsed = new URL(currentUrl);
        assertDownloadHostAllowed(parsed, { allowedHosts, strictHosts, originalUrl });
      } catch (err) {
        return fail(err);
      }
      const client = parsed.protocol === "http:" ? http : https;
      const request = client.get(
        {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === "http:" ? 80 : 443),
          path: parsed.pathname + parsed.search,
          headers: { "user-agent": USER_AGENT },
          // Re-use the shared agent when downloading from https hosts so the
          // npm metadata fetch and the tarball download share a TCP+TLS
          // session. Plain http stays on the default agent.
          agent: parsed.protocol === "https:" ? HTTPS_AGENT : undefined
        },
        (response) => {
          if (
            [301, 302, 303, 307, 308].includes(response.statusCode) &&
            response.headers.location
          ) {
            response.resume();
            return get(new URL(response.headers.location, currentUrl).toString(), hops + 1);
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            response.resume();
            return fail(new Error(`HTTP ${response.statusCode} from ${currentUrl}`));
          }
          response.on("data", (chunk) => {
            written += chunk.length;
            if (written > maxBytes) {
              response.destroy();
              return fail(
                new Error(`Download exceeded max size of ${maxBytes} bytes from ${originalUrl}`)
              );
            }
          });
          response.pipe(file);
          file.on("finish", succeed);
        }
      );
      request.on("error", fail);
    };
    get(url, 0);
  });
}

async function extractTarball(archivePath, destination, options = {}) {
  const maxBytes = options.maxTarballBytes || DEFAULT_TARBALL_MAX_BYTES;
  const maxEntries = options.maxTarballEntries || DEFAULT_TARBALL_MAX_ENTRIES;

  const listing = await runCapture("tar", ["-tvzf", archivePath]);
  const lines = listing.split("\n").filter((line) => line.trim().length > 0);

  validateTarListing(lines, maxBytes, maxEntries);

  await run("tar", [
    "-xzf", archivePath,
    "-C", destination,
    "--strip-components", "1",
    "--no-same-owner", "--no-same-permissions"
  ]);
  await normalizeTreePermissions(destination);
}

// Normalize owner perms across an extracted tree so the scanner can always read
// every file and traverse every directory. A package can ship a directory with
// no execute bit or a file with no read bit — by accident (pngjs ships lib/ as
// 0644) or on purpose, to hide code from the static walk so the scan aborts on
// EACCES and degrades to review instead of reading (and blocking) the payload.
// This is our throwaway, never-executed copy, so widening owner read/traverse is
// safe. `u+rX` adds read to everything and execute to DIRECTORIES only (never
// makes a regular file executable — `chmod -R` applies +X to a directory before
// it recurses, so a non-traversable dir gets fixed then descended into), so the
// file-mode signals we derive from the tar listing are unaffected.
async function normalizeTreePermissions(root) {
  await run("chmod", ["-R", "u+rX", root]);
}

// Validate a `tar -tvzf` listing (array of non-empty lines). Throws
// "Tarball rejected: ..." on any unsafe/unparseable entry so extraction fails
// closed. Extracted out of extractTarball so the security decisions are unit-
// testable with crafted listing lines (raw control chars, hardlink targets)
// that a given platform's tar can't easily be coaxed into emitting.
function validateTarListing(lines, maxBytes, maxEntries) {
  if (lines.length > maxEntries) {
    throw new Error(`Tarball rejected: ${lines.length} entries exceeds limit of ${maxEntries}`);
  }

  let totalBytes = 0;
  for (const line of lines) {
    const entry = parseTarListingLine(line);
    if (!entry) {
      throw new Error(`Tarball rejected: unparseable listing line: ${line}`);
    }
    // A name (or link target) carrying a newline/control char desyncs this
    // line-based parser from the real entry set — a later line could then be
    // a hidden entry we never validated. Reject fail-closed.
    assertNoControlChars(entry.path, "entry name");
    assertSafeTarPath(entry.path);
    // Link entries: symlink (l) and hardlink (h). bsdtar prints a hardlink as
    // "path link to <target>" (no " -> "), so relying on the arrow alone let
    // hardlinks slip past target validation entirely. Any entry the parser
    // flagged as a link MUST carry a target and be range-checked; a link entry
    // with no parseable target is rejected rather than trusted.
    if (entry.typeChar === "l" || entry.typeChar === "h") {
      if (entry.linkTarget === null) {
        throw new Error(`Tarball rejected: link entry with no parseable target: ${entry.path}`);
      }
      assertNoControlChars(entry.linkTarget, "link target");
      assertSafeSymlinkTarget(entry.path, entry.linkTarget);
    } else if (entry.linkTarget !== null) {
      assertNoControlChars(entry.linkTarget, "link target");
      assertSafeSymlinkTarget(entry.path, entry.linkTarget);
    }
    totalBytes += entry.size;
    if (totalBytes > maxBytes) {
      throw new Error(`Tarball rejected: uncompressed size exceeds limit of ${maxBytes} bytes`);
    }
  }
}

// tar -tvzf listing formats differ between bsdtar (macOS) and GNU tar:
//   bsdtar: "-rw-r--r--  0 user group   1234 Jan  1  2020 path"  (8 fields before path)
//   GNU:    "-rw-r--r-- user/group 1234 2020-01-01 12:00 path"   (5 fields before path)
// Detect format by whether field 2 contains "/".
function parseTarListingLine(line) {
  const parts = line.split(/\s+/).filter((p) => p.length > 0);
  const mode = parts[0];
  if (!mode || mode.length === 0) return null;
  const typeChar = mode[0];

  let sizeFieldIndex;
  let prefixFieldCount;
  if (parts.length >= 2 && parts[1].includes("/")) {
    sizeFieldIndex = 2;
    prefixFieldCount = 5;
  } else {
    sizeFieldIndex = 4;
    prefixFieldCount = 8;
  }

  if (parts.length < prefixFieldCount + 1) return null;
  const size = Number.parseInt(parts[sizeFieldIndex], 10);
  if (!Number.isFinite(size) || size < 0) return null;

  // Find byte offset of the (prefixFieldCount+1)-th whitespace field.
  let fieldsSeen = 0;
  let i = 0;
  while (i < line.length && fieldsSeen < prefixFieldCount) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) return null;
    while (i < line.length && !/\s/.test(line[i])) i++;
    fieldsSeen++;
  }
  while (i < line.length && /\s/.test(line[i])) i++;
  if (i >= line.length) return null;

  const remainder = line.slice(i);
  let entryPath = remainder;
  let linkTarget = null;
  // Symlinks print as "path -> target"; bsdtar hardlinks print as
  // "path link to target" (no arrow). Parse BOTH so a hardlink carries a target
  // through to validation instead of being dropped/aborting on a bare `l`/`h`.
  const arrowIdx = remainder.indexOf(" -> ");
  const linkToIdx = remainder.indexOf(" link to ");
  if (arrowIdx !== -1) {
    entryPath = remainder.slice(0, arrowIdx);
    linkTarget = remainder.slice(arrowIdx + 4);
  } else if (linkToIdx !== -1) {
    entryPath = remainder.slice(0, linkToIdx);
    linkTarget = remainder.slice(linkToIdx + " link to ".length);
  }
  // A link-type entry (symlink or hardlink) with no parseable target is
  // returned WITH a null target so the caller can reject it fail-closed rather
  // than us silently returning null (which would abort the whole audit).
  if (entryPath.length === 0) return null;
  return { path: entryPath, size, linkTarget, typeChar };
}

// A newline in an entry name would split into a phantom "line" and desync the
// line-based listing parser, hiding a later real entry. Other control chars are
// never legitimate in a package path either. Reject any of them fail-closed.
function assertNoControlChars(value, label) {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`Tarball rejected: control character in ${label}: ${JSON.stringify(value)}`);
  }
}

function assertSafeTarPath(entryPath) {
  if (entryPath.startsWith("/")) {
    throw new Error(`Tarball rejected: absolute path entry: ${entryPath}`);
  }
  if (/^[A-Za-z]:[\\/]/.test(entryPath)) {
    throw new Error(`Tarball rejected: drive-letter path entry: ${entryPath}`);
  }
  for (const segment of entryPath.split(/[\\/]+/)) {
    if (segment === "..") {
      throw new Error(`Tarball rejected: parent-traversal segment in: ${entryPath}`);
    }
  }
}

function assertSafeSymlinkTarget(entryPath, linkTarget) {
  if (linkTarget.length === 0) {
    throw new Error(`Tarball rejected: empty link target for: ${entryPath}`);
  }
  if (linkTarget.startsWith("/")) {
    throw new Error(`Tarball rejected: absolute link target: ${entryPath} -> ${linkTarget}`);
  }
  if (/^[A-Za-z]:[\\/]/.test(linkTarget)) {
    throw new Error(`Tarball rejected: drive-letter link target: ${entryPath} -> ${linkTarget}`);
  }
  const normalizedPath = entryPath.replace(/\\/g, "/");
  const normalizedTarget = linkTarget.replace(/\\/g, "/");
  const linkDir = path.posix.dirname(normalizedPath);
  const joined = linkDir === "." ? normalizedTarget : path.posix.join(linkDir, normalizedTarget);
  const normalized = path.posix.normalize(joined);
  if (normalized.startsWith("../") || normalized === "..") {
    throw new Error(`Tarball rejected: link escapes destination: ${entryPath} -> ${linkTarget}`);
  }
}

function runCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`));
    });
  });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`));
      }
    });
  });
}

// Read up to `limit` bytes of a file for scanning. If the file is larger than
// `limit`, read a head slice + a tail slice (each half the limit) joined by a
// truncation marker, so payloads hidden at either end still reach the auditor
// while total memory stays bounded. Decoded as utf8 (matching whole-file reads).
async function readBoundedForScan(fullPath, size, limit) {
  if (size <= limit) {
    return fsp.readFile(fullPath, "utf8");
  }
  const half = Math.floor(limit / 2);
  const handle = await fsp.open(fullPath, "r");
  try {
    const head = Buffer.alloc(half);
    const tail = Buffer.alloc(half);
    await handle.read(head, 0, half, 0);
    await handle.read(tail, 0, half, size - half);
    return (
      head.toString("utf8") +
      `\n[scan-truncated: middle of ${size}-byte file elided; head+tail scanned]\n` +
      tail.toString("utf8")
    );
  } finally {
    await handle.close();
  }
}

async function collectSourceFiles(root, options = {}) {
  const maxFiles = options.maxFiles || DEFAULT_MAX_FILES;
  // Per-file read ceiling. maxFileBytes is honoured as a FLOOR on how much we
  // read (never scan less than the caller's threshold), but oversized files are
  // no longer dropped — we read up to SCAN_SLICE_BYTES (head+tail) of them.
  const perFileScanBytes = Math.max(
    options.maxFileBytes || DEFAULT_MAX_FILE_BYTES,
    SCAN_SLICE_BYTES
  );
  const maxTotalScanBytes = options.maxTotalScanBytes || DEFAULT_MAX_TOTAL_SCAN_BYTES;
  let totalScanBytes = 0;
  const sourceFiles = {};
  // Index cursor + manual counter so we don't pay O(n) per iteration on
  // both queue.shift() and Object.keys(sourceFiles).length.
  const queue = [root];
  let cursor = 0;
  let fileCount = 0;

  while (cursor < queue.length && fileCount < maxFiles) {
    const current = queue[cursor++];
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relativePath = path.relative(root, fullPath);

      // SECURITY: explicitly reject symlinks and other non-regular entries.
      // Even though copyLocalPath now filters them at staging time, this
      // defends against a malicious tar that managed to slip a symlink past
      // the tarball listing parser, and keeps the invariant local to the
      // reader. `fsp.readFile` would follow a symlink and exfiltrate the
      // target into the JSON report otherwise.
      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          queue.push(fullPath);
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }
      let collectThisFile = looksTextLike(relativePath);
      if (!collectThisFile && !entry.name.includes(".")) {
        // Extensionless regular file (e.g. bare `install` / `preinstall` /
        // `configure`): collect it only if it's a shebang script. These carry
        // no text extension so looksTextLike skips them, yet a lifecycle hook
        // can run them at install time. The peek is a bounded 2-byte read and
        // only happens for the handful of extensionless files in a package.
        collectThisFile = await startsWithShebang(fullPath);
      }
      if (!collectThisFile) {
        continue;
      }

      // Use lstat (not stat) so a sneakily-replaced symlink between readdir
      // and the read is still recognised — the stat would otherwise follow.
      const stat = await fsp.lstat(fullPath);
      if (!stat.isFile()) continue;

      // Total-bytes budget: once the whole-package read budget is exhausted,
      // record remaining files as skipped (fail-VISIBLE, so a reviewer knows
      // coverage was capped) rather than silently dropping them.
      if (totalScanBytes >= maxTotalScanBytes) {
        sourceFiles[relativePath] = `[skipped: total scan budget of ${maxTotalScanBytes} bytes reached]`;
        fileCount += 1;
        if (fileCount >= maxFiles) break;
        continue;
      }

      // Oversized files are NOT dropped: read a bounded head+tail slice so a
      // payload padded past the per-file threshold still reaches the auditor.
      const budgetRemaining = maxTotalScanBytes - totalScanBytes;
      const readLimit = Math.min(perFileScanBytes, budgetRemaining);
      const content = await readBoundedForScan(fullPath, stat.size, readLimit);
      sourceFiles[relativePath] = content;
      totalScanBytes += Buffer.byteLength(content, "utf8");
      fileCount += 1;
      if (fileCount >= maxFiles) {
        break;
      }
    }
  }

  return sourceFiles;
}

function looksTextLike(filePath) {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  return TEXT_FILE_PATTERNS.some((pattern) => normalized.endsWith(pattern) || normalized.includes(pattern));
}

// True if the file's first two bytes are a shebang (`#!`). Used to rescue
// extensionless executable scripts that looksTextLike skips. Opens with a
// bounded 2-byte read and never follows a symlink (callers gate on a Dirent
// isFile() first, and the read targets a plain path).
async function startsWithShebang(fullPath) {
  let handle;
  try {
    handle = await fsp.open(fullPath, "r");
    const buf = Buffer.alloc(2);
    const { bytesRead } = await handle.read(buf, 0, 2, 0);
    return bytesRead === 2 && buf[0] === 0x23 && buf[1] === 0x21; // "#!"
  } catch {
    return false;
  } finally {
    if (handle) await handle.close();
  }
}

function decisionForReport(report, policy) {
  if (report.verdict === "block") {
    return "block";
  }
  if (report.verdict === "review") {
    return policy === "allow-review" ? "allow" : "review";
  }
  return "allow";
}

function shouldPromote(decision) {
  return decision === "allow";
}

async function promoteStagedPackage(stagedPath, promoteTo, options = {}) {
  const destination = path.resolve(promoteTo);
  const exists = await pathExists(destination);
  if (exists && !options.force) {
    throw new Error(`Promotion target already exists: ${destination}`);
  }
  if (exists) {
    await fsp.rm(destination, { recursive: true, force: true });
  }
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.cp(stagedPath, destination, { recursive: true, dereference: false });
  return destination;
}

function now() {
  return process.hrtime.bigint();
}

function elapsed(start) {
  return Number((process.hrtime.bigint() - start) / 1000000n);
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  guardExtension,
  parseReference,
  parseNpmSpecifier,
  collectSourceFiles,
  scanDirectDependencies,
  queryOsvPackage,
  decisionForReport,
  // exported for tests: SSRF download guard
  isPrivateOrLocalHost,
  assertDownloadHostAllowed,
  tarballHostAllowlist,
  // exported for tests: tarball listing validator + local extractor
  extractTarball,
  normalizeTreePermissions,
  parseTarListingLine,
  assertNoControlChars,
  assertSafeSymlinkTarget,
  validateTarListing
};
