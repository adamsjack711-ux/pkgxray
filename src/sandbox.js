"use strict";

// --- Honeytoken canary sandbox (#6) ----------------------------------------
//
// pkgxray's default posture is to QUARANTINE WITHOUT EXECUTING — everything
// else in the tool is static. This module is the deliberate, opt-in exception:
// it actually RUNS a package's install-time lifecycle scripts, but inside a
// throwaway HOME seeded with decoy credentials (canary honeytokens) and behind
// a loopback capture proxy that records — and never forwards — egress. That
// turns a static "this code could read ~/.aws/credentials and POST it
// somewhere" into a behavioral "this install DID read the decoy AWS key and DID
// try to send it to <host>". The difference between a heuristic and proof.
//
// Because it executes untrusted code, it is gated behind an explicit opt-in
// (allowExecution) at every entry point, and the actual command execution is an
// injectable seam (`runner`) so the whole capture/tripwire pipeline is testable
// without running anything hostile.
//
// HONEST LIMITS (reported in the result, not hidden):
//   • The capture proxy sees plaintext HTTP bodies in full, but for HTTPS it
//     records only the CONNECT target host (no MITM) — the destination, not the
//     encrypted payload. A canary token is therefore proven leaked only when it
//     travels over plaintext HTTP or appears in an HTTPS CONNECT authority/URL;
//     an HTTPS-body exfil is caught as "phoned <host> after reading a decoy",
//     which is still a strong behavioral signal.
//   • Raw-socket / dgram / non-proxied egress is not captured by an HTTP proxy.
//   • Process isolation is best-effort: a decoy HOME + a scrubbed env always;
//     an OS sandbox wrapper (sandbox-exec / bwrap / firejail) IF one is present.
//     The achieved level is reported as `isolation`.

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const DEFAULT_TIMEOUT_MS = 20000;
// After the runner settles (or is timeout-killed) keep the capture proxy alive
// this long so a slightly-delayed backgrounded beacon is still recorded rather
// than escaping after teardown. Overridable via options.egressGraceMs (tests
// set it to 0 to avoid the wait).
const DEFAULT_EGRESS_GRACE_MS = 750;
const MAX_CAPTURED_BODY = 64 * 1024;

// Decoy files seeded into the sandbox HOME. Each carries a unique per-run token
// so a captured leak can be attributed to the exact secret that was read.
//
// ANTI-EVASION: the tokens are realistic-looking random secrets with NO
// "canary"/"honeypot"/"pkgxray" marker on disk — a payload that greps a decoy's
// CONTENTS for a giveaway string cannot skip it. We match on the exact random
// value, kept only in an in-memory token→decoy map. (This does not defeat
// environment-level fingerprinting — see the `caveat` in the result.)
const DECOY_SPECS = [
  { rel: ".aws/credentials", slug: "aws", build: (t) =>
      `[default]\naws_access_key_id = AKIA${t.slice(0, 16).toUpperCase()}\naws_secret_access_key = ${t}\nregion = us-east-1\n` },
  { rel: ".npmrc", slug: "npmrc", build: (t) => `//registry.npmjs.org/:_authToken=npm_${t}\n` },
  { rel: ".claude.json", slug: "claude", build: (t) =>
      `${JSON.stringify({ primaryApiKey: `sk-ant-api03-${t}`, mcpServers: {} }, null, 2)}\n` },
  { rel: ".config/claude/mcp.json", slug: "claude-mcp", build: (t) =>
      `${JSON.stringify({ mcpServers: { github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: `ghp_${t}` } } } }, null, 2)}\n` },
  { rel: ".ssh/id_rsa", slug: "ssh", build: (t) =>
      `-----BEGIN OPENSSH PRIVATE KEY-----\n${t}\n-----END OPENSSH PRIVATE KEY-----\n` },
  { rel: ".env", slug: "env", build: (t) => `SECRET_TOKEN=${t}\nDATABASE_URL=postgres://user:${t}@localhost/db\n` }
];

// Realistic random secret material — no marker substring, so it reads as a real
// credential to a payload inspecting file contents.
function realisticSecret(slug) {
  const alnum = (n) => crypto.randomBytes(n * 2).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, n);
  if (slug === "ssh") return crypto.randomBytes(180).toString("base64");
  if (slug === "claude") return alnum(95);
  return alnum(40);
}

