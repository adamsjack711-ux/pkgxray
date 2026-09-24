"use strict";

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function sbpl(value) { return JSON.stringify(value); }
function real(value) { return fs.realpathSync(path.resolve(value)); }
function inside(file, dir) { return file === dir || file.startsWith(dir + path.sep); }

// OS confinement is explicit, with no downgrade to an unrestricted process.
// The selected working directory is read-only; HOME and TMPDIR are fresh.
function prepareMcpSandbox(command, args, env, options = {}) {
  if (!options.sandbox) return { command, args, env, cwd: options.cwd || process.cwd(), cleanup() {} };
  const platform = options.platform || process.platform;
  const wrapper = platform === 'darwin' ? '/usr/bin/sandbox-exec' : '/usr/bin/bwrap';
  if (!['darwin', 'linux'].includes(platform) || !fs.existsSync(wrapper)) {
    throw new Error('Requested MCP sandbox is unavailable (requires macOS sandbox-exec or Linux /usr/bin/bwrap); refusing to launch');
  }
  const cwd = real(options.cwd || process.cwd());
  if (cwd === path.parse(cwd).root || cwd === real(os.homedir())) {
    throw new Error('Sandbox working directory must be a dedicated project directory, not the filesystem root or HOME');
  }
  const executable = real(command);
  const reads = (options.sandboxRead || []).map(real);
  const writes = (options.sandboxWrite || []).map(real);
  for (const entry of [...reads, ...writes]) {
    if (entry === path.parse(entry).root || entry === real(os.homedir())) throw new Error('Sandbox grants cannot expose the filesystem root or entire HOME');
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgxray-mcp-'));
  fs.chmodSync(scratch, 0o700);
  const scratchPath = real(scratch);
  const childEnv = { ...env, HOME: scratchPath, TMPDIR: scratchPath, TMP: scratchPath, TEMP: scratchPath };
  const cleanup = () => fs.rmSync(scratchPath, { recursive: true, force: true });
  // Only operating-system/runtime directories are ambient readable roots.
  // Explicit grants are capabilities: granting a directory includes its files.
  const runtime = (platform === 'darwin'
    ? ['/System', '/usr', '/bin', '/sbin', '/opt/homebrew', '/Library/Apple', '/private/var/db/dyld']
    : ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc/ld.so.cache']).filter(p => fs.existsSync(p)).map(real);
  const readable = [...new Set([...runtime, cwd, ...reads, ...writes, scratchPath])];
  // Custom launchers outside runtime/project grants need an explicit grant for
  // their installation; revealing their entire parent automatically is unsafe.
  if (!readable.some(root => inside(executable, root))) {
    cleanup(); throw new Error('Sandbox launcher is outside readable roots; pass --sandbox-read for its runtime installation');
  }
  if (platform === 'darwin') {
    const profile = [
      '(version 1)', '(deny default)',
      '(import "dyld-support.sb")',
      '(allow process-exec)', '(allow signal (target self))',
      '(allow sysctl-read)', '(allow file-read-metadata)',
      `(allow file-read* file-map-executable ${readable.map(p => `(subpath ${sbpl(p)})`).join(' ')} (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))`,
      `(allow file-write* ${[scratchPath, ...writes].map(p => `(subpath ${sbpl(p)})`).join(' ')} (literal "/dev/null"))`
      // No network, Unix sockets, mach service access or arbitrary IPC grants.
    ].join('\n');
    return { command: wrapper, args: ['-p', profile, executable, ...args], env: childEnv, cwd, cleanup, level: 'sandbox-exec', scratchPath };
  }
  const binds = [];
  for (const p of readable.filter(p => !writes.includes(p) && p !== scratchPath)) binds.push('--ro-bind', p, p);
  for (const p of [scratchPath, ...writes]) binds.push('--bind', p, p);
  for (const alias of ['/bin', '/sbin', '/lib', '/lib64']) {
    if (fs.existsSync(alias) && real(alias) !== alias) binds.push('--symlink', real(alias), alias);
  }
  return { command: wrapper,
    args: ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--tmpfs', '/',
      ...binds, '--proc', '/proc', '--dev', '/dev', '--chdir', cwd, '--', executable, ...args],
    env: childEnv, cwd, cleanup, level: 'bwrap', scratchPath };
}
module.exports = { prepareMcpSandbox };
