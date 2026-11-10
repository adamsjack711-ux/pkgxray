"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {execFileSync,spawn}=require("node:child_process");
const path=require("node:path");
const root=path.resolve(__dirname,"..");
test("local MCP VM tool requires an operator opt-in and only accepts an exact reference/profile",()=>{
  for(const enabled of ["0","1"]){
    const source=`const s=require('./bin/mcp-server');console.log(JSON.stringify({tools:s.listTools().map(t=>t.name),
      path:s.validateToolCall('scan_npm_package_in_vm',{reference:'file:/tmp/a'}),
      command:s.validateToolCall('scan_npm_package_in_vm',{reference:'npm:a@1.0.0',command:'id'}),
      valid:s.validateToolCall('scan_npm_package_in_vm',{reference:'npm:a@1.0.0',profile:'ci'})}));`;
    const r=JSON.parse(execFileSync(process.execPath,["-e",source],{cwd:root,env:{...process.env,PKGXRAY_VM_TESTS:enabled},encoding:"utf8"}));
    assert.equal(r.tools.includes("scan_npm_package_in_vm"),enabled==="1");assert.ok(r.path);assert.ok(r.command);assert.equal(r.valid,null);
  }
});
test("an unadvertised VM tool cannot be called directly over MCP",async()=>{
  const child=spawn(process.execPath,[path.join(root,"bin/mcp-server.js")],{cwd:root,env:{...process.env,PKGXRAY_VM_TESTS:"0"},stdio:["pipe","pipe","pipe"]});
  const result=await new Promise((resolve,reject)=>{
    let buffer="";const timer=setTimeout(()=>{child.kill("SIGKILL");reject(Error("timeout"));},5000);
    child.once("error",reject);child.stdout.on("data",chunk=>{buffer+=chunk;if(buffer.includes("\n")){clearTimeout(timer);resolve(JSON.parse(buffer.split("\n")[0]));}});
    child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"scan_npm_package_in_vm",arguments:{reference:"npm:picocolors@1.1.1"}}})+"\n");
  });
  child.stdin.end();assert.equal(result.error.code,-32602);assert.match(result.error.message,/not available/);
});
