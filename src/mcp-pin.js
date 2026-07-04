"use strict";

// T4 — pin approved MCP manifests + drift / rug-pull recheck.
//
// The rug-pull: a server whose manifest was clean at approval time changes its
// descriptions, grows a tool, or widens a schema AFTER a human approved it.
// Pinning persists a per-tool fingerprint of the approved manifest into the
// existing `.pkgxray.lock` store (src/triage.js — same store, additive
// `manifest` field, schemaVersion stays 1); recheck re-enumerates, re-audits,
// and diffs against that baseline.
//
// Two baselines, deliberately distinct (mirroring the recheck tier's
// human-decision vs computed-verdict split):
//   - the APPROVAL baseline (`manifest` fingerprints + `decision`): rewritten
//     only by --pin, i.e. by a human re-approving what they see;
//   - the MONITORING baseline (`verdict` + `checkedAt`): refreshed by every
//     recheck, so verdict drift is measured against the last look, exactly as
//     `pkgxray recheck` does for packages (classifyDrift is reused, not
//     forked).
//
// Exit-code semantics follow RECHECK_TRIAGE.md's rule — gate on what is NEW:
// a verdict regression gates at its fresh severity (block 2 / review 3);
// manifest drift (added / removed / changed tools) gates at review 3 because
// the running manifest is no longer the one that was approved; a manifest
// that was already `review` at pin time and still is, is known state → 0.

const crypto = require("node:crypto");
const path = require("node:path");

const {
  loadDecisions,
  saveDecisions,
  isStale,
  LOCK_FILENAME
} = require("./triage");
const { classifyDrift } = require("./recheck");

// Records for MCP servers share the store with npm deps; the name prefix is
// the namespace that keeps `mcp:lodash` (a server calling itself lodash) from
// ever colliding with the lodash package record.
function mcpRecordName(serverName) {
  return `mcp:${serverName || "(unnamed)"}`;
}

// Key-order-independent stringify so a server re-emitting the same schema
// with reordered JSON keys does not read as drift.
function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function toolFingerprint(tool) {
  return crypto
    .createHash("sha256")
    .update(
      stableStringify({
        name: tool.name,
        title: tool.title || null,
        description: tool.description || "",
        inputSchema: tool.inputSchema || null
      })
    )
    .digest("hex");
}

function manifestFingerprints(manifest) {
  return {
    tools: manifest.tools
      .map((tool) => ({ name: tool.name, sha256: toolFingerprint(tool) }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  };
}

function defaultLockPath(cwd) {
  return path.join(cwd || process.cwd(), LOCK_FILENAME);
}

// Find this server's record regardless of pinned version — a rug-pull very
// often arrives as a version bump, and losing the baseline to it would defeat
// the check. Multiple versions of the same server collapse to the newest pin.
function findServerRecord(decisions, name) {
  let found = null;
  for (const record of decisions.values()) {
    if (record.name !== name) continue;
    if (!found || String(found.decided_at) < String(record.decided_at)) found = record;
  }
  return found;
}

// Pin the manifest a human just reviewed: the approval baseline. Replaces any
// prior record for the same server (older versions included — one approval
// per server).
async function pinMcpManifest({ manifest, verdict, lockPath, cwd }) {
  const resolvedLockPath = lockPath || defaultLockPath(cwd);
  const decisions = await loadDecisions(resolvedLockPath);
  const name = mcpRecordName(manifest.server.name);
  for (const [key, record] of decisions) {
    if (record.name === name) decisions.delete(key);
  }
  const now = new Date().toISOString();
  const record = {
    name,
    version: manifest.server.version || "0",
    // Pinning a block would be self-contradictory — the stored decision
    // mirrors the verdict so a blocked manifest cannot masquerade as approved.
    decision: verdict === "block" ? "block" : "allow",
    reason: "MCP manifest pinned via pkgxray mcp --pin",
    decided_at: now,
    verdict,
    checkedAt: now,
    manifest: manifestFingerprints(manifest)
  };
  decisions.set(`${record.name}@${record.version}`, record);
  await saveDecisions(resolvedLockPath, decisions);
  return { lockPath: resolvedLockPath, record };
}

function diffFingerprints(baseline, fresh) {
  const baseByName = new Map(baseline.tools.map((t) => [t.name, t.sha256]));
  const freshByName = new Map(fresh.tools.map((t) => [t.name, t.sha256]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const name of freshByName.keys()) {
    if (!baseByName.has(name)) added.push(name);
    else if (baseByName.get(name) !== freshByName.get(name)) changed.push(name);
  }
  for (const name of baseByName.keys()) {
    if (!freshByName.has(name)) removed.push(name);
  }
  return { added, removed, changed, drifted: added.length + removed.length + changed.length > 0 };
}

// Re-check a live manifest against the pinned baseline.
//
// Returns { status, verdictDrift, manifestDrift, versionChanged, stale,
//           baseline, exitCode } — status is "no-baseline" when the server
//   was never pinned (informational, exit 0, like recheck's no-baseline
//   bucket), else "ok".
// Writes the refreshed monitoring baseline (verdict/checkedAt — never the
// approval fingerprints or decision) unless write:false.
async function recheckMcpManifest({ manifest, verdict, lockPath, cwd, ttlMs, write = true }) {
  const resolvedLockPath = lockPath || defaultLockPath(cwd);
  const decisions = await loadDecisions(resolvedLockPath);
  const name = mcpRecordName(manifest.server.name);
  const record = findServerRecord(decisions, name);

  if (!record) {
    return {
      status: "no-baseline",
      verdictDrift: "no-baseline",
      manifestDrift: null,
      versionChanged: false,
      stale: true,
      baseline: null,
      exitCode: 0
    };
  }

  const stale = isStale(record, ttlMs);
  const verdictDrift = classifyDrift(record.verdict, verdict);
  const manifestDrift = record.manifest
    ? diffFingerprints(record.manifest, manifestFingerprints(manifest))
    : null;
  const versionChanged = record.version !== (manifest.server.version || "0");

  // Gate on the NEW exposure only: a regression gates at its fresh severity;
  // an unapproved manifest change gates at review; already-known state does
  // not gate (recheck's rule).
  let exitCode = 0;
  if (verdictDrift === "regressed") {
    exitCode = verdict === "block" ? 2 : 3;
  } else if (manifestDrift && manifestDrift.drifted) {
    exitCode = 3;
  }

  const baseline = {
    verdict: record.verdict,
    checkedAt: record.checkedAt,
    decision: record.decision,
    decided_at: record.decided_at,
    version: record.version
  };

  if (write) {
    record.verdict = verdict;
    record.checkedAt = new Date().toISOString();
    await saveDecisions(resolvedLockPath, decisions);
  }

  return { status: "ok", verdictDrift, manifestDrift, versionChanged, stale, baseline, exitCode };
}

module.exports = {
  pinMcpManifest,
  recheckMcpManifest,
  manifestFingerprints,
  toolFingerprint,
  stableStringify,
  mcpRecordName
};
