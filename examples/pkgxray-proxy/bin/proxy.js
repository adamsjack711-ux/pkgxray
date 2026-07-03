#!/usr/bin/env node
// CLI entry point: load config, build the store + server, listen, and print
// the .npmrc line developers/CI use to point at the proxy.

import { loadConfig } from '../src/config.js';
import { VerdictStore } from '../src/verdict-store.js';
import { createServer } from '../src/proxy.js';

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`pkgxray-proxy: configuration error: ${err.message}\n`);
    process.exit(1);
  }

  const store = new VerdictStore(config.verdictStorePath);
  const server = createServer(config, store);

  server.on('error', (err) => {
    process.stderr.write(`pkgxray-proxy: server error: ${err.message}\n`);
    process.exit(1);
  });

  server.listen(config.port, config.host, () => {
    const { port } = server.address();
    const url = `http://${config.host}:${port}`;
    process.stderr.write(
      [
        `pkgxray-proxy listening on ${url}`,
        `  upstream:        ${config.upstream}`,
        `  reviewPolicy:    ${config.reviewPolicy}`,
        `  scanErrorPolicy: ${config.scanErrorPolicy}`,
        `  verdict store:   ${config.verdictStorePath} (${store.size()} cached)`,
        config.cacheUrl ? `  shared cache:    ${config.cacheUrl}` : '',
        '',
        'Point npm at the proxy by adding this to .npmrc:',
        `  registry=${url}`,
        '',
      ].filter(Boolean).join('\n') + '\n',
    );
  });

  const shutdown = (sig) => {
    process.stderr.write(`\npkgxray-proxy: received ${sig}, shutting down\n`);
    server.close(() => process.exit(0));
    // Force-exit if connections linger.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
