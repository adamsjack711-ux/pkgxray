"use strict";

// #7 direct-dependency scan — the network-free branches. The OSV-batched path
// is exercised by the CLI integration; here we pin the parsing / skip logic
// (no registry specifiers to resolve → no network, deterministic).

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { scanDirectDependencies } = require("../src/quarantine");

async function stagedWith(pkgJson) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pkgxray-deps-"));
  await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify(pkgJson));
  return dir;
}

test("#7 a package with no dependencies scans zero (no network)", async () => {
  const dir = await stagedWith({ name: "x", version: "1.0.0" });
  const result = await scanDirectDependencies(dir);
  assert.equal(result.scanned, 0);
  assert.deepEqual(result.flagged, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("#7 non-registry specifiers (file:/workspace:/git+) are skipped, not queried", async () => {
  const dir = await stagedWith({
    name: "x",
    version: "1.0.0",
    dependencies: {
      local: "file:../local",
      mono: "workspace:*",
      forked: "git+https://github.com/a/b.git",
      viaGithub: "github:a/b"
    }
  });
  // All four are unresolvable by OSV → scanned stays 0 and no network call is
  // attempted (the function returns before requiring the OSV client).
  const result = await scanDirectDependencies(dir);
  assert.equal(result.scanned, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("#7 missing package.json yields an honest empty result", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pkgxray-deps-"));
  const result = await scanDirectDependencies(dir);
  assert.equal(result.scanned, 0);
  assert.match(result.note, /no readable package\.json/);
  fs.rmSync(dir, { recursive: true, force: true });
});
