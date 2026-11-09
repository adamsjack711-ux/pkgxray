import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
execFileSync(process.execPath, ['scripts/build-browser-extension.js', '--check'], { cwd: fileURLToPath(root), stdio: 'inherit' });
const source = await fs.readFile(new URL('browser-extension/auditor.browser.js', root), 'utf8');
await fs.mkdir(new URL('dist/', import.meta.url), { recursive: true });
// Reuse the verified pure browser engine, including its vendored-parser license.
// No filesystem, shell, network client or package execution code enters the Worker.
await fs.writeFile(new URL('dist/auditor.mjs', import.meta.url),
  `const window = {};\nconst require = () => { throw new Error('Optional Node modules are unavailable in hosted analysis'); };\n${source}\nexport { auditEvidence };\n`);
