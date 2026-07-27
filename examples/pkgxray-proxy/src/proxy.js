// The scanning pull-through proxy HTTP server.
//
// Metadata requests pass through to upstream untouched. Tarball requests go
// through the gate: allowlist/denylist -> verdict cache -> pkgxray scan ->
// policy. Allow streams the real tarball; block returns 403 + findings;
// review and scan-error follow configured policy.

import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';

import { parsePath, canonicalTarballPath } from './path-parser.js';
import { runGuard as defaultRunGuard, ScanError } from './pkgxray-runner.js';
import { VerdictStore } from './verdict-store.js';

// The shared, team-wide security POLICY (`.pkgxray.json`) — the SAME file the
// CLI, MCP server, and install hook read, so a team has one policy across every
// surface. This is deliberately separate from the proxy's own config.js, which
// holds SERVER settings (port/upstream/store/reviewPolicy). We layer the shared
// policy (allow/mute/scanErrorPolicy) on top of the server's gate decisions.
//
// It is a CommonJS module; from ESM we import the DEFAULT object and reach the
// named functions off it (`pkgxrayConfig.loadConfig` etc.) — named CJS imports
// are unreliable under Node's interop, the default object always works.
import pkgxrayConfig from '../../../src/config.js';

/**
 * Load the shared `.pkgxray.json` policy once, at startup. Warnings (malformed
 * file, dropped un-pinned allow, a loosening) are surfaced through the proxy's
 * logger so a policy change is never silent. Never throws: a broken shared file
 * degrades to the safe DEFAULTS (maximum strictness), the proxy still runs.
 *
 * @param {object} [opts] { cwd, log }
 * @returns {object} the validated shared policy config
 */
export function loadSharedPolicy({ cwd = process.cwd(), log } = {}) {
  try {
    const { config, warnings, sources } = pkgxrayConfig.loadConfig({ cwd });
    // Only ADOPT the shared policy when a real `.pkgxray.json` (or .local) was
    // found. With no authored file, loadConfig returns the safe DEFAULTS — but
    // those defaults must NOT clobber the proxy's own explicitly-set server
    // settings (e.g. a proxy configured fail-open). So: no file -> null -> the
    // proxy uses only its own config; a real file present -> it takes precedence
    // (this is the whole point: one team policy across CLI/MCP/proxy).
    if (!sources || sources.length === 0) return null;
    if (log) {
      for (const s of sources) logSafe(log, { event: 'shared-policy', source: s });
      for (const w of warnings) logSafe(log, { event: 'shared-policy-warning', message: w });
    }
    return config;
  } catch (err) {
    if (log) logSafe(log, { event: 'shared-policy-error', message: err && err.message });
    return null;
  }
}

const HEADER_VERDICT = 'x-pkgxray-verdict';
const HEADER_SOURCE = 'x-pkgxray-source'; // allowlist | denylist | cache | scan

/**
 * Decide what to do with a tarball request. Pure-ish: all side effects are the
 * verdict store and the injected runner. Returns a plan the server executes.
 *
 * @returns {Promise<{serve:boolean, status:number, decision:string,
 *   source:string, findings:Array, cached:boolean, note?:string}>}
 */
export async function gate({ config, store, name, version, runGuard = defaultRunGuard, log, sharedPolicy }) {
  // 1. Admin allow/denylist short-circuits — never scanned.
  if (listMatches(config.denylist, name, version)) {
    return plan(false, 403, 'block', 'denylist', [{ reason: 'denylisted by admin' }], false);
  }
  if (listMatches(config.allowlist, name, version)) {
    return plan(true, 200, 'allow', 'allowlist', [], false, 'pinned by admin allowlist');
  }

  // 2. Verdict cache — but only a FRESH one. A cached verdict older than
  // verdictTtlMs is stale: new intelligence may have flipped it, so we don't
  // serve a stale allow forever. Stale entries fall through to a re-scan (lazy
  // refresh on access).
  const cached = store.get(name, version);
  if (cached && !store.isStale(cached, config.verdictTtlMs)) {
    return fromDecision(config, cached.decision, cached.findings, 'cache', true);
  }

  // 3. Cache miss or stale entry — (re)scan. `prev` is the stale entry, if any,
  // so a failed refresh can fall back to it instead of overwriting a good verdict.
  return scanAndDecide({ config, store, name, version, runGuard, log, prev: cached || null, sharedPolicy });
}

