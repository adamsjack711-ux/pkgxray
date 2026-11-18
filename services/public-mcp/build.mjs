import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const pkg = JSON.parse(await fs.readFile(new URL('package.json', root), 'utf8'));
const service = JSON.parse(await fs.readFile(new URL('package.json', import.meta.url), 'utf8'));
if (service.version !== pkg.version || !/^\d+\.\d+\.\d+$/.test(service.publishedCliVersion)) {
  throw new Error('Synchronize the service/scanner version and set a verified publishedCliVersion before building.');
}
execFileSync(process.execPath, ['scripts/build-browser-extension.js', '--check'], { cwd: fileURLToPath(root), stdio: 'inherit' });
const source = await fs.readFile(new URL('browser-extension/auditor.browser.js', root), 'utf8');
await fs.mkdir(new URL('dist/', import.meta.url), { recursive: true });
// Scanner identity follows this build; the install suggestion follows the
// independently verified npm publication, which may still be an older release.
await fs.writeFile(new URL('dist/build-info.mjs', import.meta.url),
  `export const SCANNER_VERSION = ${JSON.stringify(pkg.version)};\nexport const PUBLISHED_CLI_VERSION = ${JSON.stringify(service.publishedCliVersion)};\n`);
// Reuse the verified pure browser engine, including its vendored-parser license.
// No filesystem, shell, network client or package execution code enters the Worker.
await fs.writeFile(new URL('dist/auditor.mjs', import.meta.url),
  `const window = {};\nconst require = () => { throw new Error('Optional Node modules are unavailable in hosted analysis'); };\n${source}\nexport { auditEvidence };\n`);
