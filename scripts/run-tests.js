"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Explicit filenames work on Node 18 and Windows without shell glob expansion.
// Fixture servers and helpers are deliberately excluded from test discovery.
const root = path.resolve(__dirname, "..");
function discover(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? discover(file) : entry.isFile() && entry.name.endsWith(".test.js") ? [file] : [];
  });
}
const files = ["test", "examples/pkgxray-proxy/test"].flatMap(dir => discover(path.join(root, dir))).sort();
if (!files.length) throw new Error("No tests discovered");
const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files], {
  cwd: root, stdio: "inherit", timeout: 180000
});
if (result.error) process.stderr.write(`Test runner failed: ${result.error.message}\n`);
process.exitCode = result.status === null ? 1 : result.status;