/**
 * Scan a package, update the store, and map to a plan. Shared by the cache-miss
 * path and the stale-refresh path so both obey the same rules:
 *   - a real verdict change (allow->block etc.) is logged as a transition and
 *     persisted, so subsequent requests are gated on the new verdict;
 *   - a failed scan NEVER overwrites a good stored verdict — on refresh it falls
 *     back to serving the prior cached verdict; on a true miss it follows
 *     scanErrorPolicy.
 */
async function scanAndDecide({ config, store, name, version, runGuard, log, prev, sharedPolicy }) {
  let result;
  try {
    result = await runGuard(config.pkgxrayBin, `${name}@${version}`, {
      timeoutMs: config.scanTimeoutMs,
      cacheUrl: config.cacheUrl,
    });
  } catch (err) {
    if (prev) {
      // Stale refresh failed — keep the last good verdict rather than degrade to
      // a scan-error/403. The entry is untouched (still cacheable), just not fresh.
      logSafe(log, { event: 'refresh-error', name, version, message: err.message, keeping: prev.decision });
      return fromDecision(config, prev.decision, prev.findings, 'cache', true, `stale refresh failed: ${err.message}`);
    }
    // Scan-error handling. PRECEDENCE: the shared `.pkgxray.json`
    // scanErrorPolicy wins when present — it is the one policy the whole team
    // shares across CLI/MCP/proxy, and this example server's own
    // config.scanErrorPolicy is only a fallback for a proxy run without a shared
    // file. verdictForScanError() maps fail-closed -> "review", fail-open ->
    // "safe"; anything that isn't an explicit fail-open serves closed (403).
    const errPolicy = errorPolicy(config, sharedPolicy);
    if (errPolicy === 'fail-open') {
      return plan(true, 200, 'scan-error', 'scan', findingsFromError(err), false, `${err.message} (scanErrorPolicy=fail-open)`);
    }
    return plan(false, 403, 'scan-error', 'scan', findingsFromError(err), false, `${err.message} (scanErrorPolicy=fail-closed)`);
  }

  // Layer the shared team policy on top of the raw scan verdict: a pinned+sha256
  // allow can clear a package the scan would gate; a mute suppresses a check.
  // applyConfig re-folds the verdict over the surviving findings and records
  // exactly what it changed in `configEffects`, so nothing is ever silent.
  const applied = applySharedPolicy(sharedPolicy, {
    decision: result.decision,
    findings: result.findings,
    name, version,
    sha256: result.sha256,
  });
  const decision = applied.decision;
  const findings = applied.findings;

  const prevDecision = prev ? prev.decision : null;
  store.set(name, version, decision, findings);
  if (prevDecision && prevDecision !== decision) {
    logSafe(log, {
      event: 'verdict-transition',
      name, version,
      from: prevDecision,
      to: decision,
      reason: 'ttl-refresh',
    });
  }
  return fromDecision(config, decision, findings, 'scan', false, undefined, applied.configEffects);
}

/**
 * Reconcile the shared scanErrorPolicy with the proxy's own. The shared team
 * policy (from `.pkgxray.json`) takes precedence when it is present; the proxy's
 * server-level `config.scanErrorPolicy` is the fallback. Both express the same
 * fail-closed/fail-open choice, so when they conflict we defer to the shared one
 * — one policy file for the whole team beats a per-proxy override.
 */
function errorPolicy(config, sharedPolicy) {
  if (sharedPolicy) {
    // "safe" => serve (fail-open); "review" => gate closed (fail-closed).
    return pkgxrayConfig.verdictForScanError(sharedPolicy) === 'safe' ? 'fail-open' : 'fail-closed';
  }
  return config.scanErrorPolicy;
}

