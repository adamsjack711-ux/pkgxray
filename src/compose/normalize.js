'use strict';

const net = require('node:net');
const path = require('node:path');
const { isMap, dynamic } = require('./parse');
const own = (obj, key) => Object.hasOwn(obj, key);

function range(value, allowZero = false) {
  if (!['string', 'number'].includes(typeof value) || !/^\d+(?:-\d+)?$/.test(String(value))) return null;
  const parts = String(value).split('-').map(Number);
  const [start, end = start] = parts;
  if (start < (allowZero ? 0 : 1) || end > 65535 || end < start || (start === 0 && end !== 0)) return null;
  return { text: start === end ? String(start) : `${start}-${end}`, size: end - start + 1 };
}

function binding(host) {
  if (host === undefined || host === '') return 'all-interfaces';
  if (typeof host !== 'string') return null;
  host = host.replace(/^\[([^\]]+)\]$/, '$1');
  if (!net.isIP(host)) return null;
  if (net.isIPv4(host)) {
    if (host === '0.0.0.0') return 'all-interfaces';
    return host.startsWith('127.') ? 'loopback' : 'specific-interface';
  }
  let canonical;
  try { canonical = new URL(`http://[${host}]/`).hostname.slice(1, -1); } catch { return null; }
  if (canonical === '::') return 'all-interfaces';
  if (canonical === '::1') return 'loopback';
  if (/^::ffff:7f[0-9a-f]{2}:/.test(canonical)) return 'loopback';
  if (canonical === '::ffff:0:0') return 'all-interfaces';
  return 'specific-interface';
}

function parsePort(value) {
  const fail = (code,message) => ({value:null,error:{code,message}});
  if (dynamic(value)) return fail('unresolved-port','Port entry contains unresolved interpolation.');
  let host, published, target, protocol = 'tcp', mode = 'host-default';
  let short = false;
  if (typeof value === 'string' || typeof value === 'number') {
    short = true;
    const segments = String(value).split('/');
    if (segments.length > 2) return fail('port-protocol-syntax','A short port entry permits at most one protocol suffix.');
    if (segments.length === 2) protocol = segments[1].toLowerCase();
    let text = segments[0];
    if (text.startsWith('[')) {
      const match = text.match(/^\[([^\]]+)\]:(.+)$/);
      if (!match) return fail('port-ipv6-syntax','Bracketed IPv6 short syntax requires [address]:published:target.');
      host = match[1]; text = match[2];
      const parts = text.split(':');
      if (parts.length !== 2) return fail('port-ipv6-syntax','Bracketed IPv6 short syntax requires separate published and target fields.');
      [published, target] = parts;
    } else {
      const parts = text.split(':');
      if (parts.length === 1) [target] = parts;
      else if (parts.length === 2) [published, target] = parts;
      else if (parts.length === 3) [host, published, target] = parts;
      else return fail('port-short-syntax','Short ports require target, published:target or host_ip:published:target; bracket IPv6 addresses.');
    }
  } else if (isMap(value)) {
    if (Object.keys(value).some(k => !['target','published','host_ip','protocol','mode','name','app_protocol'].includes(k) && !k.startsWith('x-'))) {
      return fail('port-unknown-key','Long port entry contains an unsupported key.');
    }
    ({ target, published, host_ip: host, protocol = 'tcp', mode = 'host-default' } = value);
    if (own(value,'mode') && !['host','ingress'].includes(mode)) return fail('port-mode','Explicit port mode must be host or ingress.');
    if (['name','app_protocol'].some(k => own(value,k) && typeof value[k] !== 'string')) return fail('port-metadata-type','Port name and app_protocol must be strings when supplied.');
  } else return fail('port-entry-type','Port entries must be a numeric target, a short-form string, or a long-form mapping.');
  const t = range(target), p = published === undefined || published === '' ? null : range(published, true);
  const scope = binding(host);
  if (!t) return fail('port-target-range','Target must be a port or ascending short-form range within 1–65535.');
  if (published !== undefined && published !== '' && !p) return fail('port-published-range','Published port must be within 1–65535, an ascending range, or 0 for dynamic allocation; a range cannot start at 0.');
  if (!scope) return fail('port-host-ip','host_ip must be a numeric IPv4/IPv6 address in the supported syntax; hostnames and IPv6 zones are not resolved.');
  if (!['tcp','udp','sctp'].includes(protocol)) return fail('port-protocol','Protocol must be tcp, udp or sctp (long form uses lowercase).');
  if (short && p && t.size > 1 && p.size !== t.size) return fail('port-range-length','When target is a range, a supplied published range must have the same number of ports. A host allocation range is allowed for a single target.');
  if (!short && t.size !== 1) return fail('port-long-target','Long-form target must be a single port; use short-form paired ranges or separate long entries.');
  const publication = !p || p.text === '0' ? 'dynamic' : t.size > 1 ? 'paired-range' : p.size > 1 ? 'allocation-range' : 'fixed';
  return { value: { binding: scope, hostIpExplicit: host !== undefined && host !== '',
    published: p?.text || 'dynamic', target: t.text, protocol, mode, publication }, error:null };
}

