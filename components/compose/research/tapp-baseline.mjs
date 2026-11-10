// Read-only baseline. This imports scanners, never Tapp or its dependencies.
// Private source snippets in combined JSON should remain in local reports.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { analyzeProject } from '../src/analyze.mjs';
import { analyzeWithPkgxray } from '../src/integration.mjs';

const entries = [
  { id: 'application', entry: 'src/server.mjs' },
  { id: 'apple-sign-in', entry: 'src/apple-auth.mjs' },
  { id: 'voice-upstream', entry: 'src/voice.mjs' },
];

export function tappBaseline({ root, scannerRoot }) {
  const cases = entries.map(item => {
    const report = scannerRoot ? analyzeWithPkgxray({ root, entry: item.entry, scannerRoot })
      : analyzeProject({ root, entry: item.entry });
    const flow = report.compose || report;
    const sourceCollected = flow.packages.some(pkg => pkg.files.some(file => file.file === item.entry));
    return { ...item, sourceCollected, flow: flow.verdict, flowFindings: flow.findings.length,
      gapCodes: [...new Set((report.gaps || []).map(gap => gap.code))],
      packageChecks: report.pkgxray?.status || 'not-requested', report };
  });
  return { schemaVersion: 1, target: 'tapp-backend',
    scope: 'Selected entrypoint coverage baseline, not a complete application scan or proof of a credential route.',
    cases };
}

export function baselineExitCode(baseline) {
  if (baseline.cases.some(item => item.gapCodes.length || item.report.decision === 'block')) return 2;
  return baseline.cases.some(item => item.flowFindings || item.report.decision === 'review') ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  let root, scannerRoot, json = false;
  const seen = new Set();
  let invalid = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !seen.has(arg)) { json = true; seen.add(arg); }
    else if (arg === '--pkgxray' && !seen.has(arg) && args[i + 1] && !args[i + 1].startsWith('-')) {
      scannerRoot = args[++i]; seen.add(arg);
    } else if (!arg.startsWith('-') && !root) root = arg;
    else invalid = true;
  }
  if (!root || invalid) {
    console.error('Usage: npm run baseline:tapp -- /path/to/tapp-backend [--pkgxray /trusted/pkgxray] [--json]');
    process.exitCode = 2;
  } else {
    const report = tappBaseline({ root, scannerRoot });
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log('TAPP BACKEND — COVERAGE BASELINE');
      for (const item of report.cases) {
        console.log(`${item.id.padEnd(16)} flow=${item.flow} source=${item.sourceCollected ? 'collected' : 'unavailable'} pkgxray=${item.packageChecks}`);
        console.log(`  findings=${item.flowFindings} gaps=${item.gapCodes.join(', ') || 'none'}`);
      }
      console.log(report.scope);
    }
    process.exitCode = baselineExitCode(report);
  }
}
