"use strict";

const https = require("node:https");

// ---------------------------------------------------------------------------
// npm registry version listing — the one piece of intelligence recheck needs
// that the existing engine didn't already fetch. `fetchNpmMetadata` in
// quarantine.js pulls a *single* version's manifest; version-drift needs the
// full version list, which lives in the packument at `<registry>/<name>`.
// ---------------------------------------------------------------------------

const REGISTRY_AGENT = new https.Agent({ keepAlive: true, maxSockets: 8 });

function packumentUrl(name, registry) {
  const base = (registry || "https://registry.npmjs.org").replace(/\/$/, "");
  // Scoped names (@scope/name) must have the slash percent-encoded for the
  // packument endpoint.
  const encoded = name.startsWith("@")
    ? `@${encodeURIComponent(name.slice(1))}`
    : encodeURIComponent(name);
  return `${base}/${encoded}`;
}

function fetchJson(url) {
  return require("./http-client").requestJson(url, {
    headers: { "user-agent": "pkgxray", accept: "application/json" }, agent: REGISTRY_AGENT
  });
}

// Returns { versions: string[], latest: string|null }. `versions` is every
// published version key; `latest` is the dist-tag. Throws on network/parse
// error so the caller can report the dep as unknown rather than silently
// treating "no newer version" as fact.
async function listNpmVersions(name, options = {}) {
  const packument = await fetchJson(packumentUrl(name, options.registry));
  const versions = packument && packument.versions ? Object.keys(packument.versions) : [];
  const latest =
    packument && packument["dist-tags"] && typeof packument["dist-tags"].latest === "string"
      ? packument["dist-tags"].latest
      : null;
  return { versions, latest };
}

module.exports = { listNpmVersions, packumentUrl };
