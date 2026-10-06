"use strict";
const nodeTest = require("node:test");
// Executable-link layout and the installation transaction are POSIX-only.
const test = (name, fn) => nodeTest(name, { skip: process.platform === "win32" }, fn);
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { installProject, validateLock, installEnvironment } = require("../src/install");
const { guardExtension } = require("../src/quarantine");
const { DEFAULTS } = require("../src/config");
const { parseArgs } = require("../bin/audit");
const { runCapture } = require("../src/bounded-process");

async function fixture(t, { scripts = false, bins = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pkgxray-install-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  await fs.mkdir(project);
  const archives = new Map();
  const packages = { "": { name: "app", version: "1.0.0", dependencies: { demo: "1.0.0" } } };
  for (const [name, dependencies] of [["demo", { transitive: "1.0.0" }], ["transitive", {}]]) {
    const dir = path.join(root, name);
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js", dependencies, ...(bins ? { bin: { [name]: "index.js" } } : {}),
      ...(scripts ? { scripts: { postinstall: "node install.js" } } : {}) }));
    await fs.writeFile(path.join(dir, "index.js"), "module.exports = 42;\n");
    if (scripts) await fs.writeFile(path.join(dir, "install.js"), "require('fs').writeFileSync('SCRIPT-RAN', 'bad');\n");
    const archive = path.join(root, `${name}.tgz`);
    execFileSync("tar", ["-czf", archive, "-C", root, name]);
    const bytes = await fs.readFile(archive);
    const integrity = `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
    archives.set(name, archive);
    packages[`node_modules/${name}`] = { version: "1.0.0", resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`, integrity, dependencies, ...(bins ? { bin: { [name]: "index.js" } } : {}) };
  }
  const manifest = { ...packages[""], ...(scripts ? { scripts: { preinstall: "node -e \"process.exit(77)\"" } } : {}) };
  const lock = { name: "app", version: "1.0.0", lockfileVersion: 3, packages };
  await fs.writeFile(path.join(project, "package.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(project, "package-lock.json"), JSON.stringify(lock));
  const transport = require("../src/http-client");
  const original = transport.requestJson;
  transport.requestJson = async url => { assert.equal(url, "https://api.osv.dev/v1/query"); return {}; };
  t.after(() => { transport.requestJson = original; });
  const guard = (ref, opts) => {
    const name = ref.slice(4, ref.lastIndexOf("@"));
    return guardExtension(ref, { ...opts, artifact: { ...opts.artifact, archivePath: archives.get(name) }, githubMetadata: false, provenance: false });
  };
  return { root, project, manifest, lock, archives, guard };
}

test("enforced install uses real approved archives for direct and transitive dependencies", async t => {
  const f = await fixture(t);
  const before = await fs.readFile(path.join(f.project, "package-lock.json"));
  await fs.mkdir(path.join(f.project, "node_modules"));
  await fs.writeFile(path.join(f.project, "node_modules/old.txt"), "keep me");
  const result = await installProject(f.project, { config: DEFAULTS }, { guard: f.guard });
  assert.equal(result.installed, 2);
  for (const name of ["demo", "transitive"]) assert.equal(await fs.readFile(path.join(f.project, `node_modules/${name}/index.js`), "utf8"), "module.exports = 42;\n");
  assert.equal(await fs.readFile(path.join(result.backupPath, "old.txt"), "utf8"), "keep me");
  assert.deepEqual(await fs.readFile(path.join(f.project, "package-lock.json")), before);
  const receipt = JSON.parse(await fs.readFile(result.receiptPath));
  assert.equal(receipt.approvals.length, 2);
  assert.equal(receipt.lifecycleScripts, "disabled");
  assert.ok(!(await fs.readdir(f.project)).some(n => n.startsWith(".pkgxray-install-")));
});

test("lifecycle scripts and hostile npm configuration cannot override the installer", async t => {
  const f = await fixture(t, { scripts: true });
  await fs.writeFile(path.join(f.project, ".npmrc"), "ignore-scripts=false\noffline=false\nregistry=https://untrusted.invalid\n");
  const old = process.env.npm_config_ignore_scripts;
  process.env.npm_config_ignore_scripts = "false";
  t.after(() => { if (old === undefined) delete process.env.npm_config_ignore_scripts; else process.env.npm_config_ignore_scripts = old; });
  const config = { ...DEFAULTS, policy: "allow-review" };
  const result = await installProject(f.project, { config }, { guard: f.guard });
  assert.equal(result.installed, 2);
  for (const name of ["demo", "transitive"]) await assert.rejects(fs.stat(path.join(f.project, `node_modules/${name}/SCRIPT-RAN`)), { code: "ENOENT" });
  assert.equal(installEnvironment("/private/home").npm_config_ignore_scripts, undefined);
});

test("unbound, incomplete and modified approvals stop before npm or replacing node_modules", async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.project, "node_modules"));
  await fs.writeFile(path.join(f.project, "node_modules/old.txt"), "original");
  for (const modify of [s => { delete s.approval; }, s => { s.approval.sourceComplete = false; },
    s => { s.approval.schemaVersion = 1; }, s => { s.approval.authorization.mandatoryHoldReasons = ['flow-analysis-gap']; },
    s => { s.approval.artifactSha256 = "0".repeat(64); }, s => { s.approval.checks.vulnerabilities = "failed"; }]) {
    let ran = false;
    await assert.rejects(installProject(f.project, { config: DEFAULTS }, { guard: async (...args) => {
      const scan = await f.guard(...args); modify(scan); return scan;
    }, run: async () => { ran = true; } }), /refused|changed/);
    assert.equal(ran, false);
    assert.equal(await fs.readFile(path.join(f.project, "node_modules/old.txt"), "utf8"), "original");
  }
});

