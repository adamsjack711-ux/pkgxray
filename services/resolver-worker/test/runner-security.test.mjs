import assert from "node:assert/strict";
import test from "node:test";
import { parseTarListingLine, runtimeEntryOf, validateTarListing, executionFindings, analyzeTrace } from "../container/runner.mjs";

const file = (size, name = "package/index.js") =>
  `-rw-r--r-- 0/0 ${size} 2026-10-30 00:00:00 ${name}`;
const dir = name => `drwxr-xr-x 0/0 0 2026-10-30 00:00:00 ${name}`;

test("failed, timed out and unmonitored phases produce incomplete-execution findings", () => {
  const complete = { hook: "postinstall", monitorStarted: true, exitCode: 0, timedOut: false };
  assert.deepEqual(executionFindings([complete]), []);
  for (const change of [{ exitCode: 137 }, { exitCode: 7 }, { timedOut: true }, { monitorStarted: false }]) {
    const findings = executionFindings([{ ...complete, ...change }]);
    assert.equal(findings[0].category, "behavioral-execution-incomplete");
    assert.equal(findings[0].severity, "medium");
  }
});

test("network findings cover TCP, UDP and IPv6 without substring-based loopback exclusions", () => {
  for (const syscall of ["connect", "sendto", "sendmsg", "sendmmsg"]) {
    for (const address of ['sin_addr=inet_addr("192.0.2.1")', 'sin_addr=inet_addr("100.0.0.0")',
      'inet_pton(AF_INET6, "2001:db8::1", &sin6_addr)']) {
      const findings = analyzeTrace({ text: `${syscall}(3, {sa_family=AF_INET6, ${address}}, 16) = -1 ENETUNREACH` }, []);
      assert.equal(findings[0].category, "network-attempt");
    }
  }
  assert.deepEqual(analyzeTrace({ text: 'connect(3, {sa_family=AF_INET, sin_addr=inet_addr("127.0.0.53")}, 16) = 0' }, []), []);
});

test("runner accepts a bounded archive containing only regular files and directories", () => {
  assert.deepEqual(parseTarListingLine(file(42)), {
    type: "-", size: 42, path: "package/index.js"
  });
  assert.deepEqual(validateTarListing([dir("package/"), file(42)]), {
    entries: 2, uncompressedBytes: 42
  });
});

test("runner rejects archive traversal, links, special files and quoted control names", () => {
  for (const line of [
    file(1, "../escape"),
    file(1, "/absolute"),
    file(1, "package/line\\nbreak.js"),
    "lrwxrwxrwx 0/0 0 2026-10-30 00:00:00 package/link -> /etc/passwd",
    "prw-r--r-- 0/0 0 2026-10-30 00:00:00 package/pipe"
  ]) assert.throws(() => validateTarListing([line]), /unsafe path, link, or special file/);
});

test("runner rejects uncompressed archive bombs and excessive entry counts", () => {
  assert.throws(() => validateTarListing([file(101)], { maxBytes: 100 }), /uncompressed size/);
  assert.throws(() => validateTarListing([dir("package/"), file(1)], { maxEntries: 1 }), /entry count/);
});

test("runner probes the declared Node import export instead of an unrelated index file", () => {
  assert.equal(runtimeEntryOf({ main: "legacy.js" }), "legacy.js");
  assert.equal(runtimeEntryOf({
    main: "innocent.js",
    exports: { ".": { types: "./dist/index.d.ts", browser: "./dist/browser.js", import: "./dist/index.js", default: "./dist/fallback.js" } }
  }), "./dist/index.js");
  assert.equal(runtimeEntryOf({ exports: { node: { import: "./esm.js", require: "./cjs.cjs" }, default: "./fallback.js" } }), "./esm.js");
  assert.throws(() => runtimeEntryOf({ exports: { "./feature": "./feature.js" } }), /no probeable root export/);
});
