import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateInstalled,validateRegistryLock} from '../acquire.mjs';
test('registry guard accepts pinned integrity and blocks fallback/custom registries',()=>{
 const p={packages:{'':{},'node_modules/a':{version:'1.0.0',resolved:'https://registry.npmjs.org/a/-/a-1.0.0.tgz',integrity:'sha512-'+Buffer.alloc(64).toString('base64')}}};
 assert.equal(validateRegistryLock(p),true);
 for(const change of [x=>x.resolved='https://example.com/a.tgz',x=>x.resolved='http://registry.npmjs.org/a.tgz',x=>delete x.integrity,x=>x.version='latest']) {const x=structuredClone(p);change(x.packages['node_modules/a']);assert.throws(()=>validateRegistryLock(x));}
});

test('inventory preserves required package identity and rejects extra, missing or wrong package',()=>{
 const lock={packages:{'':{dependencies:{a:'1.0.0'},optionalDependencies:{b:'2.0.0'}},'node_modules/a':{version:'1.0.0'},'node_modules/b':{version:'2.0.0',optional:true}}};
 assert.equal(validateInstalled([{path:'node_modules/a',version:'1.0.0'}],lock),true);
 for(const installed of [[],[{path:'node_modules/a',version:'1.0.1'}],[{path:'node_modules/a',version:'1.0.0'},{path:'node_modules/extra',version:'1.0.0'}]])assert.throws(()=>validateInstalled(installed,lock));
});

