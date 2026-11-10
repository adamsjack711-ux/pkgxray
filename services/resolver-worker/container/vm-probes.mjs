import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dgram from 'node:dgram';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = '/home/pkgxray';
const DNS_LOG = '/work/traces/dns.jsonl';
const decoys = [
  ['.npmrc', 'credential-access', t => `//registry.npmjs.org/:_authToken=npm_${t}\n`],
  ['.git-credentials', 'credential-access', t => `https://fixture:ghp_${t}@github.com\n`],
  ['.config/gh/hosts.yml', 'credential-access', t => `github.com:\n  oauth_token: ghp_${t}\n`],
  ['.aws/credentials', 'credential-access', t => `[default]\naws_access_key_id=AKIA${t.slice(0,16).toUpperCase()}\naws_secret_access_key=${t}\n`],
  ['.config/gcloud/application_default_credentials.json', 'credential-access', t => JSON.stringify({type:'authorized_user',refresh_token:t})],
  ['.azure/accessTokens.json', 'credential-access', t => JSON.stringify([{accessToken:t}])],
  ['.ssh/id_rsa', 'credential-access', t => `-----BEGIN OPENSSH PRIVATE KEY-----\n${t}\n-----END OPENSSH PRIVATE KEY-----\n`],
  ['.ssh/id_ed25519', 'credential-access', t => `-----BEGIN OPENSSH PRIVATE KEY-----\n${t}\n-----END OPENSSH PRIVATE KEY-----\n`],
  ['.env', 'credential-access', t => `OPENAI_API_KEY=sk-fixture-${t}\nANTHROPIC_API_KEY=sk-ant-fixture-${t}\nGITHUB_TOKEN=ghp_${t}\nNPM_TOKEN=npm_${t}\n`],
  ...['.claude.json','.claude/settings.json','.cursor/mcp.json','.continue/config.json','.windsurf/mcp.json','.config/claude/mcp.json']
    .map(name => [name,'mcp-config-poisoning',() => JSON.stringify({mcpServers:{},fixture:true})]),
  ['.bashrc','persistence',()=>'# disposable shell configuration\n'],
  ['.ssh/authorized_keys','persistence',()=>'# disposable SSH configuration\n'],
  ['.config/systemd/user/pkgxray-fixture.service','persistence',()=>'[Unit]\nDescription=Inert decoy\n'],
  ['project/.github/workflows/ci.yml','ci-tampering',()=> 'name: fixture\non: workflow_dispatch\njobs: {}\n'],
  ['project/.git/hooks/pre-commit','persistence',()=> '#!/bin/sh\nexit 0\n'],
  ['project/package.json','package-tampering',()=>JSON.stringify({name:'inert-fixture',version:'1.0.0',private:true})],
  ['project/package-lock.json','package-tampering',()=>JSON.stringify({name:'inert-fixture',lockfileVersion:3,packages:{}})],
  ['Documents/invoice.txt','destructive-file-operation',()=> 'Disposable personal file.\n'],
  ['.config/browser/Login Data','credential-access',t=>`FAKE_BROWSER_DATABASE:${t}\n`],
  ['.config/wallet/keys.json','credential-access',t=>JSON.stringify({fake:true,key:t})]
];

const digest = data => crypto.createHash('sha256').update(data).digest('hex');
export function seedVmCanaries() {
  return decoys.map(([relative,category,render]) => {
    const absolute=path.join(HOME,relative);
    const content=render(crypto.randomBytes(24).toString('hex'));
    fs.mkdirSync(path.dirname(absolute),{recursive:true,mode:0o700});
    fs.writeFileSync(absolute,content,{mode:0o600});
    return {relative,absolute,category,sha256:digest(content)};
  });
}

export function vmEnvironment(profile) {
  const token=crypto.randomBytes(24).toString('hex');
  return {
    ...(profile==='ci'?{CI:'true',GITHUB_ACTIONS:'true',GITHUB_WORKSPACE:`${HOME}/project`,GITHUB_REPOSITORY:'fixture/inert'}:{}),
    NPM_TOKEN:`npm_${token}`,GITHUB_TOKEN:`ghp_${token}`,OPENAI_API_KEY:`sk-fixture-${token}`,
    AWS_ACCESS_KEY_ID:`AKIA${token.slice(0,16).toUpperCase()}`,AWS_SECRET_ACCESS_KEY:token
  };
}

function snapshotChanged(canary) {
  let fd;
  try {
    fd=fs.openSync(canary.absolute,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.size>65536||stat.nlink!==1) return true;
    const data=Buffer.alloc(stat.size);
    return fs.readSync(fd,data,0,data.length,0)!==data.length || digest(data)!==canary.sha256;
  } catch { return true; }
  finally { if(fd!==undefined)fs.closeSync(fd); }
}

