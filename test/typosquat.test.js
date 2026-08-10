"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  typosquatFindings,
  levenshtein,
  baseName,
  loadPopularNames,
  popularNameSet,
  POPULAR_LIST_PATH
} = require("../src/typosquat");

test("levenshtein basic distances", () => {
  assert.equal(levenshtein("lodash", "lodash"), 0);
  assert.equal(levenshtein("lodash", "lodahs"), 2);
  assert.equal(levenshtein("react", "raect"), 2);
});

test("baseName strips scope", () => {
  assert.equal(baseName("@scope/lodash"), "lodash");
  assert.equal(baseName("Express"), "express");
});

test("typosquatFindings silent when disabled path: popular name itself", () => {
  assert.deepEqual(typosquatFindings("lodash"), []);
});

test("typosquatFindings flags near-miss of popular name", () => {
  const hits = typosquatFindings("lodahs", {
    popularNames: ["lodash", "react", "express"],
    maxDistance: 2
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].category, "typosquat-similarity");
  assert.equal(hits[0].severity, "medium");
  assert.match(hits[0].rationale, /lodash/);
});

test("typosquatFindings ignores short names", () => {
  assert.deepEqual(
    typosquatFindings("re", { popularNames: ["react"], minLen: 4 }),
    []
  );
});

// --- Finding 9: the popular-name list must ship in the packed tarball --------

test("popular-name list ships in the npm tarball (loader path covered by package.json files)", () => {
  const root = path.join(__dirname, "..");
  // The loader must resolve inside a directory that npm pack includes.
  assert.equal(path.relative(root, POPULAR_LIST_PATH), path.join("src", "data", "top1000.txt"));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.ok(
    pkg.files.includes("src/"),
    '"src/" must stay in package.json "files" so the typosquat list is packed'
  );
  // And the full list actually loads — not the 14-name emergency fallback.
  assert.ok(loadPopularNames().length > 900, "expected the full ~1000-name list to load");
});

test("near-misses of full-list names (beyond the 14-name fallback) are flagged", () => {
  // rollup is in top1000.txt but NOT in the emergency fallback list — this
  // regresses if the loader ever silently loses the shipped file again.
  const hits = typosquatFindings("roolup");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].category, "typosquat-similarity");
  assert.match(hits[0].rationale, /rollup/);
});

test("missing list falls back loudly: exactly one stderr warning, 14-name list", () => {
  // Copy the module somewhere with no data/ dir so its __dirname-relative read
  // ENOENTs, and load it in a child process to capture stderr.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pkgx-typo-fallback-"));
  fs.copyFileSync(path.join(__dirname, "..", "src", "typosquat.js"), path.join(tmp, "typosquat.js"));
  const script = `
    const t = require(${JSON.stringify(path.join(tmp, "typosquat.js"))});
    const first = t.loadPopularNames();
    const second = t.loadPopularNames();
    process.stdout.write(JSON.stringify({ len: first.length, cached: first === second }));
  `;
  const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.len, 14, "fallback is the 14 built-in names");
  assert.equal(out.cached, true);
  const warnings = r.stderr
    .split("\n")
    .filter((l) => l.includes("could not load popular-package list"));
  assert.equal(warnings.length, 1, `expected exactly one warning, stderr: ${r.stderr}`);
});

// --- Perf: the normalized lookup set is built once, not per call -------------

test("normalized popular-name set is cached (same object across calls)", () => {
  const list = loadPopularNames();
  assert.equal(popularNameSet(list), popularNameSet(list));
  // Caller-supplied lists never leak into the module cache.
  const custom = ["react"];
  assert.notEqual(popularNameSet(custom), popularNameSet(list));
  assert.equal(popularNameSet(list), popularNameSet(list));
});

// --- Finding 10: config threading through every surface ----------------------

test("config: typosquat accepts true/false or a tuning object", () => {
  const { validateConfig } = require("../src/config");

  let warnings = [];
  assert.deepEqual(validateConfig({ typosquat: true }, warnings).typosquat, {});
  assert.ok(warnings.some((w) => /typosquat/.test(w)), "enabling must warn (loosen loudly)");

  warnings = [];
  assert.deepEqual(
    validateConfig({ typosquat: { maxDistance: 1, minLen: 6 } }, warnings).typosquat,
    { maxDistance: 1, minLen: 6 }
  );

  warnings = [];
  const bad = validateConfig({ typosquat: { maxDistance: "wide" } }, warnings);
  assert.deepEqual(bad.typosquat, {}, "bad tuning drops to defaults but stays enabled");
  assert.ok(warnings.some((w) => /maxDistance/.test(w)));

  warnings = [];
  assert.equal(validateConfig({ typosquat: "yes" }, warnings).typosquat, false);
  assert.ok(warnings.some((w) => /typosquat/.test(w)));

  assert.equal(validateConfig({}, []).typosquat, false);
});

