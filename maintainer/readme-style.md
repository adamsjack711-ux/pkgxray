# README style notes

Keep the top-level README to roughly **35–50 lines**: a confident, compact front
door, not a second documentation site. The canonical detailed index is
[docs/README.md](../docs/README.md).

## Shape

1. Lead with the approved static monochrome ASCII hero at
   `../docs/pkgxray-readme-hero.svg`: a rounded dark panel, fixed `@` lettering,
   and a dim character field. Keep it static; no JavaScript, demo GIF, or badge grid.
2. Give one short purpose statement: package/MCP pre-install checks, deterministic
   local analysis, cited evidence, and no AI verdict decisions.
3. Show one published, pinned command that works from a clean directory. State
   Node.js and network requirements without a setup walkthrough.
4. Include one tiny excerpt from a real scan: the verdict and one evidence line,
   with release/date and completed-check scope.
5. State the key limit in one short paragraph; point readers to the threat model.
6. Link to only the canonical docs index, the relevant example/reference, the
   threat model, and essential project pages.

## Accuracy and voice

- Write the product name as **pkg x-ray** in prose; keep the CLI spelling
  `pkgxray` unchanged.
- SAFE is not proof of harmlessness. Distinguish evidence from conclusions and
  report completed, missing, and unrequested checks when giving a result.
- No AI enforcement claims. A verdict does not control what an agent does next.
- Static analysis cannot see runtime-fetched behavior. MCP enumeration can start
  a server; the proxy runs it; the opt-in canary executes package code.
- Keep long command walkthroughs and immutable synthetic-fixture downloads in
  [reference.md](../docs/reference.md), never in the README front door. Fixtures must be
  inert, pinned to an immutable source, and never executed.
- Preserve useful technical evidence in the canonical guides. Keep runtime,
  website, banner assets, and Compose Ray untouched in README-only revisions.
- Ghostty is a structural inspiration only; never reuse its name, artwork, copy,
  or product claims. Keep this project's own ASCII identity and verified facts.

## Verification

Run `npm run test:docs` for local links, the one pinned command, published-CLI
fixture behavior, evidence excerpts, and CLI contracts. It is offline and does
not verify npm publication.

Run `PKGXRAY_DOCS_NETWORK=1 npm run test:docs` to verify the pin against npm and
run the registry and fixture workflow in a fresh directory. This needs npm,
OSV, GitHub, and curl access. Report unavailable network checks accurately.
