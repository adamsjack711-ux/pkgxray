"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

// getCacheUrl reads process.env fresh on each call, so we can flip env vars in
// a single process. Each test restores what it touched.
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function freshClient() {
  delete require.cache[require.resolve("../src/cache-client.js")];
  return require("../src/cache-client.js");
}

test("https cache is enabled", () => {
  withEnv({ PKGXRAY_CACHE_URL: "https://cache.corp.example", PKGXRAY_CACHE_ALLOW_INSECURE: undefined }, () => {
    const c = freshClient();
    assert.equal(c.isEnabled(), true);
    assert.equal(c.getCacheUrl(), "https://cache.corp.example");
  });
});

test("remote http cache is refused (token-leak guard) even with the insecure opt-in", () => {
  withEnv({ PKGXRAY_CACHE_URL: "http://cache.internal.corp", PKGXRAY_CACHE_ALLOW_INSECURE: "1" }, () => {
    const c = freshClient();
    // Non-loopback http is never allowed — the opt-in only covers loopback.
    assert.equal(c.getCacheUrl(), null);
    assert.equal(c.isEnabled(), false);
  });
});

test("remote http cache is refused without the opt-in", () => {
  withEnv({ PKGXRAY_CACHE_URL: "http://cache.internal.corp", PKGXRAY_CACHE_ALLOW_INSECURE: undefined }, () => {
    const c = freshClient();
    assert.equal(c.getCacheUrl(), null);
  });
});

test("loopback http cache is refused without the opt-in", () => {
  withEnv({ PKGXRAY_CACHE_URL: "http://127.0.0.1:8099", PKGXRAY_CACHE_ALLOW_INSECURE: undefined }, () => {
    const c = freshClient();
    assert.equal(c.getCacheUrl(), null);
  });
});

test("loopback http cache is allowed with the opt-in", () => {
  withEnv({ PKGXRAY_CACHE_URL: "http://127.0.0.1:8099", PKGXRAY_CACHE_ALLOW_INSECURE: "1" }, () => {
    const c = freshClient();
    assert.equal(c.getCacheUrl(), "http://127.0.0.1:8099");
    assert.equal(c.isEnabled(), true);
  });
});

test("malformed cache url disables the cache (safe default)", () => {
  withEnv({ PKGXRAY_CACHE_URL: "not a url", PKGXRAY_CACHE_ALLOW_INSECURE: undefined }, () => {
    const c = freshClient();
    assert.equal(c.getCacheUrl(), null);
  });
});
