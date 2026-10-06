"use strict";

const path = require("node:path").posix;
const { analyzeExecutionFile } = require('./execution-graph');
const INSTALL_HOOKS = new Set(["preinstall", "install", "postinstall", "prepare", "prepack"]);
const EXTENSIONS = ["", ".js", ".cjs", ".mjs", ".json", ".ts", ".node", "/index.js", "/index.cjs", "/index.mjs"];

// A conservative plan over the actual artifact inventory. This follows literal
// paths only; it is not a JavaScript or shell interpreter. Keep unresolved paths
// as evidence instead of silently treating them as inspected.
function createSourcePlan(inventory) {
  const required = new Set();
  const installTime = new Set();
  const gaps = new Set();
  let work = 0;
  const withinBudget = () => {
    if (++work <= 20000) return true;
    gaps.add("runtime resolution work limit reached");
    return false;
  };

  function resolve(from, raw, install = false) {
    if (typeof raw !== "string" || !raw || !withinBudget()) return;
    const target = path.normalize(path.join(path.dirname(from), raw.replace(/\\/g, "/")));
    if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || target === ".." || target.startsWith("../")) {
      gaps.add(`runtime target escapes artifact: ${raw}`);
      return;
    }
    if (target.includes("*")) {
      const re = new RegExp("^" + target.split("*").map(x => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
      const matches = [];
      for (const file of inventory.keys()) {
        if (!withinBudget()) break;
        if (re.test(file)) matches.push(file);
      }
      if (!matches.length) gaps.add(`unresolved runtime target: ${target}`);
      for (const match of matches) { required.add(match); if (install) installTime.add(match); }
      return;
    }
    const found = EXTENSIONS.map(ext => path.normalize(target + ext)).find(x => inventory.has(x));
    if (!found) { gaps.add(`unresolved runtime target: ${target}`); return; }
    required.add(found);
    if (install) installTime.add(found);
  }

  function entries(value, localOnly = false) {
    if (typeof value === "string") {
      if (!localOnly || value.startsWith(".")) resolve("package.json", value);
    } else if (value && typeof value === "object") {
      for (const v of Object.values(value)) entries(v, localOnly);
    }
  }

  function manifest(pkg) {
    for (const key of ["main", "module", "bin", "exports"]) entries(pkg[key]);
    // Conditional import and browser maps may name external dependencies.
    entries(pkg.imports, true);
    entries(pkg.browser, typeof pkg.browser === "object");
    if (!pkg.main && !pkg.exports && inventory.has("index.js")) required.add("index.js");
    for (const [hook, command] of Object.entries(pkg.scripts || {})) {
      if (typeof command !== "string") continue;
      const tokens = command.match(/"[^"\n]*"|'[^'\n]*'|[^\s;&|]+/g) || [];
      let interpreter = false;
      let inline = false;
      for (const quoted of tokens) {
        const token = quoted.replace(/^(['"])(.*)\1$/, "$2");
        if (inline) { inline = false; interpreter = false; continue; }
        if (interpreter && ["-e", "--eval", "-p", "--print", "-c"].includes(token)) { inline = true; continue; }
        if (/^(?:node|nodejs|bash|sh|python3?)$/.test(token)) { interpreter = true; continue; }
        if (token.startsWith("-")) continue;
        const local = token.startsWith("./") || token.startsWith("../");
        const present = inventory.has(path.normalize(token));
        if (interpreter || local || present) resolve("package.json", token, INSTALL_HOOKS.has(hook));
        interpreter = false;
      }
    }
  }

  function imports(from, text) {
    if (!required.has(from)) return;
    const re = /(?:\brequire\s*\(|\bimport\s*\(|\b(?:import|export)\b[^;'"\n]*?\bfrom\b|\bimport\s*)(['"])(\.[^'"\r\n]*)\1/g;
    for (const match of text.matchAll(re)) resolve(from, match[2], installTime.has(from));
    // Subprocess targets are executable even with .dat/.txt or no extension.
    // Syntax facts also handle aliases and path.join(__dirname, ...); no target
    // source is executed to discover these paths.
    const facts = analyzeExecutionFile(from, text);
    for (const edge of facts.edges) {
      if (edge.target !== null) resolve('package.json', edge.target, installTime.has(from));
      else gaps.add(`unresolved runtime execution in ${from}: ${edge.reason}`);
    }
    for (const gap of facts.gaps) gaps.add(`${from}: ${gap.reason}`);
  }

  return { required, installTime, gaps, manifest, imports };
}

module.exports = { createSourcePlan };
