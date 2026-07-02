// The scanning pull-through proxy HTTP server.
//
// Metadata requests pass through to upstream untouched. Tarball requests go
// through the gate: allowlist/denylist -> verdict cache -> pkgxray scan ->
// policy. Allow streams the real tarball; block returns 403 + findings;
// review and scan-error follow configured policy.

import http from 'node:http';
import https from 'node:https';

import { parsePath } from './path-parser.js';
import { runGuard as defaultRunGuard, ScanError } from './pkgxray-runner.js';
import { VerdictStore } from './verdict-store.js';

const HEADER_VERDICT = 'x-pkgxray-verdict';
const HEADER_SOURCE = 'x-pkgxray-source'; // allowlist | denylist | cache | scan

/**
 * Decide what to do with a tarball request. Pure-ish: all side effects are the
 * verdict store and the injected runner. Returns a plan the server executes.
 *
 * @returns {Promise<{serve:boolean, status:number, decision:string,
 *   source:string, findings:Array, cached:boolean, note?:string}>}
 */
export async function gate({ config, store, name, version, runGuard = defaultRunGuard, log }) {
  // 1. Admin allow/denylist short-circuits — never scanned.
  if (listMatches(config.denylist, name, version)) {
    return plan(false, 403, 'block', 'denylist', [{ reason: 'denylisted by admin' }], false);
  }
  if (listMatches(config.allowlist, name, version)) {
    return plan(true, 200, 'allow', 'allowlist', [], false, 'pinned by admin allowlist');
  }

  // 2. Verdict cache.
  const cached = store.get(name, version);
  if (cached) {
    return fromDecision(config, cached.decision, cached.findings, 'cache', true);
  }

  // 3. Cache miss — scan.
  let result;
  try {
    result = await runGuard(config.pkgxrayBin, `${name}@${version}`, {
      timeoutMs: config.scanTimeoutMs,
      cacheUrl: config.cacheUrl,
    });
  } catch (err) {
    // Scan error / timeout — follow scanErrorPolicy, and NEVER cache it.
    if (config.scanErrorPolicy === 'fail-open') {
      return plan(true, 200, 'scan-error', 'scan', findingsFromError(err), false, err.message);
    }
    return plan(false, 403, 'scan-error', 'scan', findingsFromError(err), false, err.message);
  }

  // 4. Real verdict — cache it, then map to an action.
  store.set(name, version, result.decision, result.findings);
  return fromDecision(config, result.decision, result.findings, 'scan', false);
}

/** Map a real decision (allow|block|review) + review policy to a plan. */
function fromDecision(config, decision, findings, source, cached) {
  if (decision === 'allow') return plan(true, 200, 'allow', source, findings, cached);
  if (decision === 'block') return plan(false, 403, 'block', source, findings, cached);
  if (decision === 'review') {
    if (config.reviewPolicy === 'block') return plan(false, 403, 'review', source, findings, cached, 'reviewPolicy=block');
    // warn or allow both serve; warn just annotates.
    const note = config.reviewPolicy === 'warn' ? 'reviewPolicy=warn (served with warning)' : 'reviewPolicy=allow';
    return plan(true, 200, 'review', source, findings, cached, note);
  }
  // Shouldn't happen (store only holds cacheable decisions), but fail safe.
  return plan(false, 403, 'block', source, findings, cached, `unknown decision: ${decision}`);
}

function plan(serve, status, decision, source, findings, cached, note) {
  return { serve, status, decision, source, findings: findings || [], cached: Boolean(cached), ...(note ? { note } : {}) };
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
    const parsed = parsePath(req.url);

    if (parsed.kind === 'tarball') {
      return handleTarball(req, res, parsed);
    }
    // metadata + other -> transparent pass-through.
    return passthrough(req, res);
  }

  async function handleTarball(req, res, parsed) {
    const { name, version } = parsed;
    const decision = await gate({ config, store, name, version, runGuard, log });

    log({
      event: 'decision',
      name, version,
      decision: decision.decision,
      source: decision.source,
      cached: decision.cached,
      serve: decision.serve,
      ...(decision.note ? { note: decision.note } : {}),
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
      });
    }

    // Serve: stream the real tarball from upstream, annotate the verdict.
    return passthrough(req, res, {
      [HEADER_VERDICT]: decision.decision,
      [HEADER_SOURCE]: decision.source,
    });
  }

  /** Transparent reverse-proxy to upstream, streaming the response. */
  function passthrough(req, res, extraHeaders = {}) {
    return new Promise((resolve) => {
      const headers = { ...req.headers };
      delete headers.host; // let the upstream client set the correct Host
      delete headers['accept-encoding']; // avoid decompression surprises; stream as-is is fine

      const upReq = upstreamRequest(req.url, { method: req.method, headers }, (upRes) => {
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
