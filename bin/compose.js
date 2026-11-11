#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { audit, render, failure } = require('../src/compose/audit');
const { MAX_BYTES } = require('../src/compose/parse');
const { version } = require('../src/compose/metadata.json');

const HELP = `Usage: pkgxray compose --file compose.yaml [--format text|json] [--policy policy.json]

Read-only, offline audit of one explicit Compose file. YAML anchors and merge
keys are supported. Variables, includes and multi-file overrides are not resolved.
No Docker commands, shell substitutions, project scripts, or network calls run.

  -f, --file PATH     Required, one UTF-8 YAML file (at most 1 MiB)
  --format text|json  Readable text (default) or schemaVersion 1 JSON
  --policy PATH      Explicit JSON suppressions with exact rule/service and reason
  -h, --help         Show this help
  --version          Show version

Exit codes: 0 no active review findings; 2 findings; 3 incomplete; 1 input/policy/usage error.
Errors take precedence over incompleteness, which takes precedence over findings.
Informational loopback findings and suppressed findings do not fail the audit.
`;

function readBounded(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('file');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0, n;
    do { n = fs.readSync(fd, buffer, size, buffer.length - size, null); size += n; } while (n && size < buffer.length);
    if (size > MAX_BYTES) throw new Error('size');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0,size));
  } finally { fs.closeSync(fd); }
}

function main(argv) {
  let format = argv.some((a,i) => a === '--format' && argv[i + 1] === 'json') ? 'json' : 'text';
  let file, policyFile, report;
  const files = [];
  const seen = new Set();
  try {
    if (argv.length === 1 && ['--help','-h'].includes(argv[0])) { process.stdout.write(HELP); return 0; }
    if (argv.length === 1 && argv[0] === '--version') { process.stdout.write(`${version}\n`); return 0; }
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (!['--file','-f','--policy','--format'].includes(arg) || !argv[i+1] || argv[i+1].startsWith('--')) throw new Error('usage');
      const value = argv[++i];
      if (arg === '--file' || arg === '-f') files.push(value);
      else {
        if (seen.has(arg)) throw new Error('usage');
        seen.add(arg);
        if (arg === '--policy') policyFile = value;
        else if (['text','json'].includes(value)) format = value;
        else throw new Error('usage');
      }
    }
    if (!files.length) throw new Error('usage');
    if (files.length > 1) {
      report = audit('services: { audit_input: {} }', {
        file: '<multiple-inputs>', limitations: ['Multiple Compose files are not merged. No supplied file was audited; provide one already combined literal configuration.']
      });
    } else {
      file = files[0];
      let source, policy;
      try { source = readBounded(file); } catch { report = failure('Could not read the Compose input as a regular UTF-8 file of at most 1 MiB.'); }
      if (!report && policyFile) {
        try { policy = JSON.parse(readBounded(policyFile)); }
        catch { report = failure('Could not read or parse the explicit JSON policy. No suppressions were applied.', 'policy'); }
      }
      if (!report) {
        const limitations = [];
        // Do not load these files. Their presence warns against confusing this
        // explicit-file audit with Compose's automatic default-file behavior.
        const dir = path.dirname(path.resolve(file));
        const defaults = ['compose.override.yaml','compose.override.yml','docker-compose.override.yaml','docker-compose.override.yml'];
        if (defaults.some(name => path.resolve(dir,name) !== path.resolve(file) && fs.existsSync(path.join(dir,name)))) {
          limitations.push('A conventional sibling override file exists. It was not loaded or merged; this report does not describe the combined deployment.');
        }
        report = audit(source,{file,policy,limitations});
      }
    }
  } catch {
    // Never echo arguments, parser source, exception messages, or stack traces.
    report = failure('Invalid CLI arguments or an input processing failure. Run pkgxray compose --help.', 'usage');
  }
  process.stdout.write(format === 'json' ? `${JSON.stringify(report,null,2)}\n` : render(report));
  return report.exitCode;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main, readBounded };
