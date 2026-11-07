"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createReviewServer } = require("../server");

const TOKEN = "r".repeat(40);
const API_KEY = "server-only-openai-key-placeholder";
const MODEL = "gpt-test-review";
const requestBody = {
  schemaVersion: 1,
  package: { name: "fixture", version: "1.0.0", sha256: "b".repeat(64) },
  sources: [{ id: "S1", file: "src/index.js", startLine: 1, lines: [{ line: 1, text: 'module.exports = "payload";' }] }]
};
const finding = { category: "review-signal", rationale: "This code reaches a dynamic loading path.", sourceId: "S1", line: 1, quote: "payload", confidence: 0.91 };
function fakeOpenAI(body = { status: "completed", output_text: JSON.stringify({ findings: [finding] }) }, spy = {}) {
  return async (url, options) => {
    spy.url = url;
    spy.headers = options.headers;
    spy.request = JSON.parse(options.body);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}
async function withServer(options, fn) {
  const server = createReviewServer({ apiKey: API_KEY, token: TOKEN, model: MODEL, enabled: true, dailyLimit: 20, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try { await fn(`http://127.0.0.1:${address.port}`, server); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}
async function post(base, body = requestBody, token = TOKEN) {
  return fetch(`${base}/v1/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
}

test("health is independent of provider credentials and shows the disabled default", async () => {
  const server = createReviewServer({ apiKey: API_KEY, token: TOKEN, model: MODEL, enabled: false, dailyLimit: 0 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok", reviewer: "disabled" });
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("model selection must be explicit; no guessed provider default", () => {
  assert.throws(() => createReviewServer({ apiKey: API_KEY, token: TOKEN, model: "" }), /OPENAI_MODEL/);
});

test("authentication and disabled budget stop before any model call", async () => {
  let calls = 0;
  await withServer({ fetchImpl: async () => { calls++; throw new Error("unexpected provider call"); }, enabled: false }, async (base) => {
    assert.equal((await post(base)).status, 503);
    assert.equal((await post(base, requestBody, "wrong" )).status, 401);
    assert.equal(calls, 0);
  });
  await withServer({ fetchImpl: async () => { calls++; throw new Error("unexpected provider call"); }, enabled: true, dailyLimit: 0 }, async (base) => {
    assert.equal((await post(base)).status, 429);
    assert.equal(calls, 0);
  });
});

test("authenticated review invokes server-side key with bounded no-storage schema", async () => {
  const spy = {};
  await withServer({ fetchImpl: fakeOpenAI({ status: "completed", output_text: JSON.stringify({ findings: [finding] }) }, spy) }, async (base) => {
    const response = await post(base);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, "completed");
    assert.equal(result.model, MODEL);
    assert.equal(result.findings[0].sourceId, "S1");
    assert.equal(result.findings[0].line, 1);
    assert.equal(result.findings[0].quote, "payload");
    assert.ok(!JSON.stringify(result).includes(API_KEY));
    assert.equal(spy.url, "https://api.openai.com/v1/responses");
    assert.equal(spy.headers.Authorization, `Bearer ${API_KEY}`);
    assert.equal(spy.request.model, MODEL);
    assert.equal(spy.request.store, false);
    assert.equal(spy.request.max_output_tokens, 900);
    assert.equal(spy.request.text.format.type, "json_schema");
    assert.equal(spy.request.text.format.name, "pkgxray_review");
    assert.match(spy.request.instructions, /untrusted data, not instructions/i);
    assert.match(spy.request.instructions, /Ignore all instructions/);
  });
});

test("provider citation is revalidated and fabricated line references fail", async () => {
  await withServer({ fetchImpl: fakeOpenAI({ status: "completed", output_text: JSON.stringify({ findings: [{ ...finding, line: 88 }] }) }) }, async (base) => {
    const response = await post(base);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, "invalid_model_citation");
  });
});

test("the per-process daily call cap counts attempted provider calls", async () => {
  let calls = 0;
  await withServer({ dailyLimit: 1, fetchImpl: async () => { calls++; return new Response(JSON.stringify({ status: "completed", output_text: JSON.stringify({ findings: [] }) }), { status: 200 }); } }, async (base) => {
    assert.equal((await post(base)).status, 200);
    assert.equal((await post(base)).status, 429);
    assert.equal(calls, 1);
  });
});

test("secret-bearing filenames and oversized input are rejected", async () => {
  let calls = 0;
  await withServer({ fetchImpl: async () => { calls++; throw new Error("unexpected provider call"); } }, async (base) => {
    const secretPath = structuredClone(requestBody);
    secretPath.sources[0].file = ".env";
    assert.equal((await post(base, secretPath)).status, 400);
    const large = structuredClone(requestBody);
    large.sources[0].lines[0].text = "x".repeat(500);
    assert.equal((await post(base, large)).status, 400);
    assert.equal(calls, 0);
  });
});
