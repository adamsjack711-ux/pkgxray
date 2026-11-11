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
const { installProject, validateLock, installEnvironment, resolveTrustedNpmCli } = require("../src/install");
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
    // macOS resource forks must not add unsigned AppleDouble files to fixtures.
    execFileSync("tar", ["-czf", archive, "-C", root, name], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
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
  await assert.rejects(installProject(f.project, { config }, { guard: f.guard }), /refused/);
  await assert.rejects(installProject(f.project, { config, reviewChoice: "Proceed" }, { guard: f.guard }), /Manual REVIEW options have been removed/);
  await assert.rejects(fs.stat(path.join(f.project, "node_modules")), { code: "ENOENT" });
  // A fixed operator policy can suppress this known hook finding. Even then,
  // npm cannot execute it or obey hostile project/environment configuration.
  const policy = { ...DEFAULTS, mute: [{ check: "install-hook", scope: "*", reason: "fixture policy" }] };
  const result = await installProject(f.project, { config: policy }, { guard: f.guard });
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

test("requiring provenance refuses an earlier complete approval before npm runs", async t => {
  const previous = process.env.PKGXRAY_REQUIRE_PROVENANCE;
  delete process.env.PKGXRAY_REQUIRE_PROVENANCE;
  t.after(() => {
    if (previous === undefined) delete process.env.PKGXRAY_REQUIRE_PROVENANCE;
    else process.env.PKGXRAY_REQUIRE_PROVENANCE = previous;
  });
  const f = await fixture(t);
  const oldScan = await f.guard('npm:demo@1.0.0', {
    config: DEFAULTS, keepStaging: true, quarantineRoot: path.join(f.root, 'old-scan'),
    sourceScan: true, vulnerabilityCheck: true, artifact: { integrity: f.lock.packages['node_modules/demo'].integrity }
  });
  assert.equal(oldScan.decision, 'allow');
  assert.equal(oldScan.approval.checks.source, 'completed');
  process.env.PKGXRAY_REQUIRE_PROVENANCE = '1';
  let executed = false;
  await assert.rejects(installProject(f.project, { config: DEFAULTS }, {
    guard: async () => oldScan, run: async () => { executed = true; }
  }), /lacks a complete ALLOW receipt/);
  assert.equal(executed, false, 'an earlier permissive receipt never invokes npm');
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

test("trusted npm discovery supports split Node/npm prefixes and skips PATH shims", async t => {
  const f = await fixture(t);
  const hostile = path.join(f.root, "hostile-bin");
  const npmRoot = path.join(f.root, "trusted", "lib", "node_modules", "npm");
  const npmBin = path.join(npmRoot, "bin");
  const trustedPath = path.join(f.root, "trusted", "bin");
  await fs.mkdir(hostile);
  await fs.mkdir(npmBin, { recursive: true });
  await fs.mkdir(trustedPath, { recursive: true });
  await fs.writeFile(path.join(hostile, "npm"), "#!/bin/sh\nexit 91\n", { mode: 0o755 });
  await fs.writeFile(path.join(npmRoot, "package.json"), JSON.stringify({ name: "npm", version: "99.0.0" }));
  const cli = path.join(npmBin, "npm-cli.js");
  await fs.writeFile(cli, "#!/usr/bin/env node\n", { mode: 0o755 });
  await fs.symlink(cli, path.join(trustedPath, "npm"));
  const resolved = await resolveTrustedNpmCli(f.project, {
    execPath: path.join(f.root, "split-node", "node"),
    env: { PATH: `${hostile}${path.delimiter}${trustedPath}` }
  });
  assert.equal(resolved, await fs.realpath(cli));
});

test("trusted npm discovery rejects a project-controlled npm package", async t => {
  const f = await fixture(t);
  const npmRoot = path.join(f.project, "tools", "node_modules", "npm");
  await fs.mkdir(path.join(npmRoot, "bin"), { recursive: true });
  await fs.writeFile(path.join(npmRoot, "package.json"), JSON.stringify({ name: "npm", version: "99.0.0" }));
  const cli = path.join(npmRoot, "bin", "npm-cli.js");
  await fs.writeFile(cli, "#!/usr/bin/env node\n", { mode: 0o755 });
  await assert.rejects(resolveTrustedNpmCli(f.project, {
    execPath: path.join(f.root, "split-node", "node"),
    env: { PATH: "" }, explicit: cli
  }), /Trusted npm CLI not found/);
});

test('uncertain archives cannot promote or install through old manual choices', async t => {
  const f = await fixture(t, { scripts: true });
  const promoteTo = path.join(f.root, 'promoted');
  const options = { config: DEFAULTS, promoteTo,
    artifact: { integrity: f.lock.packages['node_modules/demo'].integrity } };
  const blocked = await f.guard('npm:demo@1.0.0', options);
  assert.equal(blocked.decision, 'block');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.outcome, 'UNSAFE');
  assert.equal(blocked.approval.decision, 'block');
  assert.equal(blocked.review, null);
  assert.equal(blocked.reviewPlan, null);
  assert.ok(blocked.resolution.reasonCodes.includes('uncertain-findings'));
  await assert.rejects(fs.stat(promoteTo), { code: 'ENOENT' });
  for (const legacy of [{ reviewChoice: 'Proceed' }, { reviewId: 'old' },
    { reviewDecisions: { choose() { throw new Error('must not use'); } } }, { reviewScope: 'alice' }, { reviewAction: 'install' }]) {
    await assert.rejects(f.guard('npm:demo@1.0.0', { ...options, ...legacy }), /Manual REVIEW options have been removed/);
  }
  let ran = false;
  await assert.rejects(installProject(f.project, { config: DEFAULTS }, { guard: async (...args) => {
    const scan = await f.guard(...args);
    // An old adapter claiming a remembered Proceed is still refused.
    return { ...scan, decision: 'review', allowed: true, review: { choice: 'Proceed' } };
  }, run: async () => { ran = true; } }), /refused/);
  assert.equal(ran, false);
});

test('changed uncertain archive bytes remain blocked without any decision store', async t => {
  const f = await fixture(t, { scripts: true });
  const target = path.join(f.root, 'target');
  const options = { config: DEFAULTS, promoteTo: target,
    artifact: { integrity: f.lock.packages['node_modules/demo'].integrity } };
  const first = await f.guard('npm:demo@1.0.0', options);
  await fs.appendFile(path.join(f.root, 'demo/index.js'), '\nexports.changed = true;\n');
  execFileSync('tar', ['-czf', f.archives.get('demo'), '-C', f.root, 'demo'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const bytes = await fs.readFile(f.archives.get('demo'));
  options.artifact.integrity = `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`;
  const changed = await f.guard('npm:demo@1.0.0', options);
  assert.notEqual(first.approval.artifactSha256, changed.approval.artifactSha256);
  assert.equal(changed.allowed, false);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});

test('cancellation during promotion preparation preserves the existing destination and removes temporary copies', async t => {
  const f = await fixture(t);
  const target = path.join(f.root,'existing'); await fs.mkdir(target);
  await fs.writeFile(path.join(target,'original'),'keep');
  const controller = new AbortController(); let validations = 0;
  await assert.rejects(f.guard('npm:demo@1.0.0', { config: DEFAULTS,
    artifact: { integrity: f.lock.packages['node_modules/demo'].integrity },
    promoteTo: target, force: true, signal: controller.signal,
    validatePolicy() { if (++validations === 2) controller.abort(); }
  }), { name: 'AbortError' });
  assert.equal(await fs.readFile(path.join(target,'original'),'utf8'),'keep');
  assert.ok(!(await fs.readdir(f.root)).some(name => name.startsWith('.pkgxray-promotion-')));
});

test('policy changes while writing the receipt cannot replace the existing installation', async t => {
  const cases = [
    ['setting', async (f, write) => write(path.join(f.project, '.pkgxray.json'), JSON.stringify({ typosquat: true }))],
    ['deleted policy with identical defaults', async f => fs.unlink(path.join(f.project, '.pkgxray.json'))],
    ['malformed policy with identical defaults', async (f, write) => write(path.join(f.project, '.pkgxray.json'), '{broken')],
    ['local override', async (f, write) => write(path.join(f.project, '.pkgxray.local.json'), JSON.stringify({ typosquat: false }))],
    ['supplied effective policy', async (f, write, config) => { config.typosquat = !config.typosquat; }]
  ];
  for (const [name, mutate] of cases) await t.test(name, async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.project, '.pkgxray.json'), '{}');
    await fs.mkdir(path.join(f.project, 'node_modules'));
    await fs.writeFile(path.join(f.project, 'node_modules/original'), 'keep');
    const config = structuredClone(DEFAULTS);
    const originalWrite = fs.writeFile;
    let changed = false;
    fs.writeFile = async (file, ...args) => {
      await originalWrite(file, ...args);
      if (String(file).endsWith('/node_modules/.pkgxray-install.json')) {
        changed = true;
        await mutate(f, originalWrite, config);
      }
    };
    try {
      await assert.rejects(installProject(f.project, { config }, { guard: f.guard }), /policy changed/i);
    } finally { fs.writeFile = originalWrite; }
    assert.equal(changed, true, 'mutation lands after the earlier validation during receipt writing');
    assert.equal(await fs.readFile(path.join(f.project, 'node_modules/original'), 'utf8'), 'keep');
    assert.deepEqual(await fs.readdir(path.join(f.project, 'node_modules')), ['original']);
    assert.ok(!(await fs.readdir(f.project)).some(name => name.startsWith('.pkgxray-previous-') || name.startsWith('.pkgxray-install')));
  });
});


test('failed installation replacement synchronously restores the previous tree', async t => {
  const f = await fixture(t);
  const target = path.join(await fs.realpath(f.project), 'node_modules');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'original'), 'keep');
  const sync = require('node:fs');
  const rename = sync.renameSync;
  let attempted = false;
  sync.renameSync = (source, destination) => {
    if (String(source).includes('/project/node_modules') && destination === target) {
      attempted = true;
      throw Object.assign(new Error('simulated replacement failure'), { code: 'EIO' });
    }
    return rename(source, destination);
  };
  try {
    await assert.rejects(installProject(f.project, { config: DEFAULTS }, { guard: f.guard }), /simulated replacement failure/);
  } finally { sync.renameSync = rename; }
  assert.equal(attempted, true);
  assert.equal(await fs.readFile(path.join(target, 'original'), 'utf8'), 'keep');
  assert.deepEqual(await fs.readdir(target), ['original']);
  assert.ok(!(await fs.readdir(f.project)).some(name => name.startsWith('.pkgxray-previous-') || name.startsWith('.pkgxray-install')));
});

test('scanner build is revalidated after receipt writing before installation commit', async t => {
  const f = await fixture(t);
  const target = path.join(await fs.realpath(f.project), 'node_modules');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'original'), 'keep');
  const sharing = require('../src/shared-scans');
  const validate = sharing.assertCurrentBuild;
  const write = fs.writeFile;
  let receiptWritten = false;
  fs.writeFile = async (file, ...args) => {
    await write(file, ...args);
    if (String(file).endsWith('/node_modules/.pkgxray-install.json')) receiptWritten = true;
  };
  sharing.assertCurrentBuild = () => {
    if (receiptWritten) throw Object.assign(new Error('simulated scanner build change'), { code: 'SCANNER_CHANGED' });
    validate();
  };
  try {
    await assert.rejects(installProject(f.project, { config: DEFAULTS }, { guard: f.guard }), { code: 'SCANNER_CHANGED' });
  } finally { fs.writeFile = write; sharing.assertCurrentBuild = validate; }
  assert.equal(receiptWritten, true);
  assert.deepEqual(await fs.readdir(target), ['original']);
});
