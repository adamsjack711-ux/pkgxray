"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  triageLockfile,
  loadDecisions,
  saveDecisions,
  lockPathForLockfile
} = require("../src/triage");
const { auditLockfile } = require("../src/lockfile");

// ---------------------------------------------------------------------------
// Fake streams — emulate a TTY for keypress / output capture and feed keys
// asynchronously so the triage main loop can await them.
// ---------------------------------------------------------------------------

function makeFakeStdin() {
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = function (val) { this.isRaw = Boolean(val); };
  stdin.resume = function () {};
  stdin.pause = function () {};
  stdin.off = function (event, fn) { this.removeListener(event, fn); };
  return stdin;
}

function makeFakeStdout() {
  const stdout = {
    isTTY: true,
    chunks: [],
    write(chunk) { this.chunks.push(String(chunk)); return true; },
    get text() { return this.chunks.join(""); }
  };
  return stdout;
}

function feedKeys(stdin, keys, intervalMs = 5) {
  let i = 0;
  function next() {
    if (i >= keys.length) return;
    const ch = keys[i];
    i += 1;
    stdin.emit("data", Buffer.from(ch, "utf8"));
    setTimeout(next, intervalMs);
  }
  setTimeout(next, intervalMs);
}

// Inject synthetic audit results by stubbing auditLockfile via options would
// require dependency injection. Instead we construct a real lockfile that
// triage will parse but skip the OSV call (`vulnerabilityCheck: false`), then
// monkey-patch results in via a wrapper.

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "pkgxray-triage-"));
}

async function writeLockfileWithFakeAudit(dir, fakeResults) {
  // Write a package-lock.json containing the packages so the lockfile parses
  // cleanly; OSV is skipped via vulnerabilityCheck: false.
  const packages = { "": { name: "demo", version: "1.0.0" } };
  for (const r of fakeResults) {
    packages[`node_modules/${r.name}`] = { version: r.version };
  }
  const lockfilePath = path.join(dir, "package-lock.json");
  await fs.writeFile(lockfilePath, JSON.stringify({
    name: "demo",
    lockfileVersion: 3,
    packages
  }));
  return lockfilePath;
}

// ---------------------------------------------------------------------------
// load/save round trip
// ---------------------------------------------------------------------------

test("saveDecisions writes alphabetically sorted entries", async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, ".pkgxray.lock");
  const map = new Map();
  map.set("zeta@1.0.0", { name: "zeta", version: "1.0.0", decision: "allow", reason: "", decided_at: "2026-06-22T00:00:00Z" });
  map.set("alpha@2.0.0", { name: "alpha", version: "2.0.0", decision: "block", reason: "x", decided_at: "2026-06-22T00:00:00Z" });
  map.set("beta@1.0.0", { name: "beta", version: "1.0.0", decision: "allow", reason: "", decided_at: "2026-06-22T00:00:00Z" });
  await saveDecisions(lockPath, map);

  const text = await fs.readFile(lockPath, "utf8");
  const json = JSON.parse(text);
  assert.equal(json.schemaVersion, 1);
  assert.deepEqual(json.decisions.map((d) => `${d.name}@${d.version}`), [
    "alpha@2.0.0",
    "beta@1.0.0",
    "zeta@1.0.0"
  ]);
});

test("loadDecisions returns empty map when file is missing", async () => {
  const dir = await tmpDir();
  const result = await loadDecisions(path.join(dir, ".pkgxray.lock"));
  assert.equal(result.size, 0);
});

test("lockPathForLockfile is sibling of lockfile", () => {
  const lp = lockPathForLockfile("/tmp/foo/package-lock.json");
  assert.equal(path.basename(lp), ".pkgxray.lock");
  assert.equal(path.dirname(lp), "/tmp/foo");
});

// ---------------------------------------------------------------------------
// Non-TTY refusal
// ---------------------------------------------------------------------------

