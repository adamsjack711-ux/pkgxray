"use strict";

const acorn = require('./vendor/acorn/acorn');

// Narrow source-pattern classification under standard, unmodified builtins;
// never a whole-package safety or host-integrity proof. Admit console only in
// an explicitly complete, isolated supplied artifact
// (one unique root manifest and one JavaScript source), with no other reference, alias,
// rebinding or reflective/dynamic-code access that can invalidate that model.
// Unknown syntax/uses fail closed. Never execute inspected source.
function onlyPassiveDiagnosticUrls(source, domains, context) {
  const files = context?.sourceFiles;
  const coverage = context?.sourceCoverage;
  const target = context?.filePath;
  // Per-file syntax cannot rule out mutations in a neighboring module. Missing
  // inventory/coverage is uncertainty, not an assertion that no neighbor exists.
  if (!Array.isArray(files) || files.length !== 2 || target === "package.json" ||
      typeof target !== "string" || !/\.(?:js|cjs|mjs)$/.test(target) ||
      files.filter(file => file.path === "package.json").length !== 1 ||
      files.filter(file => file.path === target && file.content === source).length !== 1 ||
      coverage?.complete !== true || coverage.scannedFiles !== files.length || coverage.inventoryFiles !== files.length ||
      coverage.skippedFiles !== 0 || coverage.truncatedFiles !== 0 ||
      !Array.isArray(coverage.reasons) || coverage.reasons.length !== 0 ||
      !Array.isArray(coverage.runtimeFiles) || !coverage.runtimeFiles.includes(target) ||
      coverage.runtimeFiles.some(file => file !== target && file !== "package.json") ||
      (coverage.installTimeFiles !== undefined && (!Array.isArray(coverage.installTimeFiles) ||
        coverage.installTimeFiles.some(file => file !== target && file !== "package.json")))) return false;
  if (typeof source !== 'string' || source.length > 1024 * 1024) return false;
  const tokens = [];
  let ast;
  try {
    ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module',
      allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true,
      allowHashBang: true, onToken: tokens });
  } catch { return false; }
  const contains = text => domains.some(domain => String(text).toLowerCase().includes(domain));
  const parents = new Map(), literals = [];
  const pending = [{ node: ast, parent: null }];
  let visited = 0;
  const diagnostics = new Set(['error', 'warn', 'log']);
  const forbidden = new Set(['eval', 'Function', 'globalThis', 'global', 'window', 'self', 'Reflect', 'process']);
  while (pending.length) {
    if (++visited > 100000) return false;
    const { node, parent } = pending.pop();
    parents.set(node, parent);
    if (node.type === 'WithStatement' || node.type === 'ThisExpression' || node.type === 'TaggedTemplateExpression') return false;
    // Computed properties can recover Function/console through escaped or
    // assembled names. This narrow exception does not resolve reflection.
    if (node.type === 'MemberExpression' && node.computed) return false;
    if (node.type === 'Identifier' && (forbidden.has(node.name) || ['constructor', '__proto__'].includes(node.name))) return false;
    if (node.type === 'Identifier' && node.name === 'require' &&
        (parent?.type !== 'CallExpression' || parent.callee !== node)) return false;
    if (node.type === 'Identifier' && node.name === 'console') {
      // Even unrelated scopes that shadow console disable the exception. This
      // intentionally avoids optimistic name resolution across closures/hoisting.
      if (parent?.type !== 'MemberExpression' || parent.object !== node || parent.computed || parent.optional ||
          !diagnostics.has(parent.property.name)) return false;
    }
    if (node.type === 'MemberExpression' && node.object?.name === 'console') {
      if (parent?.type !== 'CallExpression' || parent.callee !== node || parent.optional) return false;
    }
    if (node.type === 'Literal' && node.value === 'console' && parent?.type === 'MemberExpression') return false;
    if (node.type === 'CallExpression' && node.callee?.name === 'require') {
      // Loading arbitrary modules can replace global console through hidden
      // code. This first slice only admits the fixture's standard HTTP imports.
      if (node.arguments.length !== 1 || !['http', 'https', 'node:http', 'node:https'].includes(node.arguments[0]?.value)) return false;
    }
    if (node.type === 'ImportExpression' || node.type === 'ImportDeclaration') return false;
    if (node.type === 'Literal' && typeof node.value === 'string') literals.push(node);
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') {
        if (Array.isArray(value)) {
          for (const child of value) if (child?.type) pending.push({ node: child, parent: node });
        } else if (value.type) pending.push({ node: value, parent: node });
      }
    }
  }
  let proofWork = 0;
  const simple = node => {
    const work = [node];
    while (work.length) {
      if (++proofWork > 100000) return false;
      const part = work.pop();
      if (part.type === 'Literal' || part.type === 'Identifier') continue;
      if (part.type !== 'BinaryExpression' || part.operator !== '+') return false;
      work.push(part.left, part.right);
    }
    return true;
  };
  const approved = new Set();
  for (const literal of literals) {
    if (!contains(literal.value) && !contains(source.slice(literal.start, literal.end))) continue;
    let argument = literal, parent = parents.get(argument);
    while (parent?.type === 'BinaryExpression' && parent.operator === '+') {
      if (++proofWork > 100000) return false;
      argument = parent; parent = parents.get(argument);
    }
    if (!simple(argument) || parent?.type !== 'CallExpression' || parent.optional ||
        !parent.arguments.includes(argument) || parent.callee?.type !== 'MemberExpression' ||
        parent.callee.computed || parent.callee.optional || parent.callee.object?.name !== 'console' ||
        !diagnostics.has(parent.callee.property?.name) || parents.get(parent)?.type !== 'ExpressionStatement') return false;
    approved.add(`${literal.start}:${literal.end}`);
  }
  let occurrences = 0;
  for (const token of tokens) {
    if (!contains(source.slice(token.start, token.end)) && !(typeof token.value === 'string' && contains(token.value))) continue;
    occurrences++;
    if (!approved.has(`${token.start}:${token.end}`)) return false;
  }
  return occurrences > 0;
}
module.exports = { onlyPassiveDiagnosticUrls };
