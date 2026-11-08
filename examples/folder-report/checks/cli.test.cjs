'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs/promises'), path=require('node:path'), os=require('node:os');
const {execFileSync,spawnSync}=require('node:child_process');
const {inventory,parseArgs,formatReport}=require('../app');
const cli=path.resolve(__dirname,'../app/index.js');
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'folder-report-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}

test('counts nested files, groups types and ranks sizes without changing contents',async t=>{
 const dir=await fixture(t);await fs.mkdir(path.join(dir,'nested'));await fs.writeFile(path.join(dir,'a.TXT'),'abc');await fs.writeFile(path.join(dir,'nested/b.txt'),'12345');await fs.writeFile(path.join(dir,'LICENSE'),'x');
 const report=await inventory(dir);assert.equal(report.files,3);assert.equal(report.totalBytes,9);assert.deepEqual(report.types,[{extension:'.txt',files:2,bytes:8},{extension:'(none)',files:1,bytes:1}]);assert.equal(report.largest[0].path,path.join('nested','b.txt'));assert.equal(await fs.readFile(path.join(dir,'a.TXT'),'utf8'),'abc');
});
test('skips symlinks and dependency/VCS directories',async t=>{
 const dir=await fixture(t),outside=await fixture(t);await fs.writeFile(path.join(outside,'not-scanned.txt'),'private fixture');await fs.symlink(outside,path.join(dir,'link'),'dir');for(const name of ['.git','node_modules']){await fs.mkdir(path.join(dir,name));await fs.writeFile(path.join(dir,name,'ignored'),'ignored');}
 const report=await inventory(dir);assert.equal(report.files,0);assert.equal(report.skippedLinks,1);assert.equal(report.skippedDirectories,2);await assert.rejects(inventory(path.join(dir,'link')),/not a symlink/);
});
test('entry limit fails without printing an incomplete report',async t=>{
 const dir=await fixture(t);await fs.mkdir(path.join(dir,'one'));await fs.mkdir(path.join(dir,'two'));
 const result=spawnSync(process.execPath,[cli,dir,'--max-entries','1','--json'],{encoding:'utf8'});assert.equal(result.status,1);assert.equal(result.stdout,'');assert.match(result.stderr,/no complete report/);
});
test('CLI JSON output and empty directories work',async t=>{
 const dir=await fixture(t);const report=JSON.parse(execFileSync(process.execPath,[cli,dir,'--json'],{encoding:'utf8'}));assert.equal(report.files,0);assert.deepEqual(report.types,[]);assert.deepEqual(report.largest,[]);
});
test('missing paths and invalid arguments fail clearly',async t=>{
 const dir=await fixture(t);await assert.rejects(inventory(path.join(dir,'missing')), {code:'ENOENT'});
 for(const args of [[],['a','b'],['--unknown'],['a','--max-entries','NaN']])assert.throws(()=>parseArgs(args));
 for(const maxEntries of [0,-1,1.5,100001])await assert.rejects(inventory(dir,{maxEntries}),/integer/);
 assert.equal(parseArgs(['--','--folder']).directory,'--folder');
});
test('human output quotes control characters in names',async t=>{
 const dir=await fixture(t);await fs.writeFile(path.join(dir,'name\nwith\u001bescape.txt'),'ok');const output=formatReport(await inventory(dir));assert.ok(output.includes('name\\nwith\\u001bescape.txt'));assert.ok(!output.includes('\u001b'));
});

test('CLI errors escape C0, DEL and C1 controls in missing paths', async t => {
 const dir=await fixture(t);
 const missing=path.join(dir,'missing\u001b[2J\u0007\u007f\u009b2J\r\nFAKE-SAFE');
 const result=spawnSync(process.execPath,[cli,missing],{encoding:'utf8'});
 assert.equal(result.status,1);assert.equal(result.stdout,'');
 assert.equal(result.stderr.trimEnd().includes('\n'),false);
 assert.doesNotMatch(result.stderr.trimEnd(),/[\u0000-\u001f\u007f-\u009f]/);
 assert.match(result.stderr,/\\u009b/);
});
