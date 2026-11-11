"use strict";

// Transport failures only. Malformed evidence and policy/coverage failures are
// deterministic uncertainty, not permission to repeat work indefinitely.
function isTransientCheckFailure(error) {
  return [408, 429, 500, 502, 503, 504].includes(error?.statusCode) ||
    ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "EPIPE"].includes(error?.code) ||
    /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE)\b|HTTP request timed out|HTTP response (?:aborted|closed)/.test(error?.message || "");
}
module.exports = { isTransientCheckFailure };
