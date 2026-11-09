# First real project: Tapp backend

Tapp is the first local application target. The initial baseline reads three
entry files without starting the server, executing package code, or contacting
providers. Tapp source and generated reports are not bundled in this repository.

```sh
npm run baseline:tapp -- /path/to/tapp-backend
npm run baseline:tapp -- /path/to/tapp-backend --pkgxray /path/to/trusted/pkgxray
```

Add `--json` for full evidence. Keep generated JSON local: pkgxray findings may
contain snippets of the private source. This research command exits `2` for gaps
or blocks, `1` for review, and `0` only when its selected cases have neither gaps
nor findings. A successful command is not whole-application approval.

## Initial result · 0.3.1

| Selected entry | Source collected | pkgxray calls | Flow analysis |
| --- | --- | --- | --- |
| `src/server.mjs` | Yes | Completed | Incomplete: ESM unsupported |
| `src/apple-auth.mjs` | Yes | Completed | Incomplete: ESM unsupported |
| `src/voice.mjs` | Yes | Completed | Incomplete: ESM unsupported |

All three combined decisions were `review`. No credential route was established.
pkgxray reported its own coverage gaps as well. Only selected entry bytes and
locked manifests were supplied; this does not claim dependency-source traversal.
The local snapshot had `jose@6.2.14` and `ws` as its two direct dependencies.

This exposed a collection bug: unsupported ESM was rejected before its bytes
were fingerprinted or passed to pkgxray. Version 0.3.1 retains bounded JavaScript
source evidence before reporting the unsupported format. It does not interpret
ESM, execute it, or silently clear its flow coverage in that version.

## ESM progress · 0.4

The same local snapshot was scanned with the restricted ESM loader:

| Entry | Source modules collected | Flow result |
| --- | --- | --- |
| Application | 58 | Incomplete |
| Apple sign-in | 54 | Incomplete |
| Voice upstream | 8 | Incomplete |

The Apple sign-in scan includes 46 JavaScript source files from `jose`, plus its
manifest. All three pkgxray runs completed their selected-file calls and retained
review decisions. Async functions, classes, unmodeled APIs, unresolved values,
and diagnostic budgets remain gaps. No complete credential route was established.
Counts describe this local snapshot, not every Tapp version.

## Next path: Apple sign-in

The first question is whether an identity token can reach an unintended network
destination through the authentication dependency. A public signing-key fetch
alone must not be mistaken for transmission of the identity token.

Work in this order:

1. Done: model a [narrow ESM subset](esm.md) and exact package-export resolution,
   keeping unresolved bindings and cycles explicit.
2. Add an explicit callable entry scenario with synthetic token input. Loading an
   exported verifier alone does not exercise its verification path.
3. Model the required async/callback behavior without running the target code.
4. Pair a reduced, clearly labeled public-key-fetch control with a deliberately
   introduced token-send control, then compare against the unchanged real module.

Cryptographic correctness, authentication policy, and a complete Tapp security
audit remain outside this baseline. The voice path will additionally need
WebSocket and event-callback modeling.
