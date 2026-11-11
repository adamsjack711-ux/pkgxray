"use strict";

const acorn = require("./vendor/acorn/acorn");

// A syntax proof over supplied evidence, never a package execution or a trust
// decision about its name. Unknown syntax fails closed, including unreachable
// statements and alternate branches. The collector remains authoritative for
// regular files and completeness; omitted/symlinked/truncated files cannot be
// recovered or inferred here. Direct evidence callers supply the complete text.
const MAX_SOURCE_LENGTH = 16 * 1024;
const MAX_NODES = 1024;
const MAX_DEPTH = 32;
const ENV_KEYS = new Set(["CI", "SKIP_DOWNLOAD"]);
const BOOLEAN_STRINGS = new Set(["", "0", "1", "false", "true"]);
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

function canonicalPath(file) {
  return typeof file === "string" && file.length <= 512 &&
    file.split("/").every(part => SEGMENT.test(part) && part !== "node_modules");
}
function identifier(node, name) { return node?.type === "Identifier" && node.name === name; }
function member(node, property) {
  return node?.type === "MemberExpression" && node.computed === false && !node.optional &&
    identifier(node.property, property);
}

// Shell command exactness does not establish interpreter identity. Supplied
// node shims or ambiguous manifest metadata invalidate this exception. External
// PATH, shell configuration and NODE_OPTIONS/preloads remain trusted host inputs;
// this static proof never certifies an arbitrary execution environment.
function interpreterUnshadowed(files) {
  if (files.length > 20000) return false;
  const manifests = new Set();
  let manifestNodes = 0, manifestBytes = 0;
  const nodeName = name => typeof name === "string" && /^(?:node)(?:\.(?:exe|cmd|bat|com))?$/i.test(name.split(/[\\/]/).at(-1));
  for (const file of files) {
    if (typeof file.path !== "string") return false;
    const normalized = file.path.replace(/\\/g, "/").toLowerCase();
    if (/(?:^|\/)\.bin\/node(?:\.(?:exe|cmd|bat|com))?$/.test(normalized)) return false;
    if (!/(?:^|\/)package\.json$/.test(normalized)) continue;
    if (manifests.has(normalized) || typeof file.content !== "string" || file.content.length > MAX_SOURCE_LENGTH) return false;
    manifests.add(normalized);
    manifestBytes += file.content.length;
    if (manifestBytes > 64 * 1024) return false;
    let manifest, ast;
    try {
      manifest = JSON.parse(file.content);
      ast = acorn.parse("(" + file.content + ")", { ecmaVersion: "latest" });
    } catch { return false; }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return false;
    // JSON.parse discards duplicate properties. Do not let a later benign bin
    // value hide an earlier shadow declaration from a different consumer.
    const pending = [ast];
    while (pending.length) {
      const node = pending.pop();
      if (++manifestNodes > MAX_NODES) return false;
      if (node.type === "ObjectExpression") {
        const names = new Set();
        for (const property of node.properties) {
          const key = property.key?.value;
          if (typeof key !== "string" || names.has(key)) return false;
          names.add(key);
        }
      }
      for (const value of Object.values(node)) {
        for (const child of Array.isArray(value) ? value : [value]) {
          if (child && typeof child === "object" && typeof child.type === "string") pending.push(child);
        }
      }
    }
    if (manifest.directories && Object.hasOwn(manifest.directories, "bin")) return false;
    if (!Object.hasOwn(manifest, "bin")) continue;
    if (typeof manifest.bin === "string") {
      if (typeof manifest.name !== "string" || !manifest.name || nodeName(manifest.name) || !manifest.bin) return false;
    } else {
      if (!manifest.bin || typeof manifest.bin !== "object" || Array.isArray(manifest.bin)) return false;
      for (const [name, target] of Object.entries(manifest.bin)) {
        if (!name || /[\\/]/.test(name) || nodeName(name) || typeof target !== "string" || !target) return false;
      }
    }
  }
  return true;
}

