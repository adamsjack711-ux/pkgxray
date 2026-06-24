"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { auditLockfile } = require("./lockfile");

// ---------------------------------------------------------------------------
// .pkgxray.lock helpers — load / save decisions persisted by triage.
// File format:
// {
//   "schemaVersion": 1,
//   "decisions": [
//     { name, version, decision: "allow"|"block", reason, decided_at }
//   ]
// }
// Decisions are sorted alphabetically by "name@version" on write for
// deterministic diffs.
// ---------------------------------------------------------------------------

const LOCK_FILENAME = ".pkgxray.lock";
const SCHEMA_VERSION = 1;

function lockPathForLockfile(lockfilePath) {
  return path.join(path.dirname(path.resolve(lockfilePath)), LOCK_FILENAME);
}

async function loadDecisions(lockPath) {
  try {
    const text = await fsp.readFile(lockPath, "utf8");
    const json = JSON.parse(text);
    const decisions = Array.isArray(json.decisions) ? json.decisions : [];
    const map = new Map();
    for (const d of decisions) {
      if (!d || typeof d.name !== "string" || typeof d.version !== "string") continue;
      if (d.decision !== "allow" && d.decision !== "block") continue;
      map.set(`${d.name}@${d.version}`, {
        name: d.name,
        version: d.version,
        decision: d.decision,
        reason: typeof d.reason === "string" ? d.reason : "",
        decided_at: typeof d.decided_at === "string" ? d.decided_at : new Date().toISOString()
      });
    }
    return map;
  } catch (error) {
    if (error.code === "ENOENT") return new Map();
    throw error;
  }
}

function loadDecisionsSync(lockPath) {
  try {
    const text = fs.readFileSync(lockPath, "utf8");
    const json = JSON.parse(text);
    const decisions = Array.isArray(json.decisions) ? json.decisions : [];
    const map = new Map();
    for (const d of decisions) {
      if (!d || typeof d.name !== "string" || typeof d.version !== "string") continue;
      if (d.decision !== "allow" && d.decision !== "block") continue;
      map.set(`${d.name}@${d.version}`, {
        name: d.name,
        version: d.version,
        decision: d.decision,
        reason: typeof d.reason === "string" ? d.reason : "",
        decided_at: typeof d.decided_at === "string" ? d.decided_at : new Date().toISOString()
      });
    }
    return map;
  } catch (error) {
    if (error.code === "ENOENT") return new Map();
    throw error;
  }
}