test("triage refuses to run when stdout/stdin are not a TTY", async () => {
  const dir = await tmpDir();
  const lockfile = await writeLockfileWithFakeAudit(dir, [
    { name: "lodash", version: "4.17.21", decision: "block", vulnerabilities: [], paths: ["node_modules/lodash"] }
  ]);

  const fakeStdin = makeFakeStdin();
  fakeStdin.isTTY = false;
  const fakeStdout = makeFakeStdout();
  fakeStdout.isTTY = false;
  const fakeStderr = makeFakeStdout();

  await assert.rejects(
    triageLockfile(lockfile, {
      stdin: fakeStdin,
      stdout: fakeStdout,
      stderr: fakeStderr,
      isTTY: false,
      vulnerabilityCheck: false
    }),
    (err) => err.code === "ENOTTY"
  );
  assert.match(fakeStderr.text, /triage requires a TTY/);
});

// ---------------------------------------------------------------------------
// Auto modes
// ---------------------------------------------------------------------------

test("triage --auto block writes block decisions for every flagged package", async () => {
  const dir = await tmpDir();
  // Two deps — both will appear with decision "safe" since vulnerabilityCheck
  // is off, but with --include-safe they enter the worklist.
  const lockfile = await writeLockfileWithFakeAudit(dir, [
    { name: "lodash", version: "4.17.21" },
    { name: "react", version: "19.0.0" }
  ]);

  const fakeStdin = makeFakeStdin();
  const fakeStdout = makeFakeStdout();
  await triageLockfile(lockfile, {
    stdin: fakeStdin,
    stdout: fakeStdout,
    stderr: makeFakeStdout(),
    isTTY: true,
    vulnerabilityCheck: false,
    includeSafe: true,
    auto: "block"
  });

  const lockPath = path.join(dir, ".pkgxray.lock");
  const saved = JSON.parse(await fs.readFile(lockPath, "utf8"));
  assert.equal(saved.decisions.length, 2);
  assert.ok(saved.decisions.every((d) => d.decision === "block"));
  assert.match(fakeStdout.text, /Triage complete \(auto block\)/);
});

test("triage --auto allow writes allow decisions", async () => {
  const dir = await tmpDir();
  const lockfile = await writeLockfileWithFakeAudit(dir, [
    { name: "lodash", version: "4.17.21" }
  ]);

  await triageLockfile(lockfile, {
    stdin: makeFakeStdin(),
    stdout: makeFakeStdout(),
    stderr: makeFakeStdout(),
    isTTY: true,
    vulnerabilityCheck: false,
    includeSafe: true,
    auto: "allow"
  });

  const saved = JSON.parse(await fs.readFile(path.join(dir, ".pkgxray.lock"), "utf8"));
  assert.equal(saved.decisions.length, 1);
  assert.equal(saved.decisions[0].decision, "allow");
});

// ---------------------------------------------------------------------------
// Interactive: keypress driven
// ---------------------------------------------------------------------------

test("strips C0/C1 control bytes from attacker-controlled package names before rendering", async () => {
  // A hostile lockfile entry whose name and version embed ANSI escape codes
  // (clear-screen, cursor-up) could rewrite the prompt the user sees before
  // they press a/b. The triage renderer must scrub control bytes before they
  // reach the TTY. We feed the input synchronously via the fake stdin and
  // inspect the captured stdout for any surviving ESC/C0 bytes.
  const dir = await tmpDir();
  // npm/pnpm/yarn parsers wouldn't normally emit a name with literal escape
  // bytes, but we hand-build a package-lock.json (the npm parser accepts
  // arbitrary "name" fields) to simulate the hostile case.
  const evilName = "evil\x1b[2J\x1b[Hpkg";
  const evilVersion = "1.0.0\x07\x08";
  const lockfilePath = path.join(dir, "package-lock.json");
  await fs.writeFile(lockfilePath, JSON.stringify({
    name: "demo",
    lockfileVersion: 3,
    packages: {
      "": { name: "demo", version: "1.0.0" },
      [`node_modules/${evilName}`]: { name: evilName, version: evilVersion }
    }
  }));

  const fakeStdin = makeFakeStdin();
  const fakeStdout = makeFakeStdout();
  feedKeys(fakeStdin, ["a"]);

  await triageLockfile(lockfilePath, {
    stdin: fakeStdin,
    stdout: fakeStdout,
    stderr: makeFakeStdout(),
    isTTY: true,
    vulnerabilityCheck: false,
    includeSafe: true
  });

  // The renderer is permitted to emit its OWN ANSI sequences (BOLD, colors,
  // CLEAR_LINE). Scan only for control bytes inside places where the
  // attacker-controlled name/version were rendered. Cheap proxy: confirm
  // the raw evilName/evilVersion bytes never appear in stdout.
  assert.ok(
    !fakeStdout.text.includes("\x1b[2J"),
    "clear-screen sequence from attacker-controlled name reached TTY"
  );
  assert.ok(
    !fakeStdout.text.includes("\x1b[H"),
    "cursor-home sequence from attacker-controlled name reached TTY"
  );
  assert.ok(
    !fakeStdout.text.includes("\x07"),
    "bell byte from attacker-controlled version reached TTY"
  );
});

