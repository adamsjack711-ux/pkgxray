import { mkdtemp, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import artifact from '../../../src/artifact.js';
import policy from '../../../src/config.js';
import approvalPolicy from '../../../src/approval-policy.js';
import reviews from '../../../src/review.js';
import sharing from '../../../src/shared-scans.js';
const coordinators = new WeakMap();

export function assertArtifactCurrent(store, name, version, revision) {
  sharing.assertCurrentBuild();
  if (store.recheckRevision(name, version) !== revision) throw sharing.failure('RECHECK_CHANGED', 'Evidence changed during scan; retry for a fresh review');
}

// Hold the download in a private file. No upstream byte reaches the installer
// until this snapshot has been scanned and bound to the resulting approval.
export async function acquireArtifact(request, target, headers = {}, signal) {
  const dir = await mkdtemp(join(tmpdir(), 'pkgxray-proxy-artifact-'));
  const file = join(dir, 'package.tgz');
  try {
    const result = await new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      let bytes = 0;
      let response;
      const req = request(target, { method: 'GET', headers: {
        ...(headers.authorization ? { authorization: headers.authorization } : {}),
        'accept-encoding': 'identity'
      } }, res => {
        response = res;
        if (res.statusCode !== 200 || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
          res.destroy(); req.destroy(); clearTimeout(timer);
          reject(new Error(`Artifact download requires an unencoded HTTP 200 response (got ${res.statusCode})`));
          return;
        }
        const meter = new Transform({ transform(chunk, encoding, callback) {
          bytes += chunk.length;
          if (bytes > 64 * 1024 * 1024) return callback(new Error('Artifact exceeds 64 MiB limit'));
          hash.update(chunk); callback(null, chunk);
        } });
        pipeline(res, meter, createWriteStream(file, { mode: 0o600, flags: 'wx' }))
          .then(() => resolve({ sha256: hash.digest('hex'), size: bytes }))
          .catch(reject).finally(() => clearTimeout(timer));
      });
      const timer = setTimeout(() => {
        response?.destroy(); req.destroy(); reject(new Error('Artifact download timed out'));
      }, 30000);
      const abort = () => {
        response?.destroy();
        req.destroy(Object.assign(new Error('Artifact download cancelled'), { code: 'ABORT_ERR' }));
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      req.on('error', error => { clearTimeout(timer); reject(error); });
      req.end();
    });
    let references = 1, cleaned = false;
    const release = async () => {
      if (--references === 0) await rm(dir, { recursive: true, force: true });
    };
    return { ...result, file,
      retain() {
        if (references === 0) throw new Error('Artifact snapshot already released');
        references++;
        let released = false;
        return async () => { if (!released) { released = true; await release(); } };
      },
      async cleanup() { if (!cleaned) { cleaned = true; await release(); } }
    };
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
}

export async function gateArtifact({ config, store, name, version, snapshot, runGuard, sharedPolicy, scanCoordinator, scope, decisions, signal }) {
  try { sharing.assertCurrentBuild(); signal?.throwIfAborted(); }
  catch (error) { return denied(error.code || 'scan-error', error.message); }
  const revision = store.recheckRevision(name, version);
  const index = store.get(name, version);
  if (index?.rechecked && index.decision === 'block') return denied('block', 'Blocked by administrator recheck', index.findings);
  const context = artifact.fingerprint({ cacheSchema: 3, scannerBuildId: artifact.BUILD_ID, upstream: config.upstream,
    pkgxrayBin: config.pkgxrayBin, scanTimeoutMs: config.scanTimeoutMs, cacheUrl: config.cacheUrl,
    policy: sharedPolicy || policy.DEFAULTS, reviewPolicy: config.reviewPolicy,
    requireProvenance: process.env.PKGXRAY_REQUIRE_PROVENANCE === '1',
    sigstoreModule: process.env.PKGXRAY_SIGSTORE_MODULE || null,
    allowlist: config.allowlist, denylist: config.denylist, reviewRevision: store.reviewRevision(name, version) });
  const expectedPolicy = artifact.fingerprint(sharedPolicy || policy.DEFAULTS);
  function bound(a, decision) {
    return approvalPolicy.receiptAuthorizes(a, { allowReview: true }) && a.artifactSha256 === snapshot.sha256 && a.name === name && a.version === version &&
      a.scannerBuildId === artifact.BUILD_ID && a.policySha256 === expectedPolicy && a.decision === decision &&
      a.sourceComplete === true && a.checks?.source === 'completed' && a.checks?.vulnerabilities === 'completed' &&
      ['allow', 'review'].includes(decision);
  }
  const binding = { artifactSha256: snapshot.sha256, context };
  const held = store.getHold(name, version);
  const holdTtl = held?.decision === 'scan-error' ? config.scanErrorTtlMs : config.holdTtlMs;
  // Mandatory holds remain denial-only; a session choice cannot override them.
  if (held?.binding?.artifactSha256 === snapshot.sha256 && held.binding.context === context &&
      !store.isStale(held, Math.min(config.verdictTtlMs, holdTtl))) {
    return { ...denied(held.decision, held.note, held.findings), source: 'cache', cached: true };
  }
  const key = artifact.fingerprint({ sha256: snapshot.sha256, context, name, version, recheckRevision: revision });
  const cached = store.getArtifact(key);
  const valid = entry => entry?.binding?.artifactSha256 === snapshot.sha256 && entry.binding.context === context &&
    bound(entry.binding.approval, entry.decision);
  if (valid(cached) && !store.isStale(cached, config.verdictTtlMs)) return map(cached.decision, cached.findings, 'cache', true, cached.binding.approval);

  // Coalesce evidence, then apply each waiter's own review decision. Retain the
  // owner's private snapshot until the shared job stops, even if it disconnects.
  let coordinator = coordinators.get(store);
  if (!coordinator) {
    coordinator = new sharing.SharedScans({ timeoutMs: config.scanTimeoutMs || 30000,
      concurrency: config.scanConcurrency || 4, maxQueue: config.maxPendingScans ?? 64 });
    coordinators.set(store, coordinator);
  }
  let shared;
  try {
    shared = await coordinator.get(key, async jobSignal => {
      const scan = () => scanArtifact(jobSignal);
      return scanCoordinator ? scanCoordinator.run(key, scan) : scan();
    }, { signal, cache: false, retain: snapshot.retain?.bind(snapshot) });
  } catch (error) {
    const busy = ['SCAN_OVERLOADED', 'PKGXRAY_SCAN_BUSY'].includes(error.code);
    if (busy) return { ...denied(error.code, error.message), status: 503 };
    // Cancellation or a recheck is not evidence about a package.
    if (['SCAN_CANCELLED', 'RECHECK_CHANGED', 'SCANNER_CHANGED'].includes(error.code) || signal?.aborted) {
      return denied(error.code || 'scan-error', error.message);
    }
    try { assertFresh(); } catch (stale) { return denied(stale.code || 'scan-error', stale.message); }
    return hold('scan-error', error.message);
  }
  const evidence = shared.evidence;
  if (evidence.error) return { ...denied(evidence.error, evidence.note, evidence.findings), source: shared.source };
  return map(evidence.decision, evidence.findings, shared.source, false, evidence.approval);

  async function scanArtifact(jobSignal) {
    jobSignal.throwIfAborted();
    const result = await runGuard(config.pkgxrayBin, `${name}@${version}`, {
      signal: jobSignal, timeoutMs: config.scanTimeoutMs, cacheUrl: config.cacheUrl, cwd: config.policyCwd,
      artifact: { archivePath: snapshot.file, integrity: `sha256-${Buffer.from(snapshot.sha256, 'hex').toString('base64')}` }
    });
    assertFresh(jobSignal);
    if (result.decision === 'block' || !bound(result.approval, result.decision)) {
      const error = result.decision === 'block' ? 'block' : 'unbound';
      const note = error === 'block' ? 'Scanner blocked this artifact' :
        'Scanner evidence does not bind these bytes to the current build, policy and completed checks';
      hold(error, note, result.findings);
      return { error, note, findings: result.findings };
    }
    store.setArtifact(key, name, version, result.decision, result.findings, { ...binding, approval: result.approval });
    return { decision: result.decision, findings: result.findings, approval: result.approval };
  }
  function map(decision, findings, source, cached, receipt) {
    try { assertFresh(); } catch (error) { return denied(error.code || 'scan-error', error.message); }
    const state = reviews.reviewOutcome(decision, {
      reviewId: reviews.reviewIdentity(receipt, { action: 'deliver', target: context }), scope, decisions
    });
    return { serve: state.allowed, status: state.allowed ? 200 : state.review?.state === 'pending' ? 409 : 403,
      decision, ...state, findings: findings || [], source, cached, recheckRevision: revision };
  }
  function assertFresh(checkSignal = signal) {
    assertArtifactCurrent(store, name, version, revision); checkSignal?.throwIfAborted();
  }
  function denied(decision, note, findings = []) {
    return { serve: false, outcome: 'UNSAFE', status: 403, decision, note, findings, source: 'scan', cached: false };
  }
  function hold(decision, note, findings = []) {
    store.setHold(name, version, decision, findings, note, binding);
    return denied(decision, note, findings);
  }
}
