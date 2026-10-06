"use strict";

const assert = require("node:assert/strict");
const { existsSync, readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { tmpdir } = require("node:os");
const { dirname, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = resolve(__dirname, "..");
const README = readFileSync(resolve(ROOT, "README.md"), "utf8").replace(/\r\n/g, "\n");
const PACKAGE = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
const CLI = resolve(ROOT, "bin", "audit.js");
const FIXTURE = resolve(ROOT, "examples", "onboarding-malicious.json");
const ACTIONS_GUIDE = readFileSync(
  resolve(ROOT, "docs", "integrations", "github-actions.md"),
  "utf8"
);
const AUDIT_WORKFLOW = readFileSync(
  resolve(ROOT, ".github", "workflows", "pkgxray-audit.yml"),
  "utf8"
);

test("README uses the canonical project description and zero-install command", () => {
  const canonical =
    "pkgxray — pre-install security for npm packages, MCP servers, and AI agents";
  assert.match(README, new RegExp(canonical));
  assert.ok(PACKAGE.description.startsWith(canonical));
  const commands = [...README.matchAll(/npx --yes pkgxray@([^\s]+) ([^\n]+)/g)];
  assert.ok(commands.length >= 2, "expected both registry and fixture onboarding commands");
  // Pins may trail package.json before publication, but cannot silently drift
  // between the two steps or use a mutable latest/dist-tag reference.
  const pins = new Set(commands.map((match) => match[1]));
  assert.equal(pins.size, 1, "onboarding commands must use the same release");
  const pin = [...pins][0];
  assert.match(pin, /^\d+\.\d+\.\d+$/);
  const pinnedParts = pin.split(".").map(Number);
  const currentParts = PACKAGE.version.split(".").map(Number);
  const firstDifference = pinnedParts.findIndex((value, index) => value !== currentParts[index]);
  assert.ok(firstDifference === -1 || pinnedParts[firstDifference] < currentParts[firstDifference],
    "README must not reference a future release");
  assert.ok(commands.some((match) => match[2] === "guard npm:express@4.21.0"));
});

test("README relative links and image paths exist", () => {
  const targets = [
    ...README.matchAll(/!?\[[^\]]*]\(([^)]+)\)/g),
    ...README.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi),
  ].map((match) => match[1]);

  const missing = [];
  for (const target of targets) {
    if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
    const path = decodeURIComponent(target.split("#", 1)[0]);
    if (path && !existsSync(resolve(ROOT, path))) missing.push(target);
  }
  assert.deepEqual(missing, []);
});

