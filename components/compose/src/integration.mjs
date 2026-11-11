import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { analyzeProject } from './analyze.mjs';
import { Project, sha256 } from './project.mjs';

const worker = fileURLToPath(new URL('./pkgxray-worker.mjs', import.meta.url));
const PARTIAL = 'Only manifests and source files selected by Compose-ray were supplied; other files and entrypoints were not inventoried.';
const verdicts = new Set(['safe', 'review', 'block']);

// Re-read through the same bounded, link-rejecting reader and compare against
// the flow scan. The two engines must consume the same recorded file bytes.
function evidenceFor(root, flow) {
  const gaps = [];
  const project = new Project(root, flow.limits, (code, message) => gaps.push({ code, message }));
  if (project.lockfileSha256 !== flow.lockfileSha256) throw new Error('Lockfile changed between scans.');
  const packages = flow.packages.map(pkg => {
    const sourceFiles = pkg.files.map(record => {
      if (project.owner(record.file).id !== pkg.id) throw new Error('Source package identity changed between scans.');
      const bytes = project.read(record.file);
      if (sha256(bytes) !== record.sha256) throw new Error(`Source changed between scans: ${record.file}`);
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const relative = pkg.id === '.' ? record.file : record.file.slice(pkg.id.length + 1);
      return { path: relative, content };
    });
    return { id: pkg.id, evidence: { packageName: pkg.name, sourceFiles,
      sourceCoverage: { complete: false, reasons: [PARTIAL] } } };
  });
  if (gaps.length) throw new Error(`Cannot bind pkgxray input to the flow snapshot: ${gaps[0].message}`);
  return packages;
}

function validateResult(result, expected) {
  if (result?.engine?.name !== 'pkgxray' || typeof result.engine.version !== 'string' ||
      !/^[a-f0-9]{64}$/.test(result.engine.buildId) || !Array.isArray(result.packages) || result.packages.length !== expected.length) {
    throw new Error('Unsupported pkgxray worker response.');
  }
  for (let i = 0; i < expected.length; i++) {
    const item = result.packages[i];
    if (item.id !== expected[i].id) throw new Error('pkgxray package instance mismatch.');
    if (item.status === 'failed' && typeof item.error === 'string') continue;
    const report = item.report;
    if (item.status !== 'completed' || report?.schemaVersion !== 1 || !verdicts.has(report.verdict) ||
        report.packageName !== expected[i].evidence.packageName || !Array.isArray(report.findings) ||
        !report.findings.every(f => f && ['info', 'low', 'medium', 'high'].includes(f.severity) &&
          ['category', 'file', 'snippet', 'rationale'].every(key => typeof f[key] === 'string'))) {
      throw new Error(`Unsupported pkgxray evidence report: ${item.id}`);
    }
    // Never permit an inconsistent low verdict to erase a high finding.
    if (report.findings.some(f => f.severity === 'high') && report.verdict !== 'block') {
      throw new Error(`Inconsistent pkgxray evidence verdict: ${item.id}`);
    }
  }
  return result;
}

export function analyzeWithPkgxray({ root, entry = 'index.js', scannerRoot, limits, timeoutMs = 30000 }) {
  if (typeof scannerRoot !== 'string' || !scannerRoot) throw new TypeError('An explicit trusted pkgxray path is required.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new TypeError('timeoutMs must be 1..30000.');
  return analyzeWithEngine({ root, entry, limits }, evidence => {
    const input = JSON.stringify(evidence);
    if (Buffer.byteLength(input) > 32 * 1024 * 1024) throw new Error('pkgxray input exceeded 32 MiB.');
    // No shell, network acquisition, target cwd, inherited NODE_OPTIONS, or
    // installation hooks. The selected scanner itself must be trusted.
    const env = {};
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) if (process.env[key]) env[key] = process.env[key];
    const child = spawnSync(process.execPath, [worker, path.resolve(scannerRoot)], {
      input, encoding: 'utf8', cwd: path.dirname(worker), env,
      timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
    });
    if (child.error || child.status !== 0) throw new Error(child.error?.message || child.stderr.trim() || 'pkgxray worker failed.');
    return JSON.parse(child.stdout);
  });
}

