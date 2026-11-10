'use strict';
const { fork } = require('node:child_process');
const path = require('node:path');
function start(mode = 'static', options = {}) {
  const child = fork(path.join(__dirname, '../fixtures/mcp-load-host.js'), [mode], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'], ...options });
  let next = 0, buffer = '', stderr = '';
  const pending = new Map(), metrics = new Map();
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-10000); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => {
    buffer += data;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
      const entry = pending.get(msg.id);
      if (entry) { clearTimeout(entry.timer); pending.delete(msg.id); entry.resolve(msg); }
    }
  });
  child.on('message', data => { metrics.get(data.id)?.(data); metrics.delete(data.id); });
  child.on('exit', () => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(`MCP host exited: ${stderr}`)); }
    pending.clear();
  });
  function request(method, params, id = ++next) {
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Request ${id} timed out: ${stderr}`)); }, 65000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    promise.id = id; return promise;
  }
  return { child, request,
    notify(method, params) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); },
    stats() { return new Promise(resolve => { const id = ++next; metrics.set(id, resolve); child.send({ type: 'stats', id }); }); },
    async init() { await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'local-load-harness', version: '1' } }); return request('tools/list'); },
    async close() { if (child.exitCode !== null) return; const exited = new Promise(resolve => child.once('exit', resolve)); child.send({ type: 'stop' }); await exited; }
  };
}
function evidence(index = 0) {
  return { packageName: 'inert-fixture', sourceFiles: {
    'package.json': JSON.stringify({ name: 'inert-fixture', version: '1.0.0', main: 'index.js' }),
    'index.js': `exports.value = ${index};\n` + 'exports.sum = (a,b) => a+b;\n'.repeat(80)
  }, outputFormat: 'json' };
}
const call = (client, input) => client.request('tools/call', { name: 'audit_agent_extension_supply_chain', arguments: input });
module.exports = { start, evidence, call };
