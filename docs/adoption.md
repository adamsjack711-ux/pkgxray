# Getting pkgxray tested in the wild

A concrete, ordered playbook for putting pkgxray in front of real users and
real packages so it gets exercised, stress-tested, and calibrated against
traffic you can't manufacture. Ordered by leverage — the top items unblock the
ones below them.

## 1. Remove every reason not to try it (distribution)

The tool is only tested if trying it is a single command.

- [ ] **Publish to npm with provenance.** The README already says
      `npm install -g pkgxray`; make that real, and publish with
      `npm publish --provenance` so pkgxray ships an npm/SLSA attestation — a
      security tool that can't prove its own supply chain is a hard sell. Bonus:
      run `pkgxray guard npm:pkgxray@<version>` in release CI so it vets itself.
- [ ] **Lead with `npx`, not install.** Every doc example should have a
      zero-install form: `npx pkgxray guard npm:left-pad@1.3.0`. No global
      install, no commitment — the lowest-friction first contact.
- [ ] **List the MCP server in the public registries.** Submit to the
      [MCP registry](https://github.com/modelcontextprotocol/registry) and the
      directories agents pull from (Smithery, mcp.so, Glama, PulseMCP,
      Cursor's directory). The one-line config is already in the README; the
      registries are where agent users actually discover servers.
- [ ] **Ship a GitHub Action / reusable workflow.** The `recheck` cron snippet
      exists in the README — package it as a marketplace Action
      (`pkgxray/recheck-action@v1`) so adoption is "add one workflow file,"
      not "read the docs and wire it up."
- [ ] **Publish the browser extension** to the Chrome Web Store (currently
      load-unpacked only). Even an unlisted/beta channel lowers the bar from
      "clone the repo" to "click install."

## 2. Meet packages you didn't write (real-world corpus)

Synthetic fixtures prove the engine works; real traffic proves it's calibrated.

- [ ] **Run it against the npm top-N and publish the results.** Guard the top
      1,000 (or 10,000) most-downloaded packages, publish the false-block list
      (should be ~empty) and every `review`. This *is* the "0 false blocks"
      claim at scale — a public, reproducible run is the single most convincing
      artifact you can show, and every genuine false positive it turns up
      becomes a benign benchmark fixture.
- [ ] **Replay known-malicious corpora.** Point it at the documented npm
      malware sets (the OpenSSF malicious-packages repo, published advisories
      for `node-ipc`, `event-stream`, the 2024 xz-style cases) and publish the
      catch rate. Each real sample, reduced to its smallest tripping source,
      becomes a `corpus/malicious/` fixture — the [benchmark](../benchmark/)
      is designed to grow exactly this way.
- [ ] **Dogfood it in this repo's own CI** on every dependency you add, and in
      a couple of your other projects, so it runs against packages you actually
      pull daily.

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

- [ ] **Issue templates for the two reports that matter:** "false block" and
      "missed detection." Ask for the package ref (or minimal source) so a
      maintainer can drop it straight into the benchmark corpus. This closes the
      loop: real-world feedback → a permanent fixture → a CI gate.
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

- [ ] Fill in `SECURITY.md` disclosure contact and response expectations.
- [ ] A 30-second asciinema/GIF of `guard` blocking a real bad package, at the
      top of the README.
- [ ] Reach a tagged `1.0.0` with the [compatibility contract](compatibility.md)
      honored — "it's stable" is a precondition for a security team adopting it.
- [ ] A short comparison ("how this differs from `npm audit`, Socket, Snyk")
      that's honest about scope: local, static, zero-dep, agent-aware — not a
      registry-scale reputation service.

---

**If you do only three things:** publish to npm with provenance (1), run it
against the npm top-N and publish the false-block list (2), and add the
false-block / missed-detection issue templates that feed the benchmark (4).
Those three create the credibility, the proof, and the feedback loop that make
everything else compound.
