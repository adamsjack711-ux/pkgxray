# ESM support · v0.4

Compose-ray follows a restricted static ES module graph without importing or
executing target code. Run `npm run demo:esm` for three synthetic controls:

| Scenario | Expected flow result |
| --- | --- |
| Token is received, but only public keys are requested | `no-flow-found` |
| Token is deliberately placed in an outbound header | `review` |
| The request uses unsupported async behavior | `incomplete` |

These are reduced examples, not Tapp or jose implementations. They do not verify
JWT signatures or establish application security.

## Supported subset

- `.mjs` and `.js` inside a package with `type: "module"`. `.cjs` stays CommonJS;
  syntax-based format detection is not implemented.
- Static named, default, namespace, and side-effect imports. Import aliases and
  named re-exports are supported. Dependencies are visited before importer code,
  in module-request order, with each completed module evaluated once.
- Const/function exports, local export lists, default functions/expressions, and
  re-exports of named/default bindings. A default expression captures its value
  at that statement; local exported bindings are collected after module evaluation.
- Exported mutable `let`/`var` bindings and outer-scope writes remain gaps. The
  implementation does not claim general live-binding support. Namespace objects
  are read-only in the supported subset; arbitrary mutation is not modeled.
- Exact relative paths and exact package subpaths. Relative extension guessing,
  directory indexes, URL queries/fragments, and encoded paths are not modeled.
- Exact package export strings and ordered `node`, `import`, `default` conditions.
  `types` and `require` branches are inactive for these ESM imports. Other condition
  keys, custom conditions, arrays, and selected wildcard targets are unsupported.
- Default and `request`/`get` imports from Node HTTP/HTTPS use existing sink models.
  Other Node builtins remain outside this narrow model.

Missing bindings, cycles, top-level await, async/generators, dynamic `import()`,
star/namespace re-exports, and CommonJS/ESM interop produce explicit gaps. A module
can still contain other modeled flows; those findings remain in the report.

The format, resolution, and condition-order rules follow a deliberately limited
subset of [Node's ESM documentation](https://nodejs.org/api/esm.html) and
[conditional exports](https://nodejs.org/api/packages.html#conditional-exports).
This is not a complete Node module loader.

## Real-project progress

The [Tapp baseline](tapp-baseline.md) now reaches dependency source instead of
stopping at the first ESM entry. Async functions, classes, runtime APIs, and
diagnostic limits still prevent complete flow analysis. Broader source traversal
is progress in coverage, not a security verdict.
