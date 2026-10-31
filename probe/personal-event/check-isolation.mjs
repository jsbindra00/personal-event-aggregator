import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstatSync,realpathSync} from 'node:fs';
import {resolve,sep} from 'node:path';
export const environment = ['PATH=/usr/local/bin:/usr/bin:/bin','HOME=/tmp','LANG=C.UTF-8','HOSTNAME=d0-offline','NODE_ENV=test','WORKERD_BINARY_PATH=/probe/tooling/node_modules/@cloudflare/workerd-linux-64/bin/workerd'];
export const tmpfs = {'/tmp':'rw,noexec,nosuid,nodev,size=67108864,mode=1777','/run':'rw,noexec,nosuid,nodev,size=16777216,mode=755'};
const empty = x => x == null || (Array.isArray(x) ? x.length===0 : Object.keys(x).length===0);
export function validateInspection(x,controlPath) {
 const c=x.Config,h=x.HostConfig,n=x.NetworkSettings;
 assert.equal(c.User,'10001:10001'); assert.deepEqual([...c.Env].sort(),[...environment].sort());
 assert.deepEqual(c.Entrypoint,['node','/probe/entry.mjs']); assert(c.Cmd==null||c.Cmd.length===0);assert.equal(c.Hostname,'d0-offline');assert.equal(c.WorkingDir,'/probe');
 assert.equal(c.Tty,false);assert.equal(c.OpenStdin,false);
 assert.equal(h.NetworkMode,'none');assert.equal(h.ReadonlyRootfs,true);assert.equal(h.Privileged,false);
 assert.deepEqual(h.CapDrop,['ALL']);assert(empty(h.CapAdd));assert.deepEqual(h.SecurityOpt,['no-new-privileges']);
 for(const k of ['Binds','Devices','DeviceRequests','ExtraHosts','PortBindings']) assert(empty(h[k]),k);
 assert.equal(h.PidMode,'');assert.equal(h.IpcMode,'private');assert.equal(h.CgroupnsMode,'private');assert.equal(h.UsernsMode,'');assert.equal(h.PublishAllPorts,false);
 assert.equal(h.Memory,2147483648);assert.equal(h.MemorySwap,2147483648);assert.equal(h.NanoCpus,2000000000);assert.equal(h.PidsLimit,256);assert.deepEqual(h.Tmpfs,tmpfs);
 assert.equal(x.Mounts.length,1);const m=x.Mounts[0];assert.equal(m.Type,'bind');assert.equal(m.Source,controlPath);assert.equal(m.Destination,'/control.json');assert.equal(m.RW,false);
 assert.deepEqual(Object.keys(n.Networks),['none']);for(const k of ['IPAddress','GlobalIPv6Address','Gateway']) assert.equal(n.Networks.none[k],'');assert(empty(n.Ports));
 return true;
}
export function validatePayload(files,hashes) {
 assert.deepEqual(Object.keys(files).sort(),Object.keys(hashes).sort());
 for(const [p,b] of Object.entries(files)) {assert(!p.startsWith('/')&&!p.split('/').includes('..'));assert.equal(createHash('sha256').update(b).digest('hex'),hashes[p],p);}
 return true;
}
export function validateTerminal(raw) {
 assert(Buffer.byteLength(raw)<=65536);const x=JSON.parse(raw);
 assert.equal(x.schema,1);assert.equal(x.complete,true);assert.equal(x.status,'PASS');
 assert.equal(x.cleanup.disposed,true);assert.deepEqual(x.cleanup.ownedChildrenRemaining,[]);
 assert.deepEqual(x.ledger,x.expectedLedger);assert.deepEqual(x.violations,[]);return true;
}
export function validateCollectedFile(root,name,maxBytes) {
 assert(!name.includes('/')&&!name.includes('\\')&&name!=='.'&&name!=='..');
 const path=resolve(root,name),s=lstatSync(path);assert(s.isFile()&&!s.isSymbolicLink());
 assert(realpathSync(path).startsWith(realpathSync(root)+sep));assert(s.size<=maxBytes);return true;
}
