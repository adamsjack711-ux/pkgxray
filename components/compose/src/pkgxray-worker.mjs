// This process loads only the explicitly selected, trusted scanner. Target
// package files arrive as inert JSON strings, never as modules to import.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
try {
  const scanner = path.resolve(process.argv[2]);
  const metadata = JSON.parse(fs.readFileSync(path.join(scanner, 'package.json'), 'utf8'));
  if (metadata.name !== 'pkgxray') throw new Error('Expected a trusted pkgxray checkout or unpacked distribution.');
  const { auditEvidence } = require(path.join(scanner, 'src/auditor.js'));
  const { BUILD_ID } = require(path.join(scanner, 'src/artifact.js'));
  if (typeof auditEvidence !== 'function' || !/^[a-f0-9]{64}$/.test(BUILD_ID)) throw new Error('Unsupported pkgxray API.');
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const packages = input.map(({ id, evidence }) => {
    try { return { id, status: 'completed', report: auditEvidence(evidence) }; }
    catch (error) { return { id, status: 'failed', error: String(error.message).slice(0, 1000) }; }
  });
  process.stdout.write(JSON.stringify({ engine: { name: 'pkgxray', version: metadata.version, buildId: BUILD_ID }, packages }));
} catch (error) {
  process.stderr.write(String(error.message).slice(0, 1000));
  process.exitCode = 1;
}
