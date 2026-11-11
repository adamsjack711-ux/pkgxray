'use strict';
// A fixed measurement cohort, not a production accuracy or performance estimate.
const { BENIGN_CONTROLS } = require('./validate-external-corpus');
const { runPinnedControls } = require('./live-control-runner');

async function runLiveControls(options = {}) {
  const result = await runPinnedControls(BENIGN_CONTROLS.map(control => ({ ...control, expectedSha256: control.artifactSha256 })), options);
  return { ...result,
    selection: 'Four fixed exact-version registry controls with pinned artifact SHA256; no replacement on errors.',
    limitations: 'Small selected benign cohort; labels are assumptions. Not production accuracy, malicious recall, or a latency benchmark. A valid measurement may contain blocks.' };
}

if (require.main === module) {
  if (process.argv.length !== 3 || process.argv[2] !== '--live') {
    console.error('Usage: node scripts/check-live-controls.js --live (real npm/OSV checks; exits nonzero for invalid measurement, not for a valid block).');
    process.exitCode = 1;
  } else {
    runLiveControls().then(result => {
      console.log(JSON.stringify(result, null, 2));
      if (!result.measurementValid) process.exitCode = 1;
    }).catch(() => { console.error('Live control measurement failed.'); process.exitCode = 1; });
  }
}
module.exports = { runLiveControls };
