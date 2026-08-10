#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { auditEvidence, renderMarkdown } = require("../src/auditor");
const { guardExtension } = require("../src/quarantine");
const { auditLockfile, renderLockfileMarkdown, sanitizeForTerminal } = require("../src/lockfile");
const { triageLockfile } = require("../src/triage");
const { recheckLockfile, renderRecheckText, recheckJson } = require("../src/recheck");
const { inspectMcpServer } = require("../src/mcp-audit");
const { pinMcpManifest, recheckMcpManifest } = require("../src/mcp-pin");
const { runMcpProxy } = require("../src/mcp-proxy");
const { runCanarySandbox } = require("../src/sandbox");
const cfg = require("../src/config");
const { version: PACKAGE_VERSION } = require("../package.json");

// Map a config-adjusted verdict (safe|review|block, from applyConfig, which has
// already applied mutes + the pinned allowlist) through the same policy
// promotion the guard uses for its decision: under `allow-review` a review-grade
// package is promoted to `allow`. Keeps the guard/file exit code driven by
// exitCodeForVerdict while preserving today's --policy behavior.
function promoteVerdict(verdict, policy) {
  if (verdict === "block") return "block";
  if (verdict === "review") return policy === "allow-review" ? "allow" : "review";
  return verdict; // safe / allow pass through
}

function printUsage() {
  process.stderr.write(
    [
      "Usage: pkgxray <command> [options]",
      "",
      "Common commands — vet before you install or connect:",
      "  pkgxray guard <npm-package|npm:name@version|github:owner/repo[#ref]|./path> [--promote-to dir] [--no-source-scan] [--deps] [--typosquat]",
      "                     # vet a package before install (static; no package code runs).",
      "                     # --deps also OSV-scans the package's DIRECT dependencies (transitive worm entry point)",
      "                     # --no-vulnerability-check skips the OSV lookup entirely (offline / air-gapped use).",
      "                     #   If OSV is merely unreachable you don't need this: the static scan still runs and",
      "                     #   the report cites the missing CVE check.",
      "  pkgxray audit <package-lock.json|yarn.lock|pnpm-lock.yaml|package.json>  # batch OSV scan of every dep",
      "  pkgxray mcp [flags] <https-url | command [args...]>                       # enumerate an MCP server's tool manifest (read-only handshake)",
      "                     [--package <ref>] [--no-package-scan] [--force]        #   package-scan-first: guard the ref BEFORE connecting; block halts",
      "                     [--timeout <ms>]                                       #   NOTE: enumerating a stdio server SPAWNS it — scan first",
      "                     [--pin] [--recheck] [--lock <path>]                     #   pin the approved manifest / diff live manifest vs. the pin (rug-pull)",
      "  pkgxray recheck <lockfile> [--verbose] [--no-write]                      # re-evaluate pinned deps; diff verdict vs. stored baseline",
      "                     [--no-version-drift] [--fail-on-available-updates]     #   + pre-vet newer versions (informational unless --fail-on-...)",
      "",
      "  Exit codes: 0 safe/allow · 2 block · 3 review.",
      "",
      "Evidence in / out (no acquisition, just render a verdict):",
      "  pkgxray < evidence.json",
      "  pkgxray --format json < evidence.json",
      "  pkgxray --file evidence.json --format markdown",
      "",
      "Advanced:",
      "  pkgxray canary <ref> --yes-run-untrusted-code [--timeout ms] [--keep-sandbox] [--require-sandbox] [--tls-mitm] [--no-import-phase]",
      "                     # OPT-IN: EXECUTES untrusted package code (install + import) inside the sandbox — the one path that",
      "                     # runs the package. Decoy-credential HOME behind a capture proxy that never forwards egress; confirms",
      "                     # exfil behaviorally (cannot clear a pkg). Requires --yes-run-untrusted-code (or PKGXRAY_ALLOW_EXECUTION=1).",
      "                     # --require-sandbox fails closed without an OS sandbox (bwrap/sandbox-exec).",
      "                     # --tls-mitm: terminate HTTPS with an ephemeral per-host CA (node:crypto, no openssl) to scan decrypted",
      "                     #   request bodies; off by default (default records the CONNECT host only). See docs/canary-threat-model.md",
      "  pkgxray mcp-proxy [flags] [--] <command [args...]>                         # run a stdio MCP server behind a per-call runtime gate: every tools/call",
      "                     [--policy strict|balanced|permissive]                   #   is checked in-memory (µs), the manifest is re-audited on every",
      "                     [--pin] [--lock <path>] [--no-recheck]                  #   tools/list_changed, drifted tools are denied until re-pinned,",
      "                     [--no-scan-results] [--timing]                          #   and tool RESULTS are scanned for injection (use in host config)",
      "  pkgxray triage <lockfile> [--include-safe] [--auto allow|block]          # interactive allow/block walkthrough",
      "  pkgxray triage --resume                                                  #   resume interrupted triage",
      "  pkgxray mcp-server                                                        # run pkgxray ITSELF as a stdio MCP server (for MCP hosts /",
      "                     # the MCP Registry entry: `npx -y pkgxray mcp-server`)  #   exposes audit/guard/lockfile tools. cf. `mcp` above, which audits.",
      "  pkgxray serve-mcp                                                        # alias for mcp-server (run the local stdio MCP server)",
      "  pkgxray --version",
      "",
      "Evidence JSON fields:",
      "  packageName, npmMetadata, githubMetadata, webPresence, sourceFiles",
      ""
    ].join("\n")
  );
}