// Callback/exfil hosts a plaintext-or-CONNECT contact to is inherently
// suspicious during an install. Kept local + small (mirrors the auditor's
// curated list) so the sandbox has no dependency on the static module.
const CALLBACK_HOSTS = [
  "webhook.site", "pastebin.com", "hastebin", "transfer.sh",
  "discord.com/api/webhooks", "discordapp.com/api/webhooks", "hooks.slack.com",
  "oast.live", "oast.fun", "oast.online", "oast.pro", "oastify.com", "interact.sh",
  "burpcollaborator.net", "requestbin", "pipedream.net",
  "ngrok-free.app", "ngrok.io", "serveo.net", "trycloudflare.com", "loca.lt"
];

function makeRunId() {
  return crypto.randomBytes(8).toString("hex");
}

// Seed the decoy filesystem. Returns the seeded file records (with their tokens
// and seed-time atime) plus a token→decoy lookup for attribution.
async function seedCanaryFilesystem(home, runId) {
  const files = [];
  const tokens = new Map();
  for (const spec of DECOY_SPECS) {
    const full = path.join(home, spec.rel);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    const token = realisticSecret(spec.slug);
    await fsp.writeFile(full, spec.build(token), { mode: 0o600 });
    let atimeMs = 0;
    try {
      atimeMs = (await fsp.stat(full)).atimeMs;
    } catch {
      atimeMs = 0;
    }
    files.push({ rel: spec.rel, full, token, slug: spec.slug, atimeMsAtSeed: atimeMs });
    tokens.set(token, spec.rel);
  }
  return { files, tokens, runId };
}

// Encoded forms a naive exfil path might apply to a stolen secret before
// sending it. A payload that base64/hex/url-encodes the token would defeat a
// plain substring match, so we also probe the common REVERSIBLE encodings and
// still attribute the leak to the original token. (Compression or encryption of
// the body still defeats this — reported honestly in the result `limits`.)
function tokenVariants(token) {
  const variants = [token];
  try { variants.push(Buffer.from(token, "utf8").toString("base64")); } catch { /* noop */ }
  try { variants.push(Buffer.from(token, "utf8").toString("base64url")); } catch { /* noop */ }
  try { variants.push(Buffer.from(token, "utf8").toString("hex")); } catch { /* noop */ }
  try { variants.push(encodeURIComponent(token)); } catch { /* noop */ }
  return Array.from(new Set(variants.filter(Boolean)));
}

// Which canary tokens appear — verbatim OR in a common reversible encoding —
// anywhere in a captured blob.
function matchTokens(haystack, tokenSet) {
  const seen = [];
  for (const token of tokenSet) {
    if (tokenVariants(token).some((v) => haystack.includes(v))) seen.push(token);
  }
  return seen;
}

function hostIsCallback(host) {
  const h = String(host || "").toLowerCase();
  return CALLBACK_HOSTS.some((c) => h.includes(c));
}

function isRawIpHost(host) {
  return /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?$/.test(String(host || ""));
}

