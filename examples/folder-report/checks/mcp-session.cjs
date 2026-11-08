'use strict';
const fs=require('node:fs/promises'), path=require('node:path'), readline=require('node:readline');
const {start,call}=require('../../../test/helpers/mcp-load-client');
const root=path.resolve(__dirname,'..'), app=path.join(root,'app');
const client=start('static',{cwd:app,env:{...process.env,PKGXRAY_MCP_ALLOWED_ROOTS:root}});
const log={transport:'Real JSON-RPC over stdio via the local test harness; not native chat tool binding',startedAt:new Date().toISOString(),network:'disabled',calls:[]};
async function save(){log.metrics=(await client.stats()).scans;await fs.writeFile(path.join(__dirname,'mcp-results.json'),JSON.stringify(log,null,2)+'\n');}
async function auditInput(){const sourceFiles={};for(const file of ['package.json','index.js'])sourceFiles[file]=await fs.readFile(path.join(app,file),'utf8');return {packageName:'folder-report-local',sourceFiles,outputFormat:'json'};}
async function invoke(label,name,args){const started=performance.now();const response=await client.request('tools/call',{name,arguments:{...args,outputFormat:'json'}});if(response.error||response.result?.isError)throw Error(JSON.stringify(response));const data=response.result.structuredContent;log.calls.push({label,tool:name,ms:+(performance.now()-started).toFixed(2),result:data});return data;}
async function command(line){
 if(line==='audit'){const data=await invoke(`Source audit ${log.calls.length+1}`,'audit_agent_extension_supply_chain',await auditInput());console.log(JSON.stringify({verdict:data.verdict,source:data.scanSource,findings:data.findings.map(f=>({severity:f.severity,category:f.category,rationale:f.rationale}))}));}
 else if(line==='burst'){const input=await auditInput();const results=await Promise.all(Array.from({length:10},(_,i)=>invoke(`Concurrent audit ${i+1}`,'audit_agent_extension_supply_chain',input)));if(results.some(r=>r.scanSource!=='cache'))throw Error('Expected ten warm cache hits');console.log('PASS: 10 concurrent warm calls returned cached evidence.');}
 else if(line==='guard'){const data=await invoke('Guard app, no promotion','guard_agent_extension_install',{reference:app,sourceScan:true,vulnerabilityCheck:false,githubMetadata:false,githubDiff:false});if(data.promotedPath)throw Error('Unexpected promotion');console.log(JSON.stringify({decision:data.decision,outcome:data.outcome,review:data.review,promotedPath:data.promotedPath}));}
 else if(line==='manifest'){const data=await invoke('Audit dependency-free manifest','audit_lockfile_supply_chain',{lockfilePath:path.join(app,'package.json'),vulnerabilityCheck:false});console.log(JSON.stringify({summary:data.summary,worstDecision:data.worstDecision}));}
 else if(line==='finish'){await save();console.log(JSON.stringify({calls:log.calls.length,metrics:log.metrics,log:path.join(__dirname,'mcp-results.json')}));await client.close();process.exit(0);}
 else throw Error('Unknown command');
 await save();console.log('READY');
}
(async()=>{const tools=await client.init();log.tools=tools.result.tools.map(t=>t.name);await save();console.log('READY: audit | burst | guard | manifest | finish');const lines=readline.createInterface({input:process.stdin});for await(const line of lines){if(line.trim())await command(line.trim());}await client.close();})().catch(async error=>{console.error(error);await client.close();process.exitCode=1;});
