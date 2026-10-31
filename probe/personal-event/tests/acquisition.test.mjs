import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateInstalled,validateRegistryLock} from '../acquire.mjs';
test('registry guard accepts pinned integrity and blocks fallback/custom registries',()=>{
 const p={packages:{'':{},'node_modules/a':{version:'1.0.0',resolved:'https://registry.npmjs.org/a/-/a-1.0.0.tgz',integrity:'sha512-'+Buffer.alloc(64).toString('base64')}}};
 assert.equal(validateRegistryLock(p),true);
 for(const change of [x=>x.resolved='https://example.com/a.tgz',x=>x.resolved='http://registry.npmjs.org/a.tgz',x=>delete x.integrity,x=>x.version='latest']) {const x=structuredClone(p);change(x.packages['node_modules/a']);assert.throws(()=>validateRegistryLock(x));}
});

test('inventory preserves required package identity and rejects extra, missing or wrong package',()=>{
 const lock={packages:{'':{},'node_modules/a':{version:'1.0.0'},'node_modules/b':{version:'2.0.0',optional:true}}};
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
