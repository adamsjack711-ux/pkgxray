"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { SessionSecrets } = require("../src/session-secrets");
const { McpGate } = require("../src/mcp-proxy");
const SECRET = "synthetic/credential+only=123456";

test("correlates labelled credentials across nested structured and JSON text results", () => {
  for (const key of ["password", "API_KEY", "access-token", "refresh_token", "clientSecret", "private_key"]) {
    for (const value of [{ structuredContent: { nested: { [key]: SECRET } } }, { content: [{ type: "text", text: JSON.stringify({ [key]: SECRET }) }] }]) {
      const guard = new SessionSecrets();
      assert.equal(guard.observe(value), null);
      for (const encoded of [SECRET, encodeURIComponent(SECRET), Buffer.from(SECRET).toString("base64"), Buffer.from(SECRET).toString("base64url")]) {
        assert.match(guard.check({ url: `https://example.invalid/?value=${encoded}` }), /credential observed/);
        assert.match(guard.check({ [encoded]: "a" }), /credential observed/);
      }
      assert.equal(guard.check({ value: "ordinary public text" }), null);
    }
  }
});

test("authorization schemes track the credential as well as the header", () => {
  for (const scheme of ["Bearer", "Basic"]) {
    const guard = new SessionSecrets();
    guard.observe({ Authorization: `${scheme} ${SECRET}` });
    assert.match(guard.check({ text: SECRET }), /credential observed/);
  }
});

test("percent escaping case and redundant encoding cannot evade a remembered value", () => {
  const guard = new SessionSecrets();
  guard.observe({ api_key: SECRET });
  const encoded = encodeURIComponent(SECRET).replace(/%[0-9A-F]{2}/g, value => value.toLowerCase());
  assert.match(guard.check({ url: `https://example.invalid/?token=${encoded}` }), /credential observed/);
  const allEncoded = [...Buffer.from(SECRET)].map(byte => `%${byte.toString(16)}`).join("");
  assert.match(guard.check({ value: `malformed%XX%FF${allEncoded}` }), /credential observed/);
  guard.observe({ password: "a test phrase" });
  assert.match(guard.check({ form: "password=a+test+phrase" }), /credential observed/);
});

test("no inference from names or unlabelled prose; state is private to each session", () => {
  const first = new SessionSecrets(), second = new SessionSecrets();
  assert.equal(first.observe({ description: `password is ${SECRET}`, name: "secret_file", password: "" }), null);
  assert.equal(first.check({ text: SECRET }), null);
  first.observe({ password: SECRET });
  assert.match(first.check({ text: SECRET }), /credential observed/);
  assert.equal(second.check({ text: SECRET }), null);
  assert.equal(JSON.stringify(first), "{}");
  assert.ok(!first.check({ text: SECRET }).includes(SECRET));
});

test("short labelled passwords remain protected", () => {
  const guard = new SessionSecrets();
  guard.observe({ password: "p4ss" });
  assert.match(guard.check({ text: "p4ss" }), /credential observed/);
});

test("inspection and retention limits hold the session instead of losing evidence", () => {
  const cases = [
    { password: "x".repeat(4097) },
    { text: "x".repeat(128 * 1024 + 1) },
    { text: Array.from({ length: 10001 }, () => "small") },
    Array.from({ length: 129 }, (_, i) => ({ password: `secret-number-${i}` })),
    Array.from({ length: 34 }).reduce(value => ({ value }), "leaf")
  ];
  for (const value of cases) {
    const guard = new SessionSecrets();
    assert.match(guard.observe(value), /limit/);
    assert.match(guard.check({ text: "unrelated" }), /limit/);
    assert.match(guard.observe({}), /limit/);
  }
  const guard = new SessionSecrets();
  assert.match(guard.check({ text: "x".repeat(128 * 1024 + 1) }), /limit/);
  assert.match(guard.check({}), /limit/);
});

