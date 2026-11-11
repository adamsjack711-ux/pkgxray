# pkgxray coordinated launch runbook

Target: the first coordinated public launch after `pkgxray@1.2.1` is published
and verified.

This is the operating document for the launch. The other files in this
directory are source material, not a second checklist. Nothing here authorizes
posting, account access, outreach or Registry publication without Jack's final
review.

## The objective

Get pkgxray used in five repositories outside the maintainer's own projects.
The launch is successful when it produces real use and useful verdict feedback,
not when a post reaches a particular score.

Track these outcomes for 30 days:

- five outside repositories run pkgxray more than once;
- three actionable incorrect-verdict or usability reports;
- one outside contribution or repeat user;
- one maintainer willing to describe where pkgxray did or did not help.

Do not optimize for stars, impressions or a universal security claim.

## The message

One sentence:

> pkgxray inspects npm packages and MCP servers before an AI coding agent
> installs or runs them.

Supporting sentence:

> It runs locally, does not execute package code during a normal scan, and
> returns a fixed-rule `SAFE`, `REVIEW` or `BLOCK` verdict with cited evidence.

The first public demonstration stays narrow: one normal npm package, one inert
reconstructed malicious fixture, and the evidence behind both results. Do not
lead with the complete feature list.

## Claim boundaries

Every launch asset must preserve these boundaries:

- `SAFE` describes the checks that completed. It is not proof that a package is
  harmless.
- Normal `guard` and `audit` scans do not execute package code. MCP enumeration,
  `mcp-proxy` and the opt-in canary have different execution boundaries.
- Static inspection cannot observe a payload that is absent from the inspected
  artifact and downloaded only later.
- Internal and reconstructed fixtures are regression evidence, not a measured
  real-world malware-detection rate.
- Historical top-1,000 results are dated observations with a stated cohort, not
  a registry-wide accuracy claim.
- pkgxray complements `npm audit` and OSV-Scanner. It does not replace them.

## Release gate

Do not schedule the launch until every item is complete:

- [ ] The local audit work has been preserved and ported onto the current
      release branch.
- [ ] Hosted tests are green on macOS, Linux and Windows.
- [ ] The self-audit, calibration, website validation and release verification
      workflows are green.
- [ ] `pkgxray@1.2.1` is published to npm with provenance and the verified
      archive digest matches the reviewed artifact.
- [ ] `package.json`, `server.json`, the README commands and the website all
      name version `1.2.1`.
- [ ] Both quick-start commands below have been run from a clean temporary
      directory against the published package.
- [ ] The 30-second demo has been recorded from a clean terminal and reviewed
      for paths, tokens, usernames and misleading output.
- [ ] Jack has reserved two hours after the Show HN submission to answer
      technical questions.

Published-package smoke test:

```bash
tmpdir="$(mktemp -d)"
cd "$tmpdir"
npx --yes pkgxray@1.2.1 guard npm:express@4.21.0
curl --fail --location --output pkgxray-onboarding.json \
  https://raw.githubusercontent.com/adamsjack711-ux/pkgxray/v1.2.1/examples/onboarding-malicious.json
npx --yes pkgxray@1.2.1 --file ./pkgxray-onboarding.json --format markdown
```

Expected policy outcomes are `SAFE` for the point-in-time Express scan and
`BLOCK` for the inert fixture. Stop if either result differs; investigate and
update the public copy from the actual reviewed output.

## Thirty-second demonstration

Record from the reviewed release checkout after running `docs/demo/setup.sh`.
Use a generic `$` prompt and crop all temporary paths.

```bash
pkgxray guard npm:express@4.21.0
pkgxray guard /tmp/pkgxray-demo/sample-malicious-pkg
rc=$?; printf 'exit code: %s\n' "$rc"
```

Screen sequence:

1. `0–3s` — title: "Inspect packages before they execute."
2. `3–13s` — run the Express scan and hold on its verdict.
3. `13–16s` — label the next input: "INERT RECONSTRUCTED FIXTURE".
4. `16–26s` — run the fixture scan and frame the cited credential-access
   evidence.
5. `26–30s` — frame `exit code: 2` and show `pkgxray.ca`.

Caption or voiceover:

> The first scan is Express. Nothing in this scan hit a high- or medium-risk
> rule. The second package is an inert test case based on a real compromise. It
> reads credential material and tries to send it out, so pkgxray blocks it and
> exits with code two.

