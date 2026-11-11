"use strict";

const acorn = require('./vendor/acorn/acorn');

// Syntax-only facts. Never call a function from the inspected package. Paths
// rooted at __dirname are represented under a virtual artifact root; inherited
// process.cwd() is deliberately unknown, not assumed to be the package root.
const ROOT = '/<artifact>/';
const UNKNOWN = Object.freeze({});
const MODULES = new Set(['child_process', 'path', 'process', 'vm']);
const EXTENSIONS = ['', '.js', '.cjs', '.mjs', '.json', '/index.js', '/index.cjs', '/index.mjs'];
const value = (literal, artifact = false) => ({ literal, artifact });
const tag = kind => ({ kind });
const isString = v => typeof v?.literal === 'string';
function normalize(raw) {
  const parts = [];
  for (const p of raw.replace(/\\/g, '/').split('/')) {
    if (p === '..') { if (!parts.length) return null; parts.pop(); }
    else if (p && p !== '.') parts.push(p);
  }
  return parts.join('/');
}
function anchored(raw) {
  if (typeof raw !== 'string' || !raw.startsWith(ROOT)) return null;
  return normalize(raw.slice(ROOT.length));
}
class Scope {
  constructor(parent) { this.parent = parent; this.bindings = new Map(); }
  get(name) { return this.bindings.has(name) ? this.bindings.get(name) : this.parent?.get(name); }
  set(name, v, declare = false) {
    if (declare || this.bindings.has(name) || !this.parent) this.bindings.set(name, v);
    else this.parent.set(name, v);
  }
  clone() { const s = new Scope(this.parent?.clone()); s.bindings = new Map(this.bindings); return s; }
}

