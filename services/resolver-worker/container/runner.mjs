import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const WORK = "/work";
const PACKAGE = `${WORK}/package`;
const TRACES = `${WORK}/traces`;
const HOME = "/home/pkgxray";
const PHASE_TIMEOUT_SECONDS = 12;
const MAX_PHASE_OUTPUT_BYTES = 128 * 1024;
const MAX_TRACE_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 20_000;
const MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const INSTALL_HOOKS = ["preinstall", "install", "postinstall"];
const PACKAGE_USER = "pkgxray";
const PACKAGE_UID = "10001";
const PACKAGE_GID = "10001";

function argsOf(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 2) out[argv[i]] = argv[i + 1];
  return out;
}

async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function safeArchiveEntry(entry) {
  const clean = String(entry || "").replace(/\/$/, "");
  if (!clean || clean.startsWith("/") || clean.includes("\0") || clean.includes("\\") || /[\x00-\x1f\x7f]/.test(clean)) return false;
  const parts = clean.split("/");
  return !parts.includes("..") && !parts.includes("");
}

export function parseTarListingLine(line) {
  // The image is Debian and therefore uses GNU tar. With LC_ALL=C and
  // --full-time, the first five fields are mode, owner/group, size, date and
  // time; the remaining bytes are the quoted archive path.
  const match = String(line).match(/^([^\s]+)\s+[^\s]+\s+(\d+)\s+[^\s]+\s+[^\s]+\s+(.+)$/);
  if (!match) return null;
  const size = Number(match[2]);
  if (!Number.isSafeInteger(size) || size < 0) return null;
  return { type: match[1][0], size, path: match[3] };
}

export function validateTarListing(lines, limits = {}) {
  const maxEntries = limits.maxEntries || MAX_ARCHIVE_ENTRIES;
  const maxBytes = limits.maxBytes || MAX_UNCOMPRESSED_BYTES;
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > maxEntries) {
    throw new Error("Artifact archive entry count is outside the allowed range");
  }
  let totalBytes = 0;
  for (const line of lines) {
    const entry = parseTarListingLine(line);
    if (!entry || !["-", "d"].includes(entry.type) || !safeArchiveEntry(entry.path)) {
      throw new Error("Artifact archive contains an unsafe path, link, or special file");
    }
    totalBytes += entry.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes) {
      throw new Error("Artifact uncompressed size exceeds its limit");
    }
  }
  return { entries: lines.length, uncompressedBytes: totalBytes };
}

function conditionalExportTarget(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const target = conditionalExportTarget(candidate);
      if (target) return target;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [condition, candidate] of Object.entries(value)) {
    // Mirror the conditions active for a normal dynamic import in Node. Object
    // order matters for conditional exports, so take the first matching branch.
    if (!["node", "node-addons", "import", "default"].includes(condition)) continue;
    const target = conditionalExportTarget(candidate);
    if (target) return target;
  }
  return null;
}

export function runtimeEntryOf(pkg) {
  if (pkg?.exports !== undefined) {
    const rootExport = pkg.exports && typeof pkg.exports === "object" && !Array.isArray(pkg.exports) &&
      Object.keys(pkg.exports).some(key => key.startsWith("."))
      ? pkg.exports["."]
      : pkg.exports;
    const target = conditionalExportTarget(rootExport);
    if (!target) throw new Error("Package has no probeable root export");
    return target;
  }
  return typeof pkg?.main === "string" && pkg.main ? pkg.main : "index.js";
}

async function validateExtractedTree() {
  const pending = [PACKAGE];
  let entries = 0;
  let totalBytes = 0;
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    for (const entry of await fsp.readdir(pending[cursor], { withFileTypes: true })) {
      entries += 1;
      if (entries > MAX_ARCHIVE_ENTRIES || !safeArchiveEntry(entry.name)) {
        throw new Error("Extracted artifact entry count or path is unsafe");
      }
      const full = path.join(pending[cursor], entry.name);
      const stat = await fsp.lstat(full);
      if (stat.isDirectory()) pending.push(full);
      else if (!stat.isFile() || stat.nlink !== 1) {
        throw new Error("Extracted artifact contains a link or special file");
      } else {
        totalBytes += stat.size;
        if (totalBytes > MAX_UNCOMPRESSED_BYTES) throw new Error("Extracted artifact exceeds its size limit");
      }
    }
  }
}

