import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const fd = fs.openSync('/dev/vdb', 'r');
const header = Buffer.alloc(4096);
fs.readSync(fd, header, 0, header.length, 0);
const input = JSON.parse(header.toString('utf8').replace(/\0+$/, ''));
if (input.magic !== 'pkgxray-vm-v1' || !/^[a-f0-9]{64}$/.test(input.digest) ||
    !/^[a-f0-9]{32}$/.test(input.nonce) || !['developer', 'ci'].includes(input.profile) ||
    !Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > 64 * 1024 * 1024) {
  throw new Error('Invalid input disk');
}
const artifact = Buffer.alloc(input.bytes);
let offset = 0;
while (offset < artifact.length) {
  const read = fs.readSync(fd, artifact, offset, artifact.length - offset, 4096 + offset);
  if (!read) throw new Error('Truncated input disk');
  offset += read;
}
fs.closeSync(fd);
if (crypto.createHash('sha256').update(artifact).digest('hex') !== input.digest) throw new Error('Input digest mismatch');
fs.writeFileSync('/work/artifact.tgz', artifact, { mode: 0o400 });
process.stdout.write(`\nPKGXRAY_VM_READY ${input.nonce}\n`);
const started = performance.now();
const result = spawnSync('/usr/local/bin/node', ['/opt/pkgxray/runner.mjs',
  '--scenario', 'npm-vm-v1', '--artifact', '/work/artifact.tgz', '--expected-sha256', input.digest,
  '--profile', input.profile], {
  encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 60_000,
  env: { PATH: '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root', LANG: 'C.UTF-8' }
});
if (result.status !== 0 || result.error) throw new Error('Guest scenario failed');
const evidence = JSON.parse(result.stdout);
process.stdout.write(`\nPKGXRAY_VM_RESULT ${JSON.stringify({ nonce: input.nonce, digest: input.digest,
  profile: input.profile, scenarioMs: Math.round(performance.now() - started), ...evidence })}\n`);
