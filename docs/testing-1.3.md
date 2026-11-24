# Testing the unpublished 1.3 candidate

The published npm release is **1.2.1**. This checkout prepares **1.3.0**; its
version field does not mean it has been published. The hosted MCP endpoint and
website are deployed separately. Use the local candidate below to test 1.3;
`npx pkgxray@1.2.1` tests the older release, and `npx pkgxray@1.3.0` is not a
candidate installation path before publication.

## Prepare one identifiable build

Use Node.js 18+ (prefer a maintained Node release), npm and tar. Start in the
reviewed candidate checkout supplied by the maintainer. Record its commit and
any local modifications with `git rev-parse HEAD` and `git status --short`.
Avoid changing scanner files while an MCP process is running; restart after a
change. The scanner binds its receipts and cache to its build identity.

These macOS/Linux shell commands pack only the candidate's distribution files
and extract them into a fresh directory. They do not install any target package
or run package lifecycle scripts:

```sh
candidate_test_dir="$(mktemp -d)"
npm pack --ignore-scripts --pack-destination "$candidate_test_dir"
tar -xzf "$candidate_test_dir/pkgxray-1.3.0.tgz" -C "$candidate_test_dir"
node "$candidate_test_dir/package/bin/audit.js" --version
```

The version should be `1.3.0`. Retain the archive and record its SHA-256, for
example with `shasum -a 256 "$candidate_test_dir/pkgxray-1.3.0.tgz"` on macOS
or `sha256sum` on Linux. A tester receiving an archive should compare that hash
with the maintainer's supplied hash before extracting it. A matching hash
identifies the build; it is not an independent security assessment.

## First scan and feedback

From the same shell, run one exact public npm package:

```sh
node "$candidate_test_dir/package/bin/audit.js" guard npm:ms@2.1.3 --format json > "$candidate_test_dir/scan.json"
```

This downloads and inspects source as data and queries external metadata and
vulnerability services; it does not install or execute `ms`. Internet access is
required. Results can change as advisory data changes. Exit `0` means allowed
under the selected policy, `3` means review, and `2` means block. Read the report
even when the command exits nonzero. Neither an allow decision nor popularity
proves a package harmless.

For a review decision, print the checks, review eligibility and the finding
behind each suggested step from the saved CLI report:

```sh
node - "$candidate_test_dir/scan.json" <<'JS'
const fs = require('node:fs');
const scan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
console.log(scan.decision, scan.approval?.checks, { eligible: scan.review?.eligible });
for (const step of scan.reviewPlan?.steps || []) {
  console.log(step.instruction);
  for (const index of step.findingIndices || []) console.log(scan.report.findings[index]);
}
JS
```

For example, the candidate trial of `picocolors@1.1.1` cited finding 0 for a
single-maintainer package. The step asks the reviewer to compare the exact
artifact and manifest with the claimed identity and available provenance. An
eligible review still requires a user decision.

For a 15-minute trial, use one or two exact package versions you know well.
Report:

- Candidate commit, archive SHA-256, `--version`, OS/Node version, command and
  relevant policy overrides.
- Whether setup worked, the decision and completed/missing checks, and a finding
  you could or could not understand or act on.
- A minimal example of a suspected incorrect finding, plus the behaviour you
  expected. Distinguish an incomplete scan from a confirmed malicious finding.

