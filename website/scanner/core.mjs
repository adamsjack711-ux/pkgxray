// Public sources are data only. This module never imports or evaluates package code.
export const LIMITS = Object.freeze({ archive: 8 * 1024 * 1024, expanded: 32 * 1024 * 1024, entries: 5000, files: 100, file: 128 * 1024, source: 1024 * 1024 });
const hosts = new Set(['registry.npmjs.org', 'api.github.com', 'raw.githubusercontent.com', 'api.osv.dev']);
const text = new TextDecoder('utf-8', { fatal: true });
const bytes = value => new TextEncoder().encode(value);
const sourceName = name => /(?:\.(?:[cm]?js|jsx|[cm]?ts|tsx|json|ya?ml|toml|sh|bash|ps1|py|rb|go|rs|md|txt)|(?:^|\/)(?:Dockerfile|Makefile|\.npmrc|\.gitmodules))$/i.test(name);
const exactVersion = value => /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);

export function parseReference(value) {
  if (typeof value !== 'string' || value.length > 500 || /[\x00-\x20\x7f\\]/.test(value.trim())) throw new Error('Enter a package name or public GitHub repository without spaces.');
  let input = value.trim();
  if (/^https:\/\/(?:www\.)?npmjs.com\//.test(input)) {
    const url = new URL(input);
    if (url.username || url.password || url.search || url.hash || url.port) throw new Error('Use a plain npm package URL.');
    const match = decodeURIComponent(url.pathname).match(/^\/package\/((?:@[^/]+\/)?[^/]+)(?:\/v\/([^/]+))?\/?$/);
    if (!match) throw new Error('Use an npm package page or name.');
    input = match[1] + (match[2] ? `@${match[2]}` : '');
  }
  if (input.startsWith('github:') || input.startsWith('https://github.com/')) {
    let spec = input.replace(/^github:|^https:\/\/github\.com\//, '');
    const match = spec.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[#@]([^?#]+))?\/?$/);
    if (!match || [match[1], match[2]].some(s => s === '.' || s === '..')) throw new Error('Use github:owner/repo#ref or https://github.com/owner/repo.');
    const ref = match[3] || 'HEAD';
    if (ref.length > 200 || ref.includes('..') || /[\x00-\x20\\]/.test(ref)) throw new Error('Invalid GitHub revision.');
    return { type: 'github', owner: match[1], repo: match[2], ref };
  }
  input = input.replace(/^npm:/, '');
  const match = input.match(/^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@([^@/]+))?$/);
  if (!match || match[1].length > 214) throw new Error('Supported sources: public npm packages and GitHub repositories.');
  const version = match[2] || 'latest';
  if (!exactVersion(version) && !/^[a-zA-Z][a-zA-Z0-9._-]{0,60}$/.test(version)) throw new Error('Use an exact npm version or a published tag such as latest.');
  return { type: 'npm', name: match[1], version };
}

export async function readBounded(stream, limit, signal) {
  if (!stream) throw new Error('Empty upstream response.');
  const reader = stream.getReader();
  const chunks = []; let length = 0;
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new Error('Download timed out.');
      const item = await reader.read();
      if (signal?.aborted) throw new Error('Download timed out.');
      if (item.done) break;
      length += item.value.length;
      if (length > limit) throw new Error(`Source exceeds this browser scan's ${Math.round(limit / 1024)} KiB limit. Use the local CLI for larger scans.`);
      chunks.push(item.value);
    }
    const result = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  } finally { signal?.removeEventListener('abort', cancel); cancel(); }
}

async function acquire(url, limit, fetcher, options = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !hosts.has(target.hostname) || target.port || target.username || target.password || target.hash) throw new Error('Unsupported source host.');
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetcher(target.href, { ...options, credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal });
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error(`Source returned HTTP ${response.status}. Check the reference; public API limits may require trying later.`); }
    return await readBounded(response.body, limit, controller.signal);
  } finally { clearTimeout(timer); }
}
const json = async (url, fetcher, options) => JSON.parse(text.decode(await acquire(url, 2 * 1024 * 1024, fetcher, options)));
const hex = data => Array.from(data, x => x.toString(16).padStart(2, '0')).join('');
const digest = async (algorithm, data) => new Uint8Array(await crypto.subtle.digest(algorithm, data));

