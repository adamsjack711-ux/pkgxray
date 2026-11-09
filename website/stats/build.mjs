#!/usr/bin/env node
// pkgxray calibration stats — static site generator (Stage 1)
// ----------------------------------------------------------------
// Reads reviewed aggregate artifacts from ./data/<runId>.json and renders
// frozen, versioned pages. NO network. NO live query path to the scan data:
// every number is baked into the HTML at build time from an artifact that a
// human copied across the air gap (see README.md).
//
//   node website/stats/build.mjs
//
// Emits, under website/stats/:
//   <runId>.html        versioned, immutable page   -> /stats/<runId>
//   <runId>.json        the artifact, published alongside the page
//   index.html          the latest run              -> /stats
//   methodology.html    how the numbers were made   -> /stats/methodology
//
// Design: reuse the site's tokens from ../styles.css; stats.css adds the cards.

import { readFileSync, writeFileSync, readdirSync, copyFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "data");

// Read the production origin from stats/site.json so every generated canonical
// and social URL consistently points at the custom domain.
let CANON = "https://pkgxray.ca";
try {
  CANON = JSON.parse(readFileSync(join(HERE, "site.json"), "utf8")).canonicalBase || CANON;
} catch {}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
const commas = (n) => Number(n).toLocaleString("en-US");
const pct = (r, dp = 1) => r == null ? "N/A" : `${(r * 100).toFixed(dp)}%`;
const cohortOf = (run) => run.cohort || run.ecosystem || "npm";
const isValidation = (run) => run.headline.topThousandFalseBlocks.classification === "unadjudicated-heuristic-block-candidates";

function loadRuns(dataDir = DATA) {
  // A run id is a date, optionally with a lowercase suffix for a same-day re-run
  // (e.g. 2026-07-19-retuned). String sort puts the suffixed run after the bare
  // date, so a re-scan sorts as the newer/latest run.
  const files = readdirSync(dataDir).filter((f) => /^\d{4}-\d{2}-\d{2}(?:-[a-z0-9-]+)?\.json$/.test(f));
  const runs = files.map((f) => JSON.parse(readFileSync(join(dataDir, f), "utf8")));
  runs.sort((a, b) => (a.runId < b.runId ? 1 : -1)); // newest first
  return runs;
}

// --- shared chrome ---------------------------------------------------------
function head(title, desc, canonical, methodologyHref = "./methodology.html") {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(desc)}" />
    <meta name="theme-color" content="#17120d" />
    <meta name="robots" content="index, follow" />
    <link rel="canonical" href="${esc(canonical)}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="pkgxray" />
    <meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(desc)}" />
    <meta property="og:url" content="${esc(canonical)}" />
    <meta property="og:image" content="${esc(`${CANON}/assets/og.jpg`)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(title)}" />
    <meta name="twitter:description" content="${esc(desc)}" />
    <meta name="twitter:image" content="${esc(`${CANON}/assets/og.jpg`)}" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=Sora:wght@400;500;600;700&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="../styles.css?v=20261004" />
    <link rel="stylesheet" href="./stats.css?v=cal4" />
    <link rel="icon" href="../assets/favicon.svg" type="image/svg+xml" />
  </head>
  <body>
    <div class="grain" aria-hidden="true"></div>
    <header class="nav is-solid">
      <a class="nav-brand" href="../" aria-label="pkgxray home">
        <span class="nav-mark" aria-hidden="true"></span>
        pkg<span class="xray">xray</span>
      </a>
      <nav class="nav-links" aria-label="Primary">
        <a href="./">Calibration</a>
        <a href="${esc(methodologyHref)}">Methodology</a>
        <a class="nav-github" href="https://github.com/adamsjack711-ux/pkgxray" rel="noopener noreferrer">GitHub</a>
      </nav>
      <span class="nav-progress" aria-hidden="true"></span>
    </header>
    <main id="top">`;
}

function foot(methodologyHref = "./methodology.html") {
  return `    </main>
    <footer class="footer footer-simple">
      <div>
        <span class="footer-brand">pkg<span class="xray">xray</span></span>
        <span class="footer-muted">Inspect what gets installed — not what executes.</span>
      </div>
      <div class="footer-col">
        <h2>Elsewhere</h2>
        <ul>
          <li><a href="../">Home</a></li>
          <li><a href="./">Latest calibration</a></li>
          <li><a href="${esc(methodologyHref)}">Methodology</a></li>
          <li><a href="https://github.com/adamsjack711-ux/pkgxray" rel="noopener noreferrer">GitHub</a></li>
        </ul>
      </div>
    </footer>
  </body>