async function saveDecisions(lockPath, decisionsMap) {
  const entries = Array.from(decisionsMap.values()).slice();
  entries.sort((a, b) => {
    const ka = `${a.name}@${a.version}`;
    const kb = `${b.name}@${b.version}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    decisions: entries.map((d) => ({
      name: d.name,
      version: d.version,
      decision: d.decision,
      reason: d.reason || "",
      decided_at: d.decided_at
    }))
  };
  await fsp.writeFile(lockPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Terminal rendering — ANSI escape codes, zero deps.
// ---------------------------------------------------------------------------

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const RED = `${ESC}31m`;
const YELLOW = `${ESC}33m`;
const GREEN = `${ESC}32m`;
const CYAN = `${ESC}36m`;
const CLEAR_LINE = `${ESC}2K\r`;

// SECURITY: every string in `result` (name, version, paths, vulnerability id
// & summary, deep-scan band labels) originates from an attacker-controlled
// lockfile or OSV response. Without scrubbing, a crafted package name like
// `"foo\x1b[2K\x1b[Aevil"` could rewrite an earlier line on the TTY — e.g.
// make the prompt say "block?" while the recorded decision is "allow".
//
// Strip every C0 control byte (0x00-0x1f), DEL (0x7f), and the C1 range
// (0x80-0x9f). Replacement is U+FFFD so the user still sees a placeholder
// where something used to be. The intentional ANSI sequences emitted by the
// renderer (BOLD, RED, etc.) are written as template-literal constants, not
// through this scrubber, so colours still work.
function sanitizeForTerminal(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(
    /[\x00-\x1f\x7f-\x9f]/g,
    "�"
  );
}

function colorForDecision(decision) {
  if (decision === "block") return RED;
  if (decision === "review") return YELLOW;
  return GREEN;
}

function renderPackage(result, index, total) {
  const lines = [];
  const name = sanitizeForTerminal(result.name);
  const version = sanitizeForTerminal(result.version);
  const tag = `${colorForDecision(result.decision)}${result.decision.toUpperCase()}${RESET}`;
  const header = `${BOLD}[${index + 1}/${total}] ${name}@${version}${RESET}  (${tag})`;
  lines.push(header);
  if (Array.isArray(result.paths) && result.paths.length > 0) {
    lines.push(`  pulled in by: ${sanitizeForTerminal(result.paths[0])}`);
  }
  if (Array.isArray(result.vulnerabilities) && result.vulnerabilities.length > 0) {
    lines.push(`  vulnerabilities:`);
    for (const v of result.vulnerabilities) {
      const summary = v.summary ? ` — ${sanitizeForTerminal(v.summary)}` : "";
      lines.push(`    ${CYAN}${sanitizeForTerminal(v.id)}${RESET}${summary}`);
    }
  }
  if (result.deep && Array.isArray(result.deep.riskBands) && result.deep.riskBands.length > 0) {
    const bands = result.deep.riskBands
      .filter((b) => b.severity === "high" || b.severity === "medium")
      .map((b) => `${sanitizeForTerminal(b.severity).toUpperCase()} ${sanitizeForTerminal(b.label)}`);
    if (bands.length > 0) {
      lines.push(`  risk bands (from deep scan): ${bands.join(", ")}`);
    }
  }
  lines.push("");
  lines.push(`  ${BOLD}[a]${RESET} allow   ${BOLD}[b]${RESET} block   ${BOLD}[s]${RESET} skip   ${BOLD}[q]${RESET} quit   ${BOLD}[?]${RESET} help`);
  return lines.join("\n");
}

function renderHelp() {
  return [
    "",
    `  ${BOLD}a${RESET}  allow this package — recorded in .pkgxray.lock, skipped on subsequent runs`,
    `  ${BOLD}b${RESET}  block this package — recorded in .pkgxray.lock, still surfaced each run`,
    `  ${BOLD}s${RESET}  skip — no decision recorded, package will reappear next run`,
    `  ${BOLD}q${RESET}  quit — save progress so far and exit (use --resume to pick up)`,
    `  ${BOLD}?${RESET}  show this help`,
    ""
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Single-keypress reader. Uses process.stdin raw mode.
// Cleans up cooked mode on any exit path (Ctrl-C, exception, normal quit).
// ---------------------------------------------------------------------------

function createKeyReader(stdin) {
  let resolver = null;
  const queue = [];
  let installed = false;
  let prevRaw = false;

  function onData(chunk) {
    const str = chunk.toString("utf8");
    for (const ch of str) {
      if (resolver) {
        const r = resolver;
        resolver = null;
        r(ch);
      } else {
        queue.push(ch);
      }
    }
  }

  function install() {
    if (installed) return;
    installed = true;
    prevRaw = Boolean(stdin.isRaw);
    if (typeof stdin.setRawMode === "function") {
      stdin.setRawMode(true);
    }
    if (typeof stdin.resume === "function") stdin.resume();
    stdin.on("data", onData);
  }

  function restore() {
    if (!installed) return;
    installed = false;
    stdin.off("data", onData);
    if (typeof stdin.setRawMode === "function") {
      try { stdin.setRawMode(prevRaw); } catch { /* ignore */ }
    }
    if (typeof stdin.pause === "function") stdin.pause();
  }

  function next() {
    if (queue.length > 0) return Promise.resolve(queue.shift());
    return new Promise((resolve) => {
      resolver = resolve;
    });
  }

  return { install, restore, next };
}

// ---------------------------------------------------------------------------
// Triage main loop.
// ---------------------------------------------------------------------------

async function triageLockfile(lockfilePath, options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const stdin = options.stdin || process.stdin;
  const isTTY = options.isTTY !== undefined ? options.isTTY : Boolean(stdout.isTTY && stdin.isTTY);

  const lockPath = lockPathForLockfile(lockfilePath);
  let decisions = await loadDecisions(lockPath);

  // Run the underlying audit. We pass the existing decisions so the lockfile
  // audit can tag entries with triaged status.
  const audit = await auditLockfile(lockfilePath, {
    ...options,
    triageDecisions: decisions
  });

  // Build the worklist.
  const includeSafe = Boolean(options.includeSafe);
  let worklist = audit.results.filter((r) => {
    if (includeSafe) return true;
    return r.decision === "block" || r.decision === "review";
  });

  // Resume mode — drop entries already decided as allow. (Blocked stays
  // surfaced so the user can re-examine.)
  if (options.resume) {
    worklist = worklist.filter((r) => {
      const key = `${r.name}@${r.version}`;
      const existing = decisions.get(key);
      return !(existing && existing.decision === "allow");
    });
  } else {
    // Even without --resume, silently skip packages the user already allowed.
    worklist = worklist.filter((r) => {
      const key = `${r.name}@${r.version}`;
      const existing = decisions.get(key);
      return !(existing && existing.decision === "allow");
    });
  }

  // Sort worklist for stable ordering (block first, then review, alpha).
  worklist.sort((a, b) => {
    const rank = (d) => (d === "block" ? 0 : d === "review" ? 1 : 2);
    const dr = rank(a.decision) - rank(b.decision);
    if (dr !== 0) return dr;
    const ka = `${a.name}@${a.version}`;
    const kb = `${b.name}@${b.version}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  // Non-interactive paths --------------------------------------------------

  const auto = normalizeAuto(options.auto || process.env.PKGXRAY_TRIAGE_AUTO);
  if (auto) {
    return runAuto(worklist, decisions, lockPath, auto, { stdout });
  }

  if (!isTTY) {
    const msg = "pkgxray triage: triage requires a TTY; use --auto allow|block or set $PKGXRAY_TRIAGE_AUTO=allow|block to non-interactively process all packages.\n";
    stderr.write(msg);
    const err = new Error("triage requires a TTY");
    err.code = "ENOTTY";
    throw err;
  }

  if (worklist.length === 0) {
    stdout.write("No packages need triage.\n");
    return {
      lockPath,
      decisions: Array.from(decisions.values()),
      counts: { allowed: 0, blocked: 0, skipped: 0, quit: false }
    };
  }

  stdout.write(`Triaging ${worklist.length} package(s) from ${audit.file} (${audit.format}).\n`);
  stdout.write(`Decisions written to ${lockPath}.\n\n`);

  const reader = createKeyReader(stdin);
  reader.install();

  let allowed = 0;
  let blocked = 0;
  let skipped = 0;
  let quit = false;

  // Restore raw mode if the process is interrupted hard.
  const sigintHandler = () => {
    reader.restore();
    process.exit(130);
  };
  process.on("SIGINT", sigintHandler);

  try {
    for (let i = 0; i < worklist.length; i += 1) {
      const r = worklist[i];
      stdout.write(`${renderPackage(r, i, worklist.length)}\n  > `);

      // Inner loop — read keys until we get a valid decision.
      let done = false;
      while (!done) {
        const ch = await reader.next();
        // Handle Ctrl-C (\x03) and ESC (\x1b) -> save & quit.
        if (ch === "\x03" || ch === "\x1b") {
          stdout.write("\n");
          quit = true;
          done = true;
          break;
        }
        const lower = ch.toLowerCase();
        if (lower === "a") {
          stdout.write("a\n");
          decisions.set(`${r.name}@${r.version}`, {
            name: r.name,
            version: r.version,
            decision: "allow",
            reason: "",
            decided_at: new Date().toISOString()
          });
          allowed += 1;
          done = true;
        } else if (lower === "b") {
          stdout.write("b\n");
          decisions.set(`${r.name}@${r.version}`, {
            name: r.name,
            version: r.version,
            decision: "block",
            reason: defaultBlockReason(r),
            decided_at: new Date().toISOString()
          });
          blocked += 1;
          done = true;
        } else if (lower === "s") {
          stdout.write("s\n");
          skipped += 1;
          done = true;
        } else if (lower === "q") {
          stdout.write("q\n");
          quit = true;
          done = true;
        } else if (ch === "?") {
          stdout.write("?\n");
          stdout.write(renderHelp());
          stdout.write("  > ");
        } else {
          // Unknown key — silently re-prompt by re-emitting the cursor.
          stdout.write(`${CLEAR_LINE}  > `);
        }
      }

      stdout.write("\n");
      if (quit) break;
    }
  } finally {
    reader.restore();
    process.off("SIGINT", sigintHandler);
  }

  await saveDecisions(lockPath, decisions);

  const relLock = path.relative(process.cwd(), lockPath) || lockPath;
  const summary = `Triage complete. ${allowed} allowed, ${blocked} blocked, ${skipped} skipped. Saved to ./${relLock}\n`;
  stdout.write(summary);

  return {
    lockPath,
    decisions: Array.from(decisions.values()),
    counts: { allowed, blocked, skipped, quit }
  };
}

function defaultBlockReason(r) {
  if (Array.isArray(r.vulnerabilities) && r.vulnerabilities.length > 0) {
    const ids = r.vulnerabilities.map((v) => v.id).filter(Boolean);
    if (ids.length > 0) return `known CVEs: ${ids.slice(0, 3).join(", ")}`;
    return "known CVEs";
  }
  if (r.deep && Array.isArray(r.deep.riskBands)) {
    const high = r.deep.riskBands.find((b) => b.severity === "high");
    if (high) return `deep scan flagged ${high.label}`;
  }
  return "";
}

function normalizeAuto(value) {
  if (!value) return null;
  const v = String(value).toLowerCase().trim();
  if (v === "allow" || v === "block") return v;
  return null;
}

async function runAuto(worklist, decisions, lockPath, mode, { stdout }) {
  let allowed = 0;
  let blocked = 0;
  for (const r of worklist) {
    const key = `${r.name}@${r.version}`;
    if (mode === "allow") {
      decisions.set(key, {
        name: r.name,
        version: r.version,
        decision: "allow",
        reason: "auto-allowed",
        decided_at: new Date().toISOString()
      });
      allowed += 1;
    } else {
      decisions.set(key, {
        name: r.name,
        version: r.version,
        decision: "block",
        reason: defaultBlockReason(r) || "auto-blocked",
        decided_at: new Date().toISOString()
      });
      blocked += 1;
    }
  }
  await saveDecisions(lockPath, decisions);
  const relLock = path.relative(process.cwd(), lockPath) || lockPath;
  stdout.write(`Triage complete (auto ${mode}). ${allowed} allowed, ${blocked} blocked, 0 skipped. Saved to ./${relLock}\n`);
  return {
    lockPath,
    decisions: Array.from(decisions.values()),
    counts: { allowed, blocked, skipped: 0, quit: false }
  };
}

module.exports = {
  triageLockfile,
  loadDecisions,
  loadDecisionsSync,
  saveDecisions,
  lockPathForLockfile,
  LOCK_FILENAME,
  SCHEMA_VERSION
};
