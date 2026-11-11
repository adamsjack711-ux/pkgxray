'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourcePlan } = require('../src/source-plan');
const { analyzeExecutionFile } = require('../src/execution-graph');

function planFor(source, extra = {}, manifest = { main: 'index.js' }) {
  const files = new Map(Object.entries({ 'package.json': JSON.stringify(manifest), 'index.js': source, ...extra }));
  const plan = createSourcePlan(files);
  plan.manifest(manifest);
  for (const file of plan.required) plan.imports(file, files.get(file));
  return plan;
}

test('runtime graph ignores import examples in strings, comments and literal template text', () => {
  const source = `console.error("Example: lazy(() => import('./MyComponent'))");
    // require('./comment-only');
    /* export { thing } from './comment-export'; */
    const docs = \`import thing from './template-example'\`;
    const pattern = /require\\('\\.\\/regex-example'\\)/;`;
  assert.deepEqual([...planFor(source).gaps], []);
  assert.deepEqual(analyzeExecutionFile('index.js', source).imports, []);
});

test('actual imports, reexports and template substitutions remain executable edges', () => {
  const source = `import './one.js'; export {x} from './two.js'; export * from './three.js';
    const docs = \`text \${require('./four.js')}\`;
    import('./five.js'); require('./six.js');`;
  const plan = planFor(source);
  for (const name of ['one', 'two', 'three', 'four', 'five', 'six']) assert.ok(plan.gaps.has(`unresolved runtime target: ${name}.js`), name);
});

test('syntax-discovered aliased and computed constant imports include nonstandard runtime filenames', () => {
  const source = "const load=require; load('./payload.dat'); import(`./${'worker'}.txt`);";
  const plan = planFor(source, { 'payload.dat': "require('./missing.js')", 'worker.txt': 'module.exports=42;' });
  assert.ok(plan.required.has('payload.dat'));
  assert.ok(plan.required.has('worker.txt'));
  assert.ok(plan.gaps.has('unresolved runtime target: missing.js'));
});

test('ambiguous or member require calls do not erase literal targets previously held', () => {
  for (const source of ["if(flag)require=other;require('./missing.js')", "module.require('./missing.js')", "host.require('./missing.js')"]) {
    assert.ok(planFor(source).gaps.has('unresolved runtime target: missing.js'), source);
  }
  assert.ok([...planFor("require('./partial' + variable)").gaps].some(gap => /computed module specifier/.test(gap)));
});

test('escaping and declaration-suffixed executable targets remain mandatory', () => {
  assert.ok(planFor("require('../outside.js')").gaps.has('runtime target escapes artifact: ../outside.js'));
  const plan = planFor("require('./payload.d.ts')", { 'payload.d.ts': "require('./missing.js');" });
  assert.ok(plan.required.has('payload.d.ts'));
  assert.ok(plan.gaps.has('unresolved runtime target: missing.js'));
});

test('unsupported syntax and analysis budgets remain explicit coverage gaps', () => {
  assert.ok([...planFor("const x: string = 'value';").gaps].some(gap => /unsupported runtime syntax/.test(gap)));
  assert.ok([...planFor(' '.repeat(1024 * 1024 + 1)).gaps].some(gap => /file limit/.test(gap)));
});

test('exported valid JSON data does not execute example text', () => {
  const plan = planFor('module.exports=42;', {}, { exports: { '.': './index.js', './package.json': './package.json' },
    example: "import('./missing.js')" });
  assert.deepEqual([...plan.gaps], []);
});

test('JSON-like filenames do not exempt actual Node subprocess code', () => {
  const plan = planFor("require('child_process').fork(__dirname+'/worker.json');", {
    'worker.json': "require('./missing.js');"
  });
  assert.ok(plan.required.has('worker.json'));
  assert.ok(plan.gaps.has('unresolved runtime target: missing.js'));
});

test('explicit type-only conditional branches stay type-only through nesting', () => {
  const plan = planFor('export const x=1;', {}, { exports: { '.': { types: { default: './missing.d.ts' }, import: './index.js' } },
    imports: { '#types': { types: { node: './absent.d.ts' }, default: './index.js' } } });
  assert.deepEqual([...plan.gaps], []);
  assert.ok(plan.required.has('index.js'));
});

test('ordinary binaries called types and default declaration exports are not type-only metadata', () => {
  const plan = planFor('module.exports=42;', {}, { main: 'index.js', bin: { types: './missing-tool.js' },
    exports: { './runtime': './missing.d.ts' } });
  assert.ok(plan.gaps.has('unresolved runtime target: missing-tool.js'));
  assert.ok(plan.gaps.has('unresolved runtime target: missing.d.ts'));
});

