"use strict";

const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { scanDistribution } = require("./index");
const { acquireDistributionArchive, extractDistributionArchive } = require("./archive");
const { auditDistributionSource } = require("./source-audit");
const { scanRecursiveComponents } = require("./recursive");
const { bindArtifact, createDistributionReceipt } = require("./receipt");
const { verifyArtifactProvenance } = require("./provenance");
const { acquireVsixRegistry, parseVsixRegistryReference } = require("./vsix-registry");
const { finding } = require("./common");

const VERDICT_ORDER = { safe: 0, allow: 0, review: 1, block: 2 };

function worstVerdict(...values) {
  let worst = "safe";
  for (const value of values.flat()) {
    const verdict = typeof value === "string" ? value : value && (value.verdict || value.decision || value.report?.verdict);
    if (Object.hasOwn(VERDICT_ORDER, verdict) && VERDICT_ORDER[verdict] > VERDICT_ORDER[worst]) worst = verdict === "allow" ? "safe" : verdict;
  }
  return worst;
}

function checkState(result, requested = true) {
  if (!requested) return "not-requested";
  if (!result) return "failed";
  return result.coverage?.complete === false ? "partial" : "completed";
}

function provenanceCheck(provenance) {
  if (!provenance) return "not-requested";
  if (provenance.status === "verified") return "completed";
  if (provenance.status === "invalid") return "failed";
  return "unsupported";
}

