import path from 'node:path';
import { builtinModules } from 'node:module';
import acorn from './vendor/acorn/acorn.cjs';
import { Project, AnalysisGap } from './project.mjs';

const DEFAULTS = Object.freeze({ maxPackages: 2048, maxModules: 128, maxFileBytes: 256 * 1024,
  maxLockBytes: 2 * 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024, maxSteps: 50000,
  maxDepth: 64, maxAstNodes: 50000, maxFindings: 100, maxGaps: 100, maxTraces: 32, maxPaths: 64 });
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
const val = (kind = 'unknown', fields = {}) => ({ kind, traces: [], ...fields });
const literal = value => val('literal', { value });
const obj = entries => val('object', { props: new Map(entries) });
class Scope {
  constructor(parent, frame = false) { this.parent = parent; this.bindings = new Map(); this.kinds = new Map(); this.frame = frame || !parent ? this : parent.frame; }
  get(name) { return this.bindings.has(name) ? this.bindings.get(name) : this.parent?.get(name); }
  has(name) { return this.bindings.has(name) || Boolean(this.parent?.has(name)); }
  set(name, value, kind) { this.bindings.set(name, value); if (kind) this.kinds.set(name, kind); }
  owner(name) { return this.bindings.has(name) ? this : this.parent?.owner(name); }
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
  let project, steps = 0, astNodes = 0, paths = 1;
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
    if (value.kind === 'union') for (const child of value.options) all.push(...traces(child, depth + 1));
    const unique = [...new Map(all.map(trace => [JSON.stringify(trace), trace])).values()];
    if (unique.length > limits.maxTraces) gap('trace-budget', 'Some dataflow paths were truncated.');
    return unique.slice(0, limits.maxTraces);
  }
  function withStep(value, step, depth = 0) {
    tick(depth);
    const copy = { ...value, traces: value.traces.map(trace => [...trace, step]) };
    if (value.kind === 'object') copy.props = new Map([...value.props].map(([key, child]) => [key, withStep(child, step, depth + 1)]));
    if (value.kind === 'union') copy.options = value.options.map(child => withStep(child, step, depth + 1));
    return copy;
  }
  function merged(values) {
    const all = values.flatMap(value => traces(value));
    if (all.length > limits.maxTraces) gap('trace-budget', 'Some dataflow paths were truncated.');
    return val('unknown', { traces: all.slice(0, limits.maxTraces) });
  }

  function alternatives(value) { return value.kind === 'union' ? value.options : [value]; }
  function union(values) {
    const options = [...new Set(values.flatMap(alternatives))];
    if (options.length === 1) return options[0];
    if (options.length > limits.maxTraces) { gap('alternative-budget', 'Value alternatives exceeded the limit.'); return merged(options); }
    return val('union', { options });
  }
  const truth = value => value.kind === 'literal' ? Boolean(value.value)
    : ['object', 'function', 'regexp'].includes(value.kind) ? true : undefined;

  // Save and restore the same lexical environments and export objects, so
  // closures/aliases keep their identity while alternative paths are explored.
  function snapshot(scope) {
    const scopes = new Map(), objects = new Map(), seen = new Set();
    const pending = [scope, ...cache.values()];
    while (pending.length) {
      tick(0);
      const item = pending.pop();
      if (!item || seen.has(item)) continue;
      seen.add(item);
      if (item instanceof Scope) {
        scopes.set(item, new Map(item.bindings)); pending.push(item.parent, ...item.bindings.values());
      } else {
        if (item.kind === 'object') { objects.set(item, new Map(item.props)); pending.push(...item.props.values()); }
        if (item.kind === 'function') pending.push(item.scope);
        if (item.kind === 'union') pending.push(...item.options);
      }
    }
    return { scopes, objects };
  }
  function restore(state) {
    for (const [scope, values] of state.scopes) scope.bindings = new Map(values);
    for (const [object, values] of state.objects) object.props = new Map(values);
  }
  function fork(scope, file, node, left, right) {
    gap('uncertain-control-flow', 'Both alternatives were explored without proving path feasibility.', loc(file, node));
    if (++paths > limits.maxPaths) fail('path-budget', 'Alternative path limit exceeded.');
    const before = snapshot(scope);
    let a, b, afterA, afterB;
    try { a = left(); afterA = snapshot(scope); }
    finally { restore(before); }
    try { b = right(); afterB = snapshot(scope); }
    finally { restore(before); }
    for (const category of ['scopes', 'objects']) {
      for (const [target, baseline] of before[category]) {
        const x = afterA[category].get(target) || baseline, y = afterB[category].get(target) || baseline;
        const joined = new Map([...new Set([...x.keys(), ...y.keys()])].map(key => [key, union([x.get(key) || literal(undefined), y.get(key) || literal(undefined)])]));
        if (category === 'scopes') target.bindings = joined; else target.props = joined;
      }
    }
    return union([a, b]);
  }

  function preflight(ast, file) {
    const stack = [{ node: ast, depth: 0 }];
    while (stack.length) {
      const { node, depth } = stack.pop();
      if (++astNodes > limits.maxAstNodes || depth > limits.maxDepth) fail('ast-budget', 'Syntax node/depth limit exceeded.');
      for (const value of Object.values(node)) {
        if (value?.type) stack.push({ node: value, depth: depth + 1 });
        else if (Array.isArray(value)) for (const child of value) if (child?.type) stack.push({ node: child, depth: depth + 1 });
      }
    }
  }

  function member(object, key, file, node) {
    if (object.kind === 'union') return union(object.options.map(value => member(value, key, file, node)));
    if (typeof key !== 'string' && typeof key !== 'number') return unknown(file, node, 'Computed property is not a known literal.');
    key = String(key);
    if (object.kind === 'object') {
      if (object.props.has(key)) return object.props.get(key);
      if (!['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty', 'toLocaleString', 'isPrototypeOf', 'propertyIsEnumerable', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__'].includes(key)) return literal(undefined);
      return unknown(file, node, `Unmodeled object property: ${key}`);
    }
    if (object.kind === 'literal' && typeof object.value === 'string' && key === 'length') return literal(object.value.length);
    if (object.kind === 'Math' && ['abs', 'round', 'floor', 'ceil', 'min', 'max', 'trunc'].includes(key)) return val('primitive-call', { name: `Math.${key}` });
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

  function primitive(value) { return value.kind === 'literal' || value.kind === 'secret'; }
  function calculated(value, inputs = []) {
    if (typeof value === 'string' && value.length > limits.maxFileBytes) fail('value-budget', 'Computed string exceeds the value limit.');
    return { ...literal(value), traces: merged(inputs).traces };
  }
  const operations = {
    '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => a / b, '%': (a, b) => a % b,
    '===': (a, b) => a === b, '!==': (a, b) => a !== b, '==': (a, b) => a == b, '!=': (a, b) => a != b,
    '<': (a, b) => a < b, '>': (a, b) => a > b, '<=': (a, b) => a <= b, '>=': (a, b) => a >= b,
    '|': (a, b) => a | b, '&': (a, b) => a & b, '^': (a, b) => a ^ b,
  };
  function binary(operator, left, right, file, node) {
    if (!Object.hasOwn(operations, operator)) return unknown(file, node, `Unmodeled operator: ${operator}`);
    const values = [];
    for (const a of alternatives(left)) for (const b of alternatives(right)) {
      tick(0);
      if (!primitive(a) || !primitive(b)) { values.push(unknown(file, node, 'Unknown operand or object coercion is not modeled.')); continue; }
      if (a.kind === 'literal' && b.kind === 'literal') values.push(calculated(operations[operator](a.value, b.value), [a, b]));
      else values.push(merged([a, b]));
    }
    return union(values);
  }

  function declareVars(body, frame, file) {
    const pending = [...body];
    while (pending.length) {
      const node = pending.pop(); tick(0);
      if (['FunctionExpression', 'FunctionDeclaration', 'ArrowFunctionExpression'].includes(node.type)) {
        if (node.type === 'FunctionDeclaration' && !body.includes(node)) {
          frame.set(node.id.name, unknown(file, node, 'Block function declarations have unsupported Annex B semantics.'));
        }
        continue;
      }
      if (node.type === 'VariableDeclaration' && node.kind === 'var') {
        for (const dec of node.declarations) {
          if (dec.id.type !== 'Identifier') { unknown(file, dec, 'Destructuring declarations are not modeled.'); continue; }
          if (!frame.bindings.has(dec.id.name)) frame.set(dec.id.name, literal(undefined), 'var');
        }
      }
      for (const value of Object.values(node)) {
        if (value?.type) pending.push(value);
        else if (Array.isArray(value)) for (const child of value) if (child?.type) pending.push(child);
      }
    }
  }

  function expression(node, scope, file, depth) {
    tick(depth);
    if (!node) return literal(undefined);
    if (node.optional) return unknown(file, node, 'Optional chaining is not modeled.');
    switch (node.type) {
      case 'Literal':
        if (node.bigint) return unknown(file, node, 'BigInt is not modeled.');
        if (node.regex) return val('regexp'); // Never run a target-supplied RegExp.
        return literal(node.value);
      case 'Identifier': {
        if (scope.has(node.name)) {
          const value = scope.get(node.name);
          if (value.kind === 'uninitialized') return unknown(file, node, `Binding read before initialization: ${node.name}`, 'uninitialized-binding');
          return value;
        }
        if (node.name === 'undefined') return literal(undefined);
        if (['require', 'process', 'fetch', 'JSON', 'console', 'Math'].includes(node.name)) return val(node.name);
        if (['String', 'Number', 'Boolean', 'parseFloat', 'parseInt', 'isFinite', 'isNaN'].includes(node.name)) return val('primitive-call', { name: node.name });
        return unknown(file, node, `Unresolved identifier: ${node.name}`, 'unresolved-binding');
      }
      case 'FunctionExpression': case 'ArrowFunctionExpression':
        if (node.async || node.generator) return unknown(file, node, 'Async/generator functions are not modeled.');
        return val('function', { node, scope, file });
      case 'MemberExpression': {
        const target = expression(node.object, scope, file, depth + 1);
        const key = node.computed ? expression(node.property, scope, file, depth + 1).value : node.property.name;
        return member(target, key, file, node);
      }
      case 'ObjectExpression': {
        const entries = [];
        for (const prop of node.properties) {
          if (prop.type !== 'Property' || prop.kind !== 'init' || prop.method) return unknown(file, prop, 'Getters, methods and spreads are not modeled.');
          const key = prop.computed ? expression(prop.key, scope, file, depth + 1).value : prop.key.name ?? prop.key.value;
          if (typeof key !== 'string' && typeof key !== 'number') return unknown(file, prop, 'Unknown object key.');
          if (key === '__proto__') return unknown(file, prop, 'Prototype changes are not modeled.');
          entries.push([String(key), expression(prop.value, scope, file, depth + 1)]);
        }
        return obj(entries);
      }
      case 'ArrayExpression': return obj([...node.elements.map((value, i) => [String(i), expression(value, scope, file, depth + 1)]), ['length', literal(node.elements.length)]]);
      case 'BinaryExpression': {
        const left = expression(node.left, scope, file, depth + 1), right = expression(node.right, scope, file, depth + 1);
        return binary(node.operator, left, right, file, node);
      }
      case 'UnaryExpression': {
        if (node.operator === 'typeof' && node.argument.type === 'Identifier' && !scope.has(node.argument.name) &&
            !['undefined', 'require', 'process', 'fetch', 'JSON', 'console', 'Math', 'String', 'Number', 'Boolean', 'parseFloat', 'parseInt', 'isFinite', 'isNaN'].includes(node.argument.name)) {
          return unknown(file, node, `Cannot establish whether host global exists: ${node.argument.name}`, 'unmodeled-global');
        }
        const value = expression(node.argument, scope, file, depth + 1);
        if (node.operator === 'void') return literal(undefined);
        if (node.operator === '!') { const test = truth(value); return test === undefined ? merged([value]) : calculated(!test, [value]); }
        if (node.operator === 'typeof') {
          if (value.kind === 'literal') return calculated(typeof value.value, [value]);
          if (value.kind === 'function') return literal('function');
          if (['object', 'regexp'].includes(value.kind)) return literal('object');
          if (['require', 'fetch', 'primitive-call'].includes(value.kind)) return literal('function');
          if (['process', 'JSON', 'console', 'Math'].includes(value.kind)) return literal('object');
          return merged([value]);
        }
        if (['+', '-', '~'].includes(node.operator) && value.kind === 'literal') return calculated(node.operator === '+' ? +value.value : node.operator === '-' ? -value.value : ~value.value, [value]);
        if (['+', '-', '~'].includes(node.operator) && value.kind === 'secret') return merged([value]);
        return unknown(file, node, `Unmodeled unary operation: ${node.operator}`);
      }
      case 'LogicalExpression': {
        const left = expression(node.left, scope, file, depth + 1);
        const test = node.operator === '??' ? (left.kind === 'literal' ? left.value !== null && left.value !== undefined : undefined) : truth(left);
        const evaluateRight = () => expression(node.right, scope, file, depth + 1);
        if (test !== undefined) return node.operator === '&&' ? (test ? evaluateRight() : left) : (test ? left : evaluateRight());
        return fork(scope, file, node, () => left, evaluateRight);
      }
      case 'ConditionalExpression': {
        const test = truth(expression(node.test, scope, file, depth + 1));
        const yes = () => expression(node.consequent, scope, file, depth + 1), no = () => expression(node.alternate, scope, file, depth + 1);
        return test === undefined ? fork(scope, file, node, yes, no) : test ? yes() : no();
      }
      case 'TemplateLiteral': {
        const values = node.expressions.map(value => expression(value, scope, file, depth + 1));
        if (values.every(value => value.kind === 'literal')) {
          let output = '';
          for (let i = 0; i < node.quasis.length; i++) output = calculated(output + node.quasis[i].value.cooked + (i < values.length ? String(values[i].value) : '')).value;
          return calculated(output, values);
        }
        if (values.some(value => !['literal', 'secret', 'unknown'].includes(value.kind))) return unknown(file, node, 'Template object coercion is not modeled.');
        return merged(values);
      }
      case 'AssignmentExpression': {
        const left = node.left;
        const target = left.type === 'Identifier' ? scope.owner(left.name) : undefined;
        const previous = target?.get(left.name);
        let value = expression(node.right, scope, file, depth + 1);
        if (target && target.frame === scope.frame && !['const', 'builtin'].includes(target.kinds.get(left.name)) && previous.kind !== 'uninitialized') {
          if (node.operator !== '=') value = binary(node.operator.slice(0, -1), previous, value, file, node);
          target.set(left.name, value); return value;
        }
        if (left.type === 'Identifier') return unknown(file, node, 'Assignment to a constant, outer scope, or undeclared/uninitialized binding is not modeled.');
        if (node.operator !== '=') return unknown(file, node, 'Compound object mutation is not modeled.');
        if (scope.frame.isFunction) return unknown(file, node, 'Object/export mutation inside functions is not modeled.', 'unsupported-syntax');
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
        return invoke(target, args, node, scope, file, depth + 1);
      }
      default: return unknown(file, node, `Unmodeled expression: ${node.type}`);
    }
  }

  function invoke(target, args, node, scope, file, depth) {
    tick(depth);
    if (target.kind === 'union') {
      const explore = options => options.length === 1 ? invoke(options[0], args, node, scope, file, depth + 1)
        : fork(scope, file, node, () => invoke(options[0], args, node, scope, file, depth + 1), () => explore(options.slice(1)));
      return explore(target.options);
    }
    if (target.kind === 'primitive-call') {
      const builtins = { String, Number, Boolean, parseFloat, parseInt, isFinite, isNaN,
        'Math.abs': Math.abs, 'Math.round': Math.round, 'Math.floor': Math.floor,
        'Math.ceil': Math.ceil, 'Math.min': Math.min, 'Math.max': Math.max, 'Math.trunc': Math.trunc };
      if (!args.every(primitive)) return unknown(file, node, 'Primitive builtin with object or unknown operands is not modeled.');
      if (args.every(value => value.kind === 'literal')) return calculated(builtins[target.name](...args.map(value => value.value)), args);
      return { ...merged(args), kind: 'secret' };
    }
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
      const callScope = new Scope(target.scope, true);
      callScope.isFunction = true;
      target.node.params.forEach((param, i) => callScope.set(param.name, withStep(args[i] || literal(undefined), step), 'param'));
      if (target.node.id && !callScope.bindings.has(target.node.id.name)) callScope.set(target.node.id.name, target, 'const');
      if (target.node.body.type === 'BlockStatement') declareVars(target.node.body.body, callScope, target.file);
      activeCalls.add(target.node);
      try {
        const returned = target.node.body.type === 'BlockStatement'
          ? statements(target.node.body.body, callScope, target.file, depth + 1)
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

  function statements(body, scope, file, depth, done = () => literal(undefined)) {
    tick(depth);
    for (const node of body) {
      if (node.type === 'FunctionDeclaration') {
        if (scope !== scope.frame) unknown(file, node, 'Block function declarations have unsupported Annex B semantics.');
        scope.set(node.id.name, node.async || node.generator ? unknown(file, node, 'Async/generator functions are not modeled.') : val('function', { node, scope, file }), 'function');
      }
      if (node.type === 'VariableDeclaration' && node.kind !== 'var') for (const dec of node.declarations) {
        if (dec.id.type === 'Identifier') scope.set(dec.id.name, val('uninitialized'), node.kind);
      }
    }
    const run = index => {
      if (index >= body.length) return done();
      return statement(body[index], scope, file, depth + 1, () => run(index + 1));
    };
    return run(0);
  }

  function statement(node, scope, file, depth, next) {
    tick(depth);
    if (!node) return next();
    switch (node.type) {
      case 'VariableDeclaration':
        for (const dec of node.declarations) {
          if (dec.id.type !== 'Identifier') { unknown(file, dec, 'Destructuring is not modeled.'); continue; }
          const target = node.kind === 'var' ? scope.frame : scope;
          if (node.kind !== 'var' || dec.init) target.set(dec.id.name, expression(dec.init, scope, file, depth + 1), node.kind);
        }
        return next();
      case 'ExpressionStatement': expression(node.expression, scope, file, depth + 1); return next();
      case 'ReturnStatement': return expression(node.argument, scope, file, depth + 1);
      case 'FunctionDeclaration': case 'EmptyStatement': return next();
      case 'BlockStatement': return statements(node.body, new Scope(scope), file, depth + 1, next);
      case 'IfStatement': {
        const condition = truth(expression(node.test, scope, file, depth + 1));
        const yes = () => statement(node.consequent, scope, file, depth + 1, next);
        const no = () => statement(node.alternate, scope, file, depth + 1, next);
        return condition === undefined ? fork(scope, file, node, yes, no) : condition ? yes() : no();
      }
      case 'ThrowStatement':
        expression(node.argument, scope, file, depth + 1);
        return unknown(file, node, 'An exception path was reached; exception propagation is not modeled.', 'exception-path');
      default: unknown(file, node, `Unmodeled statement: ${node.type}`, 'unsupported-syntax'); return next();
    }
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
      preflight(ast, file);
      const scope = new Scope();
      const exports = obj([]); exports.isExports = true;
      const module = obj([['exports', exports]]); module.isModule = true;
      scope.set('module', module, 'builtin'); scope.set('exports', exports, 'builtin');
      declareVars(ast.body, scope, file);
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
    findings, gaps, stats: { modules: cache.size, sourceBytes: project?.totalBytes || 0, steps, astNodes, paths }, limits };
}
