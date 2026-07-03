"use strict";

const os = require("node:os");

// ---------------------------------------------------------------------------
// Bounded-concurrency worker pool — the single shared implementation.
//
// Extracted from lockfile.js's `runDeep` so the lockfile deep-scan pass and the
// recheck monitoring tier fan out through the *same* machinery instead of each
// hand-rolling a queue + workers. Results are index-aligned with `items`, so
// downstream folds (worst-verdict) stay order-independent regardless of which
// worker finishes first.
// ---------------------------------------------------------------------------

// Default cap for the recheck fan-out: ~8 or the machine's core count, never
// more than there is work to do. Matches the "worker cap ~8, or min(cpus, n)"
// contract in the recheck spec.
function defaultConcurrency(n) {
  return Math.max(1, Math.min(8, os.cpus().length || 1, n));
}

// Run `fn(item, index)` over every item with at most `concurrency` in flight.
// Returns a promise for the results array, positionally aligned with `items`.
// `fn` is responsible for its own error handling — a throw rejects the whole
// pool (callers that want per-item isolation should catch inside `fn`).
async function mapPool(items, concurrency, fn) {
  const list = Array.from(items);
  const results = new Array(list.length);
  const width = Math.max(1, Math.min(concurrency || 1, list.length || 1));
  let next = 0;

  async function worker() {
    while (true) {
      const i = next;
      next += 1;
      if (i >= list.length) return;
      results[i] = await fn(list[i], i);
    }
  }

  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}

module.exports = { mapPool, defaultConcurrency };
