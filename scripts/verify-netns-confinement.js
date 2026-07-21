#!/usr/bin/env node
"use strict";

// Verify canary network-namespace confinement on THIS host.
//
// The netns tier engages only where it can be proven: bwrap + ip present, and a
// runtime self-test that stands up the real machinery and confirms BOTH
// (a) proxied egress is still captured and (b) a direct dial to a non-loopback
// IP is refused by the kernel (ENETUNREACH). This script runs that detection and
// prints the outcome, so a capable Linux host (or a CI runner with bubblewrap +
// iproute2) can confirm netConfined:true before the comparison row is flipped.
//
//   node scripts/verify-netns-confinement.js
//
// Exit 0 = netns confinement available and self-test passed.
// Exit 1 = not available here (missing bwrap/ip, non-Linux, or self-test failed) —
//          canary still runs, but on the shared-net/env-only tier (netConfined:false).

const os = require("node:os");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { detectNetnsConfinement } = require("../src/sandbox");

function has(cmd) {
  return spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;
}

async function main() {
  console.log("pkgxray — canary netns confinement check");
  console.log("=========================================");
  console.log(`platform : ${process.platform}`);
  console.log(`bwrap    : ${has("bwrap") ? "present" : "MISSING"}`);
  console.log(`ip       : ${has("ip") ? "present" : "MISSING"}`);
  console.log("");

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pkgxray-netns-verify-"));
  try {
    const netns = await detectNetnsConfinement(root);
    if (netns) {
      console.log("RESULT: netns confinement AVAILABLE — self-test passed.");
      console.log("  A fresh network namespace is stood up per run; proxied egress is");
      console.log("  captured via the in-sandbox forwarder, and direct non-loopback");
      console.log("  egress is refused by the kernel. canary reports netConfined:true,");
      console.log('  isolation "bwrap+netns".');
      process.exit(0);
    }
    console.log("RESULT: netns confinement NOT available on this host.");
    if (process.platform !== "linux") {
      console.log("  Reason: not Linux (macOS uses the sandbox-exec tier instead).");
    } else if (!has("bwrap") || !has("ip")) {
      console.log("  Reason: install bubblewrap (bwrap) and iproute2 (ip), then re-run.");
    } else {
      console.log("  Reason: prerequisites present but the self-test could not PROVE");
      console.log("  confinement (unprivileged user+net namespaces may be restricted).");
      console.log("  canary falls back to shared-net bwrap (netConfined:false) — it still");
      console.log("  observes via the capture proxy, but does not kernel-block raw egress.");
    }
    process.exit(1);
  } finally {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
