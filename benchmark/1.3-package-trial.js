'use strict';

// Read-only live release trial. Registry packages remain inert scanner inputs.
// Selection is frozen separately, before results are known. Never omit failures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const { computeBuildId, fingerprint } = require('../src/artifact');
const cfg = require('../src/config');
const manifestPath = path.join(__dirname, '1.3-package-cohort.json');
const manifestBytes = fs.readFileSync(manifestPath);
const cohort = JSON.parse(manifestBytes);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function client(cwd, env) {
  const child = spawn(process.execPath, [path.join(root, 'bin/mcp-server.js')], {
    cwd, env, stdio: ['pipe', 'pipe', 'pipe']
  });
  let id = 0, buffer = '';
  const pending = new Map();
  const fail = error => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  child.stderr.resume(); // Do not persist service logs or package-controlled text.
  child.on('error', fail);
  child.on('exit', () => fail(new Error('MCP child exited')));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', text => {
    buffer += text;
    if (buffer.length > 8 * 1024 * 1024) { fail(new Error('MCP response exceeds harness bound')); child.kill(); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      let message;
      try { message = JSON.parse(buffer.slice(0, end)); }
      catch { fail(new Error('MCP emitted invalid JSON')); child.kill(); return; }
      buffer = buffer.slice(end + 1);
      const request = pending.get(message.id);
      if (request) { clearTimeout(request.timer); pending.delete(message.id); request.resolve(message); }
    }
  });
  return {
    request(method, params) {
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => {
          pending.delete(requestId); reject(new Error('MCP request exceeded 65 seconds')); child.kill();
        }, 65000);
        pending.set(requestId, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
      });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill(); const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { await exited; } finally { clearTimeout(timer); }
    }
  };
}

function summarize(item, response, buildId, policySha256) {
  if (response.error) return { reference: item.reference, group: item.group, status: 'rpc-error', code: response.error.code };
  const result = response.result?.structuredContent;
  if (!result?.assessment || !result.report) return { reference: item.reference, group: item.group, status: 'scan-error', isError: response.result?.isError === true };
  assert.equal(result.assessment.engine.buildId, buildId, 'scanner build changed');
  assert.equal(result.assessment.policySha256, policySha256, 'effective policy differs');
  assert.equal(result.assessment.effectivePolicy, 'safe-only');
  assert.equal(result.assessment.artifact.name, item.name);
  assert.equal(result.assessment.artifact.version, item.version);
  assert.equal(result.assessment.artifact.integrity, item.integrity, 'frozen registry integrity changed');
  assert.equal(result.assessment.authorization.explicitOverride, false);
  assert.equal(result.sourceEvidence.contentReturned, false);
  const findings = result.report.findings || [];
  const grouped = {};
  for (const finding of findings) {
    const key = `${finding.severity}:${finding.category}`;
    grouped[key] = (grouped[key] || 0) + 1;
  }
  return {
    reference: item.reference, group: item.group, status: 'completed',
    artifactSha256: result.assessment.artifact.sha256,
    scannerBuildId: result.assessment.engine.buildId, policySha256: result.assessment.policySha256,
    rawVerdict: result.assessment.rawVerdict, verdict: result.report.verdict,
    decision: result.decision, allowed: result.allowed, outcome: result.outcome,
    checks: result.assessment.checks, authorization: result.assessment.authorization,
    coverage: {
      complete: result.sourceCoverage?.complete, scannedFiles: result.sourceCoverage?.scannedFiles,
      skippedFiles: result.sourceCoverage?.skippedFiles, truncatedFiles: result.sourceCoverage?.truncatedFiles,
      // Public package paths only; no source excerpts or full reports are saved.
      reasons: (result.sourceCoverage?.reasons || []).slice(0, 20),
      reasonCount: result.sourceCoverage?.reasons?.length || 0
    },
    findings: grouped,
    findingLocations: findings.filter(f => ['medium', 'high'].includes(f.severity))
      .slice(0, 12).map(f => ({ category: f.category, severity: f.severity, file: f.file })),
    vulnerabilities: {
      completed: result.vulnerabilityPrecheck?.completed,
      count: result.vulnerabilityPrecheck?.vulnerabilityCount,
      ids: (result.vulnerabilityPrecheck?.vulnerabilities || []).map(v => v.id).filter(Boolean)
    },
    review: result.review && { state: result.review.state, eligible: result.review.eligible },
    reviewPlan: result.reviewPlan && {
      state: result.reviewPlan.state, blockers: result.reviewPlan.blockers,
      escalation: result.reviewPlan.escalation?.to, steps: result.reviewPlan.steps.map(step => step.id)
    }
  };
}

