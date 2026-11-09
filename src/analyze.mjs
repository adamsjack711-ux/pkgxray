import path from 'node:path';
import { builtinModules } from 'node:module';
import acorn from './vendor/acorn/acorn.cjs';
import { Project, AnalysisGap } from './project.mjs';

const DEFAULTS = Object.freeze({ maxPackages: 2048, maxModules: 128, maxFileBytes: 256 * 1024,
  maxLockBytes: 2 * 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024, maxSteps: 50000,
  maxDepth: 64, maxAstNodes: 50000, maxFindings: 100, maxGaps: 100, maxTraces: 32 });
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
const val = (kind = 'unknown', fields = {}) => ({ kind, traces: [], ...fields });
const literal = value => val('literal', { value });
const obj = entries => val('object', { props: new Map(entries) });
class Scope {
  constructor(parent) { this.parent = parent; this.bindings = new Map(); }
  get(name) { return this.bindings.has(name) ? this.bindings.get(name) : this.parent?.get(name); }
  has(name) { return this.bindings.has(name) || Boolean(this.parent?.has(name)); }
  set(name, value) { this.bindings.set(name, value); }
}

// This is deliberately a small AST interpreter. It does not invoke target
// JavaScript, perform HTTP requests, or use Node's loader for target imports.
export function analyzeProject({ root, entry = 'index.js', limits: overrides = {} }) {
  const limits = { ...DEFAULTS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in limits) || !Number.isSafeInteger(value) || value < 1 || value > DEFAULTS[key]) throw new TypeError(`Invalid limit: ${key}`);
    limits[key] = value;
  }
  const gaps = [], findings = [], edges = [], cache = new Map(), activeModules = new Set(), activeCalls = new Set();
  const gapKeys = new Set(), findingKeys = new Set();
  let project, steps = 0, astNodes = 0;
  const gap = (code, message, location = {}) => {
    const key = JSON.stringify([code, message, location]);
    if (gapKeys.has(key)) return;
    if (gaps.length >= limits.maxGaps) {
      gaps[limits.maxGaps - 1] = { code: 'gap-budget', message: 'Additional analysis gaps were truncated.' };
      return;
    }
    gapKeys.add(key); gaps.push({ code, message, ...location });
  };
  const fail = (code, message) => { throw new AnalysisGap(code, message); };
  const tick = depth => {
    if (++steps > limits.maxSteps || depth > limits.maxDepth) fail('analysis-budget', 'Evaluation step/depth limit exceeded.');
  };
  const loc = (file, node) => project.reference(file, node);
  const unknown = (file, node, message, code = 'unsupported-semantics') => { gap(code, message, loc(file, node)); return val(); };

  function traces(value, depth = 0) {
    tick(depth);
    let all = [...value.traces];
    if (value.kind === 'object') for (const child of value.props.values()) all.push(...traces(child, depth + 1));
    const unique = [...new Map(all.map(trace => [JSON.stringify(trace), trace])).values()];
    if (unique.length > limits.maxTraces) gap('trace-budget', 'Some dataflow paths were truncated.');
    return unique.slice(0, limits.maxTraces);
  }
  function withStep(value, step, depth = 0) {
    tick(depth);
    const copy = { ...value, traces: value.traces.map(trace => [...trace, step]) };
    if (value.kind === 'object') copy.props = new Map([...value.props].map(([key, child]) => [key, withStep(child, step, depth + 1)]));
    return copy;
  }
  function merged(values) {
    const all = values.flatMap(value => traces(value));
    if (all.length > limits.maxTraces) gap('trace-budget', 'Some dataflow paths were truncated.');
    return val('unknown', { traces: all.slice(0, limits.maxTraces) });
  }

  const accepted = new Set(['Program', 'VariableDeclaration', 'VariableDeclarator', 'Identifier', 'Literal', 'ExpressionStatement',
    'CallExpression', 'MemberExpression', 'ObjectExpression', 'Property', 'ArrayExpression', 'FunctionExpression', 'FunctionDeclaration',
    'ArrowFunctionExpression', 'BlockStatement', 'ReturnStatement', 'AssignmentExpression', 'BinaryExpression', 'TemplateLiteral', 'TemplateElement', 'EmptyStatement']);
  function preflight(ast, file) {
    const stack = [{ node: ast, depth: 0, inFunction: false }];
    let supported = true;
    while (stack.length) {
      const { node, depth, inFunction } = stack.pop();
      if (++astNodes > limits.maxAstNodes || depth > limits.maxDepth) fail('ast-budget', 'Syntax node/depth limit exceeded.');
      if (!accepted.has(node.type) || node.async || node.generator || node.optional ||
          (node.type === 'Property' && (node.kind !== 'init' || node.method)) ||
          (node.type === 'AssignmentExpression' && (node.operator !== '=' || inFunction)) ||
          (node.type === 'BinaryExpression' && node.operator !== '+') ||
          (node.type === 'Literal' && (node.regex || node.bigint)) ||
          (node.type === 'VariableDeclaration' && node.kind === 'var')) {
        gap('unsupported-syntax', `Unsupported syntax: ${node.type}${node.operator ? ` (${node.operator})` : ''}`, loc(file, node)); supported = false;
      }
      const childInFunction = inFunction || ['FunctionExpression', 'FunctionDeclaration', 'ArrowFunctionExpression'].includes(node.type);
      for (const value of Object.values(node)) {
        if (value?.type) stack.push({ node: value, depth: depth + 1, inFunction: childInFunction });
        else if (Array.isArray(value)) for (const child of value) if (child?.type) stack.push({ node: child, depth: depth + 1, inFunction: childInFunction });
      }
    }
    return supported;
  }

  function member(object, key, file, node) {
    if (typeof key !== 'string' && typeof key !== 'number') return unknown(file, node, 'Computed property is not a known literal.');
    key = String(key);
    if (object.kind === 'object') {
      if (object.props.has(key)) return object.props.get(key);
      return unknown(file, node, `Unmodeled object property: ${key}`);
    }
    if (object.kind === 'process' && key === 'env') return val('environment', {
      traces: [[{ kind: 'source', label: 'process.env', ...loc(file, node) }]],
    });
    if (object.kind === 'environment') return val('secret', {
      traces: [[{ kind: 'source', label: `process.env.${key}`, ...loc(file, node) }]],
    });
    if (object.kind === 'JSON' && key === 'stringify') return val('stringify');
    if (object.kind === 'console' && ['log', 'info', 'warn', 'error'].includes(key)) return val('console-call');
    if (object.kind === 'http' && ['request', 'get'].includes(key)) return val('http-call', { label: `${object.label}.${key}` });
    if (object.kind === 'request' && ['write', 'end'].includes(key)) return val('network-sink', { label: `${object.label}.${key}`, destination: object.destination });
    return unknown(file, node, `Unmodeled property access: ${key}`);
  }

  function sink(values, label, destination, file, node) {
    for (const trace of values.flatMap(value => traces(value))) {
      const route = [...trace, { kind: 'sink', label, ...loc(file, node) }];
      const key = JSON.stringify(route);
      if (findingKeys.has(key)) continue;
      if (findings.length >= limits.maxFindings) { gap('finding-budget', 'Additional findings were truncated.'); return; }
      findingKeys.add(key);
      const packages = [...new Set(route.map(step => step.package.id))];
      findings.push({ category: 'sensitive-data-to-network', severity: 'review', crossPackage: packages.length > 1,
        message: 'Environment data reaches a modeled network call; check whether this transfer is authorized.',
        destination: typeof destination === 'string' ? destination : null, trace: route });
    }
  }

  function expression(node, scope, file, depth) {
    tick(depth);
    if (!node) return literal(undefined);
    switch (node.type) {
      case 'Literal': return literal(node.value);
      case 'Identifier': {
        if (scope.has(node.name)) {
          const value = scope.get(node.name);
          if (value.kind === 'uninitialized') return unknown(file, node, `Binding read before initialization: ${node.name}`, 'uninitialized-binding');
          return value;
        }
        if (node.name === 'undefined') return literal(undefined);
        if (['require', 'process', 'fetch', 'JSON', 'console'].includes(node.name)) return val(node.name);
        return unknown(file, node, `Unresolved identifier: ${node.name}`, 'unresolved-binding');
      }
      case 'FunctionExpression': case 'ArrowFunctionExpression': return val('function', { node, scope, file });
      case 'MemberExpression': {
        const target = expression(node.object, scope, file, depth + 1);
        const key = node.computed ? expression(node.property, scope, file, depth + 1).value : node.property.name;
        return member(target, key, file, node);
      }
      case 'ObjectExpression': {
        const entries = [];
        for (const prop of node.properties) {
          const key = prop.computed ? expression(prop.key, scope, file, depth + 1).value : prop.key.name ?? prop.key.value;
          if (typeof key !== 'string' && typeof key !== 'number') return unknown(file, prop, 'Unknown object key.');
          if (key === '__proto__') return unknown(file, prop, 'Prototype changes are not modeled.');
          entries.push([String(key), expression(prop.value, scope, file, depth + 1)]);
        }
        return obj(entries);
      }
      case 'ArrayExpression': return obj(node.elements.map((value, i) => [String(i), expression(value, scope, file, depth + 1)]));
      case 'BinaryExpression': {
        const left = expression(node.left, scope, file, depth + 1), right = expression(node.right, scope, file, depth + 1);
        if (left.kind === 'literal' && right.kind === 'literal') return literal(left.value + right.value);
        if ([left, right].some(value => !['literal', 'secret', 'unknown'].includes(value.kind))) return unknown(file, node, 'Object coercion is not modeled.');
        return merged([left, right]);
      }
      case 'TemplateLiteral': {
        const values = node.expressions.map(value => expression(value, scope, file, depth + 1));
        if (values.every(value => value.kind === 'literal')) return literal(node.quasis.map((part, i) => part.value.cooked + (i < values.length ? String(values[i].value) : '')).join(''));
        if (values.some(value => !['literal', 'secret', 'unknown'].includes(value.kind))) return unknown(file, node, 'Template object coercion is not modeled.');
        return merged(values);
      }
      case 'AssignmentExpression': {
        const value = expression(node.right, scope, file, depth + 1);
        // Local mutation, aliased object writes and outer-scope side effects are
        // outside this first straight-line slice. Only CJS exports are modeled.
        const left = node.left;
        if (left.type === 'MemberExpression' && !left.computed) {
          if (left.object.type === 'Identifier' && left.object.name === 'module' && scope.get('module')?.kind === 'object' && scope.get('module').isModule) {
            if (left.property.name === 'exports') { scope.get('module').props.set('exports', value); return value; }
          }
          if (left.object.type === 'Identifier' && left.object.name === 'exports' && scope.get('exports')?.isExports) {
            if (left.property.name === '__proto__') return unknown(file, node, 'Export prototype changes are not modeled.');
            scope.get('exports').props.set(left.property.name, value); return value;
          }
        }
        return unknown(file, node, 'Only direct module.exports and exports.name assignments are modeled.');
      }
      case 'CallExpression': {
        const target = expression(node.callee, scope, file, depth + 1);
        const args = node.arguments.map(arg => expression(arg, scope, file, depth + 1));
        if (target.kind === 'require') {
          if (node.arguments.length !== 1 || node.arguments[0].type !== 'Literal' || typeof node.arguments[0].value !== 'string') return unknown(file, node, 'Dynamic require is not modeled.', 'dynamic-import');
          const specifier = node.arguments[0].value;
          if (specifier === 'http' || specifier === 'https' || specifier === 'node:http' || specifier === 'node:https') return val('http', { label: specifier });
          if (builtins.has(specifier.replace(/^node:/, '')) || specifier.startsWith('node:')) return unknown(file, node, `Unmodeled Node builtin: ${specifier}`, 'unsupported-builtin');
          try {
            const resolved = project.resolve(file, specifier);
            edges.push({ specifier, from: loc(file, node), to: project.reference(resolved) });
            const result = load(resolved, depth + 1);
            return withStep(result, { kind: 'import', label: specifier, ...loc(file, node) });
          } catch (error) { gap(error.code || 'resolution-error', error.message, loc(file, node)); return val(); }
        }
        if (target.kind === 'function') {
          if (activeCalls.has(target.node)) return unknown(file, node, 'Recursive calls are not modeled.', 'call-cycle');
          if (target.node.params.some(param => param.type !== 'Identifier')) return unknown(file, node, 'Only identifier parameters are modeled.');
          const step = { kind: 'call', label: target.node.id?.name || '(function)', ...loc(file, node), target: loc(target.file, target.node) };
          const callScope = new Scope(target.scope);
          target.node.params.forEach((param, i) => callScope.set(param.name, withStep(args[i] || literal(undefined), step)));
          if (target.node.id) callScope.set(target.node.id.name, target);
          activeCalls.add(target.node);
          try {
            const returned = target.node.body.type === 'BlockStatement'
              ? statements(target.node.body.body, callScope, target.file, depth + 1).value
              : expression(target.node.body, callScope, target.file, depth + 1);
            return withStep(returned, { kind: 'return', label: step.label, ...loc(target.file, target.node), caller: loc(file, node) });
          } finally { activeCalls.delete(target.node); }
        }
        if (target.kind === 'fetch' || target.kind === 'http-call') {
          const destination = args[0]?.value;
          sink(args, target.label || 'fetch', destination, file, node);
          if (target.kind === 'http-call') {
            if (args.some(arg => arg.kind === 'function')) gap('unsupported-callback', 'HTTP callbacks are not modeled.', loc(file, node));
            return val('request', { label: target.label, destination });
          }
          return val('response');
        }
        if (target.kind === 'network-sink') { sink(args, target.label, target.destination, file, node); return literal(undefined); }
        if (target.kind === 'stringify') {
          if (args.length !== 1 || args[0].kind === 'function') return unknown(file, node, 'Only JSON.stringify(value) without callbacks is modeled.');
          const pending = [args[0]];
          while (pending.length) {
            tick(depth);
            const value = pending.pop();
            if (value.kind === 'object') {
              if (value.props.has('toJSON')) return unknown(file, node, 'JSON toJSON callbacks are not modeled.');
              pending.push(...value.props.values());
            }
          }
          return merged(args);
        }
        if (target.kind === 'console-call') return literal(undefined);
        return unknown(file, node, 'Call target/effects are not modeled.', 'unknown-call');
      }
      default: return unknown(file, node, `Unmodeled expression: ${node.type}`);
    }
  }

  function statements(body, scope, file, depth) {
    tick(depth);
    // Reserve lexical declarations to avoid treating shadowed globals as real
    // builtins. Reads before initialization remain explicitly unresolved.
    for (const node of body) {
      if (node.type === 'FunctionDeclaration') scope.set(node.id.name, val('function', { node, scope, file }));
      if (node.type === 'VariableDeclaration') for (const dec of node.declarations) scope.set(dec.id.name, val('uninitialized'));
    }
    for (const node of body) {
      tick(depth);
      switch (node.type) {
        case 'VariableDeclaration':
          for (const dec of node.declarations) {
            if (dec.id.type !== 'Identifier') { unknown(file, dec, 'Destructuring is not modeled.'); continue; }
            scope.set(dec.id.name, expression(dec.init, scope, file, depth + 1));
          }
          break;
        case 'ExpressionStatement': expression(node.expression, scope, file, depth + 1); break;
        case 'ReturnStatement': return { returned: true, value: expression(node.argument, scope, file, depth + 1) };
        case 'FunctionDeclaration': case 'EmptyStatement': break;
        case 'BlockStatement': {
          const result = statements(node.body, new Scope(scope), file, depth + 1);
          if (result.returned) return result;
          break;
        }
        default: unknown(file, node, `Unmodeled statement: ${node.type}`);
      }
    }
    return { returned: false, value: literal(undefined) };
  }

  function load(file, depth) {
    tick(depth);
    if (activeModules.has(file)) { gap('module-cycle', `Cyclic import: ${file}`, { file }); return val(); }
    if (cache.has(file)) return cache.get(file);
    if (cache.size >= limits.maxModules) fail('module-budget', 'Module count limit exceeded.');
    cache.set(file, val());
    activeModules.add(file);
    try {
      const source = project.source(file);
      let ast;
      try { ast = acorn.parse(source, { ecmaVersion: 2022, sourceType: 'script', locations: true, allowHashBang: true }); }
      catch (error) { gap('parse-error', `Unsupported or invalid CommonJS syntax: ${error.message}`, { file }); return val(); }
      if (!preflight(ast, file)) return val();
      const scope = new Scope();
      const exports = obj([]); exports.isExports = true;
      const module = obj([['exports', exports]]); module.isModule = true;
      scope.set('module', module); scope.set('exports', exports);
      statements(ast.body, scope, file, depth + 1);
      const result = module.props.get('exports');
      cache.set(file, result);
      return result;
    } catch (error) {
      gap(error.code || 'analysis-error', error.message, { file }); return val();
    } finally { activeModules.delete(file); }
  }

  try {
    project = new Project(root, limits, gap);
    if (typeof entry !== 'string' || entry.includes('\\') || path.posix.isAbsolute(entry) || entry.split('/').includes('..')) fail('unsafe-entry', 'Entry must be a relative path inside the source tree.');
    entry = path.posix.normalize(entry);
    load(entry, 0);
  } catch (error) { gap(error.code || 'input-error', error.message); }
  const coverage = gaps.length ? 'incomplete' : 'complete-for-supported-entry';
  return { schemaVersion: 1, tool: 'package-compose-ray', entry, verdict: gaps.length ? 'incomplete' : findings.length ? 'review' : 'no-flow-found',
    coverage, scope: 'Bounded CommonJS entry analysis; no safety or malware verdict. Uncalled exports, lifecycle scripts and other entrypoints are not analyzed for flows.',
    lockfileSha256: project?.lockfileSha256 || null, packages: project?.identities() || [], imports: edges,
    findings, gaps, stats: { modules: cache.size, sourceBytes: project?.totalBytes || 0, steps, astNodes }, limits };
}