End-card small print:

> Static evidence is not proof of safety. The malicious example is an inert,
> reconstructed fixture; no package code is executed.

## Primary launch: Show HN

Post only when Jack can remain in the discussion. Do not ask anyone to vote or
coordinate comments.

Title:

> Show HN: pkgxray – Inspect npm packages before an AI agent installs them

Body:

> I have been working on pkgxray for a while and, honestly, I have spent most of
> that time testing and security-auditing it instead of showing it to anyone.
>
> The problem I wanted to solve is pretty simple: coding agents can install an
> npm package before anyone has looked at what is actually in it. pkgxray
> downloads the package into quarantine, checks it for known vulnerabilities,
> scans the package files and gives you a `SAFE`, `REVIEW` or `BLOCK` result.
> Findings include the file and the evidence that caused them.
>
> ```bash
> npx --yes pkgxray@1.2.1 guard npm:express@4.21.0
> ```
>
> A normal scan does not install or run the package. There is no lifecycle
> script, build step or package import. The verdict also does not come from an
> LLM; it comes from fixed rules, so text in the package cannot talk the scanner
> into approving it.
>
> There is more in the project—lockfile audits, an installer that uses approved
> archives with scripts disabled, and MCP checks—but I do not want to bury the
> basic idea under the feature list.
>
> I also do not want to pretend a static scanner can prove a package is safe.
> `SAFE` means it found no blocking issue in the checks that completed. A clean
> package can still download something malicious later. The benchmarks, threat
> model and the gaps I know about are all public.
>
> Project: https://pkgxray.ca
>
> Source: https://github.com/adamsjack711-ux/pkgxray
>
> What I would really like feedback on is the `REVIEW` result. Does the evidence
> give you enough to make a decision, or does it just leave you with more work?

First comment:

> Some details that will probably come up:
>
> - It is MIT licensed. The normal scanner has no installed runtime
>   dependencies; the JavaScript parser is bundled and pinned.
> - OSV handles known-vulnerability checks. The package scan uses lexical and
>   parser-based flow rules over the staged files.
> - Approvals are tied to the exact archive, package version, scanner build,
>   policy and checks that completed. They are not a general approval of that
>   package name forever.
> - `REVIEW` does not mean I think a package is malicious. It means the scanner
>   found something privileged or could not finish enough analysis to clear it.
> - Canary is the one mode that deliberately runs untrusted code. It is opt-in,
>   requires OS confinement and can confirm bad behavior, but a quiet run never
>   clears a package.
>
> The dated results and reproduction notes are at https://pkgxray.ca/stats.

## Direct tester invitation

Send this individually to maintainers who use Node and coding agents. Change
the first line to say why that particular person or repository is relevant. Do
not send it as a bulk message.

Subject:

> Would you test a pre-install package gate on one repository?

Message:

> Hi {{name}} — I have been working on an open-source tool called pkgxray. It
> checks npm packages before a coding agent installs them.
>
> I am trying to get it out of my own test environment and into a few real
> projects. Would you be willing to run it against one repository and tell me
> where the result is confusing or unhelpful?
>
> ```bash
> npx --yes pkgxray@1.2.1 audit package-lock.json
> ```
>
> I am not looking for a post or endorsement. A bad `REVIEW` or `BLOCK` result
> is useful feedback because I can turn it into a regression test. I am also
> happy to look at the first report with you, and there is no need to share
> private code.
>
> Source and threat model: https://github.com/adamsjack711-ux/pkgxray
>
> Thanks,
> Jack

## MCP Registry publication

The Registry entry is a distribution step, not a social announcement. Perform
it from the reviewed `v1.2.1` checkout only after npm publication.

```bash
npm view pkgxray@1.2.1 version mcpName --json
npx --yes --package pkgxray@1.2.1 pkgxray --version
brew install mcp-publisher
mcp-publisher login github
mcp-publisher publish
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.adamsjack711-ux/pkgxray"
```

Confirm that the entry is `io.github.adamsjack711-ux/pkgxray`, names version
`1.2.1`, identifies npm package `pkgxray`, and launches `pkgxray mcp-server`.
Never paste the device code or saved Registry token into chat, issues, CI logs
or source control.

## Follow-up posts

