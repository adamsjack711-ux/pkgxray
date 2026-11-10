"use strict";
const fs = require("node:fs/promises");
const { guardExtension, parseReference, parseNpmSpecifier } = require("./quarantine");
const { runLocalVm, SCENARIO } = require("./local-vm-sandbox");

function exactVmReference(reference) {
  if (typeof reference !== "string" || reference.length > 320 || !reference.startsWith("npm:")) throw new Error("VM scans require npm:name@exact-version");
  const parsed = parseReference(reference);
  const identity = parsed.type === "npm" && parseNpmSpecifier(parsed.specifier);
  if (!identity || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(identity.name) ||
      !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(identity.version || "")) {
    throw new Error("VM scans require npm:name@exact-version");
  }
  return identity;
}

async function scanInVm(reference, options = {}) {
  exactVmReference(reference);
  if (options.allowExecution !== true) throw new Error("VM scanning executes untrusted code; explicit authorization is required");
  const profile = options.profile || "developer";
  if (!["developer", "ci"].includes(profile)) throw new Error("VM profile must be developer or ci");
  let staged;
  try {
    // This is evidence collection, never an install or promotion path. The MCP
    // does not expose artifact/config/provider options; those are trusted CLI
    // and test inputs only.
    staged = await (options.guard || guardExtension)(reference, {
      config: options.config, policy: "safe-only", scanErrorPolicy: "fail-closed", keepStaging: true,
      artifact: options.artifact, vulnerabilityCheck: options.vulnerabilityCheck,
      githubMetadata: options.githubMetadata, githubDiff: options.githubDiff
    });
    const behavioral = await (options.runVm || runLocalVm)({
      archivePath: `${staged.stagedPath}.tgz`, artifactSha256: staged.resolved?.sha256,
      scannerBuildId: staged.assessment?.engine?.buildId, policySha256: staged.assessment?.policySha256,
      allowExecution: true, scenarioVersion: SCENARIO, profile, timeoutMs: options.timeoutMs
    });
    return { schemaVersion: 1, reference, artifactSha256: staged.resolved.sha256,
      verdict: staged.decision === "block" || behavioral.verdict === "block" ? "block" : "review",
      installationApproved: false, staticDecision: staged.decision, staticReport: staged.report,
      behavioral, summary: "Disposable VM evidence only. A quiet run cannot establish safety or approve installation." };
  } finally {
    if (staged?.quarantinePath) await fs.rm(staged.quarantinePath, { recursive: true, force: true });
  }
}
module.exports = { exactVmReference, scanInVm };
