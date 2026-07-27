const DEMOS = {
  express: {
    cmd: "pkgxray guard npm:express@4.21.0",
    lines: [
      { t: 0, html: `<span class="cmd">$ pkgxray guard npm:express@4.21.0</span>` },
      { t: 900, html: `<span class="muted">Fetching tarball… quarantining…</span>` },
      { t: 2200, html: `<span class="muted">npm ↔ GitHub cross-check… 15/16 files match @4.21.0</span>` },
      { t: 3200, html: `` },
      { t: 3600, html: `Decision: <span class="safe">SAFE</span>` },
      { t: 4200, html: `Verdict: <span class="safe">SAFE</span>` },
      { t: 4800, html: `Grade: <span class="safe">A+</span> (99/100)` },
      { t: 5400, html: `` },
      {
        t: 5900,
        html: `<span class="muted">No high- or medium-risk indicators were found.</span>`,
      },
      {
        t: 7000,
        html: `<span class="muted">INFO npm-vs-github-clean — tarball matches linked repo</span>`,
      },
    ],
    panel: {
      kind: "safe",
      pill: "● SAFE",
      grade: "A+ · 99/100",
      summary:
        "No high- or medium-risk indicators. Default policy promotes out of quarantine.",
      findings: [],
    },
  },
  trojan: {
    cmd: "pkgxray guard ./sample-malicious-pkg",
    lines: [
      {
        t: 0,
        html: `<span class="cmd">$ pkgxray guard ./sample-malicious-pkg</span>`,
      },
      { t: 900, html: `<span class="muted">Staging quarantine… static analysis…</span>` },
      { t: 2200, html: `` },
      { t: 2800, html: `Decision: <span class="block">BLOCK</span>` },
      { t: 3400, html: `Verdict: <span class="block">BLOCK</span>` },
      { t: 4000, html: `Grade: <span class="block">F</span> (12/100)` },
      { t: 4600, html: `` },
      {
        t: 5200,
        html: `<span class="block">HIGH</span> credential-access — wallet-read + exfiltration`,
      },
      {
        t: 6400,
        html: `<span class="muted">  lib/index.js:42  reading ~/.config/solana/id.json</span>`,
      },
      {
        t: 7600,
        html: `<span class="muted">  lib/index.js:58  POST to external sink</span>`,
      },
    ],
    panel: {
      kind: "block",
      pill: "● BLOCK",
      grade: "F · 12/100",
      summary:
        "High-severity cited evidence. Do not install. Modeled on the 2024 @solana/web3.js compromise.",
      findings: [
        {
          title: "HIGH credential-access",
          body: "lib/index.js — wallet-read + network exfiltration",
        },
      ],
    },
  },
  review: {
    cmd: "pkgxray guard npm:example-with-scripts@1.0.0",
    lines: [
      {
        t: 0,
        html: `<span class="cmd">$ pkgxray guard npm:example-with-scripts@1.0.0</span>`,
      },
      { t: 900, html: `<span class="muted">Quarantine… analyzing lifecycle scripts…</span>` },
      { t: 2200, html: `` },
      { t: 2800, html: `Decision: <span class="review">REVIEW</span>` },
      { t: 3400, html: `Verdict: <span class="review">REVIEW</span>` },
      { t: 4000, html: `Grade: <span class="review">C</span> (61/100)` },
      { t: 4600, html: `` },
      {
        t: 5200,
        html: `<span class="review">MEDIUM</span> install-script — postinstall needs a human`,
      },
      {
        t: 6400,
        html: `<span class="muted">Inspect the quarantined copy before promoting.</span>`,
      },
    ],
    panel: {
      kind: "review",
      pill: "● REVIEW",
      grade: "C · 61/100",
      summary:
        "Privileged capability that needs a human — install scripts, computed eval, or incomplete evidence.",
      findings: [
        {
          title: "MEDIUM install-script",
          body: "package.json postinstall — review before promote",
        },
      ],
    },
  },
};

const VERDICT_COPY = {
  safe: "No high- or medium-risk indicators. Default policy promotes out of quarantine. Install. Exit code 0.",
  review:
    "Incomplete evidence, or a privileged capability that needs a human — install scripts, computed eval, npm↔GitHub divergence. Inspect the quarantined copy. Exit code 3.",
  block:
    "High-severity, cited evidence — prompt injection, credential access, persistence, obfuscation + execution, or a known CVE. Do not install. Exit code 2.",
};

