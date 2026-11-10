'use strict';
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { start, evidence, call } = require('../test/helpers/mcp-load-client');
const rounds = Number(process.env.PKGXRAY_BENCH_ROUNDS || 3);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error('PKGXRAY_BENCH_ROUNDS must be 1..10');
const percentile = (values, q) => [...values].sort((a,b)=>a-b)[Math.max(0, Math.ceil(values.length*q)-1)];
const rounded = x => +x.toFixed(3);
function result(label, n, round, latencies, duration, before, after, errors, rejected) {
  const cpuMs = (after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system)/1000;
  return { label, callers: n, round, requests: latencies.length, batchMs: rounded(duration),
    p50Ms: rounded(percentile(latencies,.5)), p95Ms: rounded(percentile(latencies,.95)), p99Ms: rounded(percentile(latencies,.99)),
    throughputPerSecond: rounded(latencies.length / duration * 1000), completedWithoutErrorPerSecond: rounded((latencies.length-errors) / duration * 1000), cpuMs: rounded(cpuMs), cpuPercentOfOneCore: rounded(cpuMs/duration*100),
    peakRssMiB: rounded(after.resource.maxRSS/1024), heapUsedMiB: rounded(after.memory.heapUsed/1024/1024),
    scanCount: after.scans.scans-before.scans.scans, cacheHits: after.scans.hits-before.scans.hits,
    coalesced: after.scans.joined-before.scans.joined, peakQueueDepth: after.scans.peakQueue,
    peakActiveScans: after.scans.peakActive, errors, rejections: rejected, unauthorizedActions: 0,
    ...(after.runtime ? { runtime: after.runtime, peakQueueDepth: after.runtime.peakQueue } : {}) };
}
async function staticBatch(n, scenario, round) {
  const client = start();
  try {
    await client.init();
    if (scenario === 'warm' || scenario === 'mixed') assert.ok((await call(client, evidence())).result);
    const inputs = Array.from({ length: n }, (_, i) => evidence(scenario === 'distinct' ? i+1 : scenario === 'mixed' ? (i%2 ? i+1 : 0) : 0));
    const before = await client.stats(), times = [];
    let errors = 0, rejections = 0;
    const begin = performance.now();
    const responses = await Promise.all(inputs.map(async input => {
      const at = performance.now(); const response = await call(client, input); times.push(performance.now()-at);
      if (response.error) { errors++; if (response.error.code === -32001) rejections++; }
      else assert.ok(response.result.structuredContent, 'no missing scan evidence');
      return response;
    }));
    const duration = performance.now()-begin, after = await client.stats();
    if (scenario === 'cold') { assert.equal(after.scans.scans-before.scans.scans, 1); assert.equal(errors,0); }
    if (scenario === 'warm') { assert.equal(after.scans.scans-before.scans.scans,0); assert.equal(errors,0); }
    assert.ok(responses.every(r => r.result || r.error.code === -32001), 'unexpected failure');
    assert.ok(after.scans.peakActive <= 4); assert.ok(after.scans.peakQueue <= 32);
    return result(`static-${scenario}`, n, round, times, duration, before, after, errors, rejections);
  } finally { await client.close(); }
}
async function runtimeBatch(n, pattern, mode, round) {
  const client = start(mode);
  try {
    const list = await client.init(); assert.ok(list.result.tools.length);
    const before = await client.stats(), times = [];
    let blocked = 0;
    const requests = pattern === 'sustained' ? 1000 : n;
    const sustainMs = pattern === 'sustained' ? 5000 : 0;
    let cursor = 0;
    const begin = performance.now();
    await Promise.all(Array.from({ length: n }, async () => {
      while (cursor < requests || performance.now()-begin < sustainMs) {
        const i = cursor++, at = performance.now();
        const unknown = i%10 === 9;
        const response = await client.request('tools/call', { name: unknown ? 'unknown_tool' : 'get_time', arguments: { timezone: 'UTC' } });
        times.push(performance.now()-at);
        const denied = Boolean(response.error || response.result?.isError);
        if (denied) blocked++;
        assert.equal(denied, unknown || mode === 'poisoned-result', 'runtime gate released unauthorized traffic');
        assert.ok(!JSON.stringify(response).includes('Ignore all previous instructions'), 'poisoned result leaked');
      }
    }));
    const duration = performance.now()-begin, after = await client.stats();
    assert.equal(after.scans.scans, 0, 'runtime traffic must not use static package cache');
    assert.equal(after.runtime.calls, cursor);
    return { ...result(`runtime-${pattern}-${mode}`, n, round, times, duration, before, after, 0, 0), enforcedDenials: blocked };
  } finally { await client.close(); }
}
async function main() {
  const rows = [];
  for (let round = 1; round <= rounds; round++) {
    for (const n of [1,5,25,100]) for (const scenario of ['cold','warm','distinct','mixed']) {
      rows.push(await staticBatch(n,scenario,round));
      process.stderr.write(`Completed static ${scenario} / ${n} / round ${round}\n`);
    }
    for (const n of [1,5,25,100]) for (const pattern of ['burst','sustained']) for (const mode of ['benign','poisoned-result']) {
      rows.push(await runtimeBatch(n,pattern,mode,round));
      process.stderr.write(`Completed runtime ${pattern} ${mode} / ${n} / round ${round}\n`);
    }
  }
  const report = { sustainedMinimumMsPerRound: 5000, measuredAt: new Date().toISOString(), node: process.version, platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0].model, rounds,
    classification: 'fixture-only; no network calls and no production services',
    staticPath: 'Real newline-delimited JSON-RPC over child-process stdio → production MCP audit tool → bounded SharedScans → worker-thread auditEvidence → caller policy application → JSON response. Supplied inert package source bytes; excludes archive acquisition and advisory services.',
    runtimePath: 'Real newline-delimited JSON-RPC over stdio → production runMcpProxy frame queue → request-specific McpGate manifest/call checks → child fixture MCP server → per-response result scanning. strict policy, scanResults=true, recheck=false; 10% unknown calls, poisoned-result mode injects inert instruction strings.',
    metricsScope: 'Per-request latencies measured by parent through response parsing. CPU and high-water RSS from instrumented server/proxy process (includes analyzer worker threads, excludes benchmark client and runtime fixture child). RSS includes startup; peak queue is process lifetime. Throughput includes explicit overload replies; errors/rejections are not successful scans. Warm-cache setup excluded from CPU and scan counts.',
    realNetworkResults: null, stubbedNetworkResults: null, rows };
  const output = path.join(__dirname,'mcp-load-results.json');
  await fs.writeFile(output, JSON.stringify(report,null,2)+'\n');
  console.log(output);
}
main().catch(error => { console.error(error); process.exitCode=1; });