// Trusted in-process adapter for the bundled worker. Only scanner code supplies
// scanEvidence; it is never accepted as an MCP or target-project option.
export function analyzeWithEngine({ root, entry = 'index.js', limits }, scanEvidence) {
  const compose = analyzeProject({ root, entry, limits });
  const gaps = compose.gaps.map(gap => ({ engine: 'compose-ray', ...gap }));
  let pkgxray = { engine: null, status: 'failed', packages: [] };
  try {
    const evidence = evidenceFor(root, compose);
    const result = validateResult(scanEvidence(evidence), evidence);
    const failed = result.packages.filter(item => item.status !== 'completed');
    pkgxray = { ...result, status: failed.length ? 'partial' : 'completed' };
    for (const item of failed) gaps.push({ engine: 'pkgxray', code: 'package-scan-failed', packageId: item.id, message: item.error });
  } catch (error) {
    gaps.push({ engine: 'pkgxray', code: 'integration-error', message: String(error.message).slice(0, 1000) });
  }
  const blocking = pkgxray.packages.filter(item => item.report?.verdict === 'block').map(item => item.id);
  return {
    schemaVersion: 1, tool: 'pkgxray-compose', mode: 'pkgxray-composition',
    decision: 'block', authorization: { installAllowed: false },
    resolution: { reasonCodes: [blocking.length ? 'blocking-findings' : 'incomplete-checks'],
      explanation: blocking.length ? 'Blocked by package findings.' : 'Blocked because selected local source cannot establish complete package safety. This is not a confirmed malware finding.' },
    summary: blocking.length ? 'pkgxray found blocking evidence; composition results cannot clear it.'
      : compose.findings.length ? 'Environment data reaches a network call; the purpose of this transfer could not be verified.'
        : gaps.length ? 'Analysis could not complete; the reported gaps prevent authorization.'
          : 'No modeled flow found. Limited source coverage cannot authorize installation.',
    coverage: { status: 'partial', flow: compose.coverage, packageChecks: 'selected-source-files',
      registryIntegrityVerified: false, vulnerabilityCheck: 'not-run', provenanceCheck: 'not-run' },
    execution: gaps.length ? 'partial' : 'completed', blockingPackages: blocking,
    gaps, limitations: [PARTIAL, 'Local file hashes bind the two scans, not registry archives.',
      'This report supplies analysis evidence and never authorizes installation.'],
    compose, pkgxray,
  };
}

export function integrationExitCode(report) {
  return report.decision === 'allow' && report.authorization?.installAllowed === true ? 0 : 2;
}

export function renderIntegration(report) {
  const safe = value => JSON.stringify(String(value)).slice(1, -1);
  const lines = ['COMPOSE-RAY + PKGXRAY', 'Check the packages. Trace the connections.', '',
    `Decision: ${report.decision.toUpperCase()} | Coverage: ${report.coverage.status} | Execution: ${report.execution}`,
    report.summary, '', `Package checks: pkgxray ${safe(report.pkgxray.engine?.version || 'unavailable')} (${report.pkgxray.status})`];
  for (const item of report.pkgxray.packages) {
    const findings = item.report?.findings || [];
    const counts = ['high', 'medium', 'low', 'info'].map(level => `${findings.filter(f => f.severity === level).length} ${level}`).join(', ');
    lines.push(`  ${safe(item.id)}: ${item.report?.verdict.toUpperCase() || 'FAILED'} (${counts})`);
    for (const finding of item.report?.findings || []) {
      // Shared collection limits appear once below. Keep all original evidence
      // in JSON; foreground actionable package findings in the terminal.
      if (!['high', 'medium'].includes(finding.severity) || finding.category === 'incomplete-source-scan') continue;
      lines.push(`    ${finding.severity.toUpperCase()} ${safe(finding.category)} — ${safe(finding.file)}: ${safe(finding.rationale)}`);
    }
  }
  lines.push('', `Connections: ${report.compose.analysisStatus || (report.compose.verdict === 'review' ? 'flow-found' : report.compose.verdict)} (${report.compose.findings.length} flow(s))`);
  for (const finding of report.compose.findings) {
    lines.push(`  ${finding.crossPackage ? 'CROSS-PACKAGE' : 'LOCAL'} environment data → network`);
    for (const step of finding.trace) lines.push(`    ${step.kind}: ${safe(step.label)} — ${safe(step.package.name)}@${safe(step.package.version)} [${safe(step.package.id)}] ${safe(step.file)}:${step.line}:${step.column}`);
    if (finding.destination) lines.push(`    Destination: ${safe(finding.destination)}`);
  }
  for (const gap of report.gaps) lines.push(`  GAP ${safe(gap.engine)}/${safe(gap.code)}: ${safe(gap.message)}`);
  lines.push('', ...report.limitations, 'Install approval: not issued. Full package evidence: --json.');
  return lines.join('\n');
}
