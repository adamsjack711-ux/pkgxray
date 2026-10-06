'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeExecutionFile, createExecutionGraph } = require('../src/execution-graph');
const { auditEvidence } = require('../src/auditor');
const { applyConfig, guardDecision, DEFAULTS } = require('../src/config');

// Inert source strings: no malware, endpoints, secret reads or evaluation.
const opaque = "const words=['events','util','a','b','c','d','e','f']; for(let n=0;n<2;n++){words.push(words.shift())} function word(i){return words[i]} require(word(0));";
const pkg = JSON.stringify({name:'fixture',version:'1.0.0',main:'index.js'});
const spawn = "const path=require('node:path'); const {spawn:launch}=require('node:child_process'); const target=path.join(__dirname,'extended','worker.min.js'); const child=launch(process.execPath,[target],{detached:true,stdio:'ignore',windowsHide:true}); child.unref();";
const evidence = (source = spawn, target = opaque) => ({sourceFiles:{'package.json':pkg,'index.js':source,'extended/worker.min.js':target}});

test('concealed runtime execution correlates the exact local target, without OSV or provenance', () => {
  const report = auditEvidence(evidence());
  const finding = report.findings.find(f => f.category === 'hidden-local-loader');
  assert.equal(report.verdict, 'block');
  assert.equal(finding.execution.target, 'extended/worker.min.js');
  assert.deepEqual(finding.relatedFiles, ['extended/worker.min.js']);
  assert.ok(finding.execution.flags.includes('unref'));
  assert.ok(finding.execution.signals.includes('structural-obfuscation'));
  assert.ok(report.riskBands.some(b => b.band === 'hidden-local-loader'));
});

test('ordinary detached worker and clean paired artifact remain SAFE', () => {
  assert.equal(auditEvidence(evidence(spawn, 'module.exports = 42;')).verdict, 'safe');
  assert.equal(auditEvidence({sourceFiles:{'package.json':pkg,'index.js':'exports.update = value => value;'}}).verdict,'safe');
});

test('file renames, dist/test paths and dormant exported methods retain the execution edge', () => {
  for (const target of ['dist/task.min.js','test/fixture.dat','payload']) {
    const source = `const {execFile}=require('child_process'); const path=require('path'); exports.update=function(value){ if(value === 100) { const child=execFile('node',[path.resolve(__dirname,'${target}')],{windowsHide:true}); child.unref(); } };`;
    const report = auditEvidence({sourceFiles:{'package.json':pkg,'index.js':source,[target]:opaque}});
    assert.equal(report.verdict, 'block', target);
    assert.equal(report.findings.find(f=>f.category==='hidden-local-loader').execution.target,target);
  }
});

test('fork, template paths and explicit cwd resolve without assuming the consumer cwd', () => {
  for (const source of [
    "const {fork}=require('child_process'); fork(`${__dirname}/worker.js`,[],{detached:true});",
    "require('child_process').spawn('node',['worker.js'],{cwd:__dirname,stdio:'ignore'});",
    "import {execFile as start} from 'node:child_process'; import path from 'node:path'; start('node',[path.join(__dirname,'worker.js')],{detached:true});"
  ]) {
    const facts = analyzeExecutionFile('lib/index.js', source);
    assert.equal(facts.edges[0]?.target, 'lib/worker.js', source);
  }
  assert.equal(analyzeExecutionFile('lib/index.js', "require('child_process').spawn('node',['./worker.js'],{detached:true})").edges[0].target,null);
  assert.equal(analyzeExecutionFile('lib/index.js', "require('child_process').fork('/<artifact>/worker.js')").edges[0].target,null,'a literal cannot forge an artifact-relative path');
});

test('unresolved execution is cited and cannot be muted or promoted through allow-review', () => {
  for (const source of [
    "require('child_process').fork(__dirname + '/missing.js',[],{detached:true});",
    "require('child_process').spawn('node',[runtimePath],{detached:true});"
  ]) {
    const raw = auditEvidence(evidence(source));
    const config = {...DEFAULTS,policy:'allow-review',mute:[{check:'unresolved-runtime-execution',scope:'*'}]};
    const report = applyConfig(raw,{config,packageName:'fixture',version:'1.0.0'});
    assert.equal(report.verdict,'review');
    assert.equal(guardDecision(report,{policy:'allow-review',config}),'review');
    assert.ok(report.findings.some(f=>f.category==='unresolved-runtime-execution'));
  }
});

test('unrelated suspicious files do not corroborate an ordinary worker', () => {
  const e = evidence(spawn, 'module.exports=42;');
  e.sourceFiles['unrelated.min.js'] = opaque;
  assert.ok(!auditEvidence(e).findings.some(f=>f.category==='hidden-local-loader'));
});

test('scope shadowing, reassignment, strings and comments do not invent execution edges', () => {
  for (const source of [
    "function f(require) { require('child_process').spawn('node',[__dirname+'/worker.js'],{detached:true}) }",
    "const child_process={spawn(){}}; child_process.spawn('node',[__dirname+'/worker.js'],{detached:true});",
    "let launch=require('child_process').spawn; launch=local; launch('node',[__dirname+'/worker.js']);",
    "// require('child_process').spawn('node',[__dirname+'/worker.js']);",
    'const example = "require(\'child_process\').spawn(\'node\',[])";'
  ]) assert.deepEqual(analyzeExecutionFile('index.js',source).edges,[],source);
  const conditional = analyzeExecutionFile('index.js',"let target=__dirname+'/one.js'; if(flag)target=__dirname+'/two.js';require('child_process').fork(target)");
  assert.equal(conditional.edges[0].target,null);
});

test('minification, ordinary lookup tables and plugin loading alone are not structural packing', () => {
  for (const source of [
    "const words=['a','b','c','d','e','f','g','h']; module.exports=i=>words[i];",
    "module.exports=name=>require(name);",
    "const words=['a','b','c','d','e','f','g','h'];words.push(words.shift());module.exports=words;"
  ]) assert.equal(analyzeExecutionFile('index.js',source).structure,null);
});

test('execution reachability follows imports beyond two levels and propagates install context', () => {
  const files = [{path:'index.js',content:"require('./a')"},{path:'a.js',content:"require('./b')"},
    {path:'b.js',content:"require('./c')"},{path:'c.js',content:"require('child_process').fork(__dirname+'/worker.dat')"},
    {path:'worker.dat',content:'module.exports=42;'}];
  const g = createExecutionGraph(files,new Set(['index.js']),new Set(['index.js']));
  assert.ok(g.runtime.has('worker.dat'));
  assert.ok(g.installTime.has('worker.dat'));
  assert.equal(g.edges[0].resolved,true);
});

test('analysis bounds stay visible and source is never executed', () => {
  globalThis.__pkgxrayGraphExecuted = false;
  const f = analyzeExecutionFile('index.js','globalThis.__pkgxrayGraphExecuted = true;');
  assert.equal(f.status,'parsed');
  assert.equal(globalThis.__pkgxrayGraphExecuted,false);
  delete globalThis.__pkgxrayGraphExecuted;
  assert.equal(analyzeExecutionFile('index.js',' '.repeat(1024*1024+1)).status,'budget');
});
