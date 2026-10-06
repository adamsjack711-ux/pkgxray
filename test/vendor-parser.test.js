"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
test('bundled parser matches its recorded source hash, version and license', () => {
  const root = path.join(__dirname, '../src/vendor/acorn');
  const provenance = JSON.parse(fs.readFileSync(path.join(root, 'provenance.json')));
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'acorn.js'))).digest('hex'), provenance.sha256);
  assert.equal(require('../src/vendor/acorn/acorn').version, provenance.version);
  assert.match(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'), /Permission is hereby granted/);
});
