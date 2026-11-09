"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { selectCases, unwrap, safeExtractorAvailable, summarizeCases, isTransientDownloadError,
  BENIGN_CONTROLS } = require('../scripts/validate-external-corpus');
const safeExtractor = safeExtractorAvailable();
const extractionOptions = { skip: safeExtractor ? false : 'Requires POSIX Python 3 with O_NOFOLLOW; CLI refuses without it' };

test('external selection is deterministic, bounded, historical and distinct by package', () => {
  const blob = (name, version = '1.0.0', date = '2024-01-01', size = 100) => ({ type: 'blob', size, path: `${name}/${version}/${date}-${name}.zip` });
  const entries = [blob('alpha'), blob('alpha', '2.0.0'), blob('beta'), blob('gamma'),
    blob('future', '1.0.0', '2025-01-01'), blob('oversized', '1.0.0', '2024-01-01', 5 * 1024 * 1024),
    { type: 'blob', path: '../escape/1.0.0/2024-01-01-escape.zip', size: 100 }];
  const a = selectCases({ tree: entries, truncated: false }, 'malicious_intent');
  const b = selectCases({ tree: [...entries].reverse(), truncated: false }, 'malicious_intent');
  assert.deepEqual(a, b);
  assert.deepEqual(a.map(c => c.packageName).sort(), ['alpha', 'beta', 'gamma']);
  assert.equal(a.find(c => c.packageName === 'alpha').version, '1.0.0');
  assert.throws(() => selectCases({ tree: entries, truncated: true }, 'malicious_intent'), /truncated/);
});

test('benign controls are exact registry artifacts with pinned unique identities', () => {
  assert.equal(BENIGN_CONTROLS.length, 4);
  assert.equal(new Set(BENIGN_CONTROLS.map(item => `${item.packageName}@${item.version}`)).size, BENIGN_CONTROLS.length);
  for (const control of BENIGN_CONTROLS) {
    const url = new URL(control.sourceUrl);
    assert.equal(control.label, 'benign');
    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname, 'registry.npmjs.org');
    assert.match(control.artifactSha256, /^[a-f0-9]{64}$/);
    assert.ok(url.pathname.includes(control.version));
  }
});

test('external summary separates holds, confirmed blocks and benign review burden', () => {
  const summary = summarizeCases([
    { label: 'malicious', verdict: 'review' }, { label: 'malicious', verdict: 'block' },
    { label: 'malicious', error: 'bounded refusal' }, { label: 'benign', verdict: 'safe' },
    { label: 'benign', verdict: 'review' }, { label: 'benign', verdict: 'block' }
  ]);
  assert.deepEqual(summary.byLabel, {
    malicious: { safe: 0, review: 1, block: 1, errors: 1 },
    benign: { safe: 1, review: 1, block: 1, errors: 0 }
  });
  assert.deepEqual(summary.metrics, {
    maliciousHoldRate: 1, maliciousBlockRate: 0.5,
    benignFalseBlockRate: 1 / 3, benignReviewRate: 1 / 3
  });
  assert.throws(() => summarizeCases([{ label: 'unknown', verdict: 'safe' }]), /Unexpected corpus label/);
});

test('external downloader retries only transient failures', () => {
  for (const error of [Object.assign(new Error('limited'), { statusCode: 429 }),
    Object.assign(new Error('upstream'), { statusCode: 503 }), new Error('Corpus request deadline exceeded'),
    new Error('read ECONNRESET')]) assert.equal(isTransientDownloadError(error), true);
  for (const error of [Object.assign(new Error('missing'), { statusCode: 404 }),
    Object.assign(new Error('unauthorized'), { statusCode: 401 }), new Error('SHA256 differs')]) {
    assert.equal(isTransientDownloadError(error), false);
  }
});

async function makeZip(root, members) {
  const zipPath = path.join(root, 'sample.zip');
  // These are inert gzip bytes produced inside the fixture builder. No member
  // is executed or extracted, including traversal and executable-looking names.
  const source = `import gzip,json,sys,zipfile,stat
with zipfile.ZipFile(sys.argv[1],'w') as archive:
 for item in json.loads(sys.argv[2]):
  member=zipfile.ZipInfo(item['name'])
  member.external_attr=(stat.S_IFLNK|0o777)<<16 if item.get('link') else (stat.S_IFREG|0o600)<<16
  archive.writestr(member,item['content'].encode('utf-8') if 'content' in item else gzip.compress(b'inert archive bytes'))`;
  await execFileAsync('python3', ['-c', source, zipPath, JSON.stringify(members)]);
  return zipPath;
}