test("auditEvidence: options.typosquat enables the heuristic and honors tuning", () => {
  const { auditEvidence } = require("../src/auditor");
  const flags = (pkg, opts) =>
    auditEvidence({ packageName: pkg, sourceFiles: { "index.js": "module.exports = 1;" } }, opts)
      .findings.some((f) => f.category === "typosquat-similarity");

  // Disabled unless opted in.
  assert.ok(!flags("expres", undefined));

  // {} is validateConfig's normalized shape for `typosquat: true`. The default
  // maxDistance is 1, so a single-edit near-miss (expres → express) flags.
  assert.ok(flags("expres", { typosquat: {} }));

  // A transposition scores distance 2 in plain Levenshtein, so the high-precision
  // default (maxDistance 1) silences lodahs → lodash; loosening to maxDistance 2
  // catches it — proving tuning reaches the scan.
  assert.ok(!flags("lodahs", { typosquat: {} }));
  assert.ok(flags("lodahs", { typosquat: { maxDistance: 2 } }));

  // minLen above the probe's length silences it too.
  assert.ok(!flags("expres", { typosquat: { minLen: 8 } }));
});

test("auditEvidence: evidence-level typosquat:true still opts in; enableTyposquat alias is dead", () => {
  const { auditEvidence } = require("../src/auditor");
  const viaEvidence = auditEvidence({
    packageName: "expres",
    typosquat: true,
    sourceFiles: { "index.js": "x" }
  });
  assert.ok(viaEvidence.findings.some((f) => f.category === "typosquat-similarity"));

  const viaDeadAlias = auditEvidence({
    packageName: "expres",
    enableTyposquat: true,
    sourceFiles: { "index.js": "x" }
  });
  assert.ok(!viaDeadAlias.findings.some((f) => f.category === "typosquat-similarity"));
});

test("guard surface: options.typosquat reaches the audit (local ref, offline)", async () => {
  const { guardExtension } = require("../src/quarantine");
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pkgx-typo-guard-"));
  const source = path.join(root, "source");
  await fsp.mkdir(source);
  await fsp.writeFile(
    path.join(source, "package.json"),
    JSON.stringify({ name: "expres", version: "1.0.0" })
  );
  await fsp.writeFile(path.join(source, "index.js"), "module.exports = 1;");
  const offline = {
    vulnerabilityCheck: false,
    githubMetadata: false,
    githubDiff: false
  };

  const flagged = await guardExtension(source, {
    ...offline,
    quarantineRoot: path.join(root, "q1"),
    typosquat: true // CLI --typosquat shape
  });
  assert.ok(flagged.report.findings.some((f) => f.category === "typosquat-similarity"));

  const off = await guardExtension(source, { ...offline, quarantineRoot: path.join(root, "q2") });
  assert.ok(!off.report.findings.some((f) => f.category === "typosquat-similarity"));
});

test("auditLockfile threads typosquat config into the deep scan", async () => {
  // makeDefaultEvaluator/runDeep destructure guardExtension from the module
  // exports at call time, so patching the property intercepts the options.
  const quarantine = require("../src/quarantine");
  const original = quarantine.guardExtension;
  const captured = [];
  quarantine.guardExtension = async (ref, opts) => {
    captured.push({ ref, typosquat: opts.typosquat });
    return { report: { verdict: "safe", grade: "A", riskBands: [], findings: [] } };
  };
  try {
    const { auditLockfile } = require("../src/lockfile");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pkgx-typo-lock-"));
    const pkg = path.join(dir, "package.json");
    fs.writeFileSync(pkg, JSON.stringify({ name: "demo", dependencies: { roolup: "1.0.0" } }));
    await auditLockfile(pkg, {
      osvResults: [{}],
      triageDecisions: false,
      deep: true,
      deepAll: true,
      typosquat: { maxDistance: 1 }
    });
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0].typosquat, { maxDistance: 1 });
  } finally {
    quarantine.guardExtension = original;
  }
});

test("recheck's default evaluator threads typosquat config into guardExtension", async () => {
  const quarantine = require("../src/quarantine");
  const original = quarantine.guardExtension;
  let captured = null;
  quarantine.guardExtension = async (ref, opts) => {
    captured = opts;
    return { report: { verdict: "safe", findings: [] } };
  };
  try {
    const { makeDefaultEvaluator } = require("../src/recheck");
    const evaluate = makeDefaultEvaluator({ typosquat: {} });
    await evaluate({ name: "roolup", version: "1.0.0" });
    assert.ok(captured, "guardExtension was not called");
    assert.deepEqual(captured.typosquat, {});
  } finally {
    quarantine.guardExtension = original;
  }
});
