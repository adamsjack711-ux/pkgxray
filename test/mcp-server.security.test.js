"use strict";

// Security regression tests for bin/mcp-server.js. Each test spawns the
// server as a subprocess and exchanges newline-delimited JSON-RPC over
// stdio — exactly how an MCP host (Claude Code, Cursor, etc.) talks to it.
//
// Every test in this file is paired with a fix commit. Before the fix, the
// test fails (server crashes, OOMs, or echoes attacker-controlled bytes);
// after the fix, the test passes because the server rejects the input with
// a JSON-RPC error or scrubs the output.

const assert = require("node:assert/strict");
const test = require("node:test");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");

const SERVER_PATH = path.join(__dirname, "..", "bin", "mcp-server.js");

// Helper: drive one or more JSON-RPC messages through a fresh MCP server
// subprocess and collect every line it writes to stdout. Resolves when the
// server exits (we close stdin) or after a 6s safety timeout.
function driveServer(input, { timeoutMs = 6000, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(env || {}) }
    });
    let stdout = "";
    let stderr = "";
    let exitCode = null;
    let exitSignal = null;
    let crashed = false;

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      exitCode = code;
      exitSignal = signal;
      // Node exit code 1 with non-empty stderr typically means an
      // uncaught exception bubbled up.
      if (code !== 0 && code !== null) crashed = true;
      resolve({
        stdout,
        stderr,
        lines: stdout.split("\n").filter((l) => l.length > 0),
        exitCode,
        exitSignal,
        crashed
      });
    });

    if (typeof input === "string") {
      child.stdin.end(input);
    } else if (Buffer.isBuffer(input)) {
      child.stdin.end(input);
    } else {
      // Allow callers to stream chunks one-by-one for buffer-DoS tests.
      input(child).then(() => child.stdin.end()).catch((e) => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        reject(e);
      });
    }
  });
}

function rpc(id, method, params) {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

// ---------------------------------------------------------------------------
// HIGH-1: null JSON-RPC request must not crash the server
// ---------------------------------------------------------------------------
test("HIGH: null JSON-RPC request does not crash the server", async () => {
  const { lines, stderr, crashed } = await driveServer(
    "null\n" + rpc(2, "ping", {})
  );
  assert.equal(crashed, false, `server crashed: ${stderr.slice(0, 300)}`);
  // Server should reply with a JSON-RPC error for the null message AND
  // still process the follow-up ping.
  const responses = lines.map((l) => JSON.parse(l));
  const nullReply = responses.find((r) => r.id === null || (r.error && r.id === null));
  assert.ok(nullReply, `no null-reply received: ${JSON.stringify(responses)}`);
  assert.ok(nullReply.error, "null request should produce an error reply");
  const pingReply = responses.find((r) => r.id === 2);
  assert.ok(pingReply, "follow-up ping never got a reply (server died)");
});

test("HIGH: non-object JSON-RPC request does not crash the server", async () => {
  // A bare number is valid JSON but not a JSON-RPC request. The dispatcher
  // used to destructure `{id, method, params}` from it and crash.
  const { lines, crashed } = await driveServer(
    "42\n" + rpc(7, "ping", {})
  );
  assert.equal(crashed, false);
  const responses = lines.map((l) => JSON.parse(l));
  const pingReply = responses.find((r) => r.id === 7);
  assert.ok(pingReply, "server died before the follow-up ping");
});

// ---------------------------------------------------------------------------
// HIGH-2: unbounded stdin buffer DoS
// ---------------------------------------------------------------------------
test("HIGH: stdin buffer is bounded — huge unterminated message is rejected mid-stream", async () => {
  // Stream chunks WITHOUT a closing newline and DO NOT close stdin. Pre-fix
  // the server would accumulate every byte into `buffer` forever (true OOM
  // DoS — a hostile MCP host could starve the process). Post-fix the server
  // detects the buffer crossing a cap and emits a JSON-RPC parse error
  // BEFORE EOF (proven by capturing the stdout reply while stdin is still
  // open and writeable).
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_PATH], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let sawError = false;
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error("server never emitted an error reply mid-stream")), 8000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed && parsed.error && parsed.error.code === -32700) {
            sawError = true;
            clearTimeout(timer);
            finish();
            return;
          }
        } catch {
          /* not yet parseable */
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", () => {
      if (!sawError) {
        clearTimeout(timer);
        finish(new Error(`server exited without emitting -32700: ${stderr.slice(0, 200)}`));
      }
    });
    // Swallow EPIPE — when the cap trips and the server exits, our
    // remaining writes race with the close and Node hands us EPIPE.
    // That's NOT a test failure; it's exactly what we want to happen.
    child.stdin.on("error", () => {});
    const chunk = "x".repeat(64 * 1024);
    const sendNext = () => {
      if (done) return;
      // Write until we've sent ~8MB; rely on the cap to trip the error first.
      let bytes = 0;
      const tryWrite = () => {
        while (!done && bytes < 8 * 1024 * 1024) {
          if (!child.stdin.writable) return;
          if (!child.stdin.write(chunk)) {
            child.stdin.once("drain", tryWrite);
            return;
          }
          bytes += chunk.length;
        }
      };
      tryWrite();
    };
    sendNext();
  });
});