function parseArgs(argv) {
  const options = { command: "audit", format: "markdown", file: null };
  if (argv[0] === "--version" || argv[0] === "-V") {
    options.command = "version";
    argv = [];
  } else if (argv[0] === "serve-mcp") {
    options.command = "serveMcp";
    argv = argv.slice(1);
  } else if (argv[0] === "guard") {
    options.command = "guard";
    options.reference = argv[1];
    argv = argv.slice(2);
  } else if (argv[0] === "canary") {
    options.command = "canary";
    options.reference = argv[1];
    argv = argv.slice(2);
  } else if (argv[0] === "audit") {
    options.command = "auditLockfile";
    options.lockfilePath = argv[1];
    argv = argv.slice(2);
  } else if (argv[0] === "recheck") {
    options.command = "recheck";
    options.lockfilePath = argv[1];
    argv = argv.slice(2);
  } else if (argv[0] === "mcp") {
    options.command = "mcp";
    argv = argv.slice(1);
    // Own flags come first; the first non-flag token starts the target —
    // an https URL, or a stdio command whose remaining argv (flags included)
    // belongs to the server, not to us.
    while (argv.length > 0 && argv[0].startsWith("--")) {
      const arg = argv.shift();
      if (arg === "--package") {
        options.packageRef = argv.shift();
      } else if (arg === "--no-package-scan") {
        options.packageScan = false;
      } else if (arg === "--no-audit") {
        options.audit = false;
      } else if (arg === "--pin") {
        options.pin = true;
      } else if (arg === "--recheck") {
        options.recheck = true;
      } else if (arg === "--lock") {
        options.lockPath = argv.shift();
      } else if (arg === "--no-write") {
        options.write = false;
      } else if (arg === "--force") {
        options.force = true;
      } else if (arg === "--timeout") {
        options.timeoutMs = Number(argv.shift());
        if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
          throw new Error("--timeout must be a positive number of milliseconds");
        }
      } else if (arg === "--format") {
        options.format = argv.shift();
      } else if (arg === "--help" || arg === "-h") {
        options.help = true;
      } else {
        throw new Error(`Unknown mcp argument: ${arg}`);
      }
    }
    if (argv.length > 0) {
      if (/^https?:\/\//i.test(argv[0])) {
        options.mcpTarget = { url: argv[0] };
        if (argv.length > 1) {
          throw new Error("an HTTP MCP target takes no further arguments");
        }
      } else {
        options.mcpTarget = { command: argv[0], args: argv.slice(1) };
      }
    }
    argv = [];
  } else if (argv[0] === "mcp-proxy") {
    options.command = "mcpProxy";
    argv = argv.slice(1);
    // Same convention as `mcp`: our flags first, the first non-flag token (or
    // everything after `--`) is the real server's command line, untouched.
    while (argv.length > 0 && argv[0].startsWith("--") && argv[0] !== "--") {
      const arg = argv.shift();
      if (arg === "--policy") {
        options.policy = argv.shift();
        if (!["strict", "balanced", "permissive"].includes(options.policy)) {
          throw new Error("--policy must be strict, balanced or permissive");
        }
      } else if (arg === "--pin") {
        options.pin = true;
      } else if (arg === "--lock") {
        options.lockPath = argv.shift();
      } else if (arg === "--no-recheck") {
        options.recheck = false;
      } else if (arg === "--no-scan-results") {
        options.scanResults = false;
      } else if (arg === "--timing") {
        options.timing = true;
      } else if (arg === "--help" || arg === "-h") {
        options.help = true;
      } else {
        throw new Error(`Unknown mcp-proxy argument: ${arg}`);
      }
    }
    if (argv[0] === "--") argv = argv.slice(1);
    if (argv.length > 0) {
      if (/^https?:\/\//i.test(argv[0])) {
        throw new Error(
          "mcp-proxy wraps stdio servers only (the host must launch the proxy in the server's place); for HTTP servers use the connect-time `pkgxray mcp <url>`"
        );
      }
      options.mcpTarget = { command: argv[0], args: argv.slice(1) };
    }
    argv = [];
  } else if (argv[0] === "triage") {
    options.command = "triage";
    // Allow `pkgxray triage --resume` with no lockfile path (we resolve at
    // run time from CWD's .pkgxray.lock if it exists; otherwise we still
    // require a lockfile path).
    if (argv[1] && !argv[1].startsWith("--")) {
      options.lockfilePath = argv[1];
      argv = argv.slice(2);
    } else {
      argv = argv.slice(1);
    }
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--format") {
      options.format = argv[++i];
    } else if (arg === "--file") {
      options.file = argv[++i];
    } else if (arg === "--quarantine-root") {
      options.quarantineRoot = argv[++i];
    } else if (arg === "--promote-to") {
      options.promoteTo = argv[++i];
    } else if (arg === "--policy") {
      options.policy = argv[++i];
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--no-source-scan") {
      options.sourceScan = false;
    } else if (arg === "--typosquat") {
      options.typosquat = true;
    } else if (arg === "--deps") {
      options.scanDependencies = true;
    } else if (arg === "--yes-run-untrusted-code") {
      options.allowExecution = true;
    } else if (arg === "--keep-sandbox") {
      options.keepSandbox = true;
    } else if (arg === "--require-sandbox") {
      options.requireSandbox = true;
    } else if (arg === "--tls-mitm") {
      options.tlsMitm = true;
    } else if (arg === "--no-import-phase") {
      options.importPhase = false;
    } else if (arg === "--timeout") {
      options.timeoutMs = Number(argv[++i]);
      if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
        throw new Error("--timeout must be a positive number of milliseconds");
      }
    } else if (arg === "--no-vulnerability-check") {
      options.vulnerabilityCheck = false;
    } else if (arg === "--no-github") {
      options.githubMetadata = false;
      options.githubDiff = false;
    } else if (arg === "--no-github-diff") {
      options.githubDiff = false;
    } else if (arg === "--deep") {
      options.deep = true;
    } else if (arg === "--deep-all") {
      options.deep = true;
      options.deepAll = true;
    } else if (arg === "--include-safe") {
      options.includeSafe = true;
    } else if (arg === "--resume") {
      options.resume = true;
    } else if (arg === "--auto") {
      options.auto = argv[++i];
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "--no-write") {
      options.write = false;
    } else if (arg === "--no-version-drift") {
      options.versionDrift = false;
    } else if (arg === "--fail-on-available-updates") {
      options.failOnAvailableUpdates = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!["json", "markdown"].includes(options.format)) {
    throw new Error("--format must be json or markdown");
  }
  return options;
}

