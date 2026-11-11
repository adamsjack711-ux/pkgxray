"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { auditEvidence, normalizeEvidence } = require('../src/auditor');
const { proveLiteralLifecycle } = require('../src/lifecycle-evidence');
const { collectSourceEvidence, guardExtension } = require('../src/quarantine');

const message = "console.log('setup skipped');";
function evidence(source = message, command = 'node ./install.js', extra = {}) {
  return { packageName: 'arbitrary-name', sourceFiles: {
    'package.json': JSON.stringify({ name: 'arbitrary-name', version: '1.0.0', scripts: { postinstall: command } }),
    'install.js': source
  }, ...extra };
}
const hook = report => report.findings.find(f => f.category === 'install-hook');
const prove = raw => proveLiteralLifecycle('node ./install.js', 'package.json', normalizeEvidence(raw));

test('both relative Node command spellings inspect the same exact script', () => {
  for (const directory of ['', 'workspace/']) {
    for (const script of ['install.js', 'scripts/install.cjs', 'scripts/install.mjs']) {
      const proofs = [];
      for (const prefix of ['./', '']) {
        const command = `node ${prefix}${script}`;
        const input = { sourceFiles: {
          [`${directory}package.json`]: JSON.stringify({ name: 'demo', scripts: { postinstall: command } }),
          [directory + script]: message
        } };
        const report = auditEvidence(input);
        assert.equal(hook(report).severity, 'info', `${directory}: ${command}`);
        assert.equal(report.verdict, 'safe', `${directory}: ${command}`);
        assert.ok(!report.findings.some(f => f.category === 'unresolved-runtime-execution'));
        const proof = hook(report).lifecycleProof;
        assert.equal(proof.command, command, 'retain the original command as evidence');
        assert.deepEqual(proof.script, { file: directory + script, source: message });
        proofs.push(proof);
      }
      const { command: firstCommand, ...first } = proofs[0];
      const { command: secondCommand, ...second } = proofs[1];
      assert.notEqual(firstCommand, secondCommand);
      assert.deepEqual(first, second, 'only the recorded spelling differs');
    }
  }
});

test('bare relative commands retain all evidence and interpreter safeguards', () => {
  for (const command of ['node ./install.js', 'node install.js']) {
    const missing = evidence(message, command); delete missing.sourceFiles['install.js'];
    const shim = evidence(message, command);
    shim.sourceFiles['dependency/package.json'] = '{"name":"node","bin":"shim.js"}';
    const duplicate = evidence(message, command);
    duplicate.sourceFiles = [
      { path: 'package.json', content: duplicate.sourceFiles['package.json'] },
      { path: 'install.js', content: message }, { path: 'install.js', content: "require('./hidden.js');" }
    ];
    for (const input of [missing, shim, duplicate,
      evidence("console.log('ok'); require('fs').readFileSync(process.env.HOME+'/.ssh/id_rsa');", command),
      evidence("if (process.env.CI) console.log('ok'); else require('./hidden.js');", command),
      evidence(message, command, { sourceCoverage: { complete: false, truncatedFiles: 1 } })]) {
      assert.equal(proveLiteralLifecycle(command, 'package.json', normalizeEvidence(input)), null);
      assert.equal(hook(auditEvidence(input)).severity, 'medium');
      assert.notEqual(auditEvidence(input).verdict, 'safe');
    }
  }
});

test('bare command parsing rejects options, shell syntax and ambiguous paths', () => {
  for (const command of ['node -install.js', 'node --eval.js', 'node -r hidden.js install.js',
    'node --import hidden.js install.js', 'node install.js extra', 'node install.js && node hidden.js',
    'node install.js;node hidden.js', 'node install.js|sh', 'node install.js\nnode hidden.js',
    'node install.js\n', 'node install.js\r\n', 'node install.js ', 'node  install.js',
    'node scripts/../install.js', 'node node_modules/install.js', 'node /install.js',
    'node ../install.js', 'node scripts//install.js', 'node scripts\\install.js',
    'node "install.js"', 'node $SCRIPT.js', 'node $(echo install.js)']) {
    assert.equal(proveLiteralLifecycle(command, 'package.json', normalizeEvidence(evidence(message, command))), null, command);
    assert.equal(hook(auditEvidence(evidence(message, command))).severity, 'medium', command);
  }
  for (const script of ['-install.js', '--eval.js']) {
    const input = normalizeEvidence(evidence());
    input.sourceFiles.push({ path: script, content: message });
    assert.ok(proveLiteralLifecycle(`node ./${script}`, 'package.json', input), 'explicit file path retains existing behavior');
    assert.equal(proveLiteralLifecycle(`node ${script}`, 'package.json', input), null, 'an existing file cannot turn an option into a script');
  }
});

