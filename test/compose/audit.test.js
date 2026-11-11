'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('../../src/vendor/yaml/dist');
const { audit, render, RULES, CAPS } = require('../../src/compose/audit');
const { binding } = require('../../src/compose/normalize');
const fixture = name => fs.readFileSync(path.join(__dirname,'fixtures',name),'utf8');
const scan = (service, extra = {}, options = {}) => audit(YAML.stringify({services:{app:service},...extra}),{file:'/srv/stack/compose.yaml',...options});
const hits = (report, rule) => report.findings.filter(f => f.ruleId === rule);

test('safe deployment: loopback informational, named volumes and expose not publication', () => {
  const r = audit(fixture('safe.yaml'), {file:'/srv/stack/compose.yaml'});
  assert.equal(r.exitCode,0); assert.equal(r.complete,true);
  assert.equal(r.summary.informational,2); assert.equal(r.summary.active,0);
  assert.equal(hits(r,'CXR-007').length,0);
});

test('realistic risky deployment has every requested check and connected evidence', () => {
  const r = audit(fixture('risky.yaml'),{file:'test/fixtures/risky.yaml'});
  assert.equal(r.exitCode,2); assert.equal(r.complete,true);
  for (const rule of Object.keys(RULES).filter(k => !['CXR-900','CXR-901'].includes(k))) assert.ok(hits(r,rule).length,rule);
  for (const f of r.findings) {
    assert.ok(f.line > 0); assert.equal(f.file,'test/fixtures/risky.yaml');
    assert.ok(f.suggestion && f.explanation); assert.ok(Object.keys(f.evidence).length);
    for (const id of f.relatedFindings) assert.ok(r.findings.some(x => x.id === id));
  }
  assert.equal(hits(r,'CXR-006')[0].evidence.readOnly,true);
  assert.match(hits(r,'CXR-006')[0].explanation,/does not make the socket API read-only/);
  assert.equal(hits(r,'CXR-103')[0].severity,'high');
});

const ports = [
  ['8080:80','all-interfaces','8080','tcp'],
  [80,'all-interfaces','dynamic','tcp'],
  ['80/udp','all-interfaces','dynamic','udp'],
  ['0:80','all-interfaces','0','tcp'],
  ['0.0.0.0:8080:80','all-interfaces','8080','tcp'],
  ['127.0.0.1:8080:80','loopback','8080','tcp'],
  ['127.42.0.9:8080:80','loopback','8080','tcp'],
  ['192.168.1.4:8080:80','specific-interface','8080','tcp'],
  ['[::]:8080:80','all-interfaces','8080','tcp'],
  ['[0:0:0:0:0:0:0:0]:8080:80','all-interfaces','8080','tcp'],
  ['[::1]:8080:80','loopback','8080','tcp'],
  ['[0:0:0:0:0:0:0:1]:8080:80','loopback','8080','tcp'],
  ['[::ffff:127.0.0.1]:8080:80','loopback','8080','tcp'],
  ['[2001:db8::1]:8080:80','specific-interface','8080','tcp'],
  ['8080-8082:80-82/udp','all-interfaces','8080-8082','udp'],
  [{target:80,published:'8080',host_ip:'::1'},'loopback','8080','tcp'],
  [{target:80,published:8080,host_ip:'0.0.0.0',protocol:'sctp'},'all-interfaces','8080','sctp'],
  [{target:80,host_ip:'127.0.0.1'},'loopback','dynamic','tcp'],
  [{target:80,published:'8080-8090',host_ip:'192.168.1.4',name:'http',app_protocol:'http'},'specific-interface','8080-8090','tcp']
];
for (const [value,scope,published,protocol] of ports) test(`port ${JSON.stringify(value)}`, () => {
  const r = scan({ports:[value]}); const f = hits(r,'CXR-001')[0];
  assert.equal(r.complete,true); assert.ok(f);
  assert.equal(f.evidence.binding,scope); assert.equal(f.evidence.published,published);
  assert.equal(f.evidence.protocol,protocol);
  assert.equal(f.severity,scope === 'loopback' ? 'info' : 'medium');
  assert.match(f.explanation,/internet reachability/);
});
for (const value of ['99999:80','8080:0','8080:80/bogus','8080-8082:80-81','::1:8080:80',
  'localhost:8080:80',true,{},null,{target:80,host_ip:'not-an-ip'}, {target:80,published:false}, {target:'80-81'},
  {target:80,unknown:true}, {target:80,protocol:'TCP'}, '80//udp']) test(`unsupported port ${JSON.stringify(value)} is incomplete`, () => {
  const r = scan({ports:[value]}); assert.equal(r.exitCode,3); assert.equal(hits(r,'CXR-001').length,0);
});

