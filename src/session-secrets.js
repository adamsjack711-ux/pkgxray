"use strict";

// An opt-in, session-local fence for explicitly labelled credentials. This is
// exact-value correlation, not a general taint engine or an egress sandbox.
// Values never leave this object, are never logged, and are never persisted.
const SECRET_KEYS = new Set(["password", "passwd", "apikey", "accesstoken", "refreshtoken", "clientsecret", "privatekey", "authorization"]);
const MAX_BYTES = 128 * 1024;
const MAX_NODES = 10000;
const MAX_VALUES = 128;
const MAX_VALUE_BYTES = 4096;
const LIMIT_REASON = "credential-flow inspection limit reached; restart the proxy with smaller results";
const MATCH_REASON = "call contains a credential observed in an earlier response; remove the credential or use a separately reviewed workflow";

class SessionSecrets {
  #values = new Set();
  #credentials = new Set();
  #closed = false;

  // Traverse strings and property names, including JSON text content. Limit
  // both parsed expansions and visits; no executable content is evaluated.
  #walk(value, visit, parseText = false) {
    const pending = [{ value, key: "", depth: 0 }];
    let bytes = 0, nodes = 0;
    while (pending.length) {
      const item = pending.pop();
      if (++nodes > MAX_NODES || item.depth > 32) throw new Error("limit");
      const text = item.value;
      if (typeof text === "string") {
        bytes += Buffer.byteLength(text);
        if (bytes > MAX_BYTES) throw new Error("limit");
        visit(text, item.key);
        if (parseText && /^[\s]*[\[{]/.test(text)) {
          let parsed;
          try { parsed = JSON.parse(text); } catch { continue; }
          pending.push({ value: parsed, key: "", depth: item.depth + 1 });
        }
      } else if (text && typeof text === "object") {
        const entries = Object.entries(text);
        if (entries.length + pending.length + nodes > MAX_NODES) throw new Error("limit");
        for (const [key, child] of entries) {
          bytes += Buffer.byteLength(key);
          if (bytes > MAX_BYTES) throw new Error("limit");
          visit(key, "");
          pending.push({ value: child, key, depth: item.depth + 1 });
        }
      }
    }
  }

  #remember(value) {
    // Empty placeholders are not credentials. Short passwords are retained;
    // in an opted-in session false positives are preferable to silent reuse.
    if (!value) return;
    if (Buffer.byteLength(value) > MAX_VALUE_BYTES) throw new Error("limit");
    this.#credentials.add(value);
    if (this.#credentials.size > MAX_VALUES) throw new Error("limit");
    for (const variant of [value, encodeURIComponent(value), Buffer.from(value).toString("base64"), Buffer.from(value).toString("base64url")]) {
      this.#values.add(variant);
    }
    if (this.#values.size > MAX_VALUES * 4) throw new Error("limit");
  }

  observe(response) {
    if (this.#closed) return LIMIT_REASON;
    try {
      this.#walk(response, (text, key) => {
        const normalizedKey = key.toLowerCase().replace(/[-_]/g, "");
        if (!SECRET_KEYS.has(normalizedKey)) return;
        this.#remember(text);
        if (normalizedKey === "authorization") {
          const credential = /^(?:Bearer|Basic)\s+(.+)$/i.exec(text);
          if (credential) this.#remember(credential[1]);
        }
      }, true);
      return null;
    } catch {
      this.#closed = true;
      return LIMIT_REASON;
    }
  }

  check(request) {
    if (this.#closed) return LIMIT_REASON;
    let matched = false;
    try {
      this.#walk(request, text => {
        for (const value of this.#values) {
          if (text.includes(value)) { matched = true; break; }
        }
      });
      return matched ? MATCH_REASON : null;
    } catch {
      // Never silently truncate or evict evidence and then allow traffic.
      this.#closed = true;
      return LIMIT_REASON;
    }
  }
}

module.exports = { SessionSecrets };
