import fs from 'node:fs';
const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.log('## Public MCP checks\n\nNo report was produced. Inspect the job log for a startup or runner failure.');
} else {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const escape = text => String(text).replace(/[<>|\r\n]/g, ' ');
  console.log(`## Public MCP checks: ${report.passed ? 'PASS' : 'FAIL'}\n\nEndpoint: ${escape(report.endpoint)}\n\nTotal: ${report.durationMs ?? 'unavailable'} ms\n\n| Check | Result | Time |\n|---|---|---|`);
  for (const check of report.checks) console.log(`| ${escape(check.name)} | ${check.passed ? 'PASS' : 'FAIL'} | ${check.ms ?? '—'} ms |`);
  for (const check of report.checks.filter(check => !check.passed)) console.log(`\nFailure: ${escape(check.name)} — ${escape(check.error)}`);
  console.log('\nTimings are single-run observations, not a load test or availability guarantee. Samples are inert text; no package code is executed.');
}