async function main() {
  const [mode, expectedBuild, output] = process.argv.slice(2);
  assert.ok(mode === '--self-check' || (mode === '--run' && /^[a-f0-9]{64}$/.test(expectedBuild) && output),
    'Usage: node benchmark/1.3-package-trial.js --self-check | --run <expected-build-id> <new-output.json>');
  const buildId = computeBuildId(root);
  if (mode === '--run') assert.equal(buildId, expectedBuild, 'settled runtime build required');
  assert.equal(cohort.cases.length, 11);
  assert.equal(new Set(cohort.cases.map(item => item.reference)).size, 11);
  for (const item of cohort.cases) assert.equal(item.reference, `npm:${item.name}@${item.version}`);
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'pkgxray-1.3-trial-'));
  // Explicit empty config prevents ancestor configuration from changing defaults.
  await fsp.writeFile(path.join(cwd, '.pkgxray.json'), '{}\n');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('PKGXRAY_') && !['NODE_OPTIONS', 'NODE_PATH', 'GH_TOKEN', 'GITHUB_TOKEN'].includes(key)));
  env.PKGXRAY_MCP_ALLOWED_ROOTS = cwd;
  const loaded = cfg.loadConfig({ cwd, env });
  assert.deepEqual(loaded.warnings, []);
  assert.deepEqual(loaded.config, cfg.DEFAULTS);
  const policySha256 = fingerprint(loaded.config);
  const service = client(cwd, env);
  const report = {
    schemaVersion: 1, startedAt: new Date().toISOString(), completedAt: null,
    complete: false, manifestSha256: sha256(manifestBytes), scannerBuildId: buildId,
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    packageVersion: require('../package.json').version,
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    transport: 'real stdio MCP launcher', targetExecution: false, configuration: loaded.config,
    policySha256, directDependenciesRequested: false,
    limitations: ['Convenience cohort, not independently adjudicated benign or representative of npm.',
      'Static scans only; target lifecycle scripts and MCP servers are never started.',
      'No dependency graph scan, VM run, install action, or human review override.',
      'Advisories and external metadata are time-dependent; existing metadata caches may be used.',
      'No throughput or latency claim; runs include live network services.'],
    results: []
  };
  const outputPath = output && path.resolve(output);
  let ownsOutput = false;
  const save = () => { if (ownsOutput) fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n'); };
  try {
    const init = await service.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pkgxray-1.3-trial', version: '1' } });
    assert.equal(init.result.serverInfo.version, report.packageVersion);
    const tools = await service.request('tools/list', {});
    assert.ok(tools.result.tools.some(tool => tool.name === 'guard_agent_extension_install'));
    if (mode === '--self-check') {
      const response = await service.request('tools/call', { name: 'audit_agent_extension_supply_chain', arguments: {
        packageName: 'inert-trial', sourceFiles: { 'package.json': '{"name":"inert-trial","version":"1.0.0","main":"index.js"}', 'index.js': 'exports.add=(a,b)=>a+b;' }, outputFormat: 'json'
      } });
      assert.equal(response.result.structuredContent.verdict, 'safe');
      console.log('Harness self-check passed: pinned cohort, default config and real MCP inert audit.'); return;
    }
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); ownsOutput = true;
    for (const item of cohort.cases) {
      assert.equal(computeBuildId(root), buildId, 'runtime changed before case');
      const response = await service.request('tools/call', { name: 'guard_agent_extension_install', arguments: { reference: item.reference, outputFormat: 'json' } });
      assert.equal(computeBuildId(root), buildId, 'runtime changed during case');
      const result = summarize(item, response, buildId, policySha256);
      report.results.push(result); save();
      console.log(`${item.reference}: ${result.status} ${result.decision || ''}`);
    }
    assert.equal(computeBuildId(root), buildId);
    report.complete = report.results.length === cohort.cases.length;
    report.completedAt = new Date().toISOString(); save();
  } catch (error) {
    report.failure = { name: error.name, reason: 'Harness or identity assertion failed; inspect local error. Retain incomplete run.' }; save();
    throw error;
  } finally { await service.close(); await fsp.rm(cwd, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