const WHY_PANELS = {
  scale: {
    value: 7.97,
    decimals: 2,
    unit: "trillion",
    label: "npm package downloads in 2025",
    danger: false,
    copy:
      "That’s ~21.8 billion downloads every day — over 80% of all traffic across npm, PyPI, Maven Central, and NuGet combined. The registry holds 5.59 million packages and shipped 11.18 million new releases last year.",
    note: "Sonatype 2026 State of the Software Supply Chain. npm downloads up 65% year over year.",
    source: {
      label: "Sonatype: software infrastructure growth",
      url: "https://www.sonatype.com/state-of-the-software-supply-chain/2026/software-infrastructure-growth",
    },
  },
  malware: {
    value: 454600,
    decimals: 0,
    unit: "",
    prefix: "≈",
    label: "new malicious open-source packages identified in 2025",
    danger: true,
    copy:
      "Sonatype identified 394,877 malicious packages in Q4 2025 alone; over 99% of 2025’s open-source malware originated from npm. The count includes repository abuse and potentially unwanted applications as well as credential theft, loaders, and backdoors.",
    note:
      "Sonatype’s public figure is “more than 454,600” new malicious packages in 2025 across npm, PyPI, Maven Central, NuGet and Hugging Face — a count of what Sonatype detected, not an estimate of the chance any downloaded package is malicious. Automated npm spam campaigns inflate the tail and the npm share.",
    source: {
      label: "Sonatype: 2026 State of the Software Supply Chain — open-source malware",
      url: "https://www.sonatype.com/state-of-the-software-supply-chain/2026/open-source-malware",
    },
  },
  blast: {
    value: 2.6,
    decimals: 1,
    unit: "billion",
    label: "combined weekly downloads — chalk/debug, Sept 2025",
    danger: true,
    copy:
      "Eighteen packages compromised in one maintainer-account incident. A freshly trojaned package often has no CVE yet — which is exactly the gap pkgxray is built for.",
    note: "The 2.6 billion figure is combined weekly downloads, not confirmed affected installs.",
    source: {
      label: "Palo Alto Networks: September 2025 incident analysis",
      url: "https://www.paloaltonetworks.com/blog/cloud-security/npm-supply-chain-attack/",
    },
  },
  mcp: {
    value: 20,
    decimals: 0,
    unit: "%",
    label: "of ClawHub skills found malicious",
    danger: true,
    copy:
      "This figure is about malicious ClawHub skills, not MCP servers. Separately, an MCP security review found only 8.5% of servers use OAuth, 53% rely on long-lived static secrets, and 15.4% of official-registry entries have no source repository.",
    note: "The cited report distinguishes malicious marketplace listings, weak authentication, opaque servers, and known vulnerabilities.",
    source: {
      label: "NimbleBrain: State of MCP Security 2026",
      url: "https://nimblebrain.ai/blog/state-of-mcp-security-2026/",
    },
  },
};

function formatWhyValue(value, panel) {
  if (panel.format === "compact" && value >= 1000) {
    if (value >= 1000000) return (value / 1000000).toFixed(2);
    return Math.round(value / 1000).toLocaleString("en-US") + "k";
  }
  if (panel.decimals > 0) return value.toFixed(panel.decimals);
  return Math.round(value).toLocaleString("en-US");
}

function animateWhyValue(el, panel) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const target = panel.value;
  if (reduce) {
    el.textContent = formatWhyValue(target, panel);
    return;
  }

  const duration = 900;
  const start = performance.now();
  const from = 0;

  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const current = from + (target - from) * eased;
    el.textContent = formatWhyValue(current, panel);
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function renderWhyPanel(key) {
  const panelEl = document.querySelector("[data-why-panel]");
  const panel = WHY_PANELS[key];
  if (!panelEl || !panel) return;

  const unitHtml = panel.unit
    ? `<span class="unit">${panel.unit}</span>`
    : "";
  const prefixHtml = panel.prefix
    ? `<span class="why-prefix">${panel.prefix}</span>`
    : "";
  const noteHtml = panel.note
    ? `<p class="why-note">${panel.note}</p>`
    : "";
  const sourceHtml = panel.source
    ? `<p class="why-note"><a href="${panel.source.url}" rel="noopener noreferrer">Source: ${panel.source.label}</a></p>`
    : "";

  panelEl.innerHTML = `
    <p class="why-stat${panel.danger ? " is-danger" : ""}">${prefixHtml}<span data-why-value>0</span>${unitHtml}</p>
    <p class="why-label">${panel.label}</p>
    <p class="why-copy">${panel.copy}</p>
    ${noteHtml}
    ${sourceHtml}
  `;

  const valueEl = panelEl.querySelector("[data-why-value]");
  if (valueEl) animateWhyValue(valueEl, panel);
}

