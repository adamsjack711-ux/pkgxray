"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  parseLockfile,
  detectFormat,
  formatEcosystem,
  auditLockfile,
  parseRequirementsTxt,
  parseRequirementLine,
  parsePoetryLock,
  parsePipfileLock,
  parsePyproject,
  normalizePypiName
} = require("../src/lockfile");

async function tmpFile(name, content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pkgxray-pypi-"));
  const file = path.join(dir, name);
  await fs.writeFile(file, content);
  return file;
}

// A dep is resolved (OSV-queryable) iff it is present and not flagged unresolved.
function resolved(deps, key) {
  const d = deps.get(key);
  return d && !d.unresolved;
}

// ---------------------------------------------------------------------------
// Format detection + ecosystem mapping
// ---------------------------------------------------------------------------

test("detectFormat recognises Python manifests", () => {
  assert.equal(detectFormat("requirements.txt"), "requirements");
  assert.equal(detectFormat("/abs/requirements.txt"), "requirements");
  assert.equal(detectFormat("requirements-dev.txt"), "requirements");
  assert.equal(detectFormat("dev-requirements.txt"), "requirements");
  assert.equal(detectFormat("poetry.lock"), "poetry");
  assert.equal(detectFormat("Pipfile.lock"), "pipfile");
  assert.equal(detectFormat("pyproject.toml"), "pyproject");
  // Unrelated .txt / .toml files are not Python manifests.
  assert.equal(detectFormat("notes.txt"), null);
  assert.equal(detectFormat("Cargo.toml"), null);
});

test("formatEcosystem maps Python formats to PyPI, everything else to npm", () => {
  for (const f of ["requirements", "poetry", "pipfile", "pyproject"]) {
    assert.deepEqual(formatEcosystem(f), { osv: "PyPI", scheme: "pypi" });
  }
  for (const f of ["npm", "yarn", "pnpm", "package-json"]) {
    assert.deepEqual(formatEcosystem(f), { osv: "npm", scheme: "npm" });
  }
});

test("PEP 503 name normalization (Flask_Foo.Bar -> flask-foo-bar)", () => {
  assert.equal(normalizePypiName("Flask_Foo.Bar"), "flask-foo-bar");
  assert.equal(normalizePypiName("PyYAML"), "pyyaml");
  assert.equal(normalizePypiName("zope.interface"), "zope-interface");
});

// ---------------------------------------------------------------------------
// requirements.txt
// ---------------------------------------------------------------------------

test("requirements.txt: exact pins resolve, ranges/bare names do not", () => {
  const deps = parseRequirementsTxt([
    "requests==2.31.0",
    "Django>=4.0,<5.0", // range -> unresolved
    "numpy", // bare -> unpinnable
    "flask==2.0.1  # inline comment",
    "urllib3==1.26.5 ; python_version < \"3.8\"", // env marker stripped
    "requests[security]==2.28.0", // extras stripped, distinct version
    "colorama==0.4.6 --hash=sha256:deadbeef" // hash option stripped
  ].join("\n"));

  assert.ok(resolved(deps, "requests@2.31.0"));
  assert.ok(resolved(deps, "requests@2.28.0"), "extras stripped, name normalized");
  assert.ok(resolved(deps, "flask@2.0.1"), "trailing comment stripped");
  assert.ok(resolved(deps, "urllib3@1.26.5"), "env marker stripped");
  assert.ok(resolved(deps, "colorama@0.4.6"), "--hash option stripped");
  // range + bare name land as unresolved, never as a bogus pinned "safe" dep.
  const django = [...deps.values()].find((d) => d.name === "django");
  assert.equal(django.unresolved, true);
  assert.equal(django.unresolvedKind, "range");
  const numpy = [...deps.values()].find((d) => d.name === "numpy");
  assert.equal(numpy.unresolvedKind, "unpinnable");
});

test("requirements.txt: URL / VCS / editable installs are unresolved", () => {
  const deps = parseRequirementsTxt([
    "somepkg @ https://example.com/somepkg-1.0.tar.gz",
    "-e git+https://github.com/foo/bar.git#egg=barpkg",
    "git+https://github.com/x/y.git",
    "-r other-requirements.txt", // include line -> skipped entirely
    "--index-url https://pypi.example.com/simple" // option -> skipped
  ].join("\n"));
  const somepkg = [...deps.values()].find((d) => d.name === "somepkg");
  assert.equal(somepkg.unresolvedKind, "url");
  // #egg= fragment names the editable package.
  const barpkg = [...deps.values()].find((d) => d.name === "barpkg");
  assert.equal(barpkg.unresolvedKind, "editable");
  // -r / --index-url carry no package and must not appear as deps.
  assert.ok(![...deps.values()].some((d) => /other-requirements|index-url/.test(d.name)));
});

