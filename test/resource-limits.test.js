"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const { requestText } = require("../src/http-client");
const { runCapture } = require("../src/bounded-process");

function fakeTransport(deliver) {
  return { get(url, options, receive) {
    const req = new EventEmitter();
    req.destroy = () => { req.destroyed = true; };
    process.nextTick(() => {
      const res = new PassThrough();
      res.statusCode = 200;
      receive(res);
      deliver(res);
    });
    return req;
  } };
}

test("HTTP body limit counts bytes, rejects overflow, and accepts complete bodies", async () => {
  await assert.rejects(requestText("https://fixture", { maxBytes: 3, transport: fakeTransport(res => res.end("éé")) }), /exceeded/);
  assert.deepEqual(await requestText("https://fixture", { maxBytes: 4, transport: fakeTransport(res => res.end("éé")) }), { statusCode: 200, body: "éé" });
});

test("HTTP total deadline rejects stalled responses", async () => {
  await assert.rejects(requestText("https://fixture", { timeoutMs: 20, transport: fakeTransport(() => {}) }), /timed out/);
});

test("HTTP deadline covers stalled DNS, slow-drip bodies and unfinished output streams", async () => {
  let destroyed = false;
  const transport = { get() { const req = new EventEmitter(); req.destroy = () => { destroyed = true; }; return req; } };
  await assert.rejects(requestText("https://fixture", { transport, timeoutMs: 15 }), /timed out/);
  assert.equal(destroyed, true);
  let interval;
  await assert.rejects(requestText("https://fixture", { timeoutMs: 25,
    transport: fakeTransport(res => {
      interval = setInterval(() => res.write('a'), 4);
      res.once('close', () => clearInterval(interval));
    }) }), /timed out/);
  clearInterval(interval);
  const writable = new Writable({ write(chunk, encoding, callback) { callback(); }, final() {} });
  await assert.rejects(requestText("https://fixture", { writable, timeoutMs: 15,
    transport: fakeTransport(res => res.end('small')) }), /timed out/);
  assert.equal(writable.destroyed, true);
});

test("streamed downloads enforce byte limits and reject aborted bodies", async () => {
  const output = () => new Writable({ write(chunk, encoding, callback) { callback(); } });
  const writable = output();
  await assert.rejects(requestText("https://fixture", { writable, maxBytes: 3,
    transport: fakeTransport(res => res.end('éé')) }), /exceeded/);
  assert.equal(writable.destroyed, true);
  await assert.rejects(requestText("https://fixture", { writable: output(),
    transport: fakeTransport(res => { res.write('part'); res.emit('aborted'); res.destroy(); }) }), /aborted/);
});

test("bounded queues account for running tasks and reject excess retained bytes", async () => {
  const { BoundedQueue } = require('../src/bounded-queue');
  let release;
  const queue = new BoundedQueue({ maxTasks: 2, maxBytes: 5 });
  assert.equal(queue.enqueue(() => new Promise(resolve => { release = resolve; }), 3), true);
  assert.equal(queue.enqueue(() => {}, 3), false);
  assert.equal(queue.enqueue(() => {}, 2), true);
  assert.equal(queue.enqueue(() => {}, 0), false);
  await new Promise(resolve => setImmediate(resolve));
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queue.count, 0); assert.equal(queue.bytes, 0);
  queue.close(); assert.equal(queue.enqueue(() => {}), false);
});

test("bounded file downloads clean up partial output without deleting existing files", async t => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const dir = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'pkgxray-download-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'held.tgz');
  const validate = value => ({ url: new URL(value) });
  const { downloadFile } = require('../src/http-client');
  await assert.rejects(downloadFile('https://fixture.invalid', file, {
    validate, maxBytes: 3, transport: fakeTransport(res => res.end('small fixture'))
  }), /exceeded/);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  await fs.writeFile(file, 'keep');
  await assert.rejects(downloadFile('https://fixture.invalid', file, {
    validate, transport: fakeTransport(res => res.end('replacement'))
  }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(file, 'utf8'), 'keep');
});

test("HTTP interrupted response is never treated as complete", async () => {
  await assert.rejects(requestText("https://fixture", { transport: fakeTransport(res => { res.write("partial"); res.destroy(); }) }), /closed before completion/);
});

test("child process output and execution limits terminate work", async () => {
  await assert.rejects(runCapture(process.execPath, ["-e", "process.stdout.write('x'.repeat(10000))"], { maxBytes: 100 }), /resource limit/);
  await assert.rejects(runCapture(process.execPath, ["-e", "process.stdout.write('x\\n'.repeat(100))"], { maxLines: 10 }), /resource limit/);
  await assert.rejects(runCapture(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 100 }), /timed out/);
});
