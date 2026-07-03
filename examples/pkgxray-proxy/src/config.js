// Configuration loading and validation.
//
// Precedence (lowest -> highest):
//   DEFAULTS  <-  config file (path in PKGXRAY_PROXY_CONFIG)  <-  environment vars
//
// Policy is configuration, not code: fail-mode, review handling, and the
// allow/denylists all live here.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULTS = Object.freeze({
  port: 4873,
  host: '127.0.0.1',
  upstream: 'https://registry.npmjs.org',
  pkgxrayBin: 'pkgxray',
  scanTimeoutMs: 20000,
  // block | warn | allow  — what to do with a "review" verdict.
  reviewPolicy: 'warn',
  // fail-closed | fail-open — what to do when a scan errors or times out.
  scanErrorPolicy: 'fail-closed',
  allowlist: [],
  denylist: [],
  verdictStorePath: join(homedir(), '.pkgxray-proxy', 'verdicts.json'),
  // A cached verdict older than this is treated as stale and re-scanned on the
  // next request, so new intelligence flips a stale allow instead of serving it
  // forever. 0 = always re-scan (never serve from cache). Default 24h.
  verdictTtlMs: 24 * 60 * 60 * 1000,
  cacheUrl: undefined,
  logDecisions: true,
});

const REVIEW_POLICIES = new Set(['block', 'warn', 'allow']);
const SCAN_ERROR_POLICIES = new Set(['fail-closed', 'fail-open']);

/**
 * Load and validate configuration.
 * @param {object} [overrides] explicit overrides (highest precedence, used by tests)
 * @param {object} [env] environment object (defaults to process.env)
 * @returns {object} frozen, validated config
 */
export function loadConfig(overrides = {}, env = process.env) {
  const fromFile = readConfigFile(env.PKGXRAY_PROXY_CONFIG);
  const fromEnv = readEnv(env);

  const merged = {
    ...DEFAULTS,
    ...stripUndefined(fromFile),
    ...stripUndefined(fromEnv),
    ...stripUndefined(overrides),
  };

  return validate(merged);
}

function readConfigFile(path) {
  if (!path) return {};
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read PKGXRAY_PROXY_CONFIG at ${path}: ${err.message}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('config file must be a JSON object');
    }
    return parsed;
  } catch (err) {
    throw new Error(`Invalid JSON in PKGXRAY_PROXY_CONFIG (${path}): ${err.message}`);
  }
}

function readEnv(env) {
  const out = {};
  if (env.PKGXRAY_PROXY_PORT !== undefined) out.port = toInt(env.PKGXRAY_PROXY_PORT, 'PKGXRAY_PROXY_PORT');
  if (env.PKGXRAY_PROXY_HOST !== undefined) out.host = env.PKGXRAY_PROXY_HOST;
  if (env.PKGXRAY_PROXY_UPSTREAM !== undefined) out.upstream = env.PKGXRAY_PROXY_UPSTREAM;
  if (env.PKGXRAY_BIN !== undefined) out.pkgxrayBin = env.PKGXRAY_BIN;
  if (env.PKGXRAY_PROXY_SCAN_TIMEOUT_MS !== undefined) {
    out.scanTimeoutMs = toInt(env.PKGXRAY_PROXY_SCAN_TIMEOUT_MS, 'PKGXRAY_PROXY_SCAN_TIMEOUT_MS');
  }
  if (env.PKGXRAY_PROXY_REVIEW_POLICY !== undefined) out.reviewPolicy = env.PKGXRAY_PROXY_REVIEW_POLICY;
  if (env.PKGXRAY_PROXY_SCAN_ERROR_POLICY !== undefined) out.scanErrorPolicy = env.PKGXRAY_PROXY_SCAN_ERROR_POLICY;
  if (env.PKGXRAY_PROXY_ALLOWLIST !== undefined) out.allowlist = splitList(env.PKGXRAY_PROXY_ALLOWLIST);
  if (env.PKGXRAY_PROXY_DENYLIST !== undefined) out.denylist = splitList(env.PKGXRAY_PROXY_DENYLIST);
  if (env.PKGXRAY_PROXY_VERDICT_STORE !== undefined) out.verdictStorePath = env.PKGXRAY_PROXY_VERDICT_STORE;
  if (env.PKGXRAY_PROXY_VERDICT_TTL_MS !== undefined) {
    out.verdictTtlMs = toInt(env.PKGXRAY_PROXY_VERDICT_TTL_MS, 'PKGXRAY_PROXY_VERDICT_TTL_MS');
  }
  // PKGXRAY_CACHE_URL is the shared-cache server URL forwarded to the CLI.
  if (env.PKGXRAY_CACHE_URL !== undefined) out.cacheUrl = env.PKGXRAY_CACHE_URL;
  if (env.PKGXRAY_PROXY_LOG_DECISIONS !== undefined) {
    out.logDecisions = !/^(0|false|no|off)$/i.test(env.PKGXRAY_PROXY_LOG_DECISIONS.trim());
  }
  return out;
}

