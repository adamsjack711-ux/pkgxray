'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('../../src/vendor/yaml/dist');
const { audit, render, failure } = require('../../src/compose/audit');
const { redactor } = require('../../src/compose/redact');
const cli = path.resolve(__dirname,'../../bin/compose.js');

// Exact synthetic values/data from independent.test.cjs, never real credentials.
const sentinel = 'SYNTHETIC_INDEPENDENT_Z92';
const fragment = 'INDEPENDENT_Z92';
const compose = cfg => ({services:{Web:{image:'example.invalid/synthetic:1',...cfg}}});
const policy = reason => ({schemaVersion:1,suppressions:[{ruleId:'CXR-002',service:'Web',reason}]});
const unicode = text => [...text].map(c => c.charCodeAt(0) < 128 ? `\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}` : c).join('');
const nested = text => text.replaceAll('\\','\\\\');

// Independent output oracle: inspect literal output and up to four JSON escape
// layers (more than the supported two). Assertions never print a sentinel.
function absent(output, secrets = [sentinel,fragment]) {
  for (let pass = 0; pass < 5; pass++) {
    for (const secret of secrets) assert.equal(output.includes(secret),false,'credential or recoverable fragment appeared in output');
    output = output.replace(/\\(?:u[\da-fA-F]{4}|["\\/bfnrt])/g, token => JSON.parse(`"${token}"`));
  }
}

function exercise(t, data, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'compose-ray-validation-fix-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const file = path.join(dir,opts.filename || 'compose.yaml');
  const source = typeof data === 'string' ? data : YAML.stringify(data);
  fs.writeFileSync(file,source);
  const report = audit(source,{file,policy:opts.policy});
  absent(JSON.stringify(report)); absent(render(report));
  const args = [cli,'-f',file];
  if (opts.policy !== undefined) {
    const p = path.join(dir,'policy.json');fs.writeFileSync(p,JSON.stringify(opts.policy));args.push('--policy',p);
  }
  for (const format of ['default','text','json']) {
    const p = spawnSync(process.execPath,[...args,...(format === 'default' ? [] : ['--format',format])],{
      encoding:'utf8',timeout:5000,maxBuffer:2*1024*1024,env:{PATH:process.env.PATH,LC_ALL:'C'}
    });
    assert.equal(p.error,undefined,'bounded CLI invocation');assert.equal(p.status,opts.exit ?? report.exitCode);
    assert.equal(p.stderr,'');absent(p.stdout);absent(p.stderr);
    if (format === 'json') assert.equal(JSON.parse(p.stdout).exitCode,report.exitCode);
    // Captured logs use the actual CLI bytes, not a second redactor.
    const log = path.join(dir,format+'.log');fs.writeFileSync(log,p.stdout+p.stderr);absent(fs.readFileSync(log,'utf8'));
  }
  return report;
}

test('saved reproduction: JSON-escaped credential key in policy reason', t => {
  const r = exercise(t,compose({privileged:true,environment:{}}),{policy:policy(`{"pass\\u0077ord":"${sentinel}"}`),exit:0});
  assert.equal(r.summary.suppressed,1);assert.match(r.findings[0].suppressionReason,/\[REDACTED\]/);
});
test('saved reproduction: authorization mapping reused in filename', t => {
  const r = exercise(t,compose({privileged:true,'x-headers':{Authorization:sentinel}}),{filename:sentinel+'.yaml',exit:2});
  assert.equal(r.findings[0].evidence.privileged,true);assert.ok(r.findings[0].line > 0);
  assert.ok(r.findings[0].file.endsWith('[REDACTED].yaml'));
});
test('saved reproduction: escaped known value in free-form reason', t => {
  const r = exercise(t,compose({privileged:true,environment:{PASSWORD:sentinel}}),{policy:policy(sentinel.replace('S','\\u0053')),exit:0});
  assert.equal(r.findings[0].suppressionReason,'[REDACTED]');
});

for (const [name,key] of [
  ['uppercase','PASS\\u0057ORD'],['multiple escapes','p\\u0061ss\\u0077ord'],
  ['entire key',unicode('password')],['two layers',nested('pass\\u0077ord')],
  ['api key','API_\\u004bEY'],['authorization','Authoriz\\u0061tion'],
  ['quoted space separator','api\\u0020key'],['quoted mixed separators','PAss _ WoRD']
]) test('semantic credential key: '+name,t => {
  exercise(t,compose({privileged:true}),{policy:policy(`{"${key}":"${sentinel}"}; reviewed lab`),exit:0});
});

for (const [name,headers] of [
  ['lowercase map',{authorization:sentinel}],
  ['proxy map',{'pRoXy-AuThOrIzAtIoN':sentinel}],
  ['escaped map',{'Authoriz\\u0061tion':sentinel}],
  ['name value',[{name:'Authorization',value:sentinel}]],
  ['key values',[{key:'Proxy-Authorization',values:[sentinel]}]],
  ['pair',[['Authorization',sentinel]]],
  ['escaped pair',[['Authoriz\\u0061tion',sentinel]]],
  ['escaped record',[{name:'Authoriz\\u0061tion',value:sentinel}]],
  ['header string',[`Authorization: ${sentinel}`]]
]) test('structured authorization: '+name,t => {
  exercise(t,compose({privileged:true,'x-headers':headers}),{filename:sentinel+'.yaml',policy:policy('Reviewed '+sentinel),exit:0});
});

for (const [name,encoded] of [
  ['first code unit',sentinel.replace('S','\\u0053')],
  ['last code unit',sentinel.slice(0,-1)+'\\u0032'],
  ['entire value',unicode(sentinel)],
  ['two layers',nested(unicode(sentinel))],
  ['three layers fail closed',nested(nested(unicode(sentinel)))],
  ['quotes','"'+unicode(sentinel)+'"']
]) test('known escaped value: '+name,t => {
  exercise(t,compose({privileged:true,environment:{PASSWORD:sentinel}}),{filename:encoded+'.yaml',policy:policy('Reviewed '+encoded),exit:0});
});

test('overlapping escaped known values merge original spans', () => {
  const scrub = redactor({environment:{A:'SYNTHETIC_INDEPENDENT',B:fragment,PREFIX:'\\u0053',MARKER:'REDACTED'}});
  const out = scrub('Context '+unicode(sentinel)+' end');absent(out);
  assert.equal(out,'Context [REDACTED] end');
});
test('escaped quote, slash, backslash, controls and surrogate pairs stay confidential', () => {
  const secret = sentinel+'"\\/\n🔒';
  const encoded = JSON.stringify(secret).slice(1,-1).replace('🔒','\\ud83d\\udd12');
  const scrub = redactor({environment:{PASSWORD:secret}});
  const out = scrub('Before '+encoded+' after');absent(out,[secret,sentinel,fragment]);
  assert.equal(out,'Before [REDACTED] after');
});
test('structured escaped credential keys protect reused values', t => {
  exercise(t,compose({privileged:true,'x-auth':{'pass\\u0077ord':sentinel}}),{filename:sentinel+'.yaml',exit:2});
});
test('authorization context protects paths even on invalid policy', t => {
  exercise(t,compose({privileged:true,'x-headers':{Authorization:sentinel}}),{
    filename:sentinel+'.yaml',policy:{schemaVersion:9,suppressions:[]},exit:1
  });
});
test('encoded malformed source and filename remain absent in errors', t => {
  exercise(t,`services: [password="${unicode(sentinel)}`,{filename:unicode(sentinel)+'.yaml',exit:1});
});
test('escaped credential diagnostic passes the same output boundary', () => {
  const r = failure(`Diagnostic {"pass\\u0077ord":"${sentinel}"}`);
  assert.equal(r.exitCode,1);absent(JSON.stringify(r));absent(render(r));
});
test('known escaped values in limitations and evidence are redacted', () => {
  const r = audit(YAML.stringify(compose({ports:['127.0.0.1:49123:80'],environment:{PASSWORD:'49123'}})),{
    file:'report-\\u00349123.yaml',limitations:['Review \\u00349123']
  });
  for (const output of [JSON.stringify(r),render(r)]) absent(output,['49123']);
  assert.equal(r.exitCode,3);assert.equal(r.findings.find(f=>f.ruleId==='CXR-001').evidence.published,'[REDACTED]');
});
test('safe text and unrelated headers retain useful context', () => {
  const scrub = redactor({'x-headers':{'Content-Type':'application/json'},'x-record':{name:'Web',value:'public'}});
  for (const value of ['Password policy reviewed','https://example.invalid/public','public Web application/json',String.raw`safe \u0041 text`,String.raw`invalid \uZZZZ escape`]) {
    assert.equal(scrub(value),value);
  }
  assert.equal(scrub('password="hidden"; reviewed lab'),'password=[REDACTED]; reviewed lab');
});

for (const [field,value] of [['ipc','host'],['security_opt',['seccomp=unconfined']]]) {
  test('saved reproduction: scoped limitation for '+field,t => {
    const r = exercise(t,compose({[field]:value}),{exit:3});
    assert.equal(r.complete,false);assert.equal(r.riskStatus,'no-findings');assert.equal(r.analysisStatus,'incomplete');
    assert.equal(r.summary.active,0);const f=r.findings.find(f=>f.ruleId==='CXR-900');
    assert.equal(f.service,'Web');assert.ok(f.line>0);assert.equal(f.evidence.field,field);
    assert.match(f.suggestion,/Retain needed protections/);
  });
}
for (const [name,cfg] of [
  ['IPC null',{ipc:null}],['IPC sharing',{ipc:'service:other'}],
  ['security option wrong type',{security_opt:'seccomp=unconfined'}],
  ['security option null',{security_opt:null}],['security option bad item',{security_opt:[false]}],
  ['security option protective',{security_opt:['no-new-privileges:true']}]
]) test('unanalysed setting stays incomplete: '+name,()=>{
  const r=audit(YAML.stringify(compose(cfg)));assert.equal(r.exitCode,3);assert.equal(r.summary.active,0);
});
test('omitted IPC and empty security options make no unsupported-setting claims',()=>{
  const r=audit(YAML.stringify(compose({security_opt:[],read_only:true})));assert.equal(r.exitCode,0);assert.equal(r.complete,true);
});
test('security-setting limitation preserves known risk, suppression scope and exit precedence',()=>{
  const source=YAML.stringify(compose({ipc:'host',security_opt:['seccomp=unconfined'],privileged:true,cap_add:['SYS_ADMIN']}));
  const r=audit(source,{policy:policy('Synthetic lab')});assert.equal(r.exitCode,3);assert.equal(r.summary.suppressed,1);
  assert.equal(r.riskStatus,'findings');assert.equal(r.analysisStatus,'incomplete');
  assert.ok(r.findings.some(f=>f.ruleId==='CXR-005'));assert.equal(r.summary.limitations,2);
  const bad=audit(source,{policy:policy('')});assert.equal(bad.exitCode,1);assert.equal(bad.analysisStatus,'error');
});

test('redaction input, nesting, dictionary and span budgets omit text instead of leaking',()=>{
  assert.equal(redactor({})('x'.repeat(65537)),'[REDACTED]');
  assert.equal(redactor({environment:{PASSWORD:'x'.repeat(65537)}})('context'),'[REDACTED]');
  const many=Object.fromEntries(Array.from({length:4097},(_,i)=>['k'+i,'opaque-'+i]));
  assert.equal(redactor({environment:many})('context'),'[REDACTED]');
  let deep={Authorization:sentinel};for(let i=0;i<70;i++)deep={child:deep};
  assert.equal(redactor(deep)(sentinel),'[REDACTED]');
  assert.equal(redactor({environment:{PASSWORD:'a'}})('a'.repeat(20000)),'[REDACTED]');
});
test('pathological near-key and near-URL input stays bounded in a subprocess',()=>{
  const script=`const {redactor}=require(${JSON.stringify(path.resolve(__dirname,'../../src/compose/redact.js'))});
const s='a-'.repeat(30000);const r=redactor({});if(r(s)!==s)process.exit(2);process.stdout.write('bounded');`;
  const p=spawnSync(process.execPath,['-e',script],{encoding:'utf8',timeout:3000});
  assert.equal(p.error,undefined,'redaction must not time out on long near matches');assert.equal(p.status,0);assert.equal(p.stdout,'bounded');assert.equal(p.stderr,'');
});