function initWhyBoard() {
  const board = document.querySelector("[data-why-board]");
  if (!board) return;

  const tabs = [...board.querySelectorAll("[data-why]")];

  const activate = (key) => {
    tabs.forEach((tab) => {
      const on = tab.dataset.why === key;
      tab.classList.toggle("is-active", on);
      tab.setAttribute("aria-selected", on ? "true" : "false");
    });
    renderWhyPanel(key);
  };

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => activate(tab.dataset.why));
  });

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          activate("scale");
          io.disconnect();
          break;
        }
      }
    },
    { threshold: 0.3 }
  );
  io.observe(board);
}

function initCopyButtons() {
  document.querySelectorAll("[data-copy]").forEach((el) => {
    el.addEventListener("click", async () => {
      const text = el.getAttribute("data-copy") || "";
      const label = el.querySelector("[data-copy-label]");
      try {
        await navigator.clipboard.writeText(text);
        if (label) {
          const prev = label.textContent;
          label.textContent = "Copied";
          window.setTimeout(() => {
            label.textContent = prev;
          }, 1400);
        }
      } catch {
        if (label) label.textContent = "Failed";
      }
    });
  });
}

function initNavSolid() {
  const nav = document.querySelector(".nav");
  if (!nav) return;
  const onScroll = () => {
    nav.classList.toggle("is-solid", window.scrollY > 12);
  };
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
}

function initHeroBeam() {
  // Beam is CSS-driven (.beam-scanner). Kept as a no-op so older caches
  // that still call this don't throw.
}

function initScanDemo() {
  const root = document.querySelector("[data-scan-demo]");
  if (!root) return;

  const body = root.querySelector("[data-term-body]");
  const panel = root.querySelector("[data-verdict-panel]");
  const pill = root.querySelector("[data-verdict-pill]");
  const grade = root.querySelector("[data-verdict-grade]");
  const summary = root.querySelector("[data-verdict-summary]");
  const findings = root.querySelector("[data-findings]");
  const picks = [...root.querySelectorAll("[data-demo]")];

  let timers = [];

  const clearTimers = () => {
    timers.forEach((id) => window.clearTimeout(id));
    timers = [];
  };

  const showPanel = (data) => {
    if (!panel || !pill || !grade || !summary || !findings) return;
    panel.hidden = false;
    pill.textContent = data.pill;
    pill.dataset.kind = data.kind;
    grade.textContent = data.grade;
    summary.textContent = data.summary;
    findings.innerHTML = "";
    for (const f of data.findings) {
      const li = document.createElement("li");
      li.innerHTML = `<strong>${f.title}</strong>${f.body}`;
      findings.appendChild(li);
    }
  };

  const run = (key) => {
    const demo = DEMOS[key];
    if (!demo || !body) return;
    clearTimers();
    body.textContent = "";
    if (panel) panel.hidden = true;

    const parts = [];
    for (const line of demo.lines) {
      const id = window.setTimeout(() => {
        parts.push(line.html);
        body.innerHTML = parts.join("\n");
      }, line.t);
      timers.push(id);
    }

    const doneAt = demo.lines[demo.lines.length - 1].t + 200;
    timers.push(
      window.setTimeout(() => {
        showPanel(demo.panel);
      }, doneAt)
    );
  };

  picks.forEach((btn) => {
    btn.addEventListener("click", () => {
      picks.forEach((b) => {
        b.classList.toggle("is-active", b === btn);
        b.setAttribute("aria-selected", b === btn ? "true" : "false");
      });
      run(btn.dataset.demo);
    });
  });

  // Auto-run when section enters view
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          run("express");
          io.disconnect();
          break;
        }
      }
    },
    { threshold: 0.35 }
  );
  io.observe(root);
}

function initVerdictBoard() {
  const board = document.querySelector("[data-verdict-board]");
  const detail = document.querySelector("[data-verdict-detail]");
  if (!board || !detail) return;

  const cards = [...board.querySelectorAll("[data-v]")];
  cards.forEach((card) => {
    card.addEventListener("click", () => {
      cards.forEach((c) => c.classList.toggle("is-active", c === card));
      const key = card.dataset.v;
      detail.innerHTML = `<p>${VERDICT_COPY[key]}</p>`;
    });
  });
}

function initFlowSteps() {
  const steps = [...document.querySelectorAll("[data-flow] [data-step]")];
  if (!steps.length) return;

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    steps.forEach((s) => s.classList.add("is-lit"));
    return;
  }

  let i = 0;
  window.setInterval(() => {
    steps.forEach((s, idx) => s.classList.toggle("is-lit", idx === i));
    i = (i + 1) % steps.length;
  }, 2200);

  steps.forEach((step, idx) => {
    step.addEventListener("mouseenter", () => {
      steps.forEach((s, j) => s.classList.toggle("is-lit", j === idx));
      i = idx;
    });
  });
}

initCopyButtons();
initNavSolid();
initHeroBeam();
initWhyBoard();
initScanDemo();
initVerdictBoard();
initFlowSteps();
