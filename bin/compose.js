#!/usr/bin/env node
"use strict";
async function main(args = process.argv.slice(2)) {
  const { main: run } = await import("../components/compose/bin/compose-ray.mjs");
  process.exitCode = run(args);
}
if (require.main === module) main().catch(() => {
  process.stderr.write("pkgxray compose: analysis failed; no installation approval issued.\n");
  process.exitCode = 2;
});
module.exports = { main };
