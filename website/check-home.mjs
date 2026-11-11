// Contract checks for evidence, copying, and integration of the unchanged hero.
// Run with: node --test website/check-home.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import vm from 'node:vm';
const root = new URL('./', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const html = read('index.html');
const report = JSON.parse(read('assets/evidence/express-4.21.0.json'));

test('homepage evidence and command agree with the captured report', () => {
  assert.equal(report.reference, 'npm:express@4.21.0');
  assert.equal(report.assessment.engine.version, '1.2.1');
  assert.equal(report.report.verdict, 'safe');
  assert.equal(report.sourceCoverage.scannedFiles, 15);
  assert.equal(report.assessment.checks.directDependencies, 'not-requested');
  assert.equal(report.assessment.checks.provenance, 'absent');
  const finding = report.report.findings.find(f => f.category === 'dynamic-require');
  assert.equal(finding.severity, 'info');
  assert.equal(finding.file, 'lib/view.js');
  assert.ok(finding.snippet.includes('var fn = require(mod).__express'));
  assert.ok(html.includes(report.approval.artifactSha256));
  assert.ok(html.includes('npx --yes pkgxray@1.2.1 guard npm:express@4.21.0'));
  assert.ok(html.includes('https://github.com/adamsjack711-ux/pkgxray/blob/main/docs/README.md'));
  assert.ok(html.includes('Dependencies were not scanned'));
  assert.ok(html.includes('not a live browser scan'));
});

test('hero uses the handed-off renderer, and homepage colors are neutral', () => {
  assert.equal(realpathSync(new URL('assets/pkgx-ascii-hero.js', root)), realpathSync(new URL('../prototypes/pkgx-ascii-hero/pkgx-ascii-hero.js', root)));
  for (const [, hex] of read('home.css').matchAll(/#([\da-f]{3,8})\b/gi)) {
    const channels = hex.length <= 4 ? hex.slice(0, 3).split('') : hex.slice(0, 6).match(/../g);
    assert.equal(new Set(channels).size, 1, `non-neutral color #${hex}`);
  }
  assert.doesNotMatch(html, /class="wordmark"|brand-cursor|Move pointer to explore|Local · static · evidence-led/);
  assert.match(html, /<h1 class="sr-only" id="intro-title">pkg x-ray<\/h1>/);
});

function scene({ width = 1040, height = 310, displayedWidth = width, displayedHeight = height, reduced = false } = {}) {
  class Element {
    constructor() { this.events = {}; this.style = {}; this.hidden = false; this.textContent = ''; this.attrs = {}; this.classList = { add() {} }; }
    addEventListener(type, fn, opts) { (this.events[type] ??= []).push({ fn, capture: opts?.capture }); }
    dispatchEvent(event) {
      for (const item of [...(this.events[event.type] || [])].sort((a,b) => Number(!!b.capture)-Number(!!a.capture))) {
        if (event.stopped) break;
        item.fn(event);
      }
    }
    setAttribute(k,v) { this.attrs[k] = v; }
    async fire(type) { for (const e of this.events[type] || []) await e.fn({ type }); }
  }
  class PointerEvent {
    constructor(type, args = {}) { Object.assign(this, { type }, args); }
    stopImmediatePropagation() { this.stopped = true; }
  }
  const ctx = { frame: [], setTransform() {}, fillRect() { this.frame = []; }, fillText(ch,x,y) { this.frame.push([ch,x,y,this.fillStyle]); } };
  const live = new Element(); live.getContext = () => ctx;
  live.getBoundingClientRect = () => ({left:0,top:0,width:displayedWidth,height:displayedHeight});
  const still = new Element(); still.hidden = true;
  still.getContext = () => ({ drawImage() { still.frame = structuredClone(ctx.frame); } });
  const hero = new Element();
  hero.getBoundingClientRect = () => ({left:0,top:0,width,height});
  hero.querySelector = s => s.includes('__field') ? live : still;
  const button = new Element(), copy = new Element(), label = new Element(), status = new Element();
  const command = { textContent: 'npx --yes pkgxray@1.2.1 guard npm:express@4.21.0' };
  copy.dataset = { copyTarget: 'scan-command' }; copy.querySelector = () => label;
  const motion = new Element(); motion.matches = reduced;
  let id = 0, copied, selected = false;
  const queue = new Map();
  const raf = fn => { queue.set(++id, fn); return id; };
  const window = new Element();
  Object.assign(window, { matchMedia: () => motion, devicePixelRatio: 1, setTimeout: () => 1, getSelection: () => ({removeAllRanges() {},addRange() {selected = true;}}) });
  const navigator = { clipboard: { async writeText(value) { copied = value; } } };
  const document = {
    querySelector(s) { return ({'.pkgx-ascii-hero':hero,'.motion-button':button,'.copy-status':status})[s]; },
    querySelectorAll: () => [copy], getElementById: () => command,
    createRange: () => ({ selectNodeContents() {} })
  };
  const context = vm.createContext({ document, window, navigator, PointerEvent, requestAnimationFrame: raf, cancelAnimationFrame: n => queue.delete(n), clearTimeout() {} });
  vm.runInContext(read('assets/pkgx-ascii-hero.js'), context);
  vm.runInContext(read('app.js'), context);
  function tick(time) { const tasks=[...queue.values()]; queue.clear(); tasks.forEach(fn=>fn(time)); }
  const letters = () => JSON.stringify(ctx.frame.filter(cell => cell[3] === 'rgba(245,246,247,0.99)'));
  const field = () => JSON.stringify(ctx.frame.filter(cell => cell[3] !== 'rgba(245,246,247,0.99)'));
  return {hero,live,still,button,copy,label,status,command,motion,window,navigator,queue,tick,letters,field,PointerEvent, get copied(){return copied;},get selected(){return selected;}};
}

test('ASCII letters are identical over time and pointer movement at desktop and mobile sizes', () => {
  for (const size of [{}, {width:560,height:340,displayedWidth:278,displayedHeight:218}]) {
    const a = scene(size), b = scene(size);
    a.tick(100); b.tick(100); a.tick(150); b.tick(150);
    const letters = a.letters();
    a.hero.dispatchEvent(new a.PointerEvent('pointermove', { clientX:140, clientY:100, pointerType:'mouse' }));
    for (let t = 250; t <= 1250; t += 50) { a.tick(t); b.tick(t); }
    assert.equal(a.letters(), letters);
    assert.ok(a.field() !== b.field(), 'pointer must affect the field at the same timestamp');
    a.tick(5000);
    assert.equal(a.letters(), letters);
  }
});

test('reduced motion settles, blocks pointer animation, and pause keeps a fixed frame', async () => {
  const a = scene({reduced:true});
  a.tick(100); a.tick(150);
  assert.equal(a.queue.size, 0);
  const frame = JSON.stringify(a.still.frame);
  a.hero.dispatchEvent(new a.PointerEvent('pointermove', {clientX:100,clientY:100}));
  assert.equal(a.queue.size, 0);
  assert.equal(JSON.stringify(a.still.frame), frame);
  assert.equal(a.button.disabled, true);
  const b = scene(); b.tick(100); b.tick(150);
  await b.button.fire('click'); b.tick(200);
  const paused = JSON.stringify(b.still.frame);
  b.tick(3000);
  assert.equal(JSON.stringify(b.still.frame), paused);
  assert.equal(b.live.style.visibility, 'hidden');
  await b.button.fire('click');
  assert.equal(b.still.hidden, true);
  assert.equal(b.live.style.visibility, '');
});

test('copy uses the visible command and falls back to selection on denial', async () => {
  const a = scene();
  await a.copy.fire('click');
  assert.equal(a.copied, a.command.textContent);
  assert.equal(a.label.textContent, 'Copied');
  a.navigator.clipboard.writeText = async () => { throw new Error('denied'); };
  await a.copy.fire('click');
  assert.equal(a.selected, true);
  assert.match(a.status.textContent, /Clipboard unavailable/);
});
