'use strict';

// Optional network regression. Retrieve only these pinned source files as
// inert strings; never install, import or execute the inspected package.
// The withdrawn 2.1.2 manifest is unavailable, so this is reconstructed source
// evidence with an explicit main, not a claim to scan the entire npm archive.
const https = require('node:https');
const crypto = require('node:crypto');
const { auditEvidence } = require('../src/auditor');
const { createFlowAnalysis } = require('../src/flow-analysis');
const samples = [
  ['2.1.2', 'b+tree.js', '/F+Vi7Fmzr+txZTfkXSVY19ber8hDzRgDztERPLr8Cg='],
  ['2.1.2', 'extended/sharedLoad.min.js', 'T3Ckv9Ly8rOTOVzPUiF6WZZF0DME3ahNrc0QyliUSTI='],
  ['2.1.2', 'extended/subtractLoad.min.d.js', 'a7HQU+R0rO29X2Ae9Aa6fm1v7ZTyJYUXzcsLrqz3MnQ='],
  ['2.1.3', 'b+tree.js', 'vDu3SJuM7cqypStfbz4kj46cKfy68+hGuXEmb5AAKps=']
];
function retrieve(version, file, expected) {
  return new Promise((resolve, reject) => {
    const request = https.get(`https://cdn.jsdelivr.net/npm/indexed-btree@${version}/${file}`, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`${version}/${file}: HTTP ${response.statusCode}`)); return; }
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        if ((size += chunk.length) > 1024 * 1024) { response.destroy(new Error('source response limit')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const bytes = Buffer.concat(chunks);
        if (crypto.createHash('sha256').update(bytes).digest('base64') !== expected) { reject(new Error(`${version}/${file}: hash mismatch`)); return; }
        resolve({ version, file, sha256: expected, content: bytes.toString('utf8') });
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('source request deadline')), 20000);
    request.on('error', reject); request.on('close', () => clearTimeout(timer));
  });
}
async function run() {
  const files = await Promise.all(samples.map(args => retrieve(...args)));
  const results = ['2.1.2', '2.1.3'].map(version => {
    const selected = files.filter(f => f.version === version);
    const sourceFiles = Object.fromEntries(selected.map(f => [f.file, f.content]));
    sourceFiles['package.json'] = JSON.stringify({ name: 'indexed-btree', version, main: 'b+tree.js' });
    const report = auditEvidence({ sourceFiles });
    return { version, verdict: report.verdict, score: report.score,
      files: selected.map(({file,sha256,content}) => ({file,sha256,bytes:Buffer.byteLength(content),
        flow: (() => { const a=createFlowAnalysis([{path:file,content}]).analyze(file); return {status:a.status,gaps:a.gaps.filter(g=>g.relevant!==false).map(g=>({...g,context:version==='2.1.3'?content.slice(g.index,g.index+100):undefined}))}; })()})),
      findings: report.findings.filter(f => f.severity !== 'info') };
  });
  console.log(JSON.stringify({scope:'Hash-pinned reconstructed source evidence; synthetic manifest; OSV, GitHub and package execution disabled',results},null,2));
  if (results[0].verdict !== 'block' || !results[0].findings.some(f => f.category === 'hidden-local-loader') || results[1].verdict !== 'safe') process.exitCode = 1;
}
if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
