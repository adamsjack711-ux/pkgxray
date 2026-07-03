// File-backed verdict cache: name@version -> { decision, findings, ts }.
//
// Verdict caching is mandatory — a popular package is installed thousands of
// times; the first requester pays the ~1.3s scan, everyone else hits cache.
//
// Only real verdicts are cached: allow | block | review. Scan errors and
// "unknown" are NEVER persisted, so a transient failure can't poison the cache.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const CACHEABLE = new Set(['allow', 'block', 'review']);

export class VerdictStore {
  /**
   * @param {string} path file path for the JSON store
   * @param {object} [opts]
   * @param {() => number} [opts.now] clock injection for tests
   */
  constructor(path, opts = {}) {
    this.path = path;
    this._now = opts.now || (() => Date.now());
    this._map = new Map(); // key -> {decision, findings, ts}
    this._load();
  }

  static key(name, version) {
    return `${name}@${version}`;
  }

  // Split a "name@version" key back into its parts. Scoped names keep their
  // leading "@" — the version is always after the LAST "@".
  static parseKey(key) {
    const at = key.lastIndexOf('@');
    if (at <= 0) return { name: key, version: '' };
    return { name: key.slice(0, at), version: key.slice(at + 1) };
  }

  /**
   * Is this cached entry too old to trust? Used for TTL-based lazy refresh.
   * A missing/zero ts is always stale (unknown age). ttlMs=0 => always stale
   * (force re-scan). ttlMs undefined/null => TTL disabled, never stale.
   */
  isStale(entry, ttlMs) {
    if (!entry) return true;
    if (ttlMs === undefined || ttlMs === null) return false;
    if (typeof entry.ts !== 'number' || entry.ts <= 0) return true;
    return this._now() - entry.ts > ttlMs;
  }

  /** Snapshot of every cached entry as {name, version, decision, findings, ts}. */
  entries() {
    const out = [];
    for (const [k, v] of this._map) {
      const { name, version } = VerdictStore.parseKey(k);
      out.push({ name, version, decision: v.decision, findings: v.findings, ts: v.ts });
    }
    return out;
  }

  _load() {
    let raw;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return; // no store yet — start empty
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt store — tolerate it, start empty rather than crash.
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const entries = parsed.verdicts && typeof parsed.verdicts === 'object' ? parsed.verdicts : parsed;
    for (const [k, v] of Object.entries(entries)) {
      if (v && typeof v === 'object' && CACHEABLE.has(v.decision)) {
        this._map.set(k, {
          decision: v.decision,
          findings: Array.isArray(v.findings) ? v.findings : [],
          ts: typeof v.ts === 'number' ? v.ts : 0,
        });
      }
    }
  }

  /**
   * @returns {{decision, findings, ts} | undefined}
   */
  get(name, version) {
    return this._map.get(VerdictStore.key(name, version));
  }

  has(name, version) {
    return this._map.has(VerdictStore.key(name, version));
  }

  /**
   * Record a verdict. Non-cacheable decisions (error/unknown/anything else)
   * are silently ignored so they never persist.
   * @returns {boolean} whether the verdict was stored
   */
  set(name, version, decision, findings = []) {
    if (!CACHEABLE.has(decision)) return false;
    const entry = {
      decision,
      findings: Array.isArray(findings) ? findings : [],
      ts: this._now(),
    };
    this._map.set(VerdictStore.key(name, version), entry);
    this._persist();
    return true;
  }

  size() {
    return this._map.size;
  }

  _persist() {
    const obj = { version: 1, verdicts: Object.fromEntries(this._map) };
    const data = JSON.stringify(obj, null, 2);
    mkdirSync(dirname(this.path), { recursive: true });
    // Atomic write: write to a temp file then rename over the target so a
    // crash mid-write can't truncate the store.
    const tmp = join(dirname(this.path), `.${process.pid}.${this._now()}.tmp`);
    writeFileSync(tmp, data, 'utf8');
    renameSync(tmp, this.path);
  }
}
