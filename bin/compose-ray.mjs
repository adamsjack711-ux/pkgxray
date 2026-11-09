#!/usr/bin/env node
import { analyzeProject } from '../src/analyze.mjs';

const args = process.argv.slice(2);
if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
  console.log('Usage: compose-ray <source-root> [--entry relative/file.js] [--json]\n\nReads package-lock.json and local sources without executing target code.\nExit codes: 0 no modeled flow, 1 review finding, 2 incomplete analysis/invalid usage.');
  process.exit(0);
}
let root, entry = 'index.js', json = false;
const seen = new Set();
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--json' && !seen.has(arg)) { json = true; seen.add(arg); }
  else if (arg === '--entry' && !seen.has(arg) && args[i + 1] && !args[i + 1].startsWith('-')) { entry = args[++i]; seen.add(arg); }
  else if (!arg.startsWith('-') && !root) root = arg;
  else { console.error('Invalid arguments. Run compose-ray --help.'); process.exit(2); }
}
if (!root) { console.error('Source root is required. Run compose-ray --help.'); process.exit(2); }
const report = analyzeProject({ root, entry });
if (json) console.log(JSON.stringify(report, null, 2));
else {
  // Escape control characters in source-controlled strings before printing.
  const safe = value => JSON.stringify(String(value)).slice(1, -1);
  console.log(`compose-ray: ${report.verdict}\nCoverage: ${report.coverage}`);
  for (const finding of report.findings) {
    console.log(`\nREVIEW ${finding.crossPackage ? 'cross-package' : 'local'} sensitive data → network`);
    for (const step of finding.trace) console.log(`  ${step.kind}: ${safe(step.label)} — ${safe(step.package.name)}@${safe(step.package.version)} [${safe(step.package.id)}] ${safe(step.file)}:${step.line}:${step.column}`);
    if (finding.destination) console.log(`  Destination: ${safe(finding.destination)}`);
  }
  for (const item of report.gaps) console.log(`\nINCOMPLETE ${safe(item.code)}: ${safe(item.message)}${item.file ? ` (${safe(item.file)})` : ''}`);
  console.log(`\n${report.scope}`);
}
process.exitCode = report.verdict === 'incomplete' ? 2 : report.findings.length ? 1 : 0;
