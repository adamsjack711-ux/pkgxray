'use strict';
const http=require('node:http'), fs=require('node:fs/promises'), path=require('node:path'), {spawn}=require('node:child_process');
const root=__dirname, checkout=path.resolve(root,'../..'), port=Number(process.env.PORT||4817);
const child=spawn(process.execPath,[path.join(checkout,'bin/mcp-server.js')],{cwd:root,env:{...process.env,PKGXRAY_MCP_ALLOWED_ROOTS:root},stdio:['pipe','pipe','pipe']});
let nextId=0, buffer='', busy=false;const pending=new Map();
child.stderr.on('data',chunk=>process.stderr.write(chunk));
child.stdout.setEncoding('utf8');
child.stdout.on('data',chunk=>{buffer+=chunk;if(buffer.length>16*1024*1024){child.kill();return;}let i;while((i=buffer.indexOf('\n'))>=0){let message;try{message=JSON.parse(buffer.slice(0,i));}catch{child.kill();return;}buffer=buffer.slice(i+1);const task=pending.get(message.id);if(task){clearTimeout(task.timer);pending.delete(message.id);message.error?task.reject(new Error(message.error.message)):task.resolve(message.result);}}});
child.on('exit',()=>{for(const task of pending.values()){clearTimeout(task.timer);task.reject(new Error('MCP server stopped; restart the playground.'));}pending.clear();});
child.on('error',error=>console.error('MCP launch error:',error.message));
function rpc(method,params){return new Promise((resolve,reject)=>{if(child.exitCode!==null||child.signalCode)return reject(new Error('MCP server is not running'));const id=++nextId;const timer=setTimeout(()=>{pending.delete(id);child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:id}})+'\n');reject(new Error('MCP request timed out'));},65000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
const ready=(async()=>{await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'fieldnotes-local',version:'0.1.0'}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');return rpc('tools/list',{});})();
ready.catch(error=>console.error(error.message));
async function checks(){await ready;const events=[];const call=async(label,name,args)=>{const start=performance.now();const response=await rpc('tools/call',{name,arguments:{...args,outputFormat:'json'}});if(response.isError)throw Error(response.content?.[0]?.text||'Tool failed');const data=response.structuredContent || JSON.parse(response.content[0].text);const decision=data.decision||data.verdict||data.worstDecision;events.push({label,tool:name,ms:Math.round(performance.now()-start),source:data.scanSource||null,status:name==='triage_lockfile_supply_chain'?'BLOCK RECORDED':decision==='review'?'PENDING REVIEW':decision==='block'?'UNSAFE':decision==='safe'||decision==='allow'?'SAFE':'COMPLETE',findings:(data.report?.findings||data.findings||[]).length,evidence:data});};
 const sourceFiles={};for(const file of ['package.json','index.html','style.css','app.js'])sourceFiles[file]=await fs.readFile(path.join(root,'dist',file),'utf8');
 const input={packageName:'fieldnotes-web-ui',sourceFiles};
 await call('Inspect app source','audit_agent_extension_supply_chain',input);
 await call('Repeat the same scan','audit_agent_extension_supply_chain',input);
 await call('Guard local app files','guard_agent_extension_install',{reference:path.join(root,'dist'),sourceScan:true,vulnerabilityCheck:false,githubMetadata:false,githubDiff:false});
 const fixture=path.join(root,'checks/package.json');
 await call('Inspect demo dependency','audit_lockfile_supply_chain',{lockfilePath:fixture,vulnerabilityCheck:false});
 await call('Block the demo dependency','triage_lockfile_supply_chain',{lockfilePath:fixture,auto:'block',includeSafe:true,vulnerabilityCheck:false});
 await call('Recheck recorded decision','audit_lockfile_supply_chain',{lockfilePath:fixture,vulnerabilityCheck:false});
 const result={time:new Date().toISOString(),scope:'Local-only. Network checks disabled; no package installation or promotion. Triage changes only checks/.pkgxray.lock.',events};await fs.writeFile(path.join(root,'checks/latest-run.json'),JSON.stringify(result,null,2));return result;
}
const files={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
const server=http.createServer(async(req,res)=>{const json=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
 const hosts=[`127.0.0.1:${port}`,`localhost:${port}`];if(!hosts.includes(req.headers.host))return json(403,{error:'Local host required'});
 const origin=req.headers.origin;if(origin&&!hosts.some(host=>origin===`http://${host}`))return json(403,{error:'Same-origin requests required'});
 if(req.url==='/api/checks'&&req.method==='POST'){if(busy)return json(409,{error:'Checks are already running.'});if(req.headers['content-type']!=='application/json')return json(415,{error:'JSON required'});busy=true;try{let size=0;for await(const chunk of req){size+=chunk.length;if(size>1024)return json(413,{error:'Request too large'});}return json(200,await checks());}catch(error){return json(500,{error:error.message});}finally{busy=false;}}
 if(req.url==='/api/health'&&req.method==='GET'){try{const tools=await ready;return json(200,{ready:child.exitCode===null&&child.signalCode===null,tools:tools.tools.map(t=>t.name)});}catch(error){return json(503,{error:error.message});}}
 if(req.method!=='GET'||!files[req.url])return json(404,{error:'Not found'});
 try{const [file,type]=files[req.url];res.writeHead(200,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'"});res.end(await fs.readFile(path.join(root,'dist',file)));}catch{res.end();}
});
server.listen(port,'127.0.0.1',()=>console.log(`Fieldnotes: http://127.0.0.1:${port}`));
server.on('error',error=>{console.error(error.message);child.kill();process.exitCode=1;});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{child.kill();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),1500).unref();});
