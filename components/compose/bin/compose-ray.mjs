#!/usr/bin/env node
import { analyzeProject } from '../src/analyze.mjs';
import { analyzeWithPkgxray, integrationExitCode, renderIntegration } from '../src/integration.mjs';
import automaticFlow from '../../../src/automatic-flow.js';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
const bundledRoot = fileURLToPath(new URL('../../../', import.meta.url));
export function main(args = process.argv.slice(2)) {
if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
  console.log('Usage: pkgxray compose <source-root> [--entry relative/file.js] [--json] [--flow-only]\n\nReads package-lock.json and local sources without executing target code.\nUses the bundled pkgxray scanner on the same selected bytes by default.\n--flow-only runs connection analysis without package checks.\nFlow-only exits: 0 no modeled flow, 2 findings/incomplete/invalid usage.\nCombined exits: 2 block (including missing coverage).\nCombined reports never authorize installation or request a manual decision.');
  return 0;
}
let root, scannerRoot = bundledRoot, entry = 'index.js', json = false, flowOnly = false;
const seen = new Set();
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--flow-only' && !seen.has(arg)) { flowOnly = true; seen.add(arg); }
  else if (arg === '--json' && !seen.has(arg)) { json = true; seen.add(arg); }
  else if (arg === '--entry' && !seen.has(arg) && args[i + 1] && !args[i + 1].startsWith('-')) { entry = args[++i]; seen.add(arg); }
  else if (arg === '--pkgxray' && !seen.has(arg) && args[i + 1] && !args[i + 1].startsWith('-')) { scannerRoot = args[++i]; seen.add(arg); }
  else if (!arg.startsWith('-') && !root) root = arg;
  else { console.error('Invalid arguments. Run pkgxray compose --help.'); return 2; }
}
if (!root) { console.error('Source root is required. Run pkgxray compose --help.'); return 2; }
if (!flowOnly) {
  const raw = analyzeWithPkgxray({ root, entry, scannerRoot });
  const { verdict, ...flow } = raw.compose;
  const report = automaticFlow.toBinaryResult({ ...raw, compose: { ...flow, analysisStatus: verdict === 'review' ? 'flow-found' : verdict } });
  console.log(json ? JSON.stringify(report, null, 2) : renderIntegration(report));
  return integrationExitCode(report);
} else {
  const { verdict, ...flow } = analyzeProject({ root, entry });
  const report = { ...flow, analysisStatus: verdict === 'review' ? 'flow-found' : verdict, authorization: { installAllowed: false } };
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    // Escape control characters in source-controlled strings before printing.
    const safe = value => JSON.stringify(String(value)).slice(1, -1);
    console.log(`compose-ray: ${report.analysisStatus}\nCoverage: ${report.coverage}`);
    for (const finding of report.findings) {
      console.log(`\nFLOW ${finding.crossPackage ? 'cross-package' : 'local'} sensitive data → network`);
      for (const step of finding.trace) console.log(`  ${step.kind}: ${safe(step.label)} — ${safe(step.package.name)}@${safe(step.package.version)} [${safe(step.package.id)}] ${safe(step.file)}:${step.line}:${step.column}`);
      if (finding.destination) console.log(`  Destination: ${safe(finding.destination)}`);
    }
    for (const item of report.gaps) console.log(`\nINCOMPLETE ${safe(item.code)}: ${safe(item.message)}${item.file ? ` (${safe(item.file)})` : ''}`);
    console.log(`\n${report.scope}`);
  }
  return report.analysisStatus === 'incomplete' || report.findings.length ? 2 : 0;
}

}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
