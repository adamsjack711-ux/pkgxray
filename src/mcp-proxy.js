"use strict";

// Per-call runtime gate for MCP servers — the in-session complement to the
// connect-time adapter (src/mcp-audit.js).
//
// The connect-time layer answers "should this server be registered at all?".
// It cannot see two things that only exist inside a live session:
//   1. every individual tools/call (a tool that audited clean can still be
//      blocked mid-session after its definition drifts), and
//   2. manifest changes announced AFTER approval (notifications/
//      tools/list_changed — the rug-pull moving in real time).
// A separate probe cannot see them either: for a stdio server it would spawn
// a DIFFERENT instance than the one the agent is talking to. The only seam
// that observes the actual session is a proxy sitting on the wire, so that is
// what this is: the agent host launches `pkgxray mcp-proxy -- <real server>`
// instead of the real server, and every JSON-RPC frame flows through here.
//
// Speed is a design constraint, not an afterthought. The per-call gate is an
// in-memory Map lookup against verdicts computed when the manifest was last
// verified — no network, no re-audit, microseconds. The full static audit
// (auditManifest — pure regex/text analysis, no network) runs only when the
// manifest actually changes: at the first tools/list, and again after a
// tools/list_changed notification. Tool-RESULT scanning (the poisoned-output
// channel) is a bounded doc-typed text scan per call — milliseconds, and can
// be switched off with --no-scan-results.
//
// Child environments use the connect-time allowlist. Required credentials must
// be explicitly selected with --env NAME; the proxy is not an OS sandbox.
//
// Fail-closed rules, mirroring the hookshot gate's policy table:
//   - a call to a tool that is not in the verified manifest is denied;
//   - a call while the manifest is stale is HELD until re-verification
//     completes (and denied if the server won't answer the re-list);
//   - block verdicts deny under every policy; review denies under strict;
//   - after --pin, an unapproved manifest change denies the drifted tools
//     under strict AND balanced (a proxy cannot "ask"; silent-allow would
//     defeat the pin) — re-approve with `pkgxray mcp <target> --pin`.

const { spawn } = require("node:child_process");
const { prepareMcpSandbox } = require("./mcp-sandbox");

const { auditManifest, manifestEntries, scanResultText } = require("./mcp-audit");
const { normalizeTool, scrubbedEnv, resolveCommand, isAllowedEnvOverride } = require("./mcp-client");
const { pinMcpManifest, recheckMcpManifest } = require("./mcp-pin");

const VERDICT_RANK = { safe: 0, review: 1, block: 2 };
const worstOf = (a, b) => (VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b);
const severityVerdict = (severity) =>
  severity === "high" ? "block" : severity === "medium" ? "review" : "safe";

// A single line larger than this closes the session without forwarding it. Tool results are
// the only frames that legitimately get big, hence a cap well above
// mcp-client's 4 MiB enumeration cap.
const MAX_LINE_BYTES = 32 * 1024 * 1024;
// Result-scan input bound: scan at most this much text per call so a huge
// (legitimate) result cannot turn a microsecond gate into a stall.
const RESULT_SCAN_CAP = 512 * 1024;
// If the server will not answer our re-verification tools/list, held calls
// are denied rather than left hanging (fail closed).
const REVALIDATE_TIMEOUT_MS = 10_000;
const MAX_LIST_PAGES = 50;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_IN_FLIGHT = 1024;
const MAX_HELD_BYTES = 8 * 1024 * 1024;
const TIMING_SAMPLES = 512;

function timingSample(samples, value) {
  if (samples.length >= TIMING_SAMPLES) samples.shift();
  samples.push(value);
}

