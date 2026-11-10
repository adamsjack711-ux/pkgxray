'use strict';
// Local-only harness: instrumentation uses a separate IPC channel, never MCP.
const path = require('node:path');
const { sharedScans } = require('../../src/shared-scans');
const mode = process.argv[2] || 'static';
let runtime = null;
let admission = null;
process.on('message', message => {
  if (message.type === 'stats') process.send({ id: message.id, runtime, preparation: admission?.snapshot(), scans: sharedScans.snapshot(), cpu: process.cpuUsage(), resource: process.resourceUsage(), memory: process.memoryUsage() });
  if (message.type === 'stop') { sharedScans.close(); if (mode === 'static') process.exit(0); else process.stdin.emit('end'); }
});
if (mode === 'static') { const server = require('../../bin/mcp-server'); admission = server.guardAdmission; server.startStdioServer(); }
else require('../../src/mcp-proxy').runMcpProxy({ command: process.execPath,
  args: [path.join(__dirname, 'mcp-proxy-server.js'), mode] }, { policy: 'strict', scanResults: true, recheck: false, onMetrics: metrics => { runtime = metrics; } })
  .then(() => process.exit(0));
