"use strict";
const { fingerprint } = require("./artifact");

// Scan evidence is shared; these decisions belong to a single caller/session.
// Never serialize this store into scan receipts or the team verdict cache.
class ReviewDecisions {
  constructor() { this.scopes = new Map(); }
  present(scope, reviewId) {
    if (!scope) return null;
    if (!this.scopes.has(scope)) this.scopes.set(scope, new Map());
    const decisions = this.scopes.get(scope);
    if (!decisions.has(reviewId)) decisions.set(reviewId, null);
    return decisions.get(reviewId);
  }
  choose(scope, reviewId, choice) {
    if (!['Proceed', 'Decline'].includes(choice)) throw new Error('Choose Proceed or Decline');
    const decisions = this.scopes.get(scope);
    if (!decisions?.has(reviewId)) throw new Error('Review evidence must be presented to this session first');
    decisions.set(reviewId, choice);
  }
}
function reviewIdentity(receipt, { action = 'use', target = null } = {}) {
  if (!receipt?.artifactSha256 || !receipt.policySha256 || !receipt.scannerBuildId) return null;
  return fingerprint({ artifact: receipt.artifactSha256, policy: receipt.policySha256,
    action, target, analysis: receipt.analysisSha256 || null, evidence: receipt.evidenceSha256 || null, scanner: receipt.scannerBuildId, name: receipt.name, version: receipt.version });
}
function reviewOutcome(decision, { reviewId, scope, decisions, eligible = true } = {}) {
  if (decision === 'allow' || decision === 'safe') return { outcome: 'SAFE', allowed: true, review: null };
  if (decision !== 'review') return { outcome: 'UNSAFE', allowed: false, review: null };
  const choice = eligible && reviewId ? decisions?.present(scope, reviewId) : null;
  return { outcome: choice === 'Proceed' ? 'SAFE' : choice === 'Decline' ? 'UNSAFE' : null,
    allowed: choice === 'Proceed',
    review: { id: reviewId, state: choice ? 'decided' : 'pending', choice: choice || null,
      actions: eligible && reviewId ? ['Proceed', 'Decline'] : [],
      requiresDecision: !choice, eligible } };
}
// Private local CLI decisions; callers of a shared service use the in-memory
// session store above. No developer name supplied by an HTTP client is trusted.
class LocalReviewDecisions extends ReviewDecisions {
  constructor(file) {
    super(); this.file = file;
    try { this.scopes = new Map(JSON.parse(require('node:fs').readFileSync(file, 'utf8')).map(([s, d]) => [s, new Map(d)])); }
    catch { /* missing/corrupt decision store starts pending */ }
  }
  save() {
    const fs = require('node:fs'), path = require('node:path');
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${require('node:crypto').randomBytes(8).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify([...this.scopes].map(([s, d]) => [s, [...d]])), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, this.file);
  }
  present(scope, id) { const result = super.present(scope, id); this.save(); return result; }
  choose(scope, id, choice) { super.choose(scope, id, choice); this.save(); }
}
module.exports = { ReviewDecisions, LocalReviewDecisions, reviewIdentity, reviewOutcome };
