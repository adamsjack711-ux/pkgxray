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

// The capture HTTP/HTTPS server, factored out so the in-process proxy and the
// in-netns file-capture proxy (below) share ONE implementation of request
// parsing, token scanning, and CONNECT refusal. Plaintext requests are read in
// full (URL, headers, body) and scanned for canary tokens; HTTPS CONNECTs
// record the target host only. NOTHING is forwarded — captured egress never
// leaves the machine. `onHit(hit)` fires for every recorded hit; the socket set
// it returns lets the caller force-destroy lingering connections on teardown.
function createCaptureServer(tokenSet, onHit) {
  const sockets = new Set();
  // Precompute each token's encoded variants ONCE — they depend only on the
  // token, never the request — so the capture hot path doesn't re-encode all
  // decoys on every hit.
  const tokenIndex = Array.from(tokenSet, (token) => ({ token, variants: tokenVariants(token) }));
  const scan = (haystack) => {
    const seen = [];
    for (const { token, variants } of tokenIndex) {
      if (variants.some((v) => haystack.includes(v))) seen.push(token);
    }
    return seen;
  };
  const record = (hit) => { try { onHit(hit); } catch { /* onHit must never break capture */ } };

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
      const tokensSeen = scan(haystack);
      let host = req.headers.host || "?";
      try {
        host = new URL(req.url).host || host;
      } catch {
        /* relative URL through a proxy is unusual; keep header host */
      }
      record({ transport: "http", method: req.method, host, url: req.url, tokensSeen, bodyBytes, truncated });
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
    const authTokens = scan(host);
    record({ transport: "https-connect", method: "CONNECT", host, url: `https://${host}`, tokensSeen: authTokens, bodyBytes: 0 });
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

  // Bounded teardown: force-destroy any socket still open so server.close()'s
  // callback (which only fires once EVERY connection ends) can't be wedged by a
  // payload holding a keep-alive socket open.
  const close = () =>
    new Promise((r) => {
      let done = false;
      const finish = () => { if (!done) { done = true; r(); } };
      const destroyTimer = setTimeout(() => {
        for (const s of sockets) { try { s.destroy(); } catch { /* noop */ } }
      }, 250);
      if (destroyTimer.unref) destroyTimer.unref();
      const hardTimer = setTimeout(finish, 1500);
      if (hardTimer.unref) hardTimer.unref();
      server.close(() => { clearTimeout(destroyTimer); clearTimeout(hardTimer); finish(); });
    });

  return { server, close };
}

// Loopback HTTP/HTTPS capture proxy in the parent process. Listens on a TCP
// port (used by the env-only, sandbox-exec, and shared-net bwrap tiers, where
// the sandbox reaches the host loopback directly) and — when `unixPath` is
// given — ALSO on a Unix socket, which the netns tier's in-sandbox forwarder
// connects to across the network-namespace boundary (a path-based unix socket
// is filesystem-scoped, not netns-scoped, so it works where TCP loopback does
// not). Both listeners feed one shared `hits` array.
function startCaptureProxy(tokenSet, options = {}) {
  const hits = [];
  const tcp = createCaptureServer(tokenSet, (hit) => hits.push(hit));
  const unix = options.unixPath ? createCaptureServer(tokenSet, (hit) => hits.push(hit)) : null;
  return new Promise((resolve, reject) => {
    tcp.server.listen(0, "127.0.0.1", () => {
      const { port } = tcp.server.address();
      const finish = () =>
        resolve({
          port,
          unixPath: options.unixPath || null,
          hits,
          close: async () => { await tcp.close(); if (unix) await unix.close(); }
        });
      if (!unix) return finish();
      unix.server.on("error", reject);
      unix.server.listen(options.unixPath, finish);
    });
  });
}

// TCP→Unix forwarder, run INSIDE the sandbox's network namespace. It listens on
// loopback (127.0.0.1:innerPort) and pipes each connection, byte-for-byte, to
// the parent capture proxy's Unix socket. Because it is a dumb byte pipe, both
// plaintext HTTP and HTTPS CONNECT frames reach the capture proxy intact. The
// payload's HTTP(S)_PROXY points at innerPort; anything that bypasses the proxy
// and dials a real IP directly has no route out of the fresh netns and is
// refused by the kernel. Returns the server so a self-test can close it.
function startTcpToUnixForwarder(innerPort, sockPath, onReady) {
  const net = require("node:net");
  const server = net.createServer((down) => {
    const up = net.connect(sockPath);
    down.on("error", () => up.destroy());
    up.on("error", () => down.destroy());
    down.pipe(up);
    up.pipe(down);
  });
  server.on("error", () => { /* surfaced to caller via not-ready */ });
  server.listen(innerPort, "127.0.0.1", () => { if (onReady) onReady(); });
  return server;
}

