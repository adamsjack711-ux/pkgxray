'use strict';

// Confidentiality limits are independent of the scan verdict. If collection or
// matching cannot finish within these budgets, omit text rather than emit a
// partially scrubbed value. No recursive decoding, eval, or dynamic regexes.
const MAX_TEXT = 64 * 1024, MAX_VALUES = 4096, MAX_NODES = 20000;
const MAX_COLLECT = 2 * 1024 * 1024, MAX_SEARCH = 8 * 1024 * 1024, MAX_SPANS = 16384;
const JSON_ESCAPE = /\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/;
const ESCAPES = { '"':'"', '\\':'\\', '/':'/', b:'\b', f:'\f', n:'\n', r:'\r', t:'\t' };

// Keep UTF-16 offsets back to the original string, including surrogate pairs.
// A view is for matching only: the decoded text is never displayed.
function views(text) {
  if (text.length > MAX_TEXT) return null;
  const result = [{text, starts:null, ends:null}];
  for (let pass = 0; pass < 2; pass++) {
    const previous = result[result.length - 1];
    if (!JSON_ESCAPE.test(previous.text)) return result;
    const chars = [], starts = [], ends = [];
    for (let i = 0; i < previous.text.length;) {
      const start = i; let char = previous.text[i++];
      if (char === '\\') {
        const next = previous.text[i];
        if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(previous.text.slice(i + 1,i + 5))) {
          char = String.fromCharCode(parseInt(previous.text.slice(i + 1,i + 5),16)); i += 5;
        } else if (Object.hasOwn(ESCAPES,next)) { char = ESCAPES[next]; i++; }
      }
      chars.push(char);
      starts.push(previous.starts ? previous.starts[start] : start);
      ends.push(previous.ends ? previous.ends[i - 1] : i);
    }
    result.push({text:chars.join(''),starts,ends});
  }
  // A third layer is ambiguous under this contract: redact the entire value.
  return JSON_ESCAPE.test(result[result.length - 1].text) ? null : result;
}

function credentialKey(key) {
  const normalized = key.toLowerCase().replace(/[ _-]/g,'');
  return /secret|password|passwd|credential|token|apikey|privatekey/.test(normalized) ||
    normalized === 'authorization' || normalized === 'proxyauthorization';
}

function authorizationKey(key) {
  return typeof key === 'string' && /^(?:proxy)?authorization$/.test(key.toLowerCase().replace(/[ _-]/g,''));
}

// Locate the fixed delimiter first; a long almost-URL cannot make a scheme
// regex retry every possible starting position.
function urlCredentials(text) {
  const spans = [];
  for (const m of text.matchAll(/:\/\/([^\s/]*@)/g)) {
    let start = m.index;
    while (start > 0 && /[a-z0-9+.-]/i.test(text[start - 1])) start--;
    if (start < m.index && /[a-z]/i.test(text[start])) spans.push([m.index + 3,m.index + m[0].length]);
  }
  return spans;
}

function credentialSpans(text) {
  const spans = [];
  let exceeded = false;
  const mark = (start,end) => {
    if (spans.length >= MAX_SPANS) exceeded = true;
    else if (end > start) spans.push([start,end]);
  };
  function matches(pattern, group = 0) {
    for (const m of text.matchAll(pattern)) {
      const offset = group ? m[0].indexOf(m[group]) : 0;
      mark(m.index + offset, m.index + offset + m[group].length);
    }
  }
  // Valid quoted values retain neighboring prose. Ambiguous, escaped outer
  // quotes, unquoted assignments and unterminated values redact the remainder
  // rather than guessing a delimiter inside a potentially malformed secret.
  function valueEnd(start) {
    const quote = text[start];
    if (quote !== '"' && quote !== "'") return text.length;
    for (let i = start + 1; i < text.length; i++) {
      if (text[i] === '\\') { i++; continue; }
      if (text[i] !== quote) continue;
      if (quote === "'" && text[i + 1] === "'") { i++; continue; }
      if (i + 1 === text.length || /[\s,;}\]]/.test(text[i + 1])) return i + 1;
      return text.length;
    }
    return text.length;
  }
  // Structured text can have quoted keys containing separators. Walk complete
  // quoted tokens once, then apply the same key normalization used for maps.
  for (let start = 0; start < text.length;) {
    const quote = text[start];
    if (quote !== '"' && quote !== "'") { start++; continue; }
    let end = start + 1;
    while (end < text.length) {
      if (text[end] === '\\') { end += 2; continue; }
      if (text[end] === quote) {
        if (quote === "'" && text[end + 1] === "'") { end += 2; continue; }
        break;
      }
      end++;
    }
    if (end >= text.length) break;
    let at = end + 1;
    while (at < text.length && /\s/.test(text[at])) at++;
    if ((text[at] === ':' || text[at] === '=') && credentialKey(text.slice(start + 1,end))) {
      at++; while (at < text.length && /\s/.test(text[at])) at++;
      mark(at,valueEnd(at));
    }
    start = end + 1;
  }
  // Consume each candidate key once. A greedy key-prefix regex would retry at
  // every word boundary in a long hyphenated noncredential string.
  for (const m of text.matchAll(/[a-z0-9_-]+/gi)) {
    if (!credentialKey(m[0])) continue;
    let at = m.index + m[0].length;
    if (text[at] === '\\' && /["']/.test(text[at + 1] || '')) at++;
    if (text[at] === '"' || text[at] === "'") at++;
    while (at < text.length && /\s/.test(text[at])) at++;
    if (text[at] !== ':' && text[at] !== '=') continue;
    at++;
    while (at < text.length && /\s/.test(text[at])) at++;
    mark(at,valueEnd(at));
  }
  for (const m of text.matchAll(/\b(?:Bearer|Basic)\s+/gi)) mark(m.index + m[0].length,valueEnd(m.index + m[0].length));
  matches(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g);
  for (const [start,end] of urlCredentials(text)) mark(start,end);
  matches(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g);
  matches(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16})\b/g);
  return exceeded ? null : spans;
}