// Loopback HTTP/HTTPS capture proxy. Plaintext requests are read in full (URL,
// headers, body) and scanned for canary tokens; HTTPS CONNECTs record the
// target host only. NOTHING is forwarded — captured egress never leaves the
// machine, so the decoy tokens are safe even when the payload "sends" them.
function startCaptureProxy(tokenSet) {
  const hits = [];
  // Track live sockets so teardown can never hang. server.close()'s callback
  // only fires once EVERY connection has ended; a payload that opens a
  // keep-alive socket to the proxy and never closes it would otherwise wedge
  // the run forever in the teardown await. We force-destroy any lingering
  // sockets on a short timer so close() is guaranteed to complete.
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    let bodyBytes = 0;
    let truncated = false;
    req.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bodyBytes < MAX_CAPTURED_BODY) {
        chunks.push(buf);
        bodyBytes += buf.length;
      } else {
        truncated = true;
      }
    });
    req.on("end", () => {
      // latin1 preserves bytes 1:1, so an ASCII-encoded (base64/hex/url) token
      // inside an otherwise-binary body survives intact for matchTokens.
      const body = Buffer.concat(chunks).toString("latin1");
      const haystack = `${req.url}\n${JSON.stringify(req.headers)}\n${body}`;
      const tokensSeen = matchTokens(haystack, tokenSet);
      let host = req.headers.host || "?";
      try {
        host = new URL(req.url).host || host;
      } catch {
        /* relative URL through a proxy is unusual; keep header host */
      }
      hits.push({ transport: "http", method: req.method, host, url: req.url, tokensSeen, bodyBytes, truncated });
      res.writeHead(204);
      res.end();
    });
    req.on("error", () => { try { res.destroy(); } catch { /* noop */ } });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  server.on("connect", (req, clientSocket) => {
    sockets.add(clientSocket);
    clientSocket.on("close", () => sockets.delete(clientSocket));
    const host = req.url; // host:port
    const authTokens = matchTokens(host, tokenSet);
    hits.push({ transport: "https-connect", method: "CONNECT", host, url: `https://${host}`, tokensSeen: authTokens, bodyBytes: 0 });
    // No MITM: record the intended destination and refuse the tunnel so
    // nothing actually egresses.
    try {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      clientSocket.end();
    } catch {
      /* client already gone */
    }
  });
  server.on("clientError", (_err, socket) => { try { socket.destroy(); } catch { /* noop */ } });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        hits,
        close: () =>
          new Promise((r) => {
            let done = false;
            const finish = () => { if (!done) { done = true; r(); } };
            // After a short grace, force-destroy any socket still open so
            // server.close() can fire its callback. Bounded so a lingering
            // keep-alive connection can't wedge teardown.
            const destroyTimer = setTimeout(() => {
              for (const s of sockets) { try { s.destroy(); } catch { /* noop */ } }
            }, 250);
            if (destroyTimer.unref) destroyTimer.unref();
            // Absolute backstop: resolve regardless if close() never calls back.
            const hardTimer = setTimeout(finish, 1500);
            if (hardTimer.unref) hardTimer.unref();
            server.close(() => { clearTimeout(destroyTimer); clearTimeout(hardTimer); finish(); });
          })
      });
    });
  });
}

// Escape a path for safe interpolation into an SBPL string literal so a path
// containing a quote or backslash can't break out of / corrupt the sandbox
// profile (a malformed profile makes sandbox-exec fail, which fails the run —
// still fail-closed, but this keeps the policy well-formed).
function sbplLiteral(p) {
  return `"${String(p).replace(/(["\\])/g, "\\$1")}"`;
}

// Detect a best-effort OS sandbox wrapper. We never REQUIRE one (the decoy HOME
// + capture proxy are the primary controls), but if the platform ships one we
// use it to confine filesystem writes AND real network egress while keeping
// loopback access to the capture proxy. `netConfined` reports whether the OS
// boundary — not just the proxy env vars — blocks non-loopback egress.
function detectSandboxWrapper(sandboxRoot) {
  const has = (cmd) => {
    try {
      return spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;
    } catch {
      return false;
    }
  };
  if (process.platform === "darwin" && has("sandbox-exec")) {
    // Deny writes outside the sandbox root, AND deny real network egress except
    // loopback. Denying non-loopback network at the OS boundary means a payload
    // that opens a raw socket / connects to a direct IP (bypassing the proxy
    // env vars) is BLOCKED here instead of silently escaping — while the capture
    // proxy on 127.0.0.1 stays reachable so proxy-respecting egress is still
    // observed. Reads stay allowed so the payload can reach the decoy HOME.
    const profile =
      "(version 1)(allow default)" +
      `(deny file-write* (subpath ${sbplLiteral(os.homedir())}))` +
      `(allow file-write* (subpath ${sbplLiteral(sandboxRoot)}) (subpath "/private/tmp") (subpath "/tmp"))` +
      "(deny network*)" +
      '(allow network-outbound (remote ip "localhost:*"))' +
      '(allow network-inbound (local ip "localhost:*"))' +
      '(allow network-bind (local ip "localhost:*"))';
    return { level: "sandbox-exec", netConfined: true, wrap: (argv) => ["sandbox-exec", "-p", profile, ...argv] };
  }
  if (process.platform === "linux" && has("bwrap")) {
    // bubblewrap: bind the sandbox root rw, everything else ro, and isolate the
    // process/IPC/hostname namespaces. Net stays SHARED so loopback→proxy still
    // works (the capture proxy, not the network namespace, is what denies real
    // egress — so netConfined is false here; raw-socket egress can still leave).
    // A tmpfs is stacked over the REAL home dir so the payload cannot read the
    // operator's actual ~/.aws, ~/.npmrc, ~/.ssh, etc. through the ro-bind of /
    // (HOME itself is repointed at the decoy tree via env). --die-with-parent
    // guarantees no sandbox process outlives pkgxray, and --new-session detaches
    // the controlling terminal (blocks TIOCSTI input-injection). All flags are
    // long-standing.
    const realHome = os.homedir();
    const maskRealHome =
      realHome && path.resolve(realHome) !== path.resolve(sandboxRoot) && !sandboxRoot.startsWith(path.resolve(realHome) + path.sep)
        ? ["--tmpfs", realHome]
        : [];
    return {
      level: "bwrap",
      netConfined: false,
      wrap: (argv) => [
        "bwrap",
        "--ro-bind", "/", "/",
        ...maskRealHome,
        "--bind", sandboxRoot, sandboxRoot,
        "--dev", "/dev",
        "--proc", "/proc",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--die-with-parent",
        "--new-session",
        ...argv
      ]
    };
  }
  return { level: "env-only", netConfined: false, wrap: (argv) => argv };
}

