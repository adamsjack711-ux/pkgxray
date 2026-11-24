"use strict";

const { finding } = require("./common");

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_COMPONENTS = 128;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

const VERDICT_ORDER = { safe: 0, allow: 0, "not-observed": 1, review: 1, block: 2 };

function componentIdentity(component) {
  const reference = component && (component.reference || component.digest || component.name);
  if (!reference) return null;
  return [
    String(component.kind || "component"),
    String(component.ecosystem || ""),
    String(reference),
    String(component.version || ""),
    String(component.digest || "")
  ].join("\0");
}

function displayIdentity(identity) {
  return identity ? identity.split("\0").filter(Boolean).join(":") : "unknown-component";
}

function componentsOf(value) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value.components)) return value.components;
  if (Array.isArray(value.families)) return value.families.flatMap(family => family && Array.isArray(family.components) ? family.components : []);
  return [];
}

function componentScheme(component) {
  const reference = String(component && component.reference || "");
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(reference);
  return match ? match[1].toLowerCase() : null;
}

const NON_DEPENDENCY_KINDS = /^(?:optional-)?(?:permission|host-permission)$|^(?:external-connection|update-channel|desktop-entry|agent-capability|skill|oci-layer|oci-config)$/;
const DEPENDENCY_KIND = /(?:package|dependency|action|workflow|container-image|oci-(?:image|manifest)|terraform-(?:provider|module)|helm|homebrew|plugin|extension|archive|provider|module)/;

function isResolvableComponent(component) {
  if (!component || typeof component !== "object") return false;
  const kind = String(component.kind || "").toLowerCase();
  if (NON_DEPENDENCY_KINDS.test(kind)) return false;
  const scheme = componentScheme(component);
  if (["npm", "pypi", "oci", "docker"].includes(scheme)) return true;
  return DEPENDENCY_KIND.test(kind) && Boolean(component.reference || component.digest || component.name);
}

function resolverFor(component, options) {
  const resolvers = options.resolvers || {};
  const scheme = componentScheme(component);
  return resolvers[component.kind] || resolvers[component.ecosystem] || (scheme && resolvers[scheme]) ||
    options.resolveComponent || resolvers["*"] || null;
}

function isExactRegistryReference(reference) {
  const match = /^(npm|pypi):(.+)@([^@]+)$/.exec(String(reference || ""));
  if (!match) return false;
  return match[1] === "npm"
    ? Boolean(require("../semver").parse(match[3]))
    : Boolean(require("../pep440").parsePep440(match[3]));
}

function verdictFrom(value) {
  if (!value || typeof value !== "object") return "safe";
  const candidate = value.verdict || value.decision || value.report && value.report.verdict;
  return Object.hasOwn(VERDICT_ORDER, candidate) ? candidate : "safe";
}

function worstVerdict(values) {
  let worst = "safe";
  for (const value of values) {
    const verdict = verdictFrom(value);
    if (VERDICT_ORDER[verdict] > VERDICT_ORDER[worst]) worst = verdict === "allow" ? "safe" : verdict;
  }
  return worst;
}

function normalizedLimits(options) {
  const limits = {
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxComponents: options.maxComponents ?? DEFAULT_MAX_COMPONENTS,
    maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  return limits;
}

function resultBytes(resolved) {
  const value = resolved && (resolved.bytes ?? resolved.size ?? resolved.artifactSize);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

async function withDeadline(work, deadline, outerSignal) {
  if (outerSignal && outerSignal.aborted) throw outerSignal.reason || new Error("Recursive scan aborted");
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("recursive scan time limit reached");
  const controller = new AbortController();
  const abort = () => controller.abort(outerSignal.reason || new Error("Recursive scan aborted"));
  if (outerSignal) outerSignal.addEventListener("abort", abort, { once: true });
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("recursive scan time limit reached");
          controller.abort(error);
          reject(error);
        }, remaining);
        timer.unref?.();
      })
    ]);
  } finally {
    clearTimeout(timer);
    if (outerSignal) outerSignal.removeEventListener("abort", abort);
  }
}

