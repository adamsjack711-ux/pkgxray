"use strict";

// Release verification permits exactly one deliberate omission: source scanning
// of the scanner itself. Advisory outages, other review reasons and changed
// archive bytes are failures, not warnings or generic REVIEW exceptions.
function verifyReleaseScan(scan, expectedSha256) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 || "")) throw new Error("Expected release SHA-256 is required");
  if (scan.resolved?.sha256 !== expectedSha256) throw new Error("Release archive digest mismatch");
  const check = scan.vulnerabilityPrecheck;
  if (scan.assessment?.checks?.vulnerabilities !== "completed" || check?.enabled !== true ||
      check.completed !== true || check.error || check.vulnerabilityCount !== 0 ||
      !Array.isArray(check.vulnerabilities) || check.vulnerabilities.length) {
    throw new Error("Release requires a completed, clean OSV check");
  }
  if (scan.assessment?.checks?.source !== "disabled" || !scan.report || !Array.isArray(scan.report.findings) ||
      !["allow", "review"].includes(scan.decision) || scan.report.verdict === "block" ||
      scan.report.findings.some(f => f.category !== "incomplete-source-scan" && ["high", "medium"].includes(f.severity)) ||
      scan.assessment.authorization?.explicitOverride === true) {
    throw new Error("Unexpected release review/block or check configuration");
  }
  return { verified: true, sha256: expectedSha256, vulnerabilities: "completed", source: "intentionally-disabled" };
}

async function main() {
  const [mode, target, expectedArgument] = process.argv.slice(2);
  if (!["archive", "published"].includes(mode) || !target) throw new Error("Usage: verify-release.js archive <file.tgz> | published <sha256>");
  const { guardExtension } = require("../src/quarantine");
  const { DEFAULTS } = require("../src/config");
  const { name, version } = require("../package.json");
  let expected = mode === "published" ? target : expectedArgument;
  let artifact;
  if (mode === "archive") {
    const fs = require("node:fs");
    const crypto = require("node:crypto");
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
    expected = hash.digest("hex");
    artifact = { archivePath: target, integrity: `sha256-${Buffer.from(expected, "hex").toString("base64")}` };
  }
  const scan = await guardExtension(`npm:${name}@${version}`, {
    config: DEFAULTS, artifact, sourceScan: false, vulnerabilityCheck: true,
    githubMetadata: false, githubDiff: false, provenance: false, keepStaging: false
  });
  process.stdout.write(`${JSON.stringify(verifyReleaseScan(scan, expected), null, 2)}\n`);
}
if (require.main === module) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { verifyReleaseScan };