Stagger these so Jack can respond to each discussion. Do not paste identical
copy everywhere.

### MCP community

> I have been working on pkgxray, a package scanner that also checks MCP
> servers. One thing I kept running into is that MCP security starts before
> `tools/list`—the server package is already part of the trust boundary.
>
> pkgxray can scan the package before connection, check the declared tool
> surface, pin the version you reviewed and gate live stdio calls and results.
>
> ```bash
> npx --yes pkgxray@1.2.1 guard npm:some-mcp-server@1.4.2
> pkgxray mcp --package npm:some-mcp-server@1.4.2 npx some-mcp-server
> ```
>
> The first command is static. The second one eventually has to start the server
> to list its tools, and I have tried to be very clear about that boundary in
> the docs.
>
> If you maintain an MCP server, I would be interested in cases where pkgxray
> gives you an unhelpful `REVIEW`, especially around environment variables,
> subprocesses and tool schemas.
>
> https://github.com/adamsjack711-ux/pkgxray

### Short social post

> I have spent the last few months testing and security-auditing pkgxray, and I
> kept putting off showing it to people.
>
> It checks npm packages and MCP servers before a coding agent installs or runs
> them. A normal scan does not execute the package, and every result includes
> the evidence behind it.
>
> Try it:
>
> `npx --yes pkgxray@1.2.1 guard npm:express@4.21.0`
>
> https://pkgxray.ca

### Node community

> I have been building a local npm package scanner called pkgxray. The basic
> idea is to look at the tarball before installation, rather than after its
> lifecycle scripts have already had a chance to run.
>
> `npx --yes pkgxray@1.2.1 guard npm:express@4.21.0`
>
> pkgxray checks OSV, stages the tarball in quarantine and reports `SAFE`,
> `REVIEW` or `BLOCK` with the files that caused the result. It is meant to run
> alongside `npm audit`, not replace it. The normal scan does not execute the
> package.
>
> I have tested it heavily, but what I need now is feedback from real projects.
> Legitimate packages that get an unhelpful `REVIEW` or `BLOCK` are especially
> useful.
>
> https://github.com/adamsjack711-ux/pkgxray

Check each community's current self-promotion rules immediately before posting.

## Notes for answering questions

### How is this different from `npm audit`?

`npm audit` and OSV answer whether a dependency matches a known advisory.
pkgxray uses OSV too, then inspects the exact package artifact for behavior and
coverage evidence before installation. They should be used together.

### Does `SAFE` mean the package is safe?

No. It means no blocking finding was identified within the checks and source
coverage reported for that scan. Later downloads, native behavior, dormant
logic and other unobserved paths remain possible.

### Does scanning execute package code?

Normal `guard` and `audit` scans do not. MCP tool enumeration and proxying must
run the server they inspect. Canary deliberately executes untrusted code and is
opt-in, fail-closed and confined by the operating system.

### Why fixed rules instead of an LLM?

The package being inspected is untrusted input. Fixed rules keep the verdict
path reproducible and prevent package text from instructing the decision engine
to approve it.

### What should I report?

The exact package and version, command, pkgxray version, JSON output and the
decision you expected. Do not publish secrets, private source or active malware.

## Seven-day sequence

### Before Day 0

- Finish the release gate.
- Ask three people for a private test; fix only launch-blocking problems.
- Record and review the demo.
- Prepare the Show HN submission in plain text.

### Day 0

- Publish Show HN while Jack is available for two hours.
- Add the first comment.
- Answer questions directly; record repeated questions without arguing.

### Day 1

- Publish and verify the MCP Registry entry.
- Send five individual tester invitations.

### Day 2

- Post the MCP-specific version in one relevant community whose current rules
  permit it.
- Turn concrete launch confusion into documentation fixes.

### Day 3

- Post the short personal version from Jack's normal social account.
- Send the remaining individual tester invitations.

### Day 5

- Post the Node-specific version where current community rules allow it.
- Publish a short follow-up listing what users found, including problems.

### Day 7

- Review the outcome metrics.
- Choose the next engineering work from observed adoption friction and verdict
  reports, not from the old feature backlog.

## Stop conditions

Pause the launch if release verification fails, the demo differs materially
from the copy, a new security issue is discovered, or current documentation
overstates an execution/provenance boundary. Fix the evidence first; do not
explain around it in public.
