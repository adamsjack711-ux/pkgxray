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

import { readFileSync, writeFileSync, readdirSync, copyFileSync } from "node:fs";
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
const pct = (r, dp = 1) => `${(r * 100).toFixed(dp)}%`;

function loadRuns() {
  // A run id is a date, optionally with a lowercase suffix for a same-day re-run
  // (e.g. 2026-07-19-retuned). String sort puts the suffixed run after the bare
  // date, so a re-scan sorts as the newer/latest run.
  const files = readdirSync(DATA).filter((f) => /^\d{4}-\d{2}-\d{2}(?:-[a-z0-9-]+)?\.json$/.test(f));
  const runs = files.map((f) => JSON.parse(readFileSync(join(DATA, f), "utf8")));
  runs.sort((a, b) => (a.runId < b.runId ? 1 : -1)); // newest first
  return runs;
}

// --- shared chrome ---------------------------------------------------------
function head(title, desc, canonical) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(desc)}" />
    <meta name="theme-color" content="#1c1510" />
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
    <link rel="stylesheet" href="../styles.css?v=scan8" />
    <link rel="stylesheet" href="./stats.css?v=cal1" />
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
        <a href="./methodology.html">Methodology</a>
        <a class="nav-github" href="https://github.com/adamsjack711-ux/pkgxray" rel="noopener noreferrer">GitHub</a>
      </nav>
    </header>
    <main id="top">`;
}

function foot() {
  return `    </main>
    <footer class="footer">
      <span>pkg<span class="xray">xray</span></span>
      <span class="footer-muted">Inspect what gets installed — not what executes.</span>
    </footer>
  </body>