// The default (real) runner: execute the package's declared install lifecycle
// scripts, in order, in the package dir with the scrubbed decoy env. This is
// exactly the install-time execution surface the TeamPCP / node-ipc families
// use — and the part gated behind allowExecution.
async function runLifecycleScripts({ pkgDir, env, timeoutMs, wrapper, rlimits }) {
  let pkg;
  try {
    pkg = JSON.parse(await fsp.readFile(path.join(pkgDir, "package.json"), "utf8"));
  } catch {
    return { ran: [], note: "no package.json in staged package" };
  }
  const scripts = (pkg && pkg.scripts) || {};
  const ran = [];
  for (const hook of ["preinstall", "install", "postinstall"]) {
    const command = scripts[hook];
    if (typeof command !== "string" || !command.trim()) continue;
    const outcome = await execWithTimeout(command, { cwd: pkgDir, env, timeoutMs, wrapper, rlimits });
    ran.push({ hook, command, ...outcome });
  }
  return { ran };
}

// Best-effort resource caps for the untrusted child, applied via `ulimit` in the
// spawned POSIX shell. The timeout + process-group SIGKILL bound TIME; these
// bound BLAST RADIUS during that window: CPU spin, disk-fill, fork-bomb, core
// dumps. `ulimit` can only LOWER a limit, so if the host's is already stricter
// the call is a harmless no-op (errors swallowed with `2>/dev/null`). We use
// `;` not `&&` so a limit the host refuses to set can't abort the payload run
// (that would turn hardening into a false "benign" verdict). Disable with
// rlimits:false. win32 has no ulimit and is skipped by the caller.
const DEFAULT_RLIMITS = {
  cpuSeconds: null,       // null → derived from timeoutMs (wall-clock) + headroom
  fileSizeBlocks: 524288, // cap single-file writes (~256MB at 512B blocks)
  maxProcs: 512,          // fork-bomb backstop
  coreDumps: 0            // no core dumps (they can leak the decoy HOME to disk)
};

function buildRlimitPrefix(timeoutMs, rlimits) {
  if (rlimits === false || process.platform === "win32") return "";
  const r = { ...DEFAULT_RLIMITS, ...(rlimits && typeof rlimits === "object" ? rlimits : {}) };
  const wall = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const cpu = Number.isFinite(r.cpuSeconds) && r.cpuSeconds > 0
    ? Math.floor(r.cpuSeconds)
    : Math.ceil(wall / 1000) + 10;
  // Each limit is a SEPARATE, individually error-guarded `ulimit` call. Shells
  // differ in which options they support — Ubuntu's `/bin/sh` is dash, whose
  // `ulimit` rejects `-u` (max procs) — and a single combined `ulimit -t … -u …`
  // aborts ALL limits on the first unsupported flag. Separate `; `-joined calls
  // apply every supported limit and silently skip the rest. `ulimit` can only
  // lower a limit, so a stricter host limit is preserved.
  const stmts = [`ulimit -t ${cpu}`, `ulimit -c ${Math.max(0, Math.floor(r.coreDumps))}`];
  if (Number.isFinite(r.fileSizeBlocks) && r.fileSizeBlocks > 0) stmts.push(`ulimit -f ${Math.floor(r.fileSizeBlocks)}`);
  if (Number.isFinite(r.maxProcs) && r.maxProcs > 0) stmts.push(`ulimit -u ${Math.floor(r.maxProcs)}`);
  return `${stmts.map((s) => `${s} 2>/dev/null`).join("; ")}; `;
}

