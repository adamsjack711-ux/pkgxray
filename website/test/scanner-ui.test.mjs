import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function scene() {
  class Element {
    constructor(tag = 'div') { this.tag = tag; this.events = {}; this.children = []; this.hidden = true; this.disabled = false; this.value = ''; }
    set innerHTML(_) { throw Error('Untrusted HTML insertion'); }
    set textContent(value) { this.text = value; this.children = []; }
    get textContent() { return (this.text || '') + this.children.map(n => n.textContent).join(''); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren() { this.children = []; this.text = ''; }
    addEventListener(type, fn) { this.events[type] = fn; }
    setAttribute() {}
    focus() {}
    click() { this.events.click?.({ preventDefault() {} }); }
  }
  const ids = Object.fromEntries(['form', 'reference', 'start', 'cancel', 'status', 'result', 'download'].map(id => [id, new Element()]));
  const workers = [], timers = new Map(); let sequence = 0;
  class Worker {
    constructor(url, options) { assert.equal(options.type, 'module'); assert.match(url.href, /scanner\/worker.mjs$/); this.terminated = false; workers.push(this); }
    postMessage(message) { this.message = message; }
    terminate() { this.terminated = true; }
    send(data) { this.onmessage({ data }); }
  }
  const context = vm.createContext({ document: { getElementById: id => ids[id.replace('cold-scan-', '')], createElement: tag => new Element(tag), createTextNode: text => { const n = new Element(); n.textContent = text; return n; } }, Worker, URL, Blob,
    setTimeout(fn) { timers.set(++sequence, fn); return sequence; }, clearTimeout(id) { timers.delete(id); } });
  const source = fs.readFileSync(new URL('../scanner/ui.mjs', import.meta.url), 'utf8').replaceAll('import.meta.url', JSON.stringify('https://pkgxray.ca/scanner/ui.mjs'));
  vm.runInContext(source, context);
  return { ids, workers, timers, submit(value) { ids.reference.value = value; ids.form.events.submit({ preventDefault() {} }); } };
}
test('scan cancellation and deadline terminate workers and restore usable controls', () => {
  for (const cause of ['cancel', 'timeout']) {
    const s = scene(); s.submit('fixture'); assert.equal(s.ids.start.disabled, true);
    assert.equal(s.workers[0].message.reference, 'fixture');
    if (cause === 'cancel') s.ids.cancel.click(); else [...s.timers.values()][0]();
    assert.equal(s.workers[0].terminated, true); assert.equal(s.ids.start.disabled, false);
    assert.equal(s.ids.reference.disabled, false); assert.equal(s.ids.result.hidden, true);
    assert.match(s.ids.status.textContent, /No security verdict/);
  }
});
test('failed scans remove stale report and download state', () => {
  const s = scene(); s.ids.result.hidden = false; s.ids.download.hidden = false;
  s.submit('fixture'); s.workers[0].send({ error: 'Invalid archive' });
  assert.equal(s.ids.result.hidden, true); assert.equal(s.ids.download.hidden, true);
  assert.equal(s.workers[0].terminated, true); assert.match(s.ids.status.textContent, /No installation was approved/);
});
test('hostile findings are rendered as text, bidi is exposed, and advisory URLs stay on OSV', () => {
  const s = scene(); s.submit('fixture');
  const payload = '<img src=x onerror=alert(1)>\u202e';
  s.workers[0].send({ result: { verdict: 'block', staticVerdict: 'block', reference: payload, summary: 'Inspect evidence', durationMs: 12,
    coverage: { scannedFiles: 1, sourceBytes: 10, integrity: 'verified', vulnerabilities: 'completed', gaps: [payload] },
    findings: [{ severity: 'high', category: payload, file: payload, rationale: payload, snippet: payload }], advisories: [{ id: 'https://evil.invalid/#x', summary: payload }] } });
  assert.equal(s.ids.result.hidden, false); assert.match(s.ids.result.textContent, /<img src=x onerror=alert\(1\)>\[U\+202E\]/);
  function all(node) { return [node, ...node.children.flatMap(all)]; }
  const nodes = all(s.ids.result);
  assert.equal(nodes.some(n => ['img', 'script', 'iframe'].includes(n.tag)), false);
  assert.ok(nodes.filter(n => n.tag === 'a').every(n => new URL(n.href).origin === 'https://osv.dev'));
});