test('IPv4-mapped wildcard and invalid addresses', () => {
  assert.equal(binding('::ffff:0.0.0.0'),'all-interfaces');
  assert.equal(binding('127.0.0.999'),null);
});

for (const cap of CAPS) test(`dangerous capability ${cap}`, () => {
  const r = scan({cap_add:[cap]}); assert.equal(hits(r,'CXR-005').length,1); assert.equal(r.exitCode,2);
});
test('capabilities tolerate CAP_ prefix; innocuous addition and drops do not trigger', () => {
  assert.equal(hits(scan({cap_add:['CAP_SYS_ADMIN']}),'CXR-005').length,1);
  assert.equal(scan({cap_add:['NET_BIND_SERVICE'],cap_drop:['ALL']}).exitCode,0);
  assert.equal(scan({cap_add:['NEW_UNKNOWN_CAP']}).exitCode,3);
});

const mounts = [
  ['/var/run/docker.sock:/run/docker.sock:ro','CXR-006',true],
  [{type:'bind',source:'/run/docker.sock',target:'/socket'},'CXR-006',false],
  ['/custom/socket:/var/run/docker.sock','CXR-006',false],
  ['/:/host:ro','CXR-007',true],
  ['/etc:/host/etc','CXR-007',false],
  ['/var:/host/var','CXR-007',false],
  ['/var/lib/docker:/host/state','CXR-007',false],
  ['/proc:/host/proc:ro','CXR-007',true],
  ['/sys:/host/sys:ro','CXR-007',true],
  ['/dev:/host/dev','CXR-007',false],
  ['/home/alice:/home/app:ro','CXR-007',true],
  ['/Users/alice/.ssh:/keys:ro','CXR-007',true],
  ['./.aws:/keys:ro','CXR-007',true],
  ['../../etc:/host:ro','CXR-007',true],
  ['/var/run:/sockets:ro','CXR-007',true],
  ['/etc/../etc/passwd:/passwd:ro','CXR-007',true],
  [{type:'bind',source:'/etc',target:'/config',read_only:true},'CXR-007',true]
];
for (const [value,rule,ro] of mounts) test(`mount ${JSON.stringify(value)}`, () => {
  const r = scan({volumes:[value]}); assert.equal(r.complete,true);
  assert.equal(hits(r,rule).length,1); assert.equal(hits(r,rule)[0].evidence.readOnly,ro);
});
for (const value of ['data:/etc','docker.sock:/var/run/docker.sock:ro','/var/run/docker.sock',
  './data:/data','./public:/etc:ro','/srv/data:/etc:ro','/etc-backup:/backup:ro',
  {type:'volume',source:'data',target:'/etc'}, {type:'volume',target:'/var/run/docker.sock'},
  {type:'tmpfs',target:'/tmp'}]) test(`false-positive mount ${JSON.stringify(value)}`, () => {
  const r = scan({volumes:[value]}); assert.equal(r.exitCode,0);
});
for (const value of ['C:\\data:/data','~/data:/data','data/sub:/data',42,{type:'image',source:'img',target:'/data'},
  {type:'bind',target:'/data'},'/etc:/host:ro,rw','/etc:/host:nonsense',
  {type:'bind',source:'/etc',target:'/x',read_only:'false'}]) test(`unsupported mount ${JSON.stringify(value)}`, () => {
  assert.equal(scan({volumes:[value]}).exitCode,3);
});

