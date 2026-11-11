"use strict";
const path = require("node:path");
const { Worker } = require("node:worker_threads");

function failureReport() {
  return { schemaVersion: 1, tool: "pkgxray-compose", mode: "pkgxray-composition",
    decision: "block", authorization: { installAllowed: false }, execution: "partial",
    resolution: { reasonCodes: ["incomplete-checks"], explanation: "Blocked because composition analysis could not complete." },
    coverage: { status: "partial", registryIntegrityVerified: false },
    gaps: [{ engine: "compose", code: "worker-failed", message: "Composition analysis did not complete within its resource limits." }] };
}
function scanComposition(root, { entry = "index.js", signal, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error("Cancelled"));
    const worker = new Worker(path.join(__dirname, "../components/compose/src/bundled-worker.mjs"), {
      workerData: { root, entry }, resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 },
      stdout: true, stderr: true, execArgv: []
    });
    // Never forward worker diagnostics into the JSON-RPC stream.
    worker.stdout.resume(); worker.stderr.resume();
    let result, settled = false;
    const finish = (error, report) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      worker.terminate().then(() => error ? reject(error) : resolve(report));
    };
    const abort = () => finish(signal.reason || new Error("Cancelled"));
    const timer = setTimeout(() => finish(null, failureReport()), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    worker.on("message", value => { result = value; });
    worker.on("error", () => finish(null, failureReport()));
    worker.on("exit", code => finish(null, code === 0 && result ? result : failureReport()));
  });
}
module.exports = { scanComposition };