// Build the bootstrap shell that runs as the bwrap `--unshare-net` child: bring
// up loopback (a fresh netns starts with lo DOWN), start the forwarder and wait
// until it is listening, run the payload, then hold the forwarder open for the
// egress grace window so a delayed beacon is still forwarded before teardown.
// Pure string construction so it is unit-testable without a sandbox.
function buildNetnsBootstrap({ nodeBin, selfPath, innerPort, sockPath, readyFile, ipBin, graceMs, payloadCmd }) {
  const q = shellQuote;
  const graceS = Math.max(0, Math.ceil((Number(graceMs) || 0) / 1000));
  return [
    `${q(ipBin)} link set lo up 2>/dev/null`,
    `${q(nodeBin)} ${q(selfPath)} __forwarder ${innerPort} ${q(sockPath)} ${q(readyFile)} &`,
    `__fw=$!`,
    // Wait (bounded ~5s) for the forwarder to signal ready, then run the payload.
    `__i=0; while [ ! -f ${q(readyFile)} ] && [ $__i -lt 100 ]; do __i=$((__i+1)); sleep 0.05; done`,
    payloadCmd,
    `__status=$?`,
    graceS > 0 ? `sleep ${graceS}` : `:`,
    `kill $__fw 2>/dev/null`,
    `exit $__status`
  ].join("\n");
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
    // The `bwrap+netns` tier (detectNetnsConfinement) upgrades this to
    // netConfined:true when an unprivileged network namespace can be stood up.
    return {
      level: "bwrap",
      netConfined: false,
      wrap: (argv) => ["bwrap", ...bwrapBaseArgs(sandboxRoot), ...argv]
    };
  }
  return { level: "env-only", netConfined: false, wrap: (argv) => argv };
}

// The bwrap arguments shared by the shared-net and netns tiers. A tmpfs is
// stacked over the REAL home dir so the payload cannot read the operator's
// actual ~/.aws, ~/.npmrc, ~/.ssh, etc. through the ro-bind of / (HOME itself
// is repointed at the decoy tree via env). --die-with-parent guarantees no
// sandbox process outlives pkgxray; --new-session detaches the controlling
// terminal (blocks TIOCSTI input-injection). All flags are long-standing.
// Mask the real home ONLY when it's a normal directory that does not contain
// the sandbox root — the `--tmpfs /` edge (os.homedir() === "/") would shadow
// the ro-bind of everything, including the staged package, making the payload
// unable to read its own package.json (a false "not-observed" without executing).
function bwrapBaseArgs(sandboxRoot) {
  const realHome = os.homedir();
  const resolvedHome = realHome ? path.resolve(realHome) : "";
  const resolvedRoot = path.resolve(sandboxRoot);
  const homeIsFsRoot = resolvedHome !== "" && resolvedHome === path.parse(resolvedHome).root;
  const sandboxUnderHome =
    resolvedHome !== "" && (resolvedRoot === resolvedHome || resolvedRoot.startsWith(resolvedHome + path.sep));
  const maskRealHome = resolvedHome !== "" && !homeIsFsRoot && !sandboxUnderHome ? ["--tmpfs", realHome] : [];
  return [
    "--ro-bind", "/", "/",
    ...maskRealHome,
    "--bind", sandboxRoot, sandboxRoot,
    "--dev", "/dev",
    "--proc", "/proc",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--die-with-parent",
    "--new-session"
  ];
}

