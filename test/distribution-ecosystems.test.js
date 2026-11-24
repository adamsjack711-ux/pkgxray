"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  extractGitLabIncludes,
  validSha256Integrity,
  scanGitLabCi,
  scanJenkins,
  scanJetBrainsPlugin
} = require("../src/distribution/ecosystems");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkgxray-ecosystem-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    put(relative, source = "") {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, source);
      return file;
    }
  };
}

test("GitLab include extraction covers scalar and structured forms", () => {
  const found = extractGitLabIncludes(`
include:
  - local: /ci/local.yml
  - project: group/project
    ref: 0123456789012345678901234567890123456789
    file: /templates/build.yml
  - remote: https://example.invalid/template.yml
    integrity: sha256-${Buffer.alloc(32, 1).toString("base64")}
  - component: gitlab.example/group/component@v1
  - template: Jobs/SAST.gitlab-ci.yml
`);
  assert.deepEqual(found.map(item => item.kind), ["local", "project", "remote", "component", "template"]);
  assert.equal(found[1].ref, "0123456789012345678901234567890123456789");
  assert.ok(validSha256Integrity(found[2].integrity));
  assert.equal(validSha256Integrity("sha256-YWJj"), false);
});

test("GitLab scanner follows local includes and inventories mutable remote surfaces", t => {
  const f = fixture(t);
  const digest = "a".repeat(64);
  f.put(".gitlab-ci.yml", `
include:
  - local: /ci/one.yml
  - project: group/project
    ref: main
    file: /build.yml
  - remote: https://example.invalid/template.yml
  - component: gitlab.example/group/lint@v2
image: node:22
services:
  - name: postgres@sha256:${digest}
`);
  f.put("ci/one.yml", `include:\n  - local: /ci/two.yml\nbuild:\n  image: alpine@sha256:${digest}\n`);
  f.put("ci/two.yml", "include:\n  - local: /ci/one.yml\n");
  const result = scanGitLabCi(f.root);
  assert.equal(result.family, "gitlab-ci");
  assert.equal(result.coverage.filesInspected, 3);
  assert.ok(result.findings.some(item => item.category === "gitlab-include-cycle"));
  assert.ok(result.findings.some(item => item.category === "gitlab-mutable-project-include"));
  assert.ok(result.findings.some(item => item.category === "gitlab-unverified-remote-include"));
  assert.ok(result.findings.some(item => item.category === "gitlab-mutable-component-include"));
  assert.ok(result.findings.some(item => item.category === "gitlab-mutable-image" && item.snippet === "node:22"));
  assert.ok(result.components.some(item => item.kind === "gitlab-service-image" && item.immutable));
});

test("GitLab scanner rejects path escapes and fails dynamic references visibly", t => {
  const f = fixture(t);
  f.put(".gitlab-ci.yml", "include:\n  - local: ../outside.yml\nimage: $CI_IMAGE\n");
  const result = scanGitLabCi(f.root);
  assert.equal(result.verdict, "block");
  assert.equal(result.coverage.complete, false);
  assert.ok(result.findings.some(item => item.category === "gitlab-local-path-escape" && item.blocking));
  assert.ok(result.findings.some(item => item.category === "gitlab-dynamic-image"));
});

test("Jenkins scanner inventories libraries, plugins, tools, images, commands and credentials", t => {
  const f = fixture(t);
  const sha = "b".repeat(40);
  const digest = "c".repeat(64);
  f.put("Jenkinsfile", `
@Library(['trusted@${sha}', 'floating@main']) _
@Grab('org.example:helper:1.2.3')
pipeline {
  agent { docker { image 'registry.example/agent@sha256:${digest}' } }
  tools { jdk 'jdk17' }
  stages { stage('build') { steps {
    sh 'make test'
    withCredentials([string(credentialsId: 'token-id', variable: 'TOKEN')]) { sh 'deploy' }
  } } }
}
plugins { id 'warnings-ng' version '11.0.0' }
`);
  const result = scanJenkins(f.root);
  assert.ok(result.components.some(item => item.kind === "jenkins-shared-library" && item.reference.startsWith("trusted@") && item.immutable));
  assert.ok(result.findings.some(item => item.category === "jenkins-mutable-library" && /floating/.test(item.snippet)));
  assert.ok(result.components.some(item => item.kind === "jenkins-agent-image" && item.immutable));
  assert.ok(result.components.some(item => item.kind === "jenkins-plugin"));
  assert.ok(result.components.some(item => item.kind === "jenkins-tool"));
  assert.ok(result.entrypoints.some(item => item.kind === "jenkins-command"));
  assert.ok(result.findings.some(item => item.category === "jenkins-credential-binding"));
  assert.equal(result.verdict, "review");
});

test("JetBrains scanner maps dependencies and declared implementation classes", t => {
  const f = fixture(t);
  f.put("META-INF/plugin.xml", `
<idea-plugin>
  <id>example.plugin</id><name>Example</name><version>1.0.0</version>
  <idea-version since-build="241" until-build="251.*" />
  <depends>com.intellij.modules.platform</depends>
  <depends optional="true" config-file="optional.xml">other.plugin</depends>
  <extensions defaultExtensionNs="com.intellij">
    <applicationService serviceImplementation="com.example.Service" />
    <projectService serviceImplementation="com.example.Missing" />
    <listener class="com.example.Listener" />
    <toolWindow factoryClass="com.example.Factory" />
    <permission name="filesystem" />
  </extensions>
  <actions><action id="Example" class="com.example.Action" /></actions>
</idea-plugin>
`);
  f.put("META-INF/optional.xml", "<idea-plugin />");
  for (const name of ["Service", "Listener", "Factory", "Action"]) f.put(`classes/com/example/${name}.class`, "bytes");
  const result = scanJetBrainsPlugin(f.root);
  assert.equal(result.metadata.plugins[0].id, "example.plugin");
  assert.equal(result.metadata.plugins[0].sinceBuild, "241");
  assert.ok(result.components.some(item => item.kind === "jetbrains-plugin-dependency" && item.reference === "other.plugin" && item.optional));
  assert.ok(result.entrypoints.some(item => item.className === "com.example.Service"));
  assert.ok(result.entrypoints.some(item => item.className === "com.example.Factory"));
  assert.ok(result.components.some(item => item.kind === "jetbrains-extension" && item.reference === "toolWindow"));
  assert.ok(result.findings.some(item => item.category === "jetbrains-class-missing" && item.snippet === "com.example.Missing"));
  assert.ok(result.findings.some(item => item.category === "jetbrains-requested-capability"));
  assert.equal(result.coverage.complete, false);
});

test("JetBrains scanner blocks escaping resource paths and exposes unexpanded JAR coverage", t => {
  const f = fixture(t);
  f.put("META-INF/plugin.xml", `<idea-plugin><id>x</id><depends optional="true" config-file="../outside.xml">other</depends></idea-plugin>`);
  f.put("lib/plugin.jar", "opaque");
  const result = scanJetBrainsPlugin(f.root);
  assert.equal(result.verdict, "block");
  assert.ok(result.findings.some(item => item.category === "jetbrains-path-escape" && item.blocking));
  assert.ok(result.coverage.reasons.some(reason => /unexpanded JAR/.test(reason)));
});
