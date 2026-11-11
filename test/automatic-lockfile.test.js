"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("../src/http-client");
const { auditLockfile, batchOsvQuery, renderLockfileMarkdown } = require("../src/lockfile");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pkgxray-automatic-audit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "package.json");
  await fs.writeFile(file, JSON.stringify({ dependencies: { example: "1.2.3" } }));
  return file;
}
function mockHttp(t, fn) {
  const original = http.requestJson;
  http.requestJson = fn;
  t.after(() => { http.requestJson = original; });
}

test("a transient advisory failure retries identical queries once within one deadline", async t => {
  const file = await fixture(t), calls = [];
  mockHttp(t, async (url, options) => {
    calls.push({ url, body: options.body, deadline: options.deadline });
    if (calls.length === 1) throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    return { results: [{}] };
  });
  const result = await auditLockfile(file, { triageDecisions: false });
  assert.equal(result.worstDecision, "safe");
  assert.equal(result.coverage.vulnerabilities.completed, true);
  assert.equal(result.resolution.retry.attempts, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
});

test("an exhausted retry blocks without presenting a review or calling it malware", async t => {
  const file = await fixture(t); let calls = 0;
  mockHttp(t, async () => { calls++; throw Object.assign(new Error("upstream unavailable"), { statusCode: 503 }); });
  const result = await auditLockfile(file, { triageDecisions: new Map([["example@1.2.3", { decision: "allow" }]]) });
  assert.equal(calls, 2);
  assert.equal(result.worstDecision, "block");
  assert.equal(result.summary.inconclusive, 1);
  assert.equal(result.summary.blocked, 1);
  assert.equal(result.coverage.vulnerabilities.completed, false);
  assert.match(renderLockfileMarkdown(result), /not a confirmed malware finding/);
  assert.doesNotMatch(renderLockfileMarkdown(result), /REVIEW|Proceed|Decline/);
});

test("malformed advisory data is blocked without retrying unchanged bad evidence", async t => {
  const file = await fixture(t); let calls = 0;
  mockHttp(t, async () => { calls++; return { results: [] }; });
  const result = await auditLockfile(file, { triageDecisions: false });
  assert.equal(calls, 1);
  assert.equal(result.worstDecision, "block");
  assert.equal(result.resolution.retry.attempted, false);
});

test("disabled advisory checks cannot be presented as a clean dependency audit", async t => {
  const file = await fixture(t);
  mockHttp(t, async () => { throw new Error("disabled check must not make network calls"); });
  const result = await auditLockfile(file, { vulnerabilityCheck: false, triageDecisions: false });
  assert.equal(result.worstDecision, "block");
  assert.deepEqual(result.results[0].resolution.reasonCodes, ["vulnerability-check-disabled"]);
  assert.equal(result.resolution.retry.attempted, false);
});

test("cancellation prevents an automatic advisory retry", async t => {
  const controller = new AbortController(); let calls = 0;
  mockHttp(t, async () => { calls++; controller.abort(); throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); });
  await assert.rejects(batchOsvQuery(new Map([["example", { name: "example", version: "1.2.3" }]]), "npm", { signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 1);
});
