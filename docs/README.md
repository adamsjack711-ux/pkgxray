# Documentation

Start with the [project overview and quick start](../README.md).

| Guide | What it answers |
| --- | --- |
| [Architecture](architecture.md) | How do the engines fit together? |
| [Integration contract](integration.md) | What runs today, what JSON comes back, and what remains unverified? |
| [Scanner reference](reference.md) | Which JavaScript, package layouts, limits, and verdicts are supported? |
| [Roadmap](roadmap.md) | What must happen before installation policy can use the result? |
| [Security](../SECURITY.md) | What is trusted, what is analyzed, and how do I report a flaw? |
| [Contributing](../CONTRIBUTING.md) | How do I reproduce, test, and propose a change? |
| [Changelog](../CHANGELOG.md) | What changed in each increment? |

## Troubleshooting

**`integration-error` / pkgxray unavailable:** pass the root of a trusted pkgxray
checkout or unpacked distribution, containing `package.json`, `src/auditor.js`,
and `src/artifact.js`. An incompatible API or report schema stays a failure;
Compose-ray findings remain available. Compatibility CI pins one upstream commit.

**The harmless case says REVIEW:** expected in combined mode. Selected files are
not a complete package inventory, and this mode does not perform registry,
provenance, or vulnerability checks. The flow-only result is separately visible.

**Missing package or identity mismatch:** provide the lockfile and matching
sources at their locked `node_modules` locations. The scanner never installs
them for you. Workspace links and symlinks are unsupported.

**A finding appears alongside incomplete coverage:** the finding was collected
before or alongside an analysis gap. Both are retained. Inspect the gap and the
route; neither cancels the other.

**A large application hits limits:** start with a smaller, relevant CommonJS
entrypoint and inspect the first gap. Raising limits is not a substitute for
modeling unsupported behavior.