test("documented onboarding works from a fresh directory with the packed CLI", { timeout: 30000 }, (t) => {
  const download = README.match(/curl --fail --location --output (\S+) \\\n\s+(https:\/\/raw\.githubusercontent\.com\/adamsjack711-ux\/pkgxray\/([a-f0-9]{40})\/(\S+))/);
  assert.ok(download, "fixture download must use an immutable GitHub commit URL");
  const command = README.match(/npx --yes pkgxray@\d+\.\d+\.\d+ (--file [^\n]+)/);
  assert.ok(command, "expected the documented file scan command");
  const args = command[1].trim().split(/\s+/);
  assert.equal(args[1], `./${download[1]}`, "scan must use the downloaded filename");

  // Use the reviewed download bytes offline. This works in shallow CI clones
  // and ensures a fixture edit cannot silently change the pinned demo.
  assert.equal(resolve(ROOT, download[4]), FIXTURE);
  // A Windows checkout may use CRLF; the immutable download uses LF bytes.
  const fixture = Buffer.from(readFileSync(FIXTURE, "utf8").replace(/\r\n/g, "\n"));
  assert.equal(createHash("sha256").update(fixture).digest("hex"),
    "c3d00feefdf6a15ac0e020e3e749927098907cb57d59148fa653a46c279cd049");
  const temp = mkdtempSync(resolve(tmpdir(), "pkgxray-onboarding-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  // Windows cannot spawn npm.cmd directly on patched Node releases. Invoke the
  // npm CLI bundled beside node.exe so paths with spaces need no shell quoting.
  const npmArgs = ["pack", "--ignore-scripts", "--offline", "--json", "--pack-destination", temp];
  const npmCommand = process.platform === "win32" ? process.execPath : "npm";
  if (process.platform === "win32") {
    const npmCli = process.env.npm_execpath || resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
    assert.ok(existsSync(npmCli), "expected the npm CLI supplied by the Node installation");
    npmArgs.unshift(npmCli);
  }
  const pack = spawnSync(npmCommand, npmArgs,
    { cwd: ROOT, encoding: "utf8", timeout: 20000 });
  assert.ifError(pack.error);
  assert.equal(pack.status, 0, pack.stderr || pack.stdout);
  const archive = resolve(temp, Object.values(JSON.parse(pack.stdout))[0].filename);
  const unpack = spawnSync("tar", ["-xzf", archive, "-C", temp], { encoding: "utf8" });
  assert.ifError(unpack.error);
  assert.equal(unpack.status, 0, unpack.stderr);
  const packedRoot = resolve(temp, "package");
  const packedPackage = JSON.parse(readFileSync(resolve(packedRoot, "package.json"), "utf8"));
  const freshCwd = resolve(temp, "fresh-user-directory");
  mkdirSync(freshCwd);
  assert.equal(existsSync(resolve(freshCwd, "examples")), false);
  writeFileSync(resolve(freshCwd, download[1]), fixture);
  const result = spawnSync(process.execPath,
    [resolve(packedRoot, packedPackage.bin.pkgxray), ...args],
    { cwd: freshCwd, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stdout, /BLOCK/i);
  assert.match(result.stdout, /credential-access/);
});

test("documented entry points remain present in CLI help", () => {
  const result = spawnSync(process.execPath, [CLI, "--help"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const help = `${result.stdout}\n${result.stderr}`;
  // Every command — common and advanced — must remain discoverable.
  for (const command of [
    "guard",
    "audit",
    "recheck",
    "mcp",
    "mcp-proxy",
    "serve-mcp",
    "canary",
    "triage",
    "mcp-server",
  ]) {
    assert.match(help, new RegExp(`pkgxray ${command.replace("-", "\\-")}`));
  }
  for (const flag of ["--file", "--format json"]) assert.match(help, new RegExp(flag));
  // Help is grouped so the first screen leads with the common commands.
  assert.match(help, /Common commands/i);
  assert.match(help, /Advanced/i);
  // The canary line must be explicit that it executes untrusted package code and
  // requires the opt-in flag — this is the one path that runs the package.
  assert.match(help, /canary[^\n]*--yes-run-untrusted-code/);
  assert.match(help, /EXECUTES untrusted package code/);
});

test("CLI exit-code contract stays SAFE=0, REVIEW=3, BLOCK=2", () => {
  const { exitCodeForVerdict } = require(resolve(ROOT, "src", "config.js"));
  assert.equal(exitCodeForVerdict("safe", {}), 0);
  assert.equal(exitCodeForVerdict("allow", {}), 0);
  assert.equal(exitCodeForVerdict("review", {}), 3);
  assert.equal(exitCodeForVerdict("block", {}), 2);

  // End-to-end: incomplete evidence fails closed to REVIEW (exit 3), never safe.
  const review = spawnSync(process.execPath, [CLI, "--format", "json"], {
    cwd: ROOT,
    encoding: "utf8",
    input: JSON.stringify({ packageName: "exit-code-probe", sourceFiles: [] }),
  });
  assert.equal(review.status, 3, review.stderr || review.stdout);
  assert.equal(JSON.parse(review.stdout).verdict, "review");
});

test("pkgxray --version reports the package version", () => {
  const result = spawnSync(process.execPath, [CLI, "--version"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), PACKAGE.version);
});

test("GitHub Actions documentation covers every supported manifest and package guard", () => {
  for (const target of [
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "pnpm-lock.yml",
    "yarn.lock",
    "package.json",
  ]) {
    assert.match(ACTIONS_GUIDE, new RegExp(target.replaceAll(".", "\\.")));
    assert.match(AUDIT_WORKFLOW, new RegExp(target.replaceAll(".", "\\.")));
  }
  assert.match(ACTIONS_GUIDE, /guard npm:express@4\.21\.0/);
  assert.match(AUDIT_WORKFLOW, /PACKAGE_REFERENCE/);
});

test("GitHub Actions examples pin dependencies and avoid global installs", () => {
  for (const source of [ACTIONS_GUIDE, AUDIT_WORKFLOW]) {
    const uses = [...source.matchAll(/uses:\s+\S+@([0-9a-f]{40})/g)];
    assert.ok(uses.length > 0, "expected at least one full-SHA action reference");
    assert.doesNotMatch(source, /uses:\s+\S+@(?:main|master|v\d+)/);
    assert.doesNotMatch(source, /npx[^\n]*pkgxray@latest|npm install -g pkgxray/);
  }
  assert.match(AUDIT_WORKFLOW, /persist-credentials:\s+false/);
  // The live reusable workflow pins the last PUBLISHED release (bumped to the new
  // version only after it is on npm), so its default may trail package.json.
  const defaultPin = AUDIT_WORKFLOW.match(/pkgxray-version:[\s\S]*?default:\s+"(\d+\.\d+\.\d+)"/);
  assert.ok(defaultPin, "reusable workflow must default to an exact release pin");
});
