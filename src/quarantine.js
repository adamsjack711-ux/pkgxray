"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { auditEvidence } = require("./auditor");

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_FILES = 600;
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

  const evidence = {
    packageName: resolved.packageName || reference,
    npmMetadata: resolved.npmMetadata || null,
    githubMetadata: null,
    webPresence: null,
    knownVulnerabilities: vulnerabilities,
    sourceFiles
  };
  const auditStart = now();
  const report = auditEvidence(evidence);
  timings.auditMs = elapsed(auditStart);
  const decision = decisionForReport(report, options.policy || "safe-only");

  const result = {
    decision,
    reference,
    resolved,
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

async function stageReference(reference, stagedPath, options) {
  const parsed = parseReference(reference);
  if (parsed.type === "local") {
    await copyLocalPath(parsed.path, stagedPath);
    return {
      type: "local",
      source: parsed.path,
      packageName: path.basename(parsed.path)
    };
  }

  if (parsed.type === "npm") {
    return resolveNpmPackage(parsed.specifier, options);
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

async function fetchNpmMetadata(specifier, registry) {
  const parsed = parseNpmSpecifier(specifier);
  const encodedName = encodeURIComponent(parsed.name);
  const metadataUrl = `${registry.replace(/\/$/, "")}/${encodedName}`;
  const packageMetadata = await fetchJson(metadataUrl);
  const version =
    parsed.version ||
    (packageMetadata["dist-tags"] && packageMetadata["dist-tags"].latest);
  if (!version || !packageMetadata.versions || !packageMetadata.versions[version]) {
    throw new Error(`Version not found for npm package: ${specifier}`);
  }
  return packageMetadata.versions[version];
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
      .get(url, { headers: { "user-agent": "supply-chain-auditor/0.1.0" } }, (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode} from ${url}`));
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

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination, { mode: 0o600 });
    https
      .get(url, { headers: { "user-agent": "supply-chain-auditor/0.1.0" } }, (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode} from ${url}`));
          response.resume();
          return;
        }
        response.pipe(file);
        file.on("finish", () => {
          file.close(resolve);
        });
      })
      .on("error", reject);
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

function extractTarball(archivePath, destination) {
  return run("tar", ["-xzf", archivePath, "-C", destination, "--strip-components", "1"]);
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
