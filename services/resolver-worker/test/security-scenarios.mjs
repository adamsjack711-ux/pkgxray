import assert from "node:assert/strict";

function completed(behavior) {
  assert.equal(behavior.monitoring?.syscallTrace, true, "syscall monitor must cover the scenario");
  assert.equal(behavior.monitoring?.truncated, false, "trace must be complete");
  assert.equal(behavior.executed?.ran?.[0]?.exitCode, 0, "fixture assertions must complete");
  assert.equal(behavior.executed?.importPhase?.exitCode, 0);
}

function finding(behavior, category) {
  assert.ok(behavior.findings?.some(item => item.category === category), `missing ${category} finding`);
}

function interrupted(behavior) {
  const phase = behavior.executed?.ran?.[0];
  assert.ok(phase?.attempted, "stress phase must actually start");
  assert.ok(Number.isInteger(phase.exitCode), "stress phase must report an exit code");
  assert.equal(typeof behavior.monitoring?.syscallTrace, "boolean");
  assert.equal(typeof behavior.monitoring?.truncated, "boolean");
  assert.ok(phase.exitCode !== 0 || behavior.monitoring?.syscallTrace !== true ||
    behavior.monitoring?.truncated === true, "interrupted evidence must not appear complete");
  assert.notEqual(behavior.verdict, "not-observed", "incomplete execution must require review");
}

export const securityScenarios = [
  {
    name: "benign",
    code: "require('node:fs').writeFileSync('generated.txt','ok');",
    check(behavior) { completed(behavior); assert.equal(behavior.verdict, "not-observed"); }
  },
  {
    name: "credential-read",
    code: "require('node:fs').readFileSync(process.env.HOME+'/.npmrc');",
    check(behavior) { completed(behavior); assert.equal(behavior.verdict, "block"); finding(behavior, "credential-access"); }
  },
  {
    name: "network-denied",
    // TEST-NET address: no third-party application is contacted. A timeout is
    // insufficient evidence; the kernel must deny the connection explicitly.
    code: `const net=require('node:net'), assert=require('node:assert/strict');
const socket=net.connect(443,'192.0.2.1');
const timer=setTimeout(()=>{socket.destroy();throw Error('network denial was not proven');},2500);
socket.on('connect',()=>{throw Error('external network was reachable');});
socket.on('error',error=>{clearTimeout(timer);assert.ok(['ENETUNREACH','EHOSTUNREACH','EPERM','EACCES'].includes(error.code),error.code);});`,
    check(behavior) { completed(behavior); finding(behavior, "network-attempt"); }
  },
  {
    name: "evidence-protection",
    code: `const fs=require('node:fs'), assert=require('node:assert/strict');
assert.equal(process.env.RESOLVER_AUTH_TOKEN,undefined);
assert.equal(process.env.CLOUDFLARE_API_TOKEN,undefined);
assert.notEqual(process.getuid(),0);
for(const target of ['/root/pkgxray-test','/work/traces/forged','/opt/pkgxray/runner.mjs','/proc/1/environ']) {
  assert.throws(()=>target.endsWith('environ')?fs.readFileSync(target):fs.writeFileSync(target,'forged'),
    error=>['EACCES','EPERM','EROFS'].includes(error.code));
}`,
    check(behavior) { completed(behavior); finding(behavior, "filesystem-write"); }
  },
  {
    name: "kernel-limits",
    code: `const fs=require('node:fs'), assert=require('node:assert/strict');
const limits=fs.readFileSync('/proc/self/limits','utf8');
for(const pattern of [/Max processes\\s+64\\s+64/,/Max open files\\s+128\\s+128/,
 /Max file size\\s+8388608\\s+8388608/,/Max core file size\\s+0\\s+0/,/Max cpu time\\s+12\\s+12/])assert.match(limits,pattern);
assert.throws(()=>fs.writeFileSync('large.bin',Buffer.alloc(9*1024*1024)));
assert.ok(fs.statSync('large.bin').size<=8388608);
const handles=[];let code;try{for(let i=0;i<256;i++)handles.push(fs.openSync('/dev/null','r'));}
catch(error){code=error.code;}finally{for(const fd of handles)fs.closeSync(fd);}assert.equal(code,'EMFILE');`,
    check: completed
  },
  {
    name: "output-flood",
    code: "for(let i=0;i<1024;i++)require('node:fs').writeSync(1,Buffer.alloc(4096));",
    check: interrupted
  },
  {
    name: "trace-flood",
    code: "const fs=require('node:fs');for(let i=0;i<200000;i++)fs.statSync('package.json');",
    check: interrupted
  },
  {
    name: "deadline",
    code: "setInterval(()=>{},1000);",
    check(behavior) { interrupted(behavior); assert.equal(behavior.executed.ran[0].timedOut, true); }
  }
];
