// Pure child-output fixtures, never Miniflare or Docker observations.
import {test} from 'node:test';import assert from 'node:assert/strict';
import * as api from '../case-evidence.mjs';
const terminal=()=>({name:'known',status:'PASS',complete:true,ledger:[],expectedLedger:[],violations:[],cleanup:{disposed:true,ownedChildrenRemaining:[]}});
const output=x=>'D0_CASE '+JSON.stringify(x)+'\n';
test('retains failed native and disposal diagnostics before acceptance fails',()=>{
 for(const change of [x=>{x.status='FAIL';x.error='synthetic native error'},x=>{x.cleanup.disposed=false;x.cleanup.error='synthetic disposal error'}]){const x=terminal();change(x);const record=api.retainCase('known',1,output(x),'synthetic stderr',false);assert.deepEqual(record.terminal,x);assert(record.stderr.includes('synthetic stderr'));assert.throws(()=>api.acceptCase(record));}
});
test('retains malformed partial terminal and watchdog evidence without accepting it',()=>{
 const r=api.retainCase('known',null,'D0_CASE {truncated','stderr',true);assert.equal(r.terminal,null);assert(r.stdoutDiagnostic.includes('{truncated'));assert(r.parseError);assert.equal(r.killed,true);assert.throws(()=>api.acceptCase(r));
});
test('accepts genuine-shaped complete positive and rejects mismatched exit or ledger',()=>{
 const x=terminal();assert.equal(api.acceptCase(api.retainCase('known',0,output(x),'',false)),true);
 for(const [code,t] of [[1,x],[0,{...x,ledger:[{url:'https://other.invalid/'}]}]])assert.throws(()=>api.acceptCase(api.retainCase('known',code,output(t),'',false)));
});

test('entry orchestration appends the actual failed record before acceptance throws',()=>{
 const cases=[],x={...terminal(),status:'FAIL',error:'synthetic native load failure',cleanup:{disposed:false,error:'synthetic disposal failure',ownedChildrenRemaining:[42]}};
 assert.throws(()=>api.recordAndAccept(cases,'known',1,output(x),'stderr',false));assert.equal(cases.length,1);assert.equal(cases[0].terminal.error,'synthetic native load failure');assert.equal(cases[0].terminal.cleanup.error,'synthetic disposal failure');
});