// ---------------------------------------------------------------------------
// HIGH-3: ANSI / control-byte injection in guard markdown output
// ---------------------------------------------------------------------------
test("HIGH: guard markdown output scrubs control bytes from reference", async () => {
  // The reference field is attacker-controlled (an LLM/tool input the MCP
  // host blindly forwards). Without scrubbing, an ESC byte (0x1B) in the
  // reference would survive into the text content the host renders to the
  // user's terminal — letting a malicious tool-call argument repaint the
  // user's screen.
  //
  // We pin to a known-bad local path so guardExtension errors out fast
  // (it won't try a network call). The error message returned via JSON-RPC
  // exercises a different code path, so to force the markdown path we use
  // a valid (empty) staged dir.
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-sec-"));
  const evilName = "evil\x1b[2K\x1b[Aname";
  const evilDir = path.join(tmpRoot, evilName);
  await fs.mkdir(evilDir);
  await fs.writeFile(
    path.join(evilDir, "package.json"),
    JSON.stringify({ name: "x", version: "1.0.0" })
  );
  await fs.writeFile(path.join(evilDir, "index.js"), "exports.x = 1;");

  const { lines, crashed } = await driveServer(
    rpc(1, "tools/call", {
      name: "guard_agent_extension_install",
      arguments: {
        reference: evilDir,
        quarantineRoot: path.join(tmpRoot, "q"),
        vulnerabilityCheck: false,
        githubMetadata: false,
        githubDiff: false,
        // Markdown is the default but pin it explicitly.
        outputFormat: "markdown",
        allowLocalReferences: true // required after fix
      }
    })
  );
  assert.equal(crashed, false);
  const reply = lines.map((l) => JSON.parse(l)).find((r) => r.id === 1);
  assert.ok(reply, "no reply received");
  // The text content (what gets rendered to a terminal) must NOT contain
  // the ESC byte. Whatever's there in its place is fine — U+FFFD is the
  // convention.
  const text = reply.result && reply.result.content && reply.result.content[0].text;
  assert.ok(text, "no text content in reply");
  assert.ok(!text.includes("\x1b"), "ESC byte leaked into rendered markdown");

  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// HIGH-4: ANSI / control-byte injection in audit markdown output
// (packageName, finding.file echoed by renderMarkdown)
// ---------------------------------------------------------------------------
test("HIGH: audit markdown output scrubs control bytes from packageName/file", async () => {
  const { lines } = await driveServer(
    rpc(1, "tools/call", {
      name: "audit_agent_extension_supply_chain",
      arguments: {
        packageName: "foo\x1b[2K\x1b[Aevil",
        sourceFiles: {
          "evil\x1b[2K\x1b[Apath/index.js": "exports.x = 1;"
        },
        outputFormat: "markdown"
      }
    })
  );
  const reply = lines.map((l) => JSON.parse(l)).find((r) => r.id === 1);
  assert.ok(reply, "no reply received");
  const text = reply.result && reply.result.content && reply.result.content[0].text;
  assert.ok(text, "no text content");
  assert.ok(
    !text.includes("\x1b"),
    "ESC byte leaked from packageName or finding.file into rendered markdown"
  );
});

// ---------------------------------------------------------------------------
// HIGH-5: local-path traversal via `reference` over MCP
// ---------------------------------------------------------------------------
test("HIGH: MCP refuses local-path references unless explicitly opted in", async () => {
  // Without the guardrail, an MCP caller (or an LLM forwarding hostile
  // tool-call args) could ask to "audit" `/etc/ssh` or `~/.ssh` and the
  // server would happily copy the directory into quarantine, then return
  // the contents as `sourceFiles` over JSON-RPC. That's a remote file-read
  // primitive. After the fix, references starting with `/`, `~`, `.`, or
  // `file:` are rejected with a -32602 unless the caller explicitly sets
  // `allowLocalReferences: true` (CLI-equivalent behaviour preserved by the
  // pkgxray CLI which is the only legitimate consumer of that switch).
  const { lines } = await driveServer(
    rpc(1, "tools/call", {
      name: "guard_agent_extension_install",
      arguments: {
        reference: "/etc",
        vulnerabilityCheck: false,
        githubMetadata: false,
        githubDiff: false
      }
    })
  );
  const reply = lines.map((l) => JSON.parse(l)).find((r) => r.id === 1);
  assert.ok(reply, "no reply received");
  assert.ok(reply.error, "expected a JSON-RPC error for local-path reference");
  assert.equal(reply.error.code, -32602);
  // Error must NOT echo the requested path back unfiltered.
  assert.ok(!reply.error.message.includes("/etc"), "error message leaks the requested path");
});

test("HIGH: MCP refuses ~ home-relative references", async () => {
  const { lines } = await driveServer(
    rpc(1, "tools/call", {
      name: "guard_agent_extension_install",
      arguments: { reference: "~/.ssh" }
    })
  );
  const reply = lines.map((l) => JSON.parse(l)).find((r) => r.id === 1);
  assert.ok(reply && reply.error, "expected an error reply");
  assert.equal(reply.error.code, -32602);
});

test("HIGH: MCP refuses file: references", async () => {
  const { lines } = await driveServer(
    rpc(1, "tools/call", {
      name: "guard_agent_extension_install",
      arguments: { reference: "file:/etc" }
    })
  );
  const reply = lines.map((l) => JSON.parse(l)).find((r) => r.id === 1);
  assert.ok(reply && reply.error, "expected an error reply");
  assert.equal(reply.error.code, -32602);
});

// ---------------------------------------------------------------------------
// HIGH-6: input-schema validation — reject obviously-malformed args
// ---------------------------------------------------------------------------
test("HIGH: tools/call rejects non-string reference with -32602", async () => {
  const { lines } = await driveServer(
    rpc(1, "tools/call", {
      name: "guard_agent_extension_install",
      arguments: { reference: { evil: true } }
    })
  );
  const reply = lines.map((l) => JSON.parse(l)).find((r) => r.id === 1);
  assert.ok(reply && reply.error, "expected an error reply");
  assert.equal(reply.error.code, -32602);
});

test("HIGH: tools/call rejects audit call without sourceFiles", async () => {
  // The auditor used to accept anything and just produce an INFO finding.
  // After the fix the schema validation gate catches the missing required
  // field server-side and returns a JSON-RPC error.
  const { lines } = await driveServer(
    rpc(1, "tools/call", {
      name: "audit_agent_extension_supply_chain",
      arguments: {}
    })
  );
  const reply = lines.map((l) => JSON.parse(l)).find((r) => r.id === 1);
  assert.ok(reply && reply.error, "expected an error reply");
  assert.equal(reply.error.code, -32602);
});

// ---------------------------------------------------------------------------
// MEDIUM: error messages must not echo absolute filesystem paths back to
// the client (which may be an LLM whose context window is hostile).
// ---------------------------------------------------------------------------
test("MEDIUM: error messages do not leak absolute filesystem paths", async () => {
  // Drive a guard call against a local dir we just created, with a
  // `promoteTo` that already exists. guardExtension will throw
  // `Promotion target already exists: <absolute path>` — pre-fix that
  // absolute path (which encodes the user's homedir on macOS) flowed
  // straight back over JSON-RPC. Post-fix the homedir prefix is
  // replaced with `~` and the temp prefix with `<path>`.
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-leak-"));
  const source = path.join(tmpRoot, "source");
  const promoteTo = path.join(tmpRoot, "promoted");
  await fs.mkdir(source);
  await fs.mkdir(promoteTo); // already-exists -> guardExtension throws
  await fs.writeFile(path.join(source, "package.json"), JSON.stringify({ name: "x", version: "1" }));

  const { lines } = await driveServer(
    rpc(1, "tools/call", {
      name: "guard_agent_extension_install",
      arguments: {
        reference: source,
        promoteTo,
        quarantineRoot: path.join(tmpRoot, "q"),
        vulnerabilityCheck: false,
        githubMetadata: false,
        githubDiff: false,
        allowLocalReferences: true
      }
    })
  );
  const reply = lines.map((l) => JSON.parse(l)).find((r) => r.id === 1);
  assert.ok(reply && reply.error, JSON.stringify(reply));
  // Must not include the literal home directory or the /private/var/folders
  // temp prefix in any form.
  assert.ok(
    !reply.error.message.includes(os.homedir()),
    `error leaks homedir: ${reply.error.message}`
  );
  // The temp prefix on macOS is /private/var/folders/...; on linux /tmp/...
  // Either way `os.tmpdir()` returns the canonical form. Allow the basename
  // (`promoted`) to survive — that's the whole point of the sanitizer
  // keeping the tail of the path.
  const tmpPrefix = os.tmpdir();
  assert.ok(
    !reply.error.message.includes(tmpPrefix),
    `error leaks os.tmpdir prefix: ${reply.error.message}`
  );

  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Sanity: existing happy paths still work after the fixes.
// ---------------------------------------------------------------------------
test("sanity: initialize still works", async () => {
  const { lines } = await driveServer(rpc(1, "initialize", {}));
  const reply = lines.map((l) => JSON.parse(l)).find((r) => r.id === 1);
  assert.ok(reply && reply.result);
  assert.equal(reply.result.serverInfo.name, "pkgxray");
});

test("sanity: tools/list still works and returns all 4 tools", async () => {
  const { lines } = await driveServer(rpc(1, "tools/list", {}));
  const reply = lines.map((l) => JSON.parse(l)).find((r) => r.id === 1);
  assert.ok(reply && reply.result);
  assert.equal(reply.result.tools.length, 4);
});

test("sanity: audit happy path still returns a report", async () => {
  const { lines } = await driveServer(
    rpc(1, "tools/call", {
      name: "audit_agent_extension_supply_chain",
      arguments: {
        sourceFiles: {
          "package.json": JSON.stringify({ name: "ok", version: "1.0.0" }),
          "index.js": "exports.x = 1;"
        }
      }
    })
  );
  const reply = lines.map((l) => JSON.parse(l)).find((r) => r.id === 1);
  assert.ok(reply && reply.result, JSON.stringify(reply));
  assert.ok(reply.result.content[0].text.startsWith("Verdict:"));
});