function readInput(file) {
  if (file) {
    return fs.readFileSync(file, "utf8");
  }
  return fs.readFileSync(0, "utf8");
}

async function main() {
  // `pkgxray mcp-server` runs THIS package as a stdio MCP server — the same
  // server the `pkgxray-mcp` bin exposes — so MCP hosts can launch it with
  // `npx -y pkgxray mcp-server` (the registry entry) without a separate
  // package. Intercepted before parseArgs so none of the audit machinery runs.
  // NOTE: distinct from `pkgxray mcp <target>`, which AUDITS another server.
  if (process.argv[2] === "mcp-server") {
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
      process.stderr.write(
        "Usage: pkgxray mcp-server   # run pkgxray as a stdio MCP server (for MCP hosts)\n"
      );
      return;
    }
    require("./mcp-server.js").startStdioServer();
    return;
  }

  const options = parseArgs(process.argv.slice(2));
  if (options.command === "version") {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }
  if (options.command === "serveMcp") {
    require("./mcp-server").attachStdin();
    return;
  }
  if (options.help) {
    printUsage();
    return;
  }

  // Load the shared policy once, at startup, for every surface. A CLI
  // `--policy` flag is the highest-precedence override (it wins over the file
  // and env). Every warning is printed LOUD to stderr — a loosening or a
  // misconfig must never be silent.
  const { config, warnings } = cfg.loadConfig({
    cwd: process.cwd(),
    overrides: options.policy ? { policy: options.policy } : {}
  });
  for (const warning of warnings) {
    process.stderr.write(`pkgxray: ${warning}\n`);
  }
  // Keep the existing --policy semantics working downstream (guardExtension,
  // decisionForReport) by carrying the effective policy back onto options.
  options.policy = config.policy;
  // Config supplies enablement AND tuning ({maxDistance,minLen}) for the opt-in
  // typosquat heuristic; it wins over the bare --typosquat flag so file-configured
  // tuning is always honored. The flag alone (config disabled) still enables with
  // defaults via options.typosquat = true set during arg parsing.
  if (config.typosquat) options.typosquat = config.typosquat;

  if (options.command === "guard") {
    if (!options.reference) {
      throw new Error("guard requires an extension reference");
    }
    // Keep the staging tree so the user can inspect / promote it from the
    // printed Quarantine path; non-interactive callers reap it by default.
    let result;
    try {
      result = await guardExtension(options.reference, {
        ...options,
        scanErrorPolicy: config.scanErrorPolicy,
        keepStaging: true
      });
    } catch (error) {
      // A guard that crashes / times out must not exit to an unclear state.
      // Route it through the config's scan-error policy (fail-closed → review),
      // never a bare crash-to-1-or-silent-safe.
      const verdict = cfg.verdictForScanError(config);
      process.stderr.write(`pkgxray: guard failed to complete (${error.message}); treating as ${verdict}\n`);
      // Under --format json, a JSON consumer must still receive a parseable
      // verdict on stdout — otherwise the degraded review is indistinguishable
      // from a silent crash (empty stdout), which is exactly what batch scanners
      // record as a "scan error". Emit a minimal, schema-tagged object.
      if (options.format === "json") {
        process.stdout.write(
          `${JSON.stringify(
            {
              schemaVersion: 1,
              decision: verdict,
              reference: options.reference,
              scanError: error.message
            },
            null,
            2
          )}\n`
        );
      }
      process.exitCode = cfg.exitCodeForVerdict(verdict, config);
      return;
    }

    // Apply the shared policy to the guard's report before deciding: mutes are
    // kept-but-excluded, a pinned+matching-sha256 allow can force safe. The
    // resolved identity + tarball sha256 come off result.resolved (sha256 is
    // set by the npm download path in quarantine.js; absent for local refs, in
    // which case a pinned allow simply won't match).
    const adjusted = cfg.applyConfig(result.report, {
      config,
      packageName: result.resolved && result.resolved.packageName,
      version: result.resolved && result.resolved.version,
      sha256: result.resolved && result.resolved.sha256,
      evidence: { sourceFiles: Object.keys(result.sourceFiles || {}).map(() => ({})) }
    });
    result.report = adjusted;
    result.configEffects = adjusted.configEffects;
    // Fold the policy promotion (--policy allow-review) over the config verdict
    // so the guard's reported decision + exit code stay consistent with today.
    // Re-apply the scan-gap floor: applyConfig/promoteVerdict recompute the
    // verdict from the report, which would otherwise discard the floor
    // guardExtension already applied to result.decision. An allowlist hit in
    // .pkgxray.json still wins — that is an explicit, pinned human decision.
    const promoted = promoteVerdict(adjusted.verdict, config.policy);
    const finalVerdict =
      adjusted.configEffects && adjusted.configEffects.allowlisted
        ? promoted
        : cfg.floorVerdictForScanGap(
            promoted,
            Boolean(result.vulnerabilityPrecheck && result.vulnerabilityPrecheck.error),
            config
          );
    result.decision = finalVerdict;

    if (options.format === "json") {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const lines = [renderGuardMarkdown(result), ...cfg.renderConfigEffects(adjusted.configEffects)];
      process.stdout.write(`${lines.join("\n")}\n`);
    }
    process.exitCode = cfg.exitCodeForVerdict(finalVerdict, config);
    return;
  }

  if (options.command === "canary") {
    if (!options.reference) {
      throw new Error("canary requires a package reference");
    }
    const allow = options.allowExecution === true || process.env.PKGXRAY_ALLOW_EXECUTION === "1";
    process.stderr.write(
      "pkgxray: WARNING — the canary sandbox EXECUTES this package's install lifecycle scripts " +
        "(in a throwaway HOME seeded with decoy credentials, behind a capture proxy that never forwards egress).\n"
    );
    if (!allow) {
      throw new Error(
        "canary requires explicit opt-in: pass --yes-run-untrusted-code or set PKGXRAY_ALLOW_EXECUTION=1"
      );
    }
    // Stage the package WITHOUT executing it (guard's normal quarantine). Force
    // staging even when OSV would flag it — the canary is about behavior — by
    // skipping the vuln precheck that otherwise short-circuits the download.
    const staged = await guardExtension(options.reference, {
      ...options,
      keepStaging: true,
      vulnerabilityCheck: false
    });
    if (!staged.stagedPath) {
      throw new Error("could not stage the package for the canary sandbox");
    }
    const behavioral = await runCanarySandbox({
      stagedPath: staged.stagedPath,
      allowExecution: true,
      timeoutMs: options.timeoutMs,
      keepSandbox: options.keepSandbox,
      requireSandbox: options.requireSandbox,
      tlsMitm: options.tlsMitm,
      importPhase: options.importPhase
    });
    if (options.format === "json") {
      process.stdout.write(`${JSON.stringify({ static: staged.report, behavioral }, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderCanaryMarkdown(staged, behavioral)}\n`);
    }
    const worst =
      behavioral.verdict === "block" || staged.decision === "block"
        ? "block"
        : behavioral.verdict === "review" || staged.decision === "review"
          ? "review"
          : "safe";
    process.exitCode = worst === "block" ? 2 : worst === "review" ? 3 : 0;
    return;
  }

  if (options.command === "mcp") {
    if (!options.mcpTarget) {
      throw new Error("mcp requires a target: an https:// URL or a stdio command");
    }
    // The caveat, said out loud every time it applies: enumerating a stdio
    // server runs it. A prior package scan is the safe order.
    if (options.mcpTarget.command && !options.packageRef) {
      process.stderr.write(
        "pkgxray: note — enumerating a stdio MCP server SPAWNS it. No package scan was requested; pass --package <ref> to statically vet the server first.\n"
      );
    } else if (options.packageScan === false) {
      process.stderr.write(
        "pkgxray: note — package scan skipped (--no-package-scan); connecting to an unvetted server.\n"
      );
    }
    if (options.pin && options.recheck) {
      throw new Error("--pin and --recheck are mutually exclusive (pin re-approves, recheck compares)");
    }
    const result = await inspectMcpServer(options.mcpTarget, options);

    if (!result.halted && options.pin) {
      result.pin = await pinMcpManifest({
        manifest: result.manifest,
        verdict: result.verdict,
        lockPath: options.lockPath
      });
    }
    if (!result.halted && options.recheck) {
      result.recheck = await recheckMcpManifest({
        manifest: result.manifest,
        verdict: result.verdict,
        lockPath: options.lockPath,
        write: options.write
      });
    }

    if (options.format === "json") {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderMcpMarkdown(result)}\n`);
    }
    // recheck gates on what is NEW vs. the baseline (recheck's rule); the
    // plain audit and pin gate on the absolute verdict.
    process.exitCode = result.recheck
      ? result.recheck.exitCode
      : result.verdict === "block" ? 2 : result.verdict === "review" ? 3 : 0;
    return;
  }

  if (options.command === "mcpProxy") {
    if (!options.mcpTarget) {
      throw new Error("mcp-proxy requires the real server's command line, e.g. pkgxray mcp-proxy -- npx some-mcp-server");
    }
    // Long-running: lives as long as the agent session. Exit code mirrors the
    // wrapped server so the host sees the server's own failures.
    const { code } = await runMcpProxy(options.mcpTarget, options);
    process.exitCode = code;
    return;
  }

  if (options.command === "triage") {
    if (!options.lockfilePath) {
      throw new Error("triage requires a lockfile path (package-lock.json | yarn.lock | pnpm-lock.yaml | package.json)");
    }
    try {
      const result = await triageLockfile(options.lockfilePath, options);
      // Exit 0 when triage completes (or auto-mode runs) — the user has
      // exercised judgment, so a blocked count isn't an error here.
      process.exitCode = 0;
      // result intentionally not printed beyond the in-loop output.
      void result;
    } catch (error) {
      if (error && error.code === "ENOTTY") {
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    return;
  }

  if (options.command === "recheck") {
    if (!options.lockfilePath) {
      throw new Error("recheck requires a lockfile path (package-lock.json | yarn.lock | pnpm-lock.yaml | package.json)");
    }
    const result = await recheckLockfile(options.lockfilePath, options);
    if (options.format === "json") {
      process.stdout.write(`${JSON.stringify(recheckJson(result), null, 2)}\n`);
    } else {
      process.stdout.write(`${renderRecheckText(result, { verbose: options.verbose })}\n`);
    }
    // Exit code reflects the worst *regression*, never the worst absolute
    // verdict — a still-block dep that was already block is not a new exposure.
    process.exitCode = result.exitCode;
    return;
  }

  if (options.command === "auditLockfile") {
    if (!options.lockfilePath) {
      throw new Error("audit requires a lockfile path (package-lock.json | yarn.lock | pnpm-lock.yaml | package.json)");
    }
    const result = await auditLockfile(options.lockfilePath, options);
    if (options.format === "json") {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderLockfileMarkdown(result)}\n`);
    }
    // Config is applied here only for the exit-code threshold (failOn) and the
    // startup warnings — per-dep identity + sha256 isn't readily available on
    // this batch path, so per-dep allow/mute wiring is a deliberate follow-up.
    // worstDecision uses {block, review, allow/safe}; exitCodeForVerdict ranks
    // allow/safe as 0, so the default config reproduces today's codes.
    process.exitCode = cfg.exitCodeForVerdict(result.worstDecision, config);
    return;
  }

  const raw = readInput(options.file).trim();
  if (!raw) {
    throw new Error("No evidence JSON provided");
  }

  let evidence;
  try {
    evidence = JSON.parse(raw);
  } catch (error) {
    // Unparseable evidence is a scan that could not complete — fail closed
    // (default → review) rather than crash to an unclear state.
    const verdict = cfg.verdictForScanError(config);
    process.stderr.write(`pkgxray: could not parse evidence JSON (${error.message}); treating as ${verdict}\n`);
    process.exitCode = cfg.exitCodeForVerdict(verdict, config);
    return;
  }
  const report = auditEvidence(evidence, { typosquat: options.typosquat });

  // Apply the shared policy: this path has full identity (packageName/version)
  // from the evidence, and an optional sha256 the caller may pass so a pinned
  // allow can match. Mutes always apply.
  const adjusted = cfg.applyConfig(report, {
    config,
    packageName: evidence.packageName,
    version:
      (evidence.npmMetadata && evidence.npmMetadata.version) || evidence.version || null,
    sha256: evidence.sha256 || (evidence.dist && evidence.dist.sha256) || null,
    evidence
  });
  const finalVerdict = promoteVerdict(adjusted.verdict, config.policy);

  if (options.format === "json") {
    process.stdout.write(`${JSON.stringify(adjusted, null, 2)}\n`);
  } else {
    const lines = [renderMarkdown(adjusted), ...cfg.renderConfigEffects(adjusted.configEffects)];
    process.stdout.write(`${lines.join("\n")}\n`);
  }

  process.exitCode = cfg.exitCodeForVerdict(finalVerdict, config);
}