function hasCmd(cmd) {
  try {
    return spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

// Resolve the loopback-up tool. A fresh network namespace starts with `lo`
// DOWN, so a loopback-only egress path needs `ip link set lo up`. iproute2's
// `ip` is the only dependency; absent it, the netns tier is unavailable and we
// fall back to shared-net bwrap. (busybox `ifconfig` is intentionally not used —
// keeping one well-known tool keeps the self-test's guarantee legible.)
function resolveIpBin() {
  return hasCmd("ip") ? "ip" : null;
}

// Module-level cache: the netns capability is a property of the HOST (kernel +
// tooling), not of a given run, so the self-test runs at most once per process.
// undefined = not yet probed; false = unavailable; true = self-test passed.
let _netnsCapable;
const NETNS_INNER_PORT = 18080; // arbitrary; inside an isolated netns, no conflict

// Decide whether real network-namespace confinement is available, and if so
// return a per-run descriptor. Engages ONLY when bwrap + ip are present AND a
// live self-test proves, using the exact same machinery a real run uses, that
// (a) proxied egress is still captured and (b) a direct dial to a non-loopback
// IP is refused by the kernel (ENETUNREACH). Any failure → null → the caller
// falls back to shared-net bwrap. This is the safety contract: netConfined:true
// is asserted only after it has been demonstrated in THIS environment, never
// assumed.
async function detectNetnsConfinement(sandboxRoot) {
  if (process.platform !== "linux") return null;
  const ipBin = resolveIpBin();
  if (!hasCmd("bwrap") || !ipBin) return null;
  if (_netnsCapable === undefined) {
    _netnsCapable = await selfTestNetnsConfinement(ipBin).catch(() => false);
  }
  if (!_netnsCapable) return null;
  const sockPath = path.join(sandboxRoot, "cap.sock");
  const readyFile = path.join(sandboxRoot, "fw.ready");
  return {
    innerPort: NETNS_INNER_PORT,
    sockPath,
    // The final wrap depends on the run's grace window (the forwarder must
    // outlive the payload long enough for the parent's egress-grace read), so
    // the caller builds it once it knows graceMs.
    build: (graceMs) => ({
      level: "bwrap+netns",
      netConfined: true,
      wrap: (argv) => netnsWrap(argv, { sandboxRoot, innerPort: NETNS_INNER_PORT, sockPath, readyFile, ipBin, graceMs })
    })
  };
}

// Wrap the payload argv into a bwrap --unshare-net invocation whose child is the
// netns bootstrap (bring up lo, start the forwarder, run the payload). The base
// argv from execWithTimeout is ["sh","-c",<cmd>]; we rebuild <cmd> as the
// bootstrap wrapping the original command.
function netnsWrap(argv, opts) {
  const cmd = argv[0] === "sh" && argv[1] === "-c" ? argv[2] : argv.join(" ");
  const bootstrap = buildNetnsBootstrap({
    nodeBin: process.execPath,
    selfPath: __filename,
    innerPort: opts.innerPort,
    sockPath: opts.sockPath,
    readyFile: opts.readyFile,
    ipBin: opts.ipBin,
    graceMs: opts.graceMs,
    payloadCmd: cmd
  });
  return ["bwrap", ...bwrapBaseArgs(opts.sandboxRoot), "--unshare-net", "sh", "-c", bootstrap];
}

// Spawn a raw argv (no shell), capture output, enforce a timeout with a
// process-group kill. Used by the netns self-test.
function spawnCapture(argv, { env, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (error) {
      return resolve({ error: error.message, output: "", timedOut: false });
    }
    let out = "";
    const cap = (c) => { if (out.length < 8192) out += c; };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killProcessGroup(child, "SIGKILL"); }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ error: e.message, output: out, timedOut }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ exitCode: code, output: out, timedOut }); });
  });
}