/**
 * Apply the shared `.pkgxray.json` policy to a single scan result. Maps the
 * proxy's allow|block|review verdict into the shared engine's finding-based
 * model, runs applyConfig (pinned allow / mute), and maps the result back.
 *
 * Returns { decision, findings, configEffects }. When no shared policy is loaded
 * (or nothing changes) the original decision passes through untouched.
 */
function applySharedPolicy(sharedPolicy, { decision, findings, name, version, sha256 }) {
  if (!sharedPolicy) return { decision, findings, configEffects: null };

  // The shared engine folds a verdict over findings. Give it the proxy's
  // findings and a placeholder verdict-bearing finding so a gated package (no
  // structured findings from the runner) still looks non-safe to applyConfig —
  // otherwise an empty findings list would already read as "safe" and there'd be
  // nothing for a pinned allow to clear.
  const modelFindings = (Array.isArray(findings) ? findings.slice() : []).map((f) => ({ ...f }));
  if (decision !== 'allow' && modelFindings.length === 0) {
    modelFindings.push({
      category: 'proxy-verdict',
      severity: decision === 'block' ? 'high' : 'medium',
      reason: `proxy scan verdict: ${decision}`,
    });
  }
  const report = { packageName: name, verdict: proxyToShared(decision), findings: modelFindings };
  const adjusted = pkgxrayConfig.applyConfig(report, {
    config: sharedPolicy,
    packageName: name,
    version,
    sha256,
  });

  const effects = adjusted.configEffects;
  const touched = effects && (effects.allowlisted || effects.mutedCount > 0 || (effects.notices && effects.notices.length));
  if (!touched) return { decision, findings, configEffects: null };

  // Map the re-folded shared verdict back to a proxy decision. A pinned allow
  // forces "safe" -> the proxy serves it as "allow"; muting can drop a package
  // from block/review down as findings disappear.
  return {
    decision: sharedToProxy(adjusted.verdict, decision),
    findings: adjusted.findings,
    configEffects: effects,
  };
}

// The shared engine speaks safe|review|block; the proxy speaks allow|block|review.
function proxyToShared(decision) {
  if (decision === 'allow') return 'safe';
  return decision; // block / review are shared vocabulary too
}
function sharedToProxy(verdict, fallback) {
  if (verdict === 'safe' || verdict === 'allow') return 'allow';
  if (verdict === 'block' || verdict === 'review') return verdict;
  return fallback;
}

/**
 * Re-scan every cached name@version and update the store — the "force refresh
 * after a big advisory drop" path behind an admin endpoint. A regressed verdict
 * (allow -> review/block) updates the store and is logged as a transition; a
 * failed re-scan is recorded but NEVER overwrites the existing good verdict.
 *
 * @returns {Promise<{total:number, changed:Array, errors:Array, unchanged:number}>}
 */
export async function adminRecheck({ config, store, runGuard = defaultRunGuard, log = () => {} }) {
  const entries = store.entries();
  const changed = [];
  const errors = [];
  let unchanged = 0;

  for (const e of entries) {
    let result;
    try {
      result = await runGuard(config.pkgxrayBin, `${e.name}@${e.version}`, {
        timeoutMs: config.scanTimeoutMs,
        cacheUrl: config.cacheUrl,
      });
    } catch (err) {
      // Never overwrite a good stored verdict with an error state.
      errors.push({ name: e.name, version: e.version, message: err.message });
      logSafe(log, { event: 'refresh-error', name: e.name, version: e.version, message: err.message, keeping: e.decision });
      continue;
    }
    if (result.decision !== e.decision) {
      store.set(e.name, e.version, result.decision, result.findings);
      logSafe(log, {
        event: 'verdict-transition',
        name: e.name, version: e.version,
        from: e.decision, to: result.decision,
        reason: 'admin-recheck',
      });
      changed.push({ name: e.name, version: e.version, from: e.decision, to: result.decision });
    } else {
      // Same verdict — refresh ts so it's fresh again and won't re-scan on TTL.
      store.set(e.name, e.version, result.decision, result.findings);
      unchanged += 1;
    }
  }
  return { total: entries.length, changed, errors, unchanged };
}