// Every string in the manifest is attacker-controlled (a hostile server names
// its own tools) — strip control bytes before it reaches a terminal.
function renderMcpMarkdown(result) {
  const lines = [];

  if (result.packageScan) {
    lines.push(
      `Package scan: **${result.packageScan.decision.toUpperCase()}** — \`${sanitizeForTerminal(result.packageScan.reference)}\``
    );
  }
  if (result.halted) {
    lines.push(
      "",
      "Enumeration halted: the package scan says **BLOCK**. Pass --force to connect anyway (not recommended)."
    );
    return lines.join("\n");
  }

  const manifest = result.manifest;
  lines.push(
    `Server: **${sanitizeForTerminal(manifest.server.name || "(unnamed)")}** v${sanitizeForTerminal(manifest.server.version || "?")}`,
    `Transport: ${manifest.transport} — \`${sanitizeForTerminal(manifest.target)}\``,
    `Protocol: ${sanitizeForTerminal(manifest.protocolVersion || "unknown")}`,
    "",
    `Tools (${manifest.tools.length}):`
  );
  for (const tool of manifest.tools) {
    const params = tool.inputSchema && tool.inputSchema.properties
      ? Object.keys(tool.inputSchema.properties).join(", ")
      : "";
    lines.push(
      `- \`${sanitizeForTerminal(tool.name)}\`${params ? ` (${sanitizeForTerminal(params)})` : ""} — ${sanitizeForTerminal(tool.description || "(no description)")}`
    );
  }
  for (const warning of manifest.diagnostics.warnings || []) {
    lines.push(`> warning: ${sanitizeForTerminal(warning)}`);
  }

  if (result.manifestAudit) {
    lines.push("", `Manifest verdict: **${result.verdict.toUpperCase()}**`);
    const visible = result.manifestAudit.findings.filter((f) => f.severity !== "info");
    for (const finding of visible) {
      lines.push(
        `- [${finding.severity.toUpperCase()}] ${sanitizeForTerminal(finding.category)} in \`${sanitizeForTerminal(finding.file)}\`: ${sanitizeForTerminal(finding.rationale)}`
      );
    }
    if (visible.length === 0) {
      lines.push("- no findings in the tool manifest");
    }
  }

  if (result.pin) {
    lines.push(
      "",
      `Pinned: \`${sanitizeForTerminal(result.pin.record.name)}@${sanitizeForTerminal(result.pin.record.version)}\` (${result.pin.record.manifest.tools.length} tool fingerprints) → \`${sanitizeForTerminal(result.pin.lockPath)}\``
    );
  }

  if (result.recheck) {
    const rc = result.recheck;
    lines.push("");
    if (rc.status === "no-baseline") {
      lines.push("Recheck: **no baseline** — this server was never pinned. Run with --pin to approve the current manifest.");
    } else {
      lines.push(`Recheck vs. baseline (pinned ${sanitizeForTerminal(rc.baseline.decided_at || "?")}):`);
      lines.push(`- verdict: ${sanitizeForTerminal(rc.baseline.verdict || "unknown")} → ${sanitizeForTerminal(result.verdict)} (**${rc.verdictDrift}**)`);
      if (rc.manifestDrift) {
        if (rc.manifestDrift.drifted) {
          const parts = [];
          if (rc.manifestDrift.added.length) parts.push(`added: ${rc.manifestDrift.added.map(sanitizeForTerminal).join(", ")}`);
          if (rc.manifestDrift.removed.length) parts.push(`removed: ${rc.manifestDrift.removed.map(sanitizeForTerminal).join(", ")}`);
          if (rc.manifestDrift.changed.length) parts.push(`changed: ${rc.manifestDrift.changed.map(sanitizeForTerminal).join(", ")}`);
          lines.push(`- manifest DRIFTED since approval — ${parts.join("; ")}. Re-review and --pin to re-approve.`);
        } else {
          lines.push("- manifest matches the approved fingerprints");
        }
      } else {
        lines.push("- no manifest fingerprints in the baseline (pinned by an older pkgxray) — --pin to upgrade the record");
      }
      if (rc.versionChanged) {
        lines.push(`- server version changed: ${sanitizeForTerminal(rc.baseline.version)} → ${sanitizeForTerminal(result.manifest.server.version || "?")}`);
      }
    }
  }
  return lines.join("\n");
}