test('complete literal logging and fixed CI checks carry replayable exact-source proof', () => {
  for (const source of [message, ';', "process.exit(0);", "#!/usr/bin/env node\nconsole.log('ok', 'done');",
    "if (process.env.CI || process.env.SKIP_DOWNLOAD) { console.log('skip'); process.exit(0); }",
    "if (!process.env.CI && process.env.SKIP_DOWNLOAD !== 'false') console.log('skip'); else { console.log('done'); }"
  ]) {
    const input = evidence(source);
    const report = auditEvidence(input);
    assert.equal(report.verdict, 'safe', source);
    assert.equal(hook(report).severity, 'info');
    const proof = hook(report).lifecycleProof;
    assert.equal(proof.kind, 'literal-node-lifecycle-v1');
    assert.equal(proof.command, 'node ./install.js');
    assert.deepEqual(proof.script, { file: 'install.js', source });
    assert.deepEqual(proof, prove(input), 'evidence consumers can replay the exact same bounded proof');
  }
});

test('a benign log never conceals other effects, aliases, calls, or unvisited branches', () => {
  const unsupported = [
    "console.log('ok'); require('fs').readFileSync(process.env.HOME+'/.ssh/id_rsa');",
    "process.exit(0); require('child_process').execSync('id');",
    "if (process.env.CI) console.log('ok'); else require('./hidden.js');",
    "console.log('ok'); process.env.CI = 'true';",
    "console.log('ok'); globalThis.console = { log() { require('./hidden.js'); } };",
    "const console = { log() { require('./hidden.js'); } }; console.log('ok');",
    "var process = { exit() { require('./hidden.js'); } }; process.exit(0);",
    "console.log('ok'); Object.defineProperty(process.env, 'CI', { get() { require('./hidden.js'); } });",
    "const f = console.log; f('ok');",
    "console['log']('ok');",
    "globalThis.console.log('ok');",
    "(0, console.log)('ok');",
    "console.log.call(null, 'ok');",
    "console.log(...['ok']);",
    "console.log(`ok`);",
    "console.log(`${require('./hidden.js')}`);",
    "console.log(process.env.NPM_TOKEN);",
    "if (process.env['CI']) console.log('ok');",
    "if (process.env.HOME) console.log('ok');",
    "if (process.env.CI || require('./hidden.js')) console.log('ok');",
    "if (process.env.CI) { function hidden() { require('./hidden.js'); } }",
    "console.log('ok'); import('./hidden.js');",
    "import './hidden.js'; console.log('ok');",
    "console?.log('ok');",
    "process.exit(1);",
    "console.log('\\u001b[2J');",
    "console.log('ok'); while (true) {}"
  ];
  for (const source of unsupported) {
    const input = evidence(source);
    assert.equal(prove(input), null, source);
    const report = auditEvidence(input);
    assert.equal(hook(report).severity, 'medium', source);
    assert.notEqual(report.verdict, 'safe', source);
  }
});

test('command proof excludes flags, preloads, shell composition, arguments and path ambiguity', () => {
  for (const command of ['node --require ./hidden.js ./install.js', 'node -r ./hidden.js ./install.js',
    'node --import ./hidden.js ./install.js', 'NODE_OPTIONS=--require=./hidden.js node ./install.js',
    'node ./install.js && node ./hidden.js', 'node ./install.js; node ./hidden.js',
    'node ./install.js | sh', 'node ./install.js\nnode ./hidden.js', 'node ./install.js extra',
    'node ../install.js', 'node ./../install.js', 'node /install.js', 'node ./scripts/../install.js',
    'node .\\install.js', 'node ./node_modules/install.js', 'node ./install', 'node "./install.js"',
    'node ./install.js ', 'node  ./install.js', 'node ./install.js\n', 'node $(echo ./install.js)']) {
    assert.equal(hook(auditEvidence(evidence(message, command))).severity, 'medium', command);
  }
});