export function safePath(input) {
  const name = input.replace(/^\.\//, '');
  if (!name || name.length > 1024 || name.startsWith('/') || /[\x00-\x1f\x7f\\:]/.test(name) || name.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Unsafe or ambiguous archive/source path.');
  return name;
}

function number(field) {
  if (field[0] & 128) throw new Error('Unsupported binary tar size.');
  const value = text.decode(field).replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(value || '0')) throw new Error('Invalid tar header.');
  const result = parseInt(value || '0', 8);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Invalid tar size.');
  return result;
}
const fieldText = field => text.decode(field.subarray(0, field.indexOf(0) < 0 ? field.length : field.indexOf(0)));

function paxFields(data) {
  const result = {}; let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(32, offset);
    if (space < 0) throw new Error('Invalid tar extended header.');
    const lengthText = text.decode(data.subarray(offset, space));
    if (!/^[1-9]\d{0,6}$/.test(lengthText)) throw new Error('Invalid tar extended header length.');
    const length = Number(lengthText), end = offset + length;
    if (end > data.length || end <= space + 2 || data[end - 1] !== 10) throw new Error('Truncated tar extended header.');
    const record = text.decode(data.subarray(space + 1, end - 1)), equals = record.indexOf('=');
    if (equals < 1) throw new Error('Invalid tar extended header record.');
    const key = record.slice(0, equals), value = record.slice(equals + 1);
    if (/sparse/i.test(key)) throw new Error('Sparse archives are not supported.');
    if (['path', 'size'].includes(key)) result[key] = value;
    offset = end;
  }
  return result;
}

export function unpackTar(data) {
  const entries = []; const seen = new Set();
  let offset = 0, count = 0, extra = {}, root;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512); offset += 512;
    if (header.every(v => v === 0)) {
      if (data.subarray(offset).some(v => v !== 0)) throw new Error('Unexpected trailing archive data.');
      if (Object.keys(extra).length) throw new Error('Incomplete tar extended header.');
      return entries;
    }
    if (++count > LIMITS.entries) throw new Error('Archive contains too many entries for a browser scan.');
    const checksum = header.reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0);
    if (checksum !== number(header.subarray(148, 156))) throw new Error('Archive checksum mismatch.');
    const type = header[156] ? String.fromCharCode(header[156]) : '0';
    let size = number(header.subarray(124, 136));
    if (!['x', 'L'].includes(type) && extra.size !== undefined) {
      if (!/^\d{1,10}$/.test(extra.size)) throw new Error('Invalid extended archive size.');
      size = Number(extra.size);
    }
    if (size > LIMITS.expanded || offset + Math.ceil(size / 512) * 512 > data.length) throw new Error('Truncated or oversized archive entry.');
    const content = data.subarray(offset, offset + size); offset += Math.ceil(size / 512) * 512;
    if (type === 'x') { extra = { ...extra, ...paxFields(content) }; continue; }
    if (type === 'L') { extra.path = fieldText(content).replace(/\n$/, ''); continue; }
    if (type === 'g' || type === 'K') throw new Error('Unsupported archive extension; use the local CLI.');
    const prefix = fieldText(header.subarray(345, 500));
    let name = extra.path || (prefix ? `${prefix}/` : '') + fieldText(header.subarray(0, 100)); extra = {};
    if (type === '5') { safePath(name.replace(/\/$/, '')); continue; }
    name = safePath(name);
    const split = name.indexOf('/');
    if (split < 1) throw new Error('npm archive must have one containing directory.');
    root ||= name.slice(0, split);
    if (name.slice(0, split) !== root) throw new Error('Archive contains multiple roots.');
    name = safePath(name.slice(split + 1));
    if (seen.has(name)) throw new Error('Archive contains duplicate paths.');
    seen.add(name); entries.push({ path: name, size, type, content });
  }
  throw new Error('Archive is missing its end marker.');
}

async function advisories(query, fetcher) {
  try {
    const response = await json('https://api.osv.dev/v1/query', fetcher, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(query) });
    if (!response || typeof response !== 'object' || Array.isArray(response) || response.error || (response.vulns !== undefined && !Array.isArray(response.vulns))) throw new Error('Invalid advisory response.');
    const all = response.vulns || [];
    if (all.some(v => !v || typeof v.id !== 'string')) throw new Error('Invalid advisory record.');
    return { status: 'completed', entries: all.filter(v => !v.withdrawn).slice(0, 100).map(v => ({ id: v.id.slice(0, 160), summary: String(v.summary || '').slice(0, 500) })), truncated: all.length > 100 };
  } catch { return { status: 'unavailable', entries: [], truncated: false }; }
}

