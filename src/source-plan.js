"use strict";

const path = require("node:path").posix;
const { analyzeExecutionFile } = require('./execution-graph');
const INSTALL_HOOKS = new Set(["preinstall", "install", "postinstall", "prepare", "prepack"]);
const EXTENSIONS = ["", ".js", ".cjs", ".mjs", ".json", ".ts", ".node", "/index.js", "/index.cjs", "/index.mjs"];

function scriptDispatchMayBeDynamic(command) {
  if (command.length > 8192) return true;
  // Expansion, escaped/concatenated words, and inline shell/code evaluation can
  // select a script without spelling its name. Keep every script reachable.
  if (/[$`\\()]/.test(command)) return true;
  const words = [...command.matchAll(/"[^"\n]*"|'[^'\n]*'|[;&|]+|[^\s;&|]+/g)];
  if (words.length > 512) return true;
  const tokens = words.map(match => match[0].replace(/^(['"])(.*)\1$/, '$2'));
  if (words.some((match, i) => /['"]/.test(tokens[i]) || (i && words[i - 1].index + words[i - 1][0].length === match.index && !/^[;&|]+$/.test(match[0]) && !/^[;&|]+$/.test(words[i - 1][0])))) return true;
  if (tokens.some(token => /^(?:.*\/)?eval$/.test(token))) return true;
  let commandPosition = true;
  for (const token of tokens) {
    if (/^[;&|]+$/.test(token)) { commandPosition = true; continue; }
    if (!commandPosition) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    if (['command', 'exec', 'env', 'builtin', 'nohup'].includes(path.basename(token))) continue;
    if (token.startsWith('-') || /[*?{}[\]]/.test(token)) return true;
    commandPosition = false;
  }
  for (let i = 0; i < tokens.length; i++) {
    const commandName = path.basename(tokens[i]).toLowerCase();
    // Shells may hide a complete command in one argument (including grouped
    // or encoded flags); xargs may obtain the selector from stdin. Do not try
    // to interpret either here. `shx` is intentionally not a shell executable.
    if (/^(?:sh|bash|zsh|dash|ksh|fish|cmd|powershell|pwsh|xargs)(?:\.exe)?$/.test(commandName)) return true;
    const end = tokens.findIndex((token, j) => j > i && /^[;&|]+$/.test(token));
    const args = tokens.slice(i + 1, end < 0 ? tokens.length : end);
    if (/^(?:node|nodejs|python3?)$/.test(commandName) && args.some(arg => ['-c', '-e', '--eval', '-p', '--print'].includes(arg))) return true;
    if (!/^(?:npm|pnpm|yarn|bun)(?:\.cmd)?$/.test(commandName) && !['run', 'run-script'].includes(commandName)) continue;
    const run = args.findIndex(arg => ['run', 'run-script'].includes(arg));
    const selectors = run >= 0 ? args.slice(run + 1) : args;
    let selector;
    for (const arg of selectors) {
      if (['--', '--if-present', '--silent', '-s', '--ignore-scripts'].includes(arg)) continue;
      // Unknown option arity must not make its argument look like the selector.
      if (arg.startsWith('-')) return true;
      selector = arg; break;
    }
    // Only dispatch selectors expand the reachable script set. A file glob in
    // `shx chmod dist/*.js`, or after `npm run build --`, is ordinary data here.
    if (selector && /[*?{}[\]]/.test(selector)) return true;
  }
  return false;
}

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

  function resolve(from, raw, install = false, mustExist = true) {
    if (typeof raw !== "string" || !raw || !withinBudget()) return;
    const target = path.normalize(path.join(path.dirname(from), raw.replace(/\\/g, "/")));
    if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || target === ".." || target.startsWith("../")) {
      if (mustExist) gaps.add(`runtime target escapes artifact: ${raw}`);
      return;
    }
    if (target.includes("*")) {
      const re = new RegExp("^" + target.split("*").map(x => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
      const matches = [];
      for (const file of inventory.keys()) {
        if (!withinBudget()) break;
        if (re.test(file)) matches.push(file);
      }
      if (!matches.length && mustExist) gaps.add(`unresolved runtime target: ${target}`);
      for (const match of matches) { required.add(match); if (install) installTime.add(match); }
      return;
    }
    const found = EXTENSIONS.map(ext => path.normalize(target + ext)).find(x => inventory.has(x));
    if (!found) {
      if (mustExist) gaps.add(`unresolved runtime target: ${target}`);
      return;
    }
    required.add(found);
    if (install) installTime.add(found);
  }

  function entries(value, localOnly = false, condition = '') {
    if (typeof value === "string") {
      if (!/^(?:types|typings)$/i.test(condition) && (!localOnly || value.startsWith("."))) {
        resolve("package.json", value);
      }
    } else if (Array.isArray(value)) {
      for (const v of value) entries(v, localOnly, condition);
    } else if (value && typeof value === "object") {
      for (const [key, v] of Object.entries(value)) entries(v, localOnly, key);
    }
  }

  function manifest(pkg) {
    for (const key of ["main", "module", "bin", "exports"]) entries(pkg[key]);
    // Conditional import and browser maps may name external dependencies.
    entries(pkg.imports, true);
    entries(pkg.browser, typeof pkg.browser === "object");
    if (!pkg.main && !pkg.exports && inventory.has("index.js")) required.add("index.js");
    const scripts = new Map(Object.entries(pkg.scripts || {}).filter(([, command]) => typeof command === 'string'));
    const installScripts = new Set([...INSTALL_HOOKS].filter(hook => scripts.has(hook)));
    // Follow script names conservatively, including npm's pre/post companions.
    // This is deliberately an over-approximation, not a shell evaluator. If a
    // lifecycle command computes its arguments, every script may be reachable.
    for (const hook of installScripts) {
      if (!withinBudget()) break;
      const command = scripts.get(hook);
      const tokens = command.match(/"[^"\n]*"|'[^'\n]*'|[^\s;&|]+/g) || [];
      const dynamic = scriptDispatchMayBeDynamic(command);
      for (const name of scripts.keys()) {
        if (!withinBudget()) break;
        if (dynamic || tokens.some(token => token.replace(/^(['"])(.*)\1$/, '$2') === name)) {
          for (const target of [name, `pre${name}`, `post${name}`]) {
            if (scripts.has(target)) installScripts.add(target);
          }
        }
      }
    }
    for (const [hook, command] of scripts) {
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
        if (interpreter || local || present) {
          const install = installScripts.has(hook);
          // Published tarballs routinely omit developer-only build/test files.
          // If such a literal target is absent, there are no bytes for a
          // consumer to execute. Existing targets are still collected and
          // scanned; auto-install hooks remain mandatory and fail closed.
          resolve("package.json", token, install, install);
        }
        interpreter = false;
      }
    }
  }

  function imports(from, text) {
    if (!required.has(from)) return;
    if (path.extname(from) === '.json') {
      try { JSON.parse(text); } catch { gaps.add(`${from}: unsupported runtime JSON syntax`); }
      return;
    }
    // Subprocess targets are executable even with .dat/.txt or no extension.
    // Syntax facts also handle aliases and path.join(__dirname, ...); no target
    // source is executed to discover these paths.
    const facts = analyzeExecutionFile(from, text);
    for (const raw of facts.imports) resolve(from, raw, installTime.has(from));
    if (facts.status !== 'parsed') {
      // Unsupported syntax (including TypeScript) is never evidence of complete
      // import coverage. Still collect obvious literal targets for inspection.
      gaps.add(`${from}: unsupported runtime import syntax (${facts.status})`);
      const re = /(?:\brequire\s*\(|\bimport\s*\(|\b(?:import|export)\b[^;'"\n]*?\bfrom\b|\bimport\s*)\s*(['"])(\.[^'"\r\n]*)\1/g;
      for (const match of text.matchAll(re)) resolve(from, match[2], installTime.has(from));
    }
    for (const edge of facts.edges) {
      if (edge.target !== null) resolve('package.json', edge.target, installTime.has(from));
      else gaps.add(`unresolved runtime execution in ${from}: ${edge.reason}`);
    }
    for (const gap of facts.gaps) gaps.add(`${from}: ${gap.reason}`);
  }

  return { required, installTime, gaps, manifest, imports };
}

module.exports = { createSourcePlan };
