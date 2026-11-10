#!/usr/bin/env node
"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { CACHE, ASSETS, SCENARIO, sourceDigest, fileDigest } = require("../../src/local-vm-sandbox");
const exec = promisify(execFile);

function requireLocalSocket(endpoint) {
  if (typeof endpoint !== "string" || /[\r\n\0]/.test(endpoint) ||
      !(/^unix:\/\/\//.test(endpoint) || /^npipe:\/\/\/\/\.\/pipe\/[^/]+$/.test(endpoint))) {
    throw new Error("VM setup requires a local Docker socket; remote Docker contexts are refused");
  }
  return endpoint;
}

async function buildVm() {
  if (!["arm64", "x64"].includes(process.arch)) throw new Error("VM assets support ARM64 and x64 hosts");
  await fs.mkdir(CACHE, { recursive: true, mode: 0o700 });
  const lock = await fs.open(path.join(CACHE, "active.lock"), "wx", 0o600);
  const temp = await fs.mkdtemp(path.join(CACHE, "build-"));
  const name = `pkgxray-vm-build-${crypto.randomUUID()}`;
  let created = false, pinned;
  const env = { ...process.env };
  const docker = args => exec("docker", [...(pinned || []), ...args], { env, maxBuffer: 8 * 1024 * 1024, timeout: 600_000 });
  try {
    const endpoint = !process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST ||
      JSON.parse((await docker(["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"])).stdout);
    requireLocalSocket(endpoint);
    const config = path.join(temp, "config");
    await fs.mkdir(config, { mode: 0o700 });
    await fs.writeFile(path.join(config, "config.json"), "{}\n", { mode: 0o600 });
    for (const key of ["DOCKER_HOST","DOCKER_CONTEXT","DOCKER_CONFIG","DOCKER_TLS","DOCKER_TLS_VERIFY","DOCKER_CERT_PATH"]) delete env[key];
    pinned = ["--config", config, "--host", endpoint];
    const root = path.resolve(__dirname, "../..");
    const sourceSha256 = await sourceDigest();
    const context = path.join(temp, "context");
    // Explicitly assemble a tiny build context; never send the checkout or its
    // credentials to a builder, even if its .dockerignore support differs.
    for (const relative of ["services/local-vm/Dockerfile", "services/local-vm/vm-init", "services/local-vm/guest.mjs",
      "services/resolver-worker/container/runner.mjs", "services/resolver-worker/container/vm-probes.mjs"]) {
      const target = path.join(context, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(root, relative), target);
    }
    const targetArch = process.arch === "x64" ? "amd64" : "arm64";
    process.stderr.write("Building trusted VM boot assets. No package sample is executed during setup.\n");
    const build = await docker(["build", "--platform", `linux/${targetArch}`, "--build-arg", `TARGETARCH=${targetArch}`,
      "-f", path.join(context, "services/local-vm/Dockerfile"), "-t", "pkgxray-vm-assets:local", context]);
    process.stderr.write(build.stderr.slice(-2000));
    const image = JSON.parse((await docker(["image", "inspect", "pkgxray-vm-assets:local"])).stdout)[0];
    if (!/^sha256:[a-f0-9]{64}$/.test(image?.Id || "")) throw new Error("Invalid built image identity");
    created = true;
    await docker(["create", "--name", name, "--network=none", image.Id, "/unused"]);
    const files = {};
    for (const asset of ASSETS) {
      const destination = path.join(temp, asset);
      await docker(["cp", `${name}:/${asset}`, destination]);
      await fs.chmod(destination, 0o400);
      files[asset] = await fileDigest(destination);
    }
    if (await sourceDigest() !== sourceSha256) throw new Error("VM sources changed during build; rerun setup");
    const manifest = { schemaVersion: 1, scenario: SCENARIO, arch: process.arch, sourceSha256,
      builtAt: new Date().toISOString(), builderImage: image.Id, files };
    // Publish the manifest last: any interrupted replacement fails digest checks.
    for (const asset of ASSETS) await fs.rename(path.join(temp, asset), path.join(CACHE, asset));
    await fs.writeFile(path.join(temp, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    await fs.rename(path.join(temp, "manifest.json"), path.join(CACHE, "manifest.json"));
    process.stdout.write(`VM assets built for ${process.arch}: ${CACHE}\n`);
  } finally {
    try { if (created) await docker(["rm", "--force", name]); }
    finally { await fs.rm(temp, { recursive: true, force: true }); await lock.close(); await fs.unlink(path.join(CACHE, "active.lock")); }
  }
}
if (require.main === module) buildVm().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { buildVm, requireLocalSocket };
