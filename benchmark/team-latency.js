'use strict';
// Offline full guard benchmark: real archive verification, extraction and
// static analysis. Only OSV is replaced with a deterministic empty response.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
async function main() {
  const { gateArtifact } = await import('../examples/pkgxray-proxy/src/artifact-gate.js');
  const { VerdictStore } = await import('../examples/pkgxray-proxy/src/verdict-store.js');
  const { loadConfig } = await import('../examples/pkgxray-proxy/src/config.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pkgxray-latency-'));
  const transport = require('../src/http-client'), original = transport.requestJson;
  transport.requestJson = async url => {
    if (url !== 'https://api.osv.dev/v1/query') throw new Error(`Unexpected network request: ${url}`);
    return {};
  };
  try {
    await fs.mkdir(path.join(dir, 'package'));
    await fs.writeFile(path.join(dir, 'package/package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', main: 'index.js' }));
    for (let i = 0; i < 25; i++) await fs.writeFile(path.join(dir, `package/${i ? 'module'+i : 'index'}.js`), `exports.value = ${i};\n`.repeat(100));
    const file = path.join(dir, 'package.tgz');
    execFileSync('tar', ['-czf', file, '-C', dir, 'package']);
    const bytes = await fs.readFile(file);
    const snapshot = { file, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    const samples = { cold: [], cacheHit: [], concurrent4: [], concurrent5: [] };
    const counts = {};
    for (const [scenario, timings] of Object.entries(samples)) {
      let scans = 0;
      for (let i = 0; i < 20; i++) {
        const config = loadConfig({ verdictStorePath: path.join(dir, `${scenario}-${i}.json`) }, {});
        const store = new VerdictStore(config.verdictStorePath);
        const runGuard = async (bin, ref, opts) => {
          scans++;
          return require('../src/quarantine').guardExtension(`npm:${ref}`, {
            artifact: opts.artifact, config: require('../src/config').DEFAULTS,
            githubMetadata: false, githubDiff: false, provenance: false
          });
        };
        const call = () => gateArtifact({ config, store, name: 'fixture', version: '1.0.0', snapshot, runGuard });
        if (scenario === 'cacheHit') await call();
        const before = scans, start = performance.now();
        const n = scenario === 'concurrent4' ? 4 : scenario === 'concurrent5' ? 5 : 1;
        const results = await Promise.all(Array.from({ length: n }, call));
        timings.push(performance.now() - start);
        if (results.some(r => !r.serve)) throw new Error(JSON.stringify(results));
        if (scans - before !== (scenario === 'cacheHit' ? 0 : 1)) throw new Error('Duplicate scan');
      }
      counts[scenario] = scans;
    }
    const stats = values => {
      const sorted = [...values].sort((a,b) => a-b);
      return { medianMs: +sorted[10].toFixed(3), p95Ms: +sorted[18].toFixed(3), minMs: +sorted[0].toFixed(3), maxMs: +sorted[19].toFixed(3) };
    };
    console.log(JSON.stringify({ node: process.version, platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0].model,
      rounds: 20, fixture: { files: 26, archiveBytes: bytes.length },
      scope: 'In-process team gate plus disk cache, real guard/archive/static scan; OSV stubbed; excludes network, artifact download, process startup and human decision latency; concurrent timings are whole-batch wall time.',
      results: Object.fromEntries(Object.entries(samples).map(([k,v]) => [k, { ...stats(v), measuredScans: k === 'cacheHit' ? 0 : counts[k], warmupScans: k === 'cacheHit' ? counts[k] : 0 }])) }, null, 2));
  } finally { transport.requestJson = original; await fs.rm(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
