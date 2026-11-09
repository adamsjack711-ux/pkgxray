"use strict";

const GLOBAL_EVAL_CALL_RE = /\b(?:globalThis|global|window|self)\s*\[\s*['"]eval['"]\s*\]\s*\(/i;
const CONCEALED_CHILD_PROCESS_RE =
  /\brequire\s*\(\s*['"](?:node:)?child_process['"]\s*\)[\s\S]{0,600}?\.(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(/i;
const REMOTE_IMPORT_RE = /\bimport\s*\(\s*['"`]https?:\/\//i;
const REMOTE_CODE_LOAD_REGEXES = [
  /(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:[a-z]*sh|node|python[0-9.]*|ruby|perl)\b/i,
  /(?:eval|new\s+Function|vm\.runIn[A-Za-z]+Context)\s*\(\s*(?:await\s+)?(?:fetch|got|axios|node-fetch|https?\.get)\b/i,
  /\.then\s*\(\s*eval\s*\)/,
  /\.then\s*\(\s*\w+\s*=>\s*eval\s*\(/,
  /\.on\s*\(\s*['"`](?:end|close)['"`][\s\S]{0,120}?(?:eval|new\s+Function|vm\.runIn[A-Za-z]+Context)\s*\(/i
];

function clipAround(value, index, radius = 90) {
  return String(value).slice(Math.max(0, index - radius), index + radius)
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "�")
    .replace(/\s+/g, " ").trim().slice(0, 180);
}

function inspectRuntimeLoaders({ file, code, normalized, normChanged, isInstallTime }) {
  const findings = [];
  if (normChanged) {
    let match = !GLOBAL_EVAL_CALL_RE.test(code) && GLOBAL_EVAL_CALL_RE.exec(normalized);
    let shape = "a computed global eval call";
    if (!match) {
      match = !CONCEALED_CHILD_PROCESS_RE.test(code) && CONCEALED_CHILD_PROCESS_RE.exec(normalized);
      shape = "an encoded child_process loader followed by process execution";
    }
    if (match) findings.push({
      severity: "high", category: "concealed-runtime-execution", file: file.path,
      snippet: clipAround(normalized, match.index),
      rationale: `Static de-obfuscation revealed ${shape}. Concealing the executor or privileged module name while immediately invoking it is a high-confidence loader shape.`
    });
  }

  const remoteImport = REMOTE_IMPORT_RE.exec(code);
  if (remoteImport) {
    findings.push({
      severity: "high", category: "remote-code-load", file: file.path,
      snippet: clipAround(file.content, remoteImport.index),
      rationale: "Dynamically imports executable code directly from a remote URL. The shipped artifact does not contain the code that will execute, so the install is blocked."
    });
    return findings;
  }
  for (const re of REMOTE_CODE_LOAD_REGEXES) {
    const match = re.exec(code);
    if (!match) continue;
    findings.push({
      severity: isInstallTime ? "high" : "medium", category: "remote-code-load", file: file.path,
      snippet: clipAround(file.content, match.index),
      rationale: isInstallTime
        ? "Install-time code downloads content and feeds it directly to an interpreter. Installing the package would execute bytes absent from the reviewed artifact, so the install is blocked."
        : "Downloads content from the network and feeds it straight to an interpreter (curl | sh, eval/Function/vm over a fetched body). Download-then-execute fetches the real payload at runtime, where a static scan can't see it — flagged for review."
    });
    break;
  }
  return findings;
}

module.exports = { inspectRuntimeLoaders };
