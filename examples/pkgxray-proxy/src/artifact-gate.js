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

// Hold the download in a private file. No upstream byte reaches the installer
// until this snapshot has been scanned and bound to the resulting approval.
export async function acquireArtifact(request, target, headers = {}) {
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
      req.on('error', error => { clearTimeout(timer); reject(error); });
      req.end();
    });
    return { ...result, file, cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
}

export async function gateArtifact({ config, store, name, version, snapshot, runGuard, sharedPolicy }) {
  const context = artifact.fingerprint({ scannerBuildId: artifact.BUILD_ID, upstream: config.upstream,
    policy: sharedPolicy || policy.DEFAULTS, reviewPolicy: config.reviewPolicy,
    allowlist: config.allowlist, denylist: config.denylist });
  const expectedPolicy = artifact.fingerprint(sharedPolicy || policy.DEFAULTS);
  function bound(a, decision) {
    return approvalPolicy.receiptAuthorizes(a, { allowReview: true }) && a.artifactSha256 === snapshot.sha256 && a.name === name && a.version === version &&
      a.scannerBuildId === artifact.BUILD_ID && a.policySha256 === expectedPolicy && a.decision === decision &&
      a.sourceComplete === true && a.checks?.source === 'completed' && a.checks?.vulnerabilities === 'completed' &&
      ['allow', 'review'].includes(decision);
  }
  const cached = store.get(name, version);
  const valid = entry => entry?.binding?.artifactSha256 === snapshot.sha256 && entry.binding.context === context &&
    (entry.decision === 'block' || bound(entry.binding.approval, entry.decision));
  if (valid(cached) && !store.isStale(cached, config.verdictTtlMs)) return map(cached.decision, cached.findings, 'cache', true);
  // Unbound legacy entries, changed bytes, policies and builds never authorize
  // a serve. Failed rechecks never fall back to a stale approval.
  let result;
  try {
    result = await runGuard(config.pkgxrayBin, `${name}@${version}`, {
      timeoutMs: config.scanTimeoutMs, cacheUrl: config.cacheUrl, cwd: config.policyCwd,
      artifact: { archivePath: snapshot.file, integrity: `sha256-${Buffer.from(snapshot.sha256, 'hex').toString('base64')}` }
    });
  } catch (error) { return denied('scan-error', error.message); }
  if (result.decision === 'block') {
    store.set(name, version, 'block', result.findings, { artifactSha256: snapshot.sha256, context });
    return denied('block', 'Scanner blocked this artifact', result.findings);
  }
  const a = result.approval;
  if (!bound(a, result.decision)) {
    return denied('unbound', 'Scanner approval does not bind these bytes to the current build, policy and completed checks');
  }
  store.set(name, version, result.decision, result.findings, { artifactSha256: snapshot.sha256, context, approval: a });
  return map(result.decision, result.findings, 'scan', false);

  function map(decision, findings, source, cached) {
    const serve = decision === 'allow' || (decision === 'review' && config.reviewPolicy !== 'block');
    return { serve, status: serve ? 200 : 403, decision, findings: findings || [], source, cached };
  }
  function denied(decision, note, findings = []) { return { serve: false, status: 403, decision, note, findings, source: 'scan', cached: false }; }
}