test("interactive triage records keypresses to .pkgxray.lock", async () => {
  const dir = await tmpDir();
  // The audit step needs at least one package classified as block/review so
  // it appears in the default worklist. We force this by enabling
  // --include-safe (no OSV in tests) so the package shows up regardless.
  const lockfile = await writeLockfileWithFakeAudit(dir, [
    { name: "lodash", version: "4.17.21" },
    { name: "react", version: "19.0.0" },
    { name: "is-number", version: "7.0.0" }
  ]);

  const fakeStdin = makeFakeStdin();
  const fakeStdout = makeFakeStdout();

  // Sorted worklist (block first, then alpha): all three are "safe" with
  // includeSafe so order is alpha — is-number, lodash, react.
  feedKeys(fakeStdin, ["a", "b", "s"]);

  await triageLockfile(lockfile, {
    stdin: fakeStdin,
    stdout: fakeStdout,
    stderr: makeFakeStdout(),
    isTTY: true,
    vulnerabilityCheck: false,
    includeSafe: true
  });

  const saved = JSON.parse(await fs.readFile(path.join(dir, ".pkgxray.lock"), "utf8"));
  const byKey = new Map(saved.decisions.map((d) => [`${d.name}@${d.version}`, d.decision]));
  assert.equal(byKey.get("is-number@7.0.0"), "allow");
  assert.equal(byKey.get("lodash@4.17.21"), "block");
  // react was skipped, no entry
  assert.equal(byKey.has("react@19.0.0"), false);
  assert.match(fakeStdout.text, /Triage complete\. 1 allowed, 1 blocked, 1 skipped/);
});

test("quit (q) stops the loop and saves progress", async () => {
  const dir = await tmpDir();
  const lockfile = await writeLockfileWithFakeAudit(dir, [
    { name: "alpha", version: "1.0.0" },
    { name: "beta", version: "1.0.0" },
    { name: "gamma", version: "1.0.0" }
  ]);

  const fakeStdin = makeFakeStdin();
  const fakeStdout = makeFakeStdout();
  feedKeys(fakeStdin, ["a", "q"]);

  await triageLockfile(lockfile, {
    stdin: fakeStdin,
    stdout: fakeStdout,
    stderr: makeFakeStdout(),
    isTTY: true,
    vulnerabilityCheck: false,
    includeSafe: true
  });

  const saved = JSON.parse(await fs.readFile(path.join(dir, ".pkgxray.lock"), "utf8"));
  // First package allowed, second hit q -> no decision, third never reached.
  assert.equal(saved.decisions.length, 1);
  assert.equal(saved.decisions[0].name, "alpha");
});

test("? key prints help and re-prompts", async () => {
  const dir = await tmpDir();
  const lockfile = await writeLockfileWithFakeAudit(dir, [
    { name: "alpha", version: "1.0.0" }
  ]);

  const fakeStdin = makeFakeStdin();
  const fakeStdout = makeFakeStdout();
  feedKeys(fakeStdin, ["?", "s"]);

  await triageLockfile(lockfile, {
    stdin: fakeStdin,
    stdout: fakeStdout,
    stderr: makeFakeStdout(),
    isTTY: true,
    vulnerabilityCheck: false,
    includeSafe: true
  });

  assert.match(fakeStdout.text, /allow this package/);
});