async function inspectAndExtract(artifact) {
  const listing = spawnSync("tar", [
    "--list", "--verbose", "--gzip", "--file", artifact,
    "--full-time", "--numeric-owner", "--quoting-style=escape"
  ], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" }
  });
  if (listing.status !== 0) throw new Error("Artifact is not a readable gzip tar archive");
  const entries = listing.stdout.split("\n").filter(Boolean);
  validateTarListing(entries);
  fs.mkdirSync(PACKAGE, { recursive: true, mode: 0o700 });
  const extracted = spawnSync("tar", [
    "--extract", "--gzip", "--file", artifact,
    "--directory", PACKAGE,
    "--strip-components=1",
    "--no-same-owner",
    "--no-same-permissions"
  ], { encoding: "utf8", maxBuffer: MAX_PHASE_OUTPUT_BYTES });
  if (extracted.status !== 0) throw new Error("Artifact extraction failed");
  await validateExtractedTree();
}

function randomSecret(length = 48) {
  return crypto.randomBytes(length).toString("base64url").slice(0, length);
}

async function seedCanaries() {
  const records = [
    [".npmrc", token => `//registry.npmjs.org/:_authToken=npm_${token}\n`],
    [".aws/credentials", token => `[default]\naws_access_key_id=AKIA${token.slice(0, 16).toUpperCase()}\naws_secret_access_key=${token}\n`],
    [".ssh/id_rsa", token => `-----BEGIN OPENSSH PRIVATE KEY-----\n${token}\n-----END OPENSSH PRIVATE KEY-----\n`],
    [".env", token => `SECRET_TOKEN=${token}\n`],
    [".config/claude/mcp.json", token => JSON.stringify({ mcpServers: { github: { env: { GITHUB_TOKEN: `ghp_${token}` } } } })]
  ];
  const canaries = [];
  await fsp.mkdir(HOME, { recursive: true, mode: 0o700 });
  for (const [relative, render] of records) {
    const token = randomSecret();
    const absolute = path.join(HOME, relative);
    await fsp.mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
    await fsp.writeFile(absolute, render(token), { mode: 0o600 });
    canaries.push({ relative, absolute });
  }
  return canaries;
}

function phaseEnvironment() {
  return {
    PATH: `${PACKAGE}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin`,
    HOME,
    USER: "pkgxray",
    LOGNAME: "pkgxray",
    CI: "1",
    NODE_ENV: "production",
    npm_config_cache: `${HOME}/.npm-cache`,
    npm_config_userconfig: `${HOME}/.npmrc`,
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false"
  };
}

function runPhase(name, command, vmEnv) {
  const tracePrefix = `${TRACES}/${name}`;
  const startedAt = Date.now();
  const result = spawnSync("/usr/bin/timeout", [
    "--signal=TERM",
    "--kill-after=1s",
    `${PHASE_TIMEOUT_SECONDS}s`,
    "/usr/bin/prlimit", "--fsize=8388608:8388608", "--core=0:0", "--",
    "strace",
    "-ff",
    "-qq",
    "-s", "512",
    ...(vmEnv ? ["-yy"] : []),
    "-e", vmEnv ? "trace=%file,%network,%process" : "trace=%file,%network",
    "-o", tracePrefix,
    "/usr/sbin/runuser", "--user", PACKAGE_USER, "--preserve-environment", "--",
    "/usr/bin/prlimit", "--nproc=64:64", "--nofile=128:128",
    "--fsize=8388608:8388608", "--core=0:0", "--cpu=12:12", "--",
    ...(vmEnv ? ["/usr/bin/setpriv", "--no-new-privs", "--"] : []),
    ...command
  ], {
    cwd: PACKAGE,
    env: vmEnv ? { ...phaseEnvironment(), CI: "", ...vmEnv } : phaseEnvironment(),
    encoding: "utf8",
    maxBuffer: MAX_PHASE_OUTPUT_BYTES,
    timeout: (PHASE_TIMEOUT_SECONDS + 3) * 1000,
    killSignal: "SIGKILL"
  });
  const exitCode = Number.isInteger(result.status) ? result.status : 137;
  return {
    hook: name,
    attempted: true,
    exitCode,
    timedOut: exitCode === 124 || exitCode === 137 || result.signal === "SIGKILL",
    durationMs: Date.now() - startedAt,
    stdoutBytes: Buffer.byteLength(result.stdout || ""),
    stderrBytes: Buffer.byteLength(result.stderr || ""),
    monitorStarted: !result.error || result.error.code !== "ENOENT"
  };
}

