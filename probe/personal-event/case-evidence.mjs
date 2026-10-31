// Standard-library-only child evidence retention and acceptance. Never imports an SDK.
import assert from 'node:assert/strict';
const bounded=(value,bytes)=>Buffer.from(value).subarray(0,bytes).toString('utf8');
export function retainCase(name,exitCode,stdout,stderr,killed) {
 const record={name,exitCode,killed,terminal:null,stderr:bounded(stderr,2048),stderrTruncated:Buffer.byteLength(stderr)>2048};
 try {
  const lines=stdout.trimEnd().split('\n'),terminals=lines.filter(line=>line.startsWith('D0_CASE '));
  assert.equal(terminals.length,1,'missing/duplicate child terminal');assert.equal(lines.at(-1),terminals[0],'nonterminal child evidence');
  record.terminal=JSON.parse(terminals[0].slice(8));assert(record.terminal&&typeof record.terminal==='object'&&!Array.isArray(record.terminal),'malformed child object');
 }catch(e){record.parseError=bounded(String(e),1024);record.stdoutDiagnostic=bounded(stdout,4096);record.stdoutTruncated=Buffer.byteLength(stdout)>4096;}
 return record;
}
export function acceptCase(record) {
 assert.equal(record.killed,false,'child watchdog/output cap');
 const x=record.terminal;assert(x&&!record.parseError,'missing or malformed child terminal');
 assert.equal(x.complete,true);assert.equal(x.name,record.name);assert.equal(x.cleanup.disposed,true);assert.deepEqual(x.cleanup.ownedChildrenRemaining,[]);
 if(['unknown-host','unknown-path','unknown-verb','wrong-result'].includes(record.name)){
  assert.equal(record.exitCode,2);assert.equal(x.status,'EXPECTED_FAILURE');assert.equal(x.detected,true);
 }else{
  assert.equal(record.exitCode,0);assert.equal(x.status,'PASS');assert.deepEqual(x.ledger,x.expectedLedger);assert.deepEqual(x.violations,[]);
 }
 return true;
}

export function recordAndAccept(cases,...args) {
 const record=retainCase(...args);cases.push(record);acceptCase(record);return record.terminal;
}
