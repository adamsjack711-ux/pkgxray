"use strict";

// T1 — minimal MCP *client*: connect to an MCP server over stdio or streamable
// HTTP, perform the read-only lifecycle handshake (initialize →
// notifications/initialized), call tools/list (paginated), and return a
// normalized manifest.
//
// Read-only, hard invariant: this module can enumerate and NOTHING else.
// It never calls tools/call, never reads a resource, never invokes a prompt —
// there is deliberately no generic "call any method" surface exported.
//
// The one place pkgxray's "never executes what it inspects" promise narrows:
// enumerating a *stdio* server means SPAWNING it — there is no manifest
// without a connection. The spawn is therefore treated like any untrusted
// process (mirroring bin/mcp-server.js's buffer-cap discipline, inverted):
//   - scrubbed child env (allowlist only — no inherited secrets),
//   - hard wall-clock timeout on the whole enumeration,
//   - the child's process group is killed on settle (SIGTERM, then SIGKILL),
//   - bounded stdout/stderr buffers so a chatty or hostile server can't OOM us.
// The recommended order is package-scan-first (guardExtension) — enforced by
// the caller (src/mcp-audit.js / bin/audit.js), not here.

const { spawn } = require("node:child_process");
const http = require("node:http");
const https = require("node:https");

// Newest protocol revision this client knows; servers negotiate down in the
// initialize response and we accept whatever they answer with — enumeration
// only needs tools/list, which every revision has.
const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = {
  name: "pkgxray-mcp-adapter",
  version: require("../package.json").version
};

// Mirror bin/mcp-server.js's MAX_BUFFER_BYTES: 4 MiB is comfortably larger
// than any realistic JSON-RPC frame or tool manifest.
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
// A manifest with more pages than this is not a manifest, it's a tarpit.
const MAX_LIST_PAGES = 50;

// Environment allowlist for the spawned server: enough to run a normal
// Node/Python launcher, nothing that carries credentials. Everything else
// (AWS_*, GITHUB_TOKEN, npm_config_*, SSH_AUTH_SOCK, ...) is withheld.
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "SHELL",
  // Windows process bootstrap essentials.
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT"
];

function scrubbedEnv(extraEnv) {
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // Explicit caller opt-in only (a server that genuinely needs a config var);
  // nothing is ever inherited implicitly.
  if (extraEnv && typeof extraEnv === "object") {
    for (const [key, value] of Object.entries(extraEnv)) {
      if (typeof value === "string") env[key] = value;
    }
  }
  return env;
}

function initializeRequest(id) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO
    }
  };
}

function toolsListRequest(id, cursor) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/list",
    params: cursor ? { cursor } : {}
  };
}

const INITIALIZED_NOTIFICATION = {
  jsonrpc: "2.0",
  method: "notifications/initialized"
};

function rpcError(message, phase) {
  const error = new Error(message);
  error.phase = phase;
  return error;
}

// Normalize a raw tools/list tool entry. Every field is attacker-controlled;
// nothing here is trusted, this only pins the shape downstream code relies on.
function normalizeTool(tool) {
  if (!tool || typeof tool !== "object") return null;
  const name = typeof tool.name === "string" ? tool.name : "";
  if (!name) return null;
  return {
    name,
    title: typeof tool.title === "string" ? tool.title : null,
    description: typeof tool.description === "string" ? tool.description : "",
    inputSchema:
      tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : null,
    annotations:
      tool.annotations && typeof tool.annotations === "object" ? tool.annotations : null
  };
}

function normalizeManifest({ transport, target, initializeResult, tools, diagnostics }) {
  const serverInfo =
    initializeResult && typeof initializeResult.serverInfo === "object"
      ? initializeResult.serverInfo
      : {};
  return {
    schemaVersion: 1,
    transport,
    target,
    protocolVersion:
      initializeResult && typeof initializeResult.protocolVersion === "string"
        ? initializeResult.protocolVersion
        : null,
    server: {
      name: typeof serverInfo.name === "string" ? serverInfo.name : "",
      version: typeof serverInfo.version === "string" ? serverInfo.version : "",
      title: typeof serverInfo.title === "string" ? serverInfo.title : null
    },
    capabilities:
      initializeResult && typeof initializeResult.capabilities === "object"
        ? initializeResult.capabilities
        : {},
    instructions:
      initializeResult && typeof initializeResult.instructions === "string"
        ? initializeResult.instructions
        : null,
    tools: (tools || []).map(normalizeTool).filter(Boolean),
    enumeratedAt: new Date().toISOString(),
    diagnostics: diagnostics || { warnings: [] }
  };
}

// ---------------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------------

