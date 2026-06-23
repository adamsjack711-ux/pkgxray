"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { auditEvidence } = require("./auditor");
const { fetchRepoMetadata, fetchRepoTarballForVersion, extractTarball: extractTarballGh } = require("./github");
const { diffNpmVsGithub } = require("./diff");
const { fetchProvenanceAttestation } = require("./attestation");

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_FILES = 600;
const DEFAULT_TARBALL_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_TARBALL_MAX_ENTRIES = 5000;
const DEFAULT_DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_DOWNLOAD_MAX_REDIRECTS = 5;
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
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
  ".toml",
  ".yaml",
  ".yml",
  ".md",
  ".txt",
  ".env"
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
  const vulnerabilities =
    options.vulnerabilityCheck === false
      ? []
      : await precheckVulnerabilities(resolved, stagedPath);
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
    sourceFiles,
    npmVsGithubDiff,
    provenanceAttestation
  };
  const auditStart = now();
  const report = auditEvidence(evidence);
  timings.auditMs = elapsed(auditStart);
  const decision = decisionForReport(report, options.policy || "safe-only");

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
      vulnerabilityCount: vulnerabilities.length,
      vulnerabilities
    },
    timings,
    quarantinePath: workspace,
    stagedPath,
    promotedPath: null,
    report
  };

  if (options.promoteTo && shouldPromote(decision)) {
    result.promotedPath = await promoteStagedPackage(stagedPath, options.promoteTo, options);
  }

  return result;
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

  const ghStagePath = path.join(workspace, "github-tree");
  await extractTarballGh(tarball.archivePath, ghStagePath);

  // package.json may set repository.directory for monorepos — narrow the
  // comparison to that subpath if present.
  const pkgRepo = resolved.npmMetadata && resolved.npmMetadata.repository;
  const subdir = pkgRepo && typeof pkgRepo === "object" ? pkgRepo.directory || null : null;

  // Detect a publish-time build script (means built artifacts ≠ repo is normal)
  const scripts = await readScripts(npmStagedPath);
  const hasBuildScript = Boolean(scripts.prepare || scripts.prepack || scripts.build);

  const diff = await diffNpmVsGithub({
    npmStagedPath,
    githubStagedPath: ghStagePath,
    subdir,
    hasBuildScript
  });

  return {
    ...diff,
    githubRef: tarball.ref,
    tarballFromCache: tarball.fromCache
  };
}

async function readScripts(stagedPath) {
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(stagedPath, "package.json"), "utf8"));
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
      const pkg = JSON.parse(await fsp.readFile(path.join(stagedPath, "package.json"), "utf8"));
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

  if (parsed.type === "github") {
    return resolveGithubRepo(parsed, options);
  }

  throw new Error(`Unsupported reference type: ${reference}`);
}

