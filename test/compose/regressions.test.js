'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('../../src/vendor/yaml/dist');
const { audit, render } = require('../../src/compose/audit');
const { parsePort } = require('../../src/compose/normalize');
const root = path.resolve(__dirname,'../..');
const scan = (cfg,extra={},opts={}) => audit(YAML.stringify({services:{app:{image:'example/app:1',...cfg}},...extra}),{file:'/srv/stack/compose.yaml',...opts});
const hits = (r,id) => r.findings.filter(f => f.ruleId === id);

for (const type of ['configs','secrets']) test(`review: file-backed ${type} is an unanalysed grant, not a vulnerability`, () => {
  const r = scan({[type]:['hostfile']},{[type]:{hostfile:{file:'/etc/shadow'}}});
  assert.equal(r.exitCode,3); assert.equal(r.complete,false);
  assert.equal(r.analysisStatus,'incomplete'); assert.equal(r.riskStatus,'no-findings');
  assert.equal(r.summary.active,0); assert.equal(hits(r,'CXR-007').length,0);
  const grant = hits(r,'CXR-900').find(f => f.evidence.grantObserved);
  assert.equal(grant.service,'app'); assert.ok(grant.line > 0);
  assert.equal(grant.evidence.sourceKind,'file'); assert.equal(grant.evidence.contents,'not-read');
  assert.match(grant.explanation,/not a vulnerability/);
  assert.ok(!JSON.stringify(r).includes('/etc/shadow'));
});
test('dedicated ordinary secret files have limitations without being labelled risky', () => {
  const r = scan({secrets:['password']},{secrets:{password:{file:'./synthetic-secret.txt'}}});
  assert.equal(r.exitCode,3); assert.equal(r.summary.active,0); assert.equal(r.riskStatus,'no-findings');
});
test('unused file declaration does not invent a mount or service', () => {
  const r = scan({}, {configs:{unused:{file:'./example.conf'}}});
  assert.equal(r.exitCode,3); assert.equal(r.summary.active,0);
  assert.equal(r.findings[0].service,null); assert.equal(r.findings[0].evidence.grantObserved,false);
});
test('literal inline configuration does not imply an unknown host-file mount', () => {
  const r = scan({configs:['inline']},{configs:{inline:{content:'app_mode=demo'}}});
  assert.equal(r.exitCode,0); assert.equal(r.complete,true);
});
test('known risks remain visible alongside grant limitations', () => {
  const r = scan({privileged:true,secrets:['key']},{secrets:{key:{file:'./key'}}});
  assert.equal(r.riskStatus,'findings'); assert.equal(r.analysisStatus,'incomplete'); assert.equal(r.exitCode,3);
  assert.equal(hits(r,'CXR-002').length,1); assert.match(render(r),/Risk: findings; analysis: incomplete/);
});
for (const [cfg,extra] of [
  [{secrets:['absent']},{}], [{configs:'thing'},{}], [{configs:[{target:'/app'}]},{}],
  [{configs:[{source:'x',unknown:true}]},{configs:{x:{content:'safe'}}}],
  [{secrets:['x']},{secrets:{x:{external:true}}}],
  [{configs:['x']},{configs:{x:{environment:'SYNTHETIC_VAR'}}}],
  [{configs:['x']},{configs:{x:{file:32}}}],
  [{configs:['x']},{configs:{x:{file:'./x',content:'duplicate-source'}}}],
  [{configs:['x']},{configs:{x:{content:'safe',unknown_security_option:true}}}]
]) test(`resource shape limitation ${JSON.stringify([cfg,extra])}`, () => {
  const r = scan(cfg,extra); assert.equal(r.exitCode,3); assert.equal(r.summary.active,0);
});

