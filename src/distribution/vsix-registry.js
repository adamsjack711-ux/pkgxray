"use strict";

const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const { createUpstreamPolicy, isPrivateOrLocalHost } = require("../cache-upstream-policy");
const { downloadFile } = require("../http-client");
const { DEFAULT_LIMITS, verifyDownloadedFile } = require("./archive");

const REGISTRY_REFERENCE = /^(openvsx|vscode):([A-Za-z0-9][A-Za-z0-9_-]{0,99})\.([A-Za-z0-9][A-Za-z0-9._-]{0,199})@([A-Za-z0-9][A-Za-z0-9.+_-]{0,127})$/;
const TARGET_PLATFORMS = new Set([
  "universal", "win32-x64", "win32-arm64", "win32-ia32",
  "linux-x64", "linux-arm64", "linux-armhf", "alpine-x64", "alpine-arm64",
  "darwin-x64", "darwin-arm64", "web"
]);

function parseVsixRegistryReference(reference) {
  const match = REGISTRY_REFERENCE.exec(String(reference || ""));
  if (!match) {
    throw new Error("VSIX registry reference must be openvsx:publisher.name@exact-version or vscode:publisher.name@exact-version");
  }
  const [, registry, publisher, name, version] = match;
  if (["latest", "pre-release"].includes(version.toLowerCase())) {
    throw new Error("VSIX registry reference requires an exact version, not an alias");
  }
  return { registry, publisher, name, version };
}

function registryDownload(reference, targetPlatform) {
  const coordinates = typeof reference === "string" ? parseVsixRegistryReference(reference) : reference;
  if (targetPlatform !== undefined && !TARGET_PLATFORMS.has(targetPlatform)) {
    throw new Error(`Unsupported VSIX target platform: ${targetPlatform}`);
  }
  const publisher = encodeURIComponent(coordinates.publisher);
  const name = encodeURIComponent(coordinates.name);
  const version = encodeURIComponent(coordinates.version);
  if (coordinates.registry === "openvsx") {
    const target = targetPlatform ? `/${encodeURIComponent(targetPlatform)}` : "";
    return {
      coordinates: { ...coordinates, targetPlatform: targetPlatform || null },
      url: `https://open-vsx.org/api/${publisher}/${name}${target}/${version}/file/download`
    };
  }
  const query = targetPlatform && targetPlatform !== "universal"
    ? `?targetPlatform=${encodeURIComponent(targetPlatform)}` : "";
  return {
    coordinates: { ...coordinates, targetPlatform: targetPlatform || null },
    url: `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/${publisher}/vsextensions/${name}/${version}/vspackage${query}`
  };
}

function registryHostAllowed(registry, hostname) {
  const host = String(hostname).toLowerCase();
  if (registry === "openvsx") return host === "open-vsx.org" || host === "openvsx.eclipsecontent.org";
  return host === "marketplace.visualstudio.com" || host === "main.vscode-cdn.net" || host.endsWith(".gallery.vsassets.io");
}

async function decodeMarketplaceTransfer(file, response, maxBytes) {
  const encoding = String(response.headers?.["content-encoding"] || "").trim().toLowerCase();
  if (!encoding || encoding === "identity") return { encoding: encoding || null, decoded: false };
  if (!["gzip", "x-gzip"].includes(encoding)) throw new Error(`Unsupported Marketplace content encoding: ${encoding}`);
  const raw = await fsp.readFile(file);
  if (raw.length > maxBytes) throw new Error(`Marketplace transfer exceeds ${maxBytes} bytes`);
  let decoded;
  try { decoded = zlib.gunzipSync(raw, { maxOutputLength: maxBytes }); }
  catch (error) { throw new Error(`Invalid or oversized Marketplace gzip response: ${error.message}`); }
  if (decoded.length < 4 || decoded.readUInt32LE(0) !== 0x04034b50) {
    throw new Error("Decoded Marketplace response is not a VSIX ZIP archive");
  }
  const replacement = `${file}.decoded`;
  await fsp.writeFile(replacement, decoded, { mode: 0o600, flag: "wx" });
  await fsp.rename(replacement, file);
  return { encoding, decoded: true, transferBytes: raw.length };
}

async function acquireVsixRegistry(reference, options = {}) {
  const resolved = registryDownload(reference, options.targetPlatform);
  const maxBytes = options.maxBytes || DEFAULT_LIMITS.maxArchiveBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive integer");
  if (options.expectedSha256 && !/^[a-f0-9]{64}$/i.test(options.expectedSha256)) {
    throw new Error("expectedSha256 must be 64 hexadecimal characters");
  }
  const tempRoot = options.tempRoot ? path.resolve(options.tempRoot) : os.tmpdir();
  const workspace = await fsp.mkdtemp(path.join(tempRoot, "pkgxray-vsix-registry-"));
  const archivePath = path.join(workspace, "artifact.vsix");
  let resolvedUrl = resolved.url;
  try {
    const response = await downloadFile(resolved.url, archivePath, {
      timeoutMs: options.timeoutMs || 30000,
      maxBytes,
      maxRedirects: options.maxRedirects ?? 5,
      transport: options.transport,
      headers: {
        accept: "application/octet-stream",
        "user-agent": `pkgxray/${require("../../package.json").version}`
      },
      validate(value) {
        const parsed = new URL(value);
        resolvedUrl = parsed.href;
        const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
        if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
          throw new Error("VSIX registry URL must use credential-free HTTPS without a fragment");
        }
        if (!registryHostAllowed(resolved.coordinates.registry, hostname)) {
          throw new Error(`VSIX registry redirect host is not allowed: ${parsed.host}`);
        }
        if (isPrivateOrLocalHost(hostname)) throw new Error(`VSIX registry host is private or local: ${parsed.host}`);
        return createUpstreamPolicy(parsed.origin, { lookup: options.lookup })(parsed);
      }
    });
    const transfer = resolved.coordinates.registry === "vscode"
      ? await decodeMarketplaceTransfer(archivePath, response, maxBytes)
      : { encoding: String(response.headers?.["content-encoding"] || "").trim().toLowerCase() || null, decoded: false };
    const verified = await verifyDownloadedFile(archivePath, {
      expectedSha256: options.expectedSha256,
      maxBytes,
      requireExpected: false
    });
    return {
      archivePath,
      workspace,
      sourceUrl: resolved.url,
      resolvedUrl,
      registry: resolved.coordinates.registry,
      coordinates: resolved.coordinates,
      ...verified,
      // A custom transport is a library test/integration hook; do not claim
      // that it provided the TLS authentication of Node's built-in HTTPS stack.
      transportAuthenticated: options.transport ? null : true,
      transfer: {
        bytes: transfer.transferBytes || response.bytes,
        contentEncoding: transfer.encoding,
        decoded: transfer.decoded
      },
      verification: {
        status: verified.integrityVerified ? "verified" : "transport-only",
        sha256: verified.sha256,
        expectedSha256: options.expectedSha256 || null,
        reason: verified.integrityVerified ? null : "registry response had no operator-pinned digest"
      },
      cleanup: () => fsp.rm(workspace, { recursive: true, force: true })
    };
  } catch (error) {
    await fsp.rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

module.exports = {
  TARGET_PLATFORMS,
  acquireVsixRegistry,
  decodeMarketplaceTransfer,
  parseVsixRegistryReference,
  registryDownload,
  registryHostAllowed
};
