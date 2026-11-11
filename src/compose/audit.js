'use strict';

const path = require('node:path');
const { parse, dynamic, isMap } = require('./parse');
const { parsePort, portSuggestion, mount } = require('./normalize');
const { redactor } = require('./redact');
const { resourceChecks, mountOptionsError } = require('./subset');
const { serviceName } = require('./names');
const { version } = require('./metadata.json');

const RULES = Object.freeze({
  'CXR-001': 'Published port',
  'CXR-002': 'Privileged container',
  'CXR-003': 'Host network namespace',
  'CXR-004': 'Host PID namespace',
  'CXR-005': 'Dangerous added capability',
  'CXR-006': 'Docker socket bind mount',
  'CXR-007': 'Sensitive host bind mount',
  'CXR-101': 'Published access and privileged mode',
  'CXR-102': 'Published access and Docker socket',
  'CXR-103': 'Published access and sensitive host mount',
  'CXR-900': 'Incomplete analysis',
  'CXR-901': 'Invalid input or policy'
});
const CAPS = new Set(['ALL','SYS_ADMIN','SYS_MODULE','SYS_PTRACE','SYS_RAWIO','SYS_BOOT','SYS_TIME',
  'NET_ADMIN','DAC_READ_SEARCH','DAC_OVERRIDE','BPF','PERFMON','CHECKPOINT_RESTORE']);
const KNOWN_CAPS = new Set([...CAPS, 'AUDIT_CONTROL','AUDIT_READ','AUDIT_WRITE','BLOCK_SUSPEND','CHOWN',
  'FOWNER','FSETID','IPC_LOCK','IPC_OWNER','KILL','LEASE','LINUX_IMMUTABLE','MAC_ADMIN','MAC_OVERRIDE',
  'MKNOD','NET_BIND_SERVICE','NET_BROADCAST','NET_RAW','SETFCAP','SETGID','SETPCAP','SETUID',
  'SYS_CHROOT','SYS_NICE','SYS_PACCT','SYS_RESOURCE','SYS_TTY_CONFIG','WAKE_ALARM']);
const SERVICE_KEYS = new Set((
  'image build command entrypoint environment env_file labels label_file container_name hostname domainname ' +
  'restart depends_on healthcheck expose networks volumes ports privileged network_mode pid cap_add cap_drop ' +
  'user group_add read_only security_opt tmpfs working_dir stdin_open tty init stop_grace_period stop_signal ' +
  'logging deploy profiles platform pull_policy cpus cpu_count cpu_percent cpu_period cpu_quota cpu_rt_runtime ' +
  'cpu_rt_period cpu_shares cpuset mem_limit mem_reservation mem_swappiness memswap_limit pids_limit ulimits ' +
  'shm_size dns dns_opt dns_search extra_hosts links external_links ipc uts userns_mode cgroup cgroup_parent ' +
  'sysctls storage_opt blkio_config oom_kill_disable oom_score_adj isolation runtime devices device_cgroup_rules ' +
  'volumes_from extends provider post_start pre_stop develop models use_api_socket gpus credential_spec ' +
  'secrets configs attach annotations scale mac_address'
).split(/\s+/));
const UNSUPPORTED = new Set(['extends','volumes_from','provider','post_start','pre_stop','develop','models',
  'use_api_socket','devices','device_cgroup_rules','gpus','credential_spec']);
const rank = { high: 3, medium: 2, low: 1, info: 0 };
const own = (obj, key) => Object.hasOwn(obj, key);
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function baseReport() {
  return { schemaVersion: 1, tool: { name: 'compose-xray', version }, status: 'no-findings', complete: true,
    riskStatus: 'no-findings', analysisStatus: 'complete',
    exitCode: 0, scope: 'Single supplied file; all declared services and profiles; static Linux Compose subset.',
    findings: [], summary: { active: 0, informational: 0, suppressed: 0, limitations: 0 },
    notices: [
      'A published port does not prove internet reachability or a vulnerability. Authentication and exploitability are not inspected.',
      'No containers, images, project scripts, environment files, or network services are accessed. No Compose files are modified.'
    ] };
}