test('bounded ZIP reader emits only the selected TGZ to a controlled filename', extractionOptions, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pkgxray-inert-zip-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const zip = await makeZip(root, [{ name: 'sample/package.tgz' }, { name: 'sample/metadata.json' }]);
  const output = path.join(root, 'artifact.tgz');
  const result = await unwrap(zip, output);
  assert.equal(result.member, 'sample/package.tgz');
  assert.ok((await fs.stat(output)).size > 0);
  assert.deepEqual((await fs.readdir(root)).sort(), ['artifact.tgz', 'sample.zip']);
});

test('bounded ZIP reader rejects traversal, links, duplicate tarballs and destination replacement', extractionOptions, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pkgxray-inert-zip-reject-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const members of [[{ name: '../escape.tgz' }], [{ name: '/escape.tgz' }],
    [{ name: 'package.tgz', link: true }], [{ name: 'one.tgz' }, { name: 'two.tgz' }]]) {
    const zip = await makeZip(root, members);
    await assert.rejects(() => unwrap(zip, path.join(root, 'artifact.tgz')));
    await assert.rejects(fs.stat(path.join(root, 'artifact.tgz')), { code: 'ENOENT' });
  }
  const zip = await makeZip(root, [{ name: 'sample/package.tgz' }]);
  const output = path.join(root, 'artifact.tgz'); await fs.writeFile(output, 'preserved');
  await assert.rejects(() => unwrap(zip, output));
  assert.equal(await fs.readFile(output, 'utf8'), 'preserved');
});

test('derived-tree reader materializes only one package subtree with non-executable files', extractionOptions, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pkgxray-inert-tree-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const zip = await makeZip(root, [
    { name: 'sample/package/package.json', content: '{"name":"inert","version":"1.0.0"}' },
    { name: 'sample/package/index.js', content: 'module.exports = 1;' },
    { name: 'sample/metadata.json', content: '{"metadata":"ignored"}' }
  ]);
  const output = path.join(root, 'tree');
  const result = await unwrap(zip, output);
  assert.equal(result.mode, 'derived-package-tree');
  assert.equal(result.files, 2);
  assert.match(result.treeSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual((await fs.readdir(output)).sort(), ['index.js', 'package.json']);
  assert.equal((await fs.stat(path.join(output, 'index.js'))).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(path.join(output, 'index.js'), 'utf8'), 'module.exports = 1;');
});

test('derived-tree reader rejects ambiguous roots and preserves an existing destination', extractionOptions, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pkgxray-inert-tree-reject-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let zip = await makeZip(root, [
    { name: 'one/package/package.json', content: '{}' }, { name: 'two/package/package.json', content: '{}' }
  ]);
  const output = path.join(root, 'tree');
  await assert.rejects(() => unwrap(zip, output));
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
  zip = await makeZip(root, [{ name: 'one/package/package.json', content: '{}' }]);
  await fs.mkdir(output); await fs.writeFile(path.join(output, 'preserved'), 'ok');
  await assert.rejects(() => unwrap(zip, output));
  assert.equal(await fs.readFile(path.join(output, 'preserved'), 'utf8'), 'ok');
});

test('derived-tree reader refuses duplicate, case-collision, traversal and link members before materializing', extractionOptions, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pkgxray-inert-tree-paths-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageJson = { name: 'one/package/package.json', content: '{}' };
  const output = path.join(root, 'tree');
  for (const members of [
    [packageJson, packageJson],
    [packageJson, { name: 'one/package/INDEX.js' }, { name: 'one/package/index.js' }],
    [packageJson, { name: 'one/package/Dir/a.js' }, { name: 'one/package/dir/b.js' }],
    [packageJson, { name: 'one/package/../escape.js' }],
    [packageJson, { name: 'one/package/index.js', link: true }]
  ]) {
    const zip = await makeZip(root, members);
    await assert.rejects(() => unwrap(zip, output));
    await assert.rejects(fs.stat(output), { code: 'ENOENT' });
  }
});
