# pkgxray × MCP — connect-time static trust layer (prompt)

**Scope:** an *adapter* on top of the existing pkgxray engine, **not** a second
product. An agent pulls untrusted things in from outside two ways — packages it
installs, and MCP servers it connects to. pkgxray already covers the first
(guard + hook + proxy). This prompt covers the second by **reusing the same
injection detection, provenance, and recheck/drift model** — mostly adapter
plumbing, not new detection.

```
   Packages it installs  → pkgxray guard + hookshot + proxy        (built)
   MCP servers it connects to → this adapter, same engine          (this prompt)
```

The design test for every task below: *does this reuse an engine we already
ship?* If a task starts to grow a parallel scanner, a second verdict dialect, or
a fork of the triage store, stop — that's a signal it's mis-scoped.

---

## The one caveat that is a real difference, not a detail

Every other thing pkgxray does is **static — it never executes what it inspects**
(README: "never executes package code during normal scans"; a tarball is staged in quarantine and
read as bytes). **Enumerating an MCP server is not static.** To list a server's
tool manifest you must connect to it, and for a **stdio** server that means
**spawning and running the server process**. That is inherent to how MCP works —
there is no manifest without a connection.

Consequences that must be respected everywhere below:

1. **Package-scan first, then connect-and-enumerate.** Where the server ships as
   a package (an npm ref, a local dir), run the existing static path
   (`guardExtension`, i.e. `pkgxray guard`) on it **before** connecting. The
   static, no-execution check happens first; the connect step only runs against
   a server that already cleared it (or that the caller force-accepted).
2. **Treat the spawn like any untrusted process.** For a stdio server, spawning
   it is running untrusted code. Isolate it the way guard isolates a tarball:
   no inherited secrets in the child env, a hard timeout, a killed process group
   on exit, bounded output buffers. Mirror the caution already encoded in
   `bin/mcp-server.js` (stdin buffer cap, error-message path stripping) — but for
   a process we *launch*, not a caller we answer.
3. **Say it plainly in the README.** This is the one place pkgxray's "never
   executes" promise narrows, and hiding that would be dishonest. Document that
   manifest enumeration connects to (and, for stdio, runs) the server, and that
   the recommended order is package-scan-first.

This caveat is the detail most likely to bite if it's overlooked. Keep it
front-of-mind while building.

---

## Reuse map — what already exists (do not reimplement)

Verify each of these against the current code before writing anything new; the
honest remaining work is the delta, exactly as `RECHECK_TRIAGE.md` and
`INTEGRATION_TRIAGE.md` did for their tiers.

| Capability you need | Already in | Reuse note |
|---|---|---|
| The whole static/injection/concealment engine | `src/auditor.js` `auditEvidence(input)` | Consumes `sourceFiles` (a `path → text` map) + optional metadata, returns `{verdict, grade, score, riskBands, findings}`. **This is the layer T2 feeds the manifest into.** |
| Tiered prompt-injection + concealment matchers | `src/auditor.js` (`matchInjection`, `inspectInjectionAttempt`, `inspectObfuscation`, unicode-tag / base64 detectors) | Reached *through* `auditEvidence` — you don't call them directly, you hand text to the engine. |
| Package-scan-first path (static, no exec) | `src/quarantine.js` `guardExtension(reference, opts)` → `{report, decision}` | The step that runs **before** connect when the server ships as a package. Same call `pkgxray guard` already makes. |
| Triage store + `.pkgxray.lock` | `src/triage.js` (`loadDecisions`, `loadDecisionsSync`, `saveDecisions`) | Record `{name, version, decision, reason, decided_at}`, `schemaVersion: 1`. T4 pins an approved manifest here — same store, additive fields only. |
| Verdict-drift baseline + staleness | recheck tier: `checkedAt` + stored `verdict` on the record, `isStale(record, ttlMs?)` | T4's drift/rug-pull check reuses this, it does not fork it. |
| CLI dispatch + exit codes | `bin/audit.js` `parseArgs` (`guard`/`audit`/`triage`), exit `2 block / 3 review / 0 safe` | Add an `mcp` subcommand keyed the same way. |
| stdio MCP server (as a *server*) | `bin/mcp-server.js` | Reference for JSON-RPC framing and hardening. The adapter is a **client** connecting outward — the inverse role. |

