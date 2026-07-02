import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePath } from '../src/path-parser.js';

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
