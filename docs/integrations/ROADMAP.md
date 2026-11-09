# pkgxray — Integration & Expansion Roadmap

Draft backlog. Two tracks, each ranked **easiest → hardest** by build effort.
Check items off as they ship. Effort estimates assume one focused developer.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done

---

## Track A — Integrate pkgxray into more surfaces

Wire the existing engine into places that gate installs/PRs. No new detection
logic — just new entry points.

- [ ] **1. Own live apps rollout** — *~1 hr each · unblocked today*
      Add the existing `npx` PR-gate workflow (`docs/integrations/github-actions.md`)
      to beanshelf, portfolio-site, Jack-Lalith-Webdev. None are gated.
      _Can ship now — no new code needed._

- [ ] **2. pre-commit.com hook** — *~0.5 day · no deps*
      Publish a `.pre-commit-hooks.yaml` entry so any repo gates on `git commit`.
      High-adoption surface for other devs. Nothing exists yet.

- [ ] **3. GitHub Action (packaged)** — *~1 day · no deps*
      Turn the copy-paste `npx` snippet into a reusable composite Action
      (`pkgxray/audit-action`) that **comments findings inline** on the PR and
      fails the check on HIGH/BLOCK. The raw workflow exists; the packaged
      Action + inline comments do not.

- [ ] **4. Renovate / Dependabot comment bot** — *~1 day · needs #3*
      Post the pkgxray verdict on every dependency-bump PR before merge.

- [ ] **5. s-ide "Supply Chain" panel** — *~1–2 days · separate repo (`~/s-ide`)*
      New tool tab that scans the open repo's lockfile via the pkgxray MCP
      adapter. Reuses the 38-tool framework. Hardest — cross-repo UI work.

---

## Track B — New supply-chain builds (new ecosystems / detectors)

Extend the thesis to new registries and artifact types. Reuses the heuristics
+ calibration method; each needs a new manifest parser + registry client.

- [ ] **1. GitHub Action supply-chain detector** — *~3–5 days · easiest*
      Audit `uses:` lines in workflows for unpinned refs (tags/branches vs SHA)
      and typosquatted action names. Greenfield, adjacent to slopgate/pkgxray.

- [x] **2. PyPI port** ⭐ — *highest leverage · v1 COMPLETE (2026-08-03)*
      Same engine, new ecosystem. Shipped v1 (598 tests, 597 pass, 27 new):
      (a) Python manifest parsers — requirements.txt, poetry.lock, Pipfile.lock,
      pyproject.toml — in `src/lockfile.js`; (b) ecosystem dispatch through the
      OSV/lockfile path (`pkgxray audit <python-manifest>` blocks on real PyPI
      CVEs); (c) `src/pypi.js` registry client (existence/slopsquat check,
      versions, metadata shaped to the npm evidence contract, sdist select,
      sha256→SRI); (d) `pypi:` guard reference + `resolvePyPIPackage` in
      quarantine.js — downloads+extracts the sdist reusing the npm tar path,
      host-pinned to files.pythonhosted.org; (e) `setup.py`/`pyproject.toml`
      install-hook detector in auditor.js (blocks the sdist-dropper shape,
      reviews generic install hooks) + fixed the npm-centric "missing
      package.json" false-positive; (f) README + website updated.
      **v2 backlog:** teach the shared behavioral engine Python primitives
      (`exec`/`marshal`/`__import__` in arbitrary .py, not just setup.py — needs a
      recalibration pass on a Python package pool); wheel (ZIP) source
      inspection; PEP 740 attestation + wheel/sdist/GitHub diff; name-similarity
      typosquat heuristic.

- [ ] **3. crates.io / Go-module port** — *~1–2 weeks*
      Same play, less crowded field. Harder: different manifests + registry APIs.

- [ ] **4. VS Code Marketplace extension audit** — *~1–2 weeks · greenfield*
      Slopsquat problem exists for editor extensions; almost no tooling today.

- [ ] **5. macOS supply-chain-at-runtime (HIDS bridge)** — *~1–2 weeks · hardest*
      Extend the HIDS agent to flag when a newly-installed npm/pip package spawns
      network/exec. Bridges pkgxray (static) → HIDS (runtime). Cross-system.

---

## Suggested build order

The rankings above are by difficulty. A sensible **sequence** (respecting
dependencies and leverage):

1. A1 (apps rollout, today) → A3 (packaged Action) → A4 (Renovate bot)
2. A2 (pre-commit) in parallel — independent
3. B2 (PyPI port) — biggest new-ecosystem win
4. Everything else as time allows