// Keep the existing normalizer interface for callers that only need a value.
function port(value) { return parsePort(value).value; }

function portSuggestion(p) {
  if (p.binding === 'loopback') return 'Keep the explicit loopback binding, or remove ports if host access is unnecessary; review any proxy forwarding to it.';
  const mapping = `${p.published === 'dynamic' ? '' : p.published}:${p.target}/${p.protocol}`;
  return `If host-local access is sufficient, use the short ports entry "127.0.0.1:${mapping}" (or "[::1]:${mapping}" for IPv6), preserving the published/target mapping. Otherwise remove ports or restrict access with a reviewed firewall and authenticated gateway.`;
}

function mount(value, baseDir) {
  if (dynamic(value)) return null;
  let type, source, target, readOnly = false;
  if (typeof value === 'string') {
    const parts = value.replace(/\$\$/g, '$').split(':');
    if (parts.length === 1) return value.startsWith('/') ? { type: 'volume', readOnly: false } : null;
    if (parts.length > 3) return null;
    [source, target] = parts;
    if (!source || !target.startsWith('/')) return null;
    const flags = parts[2] === undefined ? [] : parts[2].split(',');
    if (flags.some(f => !['ro','rw','z','Z','private','rprivate','shared','rshared','slave','rslave','consistent','cached','delegated','nocopy'].includes(f))) return null;
    if (flags.includes('ro') && flags.includes('rw')) return null;
    readOnly = flags.includes('ro');
    type = /^(\/|\.{1,2}(?:\/|$)|~)/.test(source) ? 'bind' : 'volume';
    if (type === 'volume' && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(source)) return null;
  } else if (isMap(value)) {
    if (Object.keys(value).some(k => !['type','source','target','read_only','bind','volume','tmpfs','consistency'].includes(k))) return null;
    ({ type, source, target } = value);
    if (own(value, 'read_only') && typeof value.read_only !== 'boolean') return null;
    readOnly = value.read_only === true;
    if (!['bind','volume','tmpfs'].includes(type) || typeof target !== 'string' || !target.startsWith('/')) return null;
    if (type === 'bind' && (typeof source !== 'string' || !source)) return null;
    if (type === 'volume' && source !== undefined && (typeof source !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(source))) return null;
  } else return null;
  if (type !== 'bind') return { type, readOnly };
  if (/^[A-Za-z]:|^\\|^~/.test(source)) return null;
  const resolved = path.posix.resolve(baseDir, source);
  const socket = path.posix.basename(resolved) === 'docker.sock' || path.posix.basename(target) === 'docker.sock';
  const sensitive = [
    ['/', 'host-root'], ['/etc','system-configuration'], ['/proc','kernel-interface'], ['/sys','kernel-interface'],
    ['/dev','host-devices'], ['/root','user-home'],
    ['/run','runtime-state'], ['/var/run','runtime-state'], ['/var/lib/docker','container-runtime-state'],
    ['/var/lib/containerd','container-runtime-state'], ['/var/lib/kubelet','container-runtime-state'],
    ['/boot','system-files'], ['/usr','system-files'], ['/bin','system-files'], ['/sbin','system-files'],
    ['/lib','system-files'], ['/lib64','system-files'], ['/var/log','host-logs']
  ].find(([root]) => resolved === root || (root !== '/' && (resolved.startsWith(`${root}/`) || root.startsWith(`${resolved}/`))));
  const credential = /(?:^|\/)\.(?:ssh|aws|azure|kube|docker|gnupg)(?:\/|$)|(?:^|\/)\.env(?:\.|$)/.test(resolved);
  const home = /^\/(?:home|Users)(?:\/[^/]+)?$/.test(resolved);
  return { type, readOnly, socket, sensitive: sensitive?.[1] || (credential ? 'credential-directory' : home ? 'user-home' : null) };
}

module.exports = { port, parsePort, portSuggestion, mount, binding };
