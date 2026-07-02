// Parse npm registry request paths into a structured shape.
//
// The npm registry surface we care about:
//   metadata (packument):  GET /lodash               -> {kind:'metadata', name:'lodash'}
//                          GET /@scope/pkg            -> {kind:'metadata', name:'@scope/pkg'}
//   tarball:               GET /lodash/-/lodash-4.17.21.tgz
//                          GET /@scope/pkg/-/pkg-1.2.3.tgz
//   version metadata:      GET /lodash/4.17.21        -> treated as metadata (pass-through)
//
// The tarball convention is `<name>/-/<basename>.tgz`. The `/-/` separator is
// the reliable marker; the basename is `<unscoped-name>-<version>.tgz`.

const TARBALL_SEP = '/-/';

/**
 * @param {string} rawPath a request path, e.g. "/@scope/pkg/-/pkg-1.2.3.tgz"
 * @returns {{kind:'metadata'|'tarball'|'other', name?:string, version?:string, filename?:string}}
 */
export function parsePath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return { kind: 'other' };
  }

  // Strip query string / fragment and leading slash, decode percent-encoding.
  let path = rawPath.split(/[?#]/, 1)[0];
  if (path.startsWith('/')) path = path.slice(1);
  if (path.length === 0) return { kind: 'other' }; // registry root

  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    decoded = path; // tolerate malformed encoding
  }

  // Tarball request: contains the `/-/` separator and ends in .tgz
  const sepIdx = decoded.indexOf(TARBALL_SEP);
  if (sepIdx !== -1 && decoded.endsWith('.tgz')) {
    const name = decoded.slice(0, sepIdx);
    const filename = decoded.slice(sepIdx + TARBALL_SEP.length);
    const version = versionFromTarball(name, filename);
    if (name && version) {
      return { kind: 'tarball', name, version, filename };
    }
    // Malformed tarball path — fall through to "other".
    return { kind: 'other' };
  }

  // Non-tarball. Distinguish metadata from other registry endpoints
  // (e.g. /-/v1/search, /-/npm/..., /-/user/...).
  const segments = decoded.split('/').filter(Boolean);

  if (segments[0] === '-') {
    // Registry service endpoints, not a package.
    return { kind: 'other' };
  }

  if (decoded[0] === '@') {
    // Scoped: @scope/name  (metadata) or  @scope/name/version (version metadata)
    if (segments.length >= 2) {
      const name = `${segments[0]}/${segments[1]}`;
      const version = segments.length >= 3 ? segments[2] : undefined;
      return { kind: 'metadata', name, ...(version ? { version } : {}) };
    }
    return { kind: 'other' }; // just "@scope"
  }

  // Unscoped: name (metadata) or name/version (version metadata)
  const name = segments[0];
  const version = segments.length >= 2 ? segments[1] : undefined;
  return { kind: 'metadata', name, ...(version ? { version } : {}) };
}

/**
 * Extract the version from a tarball basename given the package name.
 * `<unscoped>-<version>.tgz` — the unscoped part of the name is the prefix.
 */
function versionFromTarball(name, filename) {
  if (!filename.endsWith('.tgz')) return undefined;
  const base = filename.slice(0, -'.tgz'.length);
  const unscoped = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
  const prefix = `${unscoped}-`;
  if (base.startsWith(prefix)) {
    const version = base.slice(prefix.length);
    return version || undefined;
  }
  // Fallback: version is whatever follows the last `-` that begins a digit.
  const m = base.match(/-(\d[^/]*)$/);
  return m ? m[1] : undefined;
}