test("post-install mutations and project lockfile changes prevent promotion", async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.project, "node_modules"));
  await fs.writeFile(path.join(f.project, "node_modules/old.txt"), "original");
  for (const mutate of [async stage => fs.writeFile(path.join(stage, "node_modules/demo/index.js"), "replaced"),
    async () => fs.appendFile(path.join(f.project, "package-lock.json"), " ")]) {
    await assert.rejects(installProject(f.project, { config: DEFAULTS }, { guard: f.guard, run: async (cmd, args, opts) => {
      await runCapture(cmd, args, opts);
      await mutate(opts.spawnOptions.cwd);
    } }), /Unapproved installed bytes|changed during installation/);
    assert.equal(await fs.readFile(path.join(f.project, "node_modules/old.txt"), "utf8"), "original");
  }
});

test("rejects lockfile path escapes, missing integrity and non-registry sources", async t => {
  const f = await fixture(t);
  for (const update of [l => { l.packages["node_modules/../escape"] = l.packages["node_modules/demo"]; },
    l => { delete l.packages["node_modules/demo"].integrity; },
    l => { l.packages["node_modules/demo"].resolved = "file:../evil.tgz"; },
    l => { l.packages["node_modules/demo"].link = true; },
    l => { l.packages["node_modules/demo"].dependencies.transitive = "git+https://evil.invalid/repo"; }]) {
    const lock = structuredClone(f.lock); update(lock);
    assert.throws(() => validateLock(f.manifest, lock));
  }
  assert.throws(() => validateLock({ ...f.manifest, workspaces: ["packages/*"] }, f.lock), /workspaces/);
  assert.throws(() => parseArgs(["install", ".", "--ignore-scripts=false"]), /Unsupported install option/);
  assert.throws(() => parseArgs(["install", ".", "--no-vulnerability-check"]), /Unsupported install option/);
  assert.deepEqual(parseArgs(["install", "--format", "json"]).project, ".");
});

test("npm cannot fall back to a registry when a snapshot disappears", async t => {
  const f = await fixture(t);
  let output = "";
  await assert.rejects(installProject(f.project, { config: DEFAULTS }, { guard: f.guard, run: async (cmd, args, opts) => {
    const lock = JSON.parse(await fs.readFile(path.join(opts.spawnOptions.cwd, "package-lock.json")));
    for (const [location, entry] of Object.entries(lock.packages)) {
      if (location) await fs.rm(require("node:url").fileURLToPath(entry.resolved));
    }
    assert.ok(args.includes("--offline"));
    assert.ok(args.includes("--ignore-scripts"));
    assert.notEqual(opts.spawnOptions.env.HOME, process.env.HOME);
    try { await runCapture(cmd, args, opts); } catch (error) { output = error.message; throw error; }
  } }));
  assert.match(output, /ENOENT|ENOTCACHED|not found/i);
  await assert.rejects(fs.stat(path.join(f.project, "node_modules")), { code: "ENOENT" });
});