function setPackageOwnership() {
  const owned = spawnSync("chown", ["-R", `${PACKAGE_UID}:${PACKAGE_GID}`, PACKAGE, HOME], {
    encoding: "utf8",
    maxBuffer: MAX_PHASE_OUTPUT_BYTES
  });
  if (owned.status !== 0) throw new Error("Could not prepare the unprivileged package workspace");
}

async function traceText() {
  const names = await fsp.readdir(TRACES).catch(() => []);
  const allTraceFiles = names.filter(name => !name.startsWith(".") && name !== "dns.jsonl");
  const traceFiles = allTraceFiles.slice(0, 500);
  const chunks = [];
  let total = 0;
  let truncated = allTraceFiles.length > traceFiles.length;
  for (const name of traceFiles) {
    const full = path.join(TRACES, name);
    const stat = await fsp.lstat(full).catch(() => null);
    if (!stat?.isFile()) continue;
    if (total + stat.size > MAX_TRACE_BYTES) {
      truncated = true;
      break;
    }
    chunks.push(await fsp.readFile(full, "utf8"));
    total += stat.size;
  }
  return { text: chunks.join("\n"), files: traceFiles.length, bytes: total, truncated };
}

export function executionFindings(phases) {
  return phases.filter(phase => !phase.monitorStarted || phase.exitCode !== 0 || phase.timedOut).map(phase => ({
    severity: "medium",
    category: "behavioral-execution-incomplete",
    target: phase.hook,
    evidence: "A scenario phase failed, was interrupted, or exceeded a limit; its behavior was not fully observed."
  }));
}