// Kill the whole process GROUP of a detached child, not just the direct shell.
// `sh -c "(sleep 5; curl ...) &"` backgrounds a grandchild; killing only the
// shell leaves that grandchild alive to egress after the direct process exits.
// Spawning detached:true makes the child a process-group leader, so a negative
// pid signals every process in the group. Guarded for ESRCH (group already
// reaped) and non-posix (no negative-pid semantics on win32).
function killProcessGroup(child, signal) {
  if (!child || child.pid == null) return;
  if (process.platform === "win32") {
    try { child.kill(signal); } catch { /* already gone */ }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error && error.code === "ESRCH") return; // group already gone
    // Fall back to killing just the direct child if the group signal fails
    // for any other reason (e.g. we never became a group leader).
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

function execWithTimeout(command, { cwd, env, timeoutMs, wrapper, rlimits }) {
  return new Promise((resolve) => {
    // On POSIX, prepend `ulimit` caps inside the shell so they bound the whole
    // process tree (backgrounded grandchildren inherit them). win32 has no
    // ulimit, so the command runs unwrapped there.
    const shellCommand =
      process.platform === "win32" ? command : `${buildRlimitPrefix(timeoutMs, rlimits)}${command}`;
    const baseArgv = process.platform === "win32" ? ["cmd", "/c", command] : ["sh", "-c", shellCommand];
    const argv = wrapper ? wrapper(baseArgv) : baseArgv;
    let child;
    try {
      // detached:true → the child leads its own process group so a timeout can
      // SIGKILL the ENTIRE group (backgrounded/forked grandchildren included),
      // not just the direct shell.
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32"
      });
    } catch (error) {
      return resolve({ error: error.message, timedOut: false, exitCode: null });
    }
    let out = "";
    const cap = (chunk) => {
      if (out.length < 8192) out += chunk;
    };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, "SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ error: error.message, timedOut, exitCode: null });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut, output: out.slice(0, 2000) });
    });
  });
}

// Turn captured proxy hits + decoy atimes into behavioral findings.
async function evaluateTripwires(canary, hits) {
  const findings = [];

  // 1) DEFINITIVE: a canary token appeared in captured egress → the install
  // read that specific decoy AND tried to transmit it. Proof, not inference.
  for (const hit of hits) {
    for (const token of hit.tokensSeen || []) {
      const decoy = canary.tokens.get(token) || "a decoy credential";
      findings.push({
        severity: "high",
        category: "behavioral-exfil",
        file: "CANARY_SANDBOX",
        snippet: `${decoy} → ${hit.host}`,
        rationale:
          `Install-time execution READ the decoy ${decoy} and transmitted its honeytoken to ${hit.host} (${hit.transport}). This is an observed credential-exfil, not a static inference.`
      });
    }
  }

  // 2) Phoned a known callback/exfil host or a raw IP during install.
  const suspiciousContacts = hits.filter((h) => hostIsCallback(h.host) || isRawIpHost(h.host));
  for (const hit of suspiciousContacts) {
    if ((hit.tokensSeen || []).length > 0) continue; // already reported as exfil
    findings.push({
      severity: "high",
      category: "behavioral-network",
      file: "CANARY_SANDBOX",
      snippet: hit.host,
      rationale:
        `Install-time execution contacted ${hit.host} (${hit.transport}) — a known callback/exfil destination or a raw IP. Legitimate installs do not phone these.`
    });
  }

  // 3) Any egress at all during install (informational-to-review): a package
  // that reaches the network from a postinstall warrants a look even if the
  // destination isn't on the callback list.
  const otherEgress = hits.filter(
    (h) => !hostIsCallback(h.host) && !isRawIpHost(h.host) && (h.tokensSeen || []).length === 0
  );
  if (otherEgress.length > 0) {
    const hostList = Array.from(new Set(otherEgress.map((h) => h.host))).slice(0, 8);
    findings.push({
      severity: "medium",
      category: "behavioral-network",
      file: "CANARY_SANDBOX",
      snippet: hostList.join(", "),
      rationale:
        `Install-time execution made outbound network requests to: ${hostList.join(", ")}. Review whether this package should reach the network at install.`
    });
  }

  // 4) Best-effort decoy-read tripwire via access-time. atime is unreliable
  // under relatime/noatime, so it only CORROBORATES (medium) — never the sole
  // basis for a high — but a decoy whose atime advanced during the run was
  // very likely opened by the payload.
  const readDecoys = [];
  for (const file of canary.files) {
    try {
      const now = (await fsp.stat(file.full)).atimeMs;
      if (now > file.atimeMsAtSeed + 1) readDecoys.push(file.rel);
    } catch {
      /* decoy vanished — ignore */
    }
  }
  if (readDecoys.length > 0) {
    findings.push({
      severity: "medium",
      category: "behavioral-credential-read",
      file: "CANARY_SANDBOX",
      snippet: readDecoys.join(", "),
      rationale:
        `Install-time execution accessed decoy credential file(s): ${readDecoys.join(", ")} (access-time tripwire; corroborating, since atime can be unreliable). Combined with any egress above this is a credential-harvest shape.`
    });
  }

  return findings;
}

