"use strict";

const acorn = require("./vendor/acorn/acorn");

// Bounded abstract interpretation. These values describe source; they never
// execute it. REVIEW means a modeled sensitive value reaches an outbound sink.
const SECRET = 1, REMOTE = 2, ENV = 4;
const clean = () => ({ bits: 0 });
const tagged = kind => ({ bits: 0, kind });
const literal = value => ({ bits: 0, value });
const secretKey = key => /TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL/i.test(key);
function stateContext() { return { copies: new Map(), joins: new Map(), work: 0 }; }
function stateTick(context, depth) {
  if (++context.work > 40000 || depth > 128) throw new Error('flow state budget');
}
// Copy the abstract heap, not just binding maps. One memo preserves aliases,
// closure environments and cycles within a snapshot, never across branches.
function copyState(value, context = stateContext(), depth = 0) {
  if (!value || typeof value !== 'object') return value;
  if (context.copies.has(value)) return context.copies.get(value);
  stateTick(context, depth);
  const out = value instanceof Scope ? new Scope() : Array.isArray(value) ? [] : value instanceof Map ? new Map() : {};
  context.copies.set(value, out);
  if (value instanceof Map) for (const [key, item] of value) out.set(key, copyState(item, context, depth + 1));
  else for (const key of Object.keys(value)) out[key] = key === 'node' ? value[key] : copyState(value[key], context, depth + 1);
  return out;
}
function joinMemo(values, context, create) {
  let table = context.joins;
  for (const value of values) {
    if (!table.has(value)) table.set(value, new Map());
    table = table.get(value);
  }
  if (table.has(null)) return [table.get(null), true];
  const out = create(); table.set(null, out); return [out, false];
}
function merge(...values) { return joinValues(values, stateContext()); }
function joinValues(values, context, depth = 0) {
  const present = values.filter(Boolean);
  if (present.length === 1) return present[0];
  if (present.length && present.every(v => v === present[0])) return present[0];
  stateTick(context, depth);
  const [out, seen] = joinMemo(present, context, () => ({ bits: present.reduce((n, v) => n | v.bits, 0) }));
  if (seen) return out;
  if (present.length && present.every(v => v.kind === 'function' && v.node === present[0].node)) {
    out.kind = 'function'; out.node = present[0].node;
    out.scope = joinStates(null, present.map(v => v.scope), context, depth + 1);
  }
  // A callable is more than its kind: dropping node/scope/target at a branch
  // join produced malformed functions and TypeErrors on ordinary TS helpers.
  else if (present.some(v => v.node || v.target || v.kind === 'alternatives')) {
    const alternatives = [...new Set(present.flatMap(v => v.alternatives || [v]))];
    Object.assign(out, { kind: 'alternatives', alternatives: alternatives.slice(0, 8), overflow: alternatives.length > 8 || present.some(v => v.overflow) });
    return out;
  }
  if (present.length && present.every(v => v.kind === present[0].kind)) out.kind = present[0].kind;
  if (present.length && present.every(v => Object.hasOwn(v, 'value') && v.value === present[0].value)) out.value = present[0].value;
  const keys = new Set(present.flatMap(v => v.props ? [...v.props.keys()] : []));
  if (keys.size || present.some(v => v.props)) out.props = new Map([...keys].map(k => [k, joinValues(present.map(v => v.props?.get(k) || clean()), context, depth + 1)]));
  if (present.some(v => v.elements)) {
    const length = Math.max(...present.map(v => v.elements?.length || 0));
    out.elements = Array.from({ length }, (_, i) => joinValues(present.map(v => v.elements?.[i] || clean()), context, depth + 1));
  }
  return out;
}
function joinStates(dest, scopes, context = stateContext(), depth = 0) {
  if (scopes.every(s => !s)) return null;
  stateTick(context, depth);
  const [out, seen] = joinMemo(scopes, context, () => dest || new Scope());
  if (seen) return out;
  out.parent = joinStates(out.parent, scopes.map(s => s?.parent), context, depth + 1);
  const keys = new Set(scopes.flatMap(s => s ? [...s.vars.keys()] : []));
  // Read all branches before changing a destination that might be one of them.
  const entries = [...keys].map(key => [key, scopes.map(s => s?.get(key) || clean())]);
  for (const [key, values] of entries) out.vars.set(key, joinValues(values, context, depth + 1));
  return out;
}
function property(object, key) {
  if (object.kind === 'alternatives') return merge(...object.alternatives.map(v => property(v, key)));
  if (object.kind === 'function' && key === 'prototype') {
    object.props ||= new Map();
    if (!object.props.has(key)) object.props.set(key, {bits:0,props:new Map()});
  }
  if (object.kind === 'global' && ['process', 'Bun', 'fetch', 'WebSocket', 'Function', 'Proxy', 'Reflect', 'Map', 'Object', 'Array', 'setTimeout', 'setInterval'].includes(key)) return tagged(key);
  if (['process', 'Bun'].includes(object.kind) && key === 'env') return { bits: ENV, kind: 'env' };
  if (object.props?.has(key)) return object.props.get(key);
  if (object.elements && /^\d+$/.test(String(key)) && Number(key) < object.elements.length) return object.elements[Number(key)] || clean();
  if (object.elements && ['at', 'pop', 'shift', 'push', 'unshift', 'slice', 'filter', 'map', 'forEach', 'find'].includes(key)) {
    return { bits: object.bits, kind: 'array-method', method: key, target: object };
  }
  if (object.kind === 'env') return key === undefined || secretKey(String(key)) ? { bits: SECRET } : clean();
  if (object.kind === 'map' && ['get', 'set'].includes(key)) return { bits: object.bits, kind: `map-${key}`, target: object };
  if (object.kind === 'Object' && ['values', 'entries'].includes(key)) return tagged(`object-${key}`);
  if (object.kind === 'Array' && ['of', 'from'].includes(key)) return tagged(`array-${key}`);
  if (object.bits & REMOTE && ['then', 'catch', 'finally'].includes(key)) return { bits: object.bits, kind: 'promise-chain', target: object };
  // `value.constructor.constructor` reaches the Function constructor without
  // spelling Function or eval. Preserve that intrinsic chain for remote-code
  // flow checks while leaving ordinary single `.constructor` reads inert.
  if (key === 'constructor' && ['intrinsic-constructor', 'function', 'array-method', 'map-get', 'map-set', 'fetch', 'sink', 'request', 'shell'].includes(object.kind)) return tagged('Function');
  if (key === 'constructor') return tagged('intrinsic-constructor');
  if (object.kind === 'https' && ['request', 'get'].includes(key)) return tagged('request');
  if (object.kind === 'dns' && ['resolve', 'resolve4', 'resolveTxt', 'lookup'].includes(key)) return tagged('sink');
  if (object.kind === 'child_process' && ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'].includes(key)) return tagged('shell');
  if (['net', 'tls'].includes(object.kind) && ['connect', 'createConnection', 'Socket', 'TLSSocket'].includes(key)) return tagged('socket-create');
  if (object.kind === 'socket' && ['write', 'end', 'send'].includes(key)) return tagged('sink');
  if (object.kind === 'socket' && ['connect', 'on', 'once'].includes(key)) return tagged('socket-create');
  if (object.kind === 'Reflect' && ['get', 'apply', 'construct'].includes(key)) return tagged(`reflect-${key}`);
  if (['call', 'apply', 'bind'].includes(key) && object.kind) return { bits: object.bits, kind: `invoke-${key}`, target: object };
  if (object.kind === 'vm' && ['runInNewContext', 'runInThisContext', 'runInContext'].includes(key)) return tagged('vm');
  if (object.kind === 'request-stream' && ['end', 'write'].includes(key)) return tagged('sink');
  if (object.kind === 'websocket' && key === 'send') return tagged('sink');
  if (key === 'sendBeacon') return tagged('sink');
  return { bits: object.bits & ~ENV };
}
class Scope {
  constructor(parent = null) { this.parent = parent; this.vars = new Map(); }
  get(name) { return this.vars.has(name) ? this.vars.get(name) : this.parent?.get(name); }
  set(name, value, declare = false) {
    if (declare || this.vars.has(name) || !this.parent) this.vars.set(name, value);
    else this.parent.set(name, value);
  }
  clone(context) { return copyState(this, context); }
}
function normalizeFile(file) {
  const out = [];
  for (const part of file.replace(/\\/g, '/').split('/')) {
    if (part === '..') { if (!out.length) return null; out.pop(); }
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}
function createFlowAnalysis(files) {
  const sources = new Map(files.map(f => [normalizeFile(f.path), f.content || '']));
  const cache = new Map(), active = new Set();
  let totalBytes = 0, work = 0;
  function analyze(file) {
    file = normalizeFile(file);
    if (cache.has(file)) return cache.get(file);
    if (active.has(file)) return { hints: [], exports: clean(), status: 'cycle' };
    const source = sources.get(file);
    const result = { hints: [], exports: clean(), status: 'parsed', gaps: [] };
    cache.set(file, result);
    if (source === undefined) { result.status = 'missing'; return result; }
    if (source.length > 1024 * 1024 || (totalBytes += source.length) > 8 * 1024 * 1024 || cache.size > 512) {
      result.status = 'budget'; return result;
    }
    let ast;
    try {
      // Acorn parses syntax only. No dynamic imports or source callbacks run.
      ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowHashBang: true });
    } catch { result.status = 'unsupported'; return result; }
    active.add(file);
    const seen = new Set();
    const callbacks = [];
    const activeFunctions = new Map();
    let depth = 0;
    let currentNode = ast;
    const tick = () => { if (++work > 500000 || depth > 160) throw new Error('flow budget'); };
    const hint = (node, kind) => {
      const key = `${node.start}:${kind}`;
      if (!seen.has(key) && result.hints.length < 8) { seen.add(key); result.hints.push({ index: node.start, kind }); }
    };
    function load(raw) {
      if (typeof raw !== 'string') return clean();
      if (!raw.startsWith('.')) {
        const name = raw.replace(/^node:/, '');
        return tagged(name === 'http' ? 'https' : name);
      }
      const target = normalizeFile(file.slice(0, file.lastIndexOf('/') + 1) + raw);
      if (!target) return clean();
      const resolved = ['', '.js', '.cjs', '.mjs', '/index.js', '/index.cjs', '/index.mjs'].map(ext => target + ext).find(name => sources.has(name));
      if (!resolved) { result.status = 'missing'; return clean(); }
      if (active.has(resolved)) { result.status = 'cycle'; return clean(); }
      const dep = analyze(resolved);
      if (dep.status !== 'parsed') result.status = dep.status === 'unsupported' ? 'unmodeled' : dep.status;
      return dep.exports;
    }
    function bind(pattern, value, scope, declare = true) {
      if (!pattern) return;
      tick();
      if (pattern.type === 'Identifier') scope.set(pattern.name, value, declare);
      else if (pattern.type === 'AssignmentPattern') bind(pattern.left, merge(value, expr(pattern.right, scope)), scope, declare);
      else if (pattern.type === 'ObjectPattern') for (const p of pattern.properties) {
        if (p.type === 'RestElement') bind(p.argument, value, scope, declare);
        else bind(p.value, property(value, p.computed ? expr(p.key, scope).value : p.key.name ?? p.key.value), scope, declare);
      }
      else if (pattern.type === 'ArrayPattern') pattern.elements.forEach((p, i) => bind(p, property(value, i), scope, declare));
    }
    function invoke(fn, args, isolated = false) {
      const signature = args.map(v => `${v.bits}:${v.kind || ''}`).join('|');
      const active = activeFunctions.get(fn.node) || new Set();
      // Revisit a recursive function when new taint arrives, but don't expand
      // the same abstract call forever. The caller still scans the whole body.
      if (active.has(signature)) return merge(...args);
      active.add(signature); activeFunctions.set(fn.node, active);
      const context = stateContext();
      const savedExports = result.exports;
      const local = new Scope(isolated ? fn.scope.clone(context) : fn.scope);
      if (isolated) result.exports = copyState(result.exports, context);
      local.set('this', {bits:0,props:new Map()}, true);
      fn.node.params.forEach((p, i) => bind(p, args[i] || clean(), local));
      try { return fn.node.body.type === 'BlockStatement' ? stmt(fn.node.body, local) : expr(fn.node.body, local); }
      finally { active.delete(signature); if (isolated) result.exports = savedExports; }
    }
    function gap(reason = 'unmodeled executable semantics', node = currentNode, relevant = true) {
      if (relevant && result.status === 'parsed') result.status = 'unmodeled';
      if (!result.gaps.some(g => g.index === node.start && g.reason === reason)) {
        result.gaps.push({ index: node.start, nodeType: node.type, reason, relevant });
        result.gaps.sort((a, b) => Number(b.relevant) - Number(a.relevant) || a.index - b.index);
        result.gaps.length = Math.min(result.gaps.length, 8);
      }
    }
    function callValue(node, callee, args) {
      tick();
      const value = merge(...args);
      if (callee.kind === 'alternatives') {
        if (callee.overflow) gap('callable alternatives limit', node);
        return merge(...callee.alternatives.map(fn => callValue(node, fn, args)));
      }
      if (callee.kind === 'require') return load(args[0]?.value);
      if (callee.kind === 'reflect-get') return property(args[0] || clean(), args[1]?.value);
      if (['reflect-apply', 'reflect-construct'].includes(callee.kind)) {
        const list = args[callee.kind === 'reflect-apply' ? 2 : 1];
        if (!list?.elements) { gap(); return value; }
        return callValue(node, args[0] || clean(), list.elements);
      }
      if (callee.kind === 'invoke-call') return callValue(node, callee.target, args.slice(1));
      if (callee.kind === 'invoke-apply') {
        if (!args[1]?.elements) { gap(); return value; }
        return callValue(node, callee.target, args[1].elements);
      }
      if (callee.kind === 'invoke-bind') return { bits: 0, kind: 'bound', target: callee.target, args: args.slice(1) };
      if (callee.kind === 'bound') return callValue(node, callee.target, [...callee.args, ...args]);
      if (callee.kind === 'map-get') return callee.target.props?.get(args[0]?.value) || clean();
      if (callee.kind === 'map-set') {
        if (args[0]?.value === undefined) { gap(); return callee.target; }
        callee.target.props.set(args[0].value, args[1] || clean());
        callee.target.bits |= (args[1]?.bits || 0);
        return callee.target;
      }
      if (callee.kind === 'Map') {
        const props = new Map();
        for (const pair of args[0]?.elements || []) {
          if (pair?.elements?.length >= 2 && pair.elements[0]?.value !== undefined) props.set(pair.elements[0].value, pair.elements[1]);
          else gap();
        }
        return { bits: merge(...props.values()).bits, kind: 'map', props };
      }
      if (callee.kind === 'object-values' || callee.kind === 'object-entries') {
        const entries = [...(args[0]?.props || new Map()).entries()];
        const elements = callee.kind === 'object-values'
          ? entries.map(([, entry]) => entry)
          : entries.map(([key, entry]) => ({ ...merge(literal(key), entry), elements: [literal(key), entry] }));
        return { ...merge(args[0] || clean(), ...elements), elements };
      }
      if (callee.kind === 'array-of') return { ...merge(...args), elements: args };
      if (callee.kind === 'array-from') {
        if (!args[0]?.elements) { gap(); return value; }
        return { ...args[0], elements: [...args[0].elements] };
      }
      if (callee.kind === 'array-method') {
        const elements = callee.target.elements;
        if (callee.method === 'at') {
          const index = Number(args[0]?.value || 0);
          return elements[index < 0 ? elements.length + index : index] || clean();
        }
        if (callee.method === 'pop') return elements.pop() || clean();
        if (callee.method === 'shift') return elements.shift() || clean();
        if (callee.method === 'push' || callee.method === 'unshift') {
          elements[callee.method === 'push' ? 'push' : 'unshift'](...args);
          callee.target.bits |= value.bits;
          return literal(elements.length);
        }
        const callback = args.find(arg => arg.kind === 'function');
        if (callback) invoke(callback, [merge(...elements)]);
        if (callee.method === 'find') return merge(...elements);
        if (callee.method === 'forEach') return clean();
        return { ...callee.target, elements: [...elements] };
      }
      if (callee.kind === 'promise-chain') {
        const callback = args.find(arg => arg.kind === 'function');
        if (!callback) return callee.target;
        return merge(callee.target, invoke(callback, [callee.target]));
      }
      if (['fetch', 'request', 'sink', 'shell', 'socket-create'].includes(callee.kind) && value.bits & (SECRET | ENV)) hint(node, 'credential-export');
      if (callee.kind === 'fetch') return { bits: REMOTE };
      if (callee.kind === 'request') return tagged('request-stream');
      if (callee.kind === 'socket-create') {
        for (const arg of args) if (arg.kind === 'function') callbacks.push(arg);
        return tagged('socket');
      }
      if (callee.kind === 'WebSocket') return tagged('websocket');
      if (callee.kind === 'vm' && value.bits & REMOTE) hint(node, 'remote-vm-code');
      if (callee.kind === 'function') return invoke(callee, args);
      if (callee.kind === 'class') return callee;
      if (callee.kind === 'Proxy') {
        // Preserve the target's taint; arbitrary traps are not modeled.
        gap(); return args[0] || value;
      }
      if (callee.kind === 'Function') {
        if (value.bits & REMOTE) hint(node, 'remote-vm-code');
        if (args.length === 1 && /^\s*return\s+(?:this|globalThis)\s*;?\s*$/.test(args[0]?.value || '')) return tagged('global-factory');
        return tagged('compiled-function');
      }
      if (callee.kind === 'compiled-function') return clean();
      if (callee.kind === 'global-factory') return tagged('global');
      if (['setTimeout', 'setInterval'].includes(callee.kind) && typeof args[0]?.value === 'string') gap();
      // Preserve fetched text through .text(), encoders and JSON.stringify.
      return merge(value, { bits: callee.bits });
    }
    function classValue(node, scope) {
      expr(node.superClass, scope);
      if (node.superClass) gap(); // inheritance and constructor effects need review
      const value = { bits: 0, kind: 'class', props: new Map() };
      const local = new Scope(scope);
      if (node.id) local.set(node.id.name, value, true);
      local.set('this', value, true);
      for (const member of node.body.body) {
        if (member.type === 'StaticBlock') { statements(member.body, local); continue; }
        const key = member.computed ? expr(member.key, local).value : member.key.name ?? member.key.value;
        const v = expr(member.value, local);
        value.props.set(key, v);
        value.bits |= v.bits;
        if (member.kind === 'get' || member.kind === 'set' || member.kind === 'constructor') gap();
      }
      return value;
    }
    function mayWrite(node) {
      if (!node || typeof node !== 'object') return false;
      tick();
      if (['AssignmentExpression', 'UpdateExpression', 'CallExpression', 'NewExpression',
        'TaggedTemplateExpression', 'ClassExpression', 'ClassDeclaration'].includes(node.type)) return true;
      // Constructing a function does not execute its body. Dormant inspection
      // already isolates its state. Pure boolean tests need no heap snapshot.
      if (['FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) return false;
      return Object.entries(node).some(([key, value]) => key !== 'loc' &&
        (Array.isArray(value) ? value.some(mayWrite) : value && typeof value === 'object' && mayWrite(value)));
    }
    function expr(node, scope) {
      if (!node) return clean();
      const previousNode = currentNode; currentNode = node;
      tick(); depth++;
      try {
        switch (node.type) {
          case 'Literal': return literal(node.value);
          case 'Identifier': return scope.get(node.name) || tagged(({ process: 'process', Bun: 'Bun', fetch: 'fetch', WebSocket: 'WebSocket', require: 'require', Reflect: 'Reflect', Proxy: 'Proxy', Function: 'Function', Map: 'Map', Object: 'Object', Array: 'Array', setTimeout: 'setTimeout', setInterval: 'setInterval', globalThis: 'global', global: 'global' })[node.name]);
          case 'ThisExpression': return scope.get('this') || clean();
          case 'MetaProperty': return clean();
          case 'ClassExpression': case 'ClassDeclaration': return classValue(node, scope);
          case 'TemplateLiteral': return merge(...node.expressions.map(n => expr(n, scope)));
          case 'TaggedTemplateExpression': expr(node.tag, scope); return expr(node.quasi, scope);
          case 'ChainExpression': case 'AwaitExpression': case 'YieldExpression': return expr(node.expression || node.argument, scope);
          case 'MemberExpression': return property(expr(node.object, scope), node.computed ? expr(node.property, scope).value : node.property.name);
          case 'ObjectExpression': {
            const props = new Map(); let bits = 0, env = false;
            for (const p of node.properties) {
              if (p.type === 'SpreadElement') { const v = expr(p.argument, scope); bits |= v.bits; env ||= v.kind === 'env'; for (const [k, x] of v.props || []) props.set(k, x); }
              else { if (p.kind === 'get' || p.kind === 'set') gap(); const v = expr(p.value, scope); props.set(p.computed ? expr(p.key, scope).value : p.key.name ?? p.key.value, v); bits |= v.bits; }
            }
            return { bits, props, kind: env ? 'env' : undefined };
          }
          case 'ArrayExpression': { const elements = node.elements.map(n => expr(n, scope)); return { ...merge(...elements), elements }; }
          case 'SpreadElement': return expr(node.argument, scope);
          case 'UnaryExpression': case 'UpdateExpression': return expr(node.argument, scope);
          case 'LogicalExpression': {
            const left = expr(node.left, scope);
            if (!mayWrite(node.right)) return merge(left, expr(node.right, scope));
            return branches(scope, s => expr(node.right, s), () => left);
          }
          case 'BinaryExpression': {
            const left = expr(node.left, scope), right = expr(node.right, scope);
            if (node.operator === '+' && typeof left.value === 'string' && typeof right.value === 'string') return literal(left.value + right.value);
            return merge(left, right);
          }
          case 'ConditionalExpression': expr(node.test, scope); return branches(scope,
            s => expr(node.consequent, s), s => expr(node.alternate, s));
          case 'SequenceExpression': { let v = clean(); for (const n of node.expressions) v = expr(n, scope); return v; }
          case 'AssignmentExpression': {
            const v = node.operator === '=' ? expr(node.right, scope) : merge(expr(node.left, scope), expr(node.right, scope));
            if (node.left.type === 'MemberExpression') {
              const key = node.left.computed ? expr(node.left.property, scope).value : node.left.property.name;
              const obj = node.left.object;
              if (obj.type === 'Identifier' && obj.name === 'module' && key === 'exports' && !scope.get('module')) result.exports = v;
              else if ((obj.type === 'Identifier' && obj.name === 'exports' && !scope.get('exports')) ||
                (obj.type === 'MemberExpression' && obj.object.name === 'module' && obj.property.name === 'exports' && !scope.get('module'))) {
                result.exports.props ||= new Map(); result.exports.props.set(key, v); result.exports.bits |= v.bits;
              } else if (obj.type === 'Identifier') {
                const old = scope.get(obj.name) || clean();
                old.props ||= new Map(); old.props.set(key, v); old.bits |= v.bits;
                if (old.elements && /^\d+$/.test(String(key))) {
                  if (Number(key) > 4096) gap('array index limit', node);
                  else old.elements[Number(key)] = v;
                }
                scope.set(obj.name, old);
              } else {
                const target = expr(obj, scope);
                if (target.props) { target.props.set(key, v); target.bits |= v.bits; }
                else gap('unresolved object assignment', node, Boolean(v.bits || v.kind));
              }
            } else bind(node.left, v, scope, false);
            return v;
          }
          case 'FunctionExpression': case 'ArrowFunctionExpression': {
            const fn = { bits: 0, kind: 'function', node, scope };
            invoke(fn, [], true);
            return fn;
          }
          case 'ImportExpression': {
            const value = expr(node.source, scope);
            if (value.bits & REMOTE) hint(node, 'remote-code-import');
            return clean();
          }
          case 'CallExpression': case 'NewExpression': {
            const callee = expr(node.callee, scope), args = node.arguments.map(n => expr(n, scope));
            return callValue(node, callee, args);
          }
          default: gap(); return clean();
        }
      } catch (error) { error.flowNode ||= node; throw error; }
      finally { depth--; currentNode = previousNode; }
    }
    function joinScopes(dest, a, b) {
      return joinStates(dest, [a, b]);
    }
    function snapshot(scope) {
      const context = stateContext();
      return { scope: scope.clone(context), exports: copyState(result.exports, context) };
    }
    function branches(scope, left, right) {
      const a = snapshot(scope), b = snapshot(scope);
      result.exports = a.exports;
      const va = left(a.scope); a.exports = result.exports;
      result.exports = b.exports;
      const vb = right(b.scope); b.exports = result.exports;
      const context = stateContext();
      joinStates(scope, [a.scope, b.scope], context);
      result.exports = joinValues([a.exports, b.exports], context);
      return joinValues([va, vb], context);
    }
    function statements(nodes, scope) {
      // Predeclare lexical/function names so shadowed globals never acquire
      // ambient process/fetch semantics merely because their declaration is later.
      for (const n of nodes) {
        if (n.type === 'VariableDeclaration') for (const d of n.declarations) bind(d.id, clean(), scope);
        const fn = n.type === 'ExportNamedDeclaration' ? n.declaration : n;
        if (fn?.type === 'FunctionDeclaration') scope.set(fn.id.name, { bits: 0, kind: 'function', node: fn, scope }, true);
      }
      // Only return-bearing statements contribute a function's result. A
      // prototype assignment is a side effect, not another possible return.
      return merge(...nodes.map(n => stmt(n, scope)).filter(v => v.bits || v.kind || v.props || v.elements || Object.hasOwn(v, 'value')));
    }
    function stmt(node, scope) {
      if (!node) return clean();
      const previousNode = currentNode; currentNode = node;
      tick(); depth++;
      try {
        switch (node.type) {
          case 'Program': return statements(node.body, scope);
          case 'BlockStatement': return statements(node.body, new Scope(scope));
          case 'VariableDeclaration': for (const d of node.declarations) bind(d.id, expr(d.init, scope), scope); break;
          case 'ExpressionStatement': expr(node.expression, scope); break;
          case 'ReturnStatement': return expr(node.argument, scope);
          case 'ThrowStatement': expr(node.argument, scope); break;
          case 'FunctionDeclaration': {
            const fn = scope.get(node.id.name);
            // Inspect dormant bodies as well as calls, but isolate their writes.
            if (fn?.kind === 'function') invoke(fn, [], true);
            break;
          }
          case 'ClassDeclaration': scope.set(node.id.name, classValue(node, scope), true); break;
          case 'EmptyStatement': case 'DebuggerStatement': case 'BreakStatement': case 'ContinueStatement': break;
          case 'LabeledStatement': return stmt(node.body, scope);
          case 'IfStatement': {
            expr(node.test, scope);
            return branches(scope, s => stmt(node.consequent, s), s => stmt(node.alternate, s));
          }
          case 'SwitchStatement': {
            expr(node.discriminant, scope);
            // Each case may be the entry point, or may receive state from a
            // preceding fallthrough. Keep the no-match path and join each
            // suffix conservatively without quadratic case re-evaluation.
            const initial = snapshot(scope), before = initial.scope, exported = initial.exports;
            const falling = scope.clone();
            const values = [];
            for (const branch of node.cases) {
              joinScopes(falling, before, falling.clone());
              expr(branch.test, falling);
              values.push(statements(branch.consequent, falling));
              joinScopes(scope, scope.clone(), falling.clone());
              result.exports = merge(exported, result.exports);
            }
            return merge(...values);
          }
          case 'ForStatement': case 'ForOfStatement': case 'ForInStatement':
          case 'WhileStatement': case 'DoWhileStatement': {
            const initial = snapshot(scope), before = initial.scope, exported = initial.exports;
            if (node.init?.type === 'VariableDeclaration') stmt(node.init, scope); else expr(node.init, scope);
            expr(node.right, scope); expr(node.test, scope);
            // Two bounded passes catch simple loop-carried values. Merge the
            // zero-iteration path so a loop cannot erase a pre-existing secret.
            for (let pass = 0; pass < 2; pass++) { stmt(node.body, scope); expr(node.update, scope); }
            joinScopes(scope, before, scope.clone());
            result.exports = merge(exported, result.exports);
            break;
          }
          case 'TryStatement': {
            const before = snapshot(scope);
            const normal = stmt(node.block, scope);
            let caught = clean();
            if (node.handler) {
              // Exceptions can arise before or after modeled writes. Keep both
              // entry states, then join the normal and caught continuations.
              const completed = snapshot(scope);
              joinScopes(scope, before.scope, completed.scope);
              result.exports = merge(before.exports, completed.exports);
              caught = branches(scope, s => stmt(node.handler, s), () => clean());
            }
            const final = stmt(node.finalizer, scope);
            return merge(normal, caught, final);
          }
          case 'CatchClause': { const local = new Scope(scope); bind(node.param, clean(), local); return stmt(node.body, local); }
          case 'ImportDeclaration': {
            const value = load(node.source.value);
            for (const s of node.specifiers) scope.set(s.local.name, s.type === 'ImportSpecifier' ? property(value, s.imported.name) : value, true);
            break;
          }
          case 'ExportDefaultDeclaration': result.exports = expr(node.declaration, scope); break;
          case 'ExportNamedDeclaration': {
            if (node.declaration) stmt(node.declaration, scope);
            const value = node.source ? load(node.source.value) : null;
            const props = result.exports.props || new Map();
            for (const s of node.specifiers) props.set(s.exported.name, value ? property(value, s.local.name) : scope.get(s.local.name) || clean());
            if (node.declaration?.type === 'VariableDeclaration') for (const d of node.declaration.declarations) if (d.id.name) props.set(d.id.name, scope.get(d.id.name));
            result.exports = { bits: merge(...props.values()).bits, props };
            break;
          }
          default: gap(); break;
        }
        return clean();
      } catch (error) { error.flowNode ||= node; throw error; }
      finally { depth--; currentNode = previousNode; }
    }
    try {
      stmt(ast, new Scope());
      for (let i = 0; i < callbacks.length; i++) { tick(); invoke(callbacks[i], []); }
    }
    catch (error) {
      result.status = 'budget';
      const node = error.flowNode || currentNode;
      result.gaps.unshift({ index: node.start, nodeType: node.type,
        reason: error.message === 'flow budget' ? 'flow work/depth limit' : `flow evaluator could not complete: ${error.name}: ${error.message}` });
    }
    finally { active.delete(file); }
    return result;
  }
  return { analyze };
}
module.exports = { createFlowAnalysis };