function analyzeExecutionFile(file, source) {
  const result = { edges: [], imports: [], gaps: [], structure: null, status: 'parsed' };
  const diagnostic = (node, reason) => {
    if (result.gaps.length < 8) result.gaps.push({ index: node?.start || 0, reason });
  };
  if (source.length > 1024 * 1024) {
    result.status = 'budget'; diagnostic(null, 'execution graph file limit (1 MiB)'); return result;
  }
  let ast;
  try { ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowHashBang: true }); }
  catch {
    // JSON data can be a package export or a required file. Its strings never
    // create executable imports. Do not apply this exception to a budget stop.
    try { JSON.parse(source); return result; } catch { /* not JSON data */ }
    result.status = 'unsupported'; diagnostic(null, 'unsupported runtime syntax'); return result;
  }
  const dirname = ROOT + (file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '');
  let work = 0, depth = 0;
  const features = { stringTables: 0, rotations: 0, computedAccesses: 0, dynamicLoads: 0, flattenedSwitches: 0 };
  // Syntax values are immutable after construction (writes never mutate their
  // props/items). Cache capability summaries so joins do not repeatedly walk
  // large inert containers and consume the existing graph work budget.
  const evaluatorCache = new WeakMap();
  function hasEvaluator(input) {
    if (!input) return false;
    if (evaluatorCache.has(input)) return evaluatorCache.get(input);
    if (!input.props && !input.items) return ['dynamic-code', 'dynamic-code-bind', 'global-factory'].includes(input.kind);
    const pending = [input], seen = new Set();
    while (pending.length) {
      if (++work > 200000) throw new Error('execution graph work/depth limit');
      const v = pending.pop();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      if (['dynamic-code', 'dynamic-code-bind', 'global-factory'].includes(v.kind)) { evaluatorCache.set(input, true); return true; }
      if (v.props) pending.push(...v.props.values());
      if (v.items) pending.push(...v.items);
    }
    evaluatorCache.set(input, false);
    return false;
  }
  // A deliberately small syntax proof for literal development wrappers.
  // No recursive interpretation, calls, imports, member reads, coercion, or
  // parameter source is accepted. Everything outside this grammar keeps a gap.
  function inertLiteral(node, kind) {
    if (node?.type !== 'Literal' || typeof node.value !== 'string' || node.value.length > 4096) return null;
    let parsed;
    try { parsed = acorn.parse(node.value, { ecmaVersion: 'latest', allowReturnOutsideFunction: true }); }
    catch { return null; }
    if (kind === 'Function') return parsed.body.length === 1 && parsed.body[0].type === 'ReturnStatement' &&
      parsed.body[0].argument?.type === 'ThisExpression' ? tag('global-factory') : null;
    if (kind !== 'eval' || parsed.body.length > 32) return null;
    const locals = new Set();
    const primitive = n => n?.type === 'Literal' && (n.value === null || ['string', 'number', 'boolean'].includes(typeof n.value)) && !n.regex;
    const scalar = n => primitive(n) || n?.type === 'Identifier' && locals.has(n.name);
    for (const statement of parsed.body) {
      if (++work > 200000) throw new Error('execution graph work/depth limit');
      if (statement.type === 'EmptyStatement') continue;
      if (statement.type === 'VariableDeclaration') {
        for (const declaration of statement.declarations) {
          if (declaration.id.type !== 'Identifier' || !primitive(declaration.init)) return null;
          locals.add(declaration.id.name);
        }
        continue;
      }
      const expression = statement.type === 'ExpressionStatement' && statement.expression;
      if (primitive(expression)) continue;
      const lhs = expression?.left;
      if (expression?.type !== 'AssignmentExpression' || expression.operator !== '=' ||
          lhs.type !== 'MemberExpression' || lhs.computed || lhs.object.type !== 'Identifier' ||
          lhs.object.name !== 'module' || lhs.property.name !== 'exports' || !scalar(expression.right)) return null;
    }
    return UNKNOWN;
  }
  function key(node) { return node?.type === 'Identifier' ? node.name : node?.type === 'Literal' ? node.value : undefined; }
  function bind(node, v, scope) {
    if (!node) return;
    if (node.type === 'Identifier') scope.set(node.name, v, true);
    else if (node.type === 'AssignmentPattern') {
      const fallback = walk(node.right, scope);
      bind(node.left, hasEvaluator(fallback) ? fallback : UNKNOWN, scope);
    }
    else if (node.type === 'ObjectPattern') for (const p of node.properties) {
      if (p.type === 'RestElement' && hasEvaluator(v)) diagnostic(p, 'dynamic code execution alias escapes runtime graph');
      bind(p.value || p.argument, p.type === 'RestElement' ? UNKNOWN : property(v, p.computed ? walk(p.key, scope).literal : key(p.key)), scope);
    }
    else if (node.type === 'ArrayPattern') {
      if (node.elements.some(p => p?.type === 'RestElement') && hasEvaluator(v)) diagnostic(node, 'dynamic code execution alias escapes runtime graph');
      node.elements.forEach((p, i) => bind(p, v.items?.[i] || UNKNOWN, scope));
    }
    else if (node.type === 'RestElement') bind(node.argument, UNKNOWN, scope);
  }
  function property(v, k) {
    // An unresolved computed global property can name an evaluator. Retain
    // that possibility rather than treating an unknown function as inert.
    if (v.kind === 'global' && (k === undefined || ['eval', 'Function'].includes(k))) return tag('dynamic-code');
    if (['function', 'dynamic-code', 'global-factory'].includes(v.kind) && k === 'constructor') return tag('dynamic-code');
    if (k === 'constructor') {
      if (v.props?.has(k)) return v.props.get(k);
      // Plain values inherit their type constructor; its constructor is
      // Function. An unresolved receiver may already be a function (for
      // example [].filter), so retain evaluator capability conservatively.
      return v.props || v.items || Object.hasOwn(v, 'literal') ? tag('function') : tag('dynamic-code');
    }
    if (v.kind === 'vm' && ['Script', 'SourceTextModule', 'compileFunction', 'runInContext', 'runInNewContext', 'runInThisContext'].includes(k)) return tag('dynamic-code');
    if (['dynamic-code', 'global-factory'].includes(v.kind) && ['call', 'apply'].includes(k)) return v;
    if (['dynamic-code', 'global-factory'].includes(v.kind) && k === 'bind') return tag('dynamic-code-bind');
    if (v.kind === 'child_process' && ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork'].includes(k)) return { kind: 'subprocess', method: k };
    if (v.kind === 'path' && ['join', 'resolve'].includes(k)) return { kind: 'path-call', method: k };
    if (v.kind === 'path' && k === 'posix') return v;
    if (v.kind === 'process' && k === 'execPath') return tag('node-command');
    if (v.kind === 'child' && k === 'unref') return { kind: 'unref', edge: v.edge };
    return v.props?.get(k) || (v.items && Number.isInteger(Number(k)) ? v.items[Number(k)] : null) || UNKNOWN;
  }
  function moduleValue(raw) {
    const name = typeof raw === 'string' ? raw.replace(/^node:/, '') : null;
    return MODULES.has(name) ? tag(name) : UNKNOWN;
  }
  function joinScopes(dest, a, b) {
    for (; dest; dest = dest.parent, a = a.parent, b = b.parent) {
      for (const name of new Set([...a.bindings.keys(), ...b.bindings.keys()])) {
        const x = a.get(name) || UNKNOWN, y = b.get(name) || UNKNOWN;
        if (x === y) { dest.bindings.set(name, x); continue; }
        const evaluator = hasEvaluator(x) || hasEvaluator(y);
        if (evaluator) diagnostic(null, 'dynamic code execution alias escapes runtime graph');
        dest.bindings.set(name, evaluator ? tag('dynamic-code') :
          x === y || (Object.hasOwn(x, 'literal') && x.literal === y.literal && x.artifact === y.artifact) ? x : UNKNOWN);
      }
    }
  }
  function sequence(nodes, scope, loops) {
    // Lexical declarations shadow globals even before initialization.
    for (const n of nodes) {
      if (n.type === 'VariableDeclaration') for (const d of n.declarations) bind(d.id, UNKNOWN, scope);
      if (['FunctionDeclaration', 'ClassDeclaration'].includes(n.type) && n.id) scope.set(n.id.name, tag('function'), true);
      if (n.type === 'ImportDeclaration') for (const s of n.specifiers) scope.set(s.local.name, UNKNOWN, true);
    }
    for (const n of nodes) walk(n, scope, loops);
    return UNKNOWN;
  }
  function subprocess(node, fn, args) {
    const fork = fn.method === 'fork';
    const command = args[0];
    if (!fork && command?.kind !== 'node-command' && !(isString(command) && /(?:^|[\\/])node(?:js)?(?:\.exe)?$/i.test(command.literal))) return UNKNOWN;
    const list = fork ? null : args[1]?.items;
    if (!fork && list?.length === 1 && ['--version', '-v', '--help', '-h'].includes(list[0]?.literal)) return UNKNOWN;
    let target = fork ? args[0] : null;
    if (!fork && list) {
      // Inline eval is executable text, not a filename. Its nested runtime
      // imports are not modeled; retain an explicit coverage gap.
      for (const arg of list) {
        if (target) break;
        if (isString(arg) && ['-e', '--eval', '-p', '--print'].includes(arg.literal)) {
          diagnostic(node, 'dynamic code execution in inline Node source is not modeled in runtime graph');
          return UNKNOWN;
        }
        if (!target && isString(arg) && /^--(?:no-warnings|enable-source-maps)$/.test(arg.literal)) continue;
        if (!target) target = isString(arg) && !arg.literal.startsWith('-') ? arg : UNKNOWN;
      }
    }
    const options = (fork ? args[2] || (args[1]?.props ? args[1] : null) : args[2]) || UNKNOWN;
    const stdio = options.props?.get('stdio');
    const flags = ['detached', 'windowsHide'].filter(k => options.props?.get(k)?.literal === true);
    if (stdio?.literal === 'ignore' || stdio?.items?.some(v => v.literal === 'ignore')) flags.push('stdio:ignore');
    let raw = target?.literal;
    let artifactPath = target?.artifact;
    const cwd = options.props?.get('cwd');
    if (typeof raw === 'string' && !raw.startsWith('/') && !/^[A-Za-z]:/.test(raw) && isString(cwd)) {
      raw = cwd.literal.replace(/\/$/, '') + '/' + raw; artifactPath = cwd.artifact;
    }
    const resolved = artifactPath ? anchored(raw) : null;
    const edge = { index: node.start, method: fn.method, target: resolved, hidden: flags.length > 0, flags,
      reason: resolved !== null ? null : typeof raw !== 'string' ? 'computed Node script target' : 'Node script path is outside the artifact or depends on inherited cwd' };
    if (result.edges.length < 256) result.edges.push(edge);
    else diagnostic(node, 'execution edge limit (256)');
    return { kind: 'child', edge };
  }
  function walk(node, scope, loops = 0) {
    if (!node) return UNKNOWN;
    if (++work > 200000 || ++depth > 160) throw new Error('execution graph work/depth limit');
    try {
      switch (node.type) {
        case 'Literal': return value(node.value);
        case 'Identifier': return scope.get(node.name) || ({ require: tag('require'), process: tag('process'),
          eval: tag('dynamic-code'), Function: tag('dynamic-code'), globalThis: tag('global'), global: tag('global'), window: tag('global'),
          __dirname: value(dirname, true), __filename: value(ROOT + file, true) }[node.name]) || UNKNOWN;
        case 'Program': return sequence(node.body, scope, loops);
        case 'BlockStatement': return sequence(node.body, new Scope(scope), loops);
        case 'SequenceExpression': {
          let last = UNKNOWN;
          for (const expression of node.expressions) last = walk(expression, scope, loops);
          return last;
        }
        case 'ReturnStatement': {
          const returned = walk(node.argument, scope, loops);
          if (hasEvaluator(returned)) diagnostic(node, 'dynamic code execution alias escapes runtime graph');
          return returned;
        }
        case 'VariableDeclaration': for (const d of node.declarations) bind(d.id, walk(d.init, scope, loops), scope); return UNKNOWN;
        case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': {
          const local = new Scope(scope.clone());
          if (node.id) local.set(node.id.name, tag('function'), true);
          for (const p of node.params) bind(p, UNKNOWN, local);
          const returned = walk(node.body, local, 0);
          if (node.type === 'ArrowFunctionExpression' && node.expression && hasEvaluator(returned)) diagnostic(node, 'dynamic code execution alias escapes runtime graph');
          return tag('function');
        }
        case 'ImportDeclaration': {
          const raw = node.source.value, mod = moduleValue(raw);
          if (raw.startsWith('.')) result.imports.push(raw);
          for (const s of node.specifiers) scope.set(s.local.name, s.type === 'ImportSpecifier' ? property(mod, key(s.imported)) : mod, true);
          return UNKNOWN;
        }
        case 'ExportAllDeclaration': case 'ExportNamedDeclaration':
          if (node.source?.value?.startsWith('.')) result.imports.push(node.source.value);
          return walk(node.declaration, scope, loops);
        case 'TemplateLiteral': {
          const parts = node.expressions.map(n => walk(n, scope, loops));
          return parts.every(v => ['string', 'number'].includes(typeof v.literal))
            ? value(node.quasis.map((q, i) => (q.value.cooked ?? q.value.raw) + (i < parts.length ? parts[i].literal : '')).join(''),
              node.quasis[0].value.cooked === '' && parts[0]?.artifact === true) : UNKNOWN;
        }
        case 'BinaryExpression': {
          const a = walk(node.left, scope, loops), b = walk(node.right, scope, loops);
          return node.operator === '+' && isString(a) && isString(b) ? value(a.literal + b.literal, a.artifact) : UNKNOWN;
        }
        case 'LogicalExpression': case 'ConditionalExpression': {
          const left = walk(node.test || node.left, scope, loops);
          const a = scope.clone(), b = scope.clone();
          const x = node.consequent ? walk(node.consequent, a, loops) : left;
          const y = walk(node.alternate || node.right, b, loops);
          joinScopes(scope, a, b);
          // Evaluator functions are truthy. Reading their name through an AND
          // expression returns the right operand, not the capability itself.
          if (node.type === 'LogicalExpression' && ['dynamic-code', 'dynamic-code-bind', 'global-factory'].includes(left.kind)) {
            return node.operator === '&&' ? y : left;
          }
          if (hasEvaluator(x) || hasEvaluator(y)) {
            diagnostic(node, 'dynamic code execution alias escapes runtime graph');
            return tag('dynamic-code');
          }
          return x === y || (Object.hasOwn(x, 'literal') && x.literal === y.literal && x.artifact === y.artifact) ? x : UNKNOWN;
        }
        case 'IfStatement': {
          walk(node.test, scope, loops);
          const a = scope.clone(), b = scope.clone();
          walk(node.consequent, a, loops); walk(node.alternate, b, loops); joinScopes(scope, a, b); return UNKNOWN;
        }
        case 'SpreadElement': {
          const spread = walk(node.argument, scope, loops);
          if (hasEvaluator(spread)) diagnostic(node, 'dynamic code execution alias escapes runtime graph');
          return UNKNOWN;
        }
        case 'ArrayExpression': {
          if (node.elements.length >= 8 && node.elements.every(n => n?.type === 'Literal' && typeof n.value === 'string')) features.stringTables++;
          return { items: node.elements.map(n => walk(n, scope, loops)) };
        }
        case 'ObjectExpression': {
          const props = new Map();
          for (const p of node.properties) {
            const k = p.computed ? walk(p.key, scope, loops).literal : key(p.key);
            const v = walk(p.value || p.argument, scope, loops);
            if (p.type === 'SpreadElement') { for (const [name, entry] of v.props || []) props.set(name, entry); }
            else props.set(k, p.kind === 'get' || p.kind === 'set' ? UNKNOWN : v);
          }
          return { props };
        }
        case 'MemberExpression': {
          if (node.computed && node.property.type !== 'Literal') features.computedAccesses++;
          return property(walk(node.object, scope, loops), node.computed ? walk(node.property, scope, loops).literal : key(node.property));
        }
        case 'AssignmentExpression': {
          const v = walk(node.right, scope, loops);
          if (node.left.type === 'Identifier') scope.set(node.left.name, node.operator === '=' || hasEvaluator(v) ? v : UNKNOWN);
          else {
            if (hasEvaluator(v)) diagnostic(node, 'dynamic code execution alias escapes runtime graph');
            walk(node.left, scope, loops);
          }
          return v;
        }
        case 'CallExpression': case 'NewExpression': {
          // Structural rotation, with the same table receiver on both calls.
          const c = node.callee, inner = node.arguments[0];
          if (c.type === 'MemberExpression' && key(c.property) === 'push' && inner?.type === 'CallExpression' &&
              inner.callee.type === 'MemberExpression' && key(inner.callee.property) === 'shift' &&
              c.object.type === 'Identifier' && inner.callee.object.type === 'Identifier' && c.object.name === inner.callee.object.name) features.rotations++;
          const fn = walk(c, scope, loops), args = node.arguments.map(n => walk(n, scope, loops));
          if (args.some(hasEvaluator)) diagnostic(node, 'dynamic code execution alias escapes runtime graph');
          // Literal source passed to an evaluator is not ordinary example
          // text. Its imports depend on evaluation scope, which this bounded
          // graph does not model. Keep a coverage gap instead of silently
          // losing the nested executable source when ignoring string literals.
          const evaluatorSyntax = c.type === 'Identifier' && ['eval', 'Function'].includes(c.name);
          if (fn.kind === 'global-factory') return tag('global');
          if (fn.kind === 'dynamic-code' || fn.kind === 'dynamic-code-bind' || evaluatorSyntax) {
            const inert = evaluatorSyntax && fn.kind === 'dynamic-code' && node.arguments.length === 1
              ? inertLiteral(node.arguments[0], c.name) : null;
            if (inert) return inert;
            diagnostic(node, 'dynamic code execution is not modeled in runtime graph');
            return fn.kind === 'dynamic-code-bind' ? tag('dynamic-code') : UNKNOWN;
          }
          // Preserve literal require-shaped calls even when receiver/binding
          // inference is ambiguous (for example a branch reassigns require).
          // This remains conservative for locally defined require methods;
          // unlike a text search it cannot match examples inside literals.
          const requireSyntax = (c.type === 'Identifier' && c.name === 'require') ||
            (c.type === 'MemberExpression' && !c.computed && key(c.property) === 'require');
          if (fn.kind === 'require' || requireSyntax) {
            if (!isString(args[0])) { features.dynamicLoads++; diagnostic(node, 'computed module specifier'); }
            if (args[0]?.literal?.startsWith?.('.')) result.imports.push(args[0].literal);
            if (fn.kind === 'require') return moduleValue(args[0]?.literal);
          }
          if (fn.kind === 'path-call' && args.length && args.every(isString)) {
            const parts = args.map(v => v.literal);
            const start = fn.method === 'resolve' ? parts.reduce((last, p, i) => p.startsWith('/') ? i : last, 0) : 0;
            const raw = parts.slice(start).join('/');
            const rel = anchored(raw);
            return rel !== null && args[start].artifact ? value(ROOT + rel, true) : UNKNOWN;
          }
          if (fn.kind === 'subprocess') return subprocess(node, fn, args);
          if (fn.kind === 'unref') { fn.edge.hidden = true; if (!fn.edge.flags.includes('unref')) fn.edge.flags.push('unref'); }
          return UNKNOWN;
        }
        case 'ImportExpression': {
          const v = walk(node.source, scope, loops);
          if (isString(v) && v.literal.startsWith('.')) result.imports.push(v.literal);
          else if (!isString(v)) { features.dynamicLoads++; diagnostic(node, 'computed module specifier'); }
          return UNKNOWN;
        }
        default: {
          const looping = /^(?:For|While|DoWhile)/.test(node.type);
          if (node.type === 'SwitchStatement' && loops) features.flattenedSwitches++;
          for (const [k, child] of Object.entries(node)) {
            if (k === 'start' || k === 'end' || k === 'type') continue;
            if (Array.isArray(child)) { for (const n of child) if (n?.type) walk(n, scope, loops + Number(looping)); }
            else if (child?.type) walk(child, scope, loops + Number(looping));
          }
          return ['ClassDeclaration', 'ClassExpression'].includes(node.type) ? tag('function') : UNKNOWN;
        }
      }
    } finally { depth--; }
  }
  try { walk(ast, new Scope()); }
  catch { result.status = 'budget'; diagnostic(null, 'execution graph work/depth limit'); }
  // Minification and a lookup table alone are not evidence of packing. Require
  // rotation or flattened control flow plus concealed loading/indirection.
  if (features.stringTables && ((features.rotations && features.dynamicLoads) ||
      (features.flattenedSwitches && features.computedAccesses >= 8 && features.dynamicLoads))) {
    result.structure = { kind: 'string-table-loader', ...features };
  }
  return result;
}

