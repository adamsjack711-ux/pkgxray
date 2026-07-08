// Shell out to the pkgxray CLI to scan a package reference.
//
// We spawn `pkgxray guard npm:<name>@<version> --format json` rather than
// importing pkgxray's modules: process isolation means a hung or crashed scan
// can't take down the proxy, and CLI version bumps don't break us. The child
// is killed if it exceeds scanTimeoutMs.
//
// Verdict is read from the JSON on stdout. Exit codes are a fallback if the
// JSON can't be parsed: 0 = safe/allow, 2 = block, 3 = review.

import { spawn } from 'node:child_process';

export class ScanError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ScanError';
    Object.assign(this, detail);
  }
}

const EXIT_DECISION = { 0: 'allow', 2: 'block', 3: 'review' };

/**
 * Run the pkgxray guard on a single package reference.
 *
 * @param {string} bin path/name of the pkgxray binary
 * @param {string} ref bare package ref "<name>@<version>" (the "npm:" scheme is added)
 * @param {object} opts
 * @param {number} opts.timeoutMs kill the child after this many ms
 * @param {string} [opts.cacheUrl] forwarded as PKGXRAY_CACHE_URL to the child
 * @param {object} [opts.env] base environment (defaults to process.env)
 * @param {Function} [opts.spawnFn] injectable spawn for tests
 * @returns {Promise<{decision:'allow'|'block'|'review', findings:Array, raw?:object}>}
 * @throws {ScanError} on timeout, spawn failure, or an unmappable result
 */
export function runGuard(bin, ref, opts = {}) {
  const { timeoutMs = 20000, cacheUrl, env = process.env, spawnFn = spawn } = opts;
  const args = ['guard', `npm:${ref}`, '--format', 'json'];

  return new Promise((resolve, reject) => {
    const childEnv = { ...env };
    if (cacheUrl) childEnv.PKGXRAY_CACHE_URL = cacheUrl;

    let child;
    try {
      child = spawnFn(bin, args, { env: childEnv });
    } catch (err) {
      reject(new ScanError(`Failed to spawn pkgxray: ${err.message}`, { cause: err, ref }));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    if (child.stdout) child.stdout.on('data', (d) => { stdout += d; });
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      finish(reject, new ScanError(`pkgxray process error: ${err.message}`, { cause: err, ref }));
    });

    child.on('close', (code, signal) => {
      if (timedOut) {
        finish(reject, new ScanError(`pkgxray scan timed out after ${timeoutMs}ms`, {
          ref, timeout: true, stderr: stderr.slice(0, 2000),
        }));
        return;
      }
      try {
        finish(resolve, interpret(stdout, code, ref, stderr));
      } catch (err) {
        finish(reject, err);
      }
    });
  });
}

/**
 * Turn the child's stdout + exit code into a verdict.
 * Prefer the JSON body; fall back to the exit code if JSON is missing/invalid.
 */
function interpret(stdout, code, ref, stderr) {
  const parsed = tryParseJson(stdout);
  if (parsed) {
    const decision = normalizeDecision(parsed.decision ?? parsed.verdict ?? parsed.result);
    if (decision) {
      return { decision, findings: extractFindings(parsed), sha256: extractSha256(parsed), raw: parsed };
    }
  }

  // JSON absent or unrecognized — fall back to the documented exit codes.
  if (Object.prototype.hasOwnProperty.call(EXIT_DECISION, code)) {
    return { decision: EXIT_DECISION[code], findings: [] };
  }

  throw new ScanError(`Could not determine verdict for ${ref} (exit=${code})`, {
    ref, exitCode: code, stderr: stderr.slice(0, 2000), stdout: stdout.slice(0, 2000),
  });
}

function tryParseJson(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // pkgxray may emit a leading log line; try to salvage the JSON object.
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function normalizeDecision(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'allow' || v === 'safe' || v === 'pass' || v === 'ok') return 'allow';
  if (v === 'block' || v === 'blocked' || v === 'deny' || v === 'fail' || v === 'malicious') return 'block';
  if (v === 'review' || v === 'warn' || v === 'suspicious') return 'review';
  return null;
}

// The artifact digest pkgxray scanned, if the report carries one. The shared
// `.pkgxray.json` allowlist is pinned to a sha256, so a pinned allow can only
// apply when we can prove the bytes — no digest here means the allow is skipped.
function extractSha256(parsed) {
  const raw =
    (parsed.report && (parsed.report.sha256 || parsed.report.digest)) ||
    parsed.sha256 ||
    parsed.digest ||
    (parsed.artifact && parsed.artifact.sha256);
  return typeof raw === 'string' && raw.trim() ? raw.trim().toLowerCase() : null;
}

function extractFindings(parsed) {
  // pkgxray's `guard --format json` nests findings under `report.findings`;
  // tolerate a few other shapes for forward-compatibility.
  if (parsed.report && Array.isArray(parsed.report.findings)) return parsed.report.findings;
  if (Array.isArray(parsed.findings)) return parsed.findings;
  if (Array.isArray(parsed.issues)) return parsed.issues;
  if (Array.isArray(parsed.reasons)) return parsed.reasons;
  return [];
}
