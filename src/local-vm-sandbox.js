"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { performance } = require("node:perf_hooks");

const SCENARIO = "npm-vm-v1";
const MAX_ARTIFACT = 64 * 1024 * 1024;
const ASSETS = ["kernel", "initrd", "root.ext4"];
const SOURCES = ["services/local-vm/Dockerfile", "services/local-vm/vm-init", "services/local-vm/guest.mjs",
  "services/resolver-worker/container/runner.mjs", "services/resolver-worker/container/vm-probes.mjs"];
const CACHE = path.join(os.homedir(), ".cache", "pkgxray", "vm");
const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

async function fileDigest(file) {
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024 * 1024) throw new Error("Invalid VM asset");
    const hash = crypto.createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest("hex");
  } finally { await handle.close(); }
}

async function sourceDigest() {
  const hash = crypto.createHash("sha256");
  for (const source of SOURCES) hash.update(source).update(await fsp.readFile(path.join(__dirname, "..", source)));
  return hash.digest("hex");
}

function qemuCommand(directory, input, platform = process.platform, arch = process.arch) {
  const accelerator = { darwin: "hvf", linux: "kvm", win32: "whpx" }[platform];
  if (!accelerator || !["arm64", "x64"].includes(arch)) throw new Error("VM backend requires macOS, Linux or Windows on ARM64/x64");
  // Never fall back to TCG: QEMU excludes software emulation from its supported
  // security boundary. No config files, NICs, shared folders or management ports.
  const args = ["-no-user-config", "-nodefaults", "-display", "none", "-monitor", "none", "-nic", "none",
    "-accel", accelerator, "-machine", arch === "arm64" ? "virt" : "q35",
    "-cpu", accelerator === "whpx" ? "max" : "host", "-m", "512M", "-smp", "1", "-no-reboot",
    "-kernel", path.join(directory, "kernel"), "-initrd", path.join(directory, "initrd"),
    "-append", `console=${arch === "arm64" ? "ttyAMA0" : "ttyS0"} root=/dev/vda ro rootwait init=/opt/pkgxray/vm-init quiet loglevel=3 panic=1`,
    "-chardev", "stdio,id=console,signal=off", "-serial", "chardev:console", "-device", "virtio-rng-pci"];
  for (const [id, filename] of [["root", path.join(directory, "root.ext4")], ["input", input]]) {
    args.push("-blockdev", JSON.stringify({ driver: "raw", "node-name": id, "read-only": true,
      file: { driver: "file", filename } }), "-device", `virtio-blk-pci,drive=${id}`);
  }
  return { command: `qemu-system-${arch === "arm64" ? "aarch64" : "x86_64"}${platform === "win32" ? ".exe" : ""}`, args, accelerator };
}

function parseResult(stdout, nonce, artifactSha256, profile) {
  const frames = stdout.split(/\r?\n/).filter(line => line.startsWith("PKGXRAY_VM_RESULT "));
  const ready = stdout.split(/\r?\n/).filter(line => line === `PKGXRAY_VM_READY ${nonce}`);
  if (frames.length !== 1 || ready.length !== 1) throw new Error("VM did not return one complete result");
  const result = JSON.parse(frames[0].slice("PKGXRAY_VM_RESULT ".length));
  const b = result.behavioral;
  const phase = value => value && value.attempted === true && Number.isInteger(value.exitCode) &&
    typeof value.timedOut === "boolean" && Number.isFinite(value.durationMs) && value.durationMs >= 0;
  if (result.schemaVersion !== 1 || result.nonce !== nonce || result.digest !== artifactSha256 || result.profile !== profile ||
      !Number.isFinite(result.scenarioMs) || result.scenarioMs < 0 || result.scenarioMs > 65_000 ||
      !["block", "review", "not-observed"].includes(b?.verdict) || !Array.isArray(b.findings) || b.findings.length > 512 ||
      b.findings.some(f => !f || !["info", "low", "medium", "high"].includes(f.severity) || typeof f.category !== "string") ||
      !Array.isArray(b.executed?.ran) || b.executed.ran.length > 3 ||
      b.executed.ran.some(value => !phase(value) || !["preinstall", "install", "postinstall"].includes(value.hook)) ||
      new Set(b.executed.ran.map(value => value.hook)).size !== b.executed.ran.length || !phase(b.executed.importPhase) ||
      typeof b.monitoring?.syscallTrace !== "boolean" || typeof b.monitoring?.truncated !== "boolean") {
    throw new Error("VM returned invalid or unbound evidence");
  }
  if (b.verdict === "not-observed" && (b.findings.length || !b.monitoring.syscallTrace || b.monitoring.truncated ||
      [...b.executed.ran, b.executed.importPhase].some(value => value.exitCode !== 0 || value.timedOut))) {
    throw new Error("VM returned a contradictory verdict for incomplete evidence");
  }
  return result;
}

async function inputDisk(source, destination, expected, profile, nonce) {
  if ((await fsp.lstat(source)).isSymbolicLink()) throw new Error("VM input must not be a symlink");
  const handle = await fsp.open(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ARTIFACT) throw new Error("VM requires a bounded regular npm archive");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error("Artifact changed while copying");
      offset += read.bytesRead;
    }
    if (digest(bytes) !== expected) throw new Error("VM artifact differs from the scanned SHA-256");
    const header = Buffer.alloc(4096);
    header.write(JSON.stringify({ magic: "pkgxray-vm-v1", digest: expected, bytes: bytes.length, profile, nonce }));
    await fsp.writeFile(destination, Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]), { mode: 0o400, flag: "wx" });
  } finally { await handle.close(); }
}

