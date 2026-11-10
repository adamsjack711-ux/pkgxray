'use strict';
const { parentPort, workerData } = require('node:worker_threads');
if (require('./artifact').BUILD_ID !== workerData.buildId) throw new Error('Scanner changed before analysis; restart required');
parentPort.postMessage(require('./auditor').auditEvidence(workerData.evidence, workerData.analysis));