async function enumerateStdio(command, args, options = {}) {
  if (typeof command !== "string" || command.length === 0) {
    throw new Error("stdio enumeration requires a command");
  }
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const warnings = [];

  const child = spawn(command, args || [], {
    cwd: options.cwd || process.cwd(),
    env: scrubbedEnv(options.extraEnv),
    stdio: ["pipe", "pipe", "pipe"],
    // Own process group so a server that spawns grandchildren can be killed
    // as a unit (POSIX). windowsHide keeps it from flashing a console.
    detached: process.platform !== "win32",
    windowsHide: true
  });

  let settled = false;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stderrTail = "";
  let lineBuffer = "";
  const pending = new Map(); // id -> {resolve, reject}
  let nextId = 1;

  const killChild = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const pid = child.pid;
    const signalGroup = (sig) => {
      try {
        if (process.platform !== "win32" && pid) process.kill(-pid, sig);
        else child.kill(sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };
    signalGroup("SIGTERM");
    const escalate = setTimeout(() => signalGroup("SIGKILL"), 500);
    escalate.unref();
  };

  const failAll = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };

  const finish = () => {
    settled = true;
    killChild();
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk) => {
    stdoutBytes += Buffer.byteLength(chunk);
    if (stdoutBytes > MAX_OUTPUT_BYTES) {
      // SECURITY: past the cap the framing can no longer be trusted — fail
      // the enumeration rather than risk parsing a truncated frame.
      failAll(rpcError("server stdout exceeded the output cap", "transport"));
      finish();
      return;
    }
    lineBuffer += chunk;
    let newline;
    while ((newline = lineBuffer.indexOf("\n")) !== -1) {
      const line = lineBuffer.slice(0, newline).trim();
      lineBuffer = lineBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // Some servers write banners/log lines to stdout. Tolerate (but
        // record) them — the JSON-RPC frames are what we're here for.
        if (warnings.length < 10) warnings.push(`non-JSON stdout line ignored: ${line.slice(0, 120)}`);
        continue;
      }
      if (message && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) {
          reject(rpcError(`server error: ${JSON.stringify(message.error).slice(0, 300)}`, "rpc"));
        } else {
          resolve(message.result);
        }
      }
      // Requests/notifications from the server are ignored: enumerate-only.
    }
  });

  child.stderr.on("data", (chunk) => {
    stderrBytes += Buffer.byteLength(chunk);
    if (stderrBytes <= MAX_OUTPUT_BYTES) {
      stderrTail = (stderrTail + chunk).slice(-2000);
    }
  });

  child.on("error", (error) => {
    failAll(rpcError(`failed to spawn server: ${error.message}`, "spawn"));
  });
  child.on("exit", () => {
    if (!settled) {
      failAll(
        rpcError(
          `server exited before enumeration completed${stderrTail ? ` — stderr: ${stderrTail.trim().slice(0, 300)}` : ""}`,
          "transport"
        )
      );
    }
  });

  const request = (message) =>
    new Promise((resolve, reject) => {
      pending.set(message.id, { resolve, reject });
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error && pending.has(message.id)) {
          pending.delete(message.id);
          reject(rpcError(`failed to write to server stdin: ${error.message}`, "transport"));
        }
      });
    });

  const notify = (message) => {
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      /* exit handler reports the real failure */
    }
  };

  const enumeration = (async () => {
    const initResult = await request(initializeRequest(nextId++));
    notify(INITIALIZED_NOTIFICATION);

    const tools = [];
    let cursor;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const result = await request(toolsListRequest(nextId++, cursor));
      if (result && Array.isArray(result.tools)) tools.push(...result.tools);
      cursor = result && typeof result.nextCursor === "string" && result.nextCursor.length > 0
        ? result.nextCursor
        : null;
      if (!cursor) break;
      if (page === MAX_LIST_PAGES - 1) {
        warnings.push(`tools/list pagination stopped after ${MAX_LIST_PAGES} pages`);
      }
    }

    return normalizeManifest({
      transport: "stdio",
      target: [command, ...(args || [])].join(" "),
      initializeResult: initResult,
      tools,
      diagnostics: { warnings, stderr: stderrTail ? stderrTail.trim() : null }
    });
  })();

  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(rpcError(`enumeration timed out after ${timeoutMs}ms`, "timeout")),
      timeoutMs
    );
  });

  try {
    return await Promise.race([enumeration, timeout]);
  } finally {
    clearTimeout(timeoutHandle);
    finish();
  }
}

// ---------------------------------------------------------------------------
// streamable HTTP transport
// ---------------------------------------------------------------------------

// Minimal SSE body parse: return every JSON object carried in `data:` lines.
function parseSseMessages(body) {
  const messages = [];
  for (const event of body.split(/\n\n|\r\n\r\n/)) {
    const dataLines = [];
    for (const line of event.split(/\r?\n/)) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) continue;
    try {
      messages.push(JSON.parse(dataLines.join("\n")));
    } catch {
      /* non-JSON SSE event — ignore */
    }
  }
  return messages;
}