function logSafe(log, entry) {
  try {
    log(entry);
  } catch {
    /* logging must never break a decision */
  }
}

/** Map a real decision (allow|block|review) + review policy to a plan. */
function fromDecision(config, decision, findings, source, cached, note, configEffects) {
  if (decision === 'allow') return plan(true, 200, 'allow', source, findings, cached, note, configEffects);
  if (decision === 'block') return plan(false, 403, 'block', source, findings, cached, note, configEffects);
  if (decision === 'review') {
    // reviewPolicy is the proxy's own server-level knob for review-grade
    // verdicts; it still applies after the shared policy has had its say.
    if (config.reviewPolicy === 'block') return plan(false, 403, 'review', source, findings, cached, note || 'reviewPolicy=block', configEffects);
    // warn or allow both serve; warn just annotates.
    const rpNote = config.reviewPolicy === 'warn' ? 'reviewPolicy=warn (served with warning)' : 'reviewPolicy=allow';
    return plan(true, 200, 'review', source, findings, cached, note || rpNote, configEffects);
  }
  // Shouldn't happen (store only holds cacheable decisions), but fail safe.
  return plan(false, 403, 'block', source, findings, cached, note || `unknown decision: ${decision}`, configEffects);
}

function plan(serve, status, decision, source, findings, cached, note, configEffects) {
  // Surface what the shared config changed (allowlisted/muted) so a loosening is
  // never invisible — carried on the plan and logged/served with the decision.
  const effectLines = configEffects ? pkgxrayConfig.renderConfigEffects(configEffects) : [];
  return {
    serve, status, decision, source,
    findings: findings || [],
    cached: Boolean(cached),
    ...(note ? { note } : {}),
    ...(effectLines.length ? { configEffects: effectLines } : {}),
  };
}

function findingsFromError(err) {
  return [{ reason: err instanceof ScanError ? err.message : `scan error: ${err.message}` }];
}

/**
 * Does an allow/deny list match this package?
 * Entries may be a bare name (matches all versions) or "name@version".
 */
function listMatches(list, name, version) {
  if (!Array.isArray(list) || list.length === 0) return false;
  const full = `${name}@${version}`;
  for (const entry of list) {
    if (entry === name) return true;
    if (entry === full) return true;
    // name@* means all versions.
    if (entry === `${name}@*`) return true;
  }
  return false;
}

/**
 * True for a loopback source address: IPv4 127.0.0.0/8, IPv6 ::1, and the
 * IPv4-mapped-IPv6 forms Node reports (e.g. ::ffff:127.0.0.1) on a dual-stack
 * listener.
 */
export function isLoopbackAddress(addr) {
  if (typeof addr !== 'string' || addr.length === 0) return false;
  const a = addr.toLowerCase();
  if (a === '::1') return true;
  const mapped = a.startsWith('::ffff:') ? a.slice('::ffff:'.length) : a;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(mapped);
}

/** Constant-time string compare that never short-circuits on length. */
function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Pull an admin token from the request (Bearer header or x-pkgxray-admin-token). */
function presentedAdminToken(req) {
  const auth = req.headers && req.headers.authorization;
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  const header = req.headers && req.headers['x-pkgxray-admin-token'];
  if (typeof header === 'string' && header.length > 0) return header.trim();
  return null;
}

/**
 * Decide whether an admin request (POST /-/pkgxray/recheck) is authorized. The
 * endpoint triggers a re-scan of EVERY cached package — a download+extract+scan
 * per entry — so an unauthenticated remote caller could use it to amplify load.
 * Precedence:
 *   1. adminToken configured -> a matching `Authorization: Bearer <token>` is
 *      required (from any host), so an operator can expose recheck to a trusted
 *      admin with a shared secret.
 *   2. no adminToken -> only loopback clients may trigger it, so the documented
 *      localhost `curl` workflow still works but a remote caller is refused with
 *      a pointer to set a token.
 * @returns {{ok:true}|{ok:false, status:number, message:string}}
 */