test('missing prepare/install scripts remain mandatory even when development targets are absent', () => {
  for (const hook of ['prepare', 'install', 'postinstall', 'prepack']) {
    const plan = planFor('module.exports=42;', {}, { main: 'index.js', scripts: { [hook]: 'bash scripts/build.sh' } });
    assert.ok(plan.gaps.has('unresolved runtime target: scripts/build.sh'), hook);
  }
});

test('dynamic code evaluation cannot turn embedded runtime loads into complete coverage', () => {
  for (const source of [
    `eval("require('./hidden.js')")`,
    `new Function("return require('./hidden.js')")()`,
    `const run=eval;run("require('./hidden.js')")`,
    `const Make=Function;Make("return require('./hidden.js')")()`,
    `const run=globalThis['eval'];run("require('./hidden.js')")`,
    `globalThis[['ev','al'].join('')]("require('./hidden.js')")`,
    `(()=>{}).constructor("return require('./hidden.js')")()`,
    `const F=(function(){}).constructor;F("require('./hidden.js')")()`,
    `const F=Function.constructor;F("require('./hidden.js')")()`,
    `const run=eval;run.call(null,"require('./hidden.js')")`,
    `const run=eval.bind(null);run("require('./hidden.js')")`,
    `(0,eval)("require('./hidden.js')")`,
    `const run=identity(eval);run("require('./hidden.js')")`,
    `Reflect.construct(Function,["return require('./hidden.js')"])()`,
    `Reflect.apply(eval,null,["require('./hidden.js')"])`,
    `function run(fn,code){fn(code)}run(eval,"require('./hidden.js')")`,
    `function run(holder,code){holder[0].fn(code)}run([{fn:eval}],"require('./hidden.js')")`,
    `function make(){return eval}make()("require('./hidden.js')")`,
    `const holder={};holder.run=eval;holder.run("require('./hidden.js')")`,
    `let run=eval;if(flag)run=other;run("require('./hidden.js')")`,
    `function load(run=eval){run("require('./hidden.js')")}`,
    `require('vm').runInThisContext("require('./hidden.js')")`
  ]) {
    const plan = planFor(source, { 'hidden.js': "fetch('/api',{body:process.env.TEST_TOKEN})" });
    assert.ok([...plan.gaps].some(gap => /dynamic code execution/.test(gap)), source);
  }
  const absent = planFor(`eval("require('./missing.dat')")`);
  assert.ok([...absent.gaps].some(gap => /dynamic code execution/.test(gap)));
});

for (const source of [
  `const run=flag?eval:eval;run("require('./hidden.js')")`,
  `const run=eval||other;run("require('./hidden.js')")`,
  `const [run]=[...[eval]];run("require('./hidden.js')")`,
  `require('child_process').spawnSync(process.execPath,['-e',"require('./hidden.js')"]);`,
  `new (require('vm').SourceTextModule)("import './hidden.js'");`,
  `let holder={run:eval};if(flag)holder={run:eval};holder.run("require('./hidden.js')")`,
  `const {run,...rest}={run:other,exec:eval};rest.exec("require('./hidden.js')")`,
  `const [first,...rest]=[other,eval];rest[0]("require('./hidden.js')")`,
  `const make=()=>eval;make()("require('./hidden.js')")`
]) test(`evaluator loss stays incomplete: ${source}`, () => {
  assert.ok([...planFor(source).gaps].some(gap => /dynamic code execution/.test(gap)));
});


test('inert literal evaluator probes retain coverage without admitting executable payloads', () => {
  for (const source of [
    `eval("var x=1;module.exports=x//# sourceURL=42.js")`,
    `(new Function('return this'))()`
  ]) assert.deepEqual([...planFor(source).gaps], [], source);
  for (const source of [
    `eval("var x=require('./hidden.js');module.exports=x")`,
    `eval("var x=host.value;module.exports=x")`,
    `eval("module.exports=unknown")`,
    `new Function("arg=require('./hidden.js')", "return this")()`,
    `(new Function('return this')).constructor("return require('./hidden.js')")()`,
    `(new Function('return this')).call(null).eval("require('./hidden.js')")`,
    `(new Function('return this'))().eval("require('./hidden.js')")`,
    `eval("var x=1;module.exports=x;import('./hidden.js')")`,
    `eval("const x: string='value'")`
  ]) assert.ok([...planFor(source).gaps].some(gap => /dynamic code execution/.test(gap)), source);
});
