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

const withoutExports = source
  .replace(/^"use strict";\n\n/, "")
  .replace(
    /^const \{ compareProvenanceToRepository \} = require\("\.\/attestation"\);\n/m,
    `// Inlined from src/attestation.js (pure, browser-safe):\n${extracted.join("\n\n")}\n`
  )
  .replace(
    /\nmodule\.exports = \{[\s\S]*?\n\};\n?$/,
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
if (/^const .* = require\(/m.test(bundle)) {
  throw new Error(
    "build-browser-extension: bundle still contains a module import — inline it or add it to INLINED"
  );
}

fs.writeFileSync(targetPath, bundle, "utf8");
process.stdout.write(`Built ${targetPath}\n`);