</html>
`;
}

// --- the calibration page --------------------------------------------------
export function renderStatsPage(run, { isLatest, allRuns }) {
  const h = run.headline;
  const fb = h.topThousandFalseBlocks;
  const cr = h.knownMalwareCatchRate;
  const canonical = `${CANON}/stats/${run.runId}`;
  // Ecosystem-aware chrome. Defaults to npm so every existing run renders
  // byte-for-byte unchanged; a non-npm cohort (e.g. PyPI) gets its own label,
  // its own methodology page, and honest ecosystem-specific prose.
  const eco = cohortOf(run);
  const ecoLabel = run.ecosystemLabel || (eco === "pypi" ? "PyPI" : eco === "mcp" ? "MCP" : "npm");
  const candidates = isValidation(run);
  const methodologyHref = candidates ? `./${run.runId}-methodology.html` :
    eco === "npm" ? "./methodology.html" : `./methodology-${run.runId}.html`;

  const cards = [
    {
      value: commas(h.packagesScanned),
      label: "packages scanned",
      sub: candidates ? `${ecoLabel} cohort, completed static scans` : eco === "pypi"
        ? "published PyPI packages (sdists), one static pass"
        : "published npm packages, one static pass",
    },
    {
      value: pct(fb.rate),
      label: candidates ? "heuristic block candidates" : "false blocks, top 1,000",
      sub: candidates ? `${fb.count} of ${commas(fb.of)} completed scans; requires adjudication` : `${fb.count} of the ${commas(fb.of)} most-downloaded packages`,
    },
    {
      value: pct(cr.rate),
      label: "known-malware catch rate",
      sub: cr.of === 0 ? "Not measured: no malicious fixtures in this cohort" : `${cr.blocked} of ${cr.of} corpus samples blocked outright`,
    },
    {
      value: run.runDate,
      label: "run date",
      sub: `pkgxray ${esc(run.pkgxray.version)} · build ${esc(run.pkgxray.commit)}`,
    },
  ];

  const otherRuns = allRuns.filter((r) => r.runId !== run.runId);
  const historyList = otherRuns.length
    ? `<ul class="run-history">${otherRuns
        .map((r) => `<li><a href="./${r.runId}.html">${r.runId}</a></li>`)
        .join("")}</ul>`
    : `<p class="fineprint">This is the first published run.</p>`;

  const corr = run.corrections || {};
  const log = Array.isArray(corr.log) ? corr.log : [];
  const correctionsBody = log.length
    ? `<ul class="corrections-log">${log
        .map(
          (c) =>
            `<li><strong>${esc(c.date)}</strong> — ${esc(c.what)}${
              c.newRun ? ` (superseded by <a href="./${esc(c.newRun)}.html">${esc(c.newRun)}</a>)` : ""
            }</li>`
        )
        .join("")}</ul>`
    : `<p class="corrections-none">No corrections to date.</p>`;

  // Denominator composition (data-driven; older runs without `scope` fall back to
  // the notes paragraph). Makes the "what is in the number" explicit on the page.
  const sc = run.scope;
  const scopeBlock = sc
    ? `<p class="stats-note"><strong>What the ${commas(sc.denominatorTotal)} counts:</strong> ${sc.denominator
        .map((d) => `${commas(d.count)} ${esc(d.name)}`)
        .join(" + ")}. Counted separately, <em>not</em> in this denominator: ${sc.separateSets
        .map((s) => `${commas(s.count)} ${esc(s.name)}`)
        .join(", ")}.</p>`
    : "";
  const relLine = run.pkgxray.releaseStatus
    ? ` Engine <code>${esc(run.pkgxray.version)}</code> was a ${esc(run.pkgxray.releaseStatus)}; the public npm release at run time was <code>${esc(run.pkgxray.publicReleaseAtRunTime)}</code>.`
    : "";

  return (
    head(
      `pkgxray calibration — ${run.runId}`,
      candidates
        ? `Aggregate calibration of pkgxray: ${commas(h.packagesScanned)} completed ${ecoLabel} scans, ${pct(fb.rate)} heuristic block candidates, ${pct(cr.rate)} fixture catch rate. Run ${run.runId}.`
        : `Aggregate calibration of pkgxray: ${commas(h.packagesScanned)} packages scanned, ${pct(fb.rate)} false blocks on the top 1,000, ${pct(cr.rate)} known-malware catch rate. Run ${run.runId}.`,
      canonical,
      candidates ? methodologyHref : undefined
    ) +
    `
      <section class="section stats-hero">
        <div class="section-inner">
          <p class="section-eyebrow">Calibration${eco === "npm" ? (isLatest ? " · latest run" : " · archived run") : ` · ${esc(ecoLabel)} cohort`}</p>
          <h1 class="stats-title">How well does pkgxray call it?</h1>
          <p class="section-lead">
            ${candidates
              ? "Completed static scans and committed fixture coverage for this cohort. Heuristic block candidates require investigation before a false-positive claim can be made."
              : `An at-scale, code-only static scan of published packages, measured
            against a committed known-malware corpus. Four numbers, adjudicated
            by hand, reproducible from the inputs below.`}
          </p>

          <div class="stat-grid">
            ${cards
              .map(
                (c) => `<div class="stat-card">
              <div class="stat-value">${esc(c.value)}</div>
              <div class="stat-label">${esc(c.label)}</div>
              <div class="stat-sub">${esc(c.sub)} · <a href="./${run.runId}.json">source data</a></div>
            </div>`
              )
              .join("\n            ")}
          </div>

          <p class="stats-links">
            <a href="${methodologyHref}">Methodology &amp; how to reproduce →</a>
            <span class="dot-sep">·</span>
            <a href="./${run.runId}.json">Raw JSON</a>
            <span class="dot-sep">·</span>
            <a href="${esc(run.reproInputs)}" rel="noopener noreferrer">${candidates ? "Cohort target list" : "Top-1000 target list"}</a>
          </p>

          <p class="stats-note">${esc(run.notes || "")}</p>
          ${scopeBlock}
        </div>
      </section>

      <section class="section">
        <div class="section-inner">
          <h2>Corrections</h2>
          <p class="section-lead">
            Published runs are immutable. If a number is wrong we publish a new
            dated run and note it here — we never silently edit a number in place.
            Contest a figure at
            <a href="${esc(corr.contact || "#")}" rel="noopener noreferrer">the tracker</a>.
          </p>
          ${correctionsBody}
        </div>
      </section>

      <section class="section">
        <div class="section-inner">
          <h2>Run history</h2>
          <p class="section-lead">Every published run stays up at a stable URL.</p>
          ${historyList}
          <p class="fineprint">
            Pinned version: this page is the <code>${run.runId}</code> snapshot at
            <code>pkgxray ${esc(run.pkgxray.version)} · ${esc(run.pkgxray.commit)}</code>.${relLine}
            <a href="./">Latest run →</a>
          </p>
        </div>
      </section>
    ` +
    foot(candidates ? methodologyHref : undefined)
  );
}

// --- the methodology page --------------------------------------------------
export function renderMethodology(run, slug = "methodology") {
  if (isValidation(run)) return renderValidationMethodology(run);
  const canonical = `${CANON}/stats/${slug}`;
  const h = run.headline;
  const sc = run.scope;
  const eco = run.ecosystem || "npm";
  const ecoLabel = run.ecosystemLabel || (eco === "pypi" ? "PyPI" : "npm");
  // Data-driven "what was scanned": the denominator packages and, kept explicitly
  // separate, the sets that are NOT part of the denominator (MCP cohort, corpus).
  const scannedList = sc
    ? `<p>
          <strong>${commas(sc.denominatorTotal)} published packages</strong> in one
          static pass, across download-ranked target lists resolved around
          <strong>${esc(run.runDate)}</strong>:
        </p>
        <ul>
          ${sc.denominator
            .map(
              (d) =>
                `<li><strong>${commas(d.count)} — ${esc(d.name)}</strong>: ${esc(
                  d.role
                )}. <a href="${esc(d.source)}" rel="noopener noreferrer">inputs</a></li>`
            )
            .join("\n          ")}
        </ul>
        <p>
          Counted <em>separately</em> and <strong>not</strong> part of the
          ${commas(sc.denominatorTotal)}-package denominator above:
        </p>
        <ul>
          ${sc.separateSets
            .map(
              (s) =>
                `<li><strong>${commas(s.count)} — ${esc(s.name)}</strong>: ${esc(
                  s.role
                )}. <a href="${esc(s.source)}" rel="noopener noreferrer">inputs</a></li>`
            )
            .join("\n          ")}
        </ul>
        <p class="fineprint">${esc(sc.reproNote)}</p>`
    : `<p>
          <strong>${commas(h.packagesScanned)} published packages</strong> in one
          static pass. Resolved target lists (inputs only, no verdicts) are committed
          under <a href="${esc(run.reproInputs)}" rel="noopener noreferrer">validation/</a>.
        </p>`;
  return (
    head(
      "pkgxray calibration — methodology",
      "How the pkgxray calibration numbers are produced: target-list construction, exact version and flags, false-block adjudication, corpus contents, and reproduction inputs.",
      canonical
    ) +
    `
      <section class="section stats-hero">
        <div class="section-inner narrow">
          <p class="section-eyebrow">Calibration · methodology</p>
          <h1 class="stats-title">How the numbers are made</h1>
          <p class="section-lead">
            A calibration claim you cannot reproduce is marketing. Everything
            needed to re-run the ${esc(run.runId)} scan and re-derive the four
            numbers is here.
          </p>
        </div>
      </section>

      <section class="section"><div class="section-inner narrow prose">
        <h2>What was scanned</h2>
        ${scannedList}

        <h2>Exact tool and command</h2>
        <p>
          <code>pkgxray ${esc(run.pkgxray.version)}</code> (build
          <code>${esc(run.pkgxray.commit)}</code>, Node ${esc(run.pkgxray.node)}), one
          invocation per package:
        </p>
        <pre class="code-block"><code>${esc(run.pkgxray.command)}</code></pre>
        ${run.pkgxray.releaseStatus
          ? `<p>
          Engine <code>${esc(run.pkgxray.version)}</code> was a
          ${esc(run.pkgxray.releaseStatus)} — <code>npx pkgxray@${esc(run.pkgxray.version)}</code>
          will not resolve. The public npm release at run time was
          <code>${esc(run.pkgxray.publicReleaseAtRunTime)}</code>. To reproduce on the
          exact engine, check out the commit:
        </p>
        <pre class="code-block"><code>${esc(run.pkgxray.reproCommand || run.pkgxray.command)}</code></pre>`
          : ""}
        <p>
          Static only — the scanner reads the tarball's bytes and queries OSV; the
          static scan never executes package code and never connected to any hosted
          endpoint. Exit codes: <code>0</code> safe, <code>2</code> block,
          <code>3</code> review. A scan that failed to produce a parseable verdict is
          recorded as a <em>scan error</em>, never counted as safe.
        </p>

        <h2>How false blocks were adjudicated</h2>
        <p>
          A block has two very different causes, and they are split before
          anything is called a false positive:
        </p>
        <ul>
          <li>
            <strong>OSV block</strong> — the only high finding is a known CVE.
            Blocking here is by design and is <em>not</em> a false positive.
          </li>
          <li>
            <strong>Heuristic block</strong> — a malware-signal finding (install
            hook, exec, exfil, obfuscation, credential/agent access…). These are
            the reputation-staking calls, and <strong>every one was read by hand.</strong>
          </li>
        </ul>
        ${eco === "pypi"
          ? `<p>
          <strong>Every top-1000 PyPI block was a known CVE or a documented defensible
          true positive</strong>; <strong>zero were heuristic false positives</strong>.
          An earlier build of this engine false-blocked
          <strong>79 of the top-1000 (7.9%)</strong>: the behavioral engine — first
          calibrated for JavaScript — mis-read ordinary Python idioms as attacks (a bulk
          <code>os.environ</code> read as a token-harvest,
          <code>importlib</code> / <code>__import__</code> as a computed require, and a
          syntax lexer's <code>.bashrc</code> filename string as an rc-file write). The fix
          scopes that JS-primitive detector suite to the languages it models: a Python sdist
          is now audited by its <code>setup.py</code> / <code>pyproject</code> install-hooks,
          OSV, and the language-neutral checks (prompt-injection, hidden-unicode), while the
          JS-shaped behavioral detectors no longer run on Python source. Re-running the full
          ${commas(h.topThousandFalseBlocks.of)}-package list on the fixed engine confirms
          <strong>${pct(h.topThousandFalseBlocks.rate)}</strong> =
          ${h.topThousandFalseBlocks.count} / ${commas(h.topThousandFalseBlocks.of)}. Of the
          four blocks in the top-1000, three carry a known-CVE finding (OSV, by design) and
          one is a defensible true positive — a package that ships a live
          <code>.claude/settings.json</code> hooks config, an install-time-equivalent agent
          auto-exec surface.
        </p>`
          : (h.topThousandFalseBlocks.count === 0
          ? `<p>
          <strong>Every top-1000 block was a real CVE</strong> (OSV, by design);
          <strong>zero were heuristic false positives</strong>. The one pre-retune
          heuristic false positive — a ~30-line utility that reads <code>.npmrc</code>
          solely to return the configured registry URL, never touching the auth token,
          with no network egress at all — was minimized into a benign corpus fixture
          and the over-firing heuristic retuned, so on this engine it resolves to
          <code>review</code>. Re-running the full ${commas(h.topThousandFalseBlocks.of)}-package
          list on the fixed engine confirms
          <strong>${pct(h.topThousandFalseBlocks.rate)}</strong> =
          ${h.topThousandFalseBlocks.count} / ${commas(h.topThousandFalseBlocks.of)},
          with no new false block.
        </p>`
          : `<p>
          Of the four blocks in the top-1000, three were real CVEs (OSV, by design)
          and <strong>one was a confirmed heuristic false positive</strong>: a
          ~30-line utility that reads <code>.npmrc</code> solely to return the
          configured registry URL — it never touches the auth token and the package
          has no network egress at all. That single case was minimized into a benign
          corpus fixture and the over-firing heuristic was retuned.
          <strong>${pct(h.topThousandFalseBlocks.rate)}</strong> =
          ${h.topThousandFalseBlocks.count} / ${commas(h.topThousandFalseBlocks.of)}.
        </p>`)}

        <h2 class="coherence">Reconciliation note (read this)</h2>
        ${eco === "pypi"
          ? `<p>
          This is the <strong>first published ${esc(ecoLabel)}-ecosystem run</strong>, so
          there is no prior ${esc(ecoLabel)} figure to reconcile. The 79 → 0 reduction
          described above happened <em>before</em> publication, on the pre-release engine;
          the number on this page is the post-fix re-measurement on the committed
          ${commas(h.packagesScanned)}-package list, not a provisional figure awaiting a
          re-run. The ${esc(ecoLabel)} cohort is reported at its own stable URL and is
          <strong>not</strong> merged into the npm calibration denominator.
        </p>`
          : (h.topThousandFalseBlocks.count === 0
          ? `<p>
          This run is the <strong>re-scan on the retuned engine</strong>. An earlier
          provisional run
          (<a href="./${esc(run.runId.replace(/-retuned$/, ""))}.html">${esc(run.runDate)}</a>,
          kept unedited in run history) published the <em>as-measured</em> pre-retune
          figure of one top-1000 false block, flagged as pending a re-run. It now has
          one: re-running the full ${commas(h.packagesScanned)}-package scan on the
          fixed engine yields <strong>zero</strong> top-1000 false blocks, and the
          earlier run's number was left in place rather than silently edited. This is
          also the scoping correction that reconciled the README's earlier
          "0 false blocks" line: that claim held only on a stale 2019 dependents list;
          the figure here is corpus-gated and scoped to "the top-1000 most-downloaded."
        </p>`
          : `<p>
          The false-block figure is the <em>as-measured</em> number from the
          at-scale scan — the number that <em>motivated</em> the retune. The engine
          has since been fixed so that case no longer blocks, but we have
          <strong>not</strong> re-run the full ${commas(h.packagesScanned)}-package
          scan on the fixed engine, so we do not claim zero. We publish the higher,
          measured number rather than an unmeasured zero. This is the same scoping
          correction that reconciled the README's earlier "0 false blocks" line: that
          claim was true only on a stale 2019 dependents list that never contained
          this package; it is now corpus-gated and scoped to "the top-1000
          most-downloaded."
        </p>`)}

        <h2>Catch rate and the corpus</h2>
        ${eco === "pypi"
          ? `<p>
          Catch rate is measured against a committed, reconstructed ${esc(ecoLabel)}
          sdist-dropper corpus run through the real static engine
          (<code>node benchmark/run.js --cohort pypi</code>):
          <strong>${h.knownMalwareCatchRate.blocked} of
          ${h.knownMalwareCatchRate.of}</strong> malicious samples block outright
          (${pct(h.knownMalwareCatchRate.rate)}), and
          <strong>${h.knownMalwareCatchRate.passedAsSafe} passed as safe</strong>. This is a
          deliberately small, honest denominator — five <code>setup.py</code> install-time
          droppers that decode (base64 / marshal / zlib) or network-fetch a payload and
          <code>exec</code> it during <code>pip install</code> — reported as-is,
          <strong>not</strong> extrapolated to a population claim. CI hard-fails on any false
          block, any full miss, and any recall regression.
        </p>`
          : `<p>
          npm removes confirmed malware, so <strong>live-registry recall is
          untestable</strong> — of 22 curated known-malicious versions, only one is
          still downloadable. Catch rate is therefore measured against a committed,
          reconstructed corpus run through the real static engine
          (<code>node benchmark/run.js</code>):
          <strong>${h.knownMalwareCatchRate.blocked} of
          ${h.knownMalwareCatchRate.of}</strong> malicious samples block outright
          (${pct(h.knownMalwareCatchRate.rate)}), and
          <strong>${h.knownMalwareCatchRate.passedAsSafe} passed as safe</strong> —
          the remainder are routed to <code>review</code> by policy
          (download-then-exec and geo/locale-gated payloads), not missed. CI hard-fails
          on any false block, any full miss, and any recall regression.
        </p>`}

        <h2>Reproduce it</h2>
        <p>
          The committed top-1000 target list (names, versions, and download counts —
          inputs only, no verdicts) is here:
          <a href="${esc(run.reproInputs)}" rel="noopener noreferrer">${esc(run.reproInputs)}</a>.
        </p>
        <p>
          Check out the exact engine and run one invocation per package over the
          top-1000 list to re-derive the verdict distribution and the false-block
          count:
        </p>
        <pre class="code-block"><code>${esc(run.pkgxray.reproCommand || run.pkgxray.command)}</code></pre>
        <p>
          The corpus and benchmark harness live in the repository under
          <code>benchmark/</code> (<code>node benchmark/run.js</code>).
        </p>

        <p class="fineprint">
          Aggregate figures only. This page does not publish per-package verdicts —
          a public "package → verdict" lookup would be a free detection oracle for an
          attacker tuning against the scanner. <a href="./${run.runId}.html">Back to the ${run.runId} run →</a>
        </p>
      </div></section>
    ` +
    foot()
  );
}

// Validation artifacts carry completion accounting and unadjudicated candidates.
// They must not borrow historical claims of manual false-positive adjudication.
function renderValidationMethodology(run) {
  const h = run.headline;
  const fb = h.topThousandFalseBlocks;
  const cr = h.knownMalwareCatchRate;
  return head("pkgxray calibration — methodology", "Cohort inputs, completed scans, and fixture coverage for this validation run.", `${CANON}/stats/${run.runId}-methodology`, `./${run.runId}-methodology.html`) + `
      <section class="section"><div class="section-inner narrow prose">
        <h1>How the numbers are made</h1>
        <p>Run ${esc(run.runId)} measures the <strong>${esc(cohortOf(run))}</strong> cohort.
          Its results are separate from the historical top-1000 npm claim.</p>
        <h2>Completion and denominators</h2>
        <p>${commas(h.packagesScanned)} scans completed out of ${commas(h.packagesAttempted)} attempts;
          ${commas(h.scanErrors)} attempts failed. Errors are excluded from the completed-scan denominator.
          The gate requires at least one completed scan, a result for every target, and at most 10% errors.</p>
        <h2>Heuristic block candidates</h2>
        <p>${fb.count} of ${commas(fb.of)} completed scans (${pct(fb.rate)}) produced a heuristic block
          outside the documented capability exceptions. These are candidates for investigation.
          A false-positive claim requires human adjudication. Known-vulnerability blocks are counted separately.</p>
        <h2>Fixture catch rate</h2>
        <p>${cr.of === 0
          ? "N/A — this cohort has no malicious fixtures, so detection recall has not been measured."
          : `${cr.blocked} of ${cr.of} malicious fixtures blocked (${pct(cr.rate)}); ${cr.passedAsSafe} passed as safe.`}
          Fixture results measure the committed examples; they do not estimate recall across the live registry.</p>
        <h2>Reproduce</h2>
        <p>Engine ${esc(run.pkgxray.version)}, commit ${esc(run.pkgxray.commit)}, Node ${esc(run.pkgxray.node)}.</p>
        <pre class="code-block"><code>${esc(run.pkgxray.command)}</code></pre>
        <p><a href="${esc(run.reproInputs)}" rel="noopener noreferrer">Cohort inputs</a> ·
          <a href="./${esc(run.runId)}.html">Run results</a></p>
      </div></section>
    ` + foot(`./${run.runId}-methodology.html`);
}

// --- main ------------------------------------------------------------------
export function buildStats({ dataDir = DATA, outputDir = HERE } = {}) {
  const runs = loadRuns(dataDir);
  if (!runs.length) throw new Error("no artifacts found under stats/data/*.json");

  // Preserve the adjudicated npm flagship. New validation runs have their own
  // URLs and do not replace historical npm claims, even when newer.
  const isNpm = (r) => cohortOf(r) === "npm";
  const historicalNpm = runs.find((r) => isNpm(r) && !isValidation(r));
  const flagship = historicalNpm || runs.find(isNpm) || runs[0];

  for (const run of runs) {
    const html = renderStatsPage(run, { isLatest: run.runId === flagship.runId, allRuns: runs });
    writeFileSync(join(outputDir, `${run.runId}.html`), html);
    copyFileSync(join(dataDir, `${run.runId}.json`), join(outputDir, `${run.runId}.json`));
    console.log(`  ${run.runId}.html + ${run.runId}.json`);
    // Retain the established historical PyPI URL; new exporter artifacts use
    // /stats/<runId>-methodology, matching their methodologyUrl field.
    if (isValidation(run) || !isNpm(run)) {
      const slug = isValidation(run) ? `${run.runId}-methodology` : `methodology-${run.runId}`;
      writeFileSync(join(outputDir, `${slug}.html`), renderMethodology(run, slug));
      console.log(`  ${slug}.html`);
    }
  }

  writeFileSync(join(outputDir, "index.html"), renderStatsPage(flagship, { isLatest: true, allRuns: runs }));
  writeFileSync(join(outputDir, "methodology.html"), renderMethodology(historicalNpm || flagship));
  console.log(`  index.html + methodology.html -> flagship (${flagship.runId})`);
  console.log(`\ndone — ${runs.length} run(s) rendered.`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) buildStats();