test("inconsistent dependency locks cannot install an unapproved missing package", async t => {
  const f = await fixture(t);
  delete f.lock.packages["node_modules/transitive"];
  await fs.writeFile(path.join(f.project, "package-lock.json"), JSON.stringify(f.lock));
  await assert.rejects(installProject(f.project, { config: DEFAULTS }, { guard: f.guard }), /exited/);
  await assert.rejects(fs.stat(path.join(f.project, "node_modules")), { code: "ENOENT" });
});

test("rejects unsafe executable links before invoking npm", async t => {
  const f = await fixture(t);
  for (const bin of [{ demo: "../../outside" }, { "../outside": "index.js" }, { demo: "/outside" }, { demo: "..\\outside" }]) {
    const lock = structuredClone(f.lock);
    lock.packages["node_modules/demo"].bin = bin;
    assert.throws(() => validateLock(f.manifest, lock), /Unsafe executable/);
  }
});

test("changed policy and concurrent installs cannot replace the existing tree", async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.project, ".pkgxray-install.lock"));
  await assert.rejects(installProject(f.project, {}, { guard: f.guard }), { code: "EEXIST" });
  await fs.rmdir(path.join(f.project, ".pkgxray-install.lock"));
  await assert.rejects(installProject(f.project, { config: DEFAULTS }, { guard: f.guard, run: async (...args) => {
    await runCapture(...args);
    await fs.writeFile(path.join(f.project, ".pkgxray.json"), JSON.stringify({ policy: "allow-review" }));
  } }), /policy changed/);
  await assert.rejects(fs.stat(path.join(f.project, "node_modules")), { code: "ENOENT" });
});


test("nested dependencies and executable links retain approved bytes after promotion", async t => {
  const f = await fixture(t, { bins: true });
  f.lock.packages["node_modules/demo/node_modules/transitive"] = f.lock.packages["node_modules/transitive"];
  delete f.lock.packages["node_modules/transitive"];
  await fs.writeFile(path.join(f.project, "package-lock.json"), JSON.stringify(f.lock));
  const result = await installProject(f.project, { config: DEFAULTS }, { guard: f.guard });
  assert.equal(result.installed, 2);
  assert.equal(await fs.realpath(path.join(f.project, "node_modules/.bin/demo")), path.join(result.project, "node_modules/demo/index.js"));
  assert.equal(await fs.realpath(path.join(f.project, "node_modules/demo/node_modules/.bin/transitive")), path.join(result.project, "node_modules/demo/node_modules/transitive/index.js"));
});


test("CLI installs an empty locked project and emits a receipt without network acquisition", async t => {
  const f = await fixture(t);
  const manifest = { name: "empty-app", version: "1.0.0" };
  await fs.writeFile(path.join(f.project, "package.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(f.project, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": manifest } }));
  const stdout = await runCapture(process.execPath, [path.resolve(__dirname, "../bin/audit.js"), "install", f.project, "--format", "json"]);
  const result = JSON.parse(stdout);
  assert.equal(result.decision, "allow");
  assert.equal(result.installed, 0);
  assert.equal(JSON.parse(await fs.readFile(result.receiptPath)).lifecycleScripts, "disabled");
});

nodeTest("enforced install explicitly rejects Windows instead of silently weakening checks", { skip: process.platform !== "win32" }, async () => {
  await assert.rejects(installProject("."), /POSIX/);
});


test("project PATH shims and Node preloads cannot hijack npm installation", async t => {
  const f = await fixture(t);
  const shims = path.join(f.root, "shims");
  await fs.mkdir(shims);
  for (const name of ["npm", "node", "tar", "gzip"]) await fs.writeFile(path.join(shims, name), "#!/bin/sh\nexit 91\n", { mode: 0o755 });
  const previousPath = process.env.PATH;
  const previousOptions = process.env.NODE_OPTIONS;
  const previousTar = process.env.TAR_OPTIONS;
  process.env.PATH = `${shims}${path.delimiter}${previousPath}`;
  process.env.NODE_OPTIONS = "--require=/nonexistent/untrusted-preload.js";
  process.env.TAR_OPTIONS = "--pkgxray-invalid-tar-option";
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousOptions;
    if (previousTar === undefined) delete process.env.TAR_OPTIONS; else process.env.TAR_OPTIONS = previousTar;
  });
  const result = await installProject(f.project, { config: DEFAULTS }, { guard: f.guard });
  assert.equal(result.installed, 2);
});