async function guardRegistryComponent(component, options, signal) {
  if (options.acquireOci === true || options.acquirePackages === true) {
    const oci = await require("./oci-recursive").resolveOciComponent(component, {
      ...(options.ociOptions || {}),
      root: options.ociRoot || options.distributionRoot || options.ociOptions && options.ociOptions.root,
      allowedHosts: options.ociOptions && options.ociOptions.allowedHosts || options.allowedHosts,
      transport: options.ociOptions && options.ociOptions.transport || options.transport,
      lookup: options.ociOptions && options.ociOptions.lookup || options.lookup,
      signal
    });
    if (oci) return oci;
  }
  if (options.acquirePackages !== true) return null;
  const reference = String(component.reference || "");
  let guardReference = reference;
  if (/^(?:npm|pypi):/.test(reference)) {
    if (!isExactRegistryReference(reference)) throw new Error(`registry recursion requires an exact version: ${reference}`);
  } else if (["remote-action", "reusable-workflow"].includes(component.kind)) {
    const at = reference.lastIndexOf("@");
    const target = at > 0 ? reference.slice(0, at) : "";
    const ref = at > 0 ? reference.slice(at + 1) : "";
    const parts = target.split("/");
    if (parts.length < 2 || !/^[a-f0-9]{40}$/i.test(ref)) {
      throw new Error(`GitHub recursion requires a full commit SHA: ${reference}`);
    }
    guardReference = `github:${parts[0]}/${parts[1]}#${ref}`;
  } else {
    return null;
  }
  const guard = options.guard || require("../quarantine").guardExtension;
  const guardOptions = {
    ...(options.guardOptions || {}),
    scanDependencies: options.guardOptions && options.guardOptions.scanDependencies !== undefined
      ? options.guardOptions.scanDependencies : true,
    signal,
    keepStaging: false,
    promoteTo: undefined,
    force: false,
    allowExecution: false
  };
  const guarded = await guard(guardReference, guardOptions);
  const result = {
    schemaVersion: guarded.schemaVersion || 1,
    reference: guarded.reference || guardReference,
    decision: guarded.decision,
    outcome: guarded.outcome,
    assessment: guarded.assessment || null,
    approval: guarded.approval || null,
    report: guarded.report || null,
    sourceCoverage: guarded.sourceCoverage || null,
    dependencyAudit: guarded.dependencyAudit || null,
    vulnerabilityPrecheck: guarded.vulnerabilityPrecheck || null,
    provenanceAttestation: guarded.provenanceAttestation ? {
      attested: guarded.provenanceAttestation.attested,
      verification: guarded.provenanceAttestation.verification || null
    } : null
  };
  return { result, components: [], bytes: 0, source: "package-guard" };
}

/**
 * Resolve and scan the component graph exposed by a distribution result.
 * Network/package acquisition is disabled unless acquirePackages is true or a
 * caller supplies an explicit resolver. Resolvers receive an AbortSignal and
 * may return {result|distribution|root, components, bytes, cleanup}.
 */
