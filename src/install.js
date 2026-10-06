"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const artifact = require("./artifact");
const cfg = require("./config");
const { guardExtension } = require("./quarantine");
const { runCapture } = require("./bounded-process");

const NAME = /^(?:@[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const object = value => value && typeof value === "object" && !Array.isArray(value);

function validateBin(manifest) {
  if (manifest.directories?.bin !== undefined) throw new Error("Directory-based bin declarations are not supported");
  const bins = typeof manifest.bin === "string" ? { command: manifest.bin } : manifest.bin;
  if (bins === undefined) return;
  if (!object(bins)) throw new Error("Invalid bin declaration");
  for (const [name, target] of Object.entries(bins)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || typeof target !== "string" || !target ||
        target.includes("\\") || target.startsWith("/") || target.split("/").some(p => p === ".." || p === "node_modules") ||
        !/^(?:\.\/)?[a-zA-Z0-9_][a-zA-Z0-9_./ -]*$/.test(target)) throw new Error("Unsafe executable link declaration");
  }
}

function validateSpecs(manifest) {
  if (!object(manifest)) throw new Error("Invalid package manifest");
  validateBin(manifest);
  for (const field of ["workspaces", "overrides", "bundledDependencies", "bundleDependencies"]) {
    if (manifest[field] !== undefined) throw new Error(`Enforced install does not support ${field}`);
  }
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    if (manifest[field] === undefined) continue;
    if (!object(manifest[field])) throw new Error(`Invalid ${field}`);
    for (const [name, spec] of Object.entries(manifest[field])) {
      if (!NAME.test(name) || typeof spec !== "string" || !spec.trim() || !/^[0-9vVxX*^~<>=| .+-]+$/.test(spec)) {
        throw new Error(`Only registry semver dependencies are supported: ${name}`);
      }
    }
  }
}

function validateLock(manifest, lock) {
  validateSpecs(manifest);
  if (!object(lock) || ![2, 3].includes(lock.lockfileVersion) || !object(lock.packages) || !object(lock.packages[""])) {
    throw new Error("Enforced install requires a complete npm package-lock v2 or v3");
  }
  validateSpecs(lock.packages[""]);
  const entries = [];
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location) continue;
    const segments = location.split("node_modules/");
    if (segments.shift() !== "" || segments.some((part, i) => !NAME.test(i === segments.length - 1 ? part : part.replace(/\/$/, "")))) {
      throw new Error(`Invalid locked package path: ${location}`);
    }
    // Require exact separators: a package may nest only through node_modules.
    const names = segments.map((part, i) => i === segments.length - 1 ? part : part.slice(0, -1));
    if (names.map(n => `node_modules/${n}`).join("/") !== location) throw new Error(`Invalid locked package path: ${location}`);
    if (!object(entry) || entry.link || entry.inBundle || !VERSION.test(entry.version)) throw new Error(`Unsupported locked package: ${location}`);
    const name = entry.name || names.at(-1);
    if (!NAME.test(name) || name !== names.at(-1)) throw new Error("Aliases are not yet supported by enforced install");
    validateSpecs(entry);
    let url;
    try { url = new URL(entry.resolved); } catch { throw new Error(`Missing artifact URL: ${location}`); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error(`Unsupported artifact URL: ${location}`);
    artifact.integrityEntries(entry.integrity);
    entries.push({ location, name, version: entry.version, entry });
  }
  if (entries.length > 1000) throw new Error("Enforced install is limited to 1000 locked packages");
  return entries;
}

async function readRegular(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error(`Expected a regular file under 8 MiB: ${file}`);
  return fs.readFile(file);
}

async function inventory(root, budget, prefix = "") {
  const result = new Map();
  for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (++budget.files > 100000) throw new Error("Install file budget exceeded");
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") throw new Error("Bundled node_modules are not supported by enforced install");
      for (const pair of await inventory(root, budget, rel)) result.set(...pair);
    } else if (entry.isFile()) {
      const stat = await fs.stat(path.join(root, rel));
      budget.bytes += stat.size;
      if (budget.bytes > 512 * 1024 * 1024) throw new Error("Install unpacked-byte budget exceeded");
      result.set(rel, hash(await fs.readFile(path.join(root, rel))));
    } else throw new Error(`Unsupported archive entry: ${rel}`);
  }
  return result;
}

