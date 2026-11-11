"use strict";

// Compatibility exports deliberately produce no pending decision or manual
// choices. Remediation facts live in guard result.resolution and assessment.
function buildReviewPlan() { return null; }
function renderReviewPlan() { return []; }
module.exports = { buildReviewPlan, renderReviewPlan };
