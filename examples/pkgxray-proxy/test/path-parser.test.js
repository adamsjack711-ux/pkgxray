import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePath, canonicalTarballPath } from '../src/path-parser.js';

test('unscoped metadata', () => {
  assert.deepEqual(parsePath('/lodash'), { kind: 'metadata', name: 'lodash' });
});

test('unscoped version metadata', () => {
  assert.deepEqual(parsePath('/lodash/4.17.21'), {
    kind: 'metadata', name: 'lodash', version: '4.17.21',
  });
});

test('scoped metadata', () => {
  assert.deepEqual(parsePath('/@babel/core'), { kind: 'metadata', name: '@babel/core' });
});

test('scoped metadata url-encoded slash', () => {
  assert.deepEqual(parsePath('/@babel%2fcore'), { kind: 'metadata', name: '@babel/core' });
});

test('unscoped tarball', () => {
  assert.deepEqual(parsePath('/lodash/-/lodash-4.17.21.tgz'), {
    kind: 'tarball', name: 'lodash', version: '4.17.21', filename: 'lodash-4.17.21.tgz',
  });
});

test('scoped tarball', () => {
  assert.deepEqual(parsePath('/@babel/core/-/core-7.24.0.tgz'), {
    kind: 'tarball', name: '@babel/core', version: '7.24.0', filename: 'core-7.24.0.tgz',
  });
});

test('scoped tarball url-encoded', () => {
  assert.deepEqual(parsePath('/@scope%2fpkg/-/pkg-1.2.3.tgz'), {
    kind: 'tarball', name: '@scope/pkg', version: '1.2.3', filename: 'pkg-1.2.3.tgz',
  });
});

test('tarball with prerelease version', () => {
  assert.deepEqual(parsePath('/react/-/react-19.0.0-rc.1.tgz'), {
    kind: 'tarball', name: 'react', version: '19.0.0-rc.1', filename: 'react-19.0.0-rc.1.tgz',
  });
});

test('registry service endpoints are "other"', () => {
  assert.equal(parsePath('/-/v1/search?text=lodash').kind, 'other');
  assert.equal(parsePath('/-/npm/v1/user').kind, 'other');
});

test('root is "other"', () => {
  assert.equal(parsePath('/').kind, 'other');
  assert.equal(parsePath('').kind, 'other');
});

test('query string is ignored for metadata name', () => {
  assert.deepEqual(parsePath('/lodash?write=true'), { kind: 'metadata', name: 'lodash' });
});

test('bare @scope with no package is "other"', () => {
  assert.equal(parsePath('/@scope').kind, 'other');
});

test('non-tgz under /-/ is not a tarball', () => {
  // Defensive: only .tgz under /-/ is a tarball.
  assert.notEqual(parsePath('/foo/-/foo-1.0.0.txt').kind, 'tarball');
});

test('divergent basename is flagged invalid (gate bypass)', () => {
  // Scanned as lodash@4.17.21 but the file is named evil-… — the served bytes
  // would not correspond to what was scanned. Must be kind:'tarball' (so it
  // reaches the gate) AND invalid (so the proxy fails closed).
  const r = parsePath('/lodash/-/evil-4.17.21.tgz');
  assert.equal(r.kind, 'tarball');
  assert.equal(r.invalid, true);
});

test('path traversal in basename is flagged invalid', () => {
  const r = parsePath('/lodash/-/../../../etc-1.0.tgz');
  assert.equal(r.kind, 'tarball');
  assert.equal(r.invalid, true);
});

test('version-field path smuggling is flagged invalid', () => {
  const r = parsePath('/lodash/-/lodash-4.17.21.tgz/../evil/-/evil-1.0.0.tgz');
  assert.equal(r.kind, 'tarball');
  assert.equal(r.invalid, true);
});

test('canonical tarballs are not flagged invalid', () => {
  assert.equal(parsePath('/lodash/-/lodash-4.17.21.tgz').invalid, undefined);
  assert.equal(parsePath('/@babel/core/-/core-7.24.0.tgz').invalid, undefined);
  assert.equal(parsePath('/react/-/react-19.0.0-rc.1.tgz').invalid, undefined);
});

test('canonicalTarballPath rebuilds the vetted upstream path', () => {
  assert.equal(canonicalTarballPath('lodash', '4.17.21'), '/lodash/-/lodash-4.17.21.tgz');
  assert.equal(canonicalTarballPath('@babel/core', '7.24.0'), '/@babel/core/-/core-7.24.0.tgz');
});
