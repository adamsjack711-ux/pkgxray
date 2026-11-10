# Contributing

Compose-ray follows data across packages and contributes evidence to pkgxray.
Help us make each supported claim precise and each limit visible.

## Local setup

From the Package Xray repository root, use Node.js 18+; no package install is required.

```sh
npm run test:compose
npm run demo:compose
npm test
```

The root test runner always exercises the real bundled engine. Protocol stubs
remain labeled and are used only to exercise adapter failure behavior. Main CI
runs the full test suite across Package Xray's supported Node and OS matrix.

## Useful changes

1. Reproduce behavior with a small inert source fixture.
2. Add a sensitive case and a harmless control. State what should be found and
   where analysis must remain incomplete.
3. Implement the smallest semantics or integration change that supports it.
4. Run relevant tests and demos. Update coverage docs when behavior changes;
   preserve existing verdict and CLI contracts.

Do not run fixture code, install fixture dependencies, contact collection URLs,
or use real secrets. Use synthetic names and `.invalid` destinations. Fixtures
can describe dangerous code but must only be parsed as data.

Keep the scanner dependency-free unless there is a strong reviewed reason.
Do not convert unsupported behavior into a clean result, conflate file hashes
with registry verification, or let one engine erase another's block.

## Pull requests

To regenerate the README animation, install Pillow in your own tooling environment
and run `python3 scripts/render-cli-demo.py /path/to/trusted/pkgxray`. It captures
real demo output and paces playback; Pillow is not a scanner dependency.

Explain before/after behavior, coverage limits, and checks run. Keep unrelated
work out. New vendored fixtures need licenses and provenance; do not silently
refresh pinned `ms` or Acorn bytes.

Report exploitable scanner flaws through [SECURITY.md](SECURITY.md). Ordinary
missing-language-support examples can use the public issue template.