// Evidence is constructed from validated numbers and fixed classifications, not
// YAML excerpts. This second layer protects identifiers and policy explanations.
function redactor(...inputs) {
  const values = new Set();
  let opaque = false, nodes = 0, collected = 0, searched = 0;
  function addKnown(text) {
    if (!text || values.has(text)) return;
    collected += text.length;
    if (values.size >= MAX_VALUES || collected > MAX_COLLECT) { opaque = true; return; }
    values.add(text);
  }
  function boundedViews(text) {
    collected += text.length;
    if (collected > MAX_COLLECT) { opaque = true; return null; }
    const result = views(text);
    if (!result) opaque = true;
    return result;
  }
  const headerKey = key => typeof key === 'string' &&
    (boundedViews(key) || []).some(view => authorizationKey(view.text));
  function collect(value) {
    const pending = [value], seen = new WeakSet();
    while (pending.length && !opaque) {
      if (++nodes > MAX_NODES) { opaque = true; break; }
      const item = pending.pop();
      if (typeof item === 'string' || typeof item === 'number') {
        for (const view of boundedViews(String(item)) || []) addKnown(view.text);
      } else if (item && typeof item === 'object' && !seen.has(item)) {
        seen.add(item); for (const child of Object.values(item)) pending.push(child);
      }
    }
  }
  const pending = inputs.map(value => ({value,depth:0})), seen = new WeakSet();
  while (pending.length && !opaque) {
    const {value,depth} = pending.pop();
    if (++nodes > MAX_NODES || depth > 64) { opaque = true; break; }
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    // Header maps, [name,value] pairs and {name/key,value/values} records.
    if (Array.isArray(value) && value.length === 2 && headerKey(value[0])) collect(value[1]);
    if (headerKey(value.name) || headerKey(value.key)) {
      if (Object.hasOwn(value,'value')) collect(value.value);
      if (Object.hasOwn(value,'values')) collect(value.values);
    }
    for (const [k, v] of Object.entries(value)) {
      if ((boundedViews(k) || []).some(view => credentialKey(view.text))) collect(v);
      if (k === 'environment' || k === 'labels' || k === 'args') {
        if (Array.isArray(v)) {
          for (const item of v) if (typeof item === 'string' && item.includes('=')) collect(item.slice(item.indexOf('=') + 1));
        } else collect(v);
      }
      if (typeof v === 'string') {
        for (const view of boundedViews(v) || []) {
          const spans = credentialSpans(view.text);
          if (!spans) { opaque = true; break; }
          for (const [start,end] of spans) {
            const raw = view.text.slice(start,end);
            addKnown(raw);
            if (raw[0] === '"' || raw[0] === "'") {
              addKnown(raw.slice(1,raw.endsWith(raw[0]) ? -1 : undefined).replace(/''/g,"'"));
            }
          }
          for (const [start,end] of urlCredentials(view.text)) {
            const credentials = view.text.slice(start,end - 1);
            addKnown(credentials); credentials.split(':').forEach(addKnown);
          }
        }
      }
      if (v && typeof v === 'object') pending.push({value:v,depth:depth + 1});
      if (opaque) break;
    }
  }
  const secrets = [...values].sort((a, b) => b.length - a.length);
  return value => {
    if (value == null) return value;
    const text = String(value), representations = opaque ? null : views(text);
    if (!representations) return '[REDACTED]';
    const spans = [];
    // Discover every span against ORIGINAL text. Replacing known strings first
    // can erase a URL scheme or Bearer prefix; sequential token matching can
    // leave suffixes behind. Merge overlapping spans before emitting anything.
    for (const view of representations) {
      searched += view.text.length * (secrets.length + 1);
      if (searched > MAX_SEARCH) return '[REDACTED]';
      const matched = credentialSpans(view.text);
      if (!matched) return '[REDACTED]';
      const mark = (start,end) => spans.push(view.starts ? [view.starts[start],view.ends[end - 1]] : [start,end]);
      for (const [start,end] of matched) mark(start,end);
      for (const secret of secrets) {
        let start = view.text.indexOf(secret);
        while (start !== -1) {
          mark(start,start + secret.length);
          if (spans.length >= MAX_SPANS) return '[REDACTED]';
          start = view.text.indexOf(secret,start + 1);
        }
      }
    }
    spans.sort((a,b) => a[0] - b[0] || b[1] - a[1]);
    const merged = [];
    for (const span of spans) {
      const previous = merged[merged.length - 1];
      if (previous && span[0] <= previous[1]) previous[1] = Math.max(previous[1],span[1]);
      else merged.push([...span]);
    }
    let output = '', cursor = 0;
    for (const [start,end] of merged) { output += text.slice(cursor,start) + '[REDACTED]'; cursor = end; }
    return (output + text.slice(cursor))
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, '?');
  };
}

module.exports = { redactor };