for (const [cfg,extra] of [
  [{volumes:[{type:'bind',source:'./data',target:'/data',bind:{unknown_security_option:true}}]},{}],
  [{},{networks:{default:{unknown_security_option:true}}}],
  [{volumes:[{type:'bind',source:'./data',target:'/data',bind:'rshared'}]},{}],
  [{volumes:[{type:'bind',source:'./data',target:'/data',bind:{create_host_path:'false'}}]},{}],
  [{volumes:[{type:'bind',source:'./data',target:'/data',bind:{recursive:'writable'}}]},{}],
  [{volumes:[{type:'volume',source:'data',target:'/data',volume:{nocopy:'false'}}]},{}],
  [{networks:{default:{aliases:7}}},{}],
  [{networks:{default:{unknown_security_option:true}}},{}],
  [{},{volumes:{data:{external:'false'}}}],
  [{},{networks:{default:{internal:'false'}}}],
  [{},{networks:{default:{ipam:{driver:'custom'}}}}]
]) test(`nested keys/types fail explicitly ${JSON.stringify([cfg,extra])}`, () => {
  assert.equal(scan(cfg,extra).exitCode,3);
});
test('safe neighboring mount and network options remain complete', () => {
  const r = scan({volumes:[
    {type:'bind',source:'./data',target:'/data',read_only:true,bind:{create_host_path:false,propagation:'rprivate',selinux:'z'}},
    {type:'volume',source:'data',target:'/state',volume:{nocopy:true,subpath:'app'}},
    {type:'tmpfs',target:'/tmp',tmpfs:{size:1024,mode:0o700}}
  ], networks:{default:{aliases:['app'],priority:1}}}, {volumes:{data:{}},networks:{default:{internal:true,enable_ipv6:true}}});
  assert.equal(r.exitCode,0); assert.equal(r.analysisStatus,'complete');
});
test('unknown bind options do not erase known sensitive-source evidence', () => {
  const r = scan({volumes:[{type:'bind',source:'/etc',target:'/host',bind:{unknown:true}}]});
  assert.equal(r.exitCode,3); assert.equal(hits(r,'CXR-007').length,1); assert.equal(r.riskStatus,'findings');
});
test('review: SYS_ADMIN survives an unresolved neighboring capability', () => {
  const r = scan({cap_add:['SYS_ADMIN','${EXTRA_CAP}']});
  assert.equal(r.exitCode,3); assert.equal(hits(r,'CXR-005').length,1); assert.equal(hits(r,'CXR-900').length,1);
  assert.notEqual(hits(r,'CXR-005')[0].line,hits(r,'CXR-900')[0].line);
});
test('literal entries in all relevant security lists survive unresolved neighbors', () => {
  const r = scan({ports:['8080:80','${PORT}:80'],cap_add:['NET_ADMIN','${CAP}'],cap_drop:['ALL','${DROP}'],
    volumes:['/run/docker.sock:/socket:ro','${MOUNT}:/data'],configs:['known','${CONFIG}']},
  {configs:{known:{file:'./synthetic.conf'}}});
  for (const id of ['CXR-001','CXR-005','CXR-006','CXR-102','CXR-900']) assert.ok(hits(r,id).length,id);
  assert.equal(r.analysisStatus,'incomplete'); assert.equal(r.riskStatus,'findings');
});
test('non-dangerous capability and ALL drops produce no risk; malformed drop cannot pass', () => {
  assert.equal(scan({cap_add:['NET_BIND_SERVICE'],cap_drop:['ALL']}).exitCode,0);
  assert.equal(scan({cap_drop:[false]}).exitCode,3);
});

const ports = [
  ['8080-8082:80-82','paired-range','80-82','8080-8082','all-interfaces'],
  ['8080-8082:80','allocation-range','80','8080-8082','all-interfaces'],
  ['127.1.2.3:8080-8082:80/udp','allocation-range','80','8080-8082','loopback'],
  ['[::1]:8080-8082:80-82/sctp','paired-range','80-82','8080-8082','loopback'],
  ['[::]:8080-8082:80','allocation-range','80','8080-8082','all-interfaces'],
  ['[fd00::123]:8080-8082:80','allocation-range','80','8080-8082','specific-interface'],
  ['80-82/udp','dynamic','80-82','dynamic','all-interfaces'],
  ['[::1]::80-82','dynamic','80-82','dynamic','loopback'],
  ['0:80','dynamic','80','0','all-interfaces'],
  ['0008080-0008082:00080-00082/TCP','paired-range','80-82','8080-8082','all-interfaces'],
  [{target:80,published:'8080-8082',host_ip:'::1'},'allocation-range','80','8080-8082','loopback']
];
for (const [input,publication,target,published,binding] of ports) test(`range semantics ${JSON.stringify(input)}`, () => {
  const r = scan({ports:[input]}); assert.equal(r.complete,true);
  const f = hits(r,'CXR-001')[0];
  assert.equal(f.evidence.publication,publication); assert.equal(f.evidence.target,target);
  assert.equal(f.evidence.published,published); assert.equal(f.evidence.binding,binding);
  if (binding !== 'loopback') {
    const examples = [...f.suggestion.matchAll(/"([^"\n]+)"/g)].map(m => parsePort(m[1]));
    assert.equal(examples.length,2);
    for (const p of examples) {
      assert.equal(p.error,null); assert.equal(p.value.binding,'loopback');
      for (const key of ['target','published','protocol','publication']) assert.equal(p.value[key],f.evidence[key],key);
    }
  }
  assert.ok(!f.suggestion.includes('target: 80-82'));
});
for (const [input,code] of [
  ['8080-8082:80-81','port-range-length'], ['8080:80-82','port-range-length'],
  ['0:80-82','port-range-length'], ['8082-8080:80','port-published-range'],
  ['8080:82-80','port-target-range'], ['0-10:80','port-published-range'],
  ['65536:80','port-published-range'], ['8080:0','port-target-range'],
  ['[::1]:8080:80/nonsense','port-protocol'], [{target:'80-82'},'port-long-target'],
  [{target:80,host_ip:'SYNTHETIC_CANARY_71qX'},'port-host-ip'],
  [{target:80,mode:'host-default'},'port-mode'], [{target:80,name:[]},'port-metadata-type']
]) test(`precise redacted port diagnostic ${JSON.stringify(input)}`, () => {
  const r = scan({ports:[input]});assert.equal(r.exitCode,3); assert.equal(hits(r,'CXR-001').length,0);
  assert.equal(hits(r,'CXR-900')[0].evidence.diagnosticCode,code);
  assert.ok(!JSON.stringify(r).includes('SYNTHETIC_CANARY_71qX'));
});