function select(entries, gaps) {
  let budget = 0, ignored = 0;
  const selected = [];
  for (const entry of [...entries].sort((a, b) => (a.path === 'package.json' ? -1 : b.path === 'package.json' ? 1 : a.path.localeCompare(b.path)))) {
    if (entry.type !== '0') { gaps.add('Links, submodules, or special entries were not followed.'); continue; }
    if (!sourceName(entry.path)) { ignored++; continue; }
    if (entry.size > LIMITS.file || budget + entry.size > LIMITS.source || selected.length >= LIMITS.files) { gaps.add('Some source files exceeded browser scan size or file limits.'); continue; }
    budget += entry.size; selected.push(entry);
  }
  if (ignored) gaps.add(`${ignored} other files were not analyzed as source; native binaries and unknown formats are not covered.`);
  return selected;
}

export async function scanReference(reference, { fetcher = fetch, audit, progress = () => {} } = {}) {
  const start = performance.now(), parsed = parseReference(reference), gaps = new Set();
  const files = Object.create(null); let identity, integrity, entries, vulnerability, resolved;
  if (parsed.type === 'npm') {
    progress('Resolving the exact npm version…');
    const metadata = await json(`https://registry.npmjs.org/${encodeURIComponent(parsed.name)}/${encodeURIComponent(parsed.version)}`, fetcher);
    if (metadata.name !== parsed.name || !exactVersion(metadata.version) || (exactVersion(parsed.version) && parsed.version !== metadata.version)) throw new Error('Registry package identity did not match the request.');
    resolved = `npm:${parsed.name}@${metadata.version}`;
    identity = { name: parsed.name, version: metadata.version };
    progress('Downloading the package as data…');
    const archiveUrl = new URL(metadata.dist?.tarball);
    if (archiveUrl.origin !== 'https://registry.npmjs.org' || archiveUrl.search || archiveUrl.hash || archiveUrl.username || archiveUrl.password || !archiveUrl.pathname.endsWith('.tgz')) throw new Error('Unsupported npm archive URL.');
    const archive = await acquire(archiveUrl, LIMITS.archive, fetcher);
    const tokens = String(metadata.dist?.integrity || '').split(/\s+/).filter(token => /^sha(?:256|512)-[A-Za-z0-9+/]+={0,2}$/.test(token));
    const algorithm = tokens.some(token => token.startsWith('sha512-')) ? 'sha512' : tokens.some(token => token.startsWith('sha256-')) ? 'sha256' : null;
    if (algorithm) {
      const hashed = await digest(algorithm === 'sha512' ? 'SHA-512' : 'SHA-256', archive);
      const encoded = btoa(String.fromCharCode(...hashed));
      if (!tokens.includes(`${algorithm}-${encoded}`)) throw new Error('Archive integrity does not match npm metadata. No scan result was issued.');
      integrity = `verified-${algorithm}`;
    } else { integrity = 'unverified'; gaps.add('npm did not provide a supported SHA-256/SHA-512 archive integrity value.'); }
    identity.archiveSha256 = hex(await digest('SHA-256', archive));
    progress('Reading archive contents without executing them…');
    if (typeof DecompressionStream !== 'function') throw new Error('This browser does not support gzip decompression. Use a current browser or the local CLI.');
    const expanded = await readBounded(new Blob([archive]).stream().pipeThrough(new DecompressionStream('gzip')), LIMITS.expanded, AbortSignal.timeout(10000));
    entries = unpackTar(expanded);
    const manifest = entries.find(entry => entry.path === 'package.json' && entry.type === '0');
    if (!manifest || manifest.size > LIMITS.file) throw new Error('Package manifest is missing or too large.');
    const pkg = JSON.parse(text.decode(manifest.content));
    if (pkg.name !== identity.name || pkg.version !== identity.version) throw new Error('Archive manifest does not match the resolved package.');
    for (const entry of select(entries, gaps)) {
      try { files[entry.path] = text.decode(entry.content); } catch { gaps.add('Some files are not UTF-8 text and were not analyzed.'); }
    }
    progress('Checking public vulnerability advisories…');
    vulnerability = await advisories({ package: { ecosystem: 'npm', name: identity.name }, version: identity.version }, fetcher);
  } else {
    progress('Resolving the GitHub revision to a commit…');
    const base = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;
    const commit = await json(`${base}/commits/${encodeURIComponent(parsed.ref)}`, fetcher);
    if (!/^[a-f0-9]{40}$/.test(commit.sha) || !/^[a-f0-9]{40}$/.test(commit.commit?.tree?.sha)) throw new Error('GitHub returned an invalid commit identity.');
    identity = { repository: `${parsed.owner}/${parsed.repo}`, commit: commit.sha };
    resolved = `github:${identity.repository}#${commit.sha}`; integrity = 'commit-and-blob-identities';
    const tree = await json(`${base}/git/trees/${commit.commit.tree.sha}?recursive=1`, fetcher);
    if (!Array.isArray(tree.tree)) throw new Error('GitHub did not return a source tree.');
    if (tree.truncated || tree.tree.length > LIMITS.entries) gaps.add('The repository tree was truncated by GitHub or browser scan limits.');
    entries = tree.tree.slice(0, LIMITS.entries).filter(entry => entry.type !== 'tree').map(entry => {
      if (!Number.isSafeInteger(entry.size) || entry.size < 0) { gaps.add('Some Git entries have no readable file size.'); return { path: safePath(entry.path), type: 'unsupported', size: 0 }; }
      return { path: safePath(entry.path), sha: entry.sha, size: entry.size, type: entry.type === 'blob' && ['100644', '100755'].includes(entry.mode) ? '0' : 'unsupported' };
    });
    const selected = select(entries, gaps); let next = 0, completed = 0;
    await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
      while (next < selected.length) {
        const entry = selected[next++];
        try {
          const content = await acquire(`https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${commit.sha}/${entry.path.split('/').map(encodeURIComponent).join('/')}`, LIMITS.file, fetcher);
          const prefix = bytes(`blob ${content.length}\0`), object = new Uint8Array(prefix.length + content.length); object.set(prefix); object.set(content, prefix.length);
          if (content.length !== entry.size || hex(await digest('SHA-1', object)) !== entry.sha) throw new Error('Git blob identity mismatch');
          files[entry.path] = text.decode(content);
        } catch { gaps.add('Some GitHub files could not be fetched or verified; analysis is partial.'); }
        progress(`Reading source files as data: ${++completed}/${selected.length}…`);
      }
    }));
    progress('Checking advisories for the resolved commit…');
    vulnerability = await advisories({ commit: commit.sha }, fetcher);
    gaps.add('GitHub commit advisories may be unavailable for repositories not indexed by OSV.');
  }
  if (!Object.keys(files).length) throw new Error('No supported source files could be read. No security verdict was issued.');
  if (vulnerability.status !== 'completed') gaps.add('The vulnerability lookup did not complete.');
  if (vulnerability.truncated) gaps.add('The advisory response was truncated.');
  progress('Analyzing source with the pkgxray engine…');
  const result = audit({ packageName: identity.name || identity.repository, sourceFiles: files });
  const severity = { high: 0, medium: 1, low: 2, info: 3 };
  const findings = [...result.findings].sort((a, b) => (severity[a.severity] ?? 4) - (severity[b.severity] ?? 4));
  if (findings.length > 100) gaps.add('The report contains the first 100 findings, ordered by severity.');
  const verdict = result.verdict === 'block' || vulnerability.entries.length ? 'block' : 'review';
  return { schemaVersion: 1, mode: 'website-cold-static-scan', scannedAt: new Date().toISOString(), reference: resolved, identity, verdict, staticVerdict: result.verdict,
    summary: verdict === 'block' ? 'Blocking source findings or known vulnerability advisories were found. Inspect the evidence before proceeding.' : `No blocking findings in ${Object.keys(files).length} scanned files. This bounded static check does not approve installation.`,
    findings: findings.slice(0, 100).map(f => ({ severity: f.severity, category: f.category, file: String(f.file || '').slice(0, 1024), rationale: String(f.rationale || '').slice(0, 1600), snippet: String(f.snippet || '').slice(0, 1000) })),
    advisories: vulnerability.entries, installationApproved: false,
    coverage: { scannedFiles: Object.keys(files).length, inventoriedEntries: entries.length, sourceBytes: Object.values(files).reduce((sum, value) => sum + bytes(value).length, 0), integrity, vulnerabilities: vulnerability.status,
      executed: false, dependenciesScanned: false, provenanceVerified: false, gaps: [...gaps], limits: LIMITS }, durationMs: Math.round(performance.now() - start) };
}
