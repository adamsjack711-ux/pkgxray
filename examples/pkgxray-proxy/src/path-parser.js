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
    // Anything with the tarball shape is ALWAYS returned as kind:'tarball' so the
    // gate sees it — never fall through to the ungated metadata/other passthrough
    // (that was a fail-open). If it isn't in strict canonical form
    // (`<name>/-/<unscoped-name>-<version>.tgz`), flag it invalid so the proxy
    // rejects it (fail closed) instead of serving a file whose basename/version
    // diverges from what was scanned.
    const result = { kind: 'tarball', name, version, filename };
    if (!isCanonicalTarball(name, version, filename)) {
      result.invalid = true;
    }
    return result;
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

// npm package name grammar (permissive enough for legacy names, but rejects
// path-traversal, slashes beyond a single scope separator, and control chars).
const NPM_NAME_RE = /^(?:@[a-zA-Z0-9-~][a-zA-Z0-9-._~]*\/)?[a-zA-Z0-9-~][a-zA-Z0-9-._~]*$/;
// Version token: semver-ish charset only. No `/`, no `..`, no control chars —
// this is what blocks version-field path smuggling.
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.\-+]*$/;

function isValidName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 214 && NPM_NAME_RE.test(name);
}

function isValidVersion(version) {
  return (
    typeof version === 'string' &&
    version.length > 0 &&
    version.length <= 256 &&
    !version.includes('..') &&
    VERSION_RE.test(version)
  );
}

/**
 * A tarball request is canonical iff the name and version are well-formed AND
 * the basename is exactly `<unscoped-name>-<version>.tgz`. This binds the served
 * artifact to the identity the gate scans: a request like
 * `/lodash/-/evil-4.17.21.tgz` (scanned as lodash@4.17.21 but named `evil-…`)
 * fails this check.
 */
function isCanonicalTarball(name, version, filename) {
  if (!isValidName(name) || !isValidVersion(version)) return false;
  const unscoped = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
  return filename === `${unscoped}-${version}.tgz`;
}

/**
 * The canonical upstream path for a validated tarball identity. The proxy fetches
 * THIS (not the client's raw URL) so the bytes served match what was scanned.
 * @param {string} name
 * @param {string} version
 * @returns {string} e.g. "/@babel/core/-/core-7.24.0.tgz"
 */
export function canonicalTarballPath(name, version) {
  const unscoped = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
  return `/${name}/-/${unscoped}-${version}.tgz`;
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
