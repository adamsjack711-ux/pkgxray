"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { scanDistribution } = require("../src/distribution");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkgxray-distribution-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (file, value) => {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof value === "string" ? value : JSON.stringify(value));
  };
  return { root, put };
}

test("distribution auto-detection composes CI and agent analyzers", t => {
  const f = fixture(t);
  f.put(".github/workflows/build.yml", "steps:\n  - uses: actions/checkout@v4\n");
  f.put(".mcp.json", { mcpServers: { example: { command: "npx", args: ["server@latest"] } } });
  const result = scanDistribution(f.root);
  assert.deepEqual(result.metadata.detectedTypes, ["ci", "agent"]);
  assert.deepEqual(result.families.map(item => item.family), ["ci-dependencies", "agent-package"]);
  assert.ok(result.findings.some(item => item.category === "ci-mutable-reference"));
  assert.ok(result.findings.some(item => item.category === "agent-package-launcher"));
  assert.equal(result.verdict, "review");
});

test("distribution scan fails visible when auto-detection finds no supported descriptors", t => {
  const f = fixture(t);
  f.put("README.md", "plain text");
  const result = scanDistribution(f.root);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.verdict, "review");
  assert.match(result.coverage.reasons[0], /no supported/);
});

test("distribution scan rejects files and unsupported types", t => {
  const f = fixture(t);
  f.put("file.txt", "text");
  assert.throws(() => scanDistribution(path.join(f.root, "file.txt")), /extracted directory/);
  assert.throws(() => scanDistribution(f.root, { type: "unknown" }), /--type/);
});

test("browser manifests do not trigger unrelated infrastructure analysis", t => {
  const f = fixture(t);
  f.put("manifest.json", { manifest_version: 3, name: "extension", version: "1" });
  const result = scanDistribution(f.root);
  assert.deepEqual(result.metadata.detectedTypes, ["browser"]);
  assert.deepEqual(result.families.map(item => item.family), ["browser-extension"]);
});

test("structural path escapes are blocking while broad capabilities require review", t => {
  const escape = fixture(t);
  escape.put("package.json", { name: "escape", main: "../outside.js", engines: { vscode: "*" } });
  const blocked = scanDistribution(escape.root, { type: "vsix" });
  assert.equal(blocked.verdict, "block");
  assert.ok(blocked.findings.some(item => item.category === "extension-entrypoint-escape" && item.blocking));

  const browser = fixture(t);
  browser.put("manifest.json", { manifest_version: 3, name: "broad", version: "1", permissions: ["nativeMessaging"] });
  const reviewed = scanDistribution(browser.root);
  assert.equal(reviewed.verdict, "review");
  assert.ok(reviewed.findings.some(item => item.category === "browser-high-risk-permission" && !item.blocking));
});

test("auto-detection includes GitLab, Jenkins and extracted JetBrains plugins", t => {
  const f = fixture(t);
  f.put(".gitlab-ci.yml", "include: local.yml\n");
  f.put("local.yml", "image: node@sha256:" + "a".repeat(64));
  f.put("Jenkinsfile", "pipeline { stages { stage('x') { steps { sh 'true' } } } }");
  f.put("META-INF/plugin.xml", "<idea-plugin><id>example.plugin</id><name>Example</name></idea-plugin>");
  const result = scanDistribution(f.root);
  assert.deepEqual(result.metadata.detectedTypes, ["gitlab", "jenkins", "jetbrains"]);
  assert.deepEqual(result.families.map(item => item.family), ["gitlab-ci", "jenkins", "jetbrains-plugin"]);
});
