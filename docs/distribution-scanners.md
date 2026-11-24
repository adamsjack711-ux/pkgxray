# Executable distribution scanners (experimental)

`scan-distribution` performs a bounded static scan of an extracted directory,
a local ZIP/TAR-family archive, a digest-bound HTTPS archive, or an exact-version
Open VSX / VS Code Marketplace extension. It does not install or execute the target.

```bash
pkgxray scan-distribution ./extension.vsix --format json
pkgxray scan-distribution openvsx:redhat.java@1.30.0 --target-platform universal
pkgxray scan-distribution vscode:esbenp.prettier-vscode@10.2.0 \
  --target-platform linux-x64 --sha256 <64-hex-digest>
pkgxray scan-distribution ./plugin --type jetbrains
pkgxray scan-distribution https://downloads.example/plugin.zip \
  --allow-host downloads.example --sha256 <64-hex-digest>
pkgxray scan-distribution ./agent.zip --recursive --acquire-packages
pkgxray scan-distribution ./release.tar.gz \
  --sigstore-bundle ./release.sigstore.json \
  --sigstore-subject release.tar.gz \
  --certificate-identity https://github.com/example/project/.github/workflows/release.yml@refs/tags/v1 \
  --certificate-issuer https://token.actions.githubusercontent.com
```

Remote acquisition requires credential-free HTTPS, an explicit host allowlist,
and either `--sha256` or `--integrity`. The policy is applied again after every
redirect and rejects private or local destinations. Downloads are time- and
size-bounded and remain temporary. Exact registry references use the forms
`openvsx:publisher.name@version` and `vscode:publisher.name@version`; aliases
such as `latest` are rejected, the hosts and redirect domains are built in,
and the extracted manifest must exactly match the requested identity and version.
When `--sha256` is omitted, registry acquisition is explicitly recorded as
`transport-only` / `partial`: the resulting receipt binds the bytes that arrived,
but it does not claim they matched a publisher-authenticated digest. A supplied
digest upgrades that acquisition check to completed. `--type` accepts `auto` (the default), `all`,
`ci`, `gitlab`, `jenkins`, `agent`, `vsix`, `jetbrains`, `browser`, or
`infrastructure`. Exit codes are `0` for safe, `2` for block, and `3` for
review.

Marketplace responses that use HTTP gzip content encoding are decoded before
artifact hashing and extraction. Both the transfer and decoded VSIX remain
bounded, and the receipt records the transfer encoding and byte count.

## Archive and artifact boundary

The built-in extractor supports ZIP, VSIX, XPI, CRX2/CRX3, raw TAR, and
gzip-compressed TAR containers. ZIP uses stored or deflated entries. It validates central/local record agreement, CRCs,
data descriptors, entry and aggregate sizes, compression ratios, and extraction
paths before a transactional extraction. It rejects encryption, ZIP64,
multi-disk archives, links and special files, traversal and absolute paths,
ambiguous encodings, duplicates and case collisions, overlapping records, and
unsupported compression methods. Default limits are 64 MiB compressed input,
256 MiB expanded content, 64 MiB per entry, 20,000 entries, and a 200:1 ratio.
TAR extraction independently validates checksums, termination, paths, entry
types, duplicates, case collisions, parents, expanded bytes, and gzip ratio.
Bounded POSIX PAX path/size records and GNU long names are supported; links,
devices, sparse fields, long-link records, conflicting overrides, and unsafe or
oversized extended metadata are rejected. Ownership, mode, xattr, and timestamp
metadata are never applied to extracted files.

An archive result includes its exact SHA-256 and a receipt binding the artifact,
scanner build, evidence, policy, check states, and provenance result. A receipt
explicitly does **not** authorize installation. CRX2 and CRX3 signatures and
extension identity are cryptographically verified. Any archive can additionally
carry an operator-supplied Sigstore SLSA bundle. Verification requires exact
SHA-256 artifact and optional subject binding plus operator-pinned certificate
identity and issuer; PKI, transparency-log, and TUF verification run through the
maintained Sigstore SDK shipped with the trusted npm runtime. Bundle claims never
choose their own trust policy, and external provenance cannot override a failed
embedded signature. VSIX OPC, XPI CMS/COSE, and JAR signature material is
detected but currently reported as unverified, never as valid format-native
provenance. Unsigned or unsupported provenance keeps an otherwise-safe archive
at review; a supported signature that fails verification blocks.

## Scanner coverage

