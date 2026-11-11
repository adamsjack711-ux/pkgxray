"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const CLI = path.resolve(__dirname, "../bin/audit.js");
const HTTP = path.resolve(__dirname, "../src/http-client.js");

for (const mode of ["scan", "promotion", "unchanged"]) {
  test(`CLI checks current policy before promotion: ${mode}`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pkgxray-cli-policy-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, "source"), target = path.join(root, "promoted");
    const config = path.join(root, ".pkgxray.json"), preload = path.join(root, "provider.cjs");
    await fs.mkdir(source); await fs.mkdir(target);
    await fs.writeFile(path.join(source, "package.json"), JSON.stringify({ name: "policy-fixture", version: "1.0.0", main: "index.js" }));
    await fs.writeFile(path.join(source, "index.js"), "exports.add = (a, b) => a + b;");
    await fs.writeFile(path.join(target, "previous"), "retain until authorized commit");
    await fs.writeFile(config, JSON.stringify({ typosquat: false }));
    await fs.writeFile(preload, `
      const fs = require('node:fs');
      const fsp = require('node:fs/promises');
      const change = () => fs.writeFileSync(${JSON.stringify(config)}, JSON.stringify({typosquat:true}));
      require(${JSON.stringify(HTTP)}).requestJson = async url => {
        if (url !== 'https://api.osv.dev/v1/query') throw new Error('Unexpected network request');
        if (${JSON.stringify(mode)} === 'scan') change();
        return {};
      };
      const copy = fsp.cp;
      fsp.cp = async (from, to, opts) => {
        await copy(from, to, opts);
        if (${JSON.stringify(mode)} === 'promotion' && String(to).includes('.pkgxray-promotion-')) change();
      };
    `);
    const result = spawnSync(process.execPath, ["--require", preload, CLI, "guard", source,
      "--promote-to", target, "--force", "--no-github", "--format", "json"], {
      cwd: root, encoding: "utf8", timeout: 10000
    });
    assert.ifError(result.error);
    const output = JSON.parse(result.stdout);
    assert.equal(output.schemaVersion, 2);
    if (mode === "unchanged") {
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(output.decision, "allow");
      assert.equal(output.quarantinePath, null);
      assert.equal(await fs.readFile(path.join(target, "index.js"), "utf8"), "exports.add = (a, b) => a + b;");
      await assert.rejects(fs.stat(path.join(target, "previous")), { code: "ENOENT" });
    } else {
      assert.equal(result.status, 2, result.stderr || result.stdout);
      assert.equal(output.decision, "block");
      assert.match(output.scanError, /Policy changed/);
      assert.equal(await fs.readFile(path.join(target, "previous"), "utf8"), "retain until authorized commit");
      await assert.rejects(fs.stat(path.join(target, "index.js")), { code: "ENOENT" });
    }
  });
}
