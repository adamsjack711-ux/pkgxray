// All executable imports are part of this distribution. Target files are data.
import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { analyzeWithEngine, renderIntegration } from './integration.mjs';
const require = createRequire(import.meta.url);
const { auditEvidence } = require('../../../src/auditor.js');
const { BUILD_ID } = require('../../../src/artifact.js');
const { version } = require('../../../package.json');
if (fs.realpathSync(workerData.root) !== workerData.root) throw new Error('Source root changed');
const report = analyzeWithEngine(workerData, packages => ({
  engine: { name: 'pkgxray', version, buildId: BUILD_ID },
  packages: packages.map(({ id, evidence }) => {
    try { return { id, status: 'completed', report: auditEvidence(evidence) }; }
    catch { return { id, status: 'failed', error: 'Package evidence analysis failed.' }; }
  })
}));
parentPort.postMessage({ report, text: renderIntegration(report) });
