// Separate persisted verdicts and deny-only holds. A hold is never an approval;
// callers must check its artifact binding and bounded lifetime before reuse.

import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';

const CACHEABLE = new Set(['allow', 'block', 'review']);
const HOLD_DECISIONS = new Set(['block', 'review', 'unbound', 'scan-error']);
const validHold = entry => entry?.kind === 'hold' && HOLD_DECISIONS.has(entry.decision) &&
  typeof entry.binding?.artifactSha256 === 'string' && typeof entry.binding?.context === 'string';

export class VerdictStore {
  /**
   * @param {string} path file path for the JSON store
   * @param {object} [opts]
   * @param {() => number} [opts.now] clock injection for tests
   */
  constructor(path, opts = {}) {
    this.path = path;
    this._now = opts.now || (() => Date.now());
    this._maxEntries = Number.isInteger(opts.maxEntries) ? opts.maxEntries : 10000;
    this._map = new Map(); // key -> {decision, findings, ts}
    this._holds = new Map(); // one denial per name@version, separate from verdicts
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
    if (!entry || ttlMs === 0) return true;
    if (ttlMs === undefined || ttlMs === null) return false;
    if (!Number.isFinite(ttlMs) || ttlMs < 0) return true;
    if (!Number.isFinite(entry.ts) || entry.ts <= 0) return true;
    const age = this._now() - entry.ts;
    return age < 0 || age >= ttlMs;
  }

  /** Snapshot of every cached entry as {name, version, decision, findings, ts}. */
  entries() {
    const out = [];
    for (const [k, v] of [...this._map, ...this._holds]) {
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
          ...(v.binding ? { binding: v.binding } : {}),
        });
      }
    }
    if (parsed.version === 2 && parsed.holds && typeof parsed.holds === 'object') {
      for (const [k, v] of Object.entries(parsed.holds)) {
        if (!validHold(v)) continue;
        this._holds.set(k, { kind: 'hold', decision: v.decision,
          findings: Array.isArray(v.findings) ? v.findings : [],
          note: typeof v.note === 'string' ? v.note : 'Artifact remains held',
          ts: typeof v.ts === 'number' ? v.ts : 0, binding: v.binding });
        this._map.delete(k);
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

  getHold(name, version) {
    return this._holds.get(VerdictStore.key(name, version));
  }

  setHold(name, version, decision, findings, note, binding) {
    const entry = { kind: 'hold', decision, binding, note,
      findings: Array.isArray(findings) ? findings : [], ts: this._now() };
    if (!validHold(entry)) return false;
    const key = VerdictStore.key(name, version);
    this._holds.set(key, entry);
    this._map.delete(key); // a newer denial retires any old approval
    this._evict();
    this._persist();
    return true;
  }

  /**
   * Record a verdict. Non-cacheable decisions (error/unknown/anything else)
   * are silently ignored so they never persist.
   * @returns {boolean} whether the verdict was stored
   */
  set(name, version, decision, findings = [], binding) {
    if (!CACHEABLE.has(decision)) return false;
    const entry = {
      decision,
      findings: Array.isArray(findings) ? findings : [],
      ts: this._now(),
      ...(binding ? { binding } : {}),
    };
    this._map.set(VerdictStore.key(name, version), entry);
    this._holds.delete(VerdictStore.key(name, version));
    this._evict();
    this._persist();
    return true;
  }

  size() {
    return this._map.size + this._holds.size;
  }

  _persist() {
    const obj = { version: 2, verdicts: Object.fromEntries(this._map), holds: Object.fromEntries(this._holds) };
    const data = JSON.stringify(obj, null, 2);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    // Atomic write: write to a temp file then rename over the target so a
    // crash mid-write can't truncate the store.
    const tmp = join(dirname(this.path), `.${process.pid}.${this._now()}.tmp`);
    writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
  }

  _evict() {
    while (this.size() > this._maxEntries) {
      let oldestMap = null, oldestKey = null, oldestTs = Infinity;
      for (const map of [this._map, this._holds]) for (const [key, entry] of map) {
        const ts = Number.isFinite(entry.ts) ? entry.ts : 0;
        if (ts < oldestTs) { oldestMap = map; oldestKey = key; oldestTs = ts; }
      }
      if (!oldestMap) break;
      oldestMap.delete(oldestKey);
    }
  }
}
