"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { qemuCommand, inputDisk, parseResult, executeVm, runLocalVm, sourceDigest, SCENARIO } = require("../src/local-vm-sandbox");
const { exactVmReference, scanInVm } = require("../src/vm-scan");
const { parseArgs } = require("../bin/audit");
const { requireLocalSocket } = require("../services/local-vm/build.cjs");

test("VM asset builds refuse remote Docker contexts", () => {
  assert.equal(requireLocalSocket("unix:///var/run/docker.sock"), "unix:///var/run/docker.sock");
  assert.equal(requireLocalSocket("npipe:////./pipe/docker_engine"), "npipe:////./pipe/docker_engine");
  for (const endpoint of [undefined,"tcp://127.0.0.1:2375","ssh://builder","unix:///tmp/socket\n"]) {
    assert.throws(()=>requireLocalSocket(endpoint), /local Docker socket/);
  }
});

test("VM launch never supplies networking, shared filesystems, management sockets or emulation fallback", () => {
  for (const [platform, arch, accelerator] of [["darwin","arm64","hvf"],["linux","x64","kvm"],["win32","x64","whpx"]]) {
    const result = qemuCommand("/tmp/assets,with,commas", "/tmp/input.raw", platform, arch);
    assert.equal(result.accelerator, accelerator);
    assert.equal(result.args[result.args.indexOf("-nic") + 1], "none");
    assert.equal(result.args[result.args.indexOf("-monitor") + 1], "none");
    assert.ok(result.args.includes("-nodefaults"));
    assert.ok(!result.args.some(arg => /tcg|virtfs|vsock|netdev|hostfwd|qmp|daemonize/.test(arg)));
    for (let i=0;i<result.args.length;i++) if(result.args[i]==="-blockdev") {
      const disk=JSON.parse(result.args[i+1]);assert.equal(disk.driver,"raw");assert.equal(disk["read-only"],true);assert.equal(disk.file.driver,"file");
    }
  }
  assert.throws(()=>qemuCommand("a","b","unsupported","x64"));
});
test("VM input binds the exact archive digest and refuses symlinks/mismatched bytes", async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"vm-unit-"));
  try {
    const bytes=Buffer.from("inert archive fixture");const sha=crypto.createHash("sha256").update(bytes).digest("hex");
    const source=path.join(root,"artifact");await fs.writeFile(source,bytes);
    await inputDisk(source,path.join(root,"input"),sha,"developer","a".repeat(32));
    const disk=await fs.readFile(path.join(root,"input"));
    const header=JSON.parse(disk.subarray(0,4096).toString().replace(/\0+$/,""));
    assert.equal(header.digest,sha);assert.equal(header.bytes,bytes.length);assert.equal(disk.length%512,0);
    assert.deepEqual(disk.subarray(4096,4096+bytes.length),bytes);
    await assert.rejects(inputDisk(source,path.join(root,"bad"),"0".repeat(64),"developer","a".repeat(32)),/differs/);
    if(process.platform!=="win32") {await fs.symlink(source,path.join(root,"link"));await assert.rejects(inputDisk(path.join(root,"link"),path.join(root,"linked"),sha,"developer","a".repeat(32)));}
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
test("VM result framing rejects duplicate, wrong-artifact and wrong-profile reports", () => {
  const nonce="a".repeat(32),sha="b".repeat(64);
  const result={schemaVersion:1,nonce,digest:sha,profile:"developer",scenarioMs:1,
    behavioral:{verdict:"not-observed",findings:[],monitoring:{syscallTrace:true,truncated:false},
      executed:{ran:[],importPhase:{attempted:true,exitCode:0,timedOut:false,durationMs:1}}}};
  const output=`PKGXRAY_VM_READY ${nonce}\nPKGXRAY_VM_RESULT ${JSON.stringify(result)}\n`;
  assert.equal(parseResult(output,nonce,sha,"developer").nonce,nonce);
  assert.throws(()=>parseResult(output+output,nonce,sha,"developer"));
  assert.throws(()=>parseResult(output,nonce,"c".repeat(64),"developer"));
  assert.throws(()=>parseResult(output,nonce,sha,"ci"));
  assert.throws(()=>parseResult(output,nonce+"x",sha,"developer"));
  delete result.behavioral.executed;
  assert.throws(()=>parseResult(`PKGXRAY_VM_READY ${nonce}\nPKGXRAY_VM_RESULT ${JSON.stringify(result)}\n`,nonce,sha,"developer"));
});
test("VM execution drops host credentials and waits for termination after its deadline", async () => {
  let killed=false,closed=false;
  await assert.rejects(executeVm("unused",[],"/private/fixture","nonce",10,(_cmd,_args,options)=>{
    assert.equal(options.env.HOME,"/private/fixture");assert.equal(options.env.NODE_OPTIONS,undefined);assert.equal(options.env.GITHUB_TOKEN,undefined);
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.kill=()=>{killed=true;setTimeout(()=>{closed=true;child.emit("close",null);},10);return true;};return child;
  }),/deadline/);
  assert.equal(killed,true);assert.equal(closed,true);
});
test("VM evidence rejects a clean verdict when execution or monitoring is incomplete", () => {
  const nonce="a".repeat(32),sha="b".repeat(64);
  for (const change of [
    b=>{b.executed.importPhase.exitCode=7;},
    b=>{b.executed.importPhase.timedOut=true;},
    b=>{b.monitoring.syscallTrace=false;},
    b=>{b.monitoring.truncated=true;},
    b=>{b.findings.push({severity:"medium",category:"network-attempt"});}
  ]) {
    const b={verdict:"not-observed",findings:[],monitoring:{syscallTrace:true,truncated:false},
      executed:{ran:[],importPhase:{attempted:true,exitCode:0,timedOut:false,durationMs:1}}};
    change(b);
    const result={schemaVersion:1,nonce,digest:sha,profile:"developer",scenarioMs:1,behavioral:b};
    assert.throws(()=>parseResult(`PKGXRAY_VM_READY ${nonce}\nPKGXRAY_VM_RESULT ${JSON.stringify(result)}\n`,nonce,sha,"developer"),/contradictory/);
  }
});
test("VM output flood and process failure are rejected only after the child closes", async () => {
  for (const stream of ["stdout","stderr"]) {
    let killed=false,closed=false;
    await assert.rejects(executeVm("unused",[],"/private/fixture","nonce",1000,()=>{
      const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
      child.kill=()=>{killed=true;setTimeout(()=>{closed=true;child.emit("close",null);},5);return true;};
      setImmediate(()=>child[stream].write(Buffer.alloc(1024*1024+1)));
      return child;
    }),/output exceeded/);
    assert.ok(killed&&closed);
  }
  await assert.rejects(executeVm("unused",[],"/private/fixture","nonce",1000,()=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.kill=()=>true;setImmediate(()=>child.emit("close",1));return child;
  }),/VM failed/);
});
test("VM asset and artifact failures release their lock and disposable directory", async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"vm-cleanup-"));
  try {
    const asset=Buffer.from("inert unit asset"),sha=crypto.createHash("sha256").update(asset).digest("hex");
    const files={};
    for(const name of ["kernel","initrd","root.ext4"]){await fs.writeFile(path.join(root,name),asset);files[name]=sha;}
    const manifest={schemaVersion:1,scenario:SCENARIO,arch:process.arch,sourceSha256:await sourceDigest(),files};
    const manifestPath=path.join(root,"manifest.json");
    const options={allowExecution:true,assetDirectory:root,archivePath:path.join(root,"artifact"),
      artifactSha256:"0".repeat(64),scannerBuildId:sha,policySha256:sha};
    await fs.writeFile(options.archivePath,asset);
    await fs.writeFile(manifestPath,JSON.stringify(manifest));
    await assert.rejects(runLocalVm(options),/differs/);
    files.kernel="0".repeat(64);await fs.writeFile(manifestPath,JSON.stringify(manifest));
    await assert.rejects(runLocalVm(options),/integrity/);
    assert.equal((await fs.readdir(root)).some(n=>n.startsWith("run-")||n==="active.lock"),false);
    await fs.writeFile(path.join(root,"active.lock"),"another owner");
    await assert.rejects(runLocalVm(options),/busy/);
    assert.equal(await fs.readFile(path.join(root,"active.lock"),"utf8"),"another owner");
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test("VM authorization and exact-reference checks run before acquisition or execution", async () => {
  for(const ref of ["file:/tmp/a","npm:pkg@latest","npm:pkg@^1.0.0","npm:pkg","https://example.com/a.tgz"]) assert.throws(()=>exactVmReference(ref));
  assert.equal(exactVmReference("npm:@scope/pkg@1.2.3").name,"@scope/pkg");
  await assert.rejects(runLocalVm({}),/authorization/);
  await assert.rejects(scanInVm("npm:pkg@1.0.0",{guard:()=>{throw Error("must not acquire")}}),/authorization/);
  assert.throws(()=>parseArgs(["vm-scan","npm:pkg@1.0.0","--keep-sandbox"]),/fixed disposable/);
  assert.throws(()=>parseArgs(["vm-scan","npm:pkg@1.0.0","--vm-profile","custom"]),/developer or ci/);
});
test("VM evidence can block but never clears static risk and always cleans staging", async () => {
  for (const fail of [false,true]) {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),"vm-scan-unit-"));
    const options={allowExecution:true,guard:async()=>({quarantinePath:root,stagedPath:path.join(root,"package"),
      resolved:{sha256:"a".repeat(64)},assessment:{engine:{buildId:"b".repeat(64)},policySha256:"c".repeat(64)},decision:"review"}),
      runVm:async()=>{if(fail)throw Error("VM failed");return {verdict:"not-observed",findings:[]};}};
    if(fail) await assert.rejects(scanInVm("npm:pkg@1.0.0",options),/VM failed/);
    else {const result=await scanInVm("npm:pkg@1.0.0",options);assert.equal(result.verdict,"review");assert.equal(result.installationApproved,false);}
    await assert.rejects(fs.stat(root),{code:"ENOENT"});
  }
});
