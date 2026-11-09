import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.mjs';
import { runSmoke } from './smoke.mjs';
const endpoint = 'https://mcp.pkgxray.ca/mcp';
const env = { PUBLIC_ORIGIN: 'https://mcp.pkgxray.ca', MCP_RATE_LIMITER: { limit: async () => ({ success: true }) }, SCAN_RATE_LIMITER: { limit: async () => ({ success: true }) } };
test('monitor exercises the public protocol and negative cases without external metadata', async () => {
  const r = await runSmoke(endpoint, { metadata: false, fetcher: (url, options) => worker.fetch(new Request(url, options), env) });
  assert.equal(r.passed, true, JSON.stringify(r.checks)); assert.equal(r.checks.length, 12);
});
test('monitor fails closed for redirects, oversized and malformed responses', async () => {
  for (const response of [new Response('', { status: 302, headers: { location: 'https://other.invalid' } }), new Response('x'.repeat(256 * 1024 + 1)), new Response('not json')]) {
    const r = await runSmoke(endpoint, { fetcher: async (_url, options) => { assert.equal(options.redirect, 'manual'); return response; } });
    assert.equal(r.passed, false); assert.equal(r.checks.length, 1);
  }
});
test('monitor deadlines cancel stalled response bodies and never mark them passed', async () => {
  let cancelled = false;
  const r = await runSmoke(endpoint, { timeoutMs: 20, fetcher: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
  assert.equal(r.passed, false); assert.match(r.checks[0].error, /deadline/); assert.equal(cancelled, true);
});
