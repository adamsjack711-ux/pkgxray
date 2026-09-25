"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { prepareMcpSandbox } = require('../src/mcp-sandbox');
const { scrubbedEnv } = require('../src/mcp-client');

function run(launch) {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, timeout: 10000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, stdout, stderr: stderr + (signal ? 'signal=' + signal : '') }));
  });
}
test('requested sandbox fails closed on unsupported platforms and excessive grants', () => {
  assert.throws(() => prepareMcpSandbox(process.execPath, [], {}, { sandbox: true, platform: 'win32' }), /unavailable/);
  if (!['darwin', 'linux'].includes(process.platform)) return;
  const wrapper = process.platform === 'darwin' ? '/usr/bin/sandbox-exec' : '/usr/bin/bwrap';
  if (!fs.existsSync(wrapper)) return;
  assert.throws(() => prepareMcpSandbox(process.execPath, [], {}, { sandbox: true, cwd: os.homedir() }), /dedicated project/);
  assert.throws(() => prepareMcpSandbox(process.execPath, [], {}, { sandbox: true, sandboxRead: ['/'] }), /entire HOME/);
});
const available = process.platform === 'darwin' ? fs.existsSync('/usr/bin/sandbox-exec') : process.platform === 'linux' && fs.existsSync('/usr/bin/bwrap');
if (process.env.PKGXRAY_REQUIRE_OS_SANDBOX_TESTS === '1' && !available) throw new Error('CI requires an available OS sandbox backend');
test('real OS sandbox blocks private files, symlink escapes, writes and network while allowing explicit grants', { skip: !available, timeout: 20000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgxray-confinement-test-'));
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const grant = path.join(root, 'grant'); fs.mkdirSync(grant);
  const secret = path.join(root, 'secret'); fs.writeFileSync(secret, 'synthetic-private');
  fs.symlinkSync(secret, path.join(project, 'escape'));
  fs.writeFileSync(path.join(project, 'input'), 'public');
  let hits = 0;
  const server = http.createServer((req, res) => { hits++; res.end('unexpected'); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const script = path.join(project, 'probe.js');
  fs.writeFileSync(script, `
    const fs=require('fs'), http=require('http');
    const result={};
    function attempt(name, fn){try{fn();result[name]=true}catch{result[name]=false}}
    attempt('readProject',()=>fs.readFileSync('input'));
    attempt('readSecret',()=>fs.readFileSync(${JSON.stringify(secret)}));
    attempt('symlinkEscape',()=>fs.readFileSync('escape'));
    attempt('writeProject',()=>fs.writeFileSync('bad','bad'));
    attempt('writeGrant',()=>fs.writeFileSync(${JSON.stringify(path.join(grant, 'allowed'))},'ok'));
    attempt('writeHome',()=>fs.writeFileSync(process.env.HOME+'/scratch','ok'));
    result.spawnHelper=require('child_process').spawnSync('/usr/bin/true').status===0;
    result.freshHome=process.env.HOME!==${JSON.stringify(os.homedir())};
    const req=http.get('http://127.0.0.1:${server.address().port}',res=>{res.resume();result.network=true;console.log(JSON.stringify(result))});
    req.on('error',()=>{result.network=false;console.log(JSON.stringify(result))});
    req.setTimeout(1000,()=>req.destroy());
  `);
  const launch = prepareMcpSandbox(process.execPath, [script], scrubbedEnv(), {
    sandbox: true, cwd: project, sandboxWrite: [grant],
    // setup-node installs outside the ambient OS roots on hosted runners.
    sandboxRead: [fs.realpathSync(process.execPath)]
  });
  t.after(launch.cleanup);
  const result = await run(launch);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { readProject: true, readSecret: false, symlinkEscape: false,
    writeProject: false, writeGrant: true, writeHome: true, spawnHelper: process.platform !== 'darwin', freshHome: true, network: false });
  assert.equal(hits, 0);
  launch.cleanup();
  assert.equal(fs.existsSync(launch.scratchPath), false);
});
