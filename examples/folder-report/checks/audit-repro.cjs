'use strict';
// Audit reproductions. Failed security assertions deliberately exit nonzero.
// Only disposable fixtures are changed; scanner/proxy doubles are labeled.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { start } = require('../../../test/helpers/mcp-load-client');
const root = path.resolve(__dirname, '../../..');
const observations = [];
function check(name, classification, observed, assertion) {
  try { assertion(); observations.push({ name, classification, passed: true, observed }); }
  catch (error) { observations.push({ name, classification, passed: false, observed, assertion: error.message }); }
}
(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pkgxray-audit-'));
  try {
    const missing = path.join(dir, 'missing\u001b[2J\nFAKE-SAFE');
    const cli = spawnSync(process.execPath, [path.join(root, 'examples/folder-report/app/index.js'), missing], { encoding: 'utf8' });
    check('CLI errors escape terminal controls', 'fixture-only; actual CLI subprocess',
      { exit: cli.status, stderr: cli.stderr, containsEscape: cli.stderr.includes('\u001b') },
      () => assert.ok(!cli.stderr.includes('\u001b'), 'stderr must not contain raw ESC bytes'));

    // Copy the runtime so the user's checkout is never modified by drift tests.
    const copy = path.join(dir, 'checkout');
    await fs.mkdir(copy);
    for (const name of ['src', 'bin', 'package.json', 'examples/pkgxray-proxy']) {
      await fs.cp(path.join(root, name), path.join(copy, name), { recursive: true });
    }
    const imp = relative => import(pathToFileURL(path.join(copy, relative)).href);
    const { gateArtifact } = await imp('examples/pkgxray-proxy/src/artifact-gate.js');
    const { adminRecheck } = await imp('examples/pkgxray-proxy/src/proxy.js');
    const { VerdictStore } = await imp('examples/pkgxray-proxy/src/verdict-store.js');
    const { loadConfig } = await imp('examples/pkgxray-proxy/src/config.js');
    const { withReceipt } = await imp('examples/pkgxray-proxy/test/receipt-helper.js');
    const artifact = require(path.join(copy, 'src/artifact.js'));
    const policy = require(path.join(copy, 'src/config.js'));
    const file = path.join(dir, 'inert.tgz');
    const bytes = Buffer.from('inert audit fixture; never executed or extracted');
    await fs.writeFile(file, bytes);
    const snapshot = { file, sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex') };
    const config = loadConfig({ verdictStorePath: path.join(dir, 'verdicts.json') }, {});
    const store = new VerdictStore(config.verdictStorePath);
    let scans = 0;
    const runGuard = withReceipt(async () => { scans++; return { decision: 'allow', findings: [] }; });
    const gate = () => gateArtifact({ config, store, name: 'audit-fixture', version: '1.0.0', snapshot, runGuard, sharedPolicy: policy.DEFAULTS });
    assert.equal((await gate()).serve, true);
    const recheck = await adminRecheck({ config, store, runGuard: async () => ({ decision: 'block', findings: [{ reason: 'new blocking evidence' }] }) });
    const afterRecheck = await gate();
    check('Admin recheck block invalidates deliverable artifact evidence', 'fixture-only; production gate/cache/admin functions; stubbed scanner receipts',
      { recheck, packageIndexDecision: store.get('audit-fixture', '1.0.0').decision, deliveryAllowed: afterRecheck.serve, deliverySource: afterRecheck.source, scans },
      () => assert.equal(afterRecheck.serve, false, 'a new block must invalidate cached delivery approval'));
    // Isolate build drift from the preceding admin-recheck observation.
    const driftStore = new VerdictStore(path.join(dir, 'drift-verdicts.json'));
    const driftGate = () => gateArtifact({ config, store: driftStore, name: 'audit-fixture', version: '1.0.0', snapshot, runGuard, sharedPolicy: policy.DEFAULTS });
    assert.equal((await driftGate()).serve, true);
    const scansBeforeChange = scans;
    await fs.appendFile(path.join(copy, 'src/config.js'), '\n// Simulated scanner/rules build update in disposable copy.\n');
    const changed = artifact.computeBuildId(copy) !== artifact.BUILD_ID;
    assert.equal(changed, true);
    const afterBuildChange = await driftGate();
    check('Changed scanner build invalidates proxy delivery approval', 'fixture-only; production gate/cache; copied runtime mutated; stubbed scanner receipt',
      { buildChanged: changed, deliveryAllowed: afterBuildChange.serve, deliverySource: afterBuildChange.source, newScans: scans - scansBeforeChange },
      () => assert.equal(afterBuildChange.serve, false, 'changed scanner bytes must prevent old approval reuse'));

    const triageDir = path.join(dir, 'triage');
    await fs.mkdir(triageDir);
    const manifest = path.join(triageDir, 'package.json');
    await fs.writeFile(manifest, JSON.stringify({ name: 'audit-fixture', dependencies: { 'inert-dependency': '1.0.0' } }));
    const preload = path.join(dir, 'hold-advisory.cjs');
    await fs.writeFile(preload, `
const http = require(${JSON.stringify(path.join(root, 'src/http-client.js'))});
http.requestJson = async (url, options) => {
  if (url !== 'https://api.osv.dev/v1/querybatch') throw new Error('Unexpected network URL');
  process.send({ type: 'audit-advisory-started' });
  await new Promise(resolve => { const listener = message => { if (message.type === 'audit-release') { process.off('message', listener); resolve(); } }; process.on('message', listener); });
  return { results: JSON.parse(options.body).queries.map(() => ({ vulns: [] })) };
};
`);
    const client = start('static', { cwd: triageDir, execArgv: ['--require', preload], env: { ...process.env, PKGXRAY_MCP_ALLOWED_ROOTS: triageDir } });
    try {
      await client.init();
      const started = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Advisory barrier timed out')), 10000);
        const listener = message => { if (message.type === 'audit-advisory-started') { clearTimeout(timer); client.child.off('message', listener); resolve(); } };
        client.child.on('message', listener);
      });
      const response = client.request('tools/call', { name: 'triage_lockfile_supply_chain', arguments: { lockfilePath: manifest, auto: 'allow', includeSafe: true, outputFormat: 'json' } });
      await started;
      client.notify('notifications/cancelled', { requestId: response.id });
      await client.request('ping', {}); // Same stdio stream: cancellation already processed.
      client.child.send({ type: 'audit-release' });
      const reply = await response;
      let written = null;
      try { written = JSON.parse(await fs.readFile(path.join(triageDir, '.pkgxray.lock'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      check('Cancelled MCP triage does not persist new allow decisions', 'stubbed-network; real MCP stdio, triage and filesystem; OSV response held until after cancellation',
        { responseError: reply.error, written },
        () => { assert.equal(reply.error?.code, -32800); assert.equal(written, null, 'cancelled triage must not write approvals'); });
    } finally { await client.close(); }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
  const report = { measuredAt: new Date().toISOString(), realNetworkUsed: false, observations };
  await fs.writeFile(process.env.PKGXRAY_AUDIT_RESULTS || path.join(__dirname, 'audit-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (observations.some(item => !item.passed)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