test('connected risks only within same service; named volumes and expose are not links', () => {
  const r = audit('services:\n  web:\n    ports: ["8080:80"]\n  admin:\n    privileged: true\n    expose: [80]\n');
  assert.equal(hits(r,'CXR-101').length,0);
  assert.equal(hits(scan({ports:['8080:80'],volumes:['data:/etc']}),'CXR-103').length,0);
});
test('loopback connection is conditional and lower severity', () => {
  const f = hits(scan({ports:['127.0.0.1:8080:80'],privileged:true}),'CXR-101')[0];
  assert.equal(f.severity,'medium'); assert.match(f.explanation,/forwarding\/proxy/);
  assert.match(f.explanation,/authentication state/);
});
test('host networking does not invent a listener or correlated finding', () => {
  const r = scan({network_mode:'host',privileged:true});
  assert.equal(hits(r,'CXR-003').length,1); assert.equal(hits(r,'CXR-101').length,0);
  assert.equal(scan({network_mode:'host',ports:['80:80']}).exitCode,3);
});

test('anchors, aliases, merge sequence precedence and explicit overrides preserve source lines', () => {
  const r = audit(fixture('merged.yaml'));
  assert.equal(r.complete,true);
  assert.equal(hits(r,'CXR-002').length,2);
  assert.ok(hits(r,'CXR-002').every(f => f.line === 2));
  assert.ok(hits(r,'CXR-001').every(f => f.line === 4));
  assert.ok(!r.findings.some(f => f.service === 'replaced'));
  assert.equal(hits(r,'CXR-004')[0].service,'inherited');
});
for (const expression of ['$PORT','${PORT}','${PORT:-8080}','${PORT?required}','${PORT:+8080}','${PORT-${OTHER}}']) test(`interpolation ${expression} is explicit incomplete`, () => {
  const r = scan({ports:[`${expression}:80`],privileged:true});
  assert.equal(r.exitCode,3); assert.equal(hits(r,'CXR-001').length,0);
  assert.equal(hits(r,'CXR-002').length,1);
  assert.ok(!JSON.stringify(r).includes(expression));
});
test('unresolved fixtures preserve known risks; escaped dollar and shell substitutions are literal data', () => {
  assert.equal(audit(fixture('unresolved.yaml')).exitCode,3);
  assert.equal(scan({command:'echo $$HOME $(touch /tmp/do-not-run) `id`'}).exitCode,0);
});
for (const service of [{extends:'base'},{volumes_from:['db']},{use_api_socket:true},{provider:{type:'test'}},
  {post_start:[{command:'echo hi',privileged:true}]},{devices:['/dev/sda:/dev/x']},
  {ports:{}},{volumes:'data:/data'},{privileged:'yes'},{cap_add:'ALL'},
  {network_mode:'service:other'},{pid:'service:other'},{platform:'windows/amd64'},
  {build:{context:'.',privileged:true}},{portz:['80:80']}, {ports:[{target:80,mode:'ingress'}]}]) {
  test(`unsupported service ${JSON.stringify(service)} cannot pass`, () => assert.equal(scan(service).exitCode,3));
}
test('includes and volume/network drivers cannot yield clean reports', () => {
  for (const extra of [{include:['https://invalid.example/config.yaml']}, {volumes:{data:{driver_opts:{type:'none',o:'bind',device:'/'}}}},
    {volumes:{data:{external:true}}},{networks:{default:{driver_opts:{'com.docker.network.bridge.host_binding_ipv4':'127.0.0.1'}}}}]) {
    assert.equal(scan({},extra).exitCode,3);
  }
});
test('profiles evaluated conservatively', () => {
  const r = scan({profiles:['debug'],privileged:true});
  assert.equal(r.exitCode,2); assert.match(r.notices.join(' '),/Profile-gated/);
});

for (const text of [fixture('malformed.yaml'),'services: {}','[]','services: []',
  'services: {app: {privileged: true, privileged: false}}',
  'services: {app: !override {privileged: true}}',
  'services: {app: {ports: !reset []}}',
  'services: {app: {}}\n---\nservices: {app: {}}',
  'services: &cycle {app: *cycle}', '%YAML 1.1\n---\nservices: {app: {}}']) {
  test(`bad YAML or structure ${text.slice(0,45)}`, () => {
    const r = audit(text); assert.equal(r.exitCode,1); assert.equal(r.complete,false);
    assert.ok(!JSON.stringify(r).includes('malformed-secret-DO-NOT-PRINT'));
  });
}
test('bounded input and alias expansion fail explicitly', () => {
  assert.equal(audit('a'.repeat(1024*1024+1)).exitCode,1);
  const source = 'a: &a [1,2,3,4,5,6,7,8,9,10]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nservices: {app: {x-load: [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]}}';
  assert.equal(audit(source).exitCode,1);
});