function validate(cfg) {
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) {
    throw new Error(`Invalid port: ${cfg.port} (expected integer 0-65535)`);
  }
  if (typeof cfg.host !== 'string' || cfg.host.length === 0) {
    throw new Error(`Invalid host: ${cfg.host}`);
  }
  if (typeof cfg.upstream !== 'string' || !/^https?:\/\//.test(cfg.upstream)) {
    throw new Error(`Invalid upstream: ${cfg.upstream} (expected http(s) URL)`);
  }
  if (typeof cfg.pkgxrayBin !== 'string' || cfg.pkgxrayBin.length === 0) {
    throw new Error(`Invalid pkgxrayBin: ${cfg.pkgxrayBin}`);
  }
  if (!Number.isInteger(cfg.scanTimeoutMs) || cfg.scanTimeoutMs <= 0) {
    throw new Error(`Invalid scanTimeoutMs: ${cfg.scanTimeoutMs} (expected positive integer)`);
  }
  if (!REVIEW_POLICIES.has(cfg.reviewPolicy)) {
    throw new Error(`Invalid reviewPolicy: ${cfg.reviewPolicy} (expected block|warn|allow)`);
  }
  if (!SCAN_ERROR_POLICIES.has(cfg.scanErrorPolicy)) {
    throw new Error(`Invalid scanErrorPolicy: ${cfg.scanErrorPolicy} (expected fail-closed|fail-open)`);
  }
  if (!Array.isArray(cfg.allowlist) || !cfg.allowlist.every((x) => typeof x === 'string')) {
    throw new Error('Invalid allowlist: expected array of strings');
  }
  if (!Array.isArray(cfg.denylist) || !cfg.denylist.every((x) => typeof x === 'string')) {
    throw new Error('Invalid denylist: expected array of strings');
  }
  if (typeof cfg.verdictStorePath !== 'string' || cfg.verdictStorePath.length === 0) {
    throw new Error('Invalid verdictStorePath');
  }
  if (!Number.isInteger(cfg.verdictTtlMs) || cfg.verdictTtlMs < 0) {
    throw new Error(`Invalid verdictTtlMs: ${cfg.verdictTtlMs} (expected non-negative integer; 0 = always re-scan)`);
  }
  if (cfg.cacheUrl !== undefined && typeof cfg.cacheUrl !== 'string') {
    throw new Error('Invalid cacheUrl');
  }
  // Normalize: strip trailing slash from upstream so path joins are clean.
  cfg.upstream = cfg.upstream.replace(/\/+$/, '');
  cfg.logDecisions = Boolean(cfg.logDecisions);
  return Object.freeze(cfg);
}

function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function toInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`Invalid ${name}: ${value} (expected integer)`);
  return n;
}

function splitList(value) {
  if (Array.isArray(value)) return value;
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