function validatePolicy(policy) {
  if (policy === undefined) return [];
  if (!isMap(policy) || policy.schemaVersion !== 1 || !Array.isArray(policy.suppressions) ||
      Object.keys(policy).some(k => !['schemaVersion','suppressions'].includes(k))) return null;
  const seen = new Set();
  for (const item of policy.suppressions) {
    if (!isMap(item) || Object.keys(item).some(k => !['ruleId','service','reason'].includes(k)) ||
        !own(RULES, item.ruleId) || ['CXR-900','CXR-901'].includes(item.ruleId) ||
        !serviceName(item.service) ||
        typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 1000) return null;
    const key = `${item.ruleId}/${item.service}`;
    if (seen.has(key)) return null;
    seen.add(key);
  }
  return policy.suppressions;
}

function finish(report, policy, redact) {
  const suppressions = validatePolicy(policy);
  if (suppressions === null) {
    report.findings.push({ id: `F${report.findings.length + 1}`, ruleId: 'CXR-901', severity: 'high',
      service: null, file: null, line: null, evidence: { kind: 'invalid-policy' },
      explanation: 'Policy is invalid. No suppressions were applied.',
      suggestion: 'Use schemaVersion: 1 and exact ruleId/service suppressions with nonempty reasons; coverage gaps cannot be suppressed.',
      relatedFindings: [], suppressed: false, suppressionReason: null });
  }
  for (const s of suppressions || []) {
    const matches = report.findings.filter(f => f.ruleId === s.ruleId && f.service === s.service);
    for (const finding of matches) { finding.suppressed = true; finding.suppressionReason = redact(s.reason); }
    if (!matches.length) report.notices.push('An explicit policy suppression matched no finding. Review the policy for stale entries.');
  }
  for (const finding of report.findings) {
    finding.service = redact(finding.service);
    finding.file = redact(finding.file);
    finding.explanation = redact(finding.explanation);
    finding.suggestion = redact(finding.suggestion);
    // Redact validated evidence too if it happens to equal a known secret value.
    function clean(value) {
      if (typeof value === 'string') return redact(value);
      if (Array.isArray(value)) return value.map(clean);
      if (isMap(value)) return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,clean(v)]));
      return value;
    }
    finding.evidence = clean(finding.evidence);
  }
  report.findings.sort((a,b) => rank[b.severity] - rank[a.severity] || cmp(a.service || '', b.service || '') || cmp(a.ruleId,b.ruleId) || cmp(a.id,b.id));
  report.summary = {
    active: report.findings.filter(f => !f.suppressed && rank[f.severity] > 0 && !['CXR-900','CXR-901'].includes(f.ruleId)).length,
    informational: report.findings.filter(f => !f.suppressed && f.severity === 'info').length,
    suppressed: report.findings.filter(f => f.suppressed).length,
    limitations: report.findings.filter(f => f.ruleId === 'CXR-900').length
  };
  const error = report.findings.some(f => f.ruleId === 'CXR-901');
  report.complete = !error && report.summary.limitations === 0;
  report.riskStatus = report.summary.active ? 'findings' : error ? 'unknown' : 'no-findings';
  report.analysisStatus = error ? 'error' : report.complete ? 'complete' : 'incomplete';
  report.status = error ? 'error' : !report.complete ? 'incomplete' : report.summary.active ? 'findings' : 'no-findings';
  report.exitCode = error ? 1 : !report.complete ? 3 : report.summary.active ? 2 : 0;
  return report;
}

