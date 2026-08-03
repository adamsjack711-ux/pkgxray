"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const {
  parsePypiSpecifier,
  pypiMetadataForEvidence,
  extractRepository,
  extractMaintainers,
  releaseFileForVersion,
  sha256ToSri
} = require("../src/pypi");

// A trimmed PyPI /pypi/<name>/json fixture. Shapers are pure, so no network.
function fixture(overrides = {}) {
  return {
    info: {
      name: "samplepkg",
      version: "1.2.3",
      home_page: "https://example.com",
      project_urls: {
        Homepage: "https://example.com",
        Source: "https://github.com/acme/samplepkg",
        Documentation: "https://docs.example.com"
      },
      author: "Jane Doe",
      author_email: "jane@example.com",
      maintainer: null,
      yanked: false,
      yanked_reason: null,
      ...overrides.info
    },
    ownership: overrides.ownership !== undefined ? overrides.ownership : {
      organization: null,
      roles: [
        { role: "Owner", user: "jane" },
        { role: "Maintainer", user: "bob" }
      ]
    },
    releases: overrides.releases || {
      "1.2.3": [
        { packagetype: "bdist_wheel", filename: "samplepkg-1.2.3-py3-none-any.whl", url: "https://files.pythonhosted.org/w.whl", yanked: false, size: 100, digests: { sha256: "beef" }, upload_time_iso_8601: "2026-01-02T00:00:00Z" },
        { packagetype: "sdist", filename: "samplepkg-1.2.3.tar.gz", url: "https://files.pythonhosted.org/s.tar.gz", yanked: false, size: 200, digests: { sha256: "cafe" }, upload_time_iso_8601: "2026-01-02T00:00:00Z" }
      ]
    }
  };
}

test("parsePypiSpecifier handles ==, @, and bare (normalizing the name)", () => {
  assert.deepEqual(parsePypiSpecifier("requests==2.31.0"), { name: "requests", version: "2.31.0" });
  assert.deepEqual(parsePypiSpecifier("PyYAML@6.0"), { name: "pyyaml", version: "6.0" });
  assert.deepEqual(parsePypiSpecifier("Flask_Login"), { name: "flask-login", version: null });
});

test("pypiMetadataForEvidence matches the npm evidence shape", () => {
  const ev = pypiMetadataForEvidence(fixture());
  assert.equal(ev.name, "samplepkg");
  assert.equal(ev.version, "1.2.3");
  assert.deepEqual(ev.repository, { url: "https://github.com/acme/samplepkg", type: "git" });
  assert.deepEqual(ev.maintainers, [
    { name: "jane", role: "Owner" },
    { name: "bob", role: "Maintainer" }
  ]);
  assert.equal(ev.dist, null);
  assert.equal(ev.deprecated, null);
  // Shape parity with npmMetadataForEvidence.
  assert.deepEqual(Object.keys(ev).sort(), ["deprecated", "dist", "maintainers", "name", "repository", "version"]);
});

test("extractRepository prefers a labelled source link over a bare homepage", () => {
  assert.deepEqual(
    extractRepository({ project_urls: { Homepage: "https://x.io", Repository: "https://github.com/a/b" } }),
    { url: "https://github.com/a/b", type: "git" }
  );
  // Falls back to a github home_page when no project_urls point at a repo host.
  assert.deepEqual(
    extractRepository({ home_page: "https://github.com/a/b" }),
    { url: "https://github.com/a/b", type: "git" }
  );
  // No repo-shaped URL anywhere -> null (never invent one).
  assert.equal(extractRepository({ project_urls: { Homepage: "https://example.com" } }), null);
});

test("extractMaintainers reads ownership.roles, falls back to author", () => {
  assert.deepEqual(extractMaintainers(fixture()), [
    { name: "jane", role: "Owner" },
    { name: "bob", role: "Maintainer" }
  ]);
  // No ownership -> free-text author fallback.
  const noOwner = fixture({ ownership: null });
  assert.deepEqual(extractMaintainers(noOwner), [{ name: "Jane Doe", email: "jane@example.com" }]);
});

test("yanked release surfaces as deprecated (npm's deprecation analog)", () => {
  const ev = pypiMetadataForEvidence(fixture({ info: { yanked: true, yanked_reason: "security" } }));
  assert.equal(ev.deprecated, "security");
});

test("releaseFileForVersion prefers the sdist over a wheel", () => {
  const f = releaseFileForVersion(fixture(), "1.2.3");
  assert.equal(f.packagetype, "sdist");
  assert.equal(f.filename, "samplepkg-1.2.3.tar.gz");
  assert.equal(f.sha256, "cafe");
});

test("releaseFileForVersion skips yanked files and returns null when none usable", () => {
  const onlyYanked = fixture({
    releases: { "1.2.3": [
      { packagetype: "sdist", url: "u", yanked: true, digests: { sha256: "x" } }
    ] }
  });
  assert.equal(releaseFileForVersion(onlyYanked, "1.2.3"), null);
  // Falls back to a wheel when there is no sdist.
  const wheelOnly = fixture({
    releases: { "1.2.3": [
      { packagetype: "bdist_wheel", filename: "w.whl", url: "u", yanked: false, digests: { sha256: "beef" } }
    ] }
  });
  assert.equal(releaseFileForVersion(wheelOnly, "1.2.3").packagetype, "bdist_wheel");
});

test("sha256ToSri produces a verifiable npm SRI string", () => {
  const bytes = crypto.randomBytes(32);
  const hex = bytes.toString("hex");
  const sri = sha256ToSri(hex);
  assert.match(sri, /^sha256-/);
  // Round-trips to the same base64 npm's integrity check would compare against.
  assert.equal(sri, "sha256-" + bytes.toString("base64"));
});