**Verdict vocabulary — reuse, do not invent a second dialect** (same rule
`RECHECK_TRIAGE.md` states): `verdict ∈ {safe, review, block}` is the computed
result; `decision ∈ {allow, block}` is the persisted human triage choice. A
manifest's verdict folds worst-of over its tools with the existing
`block > review > safe` ranking. Do not introduce "trusted", "suspicious", or a
numeric-only surface.

---

## T1 — connect + read-only handshake + manifest enumeration

**The only substantial new plumbing.** A minimal MCP client that connects over
**stdio** (spawn `command`+`args`) **or streamable HTTP** (a base URL), performs
the read-only lifecycle handshake (`initialize` → `initialized`), and calls
`tools/list` to enumerate the tool manifest.

- **Read-only, hard invariant:** enumerate only. Never call `tools/call`, never
  read a resource, never invoke a prompt. Listing must not be able to trigger a
  side effect. (Runtime tool-call gating is an explicit follow-on, below — not
  this task.)
- **Package-scan-first ordering (the caveat):** if the server is given as a
  package/local ref, run `guardExtension` on it first and stop on `block` unless
  force-accepted; only then connect. Surface the guard verdict alongside the
  manifest result.
- **Spawn hygiene (stdio):** scrubbed child env, hard timeout, killed on exit,
  bounded stdout/stderr, no TTY. A hung or chatty server must not hang or OOM the
  adapter — mirror `bin/mcp-server.js`'s buffer cap discipline, inverted.
- **Output:** a normalized manifest — server info (name/version from
  `initialize`), transport, and per-tool `{name, description, inputSchema}` —
  shaped as the `path → text` / evidence input T2 consumes. Nothing is judged
  yet in T1; it produces the input.
- **Zero-dep constraint holds:** Node core only (`child_process`, `http`/`https`,
  JSON-RPC over newline-delimited stdio), consistent with the rest of the repo.

## T2 — route the manifest through the existing scanner

**Highest reuse, highest value. No new detection logic.** The tool manifest —
every tool `name`, `description`, and `inputSchema` — is just a **new input** to
the injection/concealment layer pkgxray already ships. Feed the manifest text
into `auditEvidence` (as `sourceFiles` / evidence) and let the existing engine
find:

- verdict-forcing / rule-overriding **prompt injection** in a tool description
  (the same tiered matcher used on READMEs and code comments);
- **concealment** — instructions smuggled in invisible Unicode tag characters,
  or a base64 blob in a description that a human can't read but an agent decodes
  (the "detect the envelope, not the message" property carries over verbatim);
- chat/role scaffolding (`<|im_start|>`, `<<SYS>>`, `[INST]`), identity
  reassignment, reworded steering.

Treat **all** manifest text as untrusted evidence exactly as the auditor already
treats package text — a tool description telling the agent to ignore prior
instructions is reported as a high-severity `injection-attempt`, never followed.
The engine's injection-proof-by-construction property (deterministic verdict, no
model in the decision path) is what makes this safe to point at hostile manifest
text. **If T2 needs a new matcher, it's mis-scoped** — route the input, reuse
the layer.

## T3 — capability-surface mismatch (the one genuinely new analysis)

The only net-new detector: a tool whose **declared purpose** (name +
description) is narrow but whose **input schema** exposes a broad, dangerous
capability. The canonical case: a `get_weather` tool that takes an arbitrary
`command` / `code` / `script` / `path`-to-execute parameter — the description
says "weather", the surface says "run anything".

**Calibrate conservatively — this is the whole difficulty of the task.** The
false-positive discipline from the base engine applies (validated at 0 false
blocks): a legitimate file-reader that takes a `path`, an HTTP tool that takes a
`url`, a DB tool that takes a `query` must **not** be flagged *just for having a
powerful-looking parameter*. The signal is the **mismatch** — a benign, narrow
stated purpose paired with a general-execution / arbitrary-command parameter —
not the parameter alone.