function normalizeAllowedHosts(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

async function prepareTarget(target, options) {
  if (/^(?:openvsx|vscode):/i.test(target)) {
    const coordinates = parseVsixRegistryReference(target);
    if (options.integrity) throw new Error("VSIX registry references accept expectedSha256, not generic integrity");
    if (options.type && !["auto", "vsix"].includes(options.type)) {
      throw new Error("VSIX registry references require --type auto or --type vsix");
    }
    const acquired = await acquireVsixRegistry(target, {
      targetPlatform: options.targetPlatform,
      expectedSha256: options.expectedSha256,
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxArchiveBytes,
      maxRedirects: options.maxRedirects,
      tempRoot: options.tempRoot,
      transport: options.transport,
      lookup: options.lookup
    });
    return {
      kind: "vsix-registry",
      archive: acquired.archivePath,
      acquired,
      coordinates,
      cleanup: acquired.cleanup
    };
  }
  if (/^https:\/\//i.test(target)) {
    const acquired = await acquireDistributionArchive(target, {
      allowedHosts: normalizeAllowedHosts(options.allowedHosts),
      expectedSha256: options.expectedSha256,
      integrity: options.integrity,
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxArchiveBytes,
      maxRedirects: options.maxRedirects,
      transport: options.transport,
      lookup: options.lookup
    });
    return { kind: "remote-archive", archive: acquired.archivePath, acquired, cleanup: acquired.cleanup };
  }
  const resolved = path.resolve(target);
  const stat = await fsp.stat(resolved);
  if (stat.isDirectory()) return { kind: "directory", root: await fsp.realpath(resolved), cleanup: null };
  if (!stat.isFile()) throw new Error("Distribution target must be a directory, regular archive, or HTTPS URL");
  return { kind: "local-archive", archive: await fsp.realpath(resolved), acquired: null, cleanup: null };
}

function registryIdentityCheck(descriptors, expected) {
  if (!expected) return { valid: true, reason: null };
  const family = descriptors.families.find(item => item.family === "editor-extension");
  const actual = family?.metadata || {};
  const identityMatches = typeof actual.publisher === "string" && typeof actual.name === "string" &&
    actual.publisher.toLowerCase() === expected.publisher.toLowerCase() &&
    actual.name.toLowerCase() === expected.name.toLowerCase();
  const versionMatches = typeof actual.version === "string" && actual.version === expected.version;
  if (identityMatches && versionMatches) return { valid: true, actual, reason: null };
  return {
    valid: false,
    actual,
    reason: `requested ${expected.publisher}.${expected.name}@${expected.version}, received ${actual.publisher || "<missing>"}.${actual.name || "<missing>"}@${actual.version || "<missing>"}`
  };
}

function acquisitionCheck(acquired) {
  if (!acquired) return "not-requested";
  return acquired.integrityVerified ? "completed" : "partial";
}

function componentSha256(component) {
  const values = [component && component.digest, ...(Array.isArray(component && component.digests) ? component.digests : [])].filter(Boolean);
  for (const value of values) {
    const match = /^sha256:([a-f0-9]{64})$/i.exec(String(value));
    if (match) return match[1].toLowerCase();
  }
  return null;
}

async function resolveArchiveComponent(component, options = {}) {
  const reference = String(component && component.reference || "");
  if (!/^https:\/\//i.test(reference)) throw new Error(`no immutable archive resolver for ${reference || component?.kind || "component"}`);
  const expectedSha256 = componentSha256(component);
  if (!expectedSha256) throw new Error(`remote archive recursion requires a SHA-256 digest: ${reference}`);
  const result = await scanDistributionTarget(reference, {
    type: "auto",
    expectedSha256,
    allowedHosts: options.allowedHosts,
    timeoutMs: options.timeoutMs,
    maxArchiveBytes: options.maxArchiveBytes,
    maxProvenanceBytes: options.maxProvenanceBytes,
    sourceAudit: options.sourceAudit,
    recursive: false,
    transport: options.transport,
    lookup: options.lookup,
    signal: options.signal
  });
  return { result, components: result.components, bytes: result.artifact?.size || 0, source: "immutable-archive" };
}

function provenanceFinding(provenance, file) {
  if (!provenance || provenance.status === "verified") return null;
  const invalid = provenance.status === "invalid";
  return finding(invalid ? "high" : "medium", invalid ? "artifact-signature-invalid" : "artifact-provenance-unverified",
    file || "ARTIFACT", provenance.reason || provenance.status,
    invalid
      ? "The artifact carries signature material that failed cryptographic or identity verification."
      : "The artifact is digest-bound, but no supported publisher signature or provenance statement was cryptographically verified.",
    invalid ? { blocking: true } : {});
}

async function scanExtractedRoot(root, options = {}) {
  const descriptors = scanDistribution(root, { ...options, type: options.type || "auto" });
  const sourceAudit = options.sourceAudit === false ? null : await auditDistributionSource(descriptors, { ...options, root });
  const recursive = options.recursive === true
    ? await scanRecursiveComponents(descriptors, {
        ...options.recursiveOptions,
        acquirePackages: options.acquirePackages === true,
        acquireOci: options.acquireOci === true,
        guardOptions: options.guardOptions,
        resolvers: options.resolvers,
        allowedHosts: options.allowedHosts || options.recursiveOptions?.allowedHosts,
        transport: options.transport || options.recursiveOptions?.transport,
        lookup: options.lookup || options.recursiveOptions?.lookup,
        distributionRoot: root,
        resolveComponent: options.resolveComponent || (options.acquirePackages === true
          ? (component, context) => resolveArchiveComponent(component, { ...options, signal: context.signal })
          : undefined),
        signal: options.signal,
        scanResolved: async childRoot => scanDistribution(childRoot, { type: "auto" })
      })
    : null;
  return { descriptors, sourceAudit, recursive };
}

/**
 * End-to-end local pipeline for a directory or immutable archive. Remote URLs
 * require both an explicit host allowlist and an expected digest/integrity.
 */
async function scanDistributionTarget(target, options = {}) {
  const prepared = await prepareTarget(target, options);
  if (prepared.kind === "directory" && options.sigstoreBundle) {
    throw new Error("Sigstore artifact verification requires an archive target with exact bytes");
  }
  let extractionWorkspace = null;
  let root = prepared.root;
  let binding = null;
  let provenance = null;
  let extraction = null;
  try {
    if (prepared.archive) {
      binding = prepared.acquired
        ? { path: prepared.archive, size: prepared.acquired.size, sha256: prepared.acquired.sha256 }
        : await bindArtifact(prepared.archive, { expectedSha256: options.expectedSha256, integrity: options.integrity, maxArtifactBytes: options.maxArchiveBytes });
      provenance = await verifyArtifactProvenance(prepared.archive, binding, {
        maxArtifactBytes: options.maxProvenanceBytes,
        maxBundleBytes: options.maxProvenanceBundleBytes,
        sigstoreBundle: options.sigstoreBundle,
        sigstoreSubject: options.sigstoreSubject,
        certificateIdentity: options.certificateIdentity,
        certificateIssuer: options.certificateIssuer,
        sigstoreModulePath: options.sigstoreModulePath,
        backendRunner: options.provenanceBackendRunner,
        timeoutMs: options.provenanceTimeoutMs || options.timeoutMs
      });
      extractionWorkspace = await fsp.mkdtemp(path.join(options.tempRoot || os.tmpdir(), "pkgxray-distribution-"));
      const destination = path.join(extractionWorkspace, "extracted");
      extraction = await extractDistributionArchive(prepared.archive, destination, options.archiveOptions);
      if (extraction.artifactSha256 && extraction.artifactSha256 !== binding.sha256 ||
          extraction.artifactBytes !== undefined && extraction.artifactBytes !== binding.size) {
        throw new Error("Archive bytes changed between artifact binding and extraction");
      }
      root = extraction.destination;
    }

    const scanOptions = prepared.kind === "vsix-registry" ? { ...options, type: "vsix" } : options;
    const scanned = await scanExtractedRoot(root, scanOptions);
    const extraFindings = [];
    const registryIdentity = registryIdentityCheck(scanned.descriptors, prepared.coordinates);
    if (!registryIdentity.valid) {
      const mismatch = finding("high", "vsix-registry-coordinate-mismatch", "extension/package.json",
        registryIdentity.reason,
        "The registry response does not contain the exact extension identity and version that were requested.",
        { blocking: true });
      extraFindings.push(mismatch);
      scanned.descriptors.coverage.complete = false;
      scanned.descriptors.coverage.reasons.push(registryIdentity.reason);
    }
    const provenanceIssue = prepared.archive ? provenanceFinding(provenance, path.basename(prepared.archive)) : null;
    if (provenanceIssue) extraFindings.push(provenanceIssue);
    const findings = [
      ...scanned.descriptors.findings,
      ...(scanned.sourceAudit?.report?.findings || []),
      ...(scanned.recursive?.findings || []),
      ...extraFindings
    ];
    let verdict = worstVerdict(scanned.descriptors, scanned.sourceAudit, scanned.recursive);
    if (!registryIdentity.valid || provenance?.status === "invalid") verdict = "block";
    else if (provenanceIssue && verdict === "safe") verdict = "review";
    const coverageReasons = [
      ...scanned.descriptors.coverage.reasons,
      ...(scanned.sourceAudit?.coverage?.reasons || []),
      ...(scanned.recursive?.coverage?.reasons || [])
    ];
    const result = {
      schemaVersion: 1,
      family: "executable-distribution-pipeline",
      target: prepared.kind === "directory" ? root : target,
      verdict,
      artifact: binding ? { sha256: binding.sha256, size: binding.size } : null,
      acquisition: prepared.acquired ? {
        sourceUrl: prepared.acquired.sourceUrl,
        resolvedUrl: prepared.acquired.resolvedUrl,
        integrityVerified: prepared.acquired.integrityVerified,
        transportAuthenticated: prepared.acquired.transportAuthenticated === undefined
          ? true : prepared.acquired.transportAuthenticated,
        verification: prepared.acquired.verification,
        ...(prepared.acquired.transfer ? { transfer: prepared.acquired.transfer } : {}),
        ...(prepared.acquired.registry ? {
          registry: prepared.acquired.registry,
          coordinates: prepared.acquired.coordinates,
          manifestIdentityVerified: registryIdentity.valid
        } : {})
      } : null,
      extraction: extraction ? Object.fromEntries(Object.entries(extraction).filter(([key]) => key !== "destination")) : null,
      provenance,
      descriptors: scanned.descriptors,
      sourceAudit: scanned.sourceAudit,
      recursive: scanned.recursive,
      components: scanned.descriptors.components,
      entrypoints: scanned.descriptors.entrypoints,
      findings,
      coverage: {
        complete: scanned.descriptors.coverage.complete &&
          (scanned.sourceAudit === null || scanned.sourceAudit.coverage.complete) &&
          (scanned.recursive === null || scanned.recursive.coverage.complete),
        reasons: [...new Set(coverageReasons)].sort()
      }
    };
    if (binding) {
      result.receipt = createDistributionReceipt({
        artifact: binding,
        result: { ...result, receipt: undefined },
        checks: {
          acquisition: acquisitionCheck(prepared.acquired),
          extraction: "completed",
          descriptors: checkState(scanned.descriptors),
          source: checkState(scanned.sourceAudit, options.sourceAudit !== false),
          recursive: checkState(scanned.recursive, options.recursive === true),
          provenance: provenanceCheck(provenance)
        },
        provenance,
        policy: options.policy || null
      });
    }
    if (options.keepExtracted === true && extractionWorkspace) {
      result.extractedRoot = root;
      extractionWorkspace = null;
    }
    return result;
  } finally {
    if (extractionWorkspace) await fsp.rm(extractionWorkspace, { recursive: true, force: true });
    if (prepared.cleanup) await prepared.cleanup();
  }
}

module.exports = { acquisitionCheck, componentSha256, prepareTarget, registryIdentityCheck, resolveArchiveComponent, scanDistributionTarget, scanExtractedRoot, worstVerdict };
