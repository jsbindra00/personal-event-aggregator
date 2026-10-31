// Trusted controls run before any candidate package import, in the same offline container.
import assert from 'node:assert/strict';
import {readFileSync,readlinkSync,readdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createServer as httpServer,get as httpGet} from 'node:http';
import {createServer,connect} from 'node:net';
import {createSocket} from 'node:dgram';
import {spawn} from 'node:child_process';
import {treeFiles} from './acquire.mjs';
import {recordAndAccept} from './case-evidence.mjs';
import {environment,validateTerminal,validateInspection,validatePayload} from './check-isolation.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const listen=(s,...args)=>new Promise((ok,no)=>{s.once('error',no);s.listen(...args,ok)});
const close=s=>new Promise((ok,no)=>s.close(e=>e?no(e):ok()));
const hash=b=>createHash('sha256').update(b).digest('hex');
const result={schema:1,complete:false,status:'FAIL',cleanup:{disposed:false,ownedChildrenRemaining:[]},ledger:[],expectedLedger:[],violations:[],cases:[]};
let successful=false;
try {
 assert.equal(process.version,'v24.20.0');assert.equal(process.getuid(),10001);assert.equal(process.getgid(),10001);
 assert.deepEqual(Object.entries(process.env).map(([k,v])=>k+'='+v).sort(),[...environment].sort());
 const descriptors=[];
 for(const n of readdirSync('/proc/self/fd')) {let target;try{target=readlinkSync('/proc/self/fd/'+n)}catch(e){if(e.code==='ENOENT'){descriptors.push({fd:+n,closedDuringEnumeration:true});continue;}throw e;}
  const allowed=target.startsWith('pipe:[')||['anon_inode:[eventpoll]','anon_inode:[eventfd]','anon_inode:[timerfd]','/dev/null'].includes(target);
  descriptors.push({fd:+n,target,classification:allowed?'stdio-or-node-internal':'UNCLASSIFIED'});assert(allowed,'unclassified entry descriptor '+n+':'+target);
 }
 for(const d of descriptors)if(d.fd>2&&d.target?.startsWith('pipe:['))assert.equal(descriptors.filter(other=>other.fd>2&&other.target===d.target).length,2,'unclassified inherited pipe');
 const interfaces=readdirSync('/sys/class/net');assert.deepEqual(interfaces,['lo']);
 const ipv4=readFileSync('/proc/net/route','utf8'),ipv6=readFileSync('/proc/net/ipv6_route','utf8');
 for(const line of ipv4.trim().split('\n').slice(1))if(line.trim())assert.equal(line.split(/\s+/)[0],'lo');
 for(const line of ipv6.trim().split('\n'))if(line.trim())assert.equal(line.trim().split(/\s+/).at(-1),'lo');
 const mounts=readFileSync('/proc/self/mountinfo','utf8');const root=mounts.split('\n').find(l=>l.split(' ')[4]==='/');assert(root&&root.split(' ')[5].split(',').includes('ro'));
 let control;
 for(let i=0;i<100;i++) {try{control=JSON.parse(readFileSync('/control.json','utf8'));if(control.started)break;}catch{}await pause(50);}
 assert.equal(control?.started,true,'started inspection barrier missing');validateInspection(control.inspection,control.controlPath);
 assert.equal(existsSync(control.unixSentinel),false,'outside sentinel path unexpectedly visible');
 const ns={};for(const n of ['net','mnt','pid','user','ipc'])ns[n]=readlinkSync('/proc/self/ns/'+n);
 for(const n of ['net','mnt','pid','ipc'])assert.notEqual(ns[n],control.hostNamespaces[n],'namespace is shared with host: '+n);
 result.entry={descriptors,interfaces,ipv4,ipv6,namespaces:ns,rootMount:root,unixSentinelAbsent:true,mountsSha256:hash(mounts),mountDestinations:mounts.split('\n').filter(Boolean).map(l=>l.split(' ')[4])};
 // Finite externally owned targets only. No metadata/public DNS endpoint.
 const denied=[];
 for(const kind of ['tcp','http']) {
  await new Promise((ok,no)=>{
   const socket=connect({host:control.host,port:control.tcpPort});let reached=false;
   socket.setTimeout(350);socket.once('connect',()=>{reached=true;if(kind==='http')socket.write('GET /'+control.token+' HTTP/1.0\r\n\r\n');socket.destroy();});
   socket.once('timeout',()=>socket.destroy());socket.once('error',()=>{});socket.once('close',()=>{denied.push({kind,reached});reached?no(Error('external canary connected')):ok();});
  });
 }
 await new Promise((ok,no)=>{const s=createSocket('udp4');let received=false;const timer=setTimeout(()=>s.close(),350);s.on('error',()=>s.close());s.on('message',()=>{received=true;s.close()});s.on('close',()=>{clearTimeout(timer);denied.push({kind:'owned-udp-dns',received});received?no(Error('external DNS reply')):ok()});
  // Valid finite DNS query; resolver is the owned host canary, never a public resolver.
  const label=Buffer.from(control.token),query=Buffer.concat([Buffer.from([0x44,0x30,1,0,0,1,0,0,0,0,0,0,label.length]),label,Buffer.from([7]),Buffer.from('invalid'),Buffer.from([0,0,1,0,1])]);s.send(query,control.udpPort,control.host,()=>{});
 });result.externalAttempts=denied;
 // Owned loopback request/reply and Unix request/reply; neither is an external socket control.
 const h=httpServer((q,s)=>s.end('owned-loopback'));
 await listen(h,0,'127.0.0.1');try{const body=await new Promise((ok,no)=>{const req=httpGet('http://127.0.0.1:'+h.address().port,r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>ok(b))});req.on('error',no);req.setTimeout(1000,()=>req.destroy(Error('IPC timeout')))});assert.equal(body,'owned-loopback')}finally{await close(h)}
 const unixPath='/tmp/d0-owned.sock',u=createServer(s=>s.end('owned-unix'));await listen(u,unixPath);
 try{assert.equal(await new Promise((ok,no)=>{const s=connect(unixPath);let b='';s.on('data',x=>b+=x);s.on('end',()=>ok(b));s.on('error',no);s.setTimeout(1000,()=>s.destroy(Error('Unix timeout')))}),'owned-unix')}finally{await close(u)}
 const child=spawn(process.execPath,['-e','process.stdin.pipe(process.stdout)'],{env:process.env,stdio:['pipe','pipe','pipe']});let echoed='';child.stdout.on('data',b=>echoed+=b);child.stdin.end('owned-pipe');assert.equal(await new Promise((ok,no)=>{child.once('error',no);child.once('close',ok)}),0);assert.equal(echoed,'owned-pipe');
 result.internalIPC={loopback:true,unix:true,childPipe:true,ownedListenersClosed:true};
 const seal=JSON.parse(readFileSync('/probe/source-manifest.json','utf8'));
 const hashes=Object.fromEntries(Object.entries(seal.sha256).filter(([p])=>p.startsWith('probe/personal-event/')).map(([p,h])=>[p.slice('probe/personal-event/'.length),h]));
 validatePayload(Object.fromEntries(Object.keys(hashes).map(p=>[p,readFileSync('/probe/'+p)])),hashes);
 const actual=treeFiles('/probe/tooling'),frozen=JSON.parse(readFileSync('/probe/frozen-tree.json','utf8'));assert.deepEqual(actual,frozen,'frozen input mutation');
 result.acquisition=JSON.parse(readFileSync('/probe/acquisition.json','utf8'));
 // Only now may separate bounded children import the candidate Miniflare/native packages.
 for(const name of ['known','unknown-host','unknown-path','unknown-verb','wrong-result','redirect','dispatch-cancel','transport-pending','transport-first']) {
  const c=spawn(process.execPath,['/probe/d0-fixture.mjs',name],{env:process.env,stdio:['ignore','pipe','pipe']});let out='',err='',bytes=0,killed=false;
  const timer=setTimeout(()=>{killed=true;c.kill('SIGKILL')},45000);
  const collect=(key,b)=>{const prefix=b.subarray(0,Math.max(0,32768-bytes));bytes+=b.length;if(key==='out')out+=prefix;else err+=prefix;if(bytes>32768){killed=true;c.kill('SIGKILL')}};c.stdout.on('data',b=>collect('out',b));c.stderr.on('data',b=>collect('err',b));
  const code=await new Promise((ok,no)=>{c.once('error',no);c.once('close',ok)});clearTimeout(timer);
  // This helper retains diagnostics before any acceptance assertion can throw.
  const x=recordAndAccept(result.cases,name,code,out,err,killed);
  if(x.status==='PASS'){result.ledger.push(...x.ledger);result.expectedLedger.push(...x.expectedLedger);}

 }
 result.cleanup={disposed:true,ownedChildrenRemaining:readFileSync('/proc/self/task/'+process.pid+'/children','utf8').trim().split(/\s+/).filter(Boolean)};assert.deepEqual(result.cleanup.ownedChildrenRemaining,[]);
 result.status='PASS';result.complete=true;validateTerminal(JSON.stringify(result));successful=true;
} catch(e) {result.error=String(e.stack||e);result.status='FAIL';result.complete=true;}
const raw=JSON.stringify(result);if(Buffer.byteLength(raw)>65536){console.log('D0_RESULT '+JSON.stringify({schema:1,status:'FAIL',complete:false,error:'terminal cap'}));process.exitCode=1;}else{console.log('D0_RESULT '+raw);process.exitCode=successful?0:1;}