function renderCanaryMarkdown(staged, behavioral) {
  const lines = [
    `Canary sandbox — behavioral verdict: **${behavioral.verdict.toUpperCase()}**`,
    `Reference: \`${sanitizeForTerminal(staged.reference)}\``,
    `Isolation: ${sanitizeForTerminal(behavioral.isolation)}  ·  run ${sanitizeForTerminal(behavioral.runId)}`,
    `Phases detonated: install${behavioral.executed && behavioral.executed.importPhase && behavioral.executed.importPhase.attempted ? " + import" : " only"}`,
    ""
  ];

  // The single most important framing: this tool CONFIRMS malice, it cannot
  // CLEAR a package. A quiet run is not a safe package.
  if (behavioral.verdict === "not-observed") {
    lines.push(
      "> No malicious behavior was OBSERVED in this run. This does NOT clear the package:",
      "> sandbox-aware malware can stay dormant when it detects analysis, a proxy, a",
      "> throwaway HOME, or a missing C2 server, and activate only on a real developer's",
      "> machine. Treat a quiet canary as 'nothing caught', never as 'proven safe' — the",
      "> static scan below is still authoritative.",
      ""
    );
  }

  if (behavioral.findings.length > 0) {
    lines.push("Observed behavior:");
    for (const f of behavioral.findings) {
      lines.push(`- **${f.severity.toUpperCase()} ${sanitizeForTerminal(f.category)}** — ${sanitizeForTerminal(f.rationale)}`);
    }
    lines.push("");
  }

  if (behavioral.egress && behavioral.egress.length > 0) {
    lines.push("Captured egress (not forwarded):");
    for (const hit of behavioral.egress.slice(0, 15)) {
      const leaked = hit.tokensSeen && hit.tokensSeen.length > 0 ? "  ⚠ CANARY TOKEN LEAKED" : "";
      lines.push(`- ${sanitizeForTerminal(hit.transport)} ${sanitizeForTerminal(hit.method)} ${sanitizeForTerminal(hit.host)}${leaked}`);
    }
    lines.push("");
  } else {
    lines.push("Captured egress: none.", "");
  }

  lines.push(`Limits: ${sanitizeForTerminal(behavioral.limits)}`, "");
  lines.push("--- Static scan (authoritative) ---", "");
  lines.push(renderGuardMarkdown(staged));
  return lines.join("\n");
}

