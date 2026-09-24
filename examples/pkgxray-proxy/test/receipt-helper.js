import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import artifact from '../../../src/artifact.js';
import policy from '../../../src/config.js';

// Trusted scanner test double: binds its verdict to the actual provided file.
export function withReceipt(runner, config = policy.DEFAULTS) {
  return async (bin, ref, opts) => {
    const result = await runner(bin, ref, opts);
    const split = ref.lastIndexOf('@');
    const bytes = await readFile(opts.artifact.archivePath);
    return { ...result, approval: { schemaVersion: 2,
      artifactSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      name: ref.slice(0, split), version: ref.slice(split + 1),
      scannerBuildId: artifact.BUILD_ID, policySha256: artifact.fingerprint(config),
      decision: result.decision, sourceComplete: true,
      authorization: { mandatoryHoldReasons: [], behavioralCoverage: 'completed', explicitOverride: false },
      checks: { source: 'completed', vulnerabilities: 'completed' } } };
  };
}
