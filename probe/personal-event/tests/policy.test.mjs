// Pure simulated inspection fixtures: never container observations.
// Removing each safety check, digest check or complete-output check must fail these tests.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const api = await import('../check-isolation.mjs');
const profile=()=>({Config:{Hostname:'d0-offline',User:'10001:10001',Env:['PATH=/usr/local/bin:/usr/bin:/bin','HOME=/tmp','LANG=C.UTF-8','HOSTNAME=d0-offline','NODE_ENV=test','WORKERD_BINARY_PATH=/probe/tooling/node_modules/@cloudflare/workerd-linux-64/bin/workerd','NODE_VERSION','YARN_VERSION'],Entrypoint:['node','/probe/entry.mjs'],Cmd:[],WorkingDir:'/probe',Tty:false,OpenStdin:false},HostConfig:{NetworkMode:'none',ReadonlyRootfs:true,Privileged:false,CapDrop:['ALL'],CapAdd:null,SecurityOpt:['no-new-privileges'],Binds:null,Devices:[],DeviceRequests:null,ExtraHosts:null,PidMode:'',IpcMode:'private',CgroupnsMode:'private',UsernsMode:'',PortBindings:{},PublishAllPorts:false,Memory:2147483648,MemorySwap:2147483648,NanoCpus:2000000000,PidsLimit:256,Tmpfs:{'/tmp':'rw,noexec,nosuid,nodev,size=67108864,mode=1777','/run':'rw,noexec,nosuid,nodev,size=16777216,mode=755'}},Mounts:[{Type:'bind',Source:'/owned/control.json',Destination:'/control.json',RW:false}],NetworkSettings:{Networks:{none:{IPAddress:'',GlobalIPv6Address:'',Gateway:''}},Ports:{} }});
// Matches the observed Docker unset metadata shape; this fixture is still simulated.
test('accepts exact reviewed offline profile including two bare unset markers',()=>assert.equal(api.validateInspection(profile(),'/owned/control.json'),true));
test('rejects unknown, assigned, duplicated or missing inspection environment entries',()=>{
 // Dropping all bare entries, deduplicating, or comparing only names would break these controls.
 for(const [name,mutate] of [
  ['unknown bare name',e=>e.push('AWS_SESSION_TOKEN')],
  ['bare preload name',e=>e.push('NODE_OPTIONS')],
  ['assigned node marker',e=>e[e.indexOf('NODE_VERSION')]='NODE_VERSION=24.20.0'],
  ['empty node assignment',e=>e[e.indexOf('NODE_VERSION')]='NODE_VERSION='],
  ['assigned yarn marker',e=>e[e.indexOf('YARN_VERSION')]='YARN_VERSION=1.22.22'],
  ['empty yarn assignment',e=>e[e.indexOf('YARN_VERSION')]='YARN_VERSION='],
  ['duplicate unset marker',e=>e.push('NODE_VERSION')],
  ['duplicate assignment',e=>e.push('HOME=/tmp')],
  ['missing node marker',e=>e.splice(e.indexOf('NODE_VERSION'),1)],
  ['missing yarn marker',e=>e.splice(e.indexOf('YARN_VERSION'),1)],
  ['missing assignment',e=>e.splice(e.indexOf('HOME=/tmp'),1)],
  ['wrong assignment value',e=>e[e.indexOf('HOME=/tmp')]='HOME=/root']
 ]) {const x=profile();mutate(x.Config.Env);assert.throws(()=>api.validateInspection(x,'/owned/control.json'),name);}
});
test('effective process environment remains exactly six assignments with no unset markers',()=>{
 const effective=()=>({PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',LANG:'C.UTF-8',HOSTNAME:'d0-offline',NODE_ENV:'test',WORKERD_BINARY_PATH:'/probe/tooling/node_modules/@cloudflare/workerd-linux-64/bin/workerd'});
 assert.equal(api.validateProcessEnvironment(effective()),true);
 for(const [name,mutate] of [
  ['empty node variable',e=>e.NODE_VERSION=''],['assigned node variable',e=>e.NODE_VERSION='24.20.0'],
  ['empty yarn variable',e=>e.YARN_VERSION=''],['assigned yarn variable',e=>e.YARN_VERSION='1.22.22'],
  ['unknown variable',e=>e.AWS_SESSION_TOKEN='synthetic'],['preload variable',e=>e.NODE_OPTIONS='--import=evil'],
  ['missing variable',e=>delete e.HOME],['wrong value',e=>e.HOME='/root']
 ]) {const x=effective();mutate(x);assert.throws(()=>api.validateProcessEnvironment(x),name);}
});
for(const [name,mutate] of [
 ['host network',x=>x.HostConfig.NetworkMode='host'],['bridge network',x=>x.HostConfig.NetworkMode='bridge'],
 ['writable root',x=>x.HostConfig.ReadonlyRootfs=false],['root UID',x=>x.Config.User='0:0'],
 ['privilege',x=>x.HostConfig.Privileged=true],['capability',x=>x.HostConfig.CapAdd=['NET_ADMIN']],
 ['device',x=>x.HostConfig.Devices=[{PathOnHost:'/dev/kvm'}]],['host PID',x=>x.HostConfig.PidMode='host'],
 ['host mount',x=>x.Mounts.push({Type:'bind',Source:'/var/run/docker.sock',Destination:'/socket',RW:false})],
 ['write input',x=>x.Mounts[0].RW=true],['credential env',x=>x.Config.Env.push('AWS_ACCESS_KEY_ID=synthetic')],
 ['preload',x=>x.Config.Env.push('NODE_OPTIONS=--import=evil')],['extra address',x=>x.NetworkSettings.Networks.none.IPAddress='172.17.0.2'],
 ['missing cpu bound',x=>x.HostConfig.NanoCpus=0],['unbounded tmpfs',x=>x.HostConfig.Tmpfs['/tmp']='rw'],
 ['interactive stdin',x=>x.Config.OpenStdin=true]
]) test(`rejects ${name}`,()=>{const x=profile();mutate(x);assert.throws(()=>api.validateInspection(x,'/owned/control.json'));});
test('payload digests accept bytes, reject unknown or changed payload',()=>{
 const sealed={'a.txt':'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'};
 assert.equal(api.validatePayload({'a.txt':Buffer.from('abc')},sealed),true);
 assert.throws(()=>api.validatePayload({'a.txt':Buffer.from('abd')},sealed));
 assert.throws(()=>api.validatePayload({'a.txt':Buffer.from('abc'),'other':Buffer.from('abc')},sealed));
});
const terminal=()=>({schema:1,complete:true,status:'PASS',cleanup:{disposed:true,ownedChildrenRemaining:[]},ledger:[{url:'https://fixture.invalid/v1/event',method:'GET'}],expectedLedger:[{url:'https://fixture.invalid/v1/event',method:'GET'}],violations:[]});
test('accepts complete terminal and rejects truncation, missing cleanup, or unexpected fetch',()=>{
 const x=terminal();assert.equal(api.validateTerminal(JSON.stringify(x)),true);
 assert.throws(()=>api.validateTerminal(JSON.stringify(x).slice(0,-1)));
 for(const mutate of [x=>x.complete=false,x=>delete x.cleanup,x=>x.ledger.push({url:'https://other.invalid/',method:'GET'}),x=>x.violations.push('caught denial'),x=>x.cleanup.ownedChildrenRemaining.push(42)]) {const y=terminal();mutate(y);assert.throws(()=>api.validateTerminal(JSON.stringify(y)));}
});
test('collector accepts regular owned file and rejects symlink even to allowed content',()=>{
 const d=mkdtempSync(join(tmpdir(),'d0-pure-'));
 try {writeFileSync(join(d,'result.json'),'{}');symlinkSync('result.json',join(d,'link.json'));
 assert.equal(api.validateCollectedFile(d,'result.json',64),true);
 assert.throws(()=>api.validateCollectedFile(d,'link.json',64));
 assert.throws(()=>api.validateCollectedFile(d,'../escape.json',64));
 assert.throws(()=>api.validateCollectedFile(d,'result.json',1));} finally {rmSync(d,{recursive:true,force:true});}
});

// Recorded run 41163540272 cache pathname, replayed as data only; no native import.
// These controls reject the obsolete guard and permissive basename/version/root matching.
const observedSharpPath='/probe/tooling/node_modules/miniflare/node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64-0.35.5.node';
test('native cache policy accepts the exact pinned Sharp path observed in the failed case',()=>{
 assert.equal(typeof api.validateSharpNativePaths,'function');
 assert.equal(api.validateSharpNativePaths([observedSharpPath]),true);
});
test('native cache policy rejects wrong identity, location and non-singleton caches',()=>{
 assert.equal(typeof api.validateSharpNativePaths,'function');
 for(const [name,paths] of [
  ['unversioned binding',[observedSharpPath.replace('-0.35.5.node','.node')]],
  ['wrong version',[observedSharpPath.replace('0.35.5','0.35.4')]],
  ['musl binding',[observedSharpPath.replaceAll('sharp-linux-x64','sharp-linuxmusl-x64')]],
  ['wrong architecture',[observedSharpPath.replaceAll('linux-x64','linux-arm64')]],
  ['wrong OS',[observedSharpPath.replaceAll('linux-x64','darwin-x64')]],
  ['hoisted package',[observedSharpPath.replace('miniflare/node_modules/','')]],
  ['foreign root',[observedSharpPath.replace('/probe/tooling/','/other/tooling/')]],
  ['extra directory',[observedSharpPath.replace('/lib/','/lib/extra/')]],
  ['traversal spelling',[observedSharpPath.replace('/lib/','/lib/../lib/')]],
  ['basename only',['sharp-linux-x64-0.35.5.node']],
  ['missing addon',[]],['duplicate addon',[observedSharpPath,observedSharpPath]],
  ['additional addon',[observedSharpPath,'/probe/tooling/node_modules/other/addon.node']]
 ])assert.throws(()=>api.validateSharpNativePaths(paths),{name:'AssertionError'},name);
});
test('sealed dependency manifest sharp identity agrees with the enforced native cache policy',()=>{
 const manifest=JSON.parse(readFileSync(new URL('../dependency-manifest.json',import.meta.url),'utf8'));
 assert.equal(manifest.allowedLoadedNativePaths.sharp,observedSharpPath);
 assert.equal(typeof api.validateSharpNativePaths,'function');
 assert.equal(api.validateSharpNativePaths([manifest.allowedLoadedNativePaths.sharp]),true);
});