export function analyzeTrace(trace, canaries) {
  const findings = [];
  const keys = new Set();
  const lines = trace.text.split("\n");
  const add = finding => {
    const key = `${finding.category}:${finding.target || ""}`;
    if (!keys.has(key)) {
      keys.add(key);
      findings.push(finding);
    }
  };
  for (const canary of canaries) {
    if (lines.some(line => line.includes(canary.absolute) && !/= -1 (?:ENOENT|EACCES)/.test(line))) {
      add({ severity: "high", category: "credential-access", target: canary.relative,
        evidence: "sandbox syscall monitor observed access to a decoy credential" });
    }
  }
  for (const line of lines) {
    if (/\b(?:connect|sendto|sendmsg|sendmmsg)\(/.test(line) && /AF_INET6?/.test(line)) {
      const address = line.match(/inet_addr\("([^"\n]+)"\)/)?.[1] ||
        line.match(/inet_pton\(AF_INET6, "([^"\n]+)"/)?.[1];
      if (address && (/^127\./.test(address) || address === "::1" || address === "0.0.0.0" || address === "::")) continue;
      const target = address || "external-address";
      add({ severity: "medium", category: "network-attempt", target,
        evidence: "sandbox syscall monitor observed an external network attempt" });
    }
    if (/openat\(|open\(/.test(line) && /O_(?:WRONLY|RDWR|CREAT|TRUNC)/.test(line)) {
      const target = line.match(/"([^"]+)"/)?.[1];
      const escapedRelative = target === ".." || target?.startsWith("../") || target?.includes("/../");
      const unexpectedAbsolute = target?.startsWith("/") &&
        ![PACKAGE, TRACES, HOME, "/tmp", "/dev", "/proc"].some(root => target === root || target.startsWith(`${root}/`));
      if (target && (escapedRelative || unexpectedAbsolute)) {
        add({ severity: "medium", category: "filesystem-write", target,
          evidence: "sandbox syscall monitor observed a write outside the package workspace" });
      }
    }
  }
  return findings;
}

async function main() {
  const args = argsOf(process.argv);
  const vm = args["--scenario"] === "npm-vm-v1";
  if (!vm && args["--scenario"] !== "npm-install-v2") throw new Error("Unsupported scenario");
  if (vm && !["developer", "ci"].includes(args["--profile"])) throw new Error("Unsupported VM profile");
  const probes = vm ? await import("./vm-probes.mjs") : null;
  if (!/^[a-f0-9]{64}$/.test(args["--expected-sha256"] || "")) throw new Error("Invalid expected digest");
  if (await sha256File(args["--artifact"]) !== args["--expected-sha256"]) throw new Error("Artifact digest mismatch");

  await inspectAndExtract(args["--artifact"]);
  const manifestBytes = await fsp.readFile(`${PACKAGE}/package.json`);
  if (manifestBytes.byteLength > 1024 * 1024) throw new Error("Package manifest exceeds size limit");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const scripts = manifest.scripts && typeof manifest.scripts === "object" ? manifest.scripts : {};
  await fsp.mkdir(TRACES, { recursive: true, mode: 0o700 });
  const canaries = vm ? probes.seedVmCanaries() : await seedCanaries();
  setPackageOwnership();
  const vmEnv = vm ? probes.vmEnvironment(args["--profile"]) : null;
  const dns = vm ? await probes.startDnsHoneypot() : null;

  const ran = [];
  for (const hook of INSTALL_HOOKS) {
    if (typeof scripts[hook] !== "string" || !scripts[hook].trim()) continue;
    ran.push(runPhase(hook, ["/bin/sh", "-c", scripts[hook]], vmEnv));
  }

  const importRunner = `${WORK}/import-runner.mjs`;
  await fsp.writeFile(importRunner, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    "import { createRequire } from 'node:module';",
    `const root = ${JSON.stringify(PACKAGE)};`,
    "const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));",
    `const runtimeEntryOf = ${runtimeEntryOf.toString()};`,
    `const conditionalExportTarget = ${conditionalExportTarget.toString()};`,
    "const entry = path.resolve(root, runtimeEntryOf(pkg));",
    "if (!entry.startsWith(root + path.sep)) throw new Error('entry point escapes package');",
    "if (pkg.type === 'module' || /\\.mjs$/i.test(entry)) await import(pathToFileURL(entry).href);",
    "else createRequire(import.meta.url)(entry);"
  ].join("\n"), { mode: 0o555 });
  // The package owns node_modules/.bin, which is deliberately on lifecycle
  // scripts' PATH. Never let it replace the trusted runtime for our import probe.
  const importPhase = runPhase("import", [process.execPath, importRunner], vmEnv);

  if (dns) {
    dns.kill("SIGTERM");
    await new Promise(resolve => dns.once("exit", resolve));
  }

  const trace = await traceText();
  const vmAnalysis = vm ? probes.analyzeVmTrace(trace, canaries) : null;
  let findings = analyzeTrace(trace, vm ? [] : canaries).concat(vmAnalysis?.findings || [], executionFindings([...ran, importPhase]));
  const phaseCount = ran.length + 1;
  const monitorComplete = (!vm || vmAnalysis.dnsComplete) && [...ran, importPhase].every(outcome => outcome.monitorStarted) &&
    trace.files >= phaseCount && trace.bytes > 0 && trace.truncated !== true;
  if (!monitorComplete) findings = findings.concat({
    severity: "medium",
    category: "behavioral-monitor-unavailable",
    evidence: "syscall tracing did not cover every scenario phase"
  });
  const verdict = findings.some(finding => finding.severity === "high")
    ? "block" : findings.length ? "review" : "not-observed";

  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    behavioral: {
      verdict,
      findings,
      ...(vm ? { profile: args["--profile"], telemetry: vmAnalysis.telemetry } : {}),
      executed: { ran, importPhase },
      monitoring: { syscallTrace: monitorComplete, traceFiles: trace.files, traceBytes: trace.bytes, truncated: trace.truncated },
      limits: {
        internet: "disabled",
        phaseTimeoutSeconds: PHASE_TIMEOUT_SECONDS,
        phaseOutputBytes: MAX_PHASE_OUTPUT_BYTES,
        traceBytes: MAX_TRACE_BYTES,
        processes: 64,
        openFiles: 128,
        fileBytes: 8388608,
        coreBytes: 0,
        cpuSeconds: 12
      }
    }
  }));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${String(error?.message || error).slice(0, 300)}\n`);
    process.exitCode = 1;
  });
}
