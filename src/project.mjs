import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export class AnalysisGap extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new AnalysisGap(code, message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const packagePath = /^(?:node_modules\/(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+)(?:\/node_modules\/(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+)*$/;
const exactVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export class Project {
  constructor(root, limits, gap) {
    this.root = fs.realpathSync(root);
    this.limits = limits;
    this.gap = gap;
    this.packages = new Map();
    this.reads = new Map();
    this.totalBytes = 0;
    const lockBytes = this.read('package-lock.json', limits.maxLockBytes, false);
    this.lockfileSha256 = sha256(lockBytes);
    let lock;
    try { lock = JSON.parse(lockBytes.toString('utf8')); }
    catch { fail('invalid-lockfile', 'package-lock.json is not valid JSON.'); }
    if (![2, 3].includes(lock.lockfileVersion) || !object(lock.packages) || !object(lock.packages[''])) {
      fail('unsupported-lockfile', 'An npm lockfile v2 or v3 with a root packages entry is required.');
    }
    const entries = Object.entries(lock.packages);
    if (entries.length > limits.maxPackages) fail('package-budget', 'Lockfile package limit exceeded.');
    for (const [location, meta] of entries) {
      if (location !== '' && (!packagePath.test(location) || location.split('/').some(p => p === '.' || p === '..'))) {
        fail('unsupported-package-path', `Unsupported package path: ${location}`);
      }
      if (!object(meta)) fail('invalid-lockfile', `Invalid package entry: ${location}`);
      const installedName = location.split('/node_modules/').at(-1).replace(/^node_modules\//, '');
      const pkg = { id: location || '.', path: location, name: meta.name || installedName || lock.name || '(root)', version: meta.version || null,
        lockIntegrity: meta.integrity || null, manifest: null, files: new Map() };
      this.packages.set(location, pkg);
      try {
        if (meta.link) fail('unsupported-link', `Workspace/link package is unsupported: ${pkg.id}`);
        if (location && (typeof meta.version !== 'string' || !exactVersion.test(meta.version))) fail('unresolved-version', `Exact version required: ${pkg.id}`);
        const manifestPath = path.posix.join(location, 'package.json');
        const bytes = this.read(manifestPath, limits.maxFileBytes);
        let manifest;
        try { manifest = JSON.parse(bytes.toString('utf8')); }
        catch { fail('invalid-manifest', `Invalid JSON: ${manifestPath}`); }
        if (!object(manifest)) fail('invalid-manifest', `Expected manifest object: ${manifestPath}`);
        if (location && (manifest.version !== meta.version || (meta.name && manifest.name !== meta.name) || (!meta.name && manifest.name !== installedName))) {
          fail('identity-mismatch', `Source manifest does not match locked name/version: ${pkg.id}`);
        }
        if (!location && ((meta.name && meta.name !== manifest.name) || (meta.version && meta.version !== manifest.version))) {
          fail('identity-mismatch', 'Root manifest does not match the lockfile.');
        }
        pkg.name = manifest.name || pkg.name;
        pkg.version = manifest.version || pkg.version;
        pkg.manifest = manifest;
        pkg.files.set(manifestPath, sha256(bytes));
      } catch (error) { this.report(error, location || 'package.json'); }
    }
  }

  report(error, file) {
    this.gap(error.code || 'input-error', error.message, { file });
  }

  // Paths are interpreted beneath the explicitly supplied source root. Reject
  // links in every component, even when they point back inside the tree.
  inspect(relative) {
    if (typeof relative !== 'string' || relative.includes('\\') || relative.includes('\0') || path.posix.isAbsolute(relative) || relative.split('/').includes('..')) {
      fail('unsafe-path', `Path outside supported source layout: ${relative}`);
    }
    let current = this.root;
    const parts = relative.split('/').filter(part => part && part !== '.');
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      let stat;
      try { stat = fs.lstatSync(current); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      if (stat.isSymbolicLink()) fail('unsupported-symlink', `Source links are unsupported: ${relative}`);
      if (i < parts.length - 1 && !stat.isDirectory()) fail('invalid-path', `Non-directory in source path: ${relative}`);
      if (i === parts.length - 1) return { absolute: current, stat };
    }
    return { absolute: this.root, stat: fs.statSync(this.root) };
  }

  read(relative, maxBytes = this.limits.maxFileBytes, count = true) {
    if (this.reads.has(relative)) return this.reads.get(relative);
    const info = this.inspect(relative);
    if (!info) fail('missing-source', `Missing source file: ${relative}`);
    if (!info.stat.isFile()) fail('unsupported-file', `Expected regular source file: ${relative}`);
    if (info.stat.size > maxBytes) fail('file-budget', `File exceeds byte limit: ${relative}`);
    if (count && this.totalBytes + info.stat.size > this.limits.maxTotalBytes) fail('source-budget', 'Total source byte limit exceeded.');
    // Bound actual bytes too, in case the file grows after lstat. Never eval,
    // import or require any target file.
    const fd = fs.openSync(info.absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let bytes;
    try {
      if (!fs.fstatSync(fd).isFile()) fail('unsupported-file', `Source changed to a non-regular file: ${relative}`);
      const buffer = Buffer.alloc(maxBytes + 1);
      let size = 0, n;
      while (size < buffer.length && (n = fs.readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += n;
      if (size > maxBytes) fail('file-budget', `File exceeds byte limit: ${relative}`);
      bytes = Buffer.from(buffer.subarray(0, size));
    } finally { fs.closeSync(fd); }
    if (count && (this.totalBytes += bytes.length) > this.limits.maxTotalBytes) fail('source-budget', 'Total source byte limit exceeded.');
    this.reads.set(relative, bytes);
    return bytes;
  }

  owner(file) {
    let best = this.packages.get('');
    for (const pkg of this.packages.values()) {
      if (pkg.path && (file === pkg.path || file.startsWith(`${pkg.path}/`)) && pkg.path.length > best.path.length) best = pkg;
    }
    const rest = file.slice(best.path ? best.path.length + 1 : 0);
    if (rest.split('/').includes('node_modules')) fail('unlocked-package', `Source is not in the lockfile: ${file}`);
    if (!best.manifest) fail('missing-package', `Package manifest unavailable: ${best.id}`);
    return best;
  }

  reference(file, node) {
    const pkg = this.owner(file);
    return { package: { id: pkg.id, name: pkg.name, version: pkg.version }, file,
      line: node?.loc?.start.line || 1, column: (node?.loc?.start.column || 0) + 1 };
  }

  source(file) {
    const pkg = this.owner(file);
    // Nested package scopes can alter the module format/resolution contract.
    let dir = path.posix.dirname(file);
    while (dir !== (pkg.path || '.') && dir !== '.') {
      if (this.inspect(path.posix.join(dir, 'package.json'))) fail('nested-package-scope', `Nested package scope is unsupported: ${dir}`);
      dir = path.posix.dirname(dir);
    }
    if (file.endsWith('.mjs') || (pkg.manifest.type === 'module' && !file.endsWith('.cjs'))) fail('unsupported-module-format', `ES modules are not supported yet: ${file}`);
    if (!/\.(?:c?js)$/.test(file)) fail('unsupported-module-format', `Only CommonJS .js/.cjs files are modeled: ${file}`);
    const bytes = this.read(file);
    pkg.files.set(file, sha256(bytes));
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { fail('invalid-encoding', `Source is not UTF-8: ${file}`); }
  }

  fileTarget(candidate, pkg, depth = 0) {
    if (depth > 4) fail('resolution-budget', 'Directory main resolution limit exceeded.');
    if (this.owner(candidate).id !== pkg.id) fail('cross-boundary-path', `Relative target escapes its package: ${candidate}`);
    for (const name of [candidate, `${candidate}.js`, `${candidate}.json`, `${candidate}.node`]) {
      const info = this.inspect(name);
      if (info?.stat.isFile()) return name;
    }
    const info = this.inspect(candidate);
    if (info?.stat.isDirectory()) {
      const nestedManifest = path.posix.join(candidate, 'package.json');
      if (candidate !== pkg.path && this.inspect(nestedManifest)) fail('nested-package-scope', `Nested package scope is unsupported: ${candidate}`);
      if (candidate === pkg.path && pkg.manifest.main !== undefined) {
        const main = pkg.manifest.main;
        if (typeof main !== 'string' || main.includes('\\') || path.posix.isAbsolute(main)) fail('unsupported-main', `Unsupported main field: ${pkg.id}`);
        const target = path.posix.normalize(path.posix.join(candidate, main));
        if (target !== candidate) {
          try { return this.fileTarget(target, pkg, depth + 1); }
          catch (error) { if (error.code !== 'missing-module') throw error; }
        }
      }
      for (const suffix of ['index.js', 'index.json', 'index.node']) {
        const target = path.posix.join(candidate, suffix);
        if (this.inspect(target)?.stat.isFile()) return target;
      }
    }
    fail('missing-module', `Cannot resolve module: ${candidate}`);
  }

  resolve(from, specifier) {
    if (typeof specifier !== 'string' || !specifier || specifier.includes('\\') || specifier.includes('\0')) fail('unsupported-import', 'Require must use a supported literal module specifier.');
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
      return this.fileTarget(target, this.owner(from));
    }
    const match = specifier.match(/^((?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+)(?:\/(.+))?$/);
    if (!match || specifier.split('/').some(p => p === '.' || p === '..')) fail('unsupported-import', `Unsupported module specifier: ${specifier}`);
    const [, name, subpath] = match;
    const caller = this.owner(from);
    if (caller.manifest.name === name) fail('unsupported-self-reference', `Package self-reference is not modeled: ${name}`);
    let dir = path.posix.dirname(from), pkg;
    while (true) {
      if (path.posix.basename(dir) !== 'node_modules') {
        const candidate = path.posix.join(dir === '.' ? '' : dir, 'node_modules', name);
        if (this.packages.has(candidate)) { pkg = this.packages.get(candidate); break; }
        if (this.inspect(candidate)) fail('unlocked-package', `Installed package is absent from the lockfile: ${candidate}`);
      }
      if (dir === '.') break;
      dir = path.posix.dirname(dir);
    }
    if (!pkg?.manifest) fail('missing-package', `No locked source for ${specifier} imported by ${from}`);
    if (Object.hasOwn(pkg.manifest, 'exports')) {
      const exp = pkg.manifest.exports;
      const key = subpath ? `./${subpath}` : '.';
      const target = typeof exp === 'string' && !subpath ? exp : object(exp) ? exp[key] : undefined;
      if (typeof target !== 'string' || !target.startsWith('./') || target.includes('*') || target.split('/').includes('..')) fail('unsupported-exports', `Only exact string exports are modeled: ${pkg.id} ${key}`);
      const file = path.posix.join(pkg.path, target);
      if (this.owner(file).id !== pkg.id || !this.inspect(file)?.stat.isFile()) fail('missing-module', `Missing export target: ${file}`);
      return file;
    }
    return this.fileTarget(subpath ? path.posix.join(pkg.path, subpath) : pkg.path, pkg);
  }

  identities() {
    return [...this.packages.values()].map(pkg => {
      const files = [...pkg.files].sort(([a], [b]) => a.localeCompare(b)).map(([file, hash]) => ({ file, sha256: hash }));
      return { id: pkg.id, name: pkg.name, version: pkg.version, lockIntegrity: pkg.lockIntegrity,
        registryIntegrityVerified: false, analyzedContentSha256: sha256(JSON.stringify(files)), files };
    });
  }
}