// Orchestrator. `runner` is the injectable execution seam (defaults to the real
// lifecycle-script runner); tests pass a controlled runner so the whole
// capture/tripwire pipeline runs without executing anything hostile.
async function runCanarySandbox(options = {}) {
  if (options.allowExecution !== true) {
    const err = new Error(
      "canary sandbox EXECUTES the package's install scripts; refusing without explicit opt-in " +
        "(pass allowExecution:true / --yes-run-untrusted-code / PKGXRAY_ALLOW_EXECUTION=1)"
    );
    err.code = "EXECUTION_NOT_CONFIRMED";
    throw err;
  }
  const pkgDir = options.stagedPath;
  if (!pkgDir) throw new Error("canary sandbox requires a staged package path (stagedPath)");

  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const runId = options.runId || makeRunId();
  // Neutral temp-dir prefix (NOT "pkgxray"/"canary") so a payload that
  // fingerprints its HOME/CWD path can't trivially spot the sandbox. This only
  // raises the bar — a /tmp HOME is itself a tell; see `caveat`.
  const root = options.sandboxRoot || (await fsp.mkdtemp(path.join(os.tmpdir(), "npm-")));
  const home = path.join(root, "home");
  await fsp.mkdir(home, { recursive: true, mode: 0o700 });

  // Decide isolation up front so a caller that DEMANDS real OS-level confinement
  // (--require-sandbox) fails closed BEFORE we seed decoys, start the proxy, or
  // execute anything, rather than silently running with env-only isolation.
  const wrapperInfo = detectSandboxWrapper(root);
  if (options.requireSandbox === true && wrapperInfo.level === "env-only") {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    const err = new Error(
      "canary --require-sandbox: no OS sandbox wrapper (bwrap / sandbox-exec) is available; " +
        "refusing to execute untrusted install scripts with env-only isolation. " +
        "Install bubblewrap (Linux) or run on macOS with sandbox-exec, or drop --require-sandbox to accept env-only."
    );
    err.code = "SANDBOX_REQUIRED";
    throw err;
  }

  const canary = await seedCanaryFilesystem(home, runId);
  const proxy = await startCaptureProxy(new Set(canary.tokens.keys()));

  const proxyUrl = `http://127.0.0.1:${proxy.port}`;
  // Scrubbed env: keep only what a script needs to run, repoint HOME at the
  // decoy tree, and force every proxy variable at our capture server.
  const env = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: home,
    USERPROFILE: home,
    TMPDIR: root,
    npm_config_cache: path.join(root, "npm-cache"),
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    ALL_PROXY: proxyUrl,
    npm_config_proxy: proxyUrl,
    npm_config_https_proxy: proxyUrl,
    // A no-op registry through the proxy; nothing should actually resolve.
    NO_PROXY: "",
    no_proxy: ""
  };

  let execResult;
  try {
    const runner = options.runner || runLifecycleScripts;
    execResult = await runner({ pkgDir, env, timeoutMs, wrapper: wrapperInfo.wrap, home, proxyPort: proxy.port, rlimits: options.rlimits });
  } finally {
    // Keep the capture proxy alive for a short grace window after the runner
    // settles. A payload that backgrounds a delayed beacon —
    // `(sleep 5; curl ...) &` — egresses AFTER the direct shell exits; tearing
    // the proxy down immediately would miss it and the run would read safe.
    // Bounded so a genuinely benign install adds only this fixed tail latency.
    const graceMs = Number.isFinite(options.egressGraceMs) && options.egressGraceMs >= 0
      ? options.egressGraceMs
      : DEFAULT_EGRESS_GRACE_MS;
    if (graceMs > 0) {
      await new Promise((r) => setTimeout(r, graceMs));
    }
    await proxy.close();
  }

  const findings = await evaluateTripwires(canary, proxy.hits);

  if (!options.keepSandbox) {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }

  // "not-observed" (NOT "safe"): a clean behavioral run can never clear a
  // package, only fail to catch it this time. The verdict vocabulary reflects
  // that — callers compare against "block"/"review" and treat anything else as
  // inconclusive, never as a pass.
  const verdict = findings.some((f) => f.severity === "high")
    ? "block"
    : findings.some((f) => f.severity === "medium")
      ? "review"
      : "not-observed";

  // On Linux, raw-socket egress can still leave (net is shared to keep the proxy
  // reachable); on macOS the OS profile denies non-loopback egress. Report the
  // residual so callers/rendering can be honest about it.
  const rawSocketEgressPossible = wrapperInfo.netConfined !== true;

  return {
    schemaVersion: 2,
    runId,
    isolation: wrapperInfo.level,
    isolationRequired: options.requireSandbox === true,
    netConfined: wrapperInfo.netConfined === true,
    resourceLimited: options.rlimits !== false && process.platform !== "win32",
    sandboxRoot: options.keepSandbox ? root : null,
    timeoutMs,
    executed: execResult || null,
    egress: proxy.hits,
    findings,
    verdict,
    // A behavioral run is ASYMMETRIC evidence: it can CONFIRM malice but can
    // NEVER clear a package. Sandbox-aware malware evades observation and fires
    // only on a real developer's machine. Callers must treat a "not-observed"
    // verdict as "nothing observed this run", not "safe".
    confirmsButCannotClear: true,
    caveat:
      verdict === "not-observed"
        ? "No malicious behavior was OBSERVED in this run. This does NOT clear the package. " +
          "Sandbox-aware malware stays dormant when it detects analysis and activates only on a real target, by fingerprinting: " +
          "(1) environment — a set HTTP(S)_PROXY, a HOME under /tmp, decoy-shaped dotfiles, missing shell history/browser data, VM/CI hostnames; " +
          "(2) time — delayed, scheduled, or date-gated activation that outlasts the scan window; " +
          "(3) geo/locale — only firing in a target region (the node-ipc shape); " +
          "(4) network — a C2 that is offline/benign during the scan, or that only serves the payload to a non-datacenter/residential IP; " +
          "(5) interaction — waiting for real developer/runtime signals the install phase never produces. " +
          "The static scan remains authoritative; a quiet canary only means 'not caught here'."
        : "Malicious behavior was OBSERVED and captured. Note the inverse still holds for anything NOT seen: " +
          "sandbox-aware malware can hide additional behavior behind environment/time/geo/C2/interaction gates.",
    limits:
      "HTTPS bodies are not inspected (CONNECT destination host recorded, no MITM); plaintext/base64/hex/url-encoded canary tokens are matched but compressed or encrypted exfil bodies are not; " +
      `${rawSocketEgressPossible ? "raw-socket/dgram/non-proxied egress can still leave (net shared to keep the proxy reachable)" : "non-loopback egress is denied at the OS boundary (raw-socket egress blocked, not just unobserved)"}; ` +
      `process isolation level: ${wrapperInfo.level}. Absence of a finding is not evidence of safety.`
  };
}

module.exports = {
  runCanarySandbox,
  seedCanaryFilesystem,
  startCaptureProxy,
  evaluateTripwires,
  matchTokens,
  tokenVariants,
  detectSandboxWrapper,
  makeRunId,
  DECOY_SPECS,
  // exported for tests: process-group kill + timeout runner + resource caps
  killProcessGroup,
  execWithTimeout,
  buildRlimitPrefix
};
