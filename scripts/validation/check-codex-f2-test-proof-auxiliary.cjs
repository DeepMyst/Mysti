'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const auxiliary=require('./codex-f2-test-proof-auxiliary.cjs'),EXPECTED_ARGS=auxiliary.EXPECTED_ARGS;
const hash=value=>createHash('sha256').update(value).digest('hex'),copy=value=>JSON.parse(JSON.stringify(value));
const root=path.resolve(__dirname,'../../out-test/feature-tests/PB-02'),directory=fs.mkdtempSync(path.join(root,'f2-test-proof-auxiliary-controls-')),checks=[];
const check=(name,fn)=>{try{fn();checks.push({name,status:'PASS'});}catch(error){checks.push({name,status:'FAIL',error:error.stack});}};
function auxiliaryFixture(kinds = ['probe', 'warm', 'quota-failure', 'unvalidated-text', 'killed', 'signal', 'empty']) {
  const birth = 'Sat Oct 10 11:00:00 2026', timestamp = Date.parse(birth), receipts = [], details = [];
  const auxiliary = { provider: 'claude-code', maxInputs: 3, expectedArgs: [...EXPECTED_ARGS], executableIdentity: { path: '/synthetic/claude' } };
  let inputIndex = 0;
  for (const [index, kind] of kinds.entries()) {
    const wrapperPid = 20000 + index * 2, childPid = wrapperPid + 1, at = timestamp + 1000 * (index + 1);
    const base = { window: 'A', provider: 'claude-code', lane: 'text-only-auxiliary', wrapperPid };
    const add = (event, offset, fields = {}) => receipts.push({ ...base, event, at: at + offset, ...fields });
    const probe = kind === 'probe', active = !['probe', 'warm'].includes(kind);
    const number = active ? ++inputIndex : undefined;
    for (const [pid, executableBasename, parentPid] of [[wrapperPid, 'node', 100], [childPid, 'claude', wrapperPid]]) {
      details.push({ pid, parentPid, startedAt: birth, parentStartedAt: birth, executableBasename,
        firstObservedAt: new Date(at).toISOString(), lastObservedAt: new Date(at + 100).toISOString() });
    }
    add(probe ? 'probe-start' : 'auxiliary-start', 0, { childPid, childStartedAt: birth,
      processBirths: [{ pid: wrapperPid, startedAt: birth }, { pid: childPid, startedAt: birth }],
      executable: '/synthetic/claude', args: probe ? ['--version'] : [...EXPECTED_ARGS],
      cwd: probe ? '/owned/workspace' : `/private/tmp/mysti-text-worker-C${index}`,
      isolatedCwd: !probe, environmentForwardedUnchanged: true, safeModeEnvironment: !probe, pwdMatchesCwd: true,
      ...(!probe ? { cwdMode: 0o700, cwdInitiallyEmpty: true } : {}) });
    const input = { inputIndex: number, inputBytes: active ? 32 : 0, inputSha256: hash(active ? 'synthetic prompt' : ''),
      inputEnded: true, purpose: active ? 'title' : 'no-input' };
    if (active) {
      add('auxiliary-input', 1, { inputIndex: number });
      add('auxiliary-input-progress', 2, { ...input, inputEnded: false });
    }
    add('auxiliary-submission', 3, input);
    const text = ['quota-failure', 'unvalidated-text'].includes(kind) ? 'quota limit text is not semantic success' : probe ? 'synthetic version' : '';
    const output = { stdoutBytes: Buffer.byteLength(text), stderrBytes: 0, stdoutSha256: hash(text), stderrSha256: hash('') };
    if (text) add('auxiliary-output-progress', 4, { stream: 'stdout', bytes: output.stdoutBytes, sha256: output.stdoutSha256, inputIndex: number });
    if (kind === 'killed') continue;
    const terminal = { childPid, exitCode: kind === 'quota-failure' ? 1 : kind === 'signal' ? null : 0,
      signal: kind === 'signal' ? 'SIGTERM' : null, ...output };
    if (!probe) add('auxiliary-result', 5, { ...terminal, ...input,
      outcome: !active ? 'NO_INPUT_WORKER_EXIT' : ['quota-failure', 'signal'].includes(kind) ? 'TRANSPORT_FAILED' : text ? 'TEXT_RETURNED_UNVALIDATED' : 'EMPTY_TEXT',
      diagnosticClassification: kind === 'quota-failure' ? 'QUOTA_OR_RATE_LIMIT' : 'UNKNOWN_OR_NONE',
      diagnosticEvidence: 'FIRST_8192_BYTES_PER_STREAM_PATTERN_ONLY',
      semanticSuccess: 'NOT_INFERRED_FROM_TRANSPORT' });
    add(probe ? 'probe-exit' : 'exit', 6, { ...terminal, inputIndex: number });
  }
  const ancestry = { sampleIntervalMs: 250, processIdentities: details.map(({ pid, startedAt }) => ({ pid, startedAt })), processDetails: details };
  const cleanup = { status: 'PASS_OBSERVED_IDENTITIES_EXITED', observedIdentityCount: details.length,
    remaining: [], unverifiedLiveReceiptPids: [], auxiliaryAccountingErrors: [],
    textAuxiliaryInputs: inputIndex, auxiliaryInputs: 0, combinedAuxiliaryInputs: inputIndex };
  return { auxiliary, receipts, ancestry, cleanup, counter: { forwardedInputs: inputIndex, maxInputs: 3 }, live: [],
    primaryAuxiliaryInputs: 0, temporaryRoot: '/private/tmp', probeDirectories: ['/owned/workspace'] };
}
check('Only exact inherited cap60 to cap3 changes in the new pure auxiliary module',()=>{
  assert.equal(fs.readFileSync(path.join(__dirname,'codex-f2-test-proof-auxiliary.cjs'),'utf8'),fs.readFileSync(path.join(__dirname,'codex-f2-auxiliary.cjs'),'utf8').replace('const MAX_INPUTS = 60;','const MAX_INPUTS = 3;'));assert.equal(auxiliary.MAX_INPUTS,3);
});
check('Exactly3 accounted helper requests accepted without semantic-success claims',()=>{const r=auxiliary.auditEvidence(auxiliaryFixture(Array(3).fill('empty')));assert.equal(r.counts.submitted,3);assert.equal(r.counts.semanticSuccessesVerified,0);});
check('4 requests rejected even with matching counter and cleanup',()=>{const v=auxiliaryFixture(Array(4).fill('empty'));assert.throws(()=>auxiliary.auditEvidence(v));});
check('Returned text, quota failure and unknown terminal remain distinct',()=>{const r=auxiliary.auditEvidence(auxiliaryFixture(['unvalidated-text','quota-failure','killed']));assert.equal(r.counts.returnedTextUnvalidated,1);assert.equal(r.counts.failedProcesses,1);assert.equal(r.counts.terminalUnobserved,1);assert.equal(r.counts.semanticSuccessesVerified,0);});
for(const [name,mutate]of[
 ['counter shortfall',v=>{v.counter.forwardedInputs--;}],['counter overcount',v=>{v.counter.forwardedInputs++;}],['old cap60',v=>{v.auxiliary.maxInputs=60;v.counter.maxInputs=60;}],
 ['missing accounted request',v=>{v.receipts=v.receipts.filter(r=>r.event!=='auxiliary-input'||r.inputIndex!==1);}],['duplicate reservation',v=>{v.receipts.push(copy(v.receipts.find(r=>r.event==='auxiliary-input')));}],
 ['widened tool permission',v=>{const s=v.receipts.find(r=>r.event==='auxiliary-start');s.args[s.args.indexOf('--tools')+1]='Bash';}],
 ['foreign executable',v=>{v.receipts.find(r=>r.event==='auxiliary-start').executable='/foreign/claude';}],['unisolated cwd',v=>{v.receipts.find(r=>r.event==='auxiliary-start').cwd='/owned/workspace';}],
 ['living identity',v=>{v.live=[copy(v.ancestry.processIdentities[1])];}],['omitted child birth',v=>{v.receipts.find(r=>r.event==='auxiliary-start').processBirths.pop();}],
 ['plaintext prompt',v=>{v.receipts.find(r=>r.event==='auxiliary-input').prompt='unretained';}],['semantic claim from transport',v=>{v.receipts.find(r=>r.event==='auxiliary-result').semanticSuccess=true;}],
 ['cleanup undercount',v=>{v.cleanup.textAuxiliaryInputs--;}],['primary auxiliary count concealed',v=>{v.primaryAuxiliaryInputs=1;}],
])check(`Reject ${name}`,()=>{const v=auxiliaryFixture(['unvalidated-text','empty','killed']);mutate(v);assert.throws(()=>auxiliary.auditEvidence(v));});
const report={status:checks.every(r=>r.status==='PASS')?'PASS':'FAIL',checks,realProviderInputs:0,nativeEditorLaunches:0};
const target=path.join(directory,'checks.json');fs.writeFileSync(target,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({path:target,status:report.status,checks:checks.length,failures:checks.filter(r=>r.status==='FAIL')}));if(report.status==='FAIL')process.exitCode=1;