function audit(source, options = {}) {
  const report = baseReport();
  const file = options.file || '<input>';
  const parsed = parse(source);
  let locate = parsed.line || (() => null);
  function add(ruleId, severity, service, keys, evidence, explanation, suggestion, relatedFindings = []) {
    const finding = { id: `F${report.findings.length + 1}`, ruleId, severity, service, file,
      line: locate(service === null ? keys : ['services', service, ...keys]), evidence,
      explanation, suggestion, relatedFindings, suppressed: false, suppressionReason: null };
    report.findings.push(finding);
    return finding;
  }
  function gap(service, keys, explanation, suggestion = 'Supply one complete, literal Compose file using the documented subset; review omitted configuration before relying on this report.', evidence = {}) {
    return add('CXR-900','medium',service,keys,{ kind: 'unsupported-or-unresolved-configuration', ...evidence },explanation,suggestion);
  }
  if (parsed.error) {
    locate = () => parsed.line;
    // Even file names may contain credentials; never include malformed source.
    const error = add('CXR-901','high',null,[],{ kind: 'yaml-input' },parsed.error,'Correct the YAML or reduce its complexity and audit again.');
    // Parsing failed, so no trustworthy secret dictionary exists. Do not echo
    // a potentially secret-bearing filename in this error path.
    error.file = null;
    return finish(report,options.policy,redactor(options.policy));
  }
  const data = parsed.data;
  const redact = redactor(data, options.policy);
  if (!isMap(data) || !isMap(data.services) || !Object.keys(data.services).length) {
    add('CXR-901','high',null,[],{kind:'compose-structure'},'Expected a nonempty services mapping.','Provide a Compose document with services: and at least one service.');
    return finish(report, options.policy, redact);
  }
  for (const key of Object.keys(data).sort()) {
    if (!['name','version','services','volumes','networks','secrets','configs'].includes(key) && !key.startsWith('x-')) {
      gap(null,[key], 'A top-level include, unsupported key, or unknown construct can change the effective configuration.');
    }
    if (key !== 'services' && dynamic(data[key])) gap(null,[key],'Top-level interpolation is unresolved. Ambient environment variables and .env files are deliberately not loaded.');
  }
  const resources = resourceChecks(data,gap);
  for (const message of options.limitations || []) gap(null,[],message);
  for (const service of Object.keys(data.services).sort(cmp)) {
    const config = data.services[service];
    if (!serviceName(service) || !isMap(config)) {
      gap(service,[],'Service names must be Compose identifiers and definitions must be mappings.'); continue;
    }
    const risks = [], access = [];
    const servicePath = key => [key];
    for (const key of Object.keys(config).sort(cmp)) {
      if ((!SERVICE_KEYS.has(key) && !key.startsWith('x-')) || UNSUPPORTED.has(key)) {
        gap(service,[key],'This service contains an unsupported or unknown construct that may affect host access or effective configuration.');
      }
      const listField = ['ports','volumes','cap_add','cap_drop','configs','secrets','env_file','label_file'].includes(key);
      const items = listField && Array.isArray(config[key]) ? config[key].map((v,i) => [v,[key,i]]) : [[config[key],[key]]];
      for (const [value,keys] of items) if (dynamic(value)) gap(service,keys,
        'Interpolation is unresolved (including defaults and required expressions). Ambient variables and .env files are deliberately not loaded.',
        'Replace the expression in a separate audit input with its intended effective literal value; this tool does not resolve or execute substitutions.');
    }
    // File-backed process settings remain unknown even when optional. Record
    // references without stat/open/resolve operations on their contents.
    for (const field of ['env_file','label_file']) {
      if (!own(config,field)) continue;
      const value = config[field];
      const items = Array.isArray(value) ? value.map((v,i)=>[v,[field,i]]) : [[value,[field]]];
      for (const [item,keys] of items) {
        if (dynamic(item)) continue; // Item-scoped interpolation already reported.
        const nonempty = v => typeof v === 'string' && v.trim().length > 0;
        const longForm = field === 'env_file' && Array.isArray(value) && isMap(item) &&
          nonempty(item.path) && Object.keys(item).every(k=>['path','required','format'].includes(k)) &&
          (!own(item,'required') || typeof item.required === 'boolean') &&
          (!own(item,'format') || item.format === 'raw');
        const valid = nonempty(item) || longForm;
        gap(service,keys,valid ? 'Referenced environment or label file contents are not analysed; optional files are not resolved either.' :
          'Environment or label file reference has unsupported keys or an invalid type; its contents are not analysed.',
          'Review the referenced settings separately. Retain necessary files and keep credential values out of shared audit inputs and reports.',
          {kind:valid?'unanalysed-file-input':'invalid-file-input',field,contents:'not-read'});
      }
    }
    // These settings were previously only listed as exclusions in prose. Make
    // their absence of analysis visible in each affected service's report.
    for (const field of ['ipc','security_opt']) {
      if (!own(config,field) || dynamic(config[field])) continue;
      if (field === 'security_opt' && Array.isArray(config[field]) && config[field].length === 0) continue;
      gap(service,[field],
        field === 'ipc' ? 'The declared IPC namespace setting is not analysed; process communication and runtime isolation cannot be determined from this scan.' :
          'Nonempty security_opt settings are not analysed; seccomp, LSM and other security-option effects cannot be determined from this scan. Invalid types are also outside the supported subset.',
        'Review this setting and its runtime effects separately. Retain needed protections; do not remove a security setting merely to obtain a complete report.',
        {kind:'unanalysed-security-setting',field});
    }
    if (config.profiles) report.notices.push('Profile-gated services are audited as declared; findings apply if those services are started.');
    if (own(config,'platform') && (typeof config.platform !== 'string' || !config.platform.startsWith('linux'))) {
      gap(service,['platform'],'Only Linux container semantics are covered.');
    }
    if (isMap(config.build) && (config.build.privileged || config.build.entitlements)) {
      gap(service,['build'],'Build privileges and entitlements are outside the runtime Compose checks.');
    }
    resources.service(service,config);
    if (own(config,'privileged') && !dynamic(config.privileged)) {
      if (![true,false,'true','false'].includes(config.privileged)) gap(service,['privileged'],'privileged must be a boolean or a literal true/false string.');
      else if (config.privileged === true || config.privileged === 'true') {
        risks.push(add('CXR-002','high',service,['privileged'],{privileged:true},
          'Privileged mode grants broad device and kernel capabilities. Host impact depends on runtime isolation and the compromised process.',
          'Set privileged: false; grant only individually required capabilities and devices.'));
      }
    }
    for (const [key, rule] of [['network_mode','CXR-003'],['pid','CXR-004']]) {
      if (!own(config,key) || dynamic(config[key])) continue;
      if (config[key] === 'host') add(rule,'high',service,servicePath(key),{ namespace: key === 'pid' ? 'host-pid' : 'host-network' },
        key === 'pid' ? 'The container shares host process visibility. Interference or inspection also depends on process permissions and capabilities.' :
          'The container shares the host network namespace. Listening ports, bind addresses, authentication, and reachability cannot be inferred from this setting.',
        `Remove ${key}: host to restore a separate namespace${key === 'network_mode' ? '; publish only required ports with an explicit loopback host_ip' : ''}.`);
      else if (typeof config[key] !== 'string' || (key === 'network_mode' ? !['none','bridge'].includes(config[key]) : !['private',''].includes(config[key]))) {
        gap(service,[key],'Namespace sharing or a custom namespace cannot be resolved by this auditor.');
      }
    }
    for (const field of ['cap_add','cap_drop']) {
      if (!own(config,field)) continue;
      if (!Array.isArray(config[field])) gap(service,[field],`${field} must be a list of capability names.`);
      else config[field].forEach((value, index) => {
        if (dynamic(value)) return;
        const cap = typeof value === 'string' ? value.toUpperCase().replace(/^CAP_/,'') : '';
        if (!KNOWN_CAPS.has(cap)) gap(service,[field,index],'A capability name is invalid or outside the known Linux capability list.');
        else if (field === 'cap_add' && CAPS.has(cap)) add('CXR-005','high',service,[field,index],{capability:cap},
          'This explicitly added capability can materially increase the impact of a compromised process. Actual power depends on kernel, namespace, runtime, and other controls.',
          `Remove ${cap} from cap_add; start with cap_drop: [ALL] and add back only documented requirements.`);
      });
    }
    for (const key of ['ports','volumes']) {
      if (!own(config,key)) continue;
      if (!Array.isArray(config[key])) { gap(service,[key],`${key} must be a list.`); continue; }
      config[key].forEach((value,index) => {
        if (dynamic(value)) return;
        if (key === 'ports') {
          const {value:p,error} = parsePort(value);
          if (!p) { gap(service,[key,index],error.message,undefined,{field:'ports',diagnosticCode:error.code}); return; }
          if (p.mode === 'ingress') gap(service,[key,index],'Swarm ingress routing is outside the standalone Compose networking model; binding scope may differ.');
          if (config.network_mode === 'host' || config.network_mode === 'none') {
            gap(service,[key,index],'Published ports conflict with host/none network mode; no publication conclusion is drawn.'); return;
          }
          const f = add('CXR-001',p.binding === 'loopback' ? 'info' : 'medium',service,[key,index],p,
            p.binding === 'loopback' ? 'The declared port binds to loopback. Local processes and forwarding proxies may still reach it; publication alone proves neither internet reachability nor a vulnerability.' :
              `${p.hostIpExplicit ? `The declared port binds to ${p.binding === 'all-interfaces' ? 'all host interfaces' : 'a specific non-loopback interface'}.` : 'No host IP is declared; standard Compose defaults publish on all host interfaces.'} Routing, firewalls, Docker/runtime settings, and application behavior determine access; this does not prove internet reachability or a vulnerability.`,
            portSuggestion(p));
          access.push(f);
        } else {
          const optionError = mountOptionsError(value);
          if (optionError) gap(service,[key,index],optionError,undefined,{field:'volumes'});
          const m = mount(value, path.posix.dirname(path.resolve(file)));
          if (!m) { gap(service,[key,index],'A mount entry is invalid or outside supported Linux bind/volume/tmpfs syntax.'); return; }
          if (m.type !== 'bind') return;
          if (m.socket) risks.push(add('CXR-006','high',service,[key,index],{type:'bind',sourceClass:'docker-socket-path',readOnly:m.readOnly},
            'The bind source or destination identifies a Docker socket path. If it is a live daemon socket and the process can connect, Docker API access may control containers and host resources. A read-only bind does not make the socket API read-only.',
            'Remove this socket bind. If orchestration is essential, use a separately secured, narrowly authorized API intermediary; adding :ro alone is insufficient.'));
          else if (m.sensitive) risks.push(add('CXR-007','high',service,[key,index],{type:'bind',sourceClass:m.sensitive,readOnly:m.readOnly},
            `A host bind overlaps sensitive ${m.sensitive} paths. ${m.readOnly ? 'Read-only access can still disclose host data; it reduces ordinary file writes but is not a universal boundary for kernel interfaces.' : 'Read/write access can disclose or alter host data subject to process and host permissions.'} Paths are classified lexically; contents and symlinks are not inspected.`,
            'Remove the host bind or replace it with a named volume; if host data is required, bind only a dedicated non-sensitive subdirectory and set read_only: true.'));
        }
      });
    }
    for (const risk of risks) {
      if (!access.length) continue;
      const rule = {'CXR-002':'CXR-101','CXR-006':'CXR-102','CXR-007':'CXR-103'}[risk.ruleId];
      const allLocal = access.every(f => f.evidence.binding === 'loopback');
      const finding = add(rule,allLocal ? 'medium' : 'high',service,[],
        { bindings: access.map(f => f.evidence), hostAccess: risk.evidence },
        `Published service access is combined with ${RULES[risk.ruleId].toLowerCase()}. Exploitation would require an attacker able to reach the published listener${allLocal ? ' (here through local access or an additional forwarding/proxy path)' : ''}, an application flaw or authorized functionality that permits misuse, and sufficient process/host permissions to use the configured host access. Configuration inspection does not establish an exploit or the application's authentication state.`,
        `Break either part of this path: remove unneeded ports or constrain access to a trusted authenticated gateway, and address the host access setting. ${risk.suggestion}`,
        [...access.map(f => f.id),risk.id]);
      finding.line = risk.line;
    }
  }
  resources.finish();
  report.notices = [...new Set(report.notices)];
  return finish(report, options.policy, redact);
}

