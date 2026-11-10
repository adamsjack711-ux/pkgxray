#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

function quote(value) {
  return JSON.stringify(value).replace(/[\u007f-\u009f]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

async function inventory(directory, { maxEntries = 10000 } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 100000) throw new Error('maxEntries must be an integer from 1 to 100000');
  const root = path.resolve(directory);
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Root must be a directory, not a symlink');
  const stack = [root], files = [], extensions = new Map();
  let examined = 0, skippedLinks = 0, skippedDirectories = 0, totalBytes = 0;
  while (stack.length) {
    const current = stack.pop();
    const handle = await fs.opendir(current);
    for await (const entry of handle) {
      if (++examined > maxEntries) throw new Error(`Entry limit (${maxEntries}) exceeded; no complete report produced`);
      const full = path.join(current, entry.name);
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) { skippedLinks++; continue; }
      if (stat.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') skippedDirectories++;
        else stack.push(full);
      } else if (stat.isFile()) {
        const relative = path.relative(root, full);
        const extension = path.extname(entry.name).toLowerCase() || '(none)';
        const group = extensions.get(extension) || { extension, files: 0, bytes: 0 };
        group.files++; group.bytes += stat.size; extensions.set(extension, group);
        files.push({ path: relative, bytes: stat.size }); totalBytes += stat.size;
      }
    }
  }
  return { root, files: files.length, totalBytes, examined, skippedLinks, skippedDirectories,
    largest: files.sort((a,b) => b.bytes-a.bytes || a.path.localeCompare(b.path)).slice(0,5),
    types: [...extensions.values()].sort((a,b) => b.bytes-a.bytes || a.extension.localeCompare(b.extension)) };
}

const USAGE = 'Usage: node index.js <directory> [--json] [--max-entries N]';
function parseArgs(args) {
  const options = { json: false, maxEntries: 10000 };
  let directory, positionalOnly = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!positionalOnly && arg === '--') { positionalOnly = true; continue; }
    if (!positionalOnly && arg === '--json') { options.json = true; continue; }
    if (!positionalOnly && arg === '--help') return { help: true };
    if (!positionalOnly && arg === '--max-entries') {
      const value = args[++i];
      if (!/^\d+$/.test(value || '')) throw new Error('--max-entries requires a positive integer');
      options.maxEntries = Number(value); continue;
    }
    if (!positionalOnly && arg.startsWith('--')) throw new Error(`Unknown option: ${quote(arg)}`);
    if (directory !== undefined) throw new Error(USAGE);
    directory = arg;
  }
  if (!directory) throw new Error(USAGE);
  return { directory, ...options };
}
function formatReport(report) {
  return [
    `Folder: ${quote(report.root)}`,
    `${report.files} files | ${report.totalBytes} bytes`,
    `Skipped: ${report.skippedLinks} symbolic links; ${report.skippedDirectories} .git/node_modules directories`,
    '', 'File types:',
    ...report.types.map(t => `  ${quote(t.extension)}: ${t.files} files, ${t.bytes} bytes`),
    '', 'Largest files:',
    ...report.largest.map(f => `  ${f.bytes} bytes  ${quote(f.path)}`)
  ].join('\n');
}
async function main(args) {
  const options = parseArgs(args);
  if (options.help) { console.log(USAGE); return; }
  const result = await inventory(options.directory, options);
  console.log(options.json ? JSON.stringify(result,null,2) : formatReport(result));
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(quote(error.message)); process.exitCode = 1; });
module.exports = { inventory, parseArgs, formatReport, main };