test('missing, ambiguous, malformed, oversized and explicitly truncated evidence never proves a hook', () => {
  const missing = evidence(); delete missing.sourceFiles['install.js'];
  const duplicate = evidence(); duplicate.sourceFiles = [
    { path: 'package.json', content: duplicate.sourceFiles['package.json'] },
    { path: 'install.js', content: message }, { path: 'install.js', content: "require('./hidden.js')" }
  ];
  for (const input of [missing, duplicate, evidence(''), evidence("console.log('ok'); ???"), evidence(' '.repeat(16 * 1024) + message),
    evidence(message, undefined, { sourceCoverage: { complete: false, truncatedFiles: 1 } }),
    evidence(message, undefined, { sourceCoverage: { complete: true, truncatedFiles: 1 } }),
    evidence(message, undefined, { sourceCoverage: { complete: true, skippedFiles: 1 } }),
    evidence(message, undefined, { sourceCoverage: { complete: true, runtimeFiles: [] } })]) {
    assert.equal(prove(input), null);
    assert.equal(hook(auditEvidence(input)).severity, 'medium');
  }
});

test('AST and source budgets reject pathological proofs without partial traversal', () => {
  for (const source of [';'.repeat(1100), 'if(process.env.CI){'.repeat(40) + message + '}'.repeat(40)]) {
    assert.equal(prove(evidence(source)), null);
  }
});

test('every lifecycle hook is checked independently and a hostile neighbor remains blocked', () => {
  const scripts = { preinstall: 'node ./first.js', install: 'node ./second.js', postinstall: 'node ./install.js',
    prepack: 'node ./pack.js', prepare: 'node ./prepare.js', prepublish: 'node ./publish.js',
    preprepare: 'node ./preprepare.js', postprepare: 'node ./postprepare.js', postpack: 'node ./postpack.js' };
  const input = evidence();
  input.sourceFiles['package.json'] = JSON.stringify({ name: 'demo', scripts });
  for (const command of Object.values(scripts)) input.sourceFiles[command.slice('node ./'.length)] = message;
  let report = auditEvidence(input);
  assert.equal(report.verdict, 'safe');
  assert.equal(report.findings.filter(f => f.category === 'install-hook' && f.severity === 'info').length, 9);
  input.sourceFiles['first.js'] = "require('fs').readFileSync(process.env.HOME+'/.ssh/id_rsa');";
  report = auditEvidence(input);
  assert.equal(report.verdict, 'block');
  assert.equal(report.findings.filter(f => f.category === 'install-hook' && f.severity === 'medium').length, 1);
  assert.equal(report.findings.filter(f => f.category === 'install-hook' && f.severity === 'info').length, 8);
});

test('clearing a literal hook never clears vulnerability or required-coverage findings', () => {
  const vulnerable = auditEvidence(evidence(message, undefined, { knownVulnerabilities: [{ id: 'TEST-CVE', summary: 'known vulnerable dependency' }] }));
  assert.equal(hook(vulnerable).severity, 'info');
  assert.equal(vulnerable.verdict, 'block');
  const gap = auditEvidence(evidence(message, undefined, { sourceCoverage: { complete: false, reasons: ['truncated source'] } }));
  assert.notEqual(gap.verdict, 'safe');
  assert.ok(gap.findings.some(f => f.category === 'incomplete-source-scan'));
});

test('source collection rejects linked lifecycle files instead of trusting their visible target', { skip: process.platform === 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pkgxray-lifecycle-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'package'); await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'package.json'), evidence().sourceFiles['package.json']);
  await fs.writeFile(path.join(root, 'outside.js'), message);
  await fs.symlink('../outside.js', path.join(dir, 'install.js'));
  const collected = await collectSourceEvidence(dir);
  assert.equal(collected.coverage.complete, false);
  assert.equal(Object.hasOwn(collected.sourceFiles, 'install.js'), false);
  const report = auditEvidence({ sourceFiles: collected.sourceFiles, sourceCoverage: collected.coverage });
  assert.equal(hook(report).severity, 'medium');
});

test('actual guard clears only a fully collected proof plus completed vulnerability checks', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pkgxray-lifecycle-guard-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const transport = require('../src/http-client');
  const requestJson = transport.requestJson;
  transport.requestJson = async url => { assert.equal(url, 'https://api.osv.dev/v1/query'); return { vulns: [] }; };
  t.after(() => { transport.requestJson = requestJson; });
  const options = { githubMetadata: false, githubDiff: false, provenance: false };
  for (const command of ['node ./install.js', 'node install.js']) {
    const input = evidence(message, command);
    for (const [file, source] of Object.entries(input.sourceFiles)) await fs.writeFile(path.join(root, file), source);
    const cleared = await guardExtension(root, options);
    assert.equal(cleared.decision, 'allow', command);
    assert.equal(cleared.assessment.checks.source, 'completed');
    assert.equal(cleared.assessment.checks.vulnerabilities, 'completed');
    const disabled = await guardExtension(root, { ...options, vulnerabilityCheck: false });
    assert.equal(disabled.decision, 'block', command);
    await fs.appendFile(path.join(root, 'install.js'), "\nrequire('fs').readFileSync(process.env.HOME+'/.ssh/id_rsa');");
    const hostile = await guardExtension(root, options);
    assert.equal(hostile.decision, 'block', command);
    assert.equal(hook(hostile.report).severity, 'medium');
  }
});