import * as acquisition from '../acquire.mjs';
import {mkdtempSync,readFileSync,lstatSync,writeFileSync,unlinkSync,symlinkSync,linkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const prepare=acquisition.prepareNpmConfigs;
const verify=acquisition.verifyNpmConfigs;
test('stdlib setup creates distinct owned empty regular npm configs without reusing existing paths',()=>{
 const temp=mkdtempSync(join(tmpdir(),'d0-pure-npm-config-')),root=join(temp,'config');
 try {
  const evidence=prepare(root);
  assert.deepEqual(evidence.map(x=>x.layer),['user','global']);
  assert.deepEqual(evidence.map(x=>x.path),[join(root,'user.npmrc'),join(root,'global.npmrc')]);
  for(const x of evidence){assert.equal(readFileSync(x.path).length,0);assert.equal(x.bytes,0);assert.equal(x.sha256,'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');assert(lstatSync(x.path).isFile());assert.equal(lstatSync(x.path).mode&0o777,0o600);}
  assert.notEqual(lstatSync(evidence[0].path).ino,lstatSync(evidence[1].path).ino);
  assert.deepEqual(verify(root),evidence);assert.throws(()=>prepare(root));
 }finally{rmSync(temp,{recursive:true,force:true});}
});
test('npm config verification rejects nonempty, symlinked and same-inode config layers',()=>{
 for(const kind of ['nonempty','symlink','hardlink']){
  const temp=mkdtempSync(join(tmpdir(),'d0-pure-npm-config-')),root=join(temp,'config');
  try{
   prepare(root);const user=join(root,'user.npmrc'),global=join(root,'global.npmrc');
   if(kind==='nonempty')writeFileSync(user,'synthetic=unsafe');
   if(kind==='symlink'){unlinkSync(global);symlinkSync(user,global);}
   if(kind==='hardlink'){unlinkSync(global);linkSync(user,global);}
   assert.throws(()=>verify(root));
  }finally{rmSync(temp,{recursive:true,force:true});}
 }
});

// Frozen JSON metadata only. This candidate installed-set fixture is consistent with the
// physical npm count/omission, not an invented observation of that run's full package set.
const frozen=JSON.parse(readFileSync(new URL('../tooling/package-lock.json',import.meta.url),'utf8'));
const linuxPaths=[
 'node_modules/@cloudflare/workerd-linux-64',
 'node_modules/@cspotcode/source-map-support',
 'node_modules/@cspotcode/source-map-support/node_modules/@jridgewell/trace-mapping',
 'node_modules/@jridgewell/resolve-uri','node_modules/@jridgewell/sourcemap-codec',
 'node_modules/@poppinss/colors','node_modules/@poppinss/dumper',
 'node_modules/@poppinss/dumper/node_modules/supports-color','node_modules/@poppinss/exception',
 'node_modules/@sindresorhus/is','node_modules/@speed-highlight/core',
 'node_modules/cookie','node_modules/detect-libc','node_modules/error-stack-parser-es','node_modules/kleur',
 'node_modules/miniflare','node_modules/miniflare/node_modules/@img/colour',
 'node_modules/miniflare/node_modules/@img/sharp-libvips-linux-x64',
 'node_modules/miniflare/node_modules/@img/sharp-libvips-linuxmusl-x64',
 'node_modules/miniflare/node_modules/@img/sharp-linux-x64',
 'node_modules/miniflare/node_modules/@img/sharp-linuxmusl-x64',
 'node_modules/miniflare/node_modules/semver','node_modules/miniflare/node_modules/sharp',
 'node_modules/undici','node_modules/workerd','node_modules/ws','node_modules/youch','node_modules/youch-core'
];
const linuxInstalled=()=>linuxPaths.map(path=>({path,version:frozen.packages[path].version}));
test('frozen graph allows tslib omission only when its optional WASM consumers are omitted',()=>{
 assert.equal(linuxPaths.length,28);assert.equal(validateInstalled(linuxInstalled(),frozen),true);
 // Installing a formerly omitted branch makes its ordinary dependencies mandatory,
 // including hoisted tslib despite its inherited global optional flag being absent.
 const branch=['node_modules/@img/sharp-freebsd-wasm32','node_modules/@img/sharp-freebsd-wasm32/node_modules/@img/sharp-wasm32','node_modules/@img/sharp-freebsd-wasm32/node_modules/@img/sharp-wasm32/node_modules/@emnapi/runtime'];
 const present=[...linuxInstalled(),...branch.map(path=>({path,version:frozen.packages[path].version}))];
 assert.throws(()=>validateInstalled(present,frozen),/missing required node_modules\/tslib/);
 assert.equal(validateInstalled([...present,{path:'node_modules/tslib',version:'2.8.1'}],frozen),true);
});
test('genuine root, installed-consumer and nested-path omissions remain fatal in the frozen graph',()=>{
 for(const missing of ['node_modules/miniflare','node_modules/workerd','node_modules/miniflare/node_modules/sharp','node_modules/miniflare/node_modules/semver'])assert.throws(()=>validateInstalled(linuxInstalled().filter(x=>x.path!==missing),frozen),/missing required/);
 const required=structuredClone(frozen);required.packages[''].dependencies={tslib:'2.8.1'};
 assert.throws(()=>validateInstalled(linuxInstalled(),required),/missing required node_modules\/tslib/);
 const wrong=linuxInstalled();wrong.find(x=>x.path==='node_modules/miniflare/node_modules/@img/sharp-linux-x64').version='0.35.4';assert.throws(()=>validateInstalled(wrong,frozen));
 const relocated=linuxInstalled().filter(x=>x.path!=='node_modules/miniflare/node_modules/semver');relocated.push({path:'node_modules/semver',version:'7.8.5'});assert.throws(()=>validateInstalled(relocated,frozen),/non-lock/);
});
test('required install obligations follow dependency kinds, not global optional bits or metadata-only peers',()=>{
 const lock={packages:{'':{devDependencies:{a:'1.0.0'}},'node_modules/a':{version:'1.0.0',dependencies:{b:'1.0.0',optional:'1.0.0'},optionalDependencies:{optional:'1.0.0'},devDependencies:{devOnly:'1.0.0'},peerDependencies:{peer:'1.0.0',optionalPeer:'1.0.0'},peerDependenciesMeta:{optionalPeer:{optional:true},metadataOnly:{optional:true}}},'node_modules/b':{version:'1.0.0',optional:true},'node_modules/peer':{version:'1.0.0'},'node_modules/optional':{version:'1.0.0',optional:true}}};
 const installed=[{path:'node_modules/a',version:'1.0.0'},{path:'node_modules/b',version:'1.0.0'},{path:'node_modules/peer',version:'1.0.0'}];
 assert.equal(validateInstalled(installed,lock),true);
 for(const missing of ['node_modules/b','node_modules/peer'])assert.throws(()=>validateInstalled(installed.filter(x=>x.path!==missing),lock),/missing required/);
 assert.throws(()=>validateInstalled([...installed,{path:'node_modules/optional',version:'1.0.1'}],lock));
});

test('failed validation retains the full public installed and omitted inventory first',()=>{
 const retained=[],installed=linuxInstalled().filter(x=>x.path!=='node_modules/workerd');
 assert.throws(()=>validateInstalled(installed,frozen,record=>retained.push(record)),/missing required/);
 assert.equal(retained.length,1);assert.deepEqual(retained[0].installed,installed);
 assert(retained[0].omittedLocked.includes('node_modules/workerd'));assert(retained[0].omittedLocked.includes('node_modules/tslib'));
});