test("requirements.txt: backslash line continuation joins the requirement", () => {
  const deps = parseRequirementsTxt("requests==2.31.0 \\\n    --hash=sha256:abc");
  assert.ok(resolved(deps, "requests@2.31.0"));
  assert.equal(deps.size, 1);
});

test("parseRequirementLine: === identity pin resolves", () => {
  assert.deepEqual(parseRequirementLine("cryptography===42.0.0"), { name: "cryptography", version: "42.0.0" });
  // wildcard pin is not a single version (raw parse returns `kind`, which
  // addUnresolved later stores as `unresolvedKind`).
  assert.equal(parseRequirementLine("requests==2.1.*").kind, "unpinnable");
});

// ---------------------------------------------------------------------------
// poetry.lock
// ---------------------------------------------------------------------------

test("poetry.lock: [[package]] tables resolve; non-registry source is unresolved", () => {
  const deps = parsePoetryLock(`
[[package]]
name = "requests"
version = "2.31.0"
description = "HTTP for Humans"

[[package]]
name = "Local-Thing"
version = "0.1.0"
[package.source]
type = "directory"
url = "../local"
`);
  assert.ok(resolved(deps, "requests@2.31.0"));
  // name is PEP 503-normalized; git/url/directory/file source -> unresolved.
  const local = deps.get("local-thing@0.1.0");
  assert.equal(local.unresolvedKind, "source");
});

// ---------------------------------------------------------------------------
// Pipfile.lock
// ---------------------------------------------------------------------------

test("Pipfile.lock: default + develop sections, == stripped, path unresolved", () => {
  const deps = parsePipfileLock(JSON.stringify({
    _meta: { hash: {} },
    default: {
      requests: { version: "==2.31.0" },
      django: { version: "==4.2.0" },
      localpkg: { path: "./x" }
    },
    develop: {
      pytest: { version: "==7.4.0" }
    }
  }));
  assert.ok(resolved(deps, "requests@2.31.0"));
  assert.ok(resolved(deps, "django@4.2.0"));
  assert.ok(resolved(deps, "pytest@7.4.0"), "develop section is included");
  assert.equal(deps.get("localpkg@./x").unresolvedKind, "source");
});

// ---------------------------------------------------------------------------
// pyproject.toml
// ---------------------------------------------------------------------------

test("pyproject.toml: PEP 621 array + poetry table; ranges unresolved", () => {
  const deps = parsePyproject(`
[project]
name = "myapp"
dependencies = [
  "requests>=2.0",
  "flask==2.0.1",
  "click==8.1.7",
]

[tool.poetry.dependencies]
python = "^3.11"
httpx = "0.27.0"
rich = "^13.0"
`);
  // PEP 621: exact pins resolve, ranges do not.
  assert.ok(resolved(deps, "flask@2.0.1"));
  assert.ok(resolved(deps, "click@8.1.7"));
  assert.equal([...deps.values()].find((d) => d.name === "requests").unresolvedKind, "range");
  // Poetry table: exact pin resolves, caret range does not, python skipped.
  assert.ok(resolved(deps, "httpx@0.27.0"));
  assert.equal([...deps.values()].find((d) => d.name === "rich").unresolvedKind, "range");
  assert.ok(![...deps.values()].some((d) => d.name === "python"), "interpreter constraint is not a package");
});

// ---------------------------------------------------------------------------
// End-to-end audit (network-free via osvResults injection)
// ---------------------------------------------------------------------------

test("auditLockfile: requirements.txt block/review/safe decisions", async () => {
  const file = await tmpFile("requirements.txt", [
    "vulnpkg==1.0.0", // OSV will report a vuln -> block
    "safepkg==2.0.0", // OSV clean -> safe
    "unpinned" // bare name -> review (never OSV-queried)
  ].join("\n"));

  const { format, deps } = await parseLockfile(file);
  assert.equal(format, "requirements");
  assert.equal(deps.size, 3);

  // osvResults are index-aligned with the RESOLVED deps only ([vulnpkg, safepkg]);
  // the unresolved bare name is skipped, so only two entries are supplied.
  const result = await auditLockfile(file, {
    triageDecisions: false,
    osvResults: [
      { vulns: [{ id: "PYSEC-2026-9999", aliases: [] }] },
      {}
    ]
  });
  const byName = new Map(result.results.map((r) => [r.name, r]));
  assert.equal(byName.get("vulnpkg").decision, "block");
  assert.equal(byName.get("vulnpkg").vulnerabilities[0].id, "PYSEC-2026-9999");
  assert.equal(byName.get("safepkg").decision, "safe");
  assert.equal(byName.get("unpinned").decision, "review");
  assert.equal(byName.get("unpinned").unresolved, true);
  assert.equal(result.summary.blocked, 1);
  assert.equal(result.summary.reviewed, 1);
  assert.equal(result.summary.safe, 1);
  assert.equal(result.worstDecision, "block");
});
