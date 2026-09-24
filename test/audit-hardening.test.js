"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {auditEvidence} = require('../src/auditor');
const cfg = require('../src/config');
const {guardExtension} = require('../src/quarantine');

test('behavioral gaps stop both guard promotion and evidence CLI approval', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pkgxray-coverage-policy-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const source = path.join(root,'package');
  await fs.mkdir(source);
  const sourceFiles = {'package.json':JSON.stringify({name:'coverage-demo',version:'1.0.0',main:'index.js'}),
    'index.js':'const object = new Proxy({}, {});'};
  for (const [file,content] of Object.entries(sourceFiles)) await fs.writeFile(path.join(source,file),content);
  const config = {...cfg.DEFAULTS,policy:'allow-review'};
  const result = await guardExtension(source,{config,policy:'allow-review',githubDiff:false,
    vulnerabilityCheck:false,promoteTo:path.join(root,'promoted')});
  assert.equal(result.decision,'review');
  assert.equal(result.promotedPath,null);
  await assert.rejects(fs.access(path.join(root,'promoted')));
  const evidence = {sourceFiles};
  const evidencePath = path.join(root,'evidence.json');
  await fs.writeFile(evidencePath,JSON.stringify(evidence));
  const cli = spawnSync(process.execPath,[path.resolve(__dirname,'../bin/audit.js'),'--file',evidencePath,
    '--policy','allow-review','--format','json'],{cwd:root,encoding:'utf8',timeout:10000});
  assert.equal(cli.status,3,cli.stderr);
  assert.equal(JSON.parse(cli.stdout).verdict,'review');
  const report = auditEvidence(evidence);
  const adjusted = cfg.applyConfig(report,{config:{...config,mute:[{check:'flow-analysis-gap',scope:'*'}]}});
  assert.ok(adjusted.findings.some(f => f.category === 'flow-analysis-gap' && !f.muted));
});

test('array aliases and constructor-chain remote execution cannot receive a safe verdict', () => {
  for (const source of [
    "const calls=[fetch]; calls[0]('/collect',{body:process.env.NPM_TOKEN})",
    "fetch('/code').then(r=>r.text()).then(code=>({}).constructor.constructor(code)())"
  ]) {
    const report = auditEvidence({packageName:'redteam-regression',sourceFiles:{
      'package.json':JSON.stringify({name:'redteam-regression',version:'1.0.0',main:'index.js'}),
      'index.js':source
    }});
    assert.equal(report.verdict,'review',source);
  }
});