function runtime(enabled = true) {
  const sent = [], logs = [];
  const gate = new McpGate({ guardSecrets: enabled, recheck: false, scanResults: true,
    send: (to, message) => sent.push({ to, message }), log: text => logs.push(text),
    audit: () => ({ verdict: "safe", findings: [] }) });
  return { gate, sent, logs };
}
async function ready(gate) {
  await gate._finishVerify(["read_record", "send_record"].map(name => ({ name, description: "Handle a record", inputSchema: { type: "object" } })));
}
const call = (id, name, args = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
async function disclose(gate) {
  await gate.onClientMessage(call(1, "read_record"));
  await gate.onServerMessage({ jsonrpc: "2.0", id: 1, result: { structuredContent: { api_key: SECRET }, content: [] } });
}

test("runtime stops subsequent tool and other RPC transfers before forwarding, without leaking credentials", async () => {
  const { gate, sent, logs } = runtime();
  await ready(gate); await disclose(gate);
  sent.length = 0;
  await gate.onClientMessage(call(2, "send_record", { body: SECRET }));
  await gate.onClientMessage({ jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: `https://example.invalid/${encodeURIComponent(SECRET)}` } });
  assert.equal(sent.filter(item => item.to === "server").length, 0);
  assert.deepEqual(sent.map(item => item.message.id), [2, 3]);
  assert.ok(sent.every(item => item.message.error.code === -32602));
  assert.equal(gate.summary().credentialTransfersDenied, 2);
  assert.equal(gate.summary().calls, 2);
  assert.equal(gate.summary().denied, 1);
  assert.ok(!JSON.stringify({ sent, logs }).includes(SECRET));
  await gate.onClientMessage(call(4, "send_record", { body: "public information" }));
  assert.equal(sent.at(-1).to, "server");
});

test("manifest metadata and error responses are observed before subsequent calls", async () => {
  for (const error of [false, true]) {
    const { gate, sent } = runtime();
    await ready(gate);
    await gate.onClientMessage({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const response = error ? { error: { code: -32603, message: "failed", data: { api_key: SECRET } } }
      : { result: { tools: [{ name: "send_record", inputSchema: { type: "object" } }], _meta: { api_key: SECRET } } };
    await gate.onServerMessage({ jsonrpc: "2.0", id: 1, ...response });
    sent.length = 0;
    await gate.onClientMessage(call(2, "send_record", { value: SECRET }));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "client");
    assert.match(sent[0].message.error.message, /credential observed/);
  }
});

test("held calls are checked again after newly disclosed credentials", async () => {
  const { gate, sent } = runtime();
  await ready(gate);
  await gate.onClientMessage(call(1, "read_record"));
  gate.stale = true;
  await gate.onClientMessage(call(2, "send_record", { body: SECRET }));
  await gate.onServerMessage({ jsonrpc: "2.0", id: 1, result: { structuredContent: { password: SECRET } } });
  clearTimeout(gate.revalidateTimer);
  await ready(gate);
  gate._flushHeldCalls();
  assert.ok(!sent.some(item => item.to === "server" && item.message.id === 2));
  assert.match(sent.at(-1).message.error.message, /credential observed/);
});

test("batches, notifications, response frames and raw frames cannot bypass opted-in guard", async () => {
  const { gate, sent } = runtime();
  await ready(gate); await disclose(gate); sent.length = 0;
  await gate.onClientMessage([{ jsonrpc: "2.0", id: 2, method: "other", params: { value: SECRET } }]);
  assert.equal(sent[0].to, "client");
  assert.match(sent[0].message[0].error.message, /credential observed/);
  for (const message of [{ jsonrpc: "2.0", method: "notifications/other", params: { value: SECRET } }, { jsonrpc: "2.0", id: 99, result: { value: SECRET } }]) {
    await assert.rejects(gate.onClientMessage(message), /credential-flow guard/);
  }
  assert.throws(() => gate.onClientRaw("opaque input"), /requires JSON-RPC/);
  assert.throws(() => gate.onServerRaw("opaque output"), /requires JSON-RPC/);
});

test("credential opt-in remains independent of mandatory output injection screening", async () => {
  const { gate, sent } = runtime(false);
  await ready(gate); await disclose(gate);
  await gate.onClientMessage(call(2, "send_record", { text: SECRET }));
  assert.equal(sent.at(-1).to, "server");
});

test("oversized results are withheld and subsequent traffic held under all runtime policies", async () => {
  const { gate, sent } = runtime();
  gate.policy = "permissive";
  await ready(gate);
  await gate.onClientMessage(call(1, "read_record"));
  await gate.onServerMessage({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "x".repeat(128 * 1024 + 1) }] } });
  assert.equal(sent.at(-1).message.result.isError, true);
  await gate.onClientMessage(call(2, "send_record"));
  assert.match(sent.at(-1).message.error.message, /limit/);
});