export function authorizeAdmin(config, req) {
  if (config.adminToken) {
    const presented = presentedAdminToken(req);
    if (presented && timingSafeEqualStr(presented, config.adminToken)) return { ok: true };
    return { ok: false, status: 401, message: 'admin token required (Authorization: Bearer <token>)' };
  }
  const remote = req.socket && req.socket.remoteAddress;
  if (isLoopbackAddress(remote)) return { ok: true };
  return {
    ok: false,
    status: 403,
    message:
      'admin recheck is restricted to loopback; set adminToken (PKGXRAY_PROXY_ADMIN_TOKEN) to allow remote admin access',
  };
}

/**
 * Build the HTTP server.
 * @param {object} config validated config from loadConfig()
 * @param {VerdictStore} store
 * @param {object} [deps] injectable deps: { runGuard, upstreamRequest, log }
 * @returns {http.Server}
 */
export function createServer(config, store, deps = {}) {
  const runGuard = deps.runGuard || defaultRunGuard;
  const upstreamRequest = deps.upstreamRequest || makeUpstreamRequest();
  const log = deps.log || (config.logDecisions ? defaultLog : () => {});
  // Load the shared team policy ONCE, at startup. Tests inject `deps.sharedPolicy`
  // (which may be `null` to disable it). Warnings are printed through the logger.
  const sharedPolicy = deps.sharedPolicy !== undefined
    ? deps.sharedPolicy
    : loadSharedPolicy({ cwd: config.policyCwd || process.cwd(), log });

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log({ event: 'error', message: err && err.message, path: req.url });
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'proxy_error', message: 'internal proxy error' });
      } else {
        res.destroy();
      }
    });
  });

  async function handle(req, res) {
    // Admin: force a re-scan of every cached verdict (e.g. after a big advisory
    // drop). Intercepted before path parsing so it never hits the registry
    // passthrough. POST-only so a crawler GET can't trigger a full re-scan.
    const pathname = (req.url || '').split(/[?#]/, 1)[0];
    if (pathname === '/-/pkgxray/recheck') {
      if (req.method !== 'POST') {
        return sendJson(res, 405, { error: 'method_not_allowed', message: 'POST /-/pkgxray/recheck' });
      }
      return handleAdminRecheck(req, res);
    }

    const parsed = parsePath(req.url);

    if (parsed.kind === 'tarball') {
      return handleTarball(req, res, parsed);
    }
    // metadata + other -> transparent pass-through.
    return passthrough(req, res);
  }

  async function handleAdminRecheck(req, res) {
    const auth = authorizeAdmin(config, req);
    if (!auth.ok) {
      log({
        event: 'admin-recheck-denied',
        status: auth.status,
        remote: req.socket && req.socket.remoteAddress,
      });
      return sendJson(res, auth.status, { error: 'unauthorized', message: auth.message });
    }
    const summary = await adminRecheck({ config, store, runGuard, log });
    log({
      event: 'admin-recheck',
      total: summary.total,
      changed: summary.changed.length,
      errors: summary.errors.length,
      unchanged: summary.unchanged,
    });
    return sendJson(res, 200, { ok: true, ...summary });
  }

  async function handleTarball(req, res, parsed) {
    const { name, version } = parsed;

    // Fail closed on any tarball request that isn't in strict canonical form.
    // A divergent basename / smuggled version / query string means the bytes the
    // client would receive don't correspond to the identity the gate scans, so
    // we reject rather than serve. (See path-parser isCanonicalTarball.)
    if (parsed.invalid) {
      log({ event: 'reject', reason: 'non-canonical-tarball', path: req.url, name, version });
      res.setHeader(HEADER_VERDICT, 'block');
      res.setHeader(HEADER_SOURCE, 'path-validation');
      return sendJson(res, 400, {
        error: 'invalid_tarball_request',
        message: 'tarball path must be canonical: <name>/-/<unscoped-name>-<version>.tgz with no query string',
        path: req.url,
      });
    }

    const decision = await gate({ config, store, name, version, runGuard, log, sharedPolicy });

    log({
      event: 'decision',
      name, version,
      decision: decision.decision,
      source: decision.source,
      cached: decision.cached,
      serve: decision.serve,
      ...(decision.note ? { note: decision.note } : {}),
      // Never let a config-driven change (allowlisted/muted) go unlogged.
      ...(decision.configEffects ? { configEffects: decision.configEffects } : {}),
    });

    if (!decision.serve) {
      res.setHeader(HEADER_VERDICT, decision.decision);
      res.setHeader(HEADER_SOURCE, decision.source);
      return sendJson(res, decision.status, {
        error: 'blocked_by_pkgxray',
        package: `${name}@${version}`,
        decision: decision.decision,
        source: decision.source,
        findings: decision.findings,
        ...(decision.note ? { note: decision.note } : {}),
        ...(decision.configEffects ? { configEffects: decision.configEffects } : {}),
      });
    }

    // Serve: stream the real tarball from upstream, annotate the verdict. Fetch
    // the CANONICAL path derived from the scanned identity — not the client's raw
    // URL — so the served bytes correspond to exactly what pkgxray vetted, and no
    // basename/version/query smuggled in the request reaches upstream.
    return passthrough(req, res, {
      [HEADER_VERDICT]: decision.decision,
      [HEADER_SOURCE]: decision.source,
    }, canonicalTarballPath(name, version));
  }

  /** Transparent reverse-proxy to upstream, streaming the response. */
  function passthrough(req, res, extraHeaders = {}, targetPath) {
    return new Promise((resolve) => {
      const headers = { ...req.headers };
      delete headers.host; // let the upstream client set the correct Host
      delete headers['accept-encoding']; // avoid decompression surprises; stream as-is is fine

      // Tarball serves pass an explicit canonical targetPath; metadata/other
      // passthrough uses the incoming URL verbatim.
      const upstreamPath = targetPath || req.url;
      const upReq = upstreamRequest(upstreamPath, { method: req.method, headers }, (upRes) => {
        const outHeaders = { ...upRes.headers, ...extraHeaders };
        res.writeHead(upRes.statusCode || 502, outHeaders);
        upRes.pipe(res);
        upRes.on('end', resolve);
        upRes.on('error', () => { res.destroy(); resolve(); });
      });

      upReq.on('error', (err) => {
        if (!res.headersSent) {
          sendJson(res, 502, { error: 'upstream_error', message: err.message });
        } else {
          res.destroy();
        }
        resolve();
      });

      // Forward the request body (npm registry reads are GET, but be correct).
      req.pipe(upReq);
    });
  }

  /** Factory that binds upstream base URL to a request maker. */
  function makeUpstreamRequest() {
    const base = new URL(config.upstream);
    const client = base.protocol === 'http:' ? http : https;
    return (reqPath, options, cb) => {
      // Preserve the incoming path (and query) against the upstream origin/prefix.
      const target = new URL(base.toString());
      target.pathname = joinPath(base.pathname, reqPath);
      target.search = extractSearch(reqPath);
      return client.request(target, options, cb);
    };
  }

  server.on('listening', () => {
    const addr = server.address();
    log({ event: 'listening', host: config.host, port: addr && addr.port, upstream: config.upstream });
  });

  return server;
}

function joinPath(basePath, reqPath) {
  const b = basePath.replace(/\/+$/, '');
  const p = reqPath.split(/[?#]/, 1)[0];
  const suffix = p.startsWith('/') ? p : `/${p}`;
  return `${b}${suffix}` || '/';
}

function extractSearch(reqPath) {
  const q = reqPath.indexOf('?');
  return q === -1 ? '' : reqPath.slice(q);
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

function defaultLog(entry) {
  try {
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    /* logging must never throw */
  }
}