function executeVm(command, args, directory, nonce, timeoutMs, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let stdout = "", stderr = "", bytes = 0, readyMs = null, failure;
    // No cloud tokens, proxy settings, NODE_OPTIONS, DYLD or host-home settings.
    const env = { PATH: process.env.PATH, HOME: directory, TMPDIR: directory, LANG: "C.UTF-8" };
    if (process.platform === "win32") { env.SystemRoot = process.env.SystemRoot; env.TEMP = directory; }
    const child = spawnImpl(command, args, { stdio: ["ignore", "pipe", "pipe"], env, windowsHide: true });
    const stop = error => { failure ||= error; child.kill("SIGKILL"); };
    const timer = setTimeout(() => stop(new Error("VM exceeded its deadline")), timeoutMs);
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) return stop(new Error("VM output exceeded its limit"));
      stdout += chunk.toString("utf8");
      if (readyMs === null && stdout.includes(`PKGXRAY_VM_READY ${nonce}`)) readyMs = performance.now() - started;
    });
    child.stderr.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) return stop(new Error("VM output exceeded its limit"));
      stderr += chunk.toString("utf8");
    });
    child.once("error", error => { failure = error; });
    child.once("close", code => {
      clearTimeout(timer);
      if (failure || code !== 0) reject(failure || new Error(`VM failed: ${stderr.slice(0, 500) || "abnormal shutdown"}`));
      else resolve({ stdout, readyMs, elapsedMs: performance.now() - started });
    });
  });
}

async function runLocalVm(options) {
  if (options.allowExecution !== true) throw new Error("VM execution requires operator authorization");
  for (const field of ["artifactSha256", "scannerBuildId", "policySha256"]) if (!hex(options[field])) throw new Error(`Invalid ${field}`);
  if (options.scenarioVersion && options.scenarioVersion !== SCENARIO) throw new Error("Unsupported VM scenario");
  const profile = options.profile || "developer";
  if (!["developer", "ci"].includes(profile) || options.keepSandbox || options.tlsMitm) throw new Error("Unsupported VM configuration");
  const started = performance.now();
  const assets = options.assetDirectory || CACHE;
  const manifest = JSON.parse(await fsp.readFile(path.join(assets, "manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.scenario !== SCENARIO || manifest.arch !== process.arch ||
      manifest.sourceSha256 !== await sourceDigest()) throw new Error("Rebuild VM assets for the current pkgxray version and architecture");
  const lock = path.join(assets, "active.lock");
  const owner = await fsp.open(lock, "wx", 0o600).catch(() => { throw new Error("VM runner is busy (or a stale active.lock needs operator cleanup)"); });
  let directory;
  let output;
  try {
    for (const asset of ASSETS) {
      if (!hex(manifest.files?.[asset]) || await fileDigest(path.join(assets, asset)) !== manifest.files[asset]) throw new Error("VM asset integrity verification failed");
    }
    directory = await fsp.mkdtemp(path.join(assets, "run-"));
    const nonce = crypto.randomBytes(16).toString("hex");
    const input = path.join(directory, "input.raw");
    await inputDisk(options.archivePath, input, options.artifactSha256, profile, nonce);
    const launch = qemuCommand(assets, input);
    const preparationMs = performance.now() - started;
    const result = await executeVm(launch.command, launch.args, directory, nonce,
      Math.min(Math.max(Number(options.timeoutMs) || 90_000, 1000), 90_000));
    const parsed = parseResult(result.stdout, nonce, options.artifactSha256, profile);
    output = { ...parsed.behavioral, isolation: "local-vm", netConfined: true, resourceLimited: true,
      vmEvidence: { artifactSha256: options.artifactSha256, scannerBuildId: options.scannerBuildId,
        policySha256: options.policySha256, scenarioVersion: SCENARIO, imageManifestSha256: digest(JSON.stringify(manifest)),
        accelerator: launch.accelerator, profile, guestMemoryMiB: 512, guestCpus: 1 },
      timings: { preparationMs: Math.round(preparationMs), bootMs: Math.round(result.readyMs), scenarioMs: parsed.scenarioMs,
        shutdownMs: Math.max(0, Math.round(result.elapsedMs - result.readyMs - parsed.scenarioMs)) } };
  } finally {
    const cleanupStarted = performance.now();
    try { if (directory) await fsp.rm(directory, { recursive: true, force: true }); }
    finally { await owner.close(); await fsp.unlink(lock); }
    if (output) { output.timings.cleanupMs = Math.round(performance.now() - cleanupStarted); output.timings.totalMs = Math.round(performance.now() - started); }
  }
  return output;
}

const createLocalVmRunner = (options = {}) => run => runLocalVm({ ...options, ...run });
module.exports = { CACHE, ASSETS, SCENARIO, sourceDigest, fileDigest, qemuCommand, parseResult, inputDisk, executeVm, runLocalVm, createLocalVmRunner };