</html>
`;
}

// --- the calibration page --------------------------------------------------
function renderStatsPage(run, { isLatest, allRuns }) {
  const h = run.headline;
  const fb = h.topThousandFalseBlocks;
  const cr = h.knownMalwareCatchRate;
  const canonical = `${CANON}/stats/${run.runId}`;

  const cards = [
    {
      value: commas(h.packagesScanned),
      label: "packages scanned",
      sub: "published npm + MCP packages, one static pass",
    },
    {
      value: pct(fb.rate),
      label: "false blocks, top 1,000",
      sub: `${fb.count} of the ${commas(fb.of)} most-downloaded packages`,
    },
    {
      value: pct(cr.rate),
      label: "known-malware catch rate",
      sub: `${cr.blocked} of ${cr.of} corpus samples blocked outright`,
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

  return (
    head(
      `pkgxray calibration — ${run.runId}`,
      `Aggregate calibration of pkgxray: ${commas(h.packagesScanned)} packages scanned, ${pct(fb.rate)} false blocks on the top 1,000, ${pct(cr.rate)} known-malware catch rate. Run ${run.runId}.`,
      canonical
    ) +
    `
      <section class="section stats-hero">
        <div class="section-inner">
          <p class="section-eyebrow">Calibration${isLatest ? " · latest run" : " · archived run"}</p>
          <h1 class="stats-title">How well does pkgxray call it?</h1>
          <p class="section-lead">
            An at-scale, code-only static scan of published packages, measured
            against a committed known-malware corpus. Four numbers, adjudicated
            by hand, reproducible from the inputs below.
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
            <a href="./methodology.html">Methodology &amp; how to reproduce →</a>
            <span class="dot-sep">·</span>
            <a href="./${run.runId}.json">Raw JSON</a>
            <span class="dot-sep">·</span>
            <a href="${esc(run.reproInputs)}" rel="noopener noreferrer">Target lists</a>
          </p>

          <p class="stats-note">${esc(run.notes || "")}</p>
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
            <code>pkgxray ${esc(run.pkgxray.version)} · ${esc(run.pkgxray.commit)}</code>.
            <a href="./">Latest run →</a>
          </p>
        </div>
      </section>
    ` +
    foot()
  );
}

// --- the methodology page --------------------------------------------------
function renderMethodology(run) {
  const canonical = `${CANON}/stats/methodology`;
  const h = run.headline;
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
        <p>
          <strong>${commas(h.packagesScanned)} published packages</strong> in one
          static pass, split across three target lists resolved on
          <strong>${esc(run.runDate)}</strong>:
        </p>
        <ul>
          <li>
            <strong>top-1000</strong> (the calibration list, ${commas(h.topThousandFalseBlocks.of)} packages) —
            the anvaka <code>npmrank.json</code> pagerank pool re-ranked by
            <em>real last-week download count</em>
            (<code>api.npmjs.org/downloads/point/last-week</code>), top 1,000 pinned
            to their resolved latest version. This is the list the false-block
            number is measured on.
          </li>
          <li>
            <strong>MCP</strong> (300 packages) — an npm keyword search over
            <code>mcp-server</code>, <code>modelcontextprotocol</code>,
            <code>mcp</code>, capped by relevance then re-ranked by last-week
            downloads. A hunting list, not part of the false-block denominator.
          </li>
          <li>
            <strong>known-malware corpus</strong> — reconstructed from OpenSSF
            malicious-packages and published advisories (see below).
          </li>
        </ul>

        <h2>Exact tool and command</h2>
        <p>
          <code>pkgxray ${esc(run.pkgxray.version)}</code> (build
          <code>${esc(run.pkgxray.commit)}</code>, Node ${esc(run.pkgxray.node)}), one
          invocation per package:
        </p>
        <pre class="code-block"><code>${esc(run.pkgxray.command)}</code></pre>
        <p>
          Static only — pkgxray reads the tarball's bytes and queries OSV; it never
          executes package code and never connected to any hosted endpoint. Exit
          codes: <code>0</code> safe, <code>2</code> block, <code>3</code> review.
          A scan that failed to produce a parseable verdict is recorded as a
          <em>scan error</em>, never counted as safe.
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
        ${h.topThousandFalseBlocks.count === 0
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
        </p>`}

        <h2 class="coherence">Reconciliation note (read this)</h2>
        ${h.topThousandFalseBlocks.count === 0
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
        </p>`}

        <h2>Catch rate and the corpus</h2>
        <p>
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
        </p>

        <h2>Reproduce it</h2>
        <p>
          The resolved target lists (names, versions, and download counts — inputs
          only, no verdicts) are committed here:
        </p>
        <p>
          <a href="${esc(run.reproInputs)}" rel="noopener noreferrer">${esc(run.reproInputs)}</a>
        </p>
        <p>
          Re-run <code>${esc(run.pkgxray.command)}</code> over the top-1000 list and
          you will re-derive the verdict distribution and the false-block count. The
          corpus and benchmark harness live in the repository under
          <code>benchmark/</code>.
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

// --- main ------------------------------------------------------------------
const runs = loadRuns();
if (!runs.length) {
  console.error("no artifacts found under stats/data/*.json");
  process.exit(1);
}

for (const run of runs) {
  const isLatest = run.runId === runs[0].runId;
  const html = renderStatsPage(run, { isLatest, allRuns: runs });
  writeFileSync(join(HERE, `${run.runId}.html`), html);
  // publish the artifact alongside the rendered page
  copyFileSync(join(DATA, `${run.runId}.json`), join(HERE, `${run.runId}.json`));
  console.log(`  ${run.runId}.html + ${run.runId}.json`);
}

// index.html = latest run (canonical still points at the versioned URL)
const latest = runs[0];
writeFileSync(join(HERE, "index.html"), renderStatsPage(latest, { isLatest: true, allRuns: runs }));
console.log(`  index.html            -> latest (${latest.runId})`);

writeFileSync(join(HERE, "methodology.html"), renderMethodology(latest));
console.log(`  methodology.html`);

console.log(`\ndone — ${runs.length} run(s) rendered.`);
