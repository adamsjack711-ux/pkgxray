"use strict";

const https = require("node:https");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

// Bound the entire request, including DNS, queued sockets and slow-drip bodies.
// Callers still own URL/host policy; this helper owns transport resource limits.
function requestText(url, options = {}) {
  const { transport = https, timeoutMs = 15000, maxBytes = 16 * 1024 * 1024,
    body, writable, deadline = Date.now() + timeoutMs, ...requestOptions } = options;
  return new Promise((resolve, reject) => {
    let request;
    let response;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        if (response) response.destroy();
        if (request && request.destroy) request.destroy();
        if (writable) writable.destroy();
      } else resolve(value);
    };
    const remaining = Math.min(timeoutMs, deadline - Date.now());
    const timer = setTimeout(() => finish(new Error(`HTTP request timed out after ${timeoutMs} ms`)), Math.max(1, remaining));
    if (remaining <= 0) { finish(new Error("HTTP request timed out (deadline exhausted)")); return; }
    if (writable) writable.on("error", finish);
    const receive = (res) => {
      if (settled) { res.destroy(); return; }
      response = res;
      let bytes = 0;
      const chunks = [];
      const metadata = { statusCode: res.statusCode, ...(res.headers ? { headers: res.headers } : {}) };
      res.on("error", (error) => finish(error));
      res.on("aborted", () => finish(new Error("HTTP response aborted")));
      if (writable && res.statusCode >= 200 && res.statusCode < 300) {
        const meter = new Transform({ transform(chunk, encoding, callback) {
          bytes += chunk.length;
          callback(bytes > maxBytes ? new Error(`HTTP response exceeded ${maxBytes} bytes`) : null, chunk);
        } });
        pipeline(res, meter, writable).then(() => finish(null, { ...metadata, bytes }), finish);
        return;
      }
      res.on("data", (chunk) => {
        if (settled) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) return finish(new Error(`HTTP response exceeded ${maxBytes} bytes`));
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on("end", () => finish(null, { ...metadata, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("close", () => { if (!settled) finish(new Error("HTTP response closed before completion")); });
    };
    try {
      request = body === undefined && !requestOptions.method
        ? transport.get(url, requestOptions, receive)
        : transport.request(url, { ...requestOptions, method: requestOptions.method || "POST" }, receive);
      request.on("error", (error) => finish(error));
      if (body !== undefined || requestOptions.method) request.end(body);
    } catch (error) { finish(error); }
  });
}

// One deadline and destination across all redirect hops. Caller-supplied policy
// returns the validated URL and socket lookup; redirects never skip it.
async function downloadFile(url, destination, { validate, timeoutMs = 30000, maxBytes = 64 * 1024 * 1024, maxRedirects = 5, headers = {}, transport } = {}) {
  const fs = require("node:fs");
  const fsp = require("node:fs/promises");
  const deadline = Date.now() + timeoutMs;
  let current = url, file, created = false;
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const checked = validate(current);
      if (!file) {
        file = fs.createWriteStream(destination, { mode: 0o600, flags: "wx" });
        file.once("open", () => { created = true; });
      }
      const response = await requestText(checked.url, {
        transport: transport || (checked.url.protocol === "http:" ? require("node:http") : https),
        lookup: checked.lookup, agent: false, headers, writable: file, timeoutMs, deadline, maxBytes
      });
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers?.location) {
        current = new URL(response.headers.location, checked.url).href;
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        const error = new Error(`HTTP ${response.statusCode} downloading artifact`);
        error.statusCode = response.statusCode; throw error;
      }
      return response;
    }
    throw new Error("Too many artifact redirects");
  } catch (error) {
    if (file) {
      // Wait for open/close before unlinking, including asynchronous open errors.
      await new Promise(resolve => { if (file.closed) return resolve(); file.once("close", resolve); file.destroy(); });
      if (created) await fsp.unlink(destination).catch(() => {});
    }
    throw error;
  }
}

async function requestJson(url, options) {
  const { statusCode, body } = await requestText(url, options);
  if (statusCode < 200 || statusCode >= 300) {
    const error = new Error(`HTTP ${statusCode} from ${url}`);
    error.statusCode = statusCode;
    throw error;
  }
  return JSON.parse(body);
}

module.exports = { requestText, requestJson, downloadFile };