function parseReference(reference) {
  if (reference.startsWith("npm:")) {
    return { type: "npm", specifier: reference.slice("npm:".length) };
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

  if (
    reference.startsWith(".") ||
    reference.startsWith("/") ||
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

  await fsp.cp(sourcePath, stagedPath, {
    recursive: true,
    dereference: false,
    filter: (source) => {
      const base = path.basename(source);
      return !SKIP_DIRS.has(base);
    }
  });
}

async function resolveNpmPackage(specifier, options) {
  const metadata = await fetchNpmMetadata(specifier, options.registry || "https://registry.npmjs.org");
  const tarballUrl = metadata.dist && metadata.dist.tarball;
  if (!tarballUrl) {
    throw new Error(`No npm tarball URL found for ${specifier}`);
  }

  return {
    type: "npm",
    packageName: metadata.name,
    version: metadata.version,
    needsDownload: true,
    tarballUrl,
    integrity: (metadata.dist && metadata.dist.integrity) || null,
    shasum: (metadata.dist && metadata.dist.shasum) || null,
    npmMetadata: npmMetadataForEvidence(metadata)
  };
}

async function downloadResolvedPackage(resolved, stagedPath) {
  const archivePath = `${stagedPath}.tgz`;
  await fsp.mkdir(path.dirname(stagedPath), { recursive: true, mode: 0o700 });
  await downloadFile(resolved.tarballUrl, archivePath);
  resolved.sha256 = await hashFile(archivePath);

  // Verify against the npm registry's published integrity field BEFORE
  // extracting. Delete the partial file on mismatch so we never leave a
  // hostile tarball on disk.
  try {
    await verifyNpmTarballIntegrity(resolved, archivePath);
  } catch (error) {
    await fsp.rm(archivePath, { force: true });
    throw error;
  }

  await fsp.mkdir(stagedPath, { recursive: true, mode: 0o700 });
  await extractTarball(archivePath, stagedPath);
}

async function verifyNpmTarballIntegrity(resolved, archivePath) {
  if (resolved.integrity) {
    const firstEntry = String(resolved.integrity).trim().split(/\s+/)[0];
    const dashIndex = firstEntry.indexOf("-");
    if (dashIndex <= 0) {
      throw new Error(`npm tarball integrity field is malformed: ${resolved.integrity}`);
    }
    const algo = firstEntry.slice(0, dashIndex);
    const expectedBase64 = firstEntry.slice(dashIndex + 1);
    const actualBase64 = await hashFileDigest(archivePath, algo, "base64");
    if (actualBase64 !== expectedBase64) {
      throw new Error(
        `npm tarball integrity mismatch: expected ${firstEntry} got ${algo}-${actualBase64}`
      );
    }
    return;
  }
  if (resolved.shasum) {
    const expectedHex = String(resolved.shasum).trim().toLowerCase();
    const actualHex = (await hashFileDigest(archivePath, "sha1", "hex")).toLowerCase();
    if (actualHex !== expectedHex) {
      throw new Error(
        `npm tarball integrity mismatch: expected sha1-${expectedHex} got sha1-${actualHex}`
      );
    }
    return;
  }
  throw new Error("npm tarball has no published integrity field");
}

function hashFileDigest(filePath, algorithm, encoding) {
  return new Promise((resolve, reject) => {
    let hash;
    try {
      hash = crypto.createHash(algorithm);
    } catch (error) {
      reject(error);
      return;
    }
    fs.createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest(encoding)));
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
      .get(url, { headers: { "user-agent": "pkgxray/0.9.0" } }, (response) => {
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

  const identity = await readPackageIdentity(stagedPath);
  if (!identity || !identity.name || !identity.version) {
    return [];
  }

  return queryOsvPackage(identity.name, identity.version, "npm");
}

async function readPackageIdentity(stagedPath) {
  try {
    const packageJson = JSON.parse(
      await fsp.readFile(path.join(stagedPath, "package.json"), "utf8")
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
        }
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

function downloadFile(url, destination, options = {}) {
  const maxBytes = options.maxBytes || DEFAULT_DOWNLOAD_MAX_BYTES;
  const maxRedirects = options.maxRedirects || DEFAULT_DOWNLOAD_MAX_REDIRECTS;
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
    const succeed = () => {
      if (settled) return;
      settled = true;
      file.close(() => resolve());
    };

    const get = (currentUrl, hops) => {
      if (hops > maxRedirects) {
        return fail(new Error(`Too many redirects from ${originalUrl}`));
      }
      const parsed = new URL(currentUrl);
      const client = parsed.protocol === "http:" ? http : https;
      const request = client.get(
        {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === "http:" ? 80 : 443),
          path: parsed.pathname + parsed.search,
          headers: { "user-agent": "pkgxray/0.9.0" }
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
          file.on("error", fail);
        }
      );
      request.on("error", fail);
    };
    get(url, 0);
  });
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", resolve);
  });
  return hash.digest("hex");
}

async function extractTarball(archivePath, destination, options = {}) {
  const maxBytes = options.maxTarballBytes || DEFAULT_TARBALL_MAX_BYTES;
  const maxEntries = options.maxTarballEntries || DEFAULT_TARBALL_MAX_ENTRIES;

  const listing = await runCapture("tar", ["-tvzf", archivePath]);
  const lines = listing.split("\n").filter((line) => line.trim().length > 0);

  if (lines.length > maxEntries) {
    throw new Error(`Tarball rejected: ${lines.length} entries exceeds limit of ${maxEntries}`);
  }

  let totalBytes = 0;
  for (const line of lines) {
    const entry = parseTarListingLine(line);
    if (!entry) {
      throw new Error(`Tarball rejected: unparseable listing line: ${line}`);
    }
    assertSafeTarPath(entry.path);
    if (entry.linkTarget !== null) {
      assertSafeSymlinkTarget(entry.path, entry.linkTarget);
    }
    totalBytes += entry.size;
    if (totalBytes > maxBytes) {
      throw new Error(`Tarball rejected: uncompressed size exceeds limit of ${maxBytes} bytes`);
    }
  }

  await run("tar", [
    "-xzf", archivePath,
    "-C", destination,
    "--strip-components", "1",
    "--no-same-owner", "--no-same-permissions"
  ]);
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
  const arrowIdx = remainder.indexOf(" -> ");
  if (arrowIdx !== -1) {
    entryPath = remainder.slice(0, arrowIdx);
    linkTarget = remainder.slice(arrowIdx + 4);
  } else if (typeChar === "l") {
    return null;
  }
  if (entryPath.length === 0) return null;
  return { path: entryPath, size, linkTarget, typeChar };
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

async function collectSourceFiles(root, options = {}) {
  const maxFiles = options.maxFiles || DEFAULT_MAX_FILES;
  const maxFileBytes = options.maxFileBytes || DEFAULT_MAX_FILE_BYTES;
  const sourceFiles = {};
  const queue = [root];

  while (queue.length && Object.keys(sourceFiles).length < maxFiles) {
    const current = queue.shift();
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relativePath = path.relative(root, fullPath);

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          queue.push(fullPath);
        }
        continue;
      }

      if (!entry.isFile() || !looksTextLike(relativePath)) {
        continue;
      }

      const stat = await fsp.stat(fullPath);
      if (stat.size > maxFileBytes) {
        sourceFiles[relativePath] = `[omitted: file exceeds ${maxFileBytes} bytes]`;
        continue;
      }

      sourceFiles[relativePath] = await fsp.readFile(fullPath, "utf8");
      if (Object.keys(sourceFiles).length >= maxFiles) {
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
  queryOsvPackage,
  decisionForReport
};
