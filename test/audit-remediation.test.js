"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { validateToolCall } = require('../bin/mcp-server');
const { parseReference } = require('../src/quarantine');
const { computeBuildId } = require('../src/artifact');
const { createFlowAnalysis } = require('../src/flow-analysis');
const { sensitiveFlowHints } = require('../src/sensitive-flows');
const { authorizationFor, receiptAuthorizes, MANDATORY_CATEGORIES } = require('../src/approval-policy');
const { McpGate } = require('../src/mcp-proxy');

test('MCP authorizes the canonical acquisition path for every native local form', async t => {
  const inside = await fs.mkdtemp(path.join(process.cwd(), '.audit-path-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-path-'));
  t.after(() => Promise.all([inside, outside].map(dir => fs.rm(dir, { recursive: true, force: true }))));
  for (const ref of [inside, `file:${inside}`, `./${path.basename(inside)}`, path.basename(inside)]) {
    assert.equal(parseReference(ref).type, 'local');
    const args = { reference: ref };
    assert.equal(validateToolCall('guard_agent_extension_install', args), null);
    assert.equal(parseReference(args.reference).path, await fs.realpath(inside));
  }
  for (const ref of [outside, `file:${outside}`, path.relative(process.cwd(), outside)]) {
    assert.equal(parseReference(ref).type, 'local');
    assert.match(validateToolCall('guard_agent_extension_install', { reference: ref }), /outside/);
  }
});

test('MCP schemas enforce an option allowlist before paths, providers or staging are used', () => {
  for (const name of ['guard_agent_extension_install', 'audit_lockfile_supply_chain', 'triage_lockfile_supply_chain']) {
    for (const key of ['osvResults', 'triageDecisions', 'scanErrorPolicy', 'keepStaging', 'lockPath']) {
      assert.match(validateToolCall(name, { [key]: [] }), /unknown argument/);
    }
  }
  assert.match(validateToolCall('audit_lockfile_supply_chain', { quarantineRoot: '.' }), /unknown argument/);
  assert.match(validateToolCall('guard_agent_extension_install', { reference: 'npm:demo@1.0.0', sourceScan: 'yes' }), /boolean/);
});

function analyze(content) { return createFlowAnalysis([{ path: 'index.js', content }]).analyze('index.js'); }
test('constant-only flow invariants: aliases, branches, try/finally, closure effects and cycles', () => {
  for (const content of [
    'const a={value:1}; const b=a; b.value=2; module.exports=a.value;',
    'let value=1; try { value=2; } finally {} module.exports=value;',
    'let value=1; function update(){value=2} update(); module.exports=value;',
    'let value=1; function update(){value=2} if(condition){} update(); module.exports=value;',
    'const a={value:1}; if(condition){} else {} const b=a; b.value=2; module.exports=a.value;',
    'const a={value:1}; const b=a; if(condition){} else {} b.value=2; module.exports=a.value;',
    'const a={value:1}; const b=a; if(condition)b.value=2; else a.value=2; module.exports=a.value;'
  ]) {
    const result = analyze(content);
    assert.equal(result.status, 'parsed', JSON.stringify(result.gaps));
    assert.equal(result.exports.value, 2, content);
  }
  for (const [a, b] of [[1,2], [2,1]]) {
    for (const content of [
      `let value=0; condition ? value=${a} : value=${b}; module.exports=value;`,
      `const box={inner:{value:0}}; if(condition) box.inner.value=${a}; else box.inner.value=${b}; module.exports=box.inner.value;`
    ]) {
      const result = analyze(content);
      assert.equal(result.status, 'parsed');
      assert.equal(Object.hasOwn(result.exports, 'value'), false, 'different constants must join to unknown');
    }
  }
  const cyclic = analyze('const a={value:1}; a.self=a; if(condition)a.value=2; else a.value=3; module.exports=a;');
  assert.equal(cyclic.status, 'parsed');
  assert.equal(cyclic.exports.self, undefined);
  assert.equal(cyclic.exports.props.get('self'), cyclic.exports);
  const dormant = analyze('let value=1; function unused(){value=2} module.exports=value;');
  assert.equal(dormant.exports.value, 1, 'dormant body inspection cannot mutate live state');
  const logical = analyze('let value=1; condition && (value=2); module.exports=value;');
  assert.equal(logical.status, 'parsed');
  assert.equal(Object.hasOwn(logical.exports, 'value'), false, 'short-circuit writes must join the skipped branch');
});

test('pure logical guards do not amplify heap snapshots across compiled-style methods', () => {
  const content = 'var Item=(function(){function Item(){} ' + Array.from({ length: 80 }, (_, i) =>
    `Item.prototype.m${i}=function(x){if(typeof x !== 'number' && x !== null)return 0; return x;};`).join('') +
    'return Item;})(); new Item();';
  const result = analyze(content);
  assert.equal(result.status, 'parsed', JSON.stringify(result.gaps));
  assert.deepEqual(result.gaps, []);
});