function proveLiteralLifecycle(command, manifestPath, evidence) {
  if (typeof command !== "string" || command.length > 520 ||
      !canonicalPath(manifestPath) || manifestPath.split("/").at(-1) !== "package.json") return null;
  const match = /^node (\.\/)?([A-Za-z0-9_/-][A-Za-z0-9_./-]*\.(?:js|cjs|mjs))$/.exec(command);
  // Both forms resolve the supplied file relative to the manifest. A bare
  // leading dash is a Node option; a trailing newline is shell syntax, even
  // though JavaScript's $ anchor also matches before a final line terminator.
  if (!match || match[0] !== command || (!match[1] && match[2].startsWith("-"))) return null;
  const relative = match[2];
  if (!canonicalPath(relative)) return null;
  const directory = manifestPath.slice(0, -"package.json".length);
  const scriptPath = directory + relative;
  const files = evidence?.sourceFiles;
  if (!Array.isArray(files) || !interpreterUnshadowed(files)) return null;
  const matches = files.filter(file => file.path === scriptPath);
  if (matches.length !== 1 || files.filter(file => file.path === manifestPath).length !== 1) return null;
  const source = matches[0].content;
  const coverage = evidence.sourceCoverage;
  if (coverage && (coverage.complete !== true || coverage.truncatedFiles > 0 || coverage.skippedFiles > 0 ||
      coverage.reasons?.length || (Array.isArray(coverage.runtimeFiles) && !coverage.runtimeFiles.includes(scriptPath)))) return null;
  if (typeof source !== "string" || !source.trim() || source.length > MAX_SOURCE_LENGTH || source.includes("\0")) return null;

  let ast;
  try { ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "script", allowHashBang: true }); }
  catch { return null; }
  // Traverse every AST child before interpreting the deliberately smaller
  // grammar. Bound nesting and total nodes even for unsupported syntax.
  let nodes = 0;
  const pending = [{ node: ast, depth: 0 }];
  while (pending.length) {
    const { node, depth } = pending.pop();
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return null;
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child === "object" && typeof child.type === "string") pending.push({ node: child, depth: depth + 1 });
      }
    }
  }
  const operations = new Set();
  const environmentChecks = new Set();
  const envRead = node => {
    if (!member(node, node?.property?.name) || !ENV_KEYS.has(node.property.name) ||
        !member(node.object, "env") || !identifier(node.object.object, "process")) return false;
    environmentChecks.add(node.property.name);
    return true;
  };
  function condition(node) {
    if (!node) return false;
    if (envRead(node)) return true;
    if (node.type === "UnaryExpression" && node.operator === "!" && node.prefix) return condition(node.argument);
    if (node.type === "LogicalExpression" && ["&&", "||"].includes(node.operator)) {
      return condition(node.left) && condition(node.right);
    }
    if (node.type === "BinaryExpression" && ["===", "!=="].includes(node.operator)) {
      const literal = node.right;
      return envRead(node.left) && literal.type === "Literal" &&
        (typeof literal.value === "boolean" || (typeof literal.value === "string" && BOOLEAN_STRINGS.has(literal.value)));
    }
    return false;
  }
  function call(node) {
    if (node?.type !== "CallExpression" || node.optional) return false;
    if (member(node.callee, "log") && identifier(node.callee.object, "console") &&
        node.arguments.length >= 1 && node.arguments.length <= 4 &&
        node.arguments.every(arg => arg.type === "Literal" && typeof arg.value === "string" &&
          !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(arg.value))) {
      operations.add("console.log(literal strings)");
      return true;
    }
    if (member(node.callee, "exit") && identifier(node.callee.object, "process") &&
        node.arguments.length === 1 && node.arguments[0].type === "Literal" && node.arguments[0].value === 0) {
      operations.add("process.exit(0)");
      return true;
    }
    return false;
  }
  function statement(node) {
    if (!node) return false;
    if (node.type === "Program" || node.type === "BlockStatement") return node.body.every(child => statement(child));
    if (node.type === "EmptyStatement") return true;
    if (node.type === "ExpressionStatement") return call(node.expression);
    if (node.type === "IfStatement") return condition(node.test) && statement(node.consequent) &&
      (!node.alternate || statement(node.alternate));
    return false;
  }
  if (!statement(ast)) return null;
  return {
    kind: "literal-node-lifecycle-v1",
    command,
    assumptions: ["The host resolves node to the trusted Node.js interpreter.",
      "External PATH, shell configuration and NODE_OPTIONS/preloads do not alter the analyzed behavior."],
    script: { file: scriptPath, source },
    operations: [...operations].sort(),
    environmentChecks: [...environmentChecks].sort()
  };
}

module.exports = { proveLiteralLifecycle };
