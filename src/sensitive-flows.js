"use strict";
const { createFlowAnalysis } = require("./flow-analysis");
const { shellUploadHints } = require("./shell-flows");

// Bounded lexical flow hints, not a JavaScript parser or proof of exfiltration.
// Strings/comments stay opaque except for literal property/module names. No
// code is evaluated. Findings are REVIEW: legitimate API authentication can
// legitimately put a secret in an outbound request.
function lexicalFlowHints(source) {
  const tokens = [];
  const limit = Math.min(source.length, 1024 * 1024);
  let i = 0;
  while (i < limit && tokens.length < 60000) {
    const start = i, c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if (source.startsWith('//', i)) { const end = source.indexOf('\n', i + 2); i = end < 0 ? limit : end; continue; }
    if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); i = end < 0 ? limit : end + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c; let value = ''; i++;
      while (i < limit && source[i] !== quote) {
        if (source[i] === '\\') { value += source.slice(i, i + 2); i += 2; }
        else value += source[i++];
      }
      i++;
      tokens.push({ kind: 'string', value, start }); continue;
    }
    // Regex literals at common expression-start positions are inert patterns.
    if (c === '/' && (!tokens.length || ['=', '(', ',', ':', '[', '!', 'return'].includes(tokens.at(-1).value))) {
      i++; let inClass = false;
      while (i < limit) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '[') inClass = true;
        if (source[i] === ']') inClass = false;
        if (source[i++] === '/' && !inClass) break;
      }
      while (i < limit && /[a-z]/i.test(source[i])) i++;
      tokens.push({ kind: 'string', value: '', start }); continue;
    }
    if (/[\w$]/.test(c)) {
      i++; while (i < limit && /[\w$]/.test(source[i])) i++;
      tokens.push({ kind: 'word', value: source.slice(start, i), start }); continue;
    }
    tokens.push({ kind: 'punct', value: c, start }); i++;
  }
  const v = n => tokens[n]?.value;
  let work = 0;
  const aliases = new Map();
  const receivers = new Set();
  const declarations = new Map();
  for (let n = 0; n < tokens.length; n++) if (tokens[n].kind === 'word' && v(n + 1) === '=' && v(n + 2) !== '=') declarations.set(v(n), (declarations.get(v(n)) || 0) + 1);
  function property(n) {
    if (v(n) === '.' && tokens[n + 1]?.kind === 'word') return { name: v(n + 1), end: n + 2 };
    if (v(n) === '[' && tokens[n + 1]?.kind === 'string' && v(n + 2) === ']') return { name: v(n + 1), end: n + 3 };
    return null;
  }
  function envAt(n) {
    if (tokens[n]?.kind !== 'word') return null;
    let end;
    if (v(n) === 'Reflect' && v(n + 1) === '.' && v(n + 2) === 'get' && v(n + 3) === '(') {
      // Recognize literal reflection without evaluating a computed property.
      // Do not recursively parse arbitrary expressions or nested calls.
      if (v(n + 4) !== 'process') return null;
      const objectProperty = property(n + 5);
      const comma = objectProperty?.name === 'env' ? objectProperty.end : n + 5;
      if (v(comma) !== ',' || tokens[comma + 1]?.kind !== 'string' || v(comma + 2) !== ')') return null;
      const key = v(comma + 1);
      end = comma + 3;
      if (objectProperty?.name === 'env') return { kind: /(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL)/i.test(key) ? 'secret' : 'public', end };
      if (key !== 'env') return { kind: 'public', end };
    }
    else if (v(n) === 'process') { const p = property(n + 1); if (p?.name !== 'env') return null; end = p.end; }
    else if (aliases.get(v(n)) === 'env') end = n + 1;
    else if (aliases.get(v(n)) === 'secret') return { kind: 'secret', end: n + 1 };
    else return null;
    const p = property(end);
    if (!p) return { kind: 'env', end };
    return { kind: /(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL)/i.test(p.name) ? 'secret' : 'public', end: p.end };
  }
  function taint(start, end) {
    for (let n = start; n < end; n++) {
      if (++work > 500000) return null;
      const env = envAt(n);
      if (env && env.kind !== 'public') return env.kind;
      if (env) n = env.end - 1;
    }
    return null;
  }
  function close(open) {
    let depth = 1;
    for (let n = open + 1; n < Math.min(tokens.length, open + 4000); n++) {
      if (++work > 500000) return null;
      if (tokens[n].kind !== 'punct') continue;
      if (v(n) === '(') depth++;
      if (v(n) === ')' && --depth === 0) return n;
    }
    return null;
  }
  // A single straight-line assignment can carry a source into a later sink.
  // Reassigned aliases are excluded rather than pretending to resolve scope.
  for (let n = 0; n < tokens.length; n++) {
    // Flat object bindings with literal keys, including renamed credentials.
    // Defaults, nested patterns and rest elements require scope/data-flow
    // analysis and are deliberately outside this bounded hint.
    if (['const', 'let', 'var'].includes(v(n)) && v(n + 1) === '{') {
      let end = n + 2;
      while (end < Math.min(tokens.length, n + 1000) && v(end) !== '}') end++;
      if (v(end) === '}' && v(end + 1) === '=' && envAt(end + 2)?.kind === 'env') {
        const bindings = [];
        let k = n + 2;
        while (k < end) {
          if (!['word', 'string'].includes(tokens[k]?.kind)) break;
          const key = v(k++);
          let name = key;
          if (v(k) === ':') { k++; if (tokens[k]?.kind !== 'word') break; name = v(k++); }
          if (k < end && v(k++) !== ',') break;
          bindings.push([key, name]);
        }
        if (k === end) for (const [key, name] of bindings) {
          if (!declarations.has(name) && /(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL)/i.test(key)) aliases.set(name, 'secret');
        }
      }
    }
    if (['const', 'let', 'var'].includes(v(n)) && tokens[n + 1]?.kind === 'word' && v(n + 2) === '=') {
      let end = n + 3;
      while (end < Math.min(tokens.length, n + 1000) && v(end) !== ';') end++;
      const name = v(n + 1);
      if (declarations.get(name) === 1) {
        const kind = taint(n + 3, end);
        if (kind) aliases.set(name, kind);
        const rhs = tokens.slice(n + 3, end);
        if (rhs.some(t => t.kind === 'word' && t.value === 'WebSocket') ||
            (rhs.some(t => t.kind === 'string' && /^(?:node:)?https?$/.test(t.value)) && rhs.some(t => t.value === 'request'))) receivers.add(name);
      }
    }
  }
  const hints = [];
  for (let n = 1; n < tokens.length; n++) {
    if (v(n) !== '(' || tokens[n - 1].kind !== 'word') continue;
    const name = v(n - 1), end = close(n);
    if (end === null) continue;
    const prefix = tokens.slice(Math.max(0, n - 12), n);
    const knownModule = module => prefix.some(t => t.kind === 'string' && new RegExp(`^(?:node:)?${module}$`).test(t.value));
    const receiver = v(n - 2) === '.' ? v(n - 3) : null;
    const sink = name === 'fetch' || name === 'sendBeacon' ||
      (['send', 'end'].includes(name) && receivers.has(receiver)) ||
      (['resolve', 'resolve4', 'resolveTxt', 'lookup'].includes(name) && knownModule('dns')) ||
      (['exec', 'execSync'].includes(name) && knownModule('child_process') && tokens.slice(n + 1, end).some(t => t.kind === 'string' && /\bcurl\b/.test(t.value)));
    if (sink && taint(n + 1, end)) hints.push({ index: tokens[n - 1].start, kind: 'credential-export' });
    if (['runInNewContext', 'runInThisContext', 'runInContext'].includes(name) && knownModule('vm') &&
        tokens.slice(n + 1, end).some((t, k, a) => t.kind === 'word' && t.value === 'fetch' && a[k + 1]?.value === '(')) {
      hints.push({ index: tokens[n - 1].start, kind: 'remote-vm-code' });
    }
  }
  return hints.slice(0, 8);
}
function sensitiveFlowHints(source, options = {}) {
  const analysis = options.analysis || createFlowAnalysis([{ path: 'index.js', content: source }]).analyze('index.js');
  const hints = analysis.status === 'parsed' ? analysis.hints : [...analysis.hints, ...lexicalFlowHints(source)];
  // Keep the gap ahead of bounded hints: an exhausted hint budget must never
  // hide the fact that executable syntax was left unmodeled.
  const executableSyntax = !options.filePath || /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/i.test(options.filePath) || options.runtimeReferenced;
  if (['budget', 'cycle', 'missing', 'unmodeled'].includes(analysis.status) ||
      (analysis.status === 'unsupported' && executableSyntax)) {
    const gap = analysis.gaps?.find(g => g.relevant !== false);
    hints.unshift({ index: gap?.index || 0, kind: 'flow-analysis-gap', reason: gap?.reason || analysis.status, nodeType: gap?.nodeType });
  }
  const shell = !options.filePath || /\.(?:sh|bash|zsh)$/.test(options.filePath) || /^\s*(?:#![^\n]*\n)?curl\s/.test(source);
  return [...hints, ...(shell ? shellUploadHints(source) : [])].slice(0, 8);
}
module.exports = { sensitiveFlowHints };