// ---------------------------------------------------------------------------
// Resume behaviour
// ---------------------------------------------------------------------------

test("resume skips packages already allowed", async () => {
  const dir = await tmpDir();
  const lockfile = await writeLockfileWithFakeAudit(dir, [
    { name: "alpha", version: "1.0.0" },
    { name: "beta", version: "1.0.0" }
  ]);

  // Pre-populate .pkgxray.lock with an allow for alpha.
  const lockPath = path.join(dir, ".pkgxray.lock");
  await fs.writeFile(lockPath, JSON.stringify({
    schemaVersion: 1,
    decisions: [
      {
        name: "alpha",
        version: "1.0.0",
        decision: "allow",
        reason: "",
        decided_at: "2026-06-22T00:00:00Z"
      }
    ]
  }));

  const fakeStdin = makeFakeStdin();
  const fakeStdout = makeFakeStdout();
  // Only one feed needed — beta is the only remaining package.
  feedKeys(fakeStdin, ["b"]);

  await triageLockfile(lockfile, {
    stdin: fakeStdin,
    stdout: fakeStdout,
    stderr: makeFakeStdout(),
    isTTY: true,
    vulnerabilityCheck: false,
    includeSafe: true,
    resume: true
  });

  const saved = JSON.parse(await fs.readFile(lockPath, "utf8"));
  const decisionsByName = new Map(saved.decisions.map((d) => [d.name, d.decision]));
  assert.equal(decisionsByName.get("alpha"), "allow");
  assert.equal(decisionsByName.get("beta"), "block");
  // Output should show 0 allowed, 1 blocked — alpha was silently skipped.
  assert.match(fakeStdout.text, /0 allowed, 1 blocked/);
});

// ---------------------------------------------------------------------------
// auditLockfile honors triage decisions
// ---------------------------------------------------------------------------

test("auditLockfile honors a pre-existing .pkgxray.lock (allowed not blocked)", async () => {
  const dir = await tmpDir();
  const lockfile = await writeLockfileWithFakeAudit(dir, [
    { name: "alpha", version: "1.0.0" },
    { name: "beta", version: "1.0.0" }
  ]);

  // Synthesize a triage decision map directly — pre-allow alpha, pre-block
  // beta. We pass the decisions explicitly so we don't need OSV.
  const triageDecisions = new Map();
  triageDecisions.set("alpha@1.0.0", {
    name: "alpha", version: "1.0.0", decision: "allow", reason: "", decided_at: "2026-06-22T00:00:00Z"
  });
  triageDecisions.set("beta@1.0.0", {
    name: "beta", version: "1.0.0", decision: "block", reason: "manual", decided_at: "2026-06-22T00:00:00Z"
  });

  const result = await auditLockfile(lockfile, {
    vulnerabilityCheck: false,
    triageDecisions
  });

  const byName = new Map(result.results.map((r) => [r.name, r]));
  assert.equal(byName.get("alpha").decision, "safe");
  assert.equal(byName.get("alpha").triaged, true);
  assert.equal(byName.get("beta").decision, "block");
  assert.equal(byName.get("beta").triaged, true);
  assert.equal(result.summary.blocked, 1);
  assert.equal(result.worstDecision, "block");
});

test("auditLockfile loads .pkgxray.lock from sibling when none passed in", async () => {
  const dir = await tmpDir();
  const lockfile = await writeLockfileWithFakeAudit(dir, [
    { name: "alpha", version: "1.0.0" }
  ]);

  await fs.writeFile(path.join(dir, ".pkgxray.lock"), JSON.stringify({
    schemaVersion: 1,
    decisions: [
      { name: "alpha", version: "1.0.0", decision: "block", reason: "manual", decided_at: "2026-06-22T00:00:00Z" }
    ]
  }));

  const result = await auditLockfile(lockfile, { vulnerabilityCheck: false });
  const alpha = result.results.find((r) => r.name === "alpha");
  assert.equal(alpha.decision, "block");
  assert.equal(alpha.triaged, true);
  assert.equal(result.summary.blocked, 1);
});
