'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { audit } = require('./audit');
// Interpret YAML as data. Never invoke Docker, a shell, or the supplied code.
parentPort.postMessage(audit(workerData.source, workerData.options));