| Family | What is inspected |
|---|---|
| GitHub Actions | Workflow YAML, reusable workflows, repository composite actions, nested local `uses:` references, full commit pins, and container digest pins. |
| GitLab CI | Local include recursion plus remote, project, component, and template includes; images, services, dynamic references, cycles, and path escapes. |
| Jenkins | Jenkinsfiles, shared libraries, plugins, tools, container images, shell launch surfaces, credentials, and `@Grab` dependencies. |
| VSIX and browser extensions | Exact-version VS Code Marketplace/Open VSX acquisition plus VSIX payloads and Chrome/Firefox manifests: registry-coordinate binding, activation, executable entrypoints, install hooks, permissions, background/content code, native messaging, and update/external channels. |
| JetBrains plugins | Extracted `META-INF/plugin.xml` metadata, dependencies, build constraints, services, actions, listeners, implementation classes, permissions, and resource-path escapes. |
| Terraform/OpenTofu and Helm | Provider/module sources and lock hashes, chart dependencies, and statically resolvable image tags or digests. |
| OCI and Linux packages | OCI-layout manifest/config/layer inventory; exact-digest local or anonymous-registry image recursion; verified raw/gzip layers and diff IDs; DEB, RPM, and APK lifecycle scripts when their metadata is already extracted. |
| Desktop distribution | Homebrew formulae/casks, macOS PKG scripts and opaque DMGs, MSI/MSIX metadata, AppImage entrypoints, Flatpak manifests, and Snap launch/service commands. |
| Agent packages | MCP and plugin descriptors, skills, npm lifecycle hooks, launch commands, package references, tools/capabilities, and requested environment or permission grants. |

Declared concrete JavaScript and TypeScript entrypoints from extension, browser,
and agent descriptors are passed to pkgxray's existing source auditor. Nested
literal imports discovered by that auditor are included. VSIX `main` and
`browser` paths also receive bounded Node-style `.js`/`.cjs`/`.mjs`/TypeScript
and directory-index resolution so extensionless declarations reach the auditor.
Missing, escaping,
command-only, byte-limited, or otherwise unresolved entrypoints remain explicit
coverage gaps and cannot produce a safe result.

## Recursive dispatch

Recursive scanning is opt-in with `--recursive`. Components are deduplicated by
stable identity and traversed with depth, count, aggregate-byte, and deadline
budgets; cycles and missing resolvers remain visible. Metadata such as browser
permissions is deliberately excluded from dependency dispatch.

`--acquire-packages` additionally routes exact npm and PyPI references and
full-commit GitHub Action references through pkgxray's existing package guard.
It also resolves exact-digest OCI images from the current OCI layout or an
anonymous registry named in `--allow-host`, verifies manifest/config/layer
digests and config diff IDs, safely extracts raw or gzip tar layers, and sends
the resulting package-script descriptors through the infrastructure scanner.
Immutable HTTPS archive components carrying a SHA-256 digest are reacquired and
scanned through the same archive pipeline. Resolvers can be supplied to the
library API for other component kinds.

## Remaining gaps

- OCI authentication, manifest lists/indexes, implicit Docker Hub names,
  whiteout-bearing images, zstd/foreign layers, and binary DEB/RPM/APK archive
  unpacking are not supported. Anonymous exact-digest images and already
  extracted package lifecycle descriptors are supported.
- Firefox Add-ons, Chrome Web Store, JetBrains Marketplace, Terraform/Helm
  registries, and Jenkins update centers do not yet have store ID clients. Scan
  an exact local or digest-bound HTTPS artifact instead. Open VSX and the VS Code
  Marketplace support exact-version IDs; automatic latest-version selection is
  deliberately unsupported.
- Bzip2/xz/zstd TAR, GNU sparse/link-bearing TAR, JAR-as-a-container,
  DEB/RPM/APK payloads, DMG/PKG,
  MSI/MSIX, AppImage, Flatpak, and Snap extraction are not implemented by this
  command. Their analyzers consume already-extracted metadata.
- VSIX, XPI, JAR, OCI/cosign discovery, Linux package signatures, and platform
  installer signatures are not verified in their native formats. A supplied
  Sigstore SLSA bundle is supported when its identity and issuer are pinned.
- JetBrains JAR bytecode/classes and Jenkins plugin binaries are inventoried by
  descriptor only; their executable bodies are not decompiled or source-audited.

JSON uses `schemaVersion: 1`. This surface remains Experimental, so
family-specific fields may change before it graduates.
