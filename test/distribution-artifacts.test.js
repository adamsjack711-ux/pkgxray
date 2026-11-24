"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { analyzeArtifactDescriptors } = require("../src/distribution/artifacts");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkgxray-artifacts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    put(name, value = "") {
      const file = path.join(root, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, value);
      return file;
    }
  };
}

function categories(result) { return result.findings.map(f => f.category); }
function kinds(result) { return result.components.map(c => c.kind); }

test("Terraform/OpenTofu and Helm references preserve pins and flag mutable acquisition", t => {
  const f = fixture(t);
  f.put("main.tf", `
terraform {
  required_providers {
    aws = { source = "hashicorp/aws"; version = "~> 5.0" }
  }
}
module "vpc" { source = "git::https://example.invalid/vpc.git?ref=main" }
module "pinned" { source = "git::https://example.invalid/mod.git?ref=0123456789012345678901234567890123456789" }
`);
  f.put(".terraform.lock.hcl", `
provider "registry.opentofu.org/hashicorp/aws" {
  version = "5.1.0"
  hashes = ["h1:base64digest"]
}
provider "registry.opentofu.org/hashicorp/random" { version = "3.0.0" }
`);
  f.put("chart/Chart.yaml", `
apiVersion: v2
name: demo
dependencies:
  - name: redis
    version: "^19.0.0"
    repository: "https://charts.example.invalid"
  - name: exact
    version: "1.2.3"
    repository: "oci://registry.invalid/charts"
`);
  f.put("chart/values.yaml", `
image:
  repository: registry.invalid/app
  tag: latest
sidecar:
  repository: registry.invalid/helper
  digest: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
`);

  const result = analyzeArtifactDescriptors(f.root);
  const provider = result.components.find(c => c.kind === "terraform-provider" && c.name === "registry.opentofu.org/hashicorp/aws");
  const pinnedModule = result.components.find(c => c.kind === "terraform-module" && c.name === "pinned");
  const digestImage = result.components.find(c => c.kind === "oci-image" && /helper/.test(c.reference));
  assert.equal(provider.immutable, true);
  assert.equal(pinnedModule.immutable, true);
  assert.equal(digestImage.immutable, true);
  assert.ok(result.components.some(c => c.kind === "terraform-provider" && c.name === "aws"));
  assert.ok(result.findings.some(x => x.category === "mutable-reference" && /vpc/.test(x.snippet)));
  assert.ok(result.findings.some(x => x.category === "mutable-reference" && /redis/.test(x.snippet)));
  assert.ok(result.findings.some(x => x.category === "mutable-image" && /app:latest/.test(x.snippet)));
});

test("OCI layout inventories manifests and layers by digest and detects missing or mismatched blobs", t => {
  const f = fixture(t);
  const layer = Buffer.from("layer bytes");
  const layerDigest = `sha256:${crypto.createHash("sha256").update(layer).digest("hex")}`;
  const missingDigest = `sha256:${"b".repeat(64)}`;
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: `sha256:${"c".repeat(64)}`, size: 2 },
    layers: [
      { mediaType: "application/vnd.oci.image.layer.v1.tar", digest: layerDigest, size: layer.length },
      { mediaType: "application/vnd.oci.image.layer.v1.tar", digest: missingDigest, size: 1 }
    ]
  }));
  const manifestDigest = `sha256:${crypto.createHash("sha256").update(manifest).digest("hex")}`;
  f.put("oci-layout", JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  f.put("index.json", JSON.stringify({ schemaVersion: 2, manifests: [{ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: manifestDigest, size: manifest.length }] }));
  f.put(`blobs/sha256/${manifestDigest.slice(7)}`, manifest);
  f.put(`blobs/sha256/${layerDigest.slice(7)}`, layer);

  const result = analyzeArtifactDescriptors(f.root);
  assert.equal(result.components.filter(c => c.kind === "oci-layer").length, 2);
  assert.ok(result.components.some(c => c.kind === "oci-manifest" && c.digest === manifestDigest));
  assert.ok(result.findings.some(x => x.category === "missing-oci-blob" && x.snippet === missingDigest));
  assert.ok(!categories(result).includes("oci-digest-mismatch"));

  f.put(`blobs/sha256/${manifestDigest.slice(7)}`, "tampered");
  const tampered = analyzeArtifactDescriptors(f.root);
  assert.ok(categories(tampered).includes("oci-digest-mismatch"));
});

