"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
const server = JSON.parse(readFileSync(resolve(ROOT, "server.json"), "utf8"));

test("MCP Registry and npm ownership metadata agree", () => {
  assert.equal(pkg.mcpName, server.name);
  assert.equal(server.name, "io.github.adamsjack711-ux/pkgxray");
  assert.equal(server.version, pkg.version);
  assert.equal(server.description.length <= 100, true);
  assert.equal(server.repository.id, "1276320499");
  assert.equal(server.packages.length, 1);

  const npmPackage = server.packages[0];
  assert.equal(npmPackage.registryType, "npm");
  assert.equal(npmPackage.registryBaseUrl, "https://registry.npmjs.org");
  assert.equal(npmPackage.identifier, pkg.name);
  assert.equal(npmPackage.version, pkg.version);
  assert.deepEqual(npmPackage.transport, { type: "stdio" });
  assert.deepEqual(npmPackage.packageArguments, [
    { type: "positional", value: "serve-mcp" },
  ]);
  assert.ok(pkg.files.includes("server.json"));
});

test("registry launch entry point performs an MCP initialize handshake", () => {
  const request = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" },
  });
  const result = spawnSync(
    process.execPath,
    [resolve(ROOT, "bin", "audit.js"), "serve-mcp"],
    {
      cwd: ROOT,
      encoding: "utf8",
      input: `${request}\n`,
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout.trim());
  assert.equal(response.id, 1);
  assert.equal(response.result.serverInfo.name, "pkgxray");
  assert.equal(response.result.serverInfo.version, pkg.version);
});

test("registry checklist states the unpublished release blocker", () => {
  const guide = readFileSync(resolve(ROOT, "docs", "mcp-registry.md"), "utf8");
  assert.match(guide, /not published/i);
  assert.match(guide, /currently published `pkgxray@1\.0\.3` predates `mcpName`/);
  assert.match(guide, /mcp-publisher login github/);
  assert.match(guide, /mcp-publisher publish/);
});

test("public setup uses the launcher actually published in pkgxray 1.0.3", () => {
  for (const file of ["README.md", "docs/mcp.md"]) {
    const guide = readFileSync(resolve(ROOT, file), "utf8");
    assert.match(guide, /pkgxray@1\.0\.3/);
    assert.match(guide, /pkgxray-mcp/);
    assert.doesNotMatch(guide, /pkgxray@1\.0\.3[\s\S]{0,80}serve-mcp/);
  }
});
