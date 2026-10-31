// Hosted offline only. Imports are anchored to tooling/package.json, not this sibling.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,readlinkSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {request as httpRequest} from 'node:http';
import {execFileSync} from 'node:child_process';
import {validateSharpNativePaths} from './check-isolation.mjs';
const require=createRequire('/probe/tooling/package.json'),sharpRequire=createRequire('/probe/tooling/node_modules/miniflare/package.json');
const name=process.argv[2],delay=ms=>new Promise(ok=>setTimeout(ok,ms));
const known={url:'https://fixture.invalid/v1/event',method:'GET'};
const x={schema:1,name,complete:false,status:'FAIL',detected:false,ledger:[],expectedLedger:[],violations:[],cleanup:{disposed:false,ownedChildrenRemaining:[]}};
let mf,ready,owned=[];
function children(){return readFileSync('/proc/self/task/'+process.pid+'/children','utf8').trim().split(/\s+/).filter(Boolean).map(Number)}
function sealed(path){const f=JSON.parse(readFileSync('/probe/frozen-tree.json','utf8')),rel=path.slice('/probe/tooling/'.length);assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),f[rel]?.sha256);return {path,sha256:f[rel].sha256};}
try {
 const {Miniflare,convertV4MiniflareOptions}=await import(pathToFileURL(require.resolve('miniflare')).href);
 assert.equal(typeof convertV4MiniflareOptions,'function');assert.equal(JSON.parse(readFileSync('/probe/tooling/node_modules/miniflare/package.json')).version,'5.20261023.1-beta');
 const workerd=process.env.WORKERD_BINARY_PATH;assert.equal(workerd,'/probe/tooling/node_modules/@cloudflare/workerd-linux-64/bin/workerd');assert(execFileSync(workerd,['--version'],{encoding:'utf8'}).includes('2026-10-23'));
 const sharp=sharpRequire('sharp');assert.equal(sharp.versions.sharp,'0.35.5');const png=await sharp(Buffer.from([0,0,0,255]),{raw:{width:1,height:1,channels:4}}).png().toBuffer();assert.equal((await sharp(png).metadata()).width,1);
 const native=Object.keys(sharpRequire.cache).filter(p=>p.endsWith('.node'));validateSharpNativePaths(native);
 const libraryPaths=[...new Set(readFileSync('/proc/self/maps','utf8').split('\n').map(l=>l.split(/\s+/).at(-1)).filter(p=>p?.startsWith('/probe/tooling/')&&p.includes('.so')))];
 assert(libraryPaths.some(p=>p.startsWith('/probe/tooling/node_modules/miniflare/node_modules/@img/sharp-libvips-linux-x64/lib/libvips')));
 for(const p of libraryPaths)assert(p.startsWith('/probe/tooling/node_modules/miniflare/node_modules/@img/sharp-libvips-linux-x64/lib/'),'unexpected loaded tooling shared library');
 x.native=[sealed(workerd),...native.map(sealed),...libraryPaths.map(sealed)];
 const script=`export default {async fetch(request){
 const path=new URL(request.url).pathname;
 if(path==='/stream'||path==='/pending'){
  let timer;return new Response(new ReadableStream({start(c){timer=setTimeout(()=>c.enqueue(new TextEncoder().encode('first-chunk')),path==='/pending'?300:0)},async cancel(){clearTimeout(timer);await fetch('https://fixture.invalid/cancelled',{method:'POST'})}}));
 }
 const target=path==='/unknown-host'?'https://other.invalid/v1/event':path==='/unknown-path'?'https://fixture.invalid/other':path==='/redirect'?'https://fixture.invalid/redirect':'https://fixture.invalid/v1/event';
 try {return await fetch(target,{method:path==='/unknown-verb'?'POST':'GET',redirect:'manual'})}catch(e){return new Response('caught denial',{status:502})}
 }};`;
 const outboundService=async request=>{
  const call={url:request.url,method:request.method};x.ledger.push(call);
  if(call.url===known.url&&call.method==='GET')return new Response('synthetic-event',{status:201});
  if(call.url==='https://fixture.invalid/redirect'&&call.method==='GET')return new Response(null,{status:302,headers:{location:'https://never-fetch.invalid/escape'}});
  if(call.url==='https://fixture.invalid/cancelled'&&call.method==='POST')return new Response('cancelled');
  x.violations.push(call);throw Error('UNEXPECTED_FETCH_LATCHED');
 };
 mf=new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,workers:[{name:'synthetic',modules:true,script,compatibilityDate:'2026-10-23',compatibilityFlags:['nodejs_compat'],outboundService}]}));
 ready=await mf.ready;owned=children();assert(owned.length>0,'no genuine workerd child');
 for(const p of owned)assert.equal(readlinkSync('/proc/'+p+'/exe'),workerd,'unexpected child executable');x.workerdChildren=owned.map(p=>({pid:p,executable:workerd}));
 if(name.startsWith('unknown-')){
  const response=await mf.dispatchFetch('http://worker.invalid/'+name);assert.equal(response.status,502);assert.equal(await response.text(),'caught denial');assert.equal(x.violations.length,1);assert.equal(x.ledger.length,1);const expected={url:name==='unknown-host'?'https://other.invalid/v1/event':name==='unknown-path'?'https://fixture.invalid/other':known.url,method:name==='unknown-verb'?'POST':'GET'};assert.deepEqual(x.ledger,[expected]);assert.deepEqual(x.violations,[expected]);x.detected=true;x.status='EXPECTED_FAILURE';
 }else if(name==='known'||name==='wrong-result'){
  const response=await mf.dispatchFetch('http://worker.invalid/known');x.expectedLedger=[known];assert.equal(await response.text(),'synthetic-event');
  if(name==='wrong-result'){assert.equal(response.status,201);try{assert.equal(response.status,200)}catch{ x.detected=true;x.status='EXPECTED_FAILURE'; }assert(x.detected);}else{assert.equal(response.status,201);x.status='PASS';}
 }else if(name==='redirect'){
  const response=await mf.dispatchFetch('http://worker.invalid/redirect');assert.equal(response.status,302);assert.equal(response.headers.get('location'),'https://never-fetch.invalid/escape');assert.equal(await response.text(),'');x.expectedLedger=[{url:'https://fixture.invalid/redirect',method:'GET'}];x.status='PASS';
 }else if(name==='dispatch-cancel'){
  const controller=new AbortController();const response=await mf.dispatchFetch('http://worker.invalid/stream',{signal:controller.signal});const reader=response.body.getReader();assert.equal(new TextDecoder().decode((await reader.read()).value),'first-chunk');controller.abort();await delay(150);
  x.dispatchSignalPropagation=x.ledger.some(c=>c.url==='https://fixture.invalid/cancelled')?'OBSERVED':'NOT_OBSERVED';
  // Explicitly cancel the real returned response reader to release this seam.
  await reader.cancel();await delay(150);x.expectedLedger=x.ledger.length?[{url:'https://fixture.invalid/cancelled',method:'POST'}]:[];x.status='PASS';
 }else if(name==='transport-pending'||name==='transport-first'){
  const path=name==='transport-pending'?'/pending':'/stream';let first=false;
  await new Promise((ok,no)=>{
   const req=httpRequest(new URL(path,ready),response=>{response.on('data',chunk=>{assert.equal(chunk.toString(),'first-chunk');first=true;req.destroy();});response.on('error',()=>{});});
   req.on('error',e=>{if(e.code==='ECONNRESET')ok();else no(e)});req.on('close',ok);req.end();
   if(name==='transport-pending')setTimeout(()=>req.destroy(),50);req.setTimeout(2000,()=>req.destroy(Error('transport watchdog')));
  });assert.equal(first,name==='transport-first');
  for(let i=0;i<20&&!x.ledger.length;i++)await delay(50);
  x.expectedLedger=[{url:'https://fixture.invalid/cancelled',method:'POST'}];assert.deepEqual(x.ledger,x.expectedLedger,'real loopback transport did not propagate cancellation');x.transportCancellation='OBSERVED';x.status='PASS';
 }else throw Error('unknown case');
 if(x.status==='PASS'){assert.deepEqual(x.ledger,x.expectedLedger);assert.deepEqual(x.violations,[]);}
}catch(e){x.status='FAIL';x.error=String(e.stack||e)}
finally{
 try{
  if(mf)await mf.dispose();
  for(let i=0;i<30&&owned.some(p=>existsSync('/proc/'+p));i++)await delay(50);
  x.cleanup.ownedChildrenRemaining=[...new Set([...owned.filter(p=>existsSync('/proc/'+p)),...children()])];assert.deepEqual(x.cleanup.ownedChildrenRemaining,[]);
  if(ready)await new Promise((ok,no)=>{const req=httpRequest(ready,()=>no(Error('runtime listener remains after disposal')));req.on('error',e=>e.code==='ECONNREFUSED'?ok():no(e));req.setTimeout(500,()=>req.destroy(Error('disposal listener timeout')));req.end()});
  x.cleanup.disposed=true;
 }catch(e){x.status='FAIL';x.cleanup.error=String(e.stack||e)}
 x.complete=true;console.log('D0_CASE '+JSON.stringify(x));process.exitCode=x.status==='PASS'?0:x.status==='EXPECTED_FAILURE'?2:1;
}