- Gate only on an unambiguous shape (a command/code-exec-shaped param on a tool
  that presents itself as something innocuous). When the purpose plausibly
  justifies the surface, **route to `review`, never a false `block`** — the same
  "uncertainty → review" rule the rest of the engine follows.
- Emit citable evidence (the offending param + the mismatched description), like
  every other finding. No opaque score.

## T4 — pin approved manifests + drift / rug-pull recheck

Pin an **approved manifest** and reuse the recheck/drift tier to catch the
**rug-pull**: descriptions (or the tool set, or schemas) changing *after*
approval.

- **Pin via the existing store:** persist the approved manifest into
  `.pkgxray.lock` through `src/triage.js` — same store, `schemaVersion: 1`,
  additive fields only. Reuse the `checkedAt` + stored-`verdict` baseline the
  recheck tier added; a manifest fingerprint (per-tool name + description +
  schema) is the drift baseline.
- **Recheck = re-enumerate + diff:** re-run T1 enumeration, re-run T2/T3, and
  compare against the pinned baseline. A description that changed since approval,
  a new tool, or a widened schema is **drift** — surface it; a change that now
  trips injection/mismatch is a **regression**. Exit-code semantics follow
  recheck's rule: gate on **new regressions**, not on an already-known state
  (`RECHECK_TRIAGE.md` T4).
- Reuse `isStale(record, ttlMs?)` for the "when did we last check this server"
  surface. Do not fork the drift comparator — parameterize it.

---

## Surface

- **CLI:** add `pkgxray mcp <stdio-command… | http-url>` to `bin/audit.js`
  `parseArgs`, keyed like the existing subcommands, same `2/3/0` exit codes.
  Flags at minimum: transport selection, `--pin` / recheck against a pinned
  manifest, `--no-package-scan` opt-out (with a loud note about the caveat), a
  force flag to connect past a `block` package scan.
- **MCP tool (optional, follows the four in `bin/mcp-server.js`):** an
  `audit_mcp_server_manifest`-style tool. If added, apply the *same* MCP-server
  hardening already in that file — argument validation as the enforcement layer
  (not just `inputSchema`), NUL-byte rejection, `sanitizeErrorMessage` on every
  reply, and the local-reference guard reasoning (an LLM-driven host must not be
  able to turn "audit this server" into a remote-spawn primitive against an
  arbitrary local binary without an explicit opt-in).

---

## How to execute this prompt (repo convention)

1. **Triage first.** Before any PR, produce `MCP_ADAPTER_TRIAGE.md` in the
   pattern of `RECHECK_TRIAGE.md` / `INTEGRATION_TRIAGE.md`: reproduce each
   task's assumptions against the *actual* current code, mark **confirmed /
   partial / not-a-gap**, and reduce the plan to the honest net-new delta. Do
   not assume a gap exists until it reproduces.
2. **Tests** in the existing `node --test` style (`test/*.test.js`), including a
   fixture manifest carrying a concealed-injection description and a
   capability-mismatch tool, plus a legit narrow-param tool that must stay
   `safe` (the calibration guard for T3).
3. **README** update: a short "MCP servers it connects to" section mirroring the
   package side — **and the execution caveat stated plainly** (enumeration
   connects to, and for stdio runs, the server; package-scan-first is the safe
   order). This is a required part of the change, not optional polish.

---

## Explicitly out of scope (follow-on prompts, not this one)

This prompt is the **connect-time static layer**. The runtime pieces are a
separate, live-gateway surface — the same relationship the proxy has to the base
install-guard — and are cleaner as a second step once this layer is proven:

- **Gating actual `tools/call` invocations** at runtime (a live MCP gateway).
- **Prompt injection in *tool results*** returned during a call (T2 covers the
  *manifest*; results are a runtime channel).
- **Cross-server confused-deputy** (one server's tool influencing another's
  invocation).
- Anything that requires standing between the agent and the server *while it
  calls tools*. This prompt only ever *lists*.

Keep those out. Land the static, connect-time, one-engine layer first.
