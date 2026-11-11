'use strict';

const { isMap, dynamic } = require('./parse');
const own = (obj,key) => Object.hasOwn(obj,key);
const string = v => typeof v === 'string';
const nonempty = v => string(v) && v.length > 0;
const boolean = v => typeof v === 'boolean';
const integer = v => Number.isSafeInteger(v) && v >= 0;
const strings = v => Array.isArray(v) && v.every(string);
const labels = v => strings(v) || (isMap(v) && Object.values(v).every(x => x === null || ['string','number','boolean'].includes(typeof x)));

// A bounded set of shapes for fields whose semantics affect these checks.
// Unknown keys/types fail explicitly. This is not the full Compose schema.
function shape(value, fields) {
  if (!isMap(value)) return false;
  return Object.entries(value).every(([key,item]) => key.startsWith('x-') ||
    (own(fields,key) && (dynamic(item) || fields[key](item))));
}

function mountOptionsError(value) {
  if (!isMap(value)) return null;
  for (const key of ['bind','volume','tmpfs']) {
    if (!own(value,key)) continue;
    if (value.type !== key) return 'Mount option block does not match the declared mount type.';
    const fields = key === 'bind' ? {
      propagation: v => ['private','rprivate','shared','rshared','slave','rslave'].includes(v),
      create_host_path: boolean, selinux: v => ['z','Z'].includes(v)
    } : key === 'volume' ? {nocopy:boolean,subpath:nonempty} : {
      size:v => integer(v) || nonempty(v), mode:v => integer(v) && v <= 0o7777
    };
    if (!shape(value[key],fields)) return 'Mount option block has an unsupported key or invalid value type; its semantics were not resolved.';
  }
  if (own(value,'consistency') && !['consistent','cached','delegated'].includes(value.consistency)) {
    return 'Mount consistency is outside the supported values.';
  }
  if (value.type === 'tmpfs' && own(value,'source')) return 'tmpfs mounts do not have a host or volume source.';
  return null;
}

function resourceChecks(data, gap) {
  const used = new Set();
  const note = (service,keys,message,evidence) => gap(service,keys,message,
    'Review the identified configuration separately or supply a supported literal configuration; do not treat this limitation as a finding of exploitability.', evidence);
  for (const type of ['networks','volumes','configs','secrets']) {
    if (!own(data,type)) continue;
    if (!isMap(data[type])) { note(null,[type],`${type} must be a mapping.`,{field:type}); continue; }
    for (const [name,definition] of Object.entries(data[type])) {
      const keys = [type,name];
      if (['networks','volumes'].includes(type)) {
        if (definition === null) continue;
        const fields = {name:nonempty,driver:nonempty,driver_opts:isMap,external:boolean,labels};
        if (type === 'networks') Object.assign(fields,{internal:boolean,attachable:boolean,enable_ipv4:boolean,enable_ipv6:boolean,ipam:isMap});
        if (!shape(definition,fields)) {
          note(null,keys,`A ${type} definition contains unsupported keys or invalid value types.`,{field:type});
        }
        if (isMap(definition) && (definition.external || own(definition,'driver_opts') || own(definition,'ipam') ||
          (definition.driver && definition.driver !== (type === 'volumes' ? 'local' : 'bridge')))) {
          note(null,keys,'External resources, custom drivers, IPAM or driver options are not resolved.',{field:type});
        }
      } else {
        const fields = {name:nonempty,file:nonempty,environment:nonempty,external:boolean};
        if (type === 'configs') fields.content = string;
        if (!shape(definition,fields)) {
          note(null,keys,`A ${type} definition contains unsupported keys or invalid value types.`,{field:type});
          continue;
        }
        const sources = ['file','environment','content'].filter(k => own(definition,k));
        if ((definition.external === true && sources.length) || (definition.external !== true && sources.length !== 1)) {
          note(null,keys,'A resource must specify exactly one supported source, or external: true without a source.',{field:type});
        }
      }
    }
  }

  function service(name,config) {
    if (own(config,'networks') && !dynamic(config.networks)) {
      const fields = {aliases:strings,interface_name:nonempty,ipv4_address:nonempty,ipv6_address:nonempty,
        link_local_ips:strings,mac_address:nonempty,priority:integer,gw_priority:integer,driver_opts:isMap};
      if (!strings(config.networks) && !isMap(config.networks)) {
        note(name,['networks'],'Service networks must be a list of names or a mapping of attachments.',{field:'networks'});
      } else if (isMap(config.networks)) {
        for (const [network,attachment] of Object.entries(config.networks)) {
          if (attachment === null) continue;
          if (!shape(attachment,fields) || own(attachment,'driver_opts')) {
            note(name,['networks',network],'Network attachment contains unsupported options or invalid value types; driver options are not resolved.',{field:'networks'});
          }
        }
      }
    }
    for (const type of ['configs','secrets']) {
      if (!own(config,type)) continue;
      if (!Array.isArray(config[type])) { note(name,[type],`${type} grants must be a list.`,{field:type}); continue; }
      config[type].forEach((grant,index) => {
        if (dynamic(grant)) return; // The auditor reports the unresolved item.
        const keys = [type,index];
        const fields = {source:nonempty,target:nonempty,uid:string,gid:string,mode:v => integer(v) && v <= 0o7777};
        if (!(nonempty(grant) || (shape(grant,fields) && own(grant,'source')))) {
          note(name,keys,'Resource grant has unsupported keys, an invalid type, or no source.',{field:type}); return;
        }
        const ref = string(grant) ? grant : grant.source;
        used.add(`${type}/${ref}`);
        const definition = isMap(data[type]) && own(data[type],ref) ? data[type][ref] : null;
        if (!isMap(definition)) {
          note(name,keys,'Resource grant has no supported declaration in this file.',{field:type,sourceKind:'unknown'}); return;
        }
        const sourceKind = own(definition,'file') ? 'file' : definition.external ? 'external' :
          own(definition,'environment') ? 'environment' : own(definition,'content') ? 'inline' : 'unknown';
        if (sourceKind === 'inline') return; // Literal inline data grants no host-file access.
        note(name,keys,`This ${type} grant uses an unanalysed ${sourceKind} source. The reference is observed; source contents, permissions and runtime access are unknown. A secret/config grant alone is not a vulnerability.`,
          {kind:'unanalysed-resource-grant',field:type,sourceKind,grantObserved:true,contents:'not-read'});
      });
    }
  }

  function finish() {
    for (const type of ['configs','secrets']) {
      if (!isMap(data[type])) continue;
      for (const [name,definition] of Object.entries(data[type])) {
        if (!isMap(definition) || !own(definition,'file') || used.has(`${type}/${name}`)) continue;
        note(null,[type,name],'An unanalysed file-backed resource is declared without a resolved service grant. No mount or vulnerability is inferred; its contents were not read.',
          {kind:'unanalysed-resource-definition',field:type,sourceKind:'file',grantObserved:false,contents:'not-read'});
      }
    }
  }
  return {service,finish};
}

module.exports = { mountOptionsError, resourceChecks };
