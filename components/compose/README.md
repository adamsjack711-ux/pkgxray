# pkgxray-compose

Compose is now part of **Package Xray**. It follows JavaScript data between
packages and preserves Package Xray's findings alongside those connections.

From the repository root:

```sh
node bin/audit.js compose /path/to/source-snapshot --entry index.js --json
npm run demo:compose
npm run test:compose
```

[Setup, CLI and MCP](../../docs/compose.md) · [Detailed documentation](docs/README.md)
· [Coverage](docs/reference.md) · [Security](../../SECURITY.md)

This is experimental static analysis. Target code is never executed; package
blocks remain blocks, and partial coverage never grants installation permission.

The entire `package-compose-ray` history through
`ffbd3f8b62f0000fbc5c97d5902e94406b0ff005` was imported with `git subtree`.
Examples, research, assets, licenses and third-party provenance remain here.
Historical `Compose-ray` names in research results describe the original v0.4
prototype. Its former GitHub templates/workflow are preserved under
`migration/standalone-github`; Package Xray's root workflows now test this code.
