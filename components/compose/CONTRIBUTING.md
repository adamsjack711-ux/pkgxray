# Contributing

Compose-ray follows data across packages and contributes evidence to pkgxray.
Help us make each supported claim precise and each limit visible.

## Local setup

Use Node.js 22 or 24. No package install is required.

```sh
npm test
npm run demo
npm run demo:strings
npm run demo:real
npm run demo:esm
```

For the real pkgxray integration, use a trusted checkout:

```sh
PKGXRAY_CHECKOUT=/path/to/pkgxray node --test test/integration.test.mjs
npm run demo:integration -- /path/to/pkgxray
```

The default suite uses labeled protocol stubs for failure cases and skips the
real-engine test without `PKGXRAY_CHECKOUT`. CI also runs against the public
commit pinned in the integration contract.

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