// Trust only the installed npm executable, not project/user config, Node preload
// hooks or npm environment overrides. No arbitrary flags reach the child.
function installEnvironment(home) {
  const env = {};
  for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TMPDIR", "TEMP", "TMP"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter), HOME: home, USERPROFILE: home, CI: "true", NO_UPDATE_NOTIFIER: "1" };
}

async function verifyInstalled(root, packages) {
  const expected = new Map();
  const installed = [];
  const skipped = [];
  for (const pkg of packages) {
    try { await fs.lstat(path.join(root, pkg.location)); }
    catch (error) {
      if (error.code === "ENOENT" && pkg.entry.optional === true) { skipped.push(pkg.location); continue; }
      throw error;
    }
    installed.push(pkg.location);
    for (const [rel, digest] of pkg.files) expected.set(`${pkg.location}/${rel}`, digest);
  }
  const seen = new Set();
  async function walk(rel) {
    for (const entry of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
      const file = `${rel}/${entry.name}`;
      const full = path.join(root, file);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isSymbolicLink()) {
        const target = path.relative(root, await fs.realpath(full)).split(path.sep).join("/");
        if (path.posix.basename(rel) !== ".bin" || !expected.has(target)) throw new Error(`Unapproved installed link: ${file}`);
      } else if (entry.isFile()) {
        if (file === "node_modules/.package-lock.json") continue;
        if (!expected.has(file) || hash(await fs.readFile(full)) !== expected.get(file)) throw new Error(`Unapproved installed bytes: ${file}`);
        seen.add(file);
      } else throw new Error(`Unsupported installed entry: ${file}`);
    }
  }
  await walk("node_modules");
  for (const file of expected.keys()) if (!seen.has(file)) throw new Error(`Approved file missing after install: ${file}`);
  return { installed, skipped };
}