function createExecutionGraph(files, seeds, installSeeds = new Set(), lifecycleSeeds = new Set()) {
  const sources = new Map(files.map(f => [f.path.replace(/\\/g, '/').replace(/^\.\//, ''), f.content || '']));
  const facts = new Map(), runtime = new Set(seeds), installTime = new Set(installSeeds), lifecycle = new Set(lifecycleSeeds);
  const edges = [], gaps = [], expanded = new Map();
  let bytes = 0;
  function analyze(file) {
    if (facts.has(file)) return facts.get(file);
    const content = sources.get(file);
    if (content === undefined) return null;
    if ((bytes += content.length) > 8 * 1024 * 1024 || facts.size >= 512) {
      const f = { edges: [], imports: [], gaps: [{index:0,reason:'execution graph package limit (8 MiB / 512 files)'}], status: 'budget' };
      facts.set(file, f); return f;
    }
    const f = analyzeExecutionFile(file, content); facts.set(file, f); return f;
  }
  const queue = [...runtime];
  for (let i = 0; i < queue.length && i < 20000; i++) {
    const file = queue[i], state = Number(installTime.has(file)) + 2 * Number(lifecycle.has(file));
    if (expanded.get(file) === state) continue;
    const first = !expanded.has(file); expanded.set(file, state);
    const f = analyze(file);
    if (!f) { gaps.push({file,index:0,reason:'runtime target was not collected'}); continue; }
    if (first) gaps.push(...f.gaps.map(g => ({file,...g})));
    const targets = [];
    for (const spec of f.imports) {
      const rel = normalize(file.slice(0, file.lastIndexOf('/') + 1) + spec);
      const target = rel !== null && EXTENSIONS.map(ext => rel + ext).find(p => sources.has(p));
      if (target) targets.push(target);
    }
    for (const e of f.edges) {
      const exists = e.target !== null && sources.has(e.target);
      if (first) edges.push({file,...e,resolved:exists});
      if (exists) targets.push(e.target);
      else if (first) gaps.push({file,index:e.index,reason:e.reason || `Node script target was not collected: ${e.target}`});
    }
    for (const target of targets) {
      runtime.add(target);
      if (installTime.has(file)) installTime.add(target);
      if (lifecycle.has(file)) lifecycle.add(target);
      queue.push(target);
    }
  }
  if (queue.length > 20000) gaps.push({file:queue[0],index:0,reason:'execution graph reachability limit'});
  return { facts, runtime, installTime, lifecycle, edges, gaps };
}

module.exports = { analyzeExecutionFile, createExecutionGraph };