async function scanRecursiveComponents(distribution, options = {}) {
  const limits = normalizedLimits(options);
  const deadline = Date.now() + limits.timeoutMs;
  const coverageReasons = [];
  const findings = [];
  const nodes = [];
  const edges = [];
  const cache = new Map();
  const queue = [];
  let totalBytes = 0;

  const discoveredRoots = componentsOf(distribution);
  const eligibleRoots = discoveredRoots.filter(isResolvableComponent);
  let discoveredComponents = discoveredRoots.length;
  let eligibleComponents = eligibleRoots.length;
  let ignoredMetadataComponents = discoveredRoots.length - eligibleRoots.length;
  const roots = eligibleRoots.map(component => ({ component, depth: 1, parent: null, ancestry: [] }));
  roots.sort((a, b) => String(componentIdentity(a.component)).localeCompare(String(componentIdentity(b.component))));
  queue.push(...roots);

  while (queue.length) {
    if (options.signal && options.signal.aborted) throw options.signal.reason || new Error("Recursive scan aborted");
    if (Date.now() >= deadline) {
      coverageReasons.push(`recursive scan time limit (${limits.timeoutMs} ms) reached`);
      break;
    }
    const item = queue.shift();
    const identity = componentIdentity(item.component);
    if (!identity) {
      coverageReasons.push("component without a stable identity was not resolved");
      findings.push(finding("medium", "recursive-component-identity", "DEPENDENCY_GRAPH", JSON.stringify(item.component).slice(0, 160),
        "A discovered component lacked a stable name, reference, or digest and could not be recursively scanned."));
      continue;
    }
    if (item.ancestry.includes(identity)) {
      edges.push({ from: item.parent, to: identity, cycle: true, cached: cache.has(identity) });
      findings.push(finding("low", "recursive-component-cycle", "DEPENDENCY_GRAPH", displayIdentity(identity),
        "The component graph contains a cycle; the already-scanned identity was reused."));
      continue;
    }
    if (item.parent) edges.push({ from: item.parent, to: identity, cycle: false, cached: cache.has(identity) });
    if (cache.has(identity)) continue;
    if (nodes.length >= limits.maxComponents) {
      coverageReasons.push(`recursive component limit (${limits.maxComponents}) reached`);
      break;
    }
    if (item.depth > limits.maxDepth) {
      coverageReasons.push(`recursive depth limit (${limits.maxDepth}) reached at ${displayIdentity(identity)}`);
      continue;
    }

    const node = { identity, component: item.component, depth: item.depth, status: "pending", source: null, result: null };
    nodes.push(node);
    cache.set(identity, node);
    let resolved;
    let cleanup;
    try {
      resolved = await withDeadline(async signal => {
        const builtIn = await guardRegistryComponent(item.component, {
          ...options,
          distributionRoot: distribution && distribution.root
        }, signal);
        if (builtIn) return builtIn;
        const resolver = resolverFor(item.component, options);
        if (!resolver) throw new Error(`no resolver for ${displayIdentity(identity)}`);
        return resolver(item.component, { depth: item.depth, identity, signal });
      }, deadline, options.signal);
      if (!resolved || typeof resolved !== "object") throw new Error("resolver returned no result");
      cleanup = typeof resolved.cleanup === "function" ? resolved.cleanup : null;
      const bytes = resultBytes(resolved);
      if (totalBytes + bytes > limits.maxTotalBytes) {
        throw new Error(`recursive byte limit (${limits.maxTotalBytes}) would be exceeded`);
      }
      totalBytes += bytes;
      let childResult = resolved.distribution || resolved.result || null;
      if (!childResult && resolved.root && typeof options.scanResolved === "function") {
        childResult = await withDeadline(signal => options.scanResolved(resolved.root, {
          component: item.component, depth: item.depth, signal
        }), deadline, options.signal);
      }
      node.status = "scanned";
      node.source = resolved.source || (resolved.root ? "resolved-root" : "resolver");
      node.bytes = bytes;
      node.result = childResult;
      const discoveredChildren = Array.isArray(resolved.components)
        ? resolved.components
        : componentsOf(childResult);
      const children = discoveredChildren.filter(isResolvableComponent);
      discoveredComponents += discoveredChildren.length;
      eligibleComponents += children.length;
      ignoredMetadataComponents += discoveredChildren.length - children.length;
      const ancestry = [...item.ancestry, identity];
      const next = children.map(component => ({ component, depth: item.depth + 1, parent: identity, ancestry }));
      next.sort((a, b) => String(componentIdentity(a.component)).localeCompare(String(componentIdentity(b.component))));
      queue.push(...next);
    } catch (error) {
      node.status = "error";
      node.error = error.message;
      coverageReasons.push(`${displayIdentity(identity)}: ${error.message}`);
      findings.push(finding("medium", "recursive-component-unresolved", item.component.file || "DEPENDENCY_GRAPH",
        item.component.reference || item.component.name || identity,
        "A discovered executable dependency could not be recursively resolved and scanned."));
    } finally {
      if (cleanup) {
        try { await cleanup(); }
        catch (error) { coverageReasons.push(`${displayIdentity(identity)} cleanup failed: ${error.message}`); }
      }
    }
  }

  const values = nodes.filter(node => node.status === "scanned").map(node => node.result);
  let verdict = worstVerdict(values);
  if (coverageReasons.length && verdict === "safe") verdict = "review";
  return {
    schemaVersion: 1,
    verdict,
    nodes,
    edges,
    findings,
    coverage: {
      complete: coverageReasons.length === 0,
      discoveredComponents,
      eligibleComponents,
      ignoredMetadataComponents,
      scannedComponents: nodes.filter(node => node.status === "scanned").length,
      uniqueComponents: nodes.length,
      totalBytes,
      reasons: [...new Set(coverageReasons)].sort()
    },
    limits
  };
}

module.exports = {
  DEFAULT_MAX_COMPONENTS,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_TOTAL_BYTES,
  DEFAULT_TIMEOUT_MS,
  componentIdentity,
  isResolvableComponent,
  scanRecursiveComponents
};
