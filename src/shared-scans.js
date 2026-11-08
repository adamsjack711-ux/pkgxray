"use strict";
const { BoundedQueue } = require('./bounded-queue');
const { fingerprint, BUILD_ID, computeBuildId } = require('./artifact');
const fs = require('node:fs');
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const failure = (code, message) => Object.assign(new Error(message), { code });
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
// Detect changed on-disk runtime/rules before using cached evidence. A running
// process cannot safely mix already-loaded policy code with newly loaded workers.
const root = path.join(__dirname, '..');
function runtimeStamp() {
  const entries = [];
  function walk(relative) {
    const file = path.join(root, relative), stat = fs.lstatSync(file);
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) walk(path.join(relative, name));
    else if (stat.isFile()) entries.push([relative, stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino]);
    else throw failure('SCANNER_CHANGED', 'Non-regular scanner runtime; restart with a verified build');
  }
  for (const relative of ['src', 'bin', 'package.json']) walk(relative);
  return JSON.stringify(entries);
}
let loadedStamp = runtimeStamp();
function assertCurrentBuild() {
  const stamp = runtimeStamp();
  if (stamp !== loadedStamp) {
    if (computeBuildId(root) !== BUILD_ID) throw failure('SCANNER_CHANGED', 'Scanner runtime or rules changed; restart before using scan evidence');
    loadedStamp = stamp;
  }
}
// One owner per process. Only immutable evidence enters the cache; policy,
// approvals, staging paths and requested actions remain outside this service.
class SharedScans {
  constructor({ concurrency = 4, maxQueue = 32, maxBytes = 32 * 1024 * 1024,
    maxCacheBytes = 32 * 1024 * 1024, maxEntries = 128, ttlMs = 60000,
    timeoutMs = 30000, maxWaiters = 512 } = {}) {
    Object.assign(this, { maxCacheBytes, maxEntries, ttlMs, timeoutMs, maxWaiters });
    this.queue = new BoundedQueue({ concurrency, maxTasks: concurrency + maxQueue, maxBytes });
    this.jobs = new Map(); this.cache = new Map(); this.cacheBytes = 0; this.waiters = 0;
    this.metrics = { scans: 0, hits: 0, joined: 0, rejections: 0, errors: 0, cancellations: 0, timeouts: 0, peakQueue: 0, peakActive: 0 };
  }
  snapshot() { return { ...this.metrics, active: this.queue.running, queued: this.queue.tasks.length, jobs: this.jobs.size, waiters: this.waiters, cacheEntries: this.cache.size, cacheBytes: this.cacheBytes }; }
  get(key, scan, { signal, bytes = 0, cache = true } = {}) {
    if (signal?.aborted) return Promise.reject(failure('SCAN_CANCELLED', 'Scan request cancelled'));
    const stored = this.cache.get(key);
    if (stored && stored.expires > Date.now()) {
      this.metrics.hits++; this.cache.delete(key); this.cache.set(key, stored);
      return Promise.resolve({ evidence: stored.evidence, source: 'cache' });
    }
    if (stored) { this.cache.delete(key); this.cacheBytes -= stored.bytes; }
    if (this.waiters >= this.maxWaiters) return this.overload();
    let job = this.jobs.get(key), source = 'shared-scan';
    // A new caller may arrive while a cancelled worker is terminating. Queue
    // fresh work under the normal bounds; never inherit its cancellation.
    if (job?.done) job = null;
    if (!job) {
      source = 'scan';
      job = { key, controller: new AbortController(), subscribers: new Set(), done: false };
      job.run = async () => {
        if (job.done) return;
        this.metrics.scans++; this.metrics.peakActive = Math.max(this.metrics.peakActive, this.queue.running);
        try {
          const evidence = freeze(structuredClone(await scan(job.controller.signal)));
          if (!job.done && cache) this.put(key, evidence);
          this.finish(job, null, evidence);
        } catch (error) { if (!job.done) this.metrics.errors++; this.finish(job, error); }
        finally { if (this.jobs.get(key) === job) this.jobs.delete(key); }
      };
      if (!this.queue.enqueue(job.run, bytes)) return this.overload();
      this.jobs.set(key, job);
      this.metrics.peakQueue = Math.max(this.metrics.peakQueue, this.queue.tasks.length);
      job.timer = setTimeout(() => {
        this.metrics.timeouts++;
        this.stop(job, failure('SCAN_TIMEOUT', 'Shared scan deadline exceeded'));
      }, this.timeoutMs);
    } else {
      this.metrics.joined++;
    }
    return new Promise((resolve, reject) => {
      this.waiters++;
      const subscriber = { resolve: evidence => resolve({ evidence, source }), reject, signal };
      subscriber.abort = () => {
        this.metrics.cancellations++;
        this.detach(job, subscriber); reject(failure('SCAN_CANCELLED', 'Scan request cancelled'));
        if (!job.subscribers.size) this.stop(job, failure('SCAN_CANCELLED', 'No scan callers remain'));
      };
      job.subscribers.add(subscriber);
      signal?.addEventListener('abort', subscriber.abort, { once: true });
      if (signal?.aborted) subscriber.abort();
    });
  }
  overload() { this.metrics.rejections++; return Promise.reject(failure('SCAN_OVERLOADED', 'Shared scan capacity exceeded; no action authorized; retry later')); }
  detach(job, sub) { if (job.subscribers.delete(sub)) { this.waiters--; sub.signal?.removeEventListener('abort', sub.abort); } }
  finish(job, error, evidence) {
    if (job.done) return;
    job.done = true; clearTimeout(job.timer);
    for (const sub of [...job.subscribers]) { this.detach(job, sub); error ? sub.reject(error) : sub.resolve(evidence); }
  }
  stop(job, error) {
    this.finish(job, error); job.controller.abort();
    if (this.queue.remove(job.run)) this.jobs.delete(job.key);
    // A running slot is released only after the worker has actually stopped.
  }
  put(key, evidence) {
    const bytes = Buffer.byteLength(JSON.stringify(evidence));
    if (bytes > this.maxCacheBytes) return;
    if (this.cache.has(key)) this.cacheBytes -= this.cache.get(key).bytes;
    this.cache.delete(key); this.cache.set(key, { evidence, bytes, expires: Date.now() + this.ttlMs }); this.cacheBytes += bytes;
    while (this.cache.size > this.maxEntries || this.cacheBytes > this.maxCacheBytes) {
      const oldest = this.cache.keys().next().value;
      this.cacheBytes -= this.cache.get(oldest).bytes; this.cache.delete(oldest);
    }
  }
  close() { for (const job of this.jobs.values()) this.stop(job, failure('SCAN_CANCELLED', 'Scan service closed')); this.queue.close(); this.cache.clear(); this.cacheBytes = 0; }
}
function workerScan(evidence, analysis, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'scan-worker.js'), { workerData: { evidence, analysis, buildId: BUILD_ID },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 } });
    let result, error;
    const abort = () => { error = failure('SCAN_CANCELLED', 'Static analysis cancelled'); void worker.terminate(); };
    signal.addEventListener('abort', abort, { once: true });
    worker.once('message', message => { result = message; });
    worker.once('error', err => { error = err; });
    worker.once('exit', code => {
      signal.removeEventListener('abort', abort);
      if (error || code !== 0 || !result) reject(error || failure('SCAN_ERROR', 'Static analysis worker failed'));
      else resolve(result);
    });
    if (signal.aborted) abort();
  });
}
const sharedScans = new SharedScans();
async function analyzeShared(evidence, analysis = {}, { signal, artifactSha256, service = sharedScans, buildId = BUILD_ID } = {}) {
  assertCurrentBuild();
  // Snapshot before hashing and dispatch: callers cannot mutate queued evidence.
  const input = structuredClone({ evidence, analysis });
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized) > 8 * 1024 * 1024) throw failure('SCAN_OVERLOADED', 'Static analysis input exceeds 8 MiB');
  const key = fingerprint({ artifactSha256: artifactSha256 || fingerprint(input.evidence.sourceFiles), input, buildId });
  const result = await service.get(key, signal => workerScan(input.evidence, input.analysis, signal), { signal, bytes: Buffer.byteLength(serialized) });
  assertCurrentBuild();
  return result;
}
module.exports = { SharedScans, sharedScans, analyzeShared, assertCurrentBuild, failure };