async function installProject(project = ".", options = {}, deps = {}) {
  if (process.platform === "win32") throw new Error("Enforced install currently supports POSIX npm installations only");
  project = await fs.realpath(path.resolve(project));
  const mutex = path.join(project, ".pkgxray-install.lock");
  await fs.mkdir(mutex, { mode: 0o700 }); // Exclusive; concurrent installs must fail.
  let workspace;
  try {
    for (const name of ["npm-shrinkwrap.json"]) {
      try { await fs.lstat(path.join(project, name)); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      throw new Error("npm-shrinkwrap.json is not yet supported by enforced install");
    }
    const manifestBytes = await readRegular(path.join(project, "package.json"));
    const lockBytes = await readRegular(path.join(project, "package-lock.json"));
    const manifest = JSON.parse(manifestBytes);
    const lock = JSON.parse(lockBytes);
    const packages = validateLock(manifest, lock);
    const initialFilePolicy = artifact.fingerprint(cfg.loadConfig({ cwd: project }).config);
    const config = options.config || cfg.loadConfig({ cwd: project }).config;
    workspace = await fs.mkdtemp(path.join(project, ".pkgxray-install-"));
    const stage = path.join(workspace, "project");
    await fs.mkdir(stage);
    const guard = deps.guard || guardExtension;
    const budget = { bytes: 0, files: 0 };
    const approvals = [];
    const rewritten = { ...lock, lockfileVersion: 3 };
    delete rewritten.dependencies; // v2 legacy tree must not retain remote URLs.
    rewritten.packages = { ...lock.packages };
    let compressedBytes = 0;
    for (const pkg of packages) {
      const scan = await guard(`npm:${pkg.name}@${pkg.version}`, {
        artifact: { resolved: pkg.entry.resolved, integrity: pkg.entry.integrity },
        quarantineRoot: path.join(workspace, "quarantine"), keepStaging: true,
        config, typosquat: config.typosquat, vulnerabilityCheck: true, sourceScan: true, githubDiff: false
      });
      const a = scan.approval;
      if (scan.decision !== "allow" || !require("./approval-policy").receiptAuthorizes(a) || a.name !== pkg.name || a.version !== pkg.version ||
          a.scannerBuildId !== artifact.BUILD_ID || a.policySha256 !== artifact.fingerprint(config) || a.sourceComplete !== true ||
          a.checks?.source !== "completed" || a.checks?.vulnerabilities !== "completed") {
        throw new Error(`Installation refused: ${pkg.name}@${pkg.version} lacks a complete ALLOW receipt (${scan.decision || "unknown"})`);
      }
      const archive = `${scan.stagedPath}.tgz`;
      const verified = await artifact.verifyFile(archive, pkg.entry.integrity);
      if (verified.sha256 !== a.artifactSha256) throw new Error("Approved archive changed after scanning");
      compressedBytes += verified.size;
      if (compressedBytes > 512 * 1024 * 1024) throw new Error("Install archive-byte budget exceeded");
      const packageManifest = JSON.parse(await readRegular(path.join(scan.stagedPath, "package.json")));
      // Package-local dependency metadata can trigger resolution too.
      validateSpecs({ ...packageManifest, devDependencies: undefined });
      if (packageManifest.name !== pkg.name || packageManifest.version !== pkg.version) throw new Error("Approved package identity mismatch");
      pkg.files = await inventory(scan.stagedPath, budget);
      if (pkg.files.has("npm-shrinkwrap.json")) throw new Error("Package-local shrinkwrap is not supported by enforced install");
      const bin = typeof packageManifest.bin === "string" ? { [pkg.name.split("/").at(-1)]: packageManifest.bin } : packageManifest.bin;
      rewritten.packages[pkg.location] = { ...pkg.entry, bin, resolved: pathToFileURL(archive).href,
        integrity: `sha256-${Buffer.from(verified.sha256, "hex").toString("base64")}` };
      approvals.push({ path: pkg.location, ...a });
    }
    await fs.writeFile(path.join(stage, "package.json"), manifestBytes);
    await fs.writeFile(path.join(stage, "package-lock.json"), JSON.stringify(rewritten));
    const home = path.join(workspace, "home");
    await fs.mkdir(home);
    const userconfig = path.join(home, "user.npmrc");
    const globalconfig = path.join(home, "global.npmrc");
    await fs.writeFile(userconfig, "");
    await fs.writeFile(globalconfig, "");
    // Use the npm shipped alongside this Node, never project-local PATH shims.
    const npmCli = await fs.realpath(path.join(path.dirname(process.execPath), "npm"));
    await (deps.run || runCapture)(process.execPath, [npmCli, "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--no-update-notifier",
      "--include=dev", "--include=optional", "--include=peer", "--registry=http://127.0.0.1:9",
      `--cache=${path.join(workspace, "cache")}`, `--userconfig=${userconfig}`, `--globalconfig=${globalconfig}`],
    { timeoutMs: 300000, maxBytes: 4 * 1024 * 1024, spawnOptions: { cwd: stage, env: installEnvironment(home) } });
    await fs.mkdir(path.join(stage, "node_modules"), { recursive: true });
    const checked = await verifyInstalled(stage, packages);
    if (!(await readRegular(path.join(project, "package.json"))).equals(manifestBytes) ||
        !(await readRegular(path.join(project, "package-lock.json"))).equals(lockBytes)) throw new Error("Project manifest or lockfile changed during installation");
    if (artifact.fingerprint(cfg.loadConfig({ cwd: project }).config) !== initialFilePolicy) throw new Error("Project policy changed during installation");
    // npm's hidden lock contains temporary file URLs that will no longer exist.
    await fs.rm(path.join(stage, "node_modules/.package-lock.json"), { force: true });
    const receipt = { schemaVersion: 1, command: "install", manifestSha256: hash(manifestBytes), lockfileSha256: hash(lockBytes),
      scannerBuildId: artifact.BUILD_ID, policySha256: artifact.fingerprint(config), lifecycleScripts: "disabled", acquisition: "approved-local-archives",
      ...checked, approvals, installedAt: new Date().toISOString() };
    await fs.writeFile(path.join(stage, "node_modules/.pkgxray-install.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
    const target = path.join(project, "node_modules");
    let backupPath = null;
    try {
      const stat = await fs.lstat(target);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Existing node_modules must be a real directory");
      backupPath = path.join(project, `.pkgxray-previous-node_modules-${crypto.randomUUID()}`);
      await fs.rename(target, backupPath);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    try { await fs.rename(path.join(stage, "node_modules"), target); }
    catch (error) { if (backupPath) await fs.rename(backupPath, target); throw error; }
    return { decision: "allow", installed: checked.installed.length, skipped: checked.skipped, project,
      receiptPath: path.join(target, ".pkgxray-install.json"), backupPath, lifecycleScripts: "disabled" };
  } finally {
    if (workspace) await fs.rm(workspace, { recursive: true, force: true });
    await fs.rmdir(mutex);
  }
}

module.exports = { installProject, validateLock, installEnvironment, verifyInstalled };