test('known secrets, URL credentials, commands, path values and labels never appear in reports', () => {
  const source = fixture('secrets.yaml');
  const policy = {schemaVersion:1,suppressions:[{ruleId:'CXR-001',service:'dashboard',reason:
    'Approved sample-password-DO-NOT-PRINT; password=inline-password; https://reason-user:reason-password@host; sample-token-DO-NOT-PRINT'}]};
  const r = audit(source,{file:'/tmp/sample-token-DO-NOT-PRINT.yaml',policy});
  for (const output of [JSON.stringify(r),render(r)]) {
    assert.ok(!output.includes('DO-NOT-PRINT')); assert.ok(!output.includes('inline-password'));
    assert.ok(!output.includes('reason-password')); assert.ok(!output.includes('reason-user'));
    assert.ok(output.includes('[REDACTED]'));
  }
});
test('environment list secrets and terminal escape injection are redacted', () => {
  const r = scan({privileged:true,environment:['PASSWORD=sample-secret']},{},{file:'sample-secret\u001b[31m.yaml'});
  assert.ok(!render(r).includes('sample-secret')); assert.ok(!render(r).includes('\u001b'));
});
test('policy reasons redact authorization headers, JWTs, and private key blocks', () => {
  const policy = {schemaVersion:1,suppressions:[{ruleId:'CXR-002',service:'app',reason:
    'Authorization: Bearer authorization-secret; Basic YWxhZGRpbjpvcGVuc2VzYW1l; eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.signature; -----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----'}]};
  const r = scan({privileged:true},{},{policy});
  for (const output of [JSON.stringify(r),render(r)]) for (const secret of ['authorization-secret','YWxhZGRpbjpvcGVuc2VzYW1l','eyJhbGci','private-key-material']) {
    assert.ok(!output.includes(secret));
  }
});
test('output is deterministic, versioned, and every finding has the contract', () => {
  const first = audit(fixture('risky.yaml'));
  assert.equal(JSON.stringify(first),JSON.stringify(audit(fixture('risky.yaml'))));
  assert.equal(first.schemaVersion,1);
  for (const f of first.findings) for (const key of ['id','ruleId','severity','service','file','line','evidence','explanation','suggestion','relatedFindings','suppressed','suppressionReason']) assert.ok(Object.hasOwn(f,key));
});

test('explicit policy retains suppressed evidence; component suppression does not suppress connection', () => {
  const policy = {schemaVersion:1,suppressions:[{ruleId:'CXR-002',service:'app',reason:'Required for isolated lab'}]};
  const r = scan({privileged:true,ports:['8080:80']},{},{policy});
  assert.equal(hits(r,'CXR-002')[0].suppressed,true);
  assert.equal(hits(r,'CXR-101')[0].suppressed,false); assert.equal(r.exitCode,2);
  assert.match(render(r),/Required for isolated lab/);
  assert.equal(scan({privileged:true},{},{policy}).exitCode,0);
});
for (const policy of [null,{}, {schemaVersion:2,suppressions:[]},
  {schemaVersion:1,suppressions:[{ruleId:'CXR-002',service:'app',reason:''}]},
  {schemaVersion:1,suppressions:[{ruleId:'CXR-002',service:'*',reason:'all'}]},
  {schemaVersion:1,suppressions:[{ruleId:'CXR-900',service:'app',reason:'ignore gaps'}]},
  {schemaVersion:1,suppressions:[{ruleId:'CXR-999',service:'app',reason:'unknown'}]}]) {
  test(`invalid policy ${JSON.stringify(policy)} fails closed`, () => {
    const r = scan({privileged:true},{},{policy}); assert.equal(r.exitCode,1);
    assert.equal(hits(r,'CXR-002')[0].suppressed,false);
  });
}
