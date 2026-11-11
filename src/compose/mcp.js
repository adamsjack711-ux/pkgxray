'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { Worker } = require('node:worker_threads');
const { failure } = require('./audit');
const MAX_BYTES = 1024 * 1024;
const OVERRIDES = ['compose.override.yaml', 'compose.override.yml', 'docker-compose.override.yaml', 'docker-compose.override.yml'];

// Paths are authorized by the MCP host, never by a tool argument. Do not follow
// a replaced final symlink or block while opening a FIFO/device. Same-privilege
// hostile filesystem mutation is outside the local server's trust boundary.
function readApproved(file, resolvePath) {
  const approved = resolvePath(file);
  if (!approved) throw new Error('input');
  const fd = fs.openSync(approved, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES || resolvePath(approved) !== approved) throw new Error('input');
    const current = fs.statSync(approved);
    if (stat.dev !== current.dev || stat.ino !== current.ino) throw new Error('input');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0, count;
    do {
      count = fs.readSync(fd, buffer, size, buffer.length - size, null);
      size += count;
    } while (count && size < buffer.length);
    if (size > MAX_BYTES) throw new Error('input');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
  } finally { fs.closeSync(fd); }
}

function analyzeInWorker(source, options, { timeoutMs = 5000 } = {}) {
  return new Promise(resolve => {
    let report, failed = false;
    const worker = new Worker(path.join(__dirname, 'worker.js'), {
      workerData: { source, options },
      resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
      stdout: true, stderr: true
    });
    // Engine diagnostics must never become a second MCP frame or leak source.
    worker.stdout.resume(); worker.stderr.resume();
    const timer = setTimeout(() => { failed = true; void worker.terminate(); }, timeoutMs);
    worker.on('message', value => { report = value; });
    worker.on('error', () => { failed = true; });
    worker.on('exit', code => {
      clearTimeout(timer);
      resolve(!failed && code === 0 && report ? report : failure('Compose analysis did not complete within its resource limits. No deployment was approved.'));
    });
  });
}

async function auditComposeFile(file, { resolvePath, policyPath } = {}) {
  try {
    const source = readApproved(file, resolvePath);
    // Only the trusted host environment selects suppression policy. A caller
    // cannot choose policy files or inherit package allowlists/muted findings.
    const policy = policyPath === undefined ? undefined : JSON.parse(readApproved(policyPath, resolvePath));
    const limitations = [];
    if (OVERRIDES.some(name => {
      const sibling = path.join(path.dirname(file), name);
      if (sibling === file) return false;
      try { fs.lstatSync(sibling); return true; } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return false;
      }
    })) limitations.push('A conventional sibling override file exists. It was not loaded or merged; this report does not describe the combined deployment.');
    const report = await analyzeInWorker(source, { file, policy, limitations });
    // Keep the real path inside analysis for lexical relative-mount handling,
    // but never return host directories or secret-bearing file identifiers.
    for (const finding of report.findings) if (finding.file !== null) finding.file = '<compose>';
    return { ...report, installationApproved: false, deploymentApproved: false };
  } catch {
    return { ...failure('Could not read the Compose input or operator policy as bounded regular UTF-8 files within approved roots. No suppressions or approval were applied.'),
      installationApproved: false, deploymentApproved: false };
  }
}

module.exports = { auditComposeFile, analyzeInWorker };