test('prepublish, preprepare, postprepare and postpack neighbors remain required runtime evidence', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pkgxray-lifecycle-neighbor-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'install.js'), message);
  await fs.writeFile(path.join(root, 'neighbor.dat'), "console.log('ok'); require('fs').readFileSync(process.env.HOME+'/.ssh/id_rsa');");
  for (const name of ['prepublish', 'preprepare', 'postprepare', 'postpack']) {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: {
      postinstall: 'node ./install.js', [name]: 'node ./neighbor.dat'
    } }));
    const collected = await collectSourceEvidence(root);
    assert.equal(collected.coverage.complete, true);
    assert.ok(collected.coverage.runtimeFiles.includes('neighbor.dat'), name);
    assert.ok(collected.coverage.installTimeFiles.includes('neighbor.dat'), name);
    const report = auditEvidence({ sourceFiles: collected.sourceFiles, sourceCoverage: collected.coverage });
    assert.equal(report.verdict, 'block', name);
    assert.equal(report.findings.filter(f => f.category === 'install-hook' && f.severity === 'info').length, 1);
    assert.equal(report.findings.filter(f => f.category === 'install-hook' && f.severity === 'medium').length, 1);
  }
});


test('node executable shadowing anywhere in supplied evidence prevents lifecycle proof', () => {
  const cases = [
    { bin: { node: './shim.js' } },
    { bin: { 'node.exe': './shim.js' } },
    { bin: { 'NODE.CMD': './shim.js' } },
    { name: 'node', bin: './shim.js' },
    { name: '@scope/node', bin: './shim.js' },
    { directories: { bin: './commands' } }
  ];
  for (const shadow of cases) {
    const input = evidence();
    input.sourceFiles['dependency/package.json'] = JSON.stringify({ name: 'dependency', ...shadow });
    input.sourceFiles['dependency/shim.js'] = "require('https').get(process.env.DESTINATION);";
    assert.equal(prove(input), null, JSON.stringify(shadow));
    assert.equal(hook(auditEvidence(input)).severity, 'medium');
  }
  for (const file of ['node_modules/.bin/node', '.bin/node', 'node_modules/.bin/NODE.EXE', 'nested/.bin/node.cmd',
    'node_modules\\.bin\\node.bat']) {
    const input = evidence(); input.sourceFiles[file] = '#!/bin/sh\necho unexpected interpreter';
    assert.equal(prove(input), null, file);
    assert.equal(hook(auditEvidence(input)).severity, 'medium', file);
  }
  const root = evidence();
  root.sourceFiles['package.json'] = JSON.stringify({ name: 'demo', scripts: { postinstall: 'node ./install.js' }, bin: { node: 'shim.js' } });
  assert.equal(prove(root), null);
  assert.equal(hook(auditEvidence(root)).severity, 'medium');
});

test('ambiguous supplied manifests cannot establish interpreter identity', () => {
  for (const source of ['{broken', '[]', 'null', '{"name":"demo","bin":null}', '{"bin":"shim.js"}',
    '{"name":"demo","bin":["shim.js"]}', '{"name":"demo","bin":{"node":"shim.js"},"bin":{}}',
    '{"name":"node","name":"other","bin":"shim.js"}', '{"name":"demo","bin":{"other":false}}']) {
    const input = evidence(); input.sourceFiles['nested/package.json'] = source;
    assert.equal(prove(input), null, source);
  }
  const duplicate = normalizeEvidence(evidence());
  duplicate.sourceFiles.push({ path: 'PACKAGE.JSON', content: '{"bin":{"node":"shim.js"}}' });
  assert.equal(proveLiteralLifecycle('node ./install.js', 'package.json', duplicate), null);
  const ordinary = evidence(); ordinary.sourceFiles['dependency/package.json'] = '{"name":"tool","bin":{"tool":"cli.js"}}';
  assert.ok(prove(ordinary), 'unrelated unambiguous executable names do not shadow node');
  assert.match(prove(ordinary).assumptions.join(' '), /NODE_OPTIONS/);
});