function renderGuardMarkdown(result) {
  const lines = [
    `Decision: **${result.decision.toUpperCase()}**`,
    `Reference: \`${sanitizeForTerminal(result.reference)}\``,
    `Quarantine: \`${sanitizeForTerminal(result.quarantinePath)}\``,
    ""
  ];

  if (result.promotedPath) {
    lines.push(`Promoted to: \`${sanitizeForTerminal(result.promotedPath)}\``, "");
  }

  if (result.dependencyAudit) {
    const da = result.dependencyAudit;
    if (da.error) {
      lines.push(`Dependency scan: could not run (${sanitizeForTerminal(da.error)})`, "");
    } else if (da.flagged && da.flagged.length > 0) {
      lines.push(`Dependency scan: **${da.flagged.length} of ${da.scanned} direct dependencies have known vulnerabilities**`);
      for (const dep of da.flagged.slice(0, 25)) {
        const ids = dep.vulnerabilities.map((v) => sanitizeForTerminal(v.id)).join(", ");
        lines.push(`- \`${sanitizeForTerminal(dep.name)}@${sanitizeForTerminal(dep.range)}\` — ${ids}`);
      }
      if (da.note) lines.push(`  _${sanitizeForTerminal(da.note)}_`);
      lines.push("");
    } else {
      lines.push(`Dependency scan: ${da.scanned} direct dependencies, none with known OSV vulnerabilities.`);
      if (da.note) lines.push(`  _${sanitizeForTerminal(da.note)}_`);
      lines.push("");
    }
  }

  lines.push(renderMarkdown(result.report));
  return lines.join("\n");
}

// Only auto-run when invoked as the CLI. When required by a test, the exported
// functions are used instead so behavior can be driven in-process.
if (require.main === module) {
  try {
    main().catch((error) => {
      process.stderr.write(`pkgxray: ${error.message}\n`);
      process.exitCode = 1;
    });
  } catch (error) {
    process.stderr.write(`pkgxray: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, parseArgs, promoteVerdict };