// The self-test: stand up the real machinery once and demand proof of BOTH
// confinement properties before ever reporting netConfined:true.
async function selfTestNetnsConfinement(ipBin) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "npm-netns-selftest-"));
  const token = `selftest-${crypto.randomBytes(8).toString("hex")}`;
  let proxy;
  try {
    const sockPath = path.join(root, "cap.sock");
    const readyFile = path.join(root, "fw.ready");
    const hits = [];
    const cap = createCaptureServer(new Set([token]), (h) => hits.push(h));
    await new Promise((res, rej) => { cap.server.on("error", rej); cap.server.listen(sockPath, res); });
    proxy = cap;

    // Probe (runs inside the netns): (1) POST the token through the proxy — must
    // be captured; (2) dial a non-loopback TEST-NET-3 (RFC5737) IP directly —
    // the kernel must refuse it (ENETUNREACH/EHOSTUNREACH/ENETDOWN), proving
    // there is no route out of the namespace. Prints markers we assert on.
    const probeSrc =
      "const http=require('node:http'),net=require('node:net');" +
      "const p=new URL(process.env.HTTP_PROXY);" +
      "const r=http.request({host:p.hostname,port:p.port,method:'POST',path:'http://selftest.local/x',headers:{host:'selftest.local'}});" +
      "r.on('error',()=>{});r.end('t=' + process.env.SELFTEST_TOKEN);" +
      "const s=net.connect({host:'203.0.113.1',port:80});" +
      "s.setTimeout(2000);" +
      "s.on('connect',()=>{console.log('DIRECT_OPEN');s.destroy();});" +
      "s.on('timeout',()=>{console.log('DIRECT_TIMEOUT');s.destroy();});" +
      "s.on('error',(e)=>{console.log('DIRECT_ERR_'+e.code);});";
    const payloadCmd = `${shellQuote(process.execPath)} -e ${shellQuote(probeSrc)}`;
    const bootstrap = buildNetnsBootstrap({
      nodeBin: process.execPath, selfPath: __filename, innerPort: NETNS_INNER_PORT,
      sockPath, readyFile, ipBin, graceMs: 500, payloadCmd
    });
    const argv = ["bwrap", ...bwrapBaseArgs(root), "--unshare-net", "sh", "-c", bootstrap];
    const env = { ...process.env, HTTP_PROXY: `http://127.0.0.1:${NETNS_INNER_PORT}`, SELFTEST_TOKEN: token };
    const res = await spawnCapture(argv, { env, timeoutMs: 10000 });

    const captured = hits.some((h) => (h.tokensSeen || []).includes(token));
    // Only a KERNEL-level refusal (unreachable / net down) proves isolation;
    // a timeout would also occur on a shared net where the IP just doesn't
    // answer, so it does NOT count as confinement.
    const directBlocked = /DIRECT_ERR_(ENETUNREACH|EHOSTUNREACH|ENETDOWN|EADDRNOTAVAIL)/.test(res.output || "");
    return captured && directBlocked;
  } catch {
    return false;
  } finally {
    if (proxy) await proxy.close().catch(() => {});
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

// __forwarder / __capture entrypoints, invoked as `node sandbox.js <mode> …`
// from inside the sandbox. Kept at module scope so bwrap's ro-bind of / makes
// this file reachable by absolute path.
function forwarderMain(argv) {
  const [portStr, sockPath, readyFile] = argv;
  startTcpToUnixForwarder(Number(portStr), sockPath, () => {
    try { require("node:fs").writeFileSync(readyFile, "ready\n"); } catch { /* best effort */ }
  });
}

// The install-phase runner: execute the package's declared install lifecycle
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

// The loader that runs INSIDE the sandbox to detonate the import phase. It
// resolves the package's own entry point (respecting package.json `main` /
// `exports` / index.js), then loads it so any top-level side effect executes
// and is observed by the capture proxy — the flatmap-stream / malicious-on-first-
// require shape that a lifecycle-only run never triggers. `require` handles CJS;
// on ERR_REQUIRE_ESM it falls back to dynamic import(). Best-effort: a package
// whose entry require()s an uninstalled dependency throws before its payload
// runs — the same ceiling any without-install detonation faces (noted in the
// result `limits`). Errors are swallowed to stderr; the goal is to trigger and
// observe side effects, not to grade whether the module loaded cleanly.
const IMPORT_PROBE_SOURCE = `'use strict';
const { pathToFileURL } = require('node:url');
const dir = process.argv[2];
// The parent passes a result-file path and an unforgeable nonce. Read them, then
// TRUNCATE argv so the package we are about to load — it runs in THIS process via
// require() — cannot read the path to overwrite our result, nor learn the nonce
// to forge one. Capture the original fs.writeFileSync NOW, before the package can
// monkeypatch it, and report through that captured reference. Writing to a file
// (not stdout) keeps the signal out of the truncatable, package-writable output
// stream. Residual: same-process instrumentation can still be defeated by malware
// that tampers below this layer — the canary "confirms but cannot clear".
const HOOK_OUT = process.argv[3];
const NONCE = process.argv[4] || '';
try { process.argv.length = 3; } catch (e) {}
const _writeFileSync = require('node:fs').writeFileSync;
// Snapshot references to global network primitives BEFORE the package loads.
// A response-rewriting clipper (the chalk/qix class) exfiltrates nothing for the
// capture proxy to see — its entire behavior is REASSIGNING global fetch /
// XMLHttpRequest / Response at import so it can tamper with requests/responses in
// place. Comparing identity after import surfaces exactly that mutation. We only
// flag a primitive that EXISTED before and had its identity replaced; a fresh
// polyfill of a missing global (old-Node node-fetch) is not tampering.
function snapshotHooks() {
  const g = globalThis;
  const R = typeof g.Response === 'function' ? g.Response.prototype : null;
  const X = typeof g.XMLHttpRequest === 'function' ? g.XMLHttpRequest.prototype : null;
  return {
    'globalThis.fetch': g.fetch,
    'Response.prototype.text': R ? R.text : undefined,
    'Response.prototype.json': R ? R.json : undefined,
    'XMLHttpRequest.prototype.open': X ? X.open : undefined,
    'XMLHttpRequest.prototype.send': X ? X.send : undefined
  };
}
function diffHooks(before) {
  const after = snapshotHooks();
  const hooked = [];
  for (const k of Object.keys(before)) {
    if (before[k] !== undefined && after[k] !== before[k]) hooked.push(k);
  }
  return hooked;
}
function report(hooked) {
  if (!HOOK_OUT) return;
  try { _writeFileSync(HOOK_OUT, JSON.stringify({ nonce: NONCE, hooked: hooked })); } catch (e) {}
}
(async () => {
  const before = snapshotHooks();
  let entry;
  try {
    entry = require.resolve(dir);
  } catch (e) {
    process.stderr.write('import-phase: cannot resolve entry (' + (e && e.message || e) + ')');
    report([]);
    return;
  }
  try {
    require(entry);
  } catch (e) {
    if (e && e.code === 'ERR_REQUIRE_ESM') {
      try { await import(pathToFileURL(entry).href); }
      catch (e2) { process.stderr.write('import-phase(esm): ' + (e2 && e2.message || e2)); }
    } else {
      process.stderr.write('import-phase: ' + (e && e.message || e));
    }
  } finally {
    try { report(diffHooks(before)); } catch (e) { /* instrumentation must never break the run */ }
  }
})();
`;

// The import probe writes its observed global-network-primitive reassignments to
// a nonce-stamped result FILE (not shared stdout, which the untrusted package can
// flood past the output cap or forge a suppressing marker on). runImportPhase
// verifies the nonce and surfaces the parsed array as importPhase.runtimeHooks;
// this just reads that already-verified field.
function extractRuntimeHooks(execResult) {
  const ip = execResult && execResult.importPhase;
  if (!ip || !Array.isArray(ip.runtimeHooks)) return [];
  return ip.runtimeHooks.filter((x) => typeof x === "string");
}

// The import-phase runner: load the package's entry point inside the SAME
// sandbox (decoy HOME, capture proxy, OS wrapper, rlimits, process-group kill)
// so import-time behavior is observed too — not just install scripts. The probe
// script is written into the sandbox root (writable, and never the package dir,
// so the staged tree stays pristine) and run with the same node that runs
// pkgxray. Skips cleanly when the staged package has no resolvable entry.
async function runImportPhase({ pkgDir, env, timeoutMs, wrapper, rlimits, sandboxRoot }) {
  try {
    await fsp.access(path.join(pkgDir, "package.json"));
  } catch {
    return { attempted: false, note: "no package.json in staged package" };
  }
  const probeDir = sandboxRoot || path.dirname(pkgDir);
  const tag = crypto.randomBytes(4).toString("hex");
  const probePath = path.join(probeDir, `import-probe-${tag}.js`);
  // Nonce-stamped result file: the probe writes its observed global-primitive
  // reassignments here instead of to stdout, so a chatty or hostile package can
  // neither push the signal past execWithTimeout's output cap nor forge a
  // suppressing marker on the shared stream. The nonce is passed on argv (which
  // the probe strips before loading the package) and authenticates the file the
  // parent reads back, so a blind write to a guessed path is rejected.
  const hookOutPath = path.join(probeDir, `import-hooks-${tag}.json`);
  const nonce = crypto.randomBytes(16).toString("hex");
  try {
    await fsp.writeFile(probePath, IMPORT_PROBE_SOURCE, { mode: 0o600 });
  } catch (error) {
    return { attempted: false, note: `could not write import probe: ${error.message}` };
  }
  // Invoke node directly (not via a shell string) so a package path containing
  // shell metacharacters can't break the command; execWithTimeout still wraps
  // it in the OS sandbox and applies the process-group timeout kill.
  const nodeBin = process.execPath;
  const command =
    `${shellQuote(nodeBin)} ${shellQuote(probePath)} ${shellQuote(pkgDir)} ` +
    `${shellQuote(hookOutPath)} ${shellQuote(nonce)}`;
  const outcome = await execWithTimeout(command, { cwd: pkgDir, env, timeoutMs, wrapper, rlimits });
  let runtimeHooks = [];
  try {
    const parsed = JSON.parse(await fsp.readFile(hookOutPath, "utf8"));
    if (parsed && parsed.nonce === nonce && Array.isArray(parsed.hooked)) {
      runtimeHooks = parsed.hooked.filter((x) => typeof x === "string");
    }
  } catch { /* no result file / unreadable / nonce mismatch → nothing observed */ }
  await fsp.rm(probePath, { force: true }).catch(() => {});
  await fsp.rm(hookOutPath, { force: true }).catch(() => {});
  return { attempted: true, entryDir: pkgDir, runtimeHooks, ...outcome };
}

// Single-quote a token for safe interpolation into an `sh -c` command. Wraps in
// single quotes and escapes any embedded single quote the POSIX way ('\'').
function shellQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

// The default (real) runner: detonate BOTH phases in the same sandbox —
// install-time lifecycle scripts, then the import of the package entry point.
// Import runs even if a lifecycle script failed, so a package that is benign at
// install but malicious on first require is still observed.
async function runInstallAndImport(ctx) {
  const install = await runLifecycleScripts(ctx);
  let importPhase = { attempted: false, note: "import phase disabled" };
  if (ctx.importPhase !== false) {
    importPhase = await runImportPhase(ctx);
  }
  return { ran: install.ran || [], note: install.note, importPhase };
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
  // maxProcs (ulimit -u) is OFF by default. On macOS/BSD RLIMIT_NPROC is
  // per-real-UID (it counts ALL the operator's processes, not just the sandbox
  // subtree), so a low cap on a busy workstation can starve the PAYLOAD's own
  // shell — no fork → no execution → a false "not-observed" that suppresses the
  // very detection this sandbox exists for. dash also rejects `-u` entirely.
  // The wall-clock timeout + process-group SIGKILL already bound a fork bomb in
  // TIME, so the backstop isn't worth the false-negative risk. Opt in explicitly
  // (rlimits:{maxProcs:N}) on a host where per-UID semantics are acceptable.
  maxProcs: null,
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
async function evaluateTripwires(canary, hits, runtimeHooks = []) {
  const findings = [];

  // 0) Import-phase tampering of a global network primitive — the response-
  // rewriting clipper shape (chalk/qix). Nothing leaves the box, so the egress
  // tripwires below stay silent; the observed tell is that IMPORTING the package
  // reassigned global.fetch / XMLHttpRequest / Response in place, so it can
  // rewrite request or response bodies (swap a wallet address, inject a payload)
  // on every call the host later makes. Static analysis can't distinguish this
  // from legitimate middleware; behavioral execution can — it watched it happen.
  if (Array.isArray(runtimeHooks) && runtimeHooks.length > 0) {
    findings.push({
      severity: "high",
      category: "behavioral-runtime-hook",
      file: "CANARY_SANDBOX",
      snippet: runtimeHooks.join(", "),
      rationale:
        `Importing the package reassigned global network primitive(s) in place: ${runtimeHooks.join(", ")}. ` +
        "Monkeypatching fetch / XMLHttpRequest / Response at import is the runtime-tampering (crypto-clipper / response-rewriter) shape — it alters requests or responses without exfiltrating a token, so it leaves no egress for the capture proxy to catch. Observed during sandboxed import, not statically inferred."
    });
  }

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
          `Sandboxed execution (install + import) READ the decoy ${decoy} and transmitted its honeytoken to ${hit.host} (${hit.transport}). This is an observed credential-exfil, not a static inference.`
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
        `Sandboxed execution (install + import) contacted ${hit.host} (${hit.transport}) — a known callback/exfil destination or a raw IP. Legitimate install/import does not phone these.`
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
        `Sandboxed execution (install + import) made outbound network requests to: ${hostList.join(", ")}. Review whether this package should reach the network at install or import.`
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
        `Sandboxed execution (install + import) accessed decoy credential file(s): ${readDecoys.join(", ")} (access-time tripwire; corroborating, since atime can be unreliable). Combined with any egress above this is a credential-harvest shape.`
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
  let wrapperInfo = detectSandboxWrapper(root);
  // Upgrade shared-net bwrap to netns confinement when this host can prove it
  // (bwrap + ip + a passing self-test). The forwarder must outlive the payload
  // long enough for the parent's egress-grace read, so it is built with the
  // run's grace window. Opt out with importPhase-style options.netnsConfinement:false.
  const graceMs = Number.isFinite(options.egressGraceMs) && options.egressGraceMs >= 0
    ? options.egressGraceMs
    : DEFAULT_EGRESS_GRACE_MS;
  let netns = null;
  if (wrapperInfo.level === "bwrap" && options.netnsConfinement !== false && !options.runner) {
    netns = await detectNetnsConfinement(root);
    if (netns) wrapperInfo = netns.build(graceMs);
  }
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
  // Under netns, the sandbox cannot reach the host TCP loopback, so the capture
  // proxy also opens a Unix socket the in-netns forwarder connects to, and the
  // payload's proxy env points at the forwarder's inner loopback port instead.
  const proxy = await startCaptureProxy(
    new Set(canary.tokens.keys()),
    netns ? { unixPath: netns.sockPath } : {}
  );

  const proxyUrl = netns ? `http://127.0.0.1:${netns.innerPort}` : `http://127.0.0.1:${proxy.port}`;
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
    const runner = options.runner || runInstallAndImport;
    execResult = await runner({
      pkgDir,
      env,
      timeoutMs,
      wrapper: wrapperInfo.wrap,
      home,
      proxyPort: proxy.port,
      rlimits: options.rlimits,
      sandboxRoot: root,
      importPhase: options.importPhase
    });
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

  const findings = await evaluateTripwires(canary, proxy.hits, extractRuntimeHooks(execResult));

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

  return {
    schemaVersion: 2,
    runId,
    isolation: wrapperInfo.level,
    isolationRequired: options.requireSandbox === true,
    netConfined: wrapperInfo.netConfined === true,
    // Honest about OUTCOME, not just intent: the ulimit caps are injected only by
    // the default lifecycle runner (`execWithTimeout`). A custom `options.runner`
    // (the injectable seam) spawns the child itself and applies none, so we
    // don't claim caps were installed then. Even when true, the caps are
    // best-effort (a shell may silently reject an unsupported `ulimit`).
    resourceLimited: !options.runner && options.rlimits !== false && process.platform !== "win32",
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
      `${wrapperInfo.netConfined !== true ? "raw-socket/dgram/non-proxied egress can still leave (net shared to keep the proxy reachable)" : "non-loopback egress is denied at the OS boundary (raw-socket egress blocked, not just unobserved)"}; ` +
      `process isolation level: ${wrapperInfo.level}. Absence of a finding is not evidence of safety.`
  };
}

module.exports = {
  runCanarySandbox,
  seedCanaryFilesystem,
  startCaptureProxy,
  createCaptureServer,
  evaluateTripwires,
  extractRuntimeHooks,
  matchTokens,
  tokenVariants,
  detectSandboxWrapper,
  makeRunId,
  DECOY_SPECS,
  // exported for tests: the two phase runners + their composition
  runLifecycleScripts,
  runImportPhase,
  runInstallAndImport,
  // exported for tests: netns confinement — forwarder, bootstrap, detection
  startTcpToUnixForwarder,
  buildNetnsBootstrap,
  detectNetnsConfinement,
  bwrapBaseArgs,
  // exported for tests: process-group kill + timeout runner + resource caps
  killProcessGroup,
  execWithTimeout,
  buildRlimitPrefix
};

// CLI entrypoints invoked from inside the sandbox: `node <this file> __forwarder …`.
// Guarded so require() of the module never triggers them.
if (require.main === module) {
  const [, , mode, ...rest] = process.argv;
  if (mode === "__forwarder") {
    forwarderMain(rest);
  } else {
    process.stderr.write("src/sandbox.js is an internal module; no directly runnable command.\n");
    process.exit(2);
  }
}