test('live MCP state has finite outstanding, held, manifest and timing budgets', async () => {
  const tools = [{ name: 'clock', description: 'Return time', inputSchema: { type: 'object' } }];
  const gate = new McpGate({ send() {}, recheck: false });
  await gate._finishVerify(tools);
  for (let id = 0; id < 1024; id++) await gate.onClientMessage({ id, method: 'tools/call', params: { name: 'clock' } });
  await assert.rejects(gate.onClientMessage({ id: 1025, method: 'tools/call', params: { name: 'clock' } }), /capacity/);
  assert.equal(gate.stats.gateNs.length, 512);
  const held = new McpGate({ send() {}, recheck: false });
  for (let id = 0; id < 128; id++) await held.onClientMessage({ id, method: 'tools/call', params: { name: 'clock' } });
  await assert.rejects(held.onClientMessage({ id: 129, method: 'tools/call', params: { name: 'clock' } }), /capacity/);
  held._failRevalidation('test complete');
  assert.equal(held.heldBytes, 0);
  const listed = new McpGate({ send() {}, recheck: false });
  for (let page = 0; page < 50; page++) await listed._onClientListResponse({ result: { tools: [], nextCursor: 'next' } });
  await assert.rejects(listed._onClientListResponse({ result: { tools: [], nextCursor: 'next' } }), /capacity/);
});

test('MCP HTTP POST and cleanup DELETE use the same connection-bound resolver', async t => {
  const dns = require('node:dns');
  const transport = require('../src/http-client');
  const originalLookup = dns.lookup, originalRequest = transport.requestText;
  const previous = process.env.PKGXRAY_MCP_ALLOW_PRIVATE;
  delete process.env.PKGXRAY_MCP_ALLOW_PRIVATE;
  t.after(() => {
    dns.lookup = originalLookup; transport.requestText = originalRequest;
    if (previous === undefined) delete process.env.PKGXRAY_MCP_ALLOW_PRIVATE;
    else process.env.PKGXRAY_MCP_ALLOW_PRIVATE = previous;
  });
  let lookups = 0;
  dns.lookup = (host, options, callback) => { lookups++; callback(null, [{ address: '8.8.8.8', family: 4 }]); };
  const methods = [];
  transport.requestText = async (url, options) => {
    methods.push(options.method);
    await new Promise((resolve, reject) => options.lookup(url.hostname, { all: true }, (error, addresses) => {
      if (error) return reject(error);
      assert.equal(addresses[0].address, '8.8.8.8'); resolve();
    }));
    const request = options.body ? JSON.parse(options.body) : {};
    return { statusCode: 200, headers: { 'mcp-session-id': 'fixture', 'content-type': 'application/json' },
      body: JSON.stringify({ id: request.id, result: { serverInfo: { name: 'fixture' }, tools: [] } }) };
  };
  await require('../src/mcp-client').enumerateMcpServer({ url: 'https://fixture.invalid/mcp' });
  assert.deepEqual(methods, ['POST', 'POST', 'POST', 'DELETE']);
  assert.equal(lookups, 4);
});

test('unsupported executable syntax is reported as lexical-only coverage', () => {
  const content = 'export const count: number = 1;';
  assert.ok(sensitiveFlowHints(content, { filePath: 'index.ts' }).some(h => h.kind === 'flow-analysis-gap'));
  assert.deepEqual(sensitiveFlowHints('{"count": 1}', { filePath: 'data.json' }), []);
});

test('every mandatory coverage hold is part of receipt authorization', () => {
  const receipt = { schemaVersion: 2, decision: 'review', sourceComplete: true,
    checks: { source: 'completed', vulnerabilities: 'completed' } };
  for (const category of MANDATORY_CATEGORIES) {
    const authorization = authorizationFor({ findings: [{ category }] });
    assert.equal(receiptAuthorizes({ ...receipt, authorization }, { allowReview: true }), false);
    assert.equal(receiptAuthorizes({ ...receipt, decision: 'allow', authorization }), false);
  }
  const authorization = authorizationFor({ findings: [] });
  assert.equal(receiptAuthorizes({ ...receipt, authorization }, { allowReview: true }), true);
  assert.equal(receiptAuthorizes({ ...receipt, authorization, schemaVersion: 1 }, { allowReview: true }), false);
});

test('parser and nested runtime changes invalidate the deterministic build identity', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-build-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'src/vendor/parser'), { recursive: true });
  await fs.mkdir(path.join(dir, 'bin'));
  await fs.writeFile(path.join(dir, 'package.json'), '{}');
  const parser = path.join(dir, 'src/vendor/parser/index.js');
  await fs.writeFile(parser, 'parser v1');
  const first = computeBuildId(dir);
  assert.equal(first, computeBuildId(dir));
  await fs.writeFile(parser, 'parser v2');
  assert.notEqual(first, computeBuildId(dir));
});

test('MCP metadata drift and unavailable expected pins hold all tools', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-pin-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const lockPath = path.join(dir, 'pins.json');
  const tools = [{ name: 'clock', description: 'Return the time', inputSchema: { type: 'object' } }];
  const baseline = new McpGate({ send() {}, pin: true, lockPath });
  baseline.serverInfo = { name: 'fixture', version: '1' };
  await baseline._finishVerify(tools);
  for (const changes of [{ instructions: 'Use UTC.' }, { capabilities: { tools: { listChanged: true } } }]) {
    const gate = new McpGate({ send() {}, recheck: true, lockPath });
    Object.assign(gate, { serverInfo: baseline.serverInfo }, changes);
    await gate._finishVerify(tools);
    assert.match(gate.pinHold, /metadata changed/);
    assert.equal(gate._decision(gate.toolStatus.get('clock')).allow, false);
  }
  for (const value of ['not json', '{}']) {
    await fs.writeFile(lockPath, value);
    const gate = new McpGate({ send() {}, recheck: true, lockPath });
    gate.serverInfo = baseline.serverInfo;
    await gate._finishVerify(tools);
    assert.equal(gate._decision(gate.toolStatus.get('clock')).allow, false);
  }
  await fs.unlink(lockPath);
  await baseline._finishVerify(tools);
  assert.ok(baseline.pinHold, 'a missing previously established pin cannot become unpinned');
});