for (const name of ['_app','MixedCase','_Web.API-1','-worker','.worker']) test(`service and exact suppression: ${name}`, () => {
  const data = {services:{[name]:{privileged:true},unrelated:{privileged:true}}};
  const policy = {schemaVersion:1,suppressions:[{ruleId:'CXR-002',service:name,reason:'Isolated synthetic lab'}]};
  const r = audit(YAML.stringify(data),{policy}); assert.equal(r.complete,true);assert.equal(r.exitCode,2);
  const fs = hits(r,'CXR-002'); assert.equal(fs.length,2);
  assert.equal(fs.find(f=>f.service===name).suppressed,true);assert.equal(fs.find(f=>f.service==='unrelated').suppressed,false);
});
test('mixed-case suppression does not match another case or erase connected findings', () => {
  const source = YAML.stringify({services:{Web:{privileged:true,ports:['80:80']},web:{privileged:true}}});
  const policy = {schemaVersion:1,suppressions:[{ruleId:'CXR-002',service:'Web',reason:'Synthetic review'}]};
  const r = audit(source,{policy}); assert.equal(r.summary.suppressed,1);
  assert.equal(hits(r,'CXR-002').find(f=>f.service==='web').suppressed,false);
  assert.equal(hits(r,'CXR-101')[0].suppressed,false);
});
for (const name of ['*','Web*','','bad name','bad/service','bad\nname']) test(`invalid suppression name remains rejected: ${JSON.stringify(name)}`, () => {
  const r = scan({privileged:true},{},{policy:{schemaVersion:1,suppressions:[{ruleId:'CXR-002',service:name,reason:'Synthetic'}]}});
  assert.equal(r.exitCode,1); assert.equal(r.summary.suppressed,0);
});

test('CLI never reads files referenced by configs/secrets', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'compose-xray-resource-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file = path.join(dir,'compose.yaml');
  const synthetic = path.join(dir,'never-read-synthetic.txt');
  fs.writeFileSync(synthetic,'SYNTHETIC_CANARY_71qX');
  fs.writeFileSync(file,YAML.stringify({services:{app:{secrets:['x'],configs:['y']}},secrets:{x:{file:synthetic}},configs:{y:{file:synthetic}}}));
  const guard = path.join(dir,'guard.cjs');
  fs.writeFileSync(guard,`const fs=require('node:fs');
for(const key of ['readFileSync','openSync']) { const original=fs[key]; fs[key]=function(p,...args){
 if(String(p)===${JSON.stringify(synthetic)}) { process.stderr.write('FORBIDDEN_READ');throw Error('forbidden'); }
 return original.call(this,p,...args); }; }`);
  const p = spawnSync(process.execPath,['--require',guard,path.join(root,'bin/compose.js'),'-f',file,'--format','json'],{encoding:'utf8',timeout:5000});
  assert.equal(p.status,3); assert.equal(p.stderr,''); assert.ok(!p.stdout.includes('SYNTHETIC_CANARY_71qX'));
  assert.equal(JSON.parse(p.stdout).riskStatus,'no-findings');
});