function isTextualMimeType(value) {
  const mime = String(value || "").split(";", 1)[0].trim().toLowerCase();
  return mime.startsWith("text/") || [
    "application/json", "application/ld+json", "application/xml",
    "application/javascript", "application/x-javascript",
    "application/xhtml+xml", "image/svg+xml"
  ].includes(mime) || mime.endsWith("+json") || mime.endsWith("+xml");
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

// ---------------------------------------------------------------------------
// McpGate — transport-agnostic frame gate.
//
// The transport parses newline-delimited JSON-RPC off both pipes and feeds
// each frame in via onClientMessage / onServerMessage (raw non-JSON lines via
// onClientRaw / onServerRaw). The gate emits frames through the injected
// send(to, payload) callback, where payload is a message object or a raw
// string and to is "client" | "server". All handlers are async and MUST be
// serialized by the caller (one frame at a time, both directions through one
// queue) — ordering is part of the protocol.
// ---------------------------------------------------------------------------
class McpGate {
  constructor(options) {
    this.send = options.send;
    this.policy = options.policy || "balanced";
    this.scanResults = options.scanResults !== false;
    this.recheck = options.recheck !== false;
    this.pin = options.pin === true;
    this.lockPath = options.lockPath;
    this.timing = options.timing === true;
    this.targetLabel = options.targetLabel || "(stdio)";
    this.log = options.log || (() => {});
    // Injectable for tests; default the real static audit.
    this.audit = options.audit || auditManifest;

    this.serverInfo = { name: "", version: "", title: null };
    this.instructions = null;
    this.capabilities = {};
    this.pinHold = null;
    this.baselineExpected = Boolean(options.requireBaseline || (!this.pin && options.lockPath));
    this.protocolVersion = null;
    this.clientInitId = undefined;

    this.toolStatus = new Map(); // name -> { verdict, drifted, reasons: [] }
    this.serverVerdict = "safe"; // findings on server.md (instructions) gate everything
    this.serverReasons = [];
    this.verified = false;
    this.stale = false;

    this.clientListIds = new Set();
    this.clientListAccum = [];
    this.callsInFlight = new Map(); // id -> { name }
    this.responsesInFlight = new Map(); // id -> method for non-tool responses
    this.heldCalls = [];
    this.heldBytes = 0;
    this.clientListPages = 0;
    this.clientListBytes = 0;
    this.proxyListBytes = 0;
    this.reviewWarned = new Set();

    this.revalidating = false;
    this.proxyListIds = new Set();
    this.proxyListAccum = [];
    this.revalidateTimer = null;
    this.proxyIdCounter = 0;
    this.pinned = false;

    this.stats = {
      calls: 0,
      denied: 0,
      held: 0,
      resultsScanned: 0,
      resultsBlocked: 0,
      audits: 0,
      gateNs: [],
      auditNs: []
    };
  }

  // ---- client → server ------------------------------------------------------

  onClientRaw(line) {
    this.send("server", line);
  }

  async onClientMessage(message) {
    const requests = (Array.isArray(message) ? message : [message]).filter(m => m && typeof m.method === "string");
    if (requests.some(m => m.method.length > 256 || (typeof m.params?.name === "string" && m.params.name.length > 256) || (m.id !== undefined &&
        !(typeof m.id === "number" && Number.isFinite(m.id)) && !(typeof m.id === "string" && m.id.length <= 128))) ||
        requests.length + this.callsInFlight.size + this.responsesInFlight.size + this.clientListIds.size + this.heldCalls.length > MAX_IN_FLIGHT) {
      throw new Error("MCP request/in-flight capacity exceeded");
    }
    // JSON-RPC batches were removed in protocol 2025-06-18 and no real host
    // sends them — but a batch would let a tools/call ride past the per-call
    // gate, so any batch touching tools/* is refused rather than unpacked.
    if (Array.isArray(message)) {
      const touchesTools = message.some(
        (entry) => entry && typeof entry.method === "string" && entry.method.startsWith("tools/")
      );
      if (!touchesTools) {
        for (const entry of message) {
          if (entry && entry.id !== undefined && typeof entry.method === "string") this.responsesInFlight.set(entry.id, entry.method);
        }
        this.send("server", message);
        return;
      }
      const responses = message
        .filter((entry) => entry && entry.id !== undefined)
        .map((entry) => ({
          jsonrpc: "2.0",
          id: entry.id,
          error: {
            code: -32600,
            message: "pkgxray mcp-proxy: JSON-RPC batches containing tools/* are not allowed"
          }
        }));
      if (responses.length > 0) this.send("client", responses);
      this.log("denied a JSON-RPC batch containing tools/* frames");
      return;
    }

    if (message.method === "initialize") {
      this.verified = false;
      this.stale = true;
      this.clientInitId = message.id;
      this.send("server", message);
      return;
    }

    if (message.method === "tools/list") {
      if (this.clientListIds.size) throw new Error("Concurrent tools/list pagination is not supported");
      if (!(message.params && message.params.cursor)) {
        this.clientListAccum = []; this.clientListPages = 0; this.clientListBytes = 0;
      }
      this.clientListIds.add(message.id);
      this.send("server", message);
      return;
    }

    if (message.method === "tools/call") {
      this.stats.calls += 1;
      if (!this.verified || this.stale || this.revalidating) {
        // Fail closed: never forward a call against an unverified or stale
        // manifest. Hold it, re-enumerate through the SAME session, decide
        // once the fresh manifest has been audited.
        this.stats.held += 1;
        const bytes = Buffer.byteLength(JSON.stringify(message));
        if (this.heldCalls.length >= 128 || this.heldBytes + bytes > MAX_HELD_BYTES) throw new Error("MCP held-call capacity exceeded");
        this.heldBytes += bytes;
        this.heldCalls.push(message);
        this._startRevalidation();
        return;
      }
      this._decideAndRoute(message);
      return;
    }

    if (message.id !== undefined && typeof message.method === "string") this.responsesInFlight.set(message.id, message.method);
    this.send("server", message);
  }

  // ---- server → client ------------------------------------------------------

  onServerRaw(line) {
    this.send("client", line);
  }

  async onServerMessage(message) {
    if (Array.isArray(message)) {
      // Process batch entries individually so a batched call result cannot
      // dodge the result scan; re-emit whatever survives as a batch.
      const out = [];
      for (const entry of message) {
        const processed = await this._handleServerSingle(entry);
        if (processed !== null) out.push(processed);
      }
      if (out.length > 0) this.send("client", out);
      return;
    }
    const processed = await this._handleServerSingle(message);
    if (processed !== null) this.send("client", processed);
  }

  // Returns the (possibly rewritten) message to forward, or null to swallow.
  async _handleServerSingle(message) {
    if (!message || typeof message !== "object") return message;

    // Our own re-verification traffic — never forwarded.
    if (message.id !== undefined && this.proxyListIds.has(message.id)) {
      await this._onProxyListResponse(message);
      return null;
    }

    if (message.id !== undefined && message.id === this.clientInitId) {
      const result = message.result || {};
      const serverInfo = result.serverInfo || {};
      this.serverInfo = {
        name: typeof serverInfo.name === "string" ? serverInfo.name : "",
        version: typeof serverInfo.version === "string" ? serverInfo.version : "",
        title: typeof serverInfo.title === "string" ? serverInfo.title : null
      };
      this.instructions = typeof result.instructions === "string" ? result.instructions : null;
      this.capabilities = result.capabilities && typeof result.capabilities === "object" && !Array.isArray(result.capabilities) ? result.capabilities : {};
      this.protocolVersion =
        typeof result.protocolVersion === "string" ? result.protocolVersion : null;
      return this._screenCallResult("initialize", message, "rpc");
    }

    if (message.id !== undefined && this.clientListIds.has(message.id)) {
      this.clientListIds.delete(message.id);
      return this._onClientListResponse(message);
    }

    if (message.id !== undefined && this.callsInFlight.has(message.id)) {
      const { name } = this.callsInFlight.get(message.id);
      this.callsInFlight.delete(message.id);
      return this._screenCallResult(name, message);
    }

    if (message.id !== undefined && this.responsesInFlight.has(message.id)) {
      const method = this.responsesInFlight.get(message.id);
      this.responsesInFlight.delete(message.id);
      return this._screenCallResult(method, message, "rpc");
    }

    if (message.method === "notifications/tools/list_changed") {
      // The rug-pull signal. Mark everything stale and re-verify NOW rather
      // than waiting for the next call — the fresh audit and the pin diff
      // should land before the model acts on the new tool set.
      this.stale = true;
      this._startRevalidation();
      return message;
    }

    return message;
  }

  // ---- manifest verification ------------------------------------------------

  _manifestFor(tools) {
    return {
      schemaVersion: 1,
      transport: "stdio-proxy",
      target: this.targetLabel,
      protocolVersion: this.protocolVersion,
      server: this.serverInfo,
      capabilities: this.capabilities,
      instructions: this.instructions,
      tools: tools.map(normalizeTool).filter(Boolean),
      enumeratedAt: new Date().toISOString(),
      diagnostics: { warnings: [] }
    };
  }

  // Audit a tool set and fold findings into per-tool statuses. Findings whose
  // evidence path is not one of the tool documents belong to server.md (the
  // instructions blurb) and gate every call.
  _auditTools(tools) {
    const started = process.hrtime.bigint();
    const manifest = this._manifestFor(tools);
    const audit = this.audit(manifest);
    const nameByPath = new Map(manifestEntries(manifest).map((e) => [e.path, e.tool.name]));

    const status = new Map();
    for (const tool of manifest.tools) {
      status.set(tool.name, { verdict: "safe", drifted: false, reasons: [] });
    }
    let serverVerdict = "safe";
    const serverReasons = [];
    for (const finding of audit.findings) {
      const verdict = severityVerdict(finding.severity);
      if (verdict === "safe") continue;
      const reason = `${finding.category}: ${finding.rationale}`;
      const toolName = nameByPath.get(finding.file);
      if (toolName !== undefined && status.has(toolName)) {
        const entry = status.get(toolName);
        entry.verdict = worstOf(entry.verdict, verdict);
        entry.reasons.push(reason);
      } else {
        serverVerdict = worstOf(serverVerdict, verdict);
        serverReasons.push(reason);
      }
    }

    this.stats.audits += 1;
    timingSample(this.stats.auditNs, Number(process.hrtime.bigint() - started));
    return { manifest, audit, status, serverVerdict, serverReasons };
  }

  // Full verification round: replace all statuses, then run the pin/recheck
  // drift comparison against the approval baseline.
  async _finishVerify(tools) {
    const { manifest, audit, status, serverVerdict, serverReasons } = this._auditTools(tools);
    this.toolStatus = status;
    this.reviewWarned.clear();
    this.serverVerdict = serverVerdict;
    this.serverReasons = serverReasons;
    this.verified = true;
    this.stale = false;
    this.pinHold = null;

    if (serverVerdict !== "safe") {
      this.log(
        `server-level manifest verdict is ${serverVerdict} — ${serverReasons[0] || "see findings"}`
      );
    }

    try {
      if (this.pin && !this.pinned) {
        await pinMcpManifest({ manifest, verdict: audit.verdict, lockPath: this.lockPath });
        this.pinned = true;
        this.baselineExpected = true;
        this.log(`pinned manifest for "${manifest.server.name || this.targetLabel}" (--pin)`);
      } else if (this.recheck) {
        const rc = await recheckMcpManifest({
          manifest,
          verdict: audit.verdict,
          lockPath: this.lockPath,
          write: true,
          requireBaseline: this.baselineExpected
        });
        if (rc.status === "ok") this.baselineExpected = true;
        if (rc.status === "ok" && rc.manifestDrift && rc.manifestDrift.drifted) {
          if (rc.manifestDrift.metaChanged) this.pinHold = "server metadata changed since the pinned approval; explicit reapproval required";
          const driftedNames = [...rc.manifestDrift.added, ...rc.manifestDrift.changed];
          for (const name of driftedNames) {
            const entry = this.toolStatus.get(name);
            if (!entry) continue;
            entry.drifted = true;
            entry.reasons.push("tool added or changed since the pinned approval");
          }
          this.log(
            `MANIFEST DRIFT vs pinned approval — added: [${rc.manifestDrift.added.join(", ")}] ` +
              `changed: [${rc.manifestDrift.changed.join(", ")}] removed: [${rc.manifestDrift.removed.join(", ")}]. ` +
              `Drifted tools are denied under strict/balanced until re-approved with \`pkgxray mcp --pin\`.`
          );
        }
      }
    } catch (error) {
      this.pinHold = "manifest pin could not be verified; restore the pin store or explicitly reapprove";
      this.log(`pin/recheck held: ${error.message}`);
    }
  }

  // Client-issued tools/list response: audit the page, strip tools the policy
  // would deny calls to (so the model never even reads their descriptions —
  // the description IS the injection surface), forward the rest.
  async _onClientListResponse(message) {
    const tools =
      message.result && Array.isArray(message.result.tools) ? message.result.tools : null;
    if (!tools) return message;

    this.clientListBytes += Buffer.byteLength(JSON.stringify(tools));
    this.clientListPages++;
    if (this.clientListBytes > MAX_MANIFEST_BYTES || this.clientListPages > MAX_LIST_PAGES ||
        this.clientListAccum.length + tools.length > 10000) throw new Error("MCP manifest capacity exceeded");
    this.clientListAccum.push(...tools);
    const lastPage = !(
      message.result &&
      typeof message.result.nextCursor === "string" &&
      message.result.nextCursor.length > 0
    );
    if (lastPage) {
      await this._finishVerify(this.clientListAccum);
      this.clientListAccum = [];
      this._flushHeldCalls();
    }

    // Strip from what the model sees using the freshly computed statuses.
    // Mid-chain pages are audited standalone; the chain-final full audit
    // replaces every status anyway.
    const statuses = lastPage ? this.toolStatus : this._auditTools(tools).status;
    const kept = tools.filter((tool) => {
      const name = tool && typeof tool.name === "string" ? tool.name : "";
      const decision = this._decision(statuses.get(name));
      if (decision.allow) return true;
      this.log(`stripped tool "${name}" from tools/list — ${decision.reason}`);
      return false;
    });
    if (kept.length !== tools.length) {
      message = { ...message, result: { ...message.result, tools: kept } };
    }
    return message;
  }

  // ---- per-call gate ----------------------------------------------------------

  // The hot path: pure in-memory verdict fold. No IO of any kind.
  _decision(entry) {
    if (this.pinHold && this.policy !== "permissive") return { allow: false, reason: this.pinHold };
    const toolVerdict = entry ? entry.verdict : "block";
    const effective = worstOf(toolVerdict, this.serverVerdict);
    if (!entry) {
      return { allow: false, reason: "tool is not in the verified manifest" };
    }
    if (effective === "block") {
      return { allow: false, reason: entry.reasons[0] || this.serverReasons[0] || "block verdict" };
    }
    if (entry.drifted && this.policy !== "permissive") {
      return {
        allow: false,
        reason:
          "tool changed since the pinned approval — re-approve with `pkgxray mcp <target> --pin`"
      };
    }
    if (effective === "review" && this.policy === "strict") {
      return { allow: false, reason: entry.reasons[0] || this.serverReasons[0] || "review verdict" };
    }
    return {
      allow: true,
      warn: effective === "review" ? entry.reasons[0] || this.serverReasons[0] : null
    };
  }

  _decideAndRoute(message) {
    const started = process.hrtime.bigint();
    const name =
      message.params && typeof message.params.name === "string" ? message.params.name : "";
    const decision = this._decision(this.toolStatus.get(name));
    timingSample(this.stats.gateNs, Number(process.hrtime.bigint() - started));

    if (!decision.allow) {
      this.stats.denied += 1;
      this.log(`DENIED tools/call "${name}" — ${decision.reason}`);
      this.send("client", {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [
            {
              type: "text",
              text: `pkgxray mcp-proxy denied the call to "${name}": ${decision.reason}`
            }
          ],
          isError: true
        }
      });
      return;
    }
    if (decision.warn && !this.reviewWarned.has(name)) {
      this.reviewWarned.add(name);
      this.log(`review-verdict tool "${name}" allowed under ${this.policy} — ${decision.warn}`);
    }
    if (this.timing) {
      const ns = this.stats.gateNs[this.stats.gateNs.length - 1];
      this.log(`gate "${name}" allow in ${(ns / 1000).toFixed(1)}µs`);
    }
    this.callsInFlight.set(message.id, { name });
    this.send("server", message);
  }

  // ---- result screening -------------------------------------------------------

  // Poisoned-output channel: a clean-manifest server can still steer the
  // model through injection-shaped text in a tool RESULT. Same doc-typed scan
  // as the manifest audit, bounded input; strict also withholds review results.
  _screenCallResult(name, message, responseKind = "tool") {
    if (!this.scanResults || (!message.error && !message.result)) return message;

    const parts = [];
    let bytes = 0;
    let visited = 0;
    const add = (text) => {
      bytes += Buffer.byteLength(text, "utf8");
      if (bytes <= RESULT_SCAN_CAP) parts.push(text);
    };
    const addStructured = (value) => {
      const pending = [value];
      while (pending.length && bytes <= RESULT_SCAN_CAP) {
        if (++visited > 10000) { bytes = RESULT_SCAN_CAP + 1; break; }
        const item = pending.pop();
        if (typeof item === "string") add(item);
        else if (item && typeof item === "object") {
          for (const [key, child] of Object.entries(item)) { add(key); pending.push(child); }
        }
      }
    };
    const addEncodedText = (encoded, mimeType) => {
      if (typeof encoded !== "string" || !isTextualMimeType(mimeType)) return;
      const compact = encoded.replace(/\s+/g, "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) return;
      const estimated = Math.floor(compact.length * 3 / 4);
      if (bytes + estimated > RESULT_SCAN_CAP) { bytes = RESULT_SCAN_CAP + 1; return; }
      add(Buffer.from(compact, "base64").toString("utf8"));
    };
    if (message.error) addStructured(message.error);
    const result = message.result || {};
    const content = Array.isArray(result.content) ? result.content : [];
    for (const item of content) {
      if (!item || typeof item !== "object") { addStructured(item); continue; }
      // All textual metadata is model-visible, including resource links,
      // annotations and future content types. Decode bodies whose MIME type
      // declares text, including SVG images and textual resource blobs.
      const metadata = { ...item };
      if (item.type === "image" || item.type === "audio") {
        addEncodedText(item.data, item.mimeType);
        delete metadata.data;
      }
      if (item.type === "resource" && item.resource && typeof item.resource === "object") {
        metadata.resource = { ...item.resource };
        addEncodedText(item.resource.blob, item.resource.mimeType || item.mimeType);
        delete metadata.resource.blob;
      }
      addStructured(metadata);
    }
    for (const [key, value] of Object.entries(result)) {
      if (key !== "content") { add(key); addStructured(value); }
    }
    if (bytes > RESULT_SCAN_CAP) {
      this.stats.resultsBlocked += 1;
      this.log(`withheld oversized result of "${name}" (${bytes} bytes)`);
      return this._withheldResult(message, `pkgxray withheld this result: text exceeds the ${RESULT_SCAN_CAP}-byte inspection limit. Request a smaller result.`, responseKind);
    }
    if (parts.length === 0) return message;

    const started = process.hrtime.bigint();
    const findings = scanResultText(name || "tool", parts.join("\n\n"));
    this.stats.resultsScanned += 1;
    const scanNs = Number(process.hrtime.bigint() - started);
    if (this.timing) this.log(`result scan "${name}" in ${(scanNs / 1e6).toFixed(1)}ms`);

    const worst = findings.reduce((acc, f) => worstOf(acc, severityVerdict(f.severity)), "safe");
    if ((worst === "block" && this.policy !== "permissive") || (worst === "review" && this.policy === "strict")) {
      this.stats.resultsBlocked += 1;
      const first = findings.find((f) => severityVerdict(f.severity) === worst);
      this.log(`BLOCKED result of "${name}" — ${first.category}: ${first.rationale}`);
      return this._withheldResult(message,
        `pkgxray mcp-proxy blocked the result of "${name}": ${first.category} — ${first.rationale}`, responseKind);
    }
    if (worst !== "safe") {
      const first = findings[0];
      this.log(`suspicious result from "${name}" (${worst}) — ${first.category}: ${first.rationale}`);
    }
    return message;
  }

  _withheldResult(message, text, responseKind = "tool") {
    if (message.error || responseKind === "rpc") return { jsonrpc: "2.0", id: message.id, error: { code: -32603, message: text } };
    return { jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text", text }] } };
  }

  // ---- re-verification --------------------------------------------------------

  _startRevalidation() {
    if (this.revalidating) return;
    this.revalidating = true;
    this.proxyListAccum = [];
    this.proxyListBytes = 0;
    this.proxyPageCount = 0;
    this._sendProxyList();
    this.revalidateTimer = setTimeout(() => this._failRevalidation("timed out"), REVALIDATE_TIMEOUT_MS);
    if (this.revalidateTimer.unref) this.revalidateTimer.unref();
  }

  _sendProxyList(cursor) {
    // String ids in our own namespace cannot collide with host-issued ids.
    const id = `pkgxray-proxy:${(this.proxyIdCounter += 1)}`;
    this.proxyPageCount += 1;
    this.proxyListIds.add(id);
    this.send("server", {
      jsonrpc: "2.0",
      id,
      method: "tools/list",
      params: cursor ? { cursor } : {}
    });
  }

  async _onProxyListResponse(message) {
    this.proxyListIds.delete(message.id);
    if (message.error) {
      this._failRevalidation(`server answered tools/list with an error: ${JSON.stringify(message.error).slice(0, 200)}`);
      return;
    }
    const result = message.result || {};
    this.proxyListBytes += Buffer.byteLength(JSON.stringify(result));
    if (this.proxyListBytes > MAX_MANIFEST_BYTES || this.proxyListAccum.length + (result.tools?.length || 0) > 10000) {
      this._failRevalidation("manifest capacity exceeded"); return;
    }
    if (Array.isArray(result.tools)) this.proxyListAccum.push(...result.tools);
    const cursor =
      typeof result.nextCursor === "string" && result.nextCursor.length > 0
        ? result.nextCursor
        : null;
    if (cursor && this.proxyPageCount < MAX_LIST_PAGES) {
      this._sendProxyList(cursor);
      return;
    }
    if (cursor) { this._failRevalidation("pagination limit exceeded"); return; }
    clearTimeout(this.revalidateTimer);
    await this._finishVerify(this.proxyListAccum);
    this.revalidating = false;
    this.log(
      `manifest re-verified (${this.toolStatus.size} tools) — flushing ${this.heldCalls.length} held call(s)`
    );
    this._flushHeldCalls();
  }

  _failRevalidation(why) {
    clearTimeout(this.revalidateTimer);
    if (!this.revalidating) return;
    this.revalidating = false;
    this.proxyListIds.clear();
    this.proxyListAccum = [];
    this.heldBytes = 0;
    const held = this.heldCalls.splice(0);
    this.log(`re-verification failed (${why}) — denying ${held.length} held call(s), failing closed`);
    for (const call of held) {
      this.stats.denied += 1;
      this.send("client", {
        jsonrpc: "2.0",
        id: call.id,
        result: {
          content: [
            {
              type: "text",
              text: `pkgxray mcp-proxy denied the call: manifest re-verification failed (${why})`
            }
          ],
          isError: true
        }
      });
    }
  }

  _flushHeldCalls() {
    const held = this.heldCalls.splice(0);
    this.heldBytes = 0;
    for (const call of held) this._decideAndRoute(call);
  }

  // ---- reporting ----------------------------------------------------------------

  summary() {
    const gate = [...this.stats.gateNs].sort((a, b) => a - b);
    const audits = this.stats.auditNs;
    const avgAuditMs = audits.length
      ? audits.reduce((a, b) => a + b, 0) / audits.length / 1e6
      : 0;
    return {
      calls: this.stats.calls,
      denied: this.stats.denied,
      held: this.stats.held,
      resultsScanned: this.stats.resultsScanned,
      resultsBlocked: this.stats.resultsBlocked,
      audits: this.stats.audits,
      gateMicros: {
        p50: quantile(gate, 0.5) / 1000,
        p95: quantile(gate, 0.95) / 1000,
        max: (gate[gate.length - 1] || 0) / 1000
      },
      auditAvgMs: avgAuditMs
    };
  }

  summaryLine() {
    const s = this.summary();
    return (
      `${s.calls} call(s) gated (${s.denied} denied, ${s.held} held for re-verify), ` +
      `${s.resultsScanned} result(s) scanned (${s.resultsBlocked} blocked), ` +
      `${s.audits} manifest audit(s) avg ${s.auditAvgMs.toFixed(1)}ms; ` +
      `per-call gate p50 ${s.gateMicros.p50.toFixed(1)}µs / p95 ${s.gateMicros.p95.toFixed(1)}µs`
    );
  }
}

// ---------------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------------

// Bounded newline framing: a line past the cap is
// rejected without forwarding any part of the frame. The transport closes the session.
function makeLineFeeder({ cap, onLine, onOversize, warn }) {
  let buffer = "";
  let bytes = 0;
  let failed = false;
  return (chunk) => {
    if (failed) return;
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf("\n", start);
      const part = chunk.slice(start, newline === -1 ? chunk.length : newline);
      bytes += Buffer.byteLength(part, "utf8");
      if (bytes > cap) {
        failed = true;
        buffer = "";
        warn(`frame exceeds ${cap} bytes — closing session`);
        onOversize();
        return;
      }
      buffer += part;
      if (newline === -1) return;
      if (buffer.trim()) onLine(buffer);
      buffer = "";
      bytes = 0;
      start = newline + 1;
    }
  };
}

// Run the proxy: agent host on our stdin/stdout, real server as a spawned
// child. Resolves with the child's exit code once the session ends.
function runMcpProxy(target, options = {}) {
  return new Promise((resolve) => {
    const logStream = options.logStream || process.stderr;
    const log = (line) => {
      if (logStream.writableLength <= 1024 * 1024 || logStream.writableLength === undefined) logStream.write(`pkgxray-proxy: ${line}\n`);
    };

    const warnings = [];
    const command = resolveCommand(target.command, warnings);
    const env = scrubbedEnv(options.extraEnv);
    for (const name of options.envNames || []) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Invalid environment variable name");
      if (!isAllowedEnvOverride(name)) throw new Error(`Environment override forbidden: ${name}`);
      if (process.env[name] === undefined) throw new Error(`Environment variable is not set: ${name}`);
      env[name] = process.env[name];
    }
    warnings.forEach(log);
    const launch = prepareMcpSandbox(command, target.args || [], env, options);
    if (launch.level) log(`OS sandbox: ${launch.level}; network denied; project read-only; private temporary HOME`);
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true
    });

    const stdin = options.stdin || process.stdin;
    const stdout = options.stdout || process.stdout;
    const blockedOutputs = new Map();
    function writeFrame(destination, frame) {
      if (!destination.writable || destination.writableLength + Buffer.byteLength(frame) > 64 * 1024 * 1024) {
        settle(1); return;
      }
      if (!destination.write(frame) && !blockedOutputs.has(destination)) {
        stdin.pause(); child.stdout.pause();
        const timer = setTimeout(() => settle(1), REVALIDATE_TIMEOUT_MS);
        blockedOutputs.set(destination, timer);
        destination.once("drain", () => {
          clearTimeout(timer); blockedOutputs.delete(destination);
          if (!settled && !blockedOutputs.size) { stdin.resume(); child.stdout.resume(); }
        });
      }
    }

    const gate = new McpGate({
      policy: options.policy,
      scanResults: options.scanResults,
      recheck: options.recheck,
      pin: options.pin,
      lockPath: options.lockPath,
      timing: options.timing,
      targetLabel: [target.command, ...(target.args || [])].join(" "),
      log,
      send: (to, payload) => {
        const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
        writeFrame(to === "server" ? child.stdin : stdout, `${raw}\n`);
      }
    });

    // One queue for BOTH directions: frame order is part of the protocol, and
    // gate handlers (audit, pin IO) are async.
    const queue = new (require("./bounded-queue").BoundedQueue)({ maxTasks: 128, maxBytes: 64 * 1024 * 1024,
      onError: error => { log(`session held: ${error.message}`); settle(1); } });
    const enqueue = (fn, bytes = 0) => {
      if (!settled && !queue.enqueue(() => { if (!settled) return fn(); }, bytes)) {
        log("frame queue capacity exceeded"); settle(1);
      }
    };

    const feedFrom = (source, onMessage, onRaw) =>
      makeLineFeeder({
        cap: MAX_LINE_BYTES,
        onLine: (line) => {
          enqueue(() => {
            let message;
            try { message = JSON.parse(line); }
            catch { return onRaw(line); }
            return onMessage(message);
          }, Buffer.byteLength(line));
        },
        onOversize: () => {
          stdin.pause();
          child.stdout.pause();
          settle(1);
        },
        warn: (msg) => log(`${source}: ${msg}`)
      });

    const clientFeed = feedFrom(
      "client",
      (m) => gate.onClientMessage(m),
      (l) => gate.onClientRaw(l)
    );
    const serverFeed = feedFrom(
      "server",
      (m) => gate.onServerMessage(m),
      (l) => gate.onServerRaw(l)
    );

    stdin.setEncoding("utf8");
    child.stdout.setEncoding("utf8");
    stdin.on("data", clientFeed);
    child.stdout.on("data", serverFeed);
    child.stderr.pipe(logStream);

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

    let settled = false;
    const settle = (code) => {
      if (settled) return;
      settled = true;
      queue.close();
      for (const timer of blockedOutputs.values()) clearTimeout(timer);
      clearTimeout(gate.revalidateTimer);
      stdin.removeListener("data", clientFeed);
      stdin.pause();
      log(`session closed — ${gate.summaryLine()}`);
      killChild();
      resolve({ code, gate });
    };

    stdin.on("end", () => {
      // Host hung up: give the server its EOF, then reap it.
      try {
        child.stdin.end();
      } catch {
        /* child already gone */
      }
      killChild();
    });
    child.on("exit", (code) => enqueue(() => settle(code === null ? 1 : code)));
    child.on("close", () => {
      try { launch.cleanup(); } catch (error) { log(`sandbox cleanup failed: ${error.message}`); }
    });
    child.on("error", (error) => {
      log(`failed to spawn server: ${error.message}`);
      settle(1);
    });
  });
}

module.exports = {
  McpGate,
  runMcpProxy,
  makeLineFeeder,
  MAX_LINE_BYTES,
  RESULT_SCAN_CAP,
  REVALIDATE_TIMEOUT_MS
};
