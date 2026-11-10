import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fixture } from '../resolver-worker/test/fixture.mjs';
import { securityScenarios } from '../resolver-worker/test/security-scenarios.mjs';
import { adversarialScenarios } from './security-scenarios.mjs';
const { runLocalVm, CACHE } = createRequire(import.meta.url)('../../src/local-vm-sandbox');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'pkgxray-vm-fixtures-'));
const options = artifact => ({ archivePath:artifact.archive,artifactSha256:artifact.sha256,
  scannerBuildId:'b'.repeat(64),policySha256:'c'.repeat(64),allowExecution:true });
const finding = (b,c) => assert.ok(b.findings.some(f=>f.category===c),`Missing ${c}`);
const complete=b=>{assert.equal(b.executed.ran[0].exitCode,0);assert.equal(b.executed.importPhase.exitCode,0);assert.equal(b.monitoring.syscallTrace,true);};
const scenarios=[...securityScenarios,...adversarialScenarios,
  {name:'dns',code:`require('node:dns').resolve4('decoy.pkgxray.invalid',error=>{require('node:assert/strict').equal(error.code,'ENOTFOUND');});`,
    check(b){complete(b);finding(b,'dns-attempt');assert.ok(b.telemetry.dnsQueries.includes('decoy.pkgxray.invalid'));}},
  {name:'honeypot-tampering',code:`const fs=require('node:fs'),h=process.env.HOME;
for(const p of ['/.cursor/mcp.json','/project/.github/workflows/ci.yml','/.bashrc','/project/package.json'])fs.appendFileSync(h+p,'tampered');
fs.unlinkSync(h+'/Documents/invoice.txt');`,
    check(b){complete(b);for(const c of ['mcp-config-poisoning','ci-tampering','persistence','package-tampering','destructive-file-operation'])finding(b,c);}},
  {name:'relative-credential',code:`process.chdir(process.env.HOME);require('node:fs').readFileSync('.git-credentials');`,
    check(b){complete(b);finding(b,'credential-access');}},
  {name:'host-separation',code:`const fs=require('node:fs'),a=require('node:assert/strict');
a.deepEqual(fs.readdirSync('/sys/class/net'),['lo']);
for(const p of ['/var/run/docker.sock','/run/containerd/containerd.sock',${JSON.stringify(path.join(root,'host-only-secret'))}])a.equal(fs.existsSync(p),false);
a.equal(process.env.PKGXRAY_VM_HOST_SECRET,undefined);
a.match(fs.readFileSync('/proc/self/status','utf8'),/NoNewPrivs:\\s+1/);
a.match(fs.readFileSync('/proc/self/status','utf8'),/CapEff:\\s+0+\\b/);
a.throws(()=>fs.readFileSync('/dev/vdb'));a.throws(()=>fs.writeFileSync('/etc/forged','x'));`,check:complete},
  {name:'ci-profile',profile:'ci',code:`const a=require('node:assert/strict');a.equal(process.env.CI,'true');a.equal(process.env.GITHUB_ACTIONS,'true');require('node:fs').readFileSync(process.env.GITHUB_WORKSPACE+'/package.json');`,check:complete}
];
const selected=process.argv[2]?scenarios.filter(s=>s.name===process.argv[2]):scenarios;
assert.ok(selected.length,'Unknown fixture');
const measurements=[];
const assertClean = async () => assert.equal((await fs.readdir(CACHE)).some(n=>n.startsWith('run-')||n==='active.lock'),false);
try {
  await fs.writeFile(path.join(root,'host-only-secret'),'synthetic host marker');
  process.env.PKGXRAY_VM_HOST_SECRET='must-not-enter-guest';
  for(const scenario of selected){
    const artifact=await fixture(root,scenario.name,{postinstall:'node probe.js'},{'probe.js':scenario.code,...scenario.files});
    const started=Date.now();let b;
    try { b=await runLocalVm({...options(artifact),profile:scenario.profile||'developer',timeoutMs:scenario.timeoutMs}); }
    catch(error) {
      if(!scenario.allowVmFailure)throw error;
      assert.match(error.message,/complete result|VM failed|deadline/);
      assert.ok(Date.now()-started<30000,'failed guest exceeded its host deadline budget');
      await assertClean();
      measurements.push({name:scenario.name,failedClosed:true,totalMs:Date.now()-started});
      console.log(JSON.stringify({pass:scenario.name,failedClosed:true,totalMs:Date.now()-started}));
      continue;
    }
    scenario.check(b);assert.equal(b.isolation,'local-vm');assert.equal(b.vmEvidence.artifactSha256,artifact.sha256);
    await assertClean();
    assert.ok(b.timings.totalMs>0);measurements.push({name:scenario.name,...b.timings});
    console.log(JSON.stringify({pass:scenario.name,verdict:b.verdict,timings:b.timings}));
  }
  if(!process.argv[2]){
    const linked=await fixture(root,'linked',{}, {escape:{symlink:'/etc/passwd'}});
    await assert.rejects(runLocalVm(options(linked)),/complete result|failed/);
    const slow=await fixture(root,'host-deadline',{postinstall:'node probe.js'},{'probe.js':'setInterval(()=>{},1000)'});
    const started=Date.now();await assert.rejects(runLocalVm({...options(slow),timeoutMs:1000}),/deadline/);
    assert.ok(Date.now()-started<10000);console.log('PASS unsafe archive and host deadline');
  }
  await assertClean();
  console.log(JSON.stringify({passed:true,fixtures:selected.length,measurements}));
}finally{delete process.env.PKGXRAY_VM_HOST_SECRET;await fs.rm(root,{recursive:true,force:true});}