function httpPost(url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      reject(rpcError(`unsupported URL protocol: ${parsed.protocol}`, "transport"));
      return;
    }
    const lib = parsed.protocol === "https:" ? https : http;
    const request = lib.request(
      parsed,
      { method: "POST", headers },
      (response) => {
        let bytes = 0;
        const chunks = [];
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_OUTPUT_BYTES) {
            request.destroy(rpcError("server response exceeded the output cap", "transport"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(rpcError(`request timed out after ${timeoutMs}ms`, "timeout"));
    });
    request.on("error", (error) => {
      reject(error.phase ? error : rpcError(`request failed: ${error.message}`, "transport"));
    });
    request.end(body);
  });
}

async function httpRpc(url, message, { sessionId, protocolVersion, timeoutMs }) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream"
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;

  const response = await httpPost(url, headers, JSON.stringify(message), timeoutMs);
  const isNotification = message.id === undefined;

  if (isNotification) {
    if (response.status >= 400) {
      throw rpcError(`notification rejected with HTTP ${response.status}`, "rpc");
    }
    return { result: null, sessionId: response.headers["mcp-session-id"] || sessionId };
  }

  if (response.status >= 400) {
    throw rpcError(`server answered HTTP ${response.status}: ${response.body.slice(0, 200)}`, "rpc");
  }

  const contentType = String(response.headers["content-type"] || "");
  let reply = null;
  if (contentType.includes("text/event-stream")) {
    reply = parseSseMessages(response.body).find((m) => m && m.id === message.id) || null;
  } else {
    try {
      reply = JSON.parse(response.body);
    } catch {
      throw rpcError("server returned a non-JSON response body", "rpc");
    }
  }
  if (!reply || reply.id !== message.id) {
    throw rpcError("server response did not answer the request", "rpc");
  }
  if (reply.error) {
    throw rpcError(`server error: ${JSON.stringify(reply.error).slice(0, 300)}`, "rpc");
  }
  return { result: reply.result, sessionId: response.headers["mcp-session-id"] || sessionId };
}

async function enumerateHttp(url, options = {}) {
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("http enumeration requires a URL");
  }
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const warnings = [];
  let nextId = 1;
  let sessionId = null;
  let protocolVersion = null;

  const init = await httpRpc(url, initializeRequest(nextId++), { timeoutMs });
  sessionId = init.sessionId;
  const initResult = init.result || {};
  protocolVersion =
    typeof initResult.protocolVersion === "string" ? initResult.protocolVersion : null;

  await httpRpc(url, INITIALIZED_NOTIFICATION, { sessionId, protocolVersion, timeoutMs });

  const tools = [];
  let cursor;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const { result } = await httpRpc(url, toolsListRequest(nextId++, cursor), {
      sessionId,
      protocolVersion,
      timeoutMs
    });
    if (result && Array.isArray(result.tools)) tools.push(...result.tools);
    cursor = result && typeof result.nextCursor === "string" && result.nextCursor.length > 0
      ? result.nextCursor
      : null;
    if (!cursor) break;
    if (page === MAX_LIST_PAGES - 1) {
      warnings.push(`tools/list pagination stopped after ${MAX_LIST_PAGES} pages`);
    }
  }

  // Session hygiene: streamable-HTTP clients should terminate their session.
  // Best-effort only — enumeration already succeeded.
  if (sessionId) {
    try {
      const parsed = new URL(url);
      const lib = parsed.protocol === "https:" ? https : http;
      await new Promise((resolve) => {
        const request = lib.request(
          parsed,
          { method: "DELETE", headers: { "mcp-session-id": sessionId } },
          (response) => {
            response.resume();
            response.on("end", resolve);
          }
        );
        request.setTimeout(2000, () => {
          request.destroy();
          resolve();
        });
        request.on("error", resolve);
        request.end();
      });
    } catch {
      /* best-effort */
    }
  }

  return normalizeManifest({
    transport: "http",
    target: url,
    initializeResult: initResult,
    tools,
    diagnostics: { warnings }
  });
}

// ---------------------------------------------------------------------------

// Enumerate an MCP server's tool manifest. Exactly one of:
//   enumerateMcpServer({ url })                      — streamable HTTP
//   enumerateMcpServer({ command, args })            — stdio (SPAWNS the server)
// Options: timeoutMs, cwd, extraEnv (explicit allowlist additions only).
async function enumerateMcpServer(target, options = {}) {
  if (target && typeof target.url === "string") {
    return enumerateHttp(target.url, options);
  }
  if (target && typeof target.command === "string") {
    return enumerateStdio(target.command, target.args || [], options);
  }
  throw new Error("enumerateMcpServer requires { url } or { command, args }");
}

module.exports = {
  enumerateMcpServer,
  // Exported for tests and for the audit layer's evidence shaping.
  normalizeManifest,
  parseSseMessages,
  scrubbedEnv,
  PROTOCOL_VERSION,
  MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS
};
