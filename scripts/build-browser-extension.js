"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const sourcePath = path.join(root, "src", "auditor.js");
const attestationPath = path.join(root, "src", "attestation.js");
const targetPath = path.join(root, "browser-extension", "auditor.browser.js");

const source = fs.readFileSync(sourcePath, "utf8");
const attestation = fs.readFileSync(attestationPath, "utf8");

// The auditor imports one pure comparison from the attestation module; the
// rest of that module (registry fetch, fs cache) is Node-only and must not
// reach the bundle. Inline just the pure dependency chain.
const INLINED = ["parseGithubUrl", "canonicalGithubKey", "compareProvenanceToRepository"];
const extracted = INLINED.map((name) => {
  const match = attestation.match(
    new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`, "m")
  );
  if (!match) {
    throw new Error(`build-browser-extension: could not extract ${name} from src/attestation.js`);
  }
  return match[0];
});

// Inline pure CommonJS modules in isolated scopes; the vendored parser keeps
// its original MIT notice and exposes only its exports to the flow engine.
const pureModules = ['vendor/acorn/acorn', 'shell-flows', 'flow-analysis', 'sensitive-flows', 'execution-graph'];
const vendorLicense = fs.readFileSync(path.join(root, 'src/vendor/acorn/LICENSE'), 'utf8');
const pureBundle = '/* Bundled Acorn 8.18.0 — MIT license\n' + vendorLicense + '\n*/\n' + pureModules.map(name => {
  const text = fs.readFileSync(path.join(root, 'src', name + '.js'), 'utf8');
  return `pure[${JSON.stringify('./' + name)}] = (() => { const module = {exports:{}}; const exports = module.exports; const require = key => pure[key];\n${text}\nreturn module.exports; })();`;
}).join('\n');
const supportedImports = new Set(['./sensitive-flows', './flow-analysis', './execution-graph', './attestation']);
for (const match of source.matchAll(/^const .* = require\("([^"\n]+)"\);$/gm)) {
  if (!supportedImports.has(match[1])) throw new Error(`Unbundled auditor dependency: ${match[1]}`);
}
const withoutExports = source
  .replace(/^"use strict";\n\n/, "")
  .replace(/^const \{ sensitiveFlowHints \} = require\("\.\/sensitive-flows"\);\n/m,
    () => `const pure = {};\n${pureBundle}\nconst { sensitiveFlowHints } = pure['./sensitive-flows'];\n`)
  .replace(/^const \{ createFlowAnalysis \} = require\("\.\/flow-analysis"\);\n/gm,
    () => "const { createFlowAnalysis } = pure['./flow-analysis'];\n")
  .replace(/^const \{ createExecutionGraph \} = require\("\.\/execution-graph"\);\n/gm,
    () => "const { createExecutionGraph } = pure['./execution-graph'];\n")
  .replace(
    /^const \{ compareProvenanceToRepository \} = require\("\.\/attestation"\);\n/m,
    () => `// Inlined from src/attestation.js (pure, browser-safe):\n${extracted.join("\n\n")}\n`
  )
  .replace(
    /\nmodule\.exports = \{\n  auditEvidence,[\s\S]*?\n\};\n?$/,
    [
      "",
      "window.SupplyChainAuditor = {",
      "  auditEvidence,",
      "  renderMarkdown,",
      "  normalizeEvidence,",
      "  gradeEvidence,",
      "  letterGrade",
      "};",
      ""
    ].join("\n")
  );

const bundle = `"use strict";\n\n${withoutExports}`;

// A module import that survives to the bundle throws in the browser and
// silently kills the whole extension (window.SupplyChainAuditor never gets
// set). Fail the build instead. Detection-heuristic strings that merely
// mention require( don't match this import shape.
if (/^const .* = require\("\.\/attestation"\)/m.test(bundle)) {
  throw new Error(
    "build-browser-extension: bundle still contains a module import — inline it or add it to INLINED"
  );
}

fs.writeFileSync(targetPath, bundle, "utf8");
process.stdout.write(`Built ${targetPath}\n`);