test("DEB, RPM, APK and desktop package lifecycle surfaces are inventoried", t => {
  const f = fixture(t);
  f.put("DEBIAN/postinst", "#!/bin/sh\nsystemctl enable example\n");
  f.put("package.pre-install", "#!/bin/sh\ntrue\n");
  f.put("rpm/example.spec", "%post\nsystemctl restart example\n%preun\ntrue\n");
  f.put("payload/Scripts/preinstall", "#!/bin/sh\ntrue\n");
  f.put("AppDir/AppRun", "#!/bin/sh\nexec app\n");
  f.put("AppDir/example.desktop", "[Desktop Entry]\nExec=bin/example --open %U\n");
  f.put("snap/snapcraft.yaml", "name: demo\napps:\n  demo:\n    command: bin/demo\n  helper:\n    daemon: simple\n");
  f.put("msix/AppxManifest.xml", `<Package><Applications><Application Executable="app.exe" /></Applications><Capabilities><rescap:Capability Name="runFullTrust" /></Capabilities></Package>`);
  f.put("opaque/installer.msi", Buffer.from([0, 1, 2]));

  const result = analyzeArtifactDescriptors(f.root);
  for (const expected of ["deb-install-script", "apk-install-script", "rpm-install-script", "macos-pkg-install-script", "appimage-launcher", "desktop-entry", "snap-launch-command", "msix-application", "msi-package"]) {
    assert.ok(kinds(result).includes(expected), `missing ${expected}`);
  }
  assert.ok(result.findings.filter(x => x.category === "install-script").length >= 5);
  assert.ok(result.findings.some(x => x.category === "desktop-capability" && x.severity === "high"));
  assert.ok(categories(result).includes("opaque-package"));
});

test("Homebrew and Flatpak downloads require checksums while pinned formulae remain immutable", t => {
  const f = fixture(t);
  f.put("Formula/good.rb", `class Good < Formula
  url "https://example.invalid/good.tar.gz"
  sha256 "${"d".repeat(64)}"
end
`);
  f.put("Casks/risky.rb", `cask "risky" do
  url "https://example.invalid/risky.dmg"
  sha256 :no_check
  postflight do
    system_command "/bin/sh"
  end
end
`);
  f.put("flatpak/org.example.App.yml", `
app-id: org.example.App
runtime: org.freedesktop.Platform
modules:
  - name: app
    sources:
      - type: archive
        url: https://example.invalid/source.tar.gz
`);

  const result = analyzeArtifactDescriptors(f.root);
  assert.equal(result.components.find(c => c.kind === "homebrew-formula").immutable, true);
  assert.equal(result.components.find(c => c.kind === "homebrew-cask").immutable, false);
  assert.ok(result.components.some(c => c.kind === "flatpak-manifest"));
  assert.ok(result.findings.some(x => x.category === "missing-checksum" && /risky/.test(x.snippet)));
  assert.ok(result.findings.some(x => x.category === "missing-checksum" && /source\.tar/.test(x.snippet)));
  assert.ok(result.findings.some(x => x.category === "install-script" && x.snippet === "postflight"));
});

test("scanner is deterministic, skips symlinks, and reports bounded coverage", t => {
  const f = fixture(t);
  f.put("main.tf", `module "x" { source = "git::https://example.invalid/x.git" }`);
  fs.symlinkSync("main.tf", path.join(f.root, "linked.tf"));
  f.put("large/Chart.yaml", "x".repeat(100));
  const first = analyzeArtifactDescriptors(f.root, { maxFileBytes: 50 });
  const second = analyzeArtifactDescriptors(f.root, { maxFileBytes: 50 });
  assert.deepEqual(first, second);
  assert.equal(first.coverage.complete, false);
  assert.ok(first.coverage.reasons.some(reason => reason.includes("symbolic link skipped")));
  assert.ok(first.coverage.reasons.some(reason => reason.includes("oversized file skipped")));
});
