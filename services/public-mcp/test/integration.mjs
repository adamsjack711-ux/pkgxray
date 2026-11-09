import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { runSmoke, saveReport } from './smoke.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const reservation = createServer();
await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const endpoint = `http://127.0.0.1:${port}/mcp`;
const child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)),
  'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0', '--log-level', 'warn'], {
  cwd: root, env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
});
let log = '', exited = false, spawnError;
const exit = once(child, 'exit').catch(() => {});
child.once('exit', () => { exited = true; });
child.once('error', error => { spawnError = error; exited = true; });
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-65536); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let report;
try {
  let ready = false;
  const deadline = Date.now() + 45000;
  while (!ready && Date.now() < deadline) {
    if (exited) throw spawnError || new Error(`Local Worker exited before readiness:\n${log}`);
    try { const response = await fetch(new URL('/health', endpoint), { signal: AbortSignal.timeout(500) }); ready = response.ok; await response.body?.cancel(); } catch { /* Retry only readiness. */ }
    if (!ready) await sleep(200);
  }
  if (!ready) throw new Error(`Local Worker readiness deadline exceeded:\n${log}`);
  report = await runSmoke(endpoint, { metadata: false });
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report = { passed: false, endpoint, checks: [{ name: 'local Worker startup', passed: false, error: error.message }] };
  console.error(error.message); process.exitCode = 1;
} finally {
  if (!exited) {
    if (process.platform === 'win32') child.kill();
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ } }
    await Promise.race([exit, sleep(3000)]);
    if (!exited) { try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }
  }
  await saveReport(report, `${root}reports/integration.json`);
}
