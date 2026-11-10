'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const run = require('node:util').promisify(execFile);

test('audit regressions: recheck revocation, build drift, cancelled MCP triage and terminal controls', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pkgxray-regressions-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'results.json');
  const script = path.resolve(__dirname, '../examples/folder-report/checks/audit-repro.cjs');
  await run(process.execPath, [script], { timeout: 30000, env: { ...process.env, PKGXRAY_AUDIT_RESULTS: output } });
  const report = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.equal(report.observations.length, 4);
  for (const result of report.observations) assert.equal(result.passed, true, result.name);
});
