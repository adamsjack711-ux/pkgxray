"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const sourcePath = path.join(root, "src", "auditor.js");
const targetPath = path.join(root, "browser-extension", "auditor.browser.js");

const source = fs.readFileSync(sourcePath, "utf8");
const withoutExports = source
  .replace(/^"use strict";\n\n/, "")
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

fs.writeFileSync(targetPath, `"use strict";\n\n${withoutExports}`, "utf8");
process.stdout.write(`Built ${targetPath}\n`);
