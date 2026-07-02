"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { mapPool, defaultConcurrency } = require("../src/pool");

test("mapPool preserves index alignment regardless of finish order", async () => {
  const items = [30, 5, 20, 1, 10];
  const out = await mapPool(items, 3, async (n) => {
    await new Promise((r) => setTimeout(r, n));
    return n * 2;
  });
  assert.deepEqual(out, [60, 10, 40, 2, 20]);
});

test("mapPool never exceeds the concurrency cap", async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  await mapPool(items, 4, async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
  });
  assert.ok(peak <= 4, `peak concurrency ${peak} exceeded cap 4`);
});

test("mapPool handles an empty list", async () => {
  assert.deepEqual(await mapPool([], 4, async () => 1), []);
});

test("defaultConcurrency caps at 8 and never exceeds the item count", () => {
  assert.equal(defaultConcurrency(3), 3);
  assert.ok(defaultConcurrency(1000) <= 8);
  assert.equal(defaultConcurrency(0), 1);
});
