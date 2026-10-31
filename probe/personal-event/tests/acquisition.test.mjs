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
