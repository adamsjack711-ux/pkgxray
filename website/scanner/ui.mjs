const form = document.getElementById('cold-scan-form');
const input = document.getElementById('cold-scan-reference');
const start = document.getElementById('cold-scan-start');
const cancel = document.getElementById('cold-scan-cancel');
const status = document.getElementById('cold-scan-status');
const output = document.getElementById('cold-scan-result');
const download = document.getElementById('cold-scan-download');
const examples = document.querySelectorAll('[data-scan-example]');
let worker, timer, report;
const readable = value => String(value ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ch => `[U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}]`);
function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = readable(value);
  if (className) node.className = className;
  return node;
}
function stop() {
  worker?.terminate(); worker = null; clearTimeout(timer);
  start.disabled = false; cancel.hidden = true; input.disabled = false; form.setAttribute('aria-busy', 'false');
  for (const button of examples) button.disabled = false;
}
for (const button of examples) button.addEventListener('click', () => {
  if (worker) return;
  input.value = button.dataset.scanExample;
  report = null; output.hidden = true; download.hidden = true;
  status.textContent = `${input.value} selected. Select Scan source to check the latest published version.`;
  input.focus();
});
function show(result) {
  output.replaceChildren(); output.hidden = false; report = result; download.hidden = false;
  output.append(element('p', result.verdict.toUpperCase(), 'cold-verdict'), element('h3', result.reference), element('p', result.summary));
  const coverage = result.coverage;
  output.append(element('p', `${coverage.scannedFiles} files · ${Math.ceil(coverage.sourceBytes / 1024)} KiB of source · ${(result.durationMs / 1000).toFixed(2)} seconds`, 'cold-scan-meta'));
  const details = element('dl', undefined, 'cold-scan-checks');
  for (const [label, value] of [['Source analysis', `Completed; engine result: ${result.staticVerdict.toUpperCase()}`], ['Source identity', coverage.integrity], ['Vulnerability lookup', coverage.vulnerabilities], ['Dependencies', 'Not scanned'], ['Provenance signatures', 'Not verified'], ['Package execution', 'None']]) {
    const row = element('div'); row.append(element('dt', label), element('dd', value)); details.append(row);
  }
  output.append(details);
  const findings = result.findings.filter(f => ['high', 'medium'].includes(f.severity));
  output.append(element('h4', 'Source evidence'));
  if (!findings.length) output.append(element('p', 'No high- or medium-severity source findings in the files scanned. Informational findings are included in the JSON report.'));
  for (const finding of findings.slice(0, 30)) {
    const item = element('details', undefined, 'cold-finding');
    item.append(element('summary', `${finding.severity.toUpperCase()} · ${finding.category} · ${finding.file}`), element('p', finding.rationale));
    if (finding.snippet) { const pre = element('pre'); pre.append(element('code', finding.snippet)); item.append(pre); }
    output.append(item);
  }
  if (findings.length > 30) output.append(element('p', 'More findings are included in the JSON report.'));
  output.append(element('h4', 'Known advisories'));
  if (!result.advisories.length) output.append(element('p', coverage.vulnerabilities === 'completed' ? 'No advisories returned for this identity. This does not establish that the code is safe.' : 'Lookup unavailable; no clean vulnerability result is claimed.'));
  for (const advisory of result.advisories) {
    const paragraph = element('p'); const link = element('a', advisory.id);
    link.href = `https://osv.dev/vulnerability/${encodeURIComponent(advisory.id)}`; link.rel = 'noopener noreferrer'; link.target = '_blank';
    paragraph.append(link, document.createTextNode(readable(advisory.summary ? ` — ${advisory.summary}` : ''))); output.append(paragraph);
  }
  output.append(element('h4', 'Coverage and next steps'));
  const gaps = element('ul');
  for (const gap of [...coverage.gaps, 'This is a bounded static scan. Dormant behavior, dependencies, native code, and runtime downloads can remain undetected.', 'For broader artifact and dependency checks, use the local pkgxray CLI. No installation is approved by this website.']) gaps.append(element('li', gap));
  output.append(gaps);
  status.textContent = 'Scan complete. Review the evidence and coverage below.';
}
form.addEventListener('submit', event => {
  event.preventDefault(); stop(); report = null; output.hidden = true; download.hidden = true;
  if (!input.value.trim()) { input.focus(); status.textContent = 'Enter an npm package or public GitHub repository.'; return; }
  if (typeof Worker !== 'function') { status.textContent = 'This browser cannot run the isolated analysis worker. Use a current browser or the local CLI.'; return; }
  start.disabled = true; input.disabled = true; cancel.hidden = false; form.setAttribute('aria-busy', 'true');
  for (const button of examples) button.disabled = true;
  status.textContent = 'Starting a fresh static scan…';
  try {
    worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
    timer = setTimeout(() => { stop(); status.textContent = 'Scan stopped after 60 seconds. No security verdict was issued. Try a smaller package or the local CLI.'; }, 60000);
    worker.onmessage = event => {
      if (event.data.stage) status.textContent = readable(event.data.stage);
      else if (event.data.result) { stop(); show(event.data.result); }
      else if (event.data.error) { stop(); status.textContent = `${readable(event.data.error)} No installation was approved.`; }
    };
    worker.onerror = event => { event.preventDefault(); stop(); status.textContent = 'The scan could not complete. Check your connection or try the local CLI. No security verdict was issued.'; };
    worker.postMessage({ reference: input.value.trim() });
  } catch { stop(); status.textContent = 'The scanner could not start. No security verdict was issued.'; }
});
cancel.addEventListener('click', () => { stop(); status.textContent = 'Scan cancelled. No security verdict was issued.'; });
download.addEventListener('click', () => {
  if (!report) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = element('a'); link.href = url; link.download = `pkgxray-static-scan-${Date.now()}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