export function analyzeVmTrace(trace,canaries) {
  const findings=[];
  const processes=new Set(),network=new Set();
  const lines=trace.text.split('\n');
  for(const canary of canaries) {
    const accessed=lines.some(line => /\bopen(?:at|at2)?\(/.test(line) && line.includes(canary.absolute) &&
      /O_(?:RDONLY|RDWR)/.test(line) && !/ = -1 /.test(line));
    if(accessed && canary.category==='credential-access') findings.push({severity:'high',category:'credential-access',
      target:canary.relative,evidence:'A process opened a synthetic credential for reading; contents were not taken from the host.'});
    const writeAttempt=lines.some(line=>line.includes(canary.absolute)&&
      (/\b(?:unlink|unlinkat|rename|renameat|renameat2|truncate)\(/.test(line) || /\bopen(?:at|at2)?\(/.test(line)&&/O_(?:WRONLY|RDWR|TRUNC)/.test(line))&&!/ = -1 /.test(line));
    if(snapshotChanged(canary)||writeAttempt) findings.push({severity:'high',category:canary.category==='credential-access'?'credential-tampering':canary.category,
      target:canary.relative,evidence:'A seeded honeypot was modified, removed or replaced.'});
  }
  for(const line of lines) {
    const executable=line.match(/execve\("([^"\n]{1,512})"/)?.[1];
    if(executable && processes.size<128) processes.add(executable);
    if(/(?:connect|sendto|sendmsg)\(/.test(line)&&/AF_INET6?/.test(line)&&network.size<128) {
      const ip=line.match(/inet_addr\("([^"\n]+)"\)/)?.[1] || line.match(/inet_pton\(AF_INET6, "([^"\n]+)"/)?.[1];
      const port=line.match(/sin6?_port=htons\((\d+)\)/)?.[1];
      if(ip) network.add(`${ip}:${port||'unknown'}`);
    }
    if(/(?:connect|openat|open)\(/.test(line)&&/(?:docker\.sock|containerd\.sock|\/dev\/kvm|\/dev\/vdb)/.test(line)) {
      if(!findings.some(f=>f.category==='host-boundary-probe')) findings.push({severity:'medium',category:'host-boundary-probe',
        evidence:'A process attempted access to a VM input device or container/hypervisor control endpoint.'});
    }
  }
  const domains=[];let dnsComplete=false,dnsTruncated=false;
  try {
    for(const line of fs.readFileSync(DNS_LOG,'utf8').split('\n').filter(Boolean)) {
      const record=JSON.parse(line),name=record.name;
      if(record.monitorStopped===true){dnsComplete=true;dnsTruncated=record.queries>128;}
      if(typeof name==='string'&&!domains.includes(name)&&domains.length<128) domains.push(name);
    }
  } catch { /* Missing or corrupt telemetry is explicitly incomplete below. */ }
  if(domains.length) findings.push({severity:'medium',category:'dns-attempt',
    evidence:'The isolated DNS honeypot received queries and returned NXDOMAIN without forwarding.',targets:domains});
  if(!dnsComplete||dnsTruncated) findings.push({severity:'medium',category:'behavioral-monitor-unavailable',evidence:'DNS monitoring was incomplete or exceeded its capture limit.'});
  return {findings,dnsComplete:dnsComplete&&!dnsTruncated,telemetry:{processes:[...processes],networkAttempts:[...network],dnsQueries:domains,
    honeypots:canaries.map(c=>({path:c.relative,category:c.category})),
    limits:{processes:128,networkAttempts:128,dnsQueries:128},
    limitations:['No live credentials or external services','No dependency download','No Windows, AD or ICS emulation',
      'Short observation window; delayed, interactive and environment-dependent behavior may not activate',
      'Guest-kernel compromise can falsify in-guest telemetry; this is not attestation']}};
}

export async function startDnsHoneypot() {
  const child=fork(fileURLToPath(import.meta.url),['--dns-server'],{stdio:['ignore','ignore','ignore','ipc'],env:{}});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('DNS honeypot startup timeout'));},3000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('DNS honeypot startup failed'));});
    child.once('message',message=>{clearTimeout(timer);message==='ready'?resolve():reject(new Error('Invalid DNS startup'));});
  });
  return child;
}

if(process.argv[2]==='--dns-server') {
  const socket=dgram.createSocket('udp4');
  fs.writeFileSync(DNS_LOG,'',{mode:0o600});
  let count=0;
  process.once('SIGTERM',()=>{fs.appendFileSync(DNS_LOG,JSON.stringify({monitorStopped:true,queries:count})+'\n');socket.close(()=>process.exit(0));});
  socket.on('message',(packet,remote)=>{
    if(packet.length<17||packet.length>512)return;
    let offset=12;const labels=[];
    while(offset<packet.length) {
      const size=packet[offset++];if(size===0)break;
      if(size>63||offset+size>packet.length)return;
      labels.push(packet.subarray(offset,offset+size).toString('ascii').replace(/[^a-zA-Z0-9_-]/g,'?'));offset+=size;
    }
    if(offset+4>packet.length||labels.join('.').length>253)return;
    if(count++<128)fs.appendFileSync(DNS_LOG,JSON.stringify({name:labels.join('.'),type:packet.readUInt16BE(offset)})+'\n');
    const answer=Buffer.from(packet.subarray(0,offset+4));answer.writeUInt16BE(0x8183,2);
    answer.writeUInt16BE(1,4);answer.fill(0,6,12);socket.send(answer,remote.port,remote.address);
  });
  socket.bind(53,'127.0.0.53',()=>process.send('ready'));
}
