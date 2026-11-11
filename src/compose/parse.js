'use strict';

const YAML = require('../vendor/yaml/dist');
const MAX_BYTES = 1024 * 1024;
const isMap = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// No dotenv, process environment, commands, includes, or custom tag resolvers.
function parse(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_BYTES) {
    return { error: 'Input must be UTF-8 YAML no larger than 1 MiB.', line: null };
  }
  const lines = new YAML.LineCounter();
  let doc, data;
  try {
    doc = YAML.parseDocument(source, {
      version: '1.2', merge: true, uniqueKeys: true, lineCounter: lines,
      prettyErrors: false, strict: true
    });
    if (doc.errors.length || doc.warnings.length) {
      const issue = doc.errors[0] || doc.warnings[0];
      // Parser messages can contain entire secret-bearing input lines.
      return { error: 'Invalid or unsupported YAML (including duplicate keys, tags, directives, or multiple documents).',
        line: issue.pos ? lines.linePos(issue.pos[0]).line : null };
    }
    if (doc.directives.yaml.version !== '1.2') return { error: 'Only YAML 1.2 is supported.', line: 1 };
    // toJS may emit process warnings containing complex keys. Reject them
    // before conversion, as well as YAML types outside the Compose data model.
    const allowedTags = new Set(['tag:yaml.org,2002:map','tag:yaml.org,2002:seq',
      'tag:yaml.org,2002:str','tag:yaml.org,2002:bool','tag:yaml.org,2002:int',
      'tag:yaml.org,2002:float','tag:yaml.org,2002:null','tag:yaml.org,2002:merge']);
    YAML.visit(doc, (_key, node) => {
      if (node?.tag && !allowedTags.has(node.tag)) throw new Error('tag');
      if (YAML.isMap(node)) for (const pair of node.items) {
        if (!YAML.isScalar(pair.key) || !['string','symbol'].includes(typeof pair.key.value)) throw new Error('key');
      }
    });
    data = doc.toJS({ maxAliasCount: 50 });
    let count = 0;
    const stack = new Set();
    function bounded(value, depth = 0) {
      if (++count > 20000 || depth > 64) throw new Error('limit');
      if (!value || typeof value !== 'object') return;
      if (stack.has(value)) throw new Error('cycle');
      stack.add(value);
      for (const child of Object.values(value)) bounded(child, depth + 1);
      stack.delete(value);
    }
    bounded(data);
  } catch {
    return { error: 'YAML could not be resolved within alias, nesting, or size limits.', line: null };
  }

  // Locate inherited values at their anchor definition, with merge precedence
  // matching YAML: explicit keys win; earlier maps in a merge sequence win.
  function resolve(node, seen = new Set()) {
    if (!YAML.isAlias(node)) return node;
    if (seen.has(node)) return null;
    seen.add(node);
    return resolve(node.resolve(doc), seen);
  }
  function child(node, key, seen = new Set()) {
    node = resolve(node);
    if (!node || seen.has(node)) return null;
    seen.add(node);
    if (YAML.isSeq(node)) return node.items[key] || null;
    if (!YAML.isMap(node)) return null;
    const pair = node.items.find(p => p.key && p.key.value === key);
    if (pair) return pair.value || pair.key;
    const merges = node.items.filter(p => typeof p.key?.value === 'symbol');
    for (const merge of merges) {
      const value = resolve(merge.value);
      for (const map of YAML.isSeq(value) ? value.items : [value]) {
        const found = child(map, key, new Set(seen));
        if (found) return found;
      }
    }
    return null;
  }
  function line(path = []) {
    let node = doc.contents;
    for (const key of path) node = child(node, key);
    node = resolve(node);
    return node?.range ? lines.linePos(node.range[0]).line : null;
  }
  return { data, line };
}

function dynamic(value) {
  if (typeof value === 'string') return /\$(?:[A-Za-z_]|\{)/.test(value.replace(/\$\$/g, ''));
  if (value && typeof value === 'object') return Object.values(value).some(dynamic);
  return false;
}

module.exports = { parse, dynamic, isMap, MAX_BYTES };