Keep source, credentials and private paths out of public reports. Ordinary setup
issues and benign false positives can use [GitHub issues](https://github.com/adamsjack711-ux/pkgxray/issues).
Send suspected scanner bypasses or live-malware findings through the
[private security channels](../SECURITY.md). Do not execute suspicious package
code to investigate a result.

The maintainer's [bounded package trial](1.3-package-trial.md) records a fixed
convenience sample and its limits. Its results do not replace your own review or
establish a real-world false-positive rate.

## Practice reviewing an exact archive

From the checkout root, use the candidate extracted above and the inert
`native-dep` fixture. Its `postinstall` script only prints a message. The
candidate reads the fixture as source and checks its identity with OSV.

```sh
(
  set -eu
  cli="$candidate_test_dir/package/bin/audit.js"
  trial=$(mktemp -d)
  trap 'rm -rf -- "$trial"' EXIT
  mkdir -p "$trial/home" "$trial/project" "$trial/staging/package/scripts"

  node - benchmark/corpus/benign/install-hook-benign.json "$trial/staging/package" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [fixture, dest] = process.argv.slice(2);
const { sourceFiles } = JSON.parse(fs.readFileSync(fixture, 'utf8')).evidence;
const manifest = JSON.parse(sourceFiles['package.json']);
manifest.version = '1.0.0';
fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify(manifest));
fs.writeFileSync(path.join(dest, 'scripts/rebuild.js'), sourceFiles['scripts/rebuild.js']);
NODE

  cd "$trial/project"
  tar -czf ./native-dep-1.0.0.tgz -C "$trial/staging" package
  sri=$(node -e '
    const fs = require("node:fs");
    const crypto = require("node:crypto");
    const bytes = fs.readFileSync(process.argv[1]);
    console.log("sha512-" + crypto.createHash("sha512").update(bytes).digest("base64"));
  ' ./native-dep-1.0.0.tgz)

  rc=0
  env HOME="$trial/home" XDG_CONFIG_HOME="$trial/home/.config" \
    XDG_CACHE_HOME="$trial/home/.cache" XDG_STATE_HOME="$trial/home/.local/state" \
    node "$cli" guard npm:native-dep@1.0.0 --archive ./native-dep-1.0.0.tgz \
    --integrity "$sri" --format json --receipt-only > review.json || rc=$?
  printf 'Guard exit %s\n' "$rc"
  cat review.json
  printf '\nHook source from the archive\n'
  tar -xOzf ./native-dep-1.0.0.tgz package/scripts/rebuild.js
  printf '\n'
  test "$rc" -eq 3
)
```

With a completed clean advisory check, expect exit `3` and a `pending` review
with `eligible: true`, a review ID, and the `Proceed` and `Decline` actions.
The plan reports `review-required`, bound to the `use` action. The finding
points to the `postinstall` hook in `package.json`. Inspect the hook source
printed by the command, then stop with the review still pending.

If the OSV check cannot complete, exit `3` still holds the archive. Look for
`eligible: false` and a `checks-required` plan with a
`complete-vulnerability-check` blocker. Restore access to OSV and rerun the
exercise to see an eligible review.

## Local MCP candidate

Keep the extracted package in a stable location while testing. Replace both
paths below with absolute paths: the extracted candidate's `package` directory
and only the project directory you intend the MCP host to inspect.

```json
{
  "mcpServers": {
    "pkgxray-candidate": {
      "command": "node",
      "args": ["/absolute/path/to/candidate/package/bin/mcp-server.js"],
      "env": {
        "PKGXRAY_MCP_ALLOWED_ROOTS": "/absolute/path/to/test-project"
      }
    }
  }
}
```

This starts the local candidate, not `https://mcp.pkgxray.ca/mcp`. Guard remains
read-only: it does not promote, install or execute the inspected package. The operator's policy determines ordinary review handling; incomplete
mandatory checks stay held. See the [review contract](review-contract.md).

## Optional features

- **Compose:** bundled in this candidate. Run
  `node "$candidate_test_dir/package/bin/audit.js" compose /absolute/path/to/source-snapshot --entry index.js --json`.
  It needs a prepared npm lockfile and matching local sources; it downloads and
  executes no target code. Combined results remain REVIEW or BLOCK and never
  approve installation. Set `PKGXRAY_COMPOSE=1` in the local MCP environment to
  expose its tool. See [Compose](compose.md) for coverage and input limits.
- **VM execution:** a separate experimental test requiring trusted boot assets,
  QEMU and explicit execution opt-in. It is not part of the static trial above.
  Follow the [VM runbook](../services/local-vm/README.md); guest verification on
  Linux/Windows remains outstanding, and a quiet run never clears a package.

When finished, remove the candidate entry from the MCP host and delete only the
temporary directory/archive you created. These instructions do not change the
global npm installation or the hosted service.
