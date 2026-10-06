"use strict";

const { spawn } = require("node:child_process");

// Archive listing validation must not require buffering unlimited output first.
function runCapture(command, args, { timeoutMs = 30000, maxBytes = 8 * 1024 * 1024, maxLines = 20000, spawnOptions = {} } = {}) {
  // Package-manager scripts can prepend project node_modules/.bin to PATH.
  // Archive inspection must not execute a project-provided tar, gzip or options
  // injected via TAR_OPTIONS / loader environment variables.
  if (command === "tar" && process.platform !== "win32") {
    command = "/usr/bin/tar";
    spawnOptions = { ...spawnOptions, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } };
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let bytes = 0;
    let lines = 0;
    let stderr = "";
    let failure;
    const stop = (error) => {
      if (failure) return;
      failure = error;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop(new Error(`${command} timed out`)), timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (failure) return;
      bytes += chunk.length;
      for (const byte of chunk) if (byte === 10) lines += 1;
      if (bytes > maxBytes || lines > maxLines) return stop(new Error(`${command} output exceeded resource limit`));
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-8192); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

module.exports = { runCapture };
