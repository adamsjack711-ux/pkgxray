"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  scanVsix,
  scanBrowserExtension
} = require("../src/distribution/extensions");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkgxray-extension-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    put(relative, value) {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    }
  };
}

test("VSIX analysis is marketplace-neutral and inventories executable surfaces", t => {
  const f = fixture(t);
  f.put("extension/dist/main.js", "module.exports = {};");
  f.put("extension/dist/web.js", "export {};");
  f.put("extension/package.json", {
    name: "fixture",
    publisher: "example",
    version: "1.2.3",
    engines: { vscode: "^1.90.0" },
    activationEvents: ["onStartupFinished", "workspaceContains:**/.env"],
    main: "dist/main.js",
    browser: "dist/web.js",
    scripts: { postinstall: "node scripts/setup.js", test: "node test.js" },
    extensionDependencies: ["vendor.dependency"],
    extensionPack: ["vendor.member"],
    capabilities: {
      untrustedWorkspaces: { supported: false },
      virtualWorkspaces: { supported: false }
    }
  });

  const scan = scanVsix(f.root);
  assert.equal(scan.format, "vsix");
  assert.equal(scan.metadata.publisher, "example");
  assert.deepEqual(scan.metadata.activationEvents, ["onStartupFinished", "workspaceContains:**/.env"]);
  assert.deepEqual(scan.entrypoints.filter(e => e.kind !== "script").map(e => [e.kind, e.exists]), [
    ["browser", true], ["main", true]
  ]);
  assert.deepEqual(scan.components.map(c => [c.kind, c.reference]), [
    ["extension-dependency", "vendor.dependency"],
    ["extension-pack-member", "vendor.member"]
  ]);
  assert.ok(scan.findings.some(finding => finding.category === "vsix-install-script"));
  assert.ok(scan.findings.some(finding => finding.category === "vsix-requires-trusted-workspace"));
  assert.equal(scan.coverage.complete, true);
});

test("VSIX entrypoints cannot escape the extracted root and missing code is visible", t => {
  const f = fixture(t);
  f.put("package.json", { name: "bad", main: "../outside.js", browser: "missing.js" });
  const scan = scanVsix(f.root);
  assert.deepEqual(scan.entrypoints.map(e => [e.kind, e.withinRoot, e.exists]), [
    ["browser", true, false], ["main", false, false]
  ]);
  assert.ok(scan.findings.some(item => item.category === "extension-entrypoint-escape"));
  assert.ok(scan.findings.some(item => item.category === "extension-entrypoint-missing"));
});

test("VSIX Node entrypoints resolve extensionless files and directory indexes", t => {
  const f = fixture(t);
  f.put("extension/dist/extension.js", "module.exports = {};");
  f.put("extension/web/index.mjs", "export {};");
  f.put("extension/package.json", {
    name: "node-resolution", publisher: "example", version: "1.0.0",
    main: "./dist/extension", browser: "./web"
  });
  const scan = scanVsix(f.root);
  assert.deepEqual(scan.entrypoints.map(item => [item.kind, item.declaredPath, item.path, item.exists]), [
    ["browser", "./web", "web/index.mjs", true],
    ["main", "./dist/extension", "dist/extension.js", true]
  ]);
  assert.equal(scan.findings.some(item => item.category === "extension-entrypoint-missing"), false);
});

test("browser manifest inventories background/content code and sensitive permissions", t => {
  const f = fixture(t);
  f.put("sw.js", "self.addEventListener('fetch', () => {});");
  f.put("content.js", "console.log('content');");
  f.put("manifest.json", {
    manifest_version: 3,
    name: "browser fixture",
    version: "1",
    background: { service_worker: "sw.js" },
    content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"] }],
    permissions: ["nativeMessaging", "cookies"],
    host_permissions: ["<all_urls>"],
    optional_permissions: ["history"],
    optional_host_permissions: ["https://example.com/*"],
    externally_connectable: { ids: ["*"], matches: ["https://trusted.example/*"] },
    update_url: "https://updates.example/extension.xml",
    browser_specific_settings: { gecko: { id: "fixture@example.test" } }
  });

  const scan = scanBrowserExtension(f.root);
  assert.equal(scan.metadata.manifestVersion, 3);
  assert.deepEqual(scan.entrypoints.map(e => [e.kind, e.path, e.exists]), [
    ["background-service-worker", "sw.js", true],
    ["content-script", "content.js", true]
  ]);
  assert.ok(scan.components.some(c => c.kind === "permission" && c.reference === "nativeMessaging"));
  assert.ok(scan.components.some(c => c.kind === "host-permission" && c.reference === "<all_urls>"));
  assert.ok(scan.components.some(c => c.kind === "host-permission" && c.reference === "<all_urls>" && /content_scripts/.test(c.evidence)));
  assert.ok(scan.components.some(c => c.kind === "update-channel"));
  assert.ok(scan.findings.some(item => item.category === "browser-high-risk-permission" && item.severity === "high"));
  assert.ok(scan.findings.some(item => item.category === "browser-broad-host-access" && item.severity === "high"));
  assert.ok(scan.findings.some(item => item.category === "browser-broad-external-connectivity"));
  assert.ok(scan.findings.some(item => item.category === "browser-custom-update-channel"));
});

test("Manifest V2 background scripts and host patterns in permissions are covered", t => {
  const f = fixture(t);
  f.put("bg.js", "void 0;");
  f.put("manifest.json", {
    manifest_version: 2,
    name: "mv2 fixture",
    version: "1",
    background: { scripts: ["bg.js"] },
    permissions: ["*://*/*", "webRequestBlocking"]
  });
  const scan = scanBrowserExtension(f.root);
  assert.equal(scan.entrypoints[0].kind, "background-script");
  assert.ok(scan.findings.some(item => item.category === "browser-broad-host-access"));
  assert.ok(scan.findings.some(item => item.category === "browser-sensitive-permission"));
});

test("invalid and oversized manifests fail visibly within the read bound", t => {
  const invalid = fixture(t);
  invalid.put("manifest.json", "{");
  const invalidScan = scanBrowserExtension(invalid.root);
  assert.equal(invalidScan.coverage.complete, false);
  assert.ok(invalidScan.findings.some(item => item.category === "extension-invalid-manifest"));

  const oversized = fixture(t);
  oversized.put("manifest.json", JSON.stringify({ name: "large", padding: "x".repeat(256) }));
  const largeScan = scanBrowserExtension(oversized.root, { maxManifestBytes: 64 });
  assert.equal(largeScan.coverage.complete, false);
  assert.ok(largeScan.findings.some(item => item.category === "extension-manifest-too-large"));
});
