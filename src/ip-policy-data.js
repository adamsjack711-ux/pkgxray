"use strict";

const acorn = require('./vendor/acorn/acorn');
const REFLECTIVE_NAMES = new Set(['prototype', '__proto__', 'getPrototypeOf', 'setPrototypeOf', 'defineProperty', 'defineProperties', 'Reflect', 'getBuiltinModule', 'createRequire', 'Symbol']);

// A literal used only to populate a local built-in BlockList is policy data,
// not an outbound destination. Mask only those literal occurrences for the
// IP/capability heuristic; all other detectors still receive the full source.
// Unknown syntax, aliases, mutations, escaping instances or budget exhaustion
// keep the original evidence. This does not establish package safety.
function withoutBlockListData(source) {
  if (source.length > 128 * 1024 || !source.includes('BlockList') || !/\.add(?:Subnet|Address)\s*\(/.test(source)) return source;
  try {
    const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowHashBang: true });
    const records = [], pending = [{ node: ast, parent: null }];
    while (pending.length) {
      if (records.length + pending.length > 20000) return source;
      const record = pending.pop(); records.push(record);
      for (const value of Object.values(record.node)) {
        for (const node of Array.isArray(value) ? value : [value]) {
          if (node && typeof node === 'object' && typeof node.type === 'string') pending.push({ node, parent: record.node });
        }
      }
    }
    const literal = (node, value) => node?.type === 'Literal' && (value === undefined || node.value === value);
    const constructors = new Map(), moduleLiterals = new Set(), requireCalls = new Set();
    for (const statement of ast.body) {
      if (statement.type === 'ImportDeclaration' && ['net', 'node:net'].includes(statement.source.value)) {
        if (statement.specifiers.length !== 1 || statement.specifiers[0].type !== 'ImportSpecifier' || statement.specifiers[0].imported.name !== 'BlockList') return source;
        const specifier = statement.specifiers[0];
        constructors.set(specifier.local.name, new Set([specifier.local, specifier.imported])); moduleLiterals.add(statement.source);
      }
      if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') continue;
      for (const declaration of statement.declarations) {
        const init = declaration.init;
        if (init?.type !== 'CallExpression' || init.callee.type !== 'Identifier' || init.callee.name !== 'require' ||
            init.arguments.length !== 1 || !literal(init.arguments[0]) || !['net', 'node:net'].includes(init.arguments[0].value)) continue;
        if (declaration.id.type !== 'ObjectPattern' || declaration.id.properties.length !== 1) return source;
        const property = declaration.id.properties[0];
        if (property.type !== 'Property' || property.computed || property.key.name !== 'BlockList' || property.value.type !== 'Identifier') return source;
        constructors.set(property.value.name, new Set([property.key, property.value]));
        moduleLiterals.add(init.arguments[0]); requireCalls.add(init.callee);
      }
    }
    if (!constructors.size) return source;
    const instances = new Map(), constructorUses = new Set();
    for (const statement of ast.body) {
      if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') continue;
      for (const declaration of statement.declarations) {
        const init = declaration.init;
        if (declaration.id.type === 'Identifier' && init?.type === 'NewExpression' && init.callee.type === 'Identifier' &&
            constructors.has(init.callee.name) && init.arguments.length === 0) {
          instances.set(declaration.id.name, declaration.id); constructorUses.add(init.callee);
        }
      }
    }
    if (!instances.size) return source;
    const parents = new Map(records.map(({ node, parent }) => [node, parent]));
    for (const { node, parent } of records) {
      if (literal(node) && ['net', 'node:net'].includes(node.value) && !moduleLiterals.has(node)) return source;
      if (node.type === 'ImportExpression' && !literal(node.source)) return source;
      // This exception only describes local policy construction, not files
      // that write through arbitrary object paths or dispatch computed calls.
      // Reject the shapes themselves, including dynamically spelled built-ins.
      if (node.type === 'AssignmentExpression' && node.left.type !== 'Identifier') return source;
      if (node.type === 'UpdateExpression' && node.argument.type !== 'Identifier') return source;
      if (node.type === 'UnaryExpression' && node.operator === 'delete') return source;
      if (['CallExpression', 'NewExpression'].includes(node.type) && node.callee.type === 'MemberExpression' && node.callee.computed) return source;
      // Reflection, prototype/iterator changes, and a computed second module
      // load can replace the apparent built-in methods or table iteration.
      // Such a file is outside this deliberately small data-only exception.
      if ((node.type === 'Identifier' && REFLECTIVE_NAMES.has(node.name)) || (literal(node) && REFLECTIVE_NAMES.has(node.value))) return source;
      if (node.type !== 'Identifier') continue;
      if (['eval', 'Function', 'syncBuiltinESMExports'].includes(node.name)) return source;
      if (constructors.has(node.name) && !constructors.get(node.name).has(node) && !constructorUses.has(node)) return source;
      // A shadowed require could return an arbitrary object. All other direct
      // require calls are allowed, but declarations/aliases of require are not.
      if (node.name === 'require' && !requireCalls.has(node) &&
          !(parent?.type === 'CallExpression' && parent.callee === node && parent.arguments.length === 1 && literal(parent.arguments[0]) && typeof parent.arguments[0].value === 'string')) return source;
      if (!instances.has(node.name) || instances.get(node.name) === node) continue;
      const call = parents.get(parent);
      if (parent?.type !== 'MemberExpression' || parent.object !== node || parent.computed || parent.optional ||
          !['addSubnet', 'addAddress', 'check'].includes(parent.property.name) ||
          call?.type !== 'CallExpression' || call.callee !== parent || call.optional) return source;
    }
    const method = call => call?.type === 'CallExpression' && call.callee.type === 'MemberExpression' && !call.callee.computed &&
      call.callee.object.type === 'Identifier' && instances.has(call.callee.object.name) ? call.callee.property.name : null;
    const ipv4 = node => literal(node) && typeof node.value === 'string' && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(node.value) && node.value.split('.').every(part => Number(part) <= 255);
    const masks = new Map();
    const mask = node => masks.set(node.start, node.end);
    for (const { node } of records) {
      if (method(node) === 'addAddress' && node.arguments.length === 2 && ipv4(node.arguments[0]) && literal(node.arguments[1], 'ipv4')) mask(node.arguments[0]);
      if (method(node) === 'addSubnet' && node.arguments.length === 3 && ipv4(node.arguments[0]) &&
          literal(node.arguments[1]) && Number.isInteger(node.arguments[1].value) && node.arguments[1].value >= 0 && node.arguments[1].value <= 32 && literal(node.arguments[2], 'ipv4')) mask(node.arguments[0]);
    }
    // Exact top-level literal table loop: no side effects, aliasing or escaped
    // values in the body. A second use of a subnet as a URL remains unmasked.
    for (const loop of ast.body) {
      if (loop.type !== 'ForOfStatement' || loop.await || loop.left.type !== 'VariableDeclaration' || loop.left.kind !== 'const' || loop.left.declarations.length !== 1 || loop.right.type !== 'ArrayExpression') continue;
      const pattern = loop.left.declarations[0].id;
      if (pattern.type !== 'ArrayPattern' || pattern.elements.length !== 2 || pattern.elements.some(node => node?.type !== 'Identifier')) continue;
      const body = loop.body.type === 'BlockStatement' && loop.body.body.length === 1 ? loop.body.body[0] : loop.body;
      const call = body?.type === 'ExpressionStatement' ? body.expression : null;
      if (method(call) !== 'addSubnet' || call.arguments.length !== 3 || !literal(call.arguments[2], 'ipv4') ||
          call.arguments.slice(0, 2).some((node, index) => node.type !== 'Identifier' || node.name !== pattern.elements[index].name)) continue;
      const pairs = loop.right.elements;
      if (pairs.some(pair => pair?.type !== 'ArrayExpression' || pair.elements.length !== 2 || !ipv4(pair.elements[0]) ||
          !literal(pair.elements[1]) || !Number.isInteger(pair.elements[1].value) || pair.elements[1].value < 0 || pair.elements[1].value > 32)) continue;
      for (const pair of pairs) mask(pair.elements[0]);
    }
    let result = source;
    for (const [start, end] of [...masks].sort((a, b) => b[0] - a[0])) result = result.slice(0, start) + ' '.repeat(end - start) + result.slice(end);
    return result;
  } catch { return source; }
}

module.exports = { withoutBlockListData };