function failure(message, kind = 'input') {
  const report = baseReport();
  report.findings.push({id:'F1',ruleId:'CXR-901',severity:'high',service:null,file:null,line:null,
    evidence:{kind},explanation:message,suggestion:'Check the documented CLI arguments and readable UTF-8 input files.',
    relatedFindings:[],suppressed:false,suppressionReason:null});
  return finish(report,undefined,redactor({}));
}

function render(report) {
  const out = [`Compose X-Ray ${version} — ${report.status.toUpperCase()}`,
    `Risk: ${report.riskStatus}; analysis: ${report.analysisStatus}`,
    `${report.summary.active} active, ${report.summary.informational} informational, ${report.summary.suppressed} suppressed, ${report.summary.limitations} limitations`,
    `Scope: ${report.scope}`];
  for (const f of report.findings) {
    out.push('',`${f.suppressed ? 'SUPPRESSED ' : ''}${f.severity.toUpperCase()} ${f.ruleId} [${f.service || 'document'}] ${f.file || '<input>'}${f.line ? `:${f.line}` : ''}`,
      `  Evidence: ${JSON.stringify(f.evidence)}`,`  ${f.explanation}`,`  Change: ${f.suggestion}`);
    if (f.relatedFindings.length) out.push(`  Connected evidence: ${f.relatedFindings.join(', ')} (this finding: ${f.id})`);
    else out.push(`  Finding: ${f.id}`);
    if (f.suppressed) out.push(`  Policy reason: ${f.suppressionReason}`);
  }
  out.push('',...report.notices.map(n => `Note: ${n}`));
  if (report.status === 'no-findings') out.push('No unsuppressed review findings in the supported subset; this is not a security certification.');
  return `${out.join('\n')}\n`;
}

module.exports = { audit, render, failure, RULES, CAPS, validatePolicy };
