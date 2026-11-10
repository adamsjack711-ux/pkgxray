import assert from 'node:assert/strict';
import { analyzeWithPkgxray, renderIntegration } from '../src/integration.mjs';
import { createScenario } from './support/scenario.mjs';

const scannerRoot = process.argv[2];
if (!scannerRoot || process.argv.length !== 3) {
  console.error('Usage: npm run demo:integration -- /path/to/trusted/pkgxray\nUses real pkgxray static analysis on synthetic source files. No target code runs.');
  process.exit(2);
}
for (const kind of ['sensitive', 'public', 'unsupported', 'blocked']) {
  const fixture = createScenario(kind);
  try {
    const report = analyzeWithPkgxray({ root: fixture.root, scannerRoot });
    assert.equal(report.pkgxray.status, 'completed', JSON.stringify(report.gaps));
    assert.equal(report.authorization.installAllowed, false);
    assert.equal(report.decision, kind === 'blocked' ? 'block' : 'review');
    assert.equal(report.compose.verdict, kind === 'sensitive' ? 'review' : kind === 'unsupported' ? 'incomplete' : 'no-flow-found');
    if (kind === 'sensitive') {
      console.log(renderIntegration(report));
      console.log('\nCONTROL CASES');
    } else console.log(`${kind.padEnd(12)} decision=${report.decision} flow=${report.compose.verdict} coverage=${report.coverage.status}`);
  } finally { fixture.cleanup(); }
}
console.log('\nAll four integration checks passed. Fixtures were removed.');
