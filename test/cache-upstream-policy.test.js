"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createUpstreamPolicy, isPublicAddress } = require("../src/cache-upstream-policy");

test("cache accepts only approved HTTPS origins, including its GitHub CDN destinations", () => {
  const policy = createUpstreamPolicy("https://codeload.github.com", { codeload: true });
  for (const url of ["https://codeload.github.com/o/r", "https://objects.githubusercontent.com/archive"]) {
    assert.doesNotThrow(() => policy(url));
  }
  for (const url of ["http://codeload.github.com/x", "https://codeload.github.com:8443/x",
    "https://evil.invalid/x", "https://user:pass@codeload.github.com/x", "file:///etc/passwd",
    "http://169.254.169.254/latest/meta-data", "https://2130706433/x", "https://[::ffff:127.0.0.1]/x"]) {
    assert.throws(() => policy(url), undefined, url);
  }
});
test("private upstream access is explicit and confined to the configured origin", () => {
  assert.throws(() => createUpstreamPolicy("http://127.0.0.1:8080"));
  const policy = createUpstreamPolicy("http://127.0.0.1:8080", { allowPrivateUpstream: true });
  assert.doesNotThrow(() => policy("http://127.0.0.1:8080/redirected"));
  assert.throws(() => policy("http://127.0.0.1:8081/other-service"));
  assert.throws(() => policy("http://169.254.169.254/metadata"));
});
test("DNS results passed to the socket exclude private, reserved and mixed answer sets", async () => {
  for (const addresses of [["127.0.0.1"], ["169.254.169.254"], ["8.8.8.8", "10.0.0.1"],
    ["::ffff:127.0.0.1"], ["2002:7f00:1::"], ["192.0.2.1"], []]) {
    const policy = createUpstreamPolicy("https://api.github.com", {
      lookup: (host, options, callback) => callback(null, addresses.map(address => ({ address, family: address.includes(":") ? 6 : 4 })))
    });
    await assert.rejects(new Promise((resolve, reject) => policy("https://api.github.com").lookup(
      "api.github.com", { all: true }, (error, records) => error ? reject(error) : resolve(records)
    )), /non-public/);
  }
});
test("public DNS results are returned without resolving the hostname a second time", async () => {
  let calls = 0;
  const records = [{ address: "8.8.8.8", family: 4 }, { address: "2606:4700::1111", family: 6 }];
  const policy = createUpstreamPolicy("https://api.github.com", {
    lookup: (host, options, callback) => { calls++; callback(null, records); }
  });
  const result = await new Promise((resolve, reject) => policy("https://api.github.com").lookup(
    "api.github.com", { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses)
  ));
  assert.deepEqual(result, records);
  assert.equal(calls, 1);
  assert.equal(isPublicAddress("not-an-address"), false);
});
