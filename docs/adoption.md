# Getting pkgxray tested in the wild

A concrete, ordered playbook for putting pkgxray in front of real users and
real packages so it gets exercised, stress-tested, and calibrated against
traffic you can't manufacture. Ordered by leverage — the top items unblock the
ones below them.

Status was reviewed on 2026-07-19. Completed items link to their evidence;
remaining items are proposals, not release commitments. See
[project status](project-status.md) for the supported/experimental boundary.

## 1. Remove every reason not to try it (distribution)

The tool is only tested if trying it is a single command.

- [x] **Publish to npm with provenance.** Releases are live on npm and the
      [release workflow](../.github/workflows/release.yml) gates provenance
      publication on tests, calibration, and a self-guard.
- [x] **Lead with `npx`, not install.** The README quick start uses a
      zero-install form: `npx pkgxray guard npm:left-pad@1.3.0`. No global
      install, no commitment — the lowest-friction first contact.
- [ ] **List the MCP server in the public registries.** Submit to the
      [MCP registry](https://github.com/modelcontextprotocol/registry) and the
      directories agents pull from (Smithery, mcp.so, Glama, PulseMCP,
      Cursor's directory). The one-line config is already in the README; the
      registries are where agent users actually discover servers.
- [x] **Ship a reusable GitHub workflow.** The
      [workflow and direct-`npx` guide](integrations/github-actions.md) cover
      pull requests, scheduled rechecks, manifests, and exact packages. A
      Marketplace/composite action remains deferred until it offers more than
      the zero-dependency CLI.
- [ ] **Publish the browser extension** to the Chrome Web Store (currently
      load-unpacked only). Even an unlisted/beta channel lowers the bar from
      "clone the repo" to "click install."

## 2. Meet packages you didn't write (real-world corpus)

Synthetic fixtures prove the engine works; real traffic proves it's calibrated.

- [x] **Run it against the npm top-N and publish the results.** The
      [2026-07-19 run](https://pkgxray.ca/stats/2026-07-19-retuned) covered the
      top 1,000 most-downloaded packages and published aggregate false-block and
      recall results with reproducibility inputs and scope caveats.
- [x] **Replay known-malicious corpora.** The committed
      [benchmark corpus](../benchmark/) contains reduced malicious and benign
      fixtures and gates recall and false blocks in CI. Continue expanding it
      from responsibly disclosed samples.
- [x] **Dogfood it in this repo's own CI** through the reusable audit and
      release self-guard workflows. Continue using it in other projects on
      packages you actually pull.

## 3. Get in front of the right rooms (audience)

pkgxray sits at the intersection of two active communities; both are reachable.

- [ ] **AI-agent / MCP builders** — the differentiator is "supply-chain
      security *for agents*" (the MCP adapter, the prompt-injection layer, the
      lethal-trifecta framing). Post the MCP-proxy runtime-gate story to the
      MCP community, r/LocalLLaMA, and agent-framework Discords. A short
      "here's an MCP server that rug-pulls its tool descriptions, here's
      pkgxray catching it live" clip travels.
- [ ] **Supply-chain / AppSec** — the differentiator is "static, no-execution,
      evidence-only, zero-dep." That resonates with OpenSSF, the `npm`/registry
      security crowd, and Show HN. Write it up honestly, including the stated
      blind spot (post-install payloads) — the candor is credibility.
- [ ] **One strong writeup, cross-posted.** A single technical post — "detecting
      the delivery, not the wording: how we scan for prompt injection without an
      LLM in the decision path" — anchored to the benchmark numbers, then
      cross-posted (blog, Show HN, dev.to, lobste.rs, the relevant subreddits).

## 4. Make feedback cheap and make it improve the tool (loops)

Every report should have somewhere to land and, ideally, a test it becomes.

- [x] **Issue templates for incorrect verdicts and private bypass reports.**
      The public form handles safe-to-share false positives; suspected missed
      detections, live malware, and bypasses route to private vulnerability
      reporting. It collects the exact package, command, version, verdict, JSON
      output, expected result, and reproduction needed for a regression fixture.
- [ ] **A `--report`/copy-paste evidence bundle.** Let a user turn any verdict
      into a shareable, reproducible `--format json` blob (already exists) with
      a one-line "paste this into a new issue" nudge on `review`/`block`.
- [ ] **Publish the benchmark results in the README** as a badge/table
      (precision / recall / false-block count) generated from
      `node benchmark/run.js --json`, so the calibration story is visible
      without reading code.
- [ ] **A `good first issue` on the corpus.** "Add a benign fixture for
      <popular bundler output>" is a perfect low-risk contribution that
      directly hardens calibration.

## 5. Credibility signals (do these before a big push)

- [x] Fill in `SECURITY.md` disclosure contact and response expectations.
- [x] A 30-second asciinema/GIF of `guard` blocking an inert malicious fixture, at the
      top of the README.
- [x] Reach a tagged `1.0.0` with the [compatibility contract](compatibility.md)
      honored — "it's stable" is a precondition for a security team adopting it.
- [x] A short comparison ("how this differs from `npm audit` and OSV-Scanner")
      that's honest about scope: local, static, zero-dep, agent-aware — not a
      registry-scale reputation service.

---

**Current next priorities:** finish MCP registry readiness without weakening its
local trust boundary, exercise the integration guides against real hosts, and
keep expanding the benign and malicious calibration corpus.
