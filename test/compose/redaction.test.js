'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('../../src/vendor/yaml/dist');
const { redactor } = require('../../src/compose/redact');
const { audit, render } = require('../../src/compose/audit');
const cli = path.resolve(__dirname,'../../bin/compose.js');
const sentinel = 'SYNTHETIC_CANARY_71qX';
const cases = [
  ['quoted JSON credential', {}, `Approved config: {"password":"${sentinel}"}`],
  ['Bearer ordering', {AUTH_SCHEME:'Bearer'}, `Authorization: Bearer ${sentinel}`],
  ['URL ordering', {SCHEME:'https'}, `Approved https://review-user:${sentinel}@example.invalid`],
  ['escaped quote', {}, `password="prefix\\"${sentinel}"`],
  ['unclosed quote', {}, `password="${sentinel}`],
  ['malformed quote suffix', {}, `password="prefix"${sentinel}`],
  ['escaped JSON', {}, `{"password":\\"${sentinel}\\"}`],
  ['single quotes', {}, `{'api_key':'${sentinel}'}`],
  ['YAML doubled quotes', {}, `password: 'prefix''${sentinel}'`],
  ['multiline malformed value', {}, `password: "prefix\n${sentinel}`],
  ['authorization quotes', {}, `Authorization: "Bearer ${sentinel}"`],
  ['Basic authorization', {}, `Proxy-Authorization: Basic ${sentinel}`],
  ['unclosed key material', {}, `-----BEGIN PRIVATE KEY-----\n${sentinel}`],
  ['overlapping token prefix', {PREFIX:'ghp_SYNTHETIC'}, `ghp_${sentinel}`],
  ['overlapping PEM header', {KIND:'PRIVATE KEY'}, `-----BEGIN PRIVATE KEY-----\n${sentinel}\n-----END PRIVATE KEY-----`],
  ['unquoted whitespace', {}, `AWS_SECRET_ACCESS_KEY=prefix ${sentinel}`]
];
for (const [name,environment,reason] of cases) test(`synthetic secrets absent from API and CLI output: ${name}`, t => {
  const source = YAML.stringify({services:{app:{privileged:true,environment}}});
  const policy = {schemaVersion:1,suppressions:[{ruleId:'CXR-002',service:'app',reason}]};
  const report = audit(source,{policy});
  assert.equal(report.exitCode,0);
  for (const out of [JSON.stringify(report),render(report)]) {
    assert.equal(out.includes(sentinel),false); assert.match(out,/\[REDACTED\]/);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'compose-xray-redaction-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const file = path.join(dir,'compose.yaml'), policyFile = path.join(dir,'policy.json');
  fs.writeFileSync(file,source); fs.writeFileSync(policyFile,JSON.stringify(policy));
  for (const format of ['text','json']) {
    const p = spawnSync(process.execPath,[cli,'-f',file,'--policy',policyFile,'--format',format],{encoding:'utf8',timeout:5000});
    assert.equal(p.status,0); assert.equal(p.stderr,'');
    assert.equal((p.stdout+p.stderr).includes(sentinel),false);
  }
});
test('overlapping literal spans are merged, and replacement markers are never rescanned', () => {
  const scrub = redactor({environment:{A:'abc', B:'bcd', C:'REDACTED'}});
  assert.equal(scrub('abcd'), '[REDACTED]');
  assert.equal(scrub('abc and bcd'), '[REDACTED] and [REDACTED]');
});
test('quoted credentials preserve safe neighboring prose; noncredential prose is unchanged', () => {
  const scrub = redactor({});
  assert.equal(scrub(`password="${sentinel}"; reviewed for isolated lab`),'password=[REDACTED]; reviewed for isolated lab');
  assert.equal(scrub('Password policy reviewed; authentication required.'),'Password policy reviewed; authentication required.');
  assert.equal(scrub('https://example.invalid/public'),'https://example.invalid/public');
});
test('known environment secrets are scrubbed from source identifiers and limitation messages', () => {
  const source = YAML.stringify({services:{app:{privileged:true,environment:{PASSWORD:sentinel}}}});
  const report = audit(source,{file:`${sentinel}.yaml`,limitations:[`Context token="${sentinel}"` ]});
  for (const out of [JSON.stringify(report),render(report)]) assert.equal(out.includes(sentinel),false);
});
test('malformed YAML hides source filename when no reliable secret dictionary exists', () => {
  const report = audit(`services: [PASSWORD=${sentinel}`,{file:`${sentinel}.yaml`});
  assert.equal(report.exitCode,1); assert.equal(report.findings[0].file,null);
  assert.equal((JSON.stringify(report)+render(report)).includes(sentinel),false);
});
test('credential-like policy text is scrubbed from identifiers even if policy is invalid', () => {
  const policy = {schemaVersion:999,suppressions:[{ruleId:'CXR-002',service:'app',reason:`password="${sentinel}"`}]};
  const report = audit('services: {app: {privileged: true}}',{file:`${sentinel}.yaml`,policy});
  assert.equal(report.exitCode,1);
  assert.equal((JSON.stringify(report)+render(report)).includes(sentinel),false);
});
test('CLI YAML, policy, usage and input errors do not echo synthetic credentials', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'compose-xray-errors-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const file = path.join(dir,`${sentinel}.yaml`), policyFile = path.join(dir,'policy.json');
  fs.writeFileSync(file,`services: [PASSWORD=${sentinel}`);
  const check = args => {
    for (const format of ['text','json']) {
      const p = spawnSync(process.execPath,[cli,...args,'--format',format],{encoding:'utf8',timeout:5000});
      assert.equal(p.status,1); assert.equal(p.stderr,'');
      assert.equal((p.stdout+p.stderr).includes(sentinel),false);
      if(format==='json') assert.equal(JSON.parse(p.stdout).status,'error');
    }
  };
  check(['-f',file]);
  fs.writeFileSync(file,'services: {app: {privileged: true}}');
  fs.writeFileSync(policyFile,`{"password":"${sentinel}`); check(['-f',file,'--policy',policyFile]);
  check(['--unknown',`password=${sentinel}`]); check(['-f',path.join(dir,`absent-${sentinel}.yaml`)]);
});
