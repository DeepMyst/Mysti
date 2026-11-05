/* Synthetic cap36 text-worker controls. No editor or model is launched. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const auxiliary=require('./codex-f2-final-pair-auxiliary.cjs'), EXPECTED_ARGS=auxiliary.EXPECTED_ARGS;
const hash=value=>crypto.createHash('sha256').update(value).digest('hex'), copy=value=>JSON.parse(JSON.stringify(value));
const root=path.resolve(__dirname,'../../out-test/feature-tests/PB-02');
const directory=fs.mkdtempSync(path.join(root,'f2-final-pair-auxiliary-controls-')),checks=[];
const check=(name,fn)=>{try{fn();checks.push({name,status:'PASS'});}catch(error){checks.push({name,status:'FAIL',error:error.stack});}};
function auxiliaryFixture(kinds = ['probe', 'warm', 'quota-failure', 'unvalidated-text', 'killed', 'signal', 'empty']) {
  const birth = 'Sat Oct 10 11:00:00 2026', timestamp = Date.parse(birth), receipts = [], details = [];
  const auxiliary = { provider: 'claude-code', maxInputs: 36, expectedArgs: [...EXPECTED_ARGS], executableIdentity: { path: '/synthetic/claude' } };
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
  return { auxiliary, receipts, ancestry, cleanup, counter: { forwardedInputs: inputIndex, maxInputs: 36 }, live: [],
    primaryAuxiliaryInputs: 0, temporaryRoot: '/private/tmp', probeDirectories: ['/owned/workspace'] };
}
check('cap36 helper module changes only the inherited hard input bound', () => {
  const old = fs.readFileSync(path.join(__dirname, 'codex-f2-auxiliary.cjs'), 'utf8');
  assert.equal(fs.readFileSync(path.join(__dirname, 'codex-f2-final-pair-auxiliary.cjs'), 'utf8'), old.replace('const MAX_INPUTS = 60;', 'const MAX_INPUTS = 36;'));
  assert.equal(auxiliary.MAX_INPUTS, 36);
});
check('36 independently accounted helper inputs accepted without semantic-success credit', () => { const r = auxiliary.auditEvidence(auxiliaryFixture(Array(36).fill('empty'))); assert.equal(r.counts.submitted, 36); assert.equal(r.counts.semanticSuccessesVerified, 0); });
check('37 helpers rejected even if all counters agree', () => { const value = auxiliaryFixture(Array(37).fill('empty')); assert.throws(() => auxiliary.auditEvidence(value)); });
check('helper mixed transport outcomes preserve unknown terminals and quota failures', () => { const r = auxiliary.auditEvidence(auxiliaryFixture()); assert.equal(r.counts.terminalUnobserved, 1); assert.equal(r.counts.failedProcesses, 1); assert.equal(r.counts.semanticSuccessesVerified, 0); });
for (const [name, mutate] of [
  ['counter shortfall', v => { v.counter.forwardedInputs--; }], ['counter excess', v => { v.counter.forwardedInputs++; }],
  ['cap downgrade', v => { v.counter.maxInputs = 32; }], ['unaccounted input', v => { v.receipts = v.receipts.filter(r => r.event !== 'auxiliary-input' || r.inputIndex !== 1); }],
  ['builtin tool enabled', v => { const s = v.receipts.find(r => r.event === 'auxiliary-start'); s.args[s.args.indexOf('--tools') + 1] = 'Bash'; }],
  ['foreign executable', v => { v.receipts.find(r => r.event === 'auxiliary-start').executable = '/other/claude'; }],
  ['living owned identity', v => { v.live = [copy(v.ancestry.processIdentities[1])]; }],
  ['receipt body forbidden', v => { v.receipts.find(r => r.event === 'auxiliary-input').prompt = 'unretained body'; }],
  ['fake semantic success', v => { v.receipts.find(r => r.event === 'auxiliary-result').semanticSuccess = true; }],
  ['missing input ancestry', v => { v.receipts.find(r => r.event === 'auxiliary-start').processBirths = []; }],
]) check(`helper policy/accounting rejects ${name}`, () => { const v = auxiliaryFixture(); mutate(v); assert.throws(() => auxiliary.auditEvidence(v)); });

for (const [name,mutate] of [
 ['declared descriptor cap60',v=>{v.auxiliary.maxInputs=60;}],
 ['declared descriptor cap37',v=>{v.auxiliary.maxInputs=37;}],
 ['counter cap37',v=>{v.counter.maxInputs=37;}],
 ['duplicate global input index',v=>{const xs=v.receipts.filter(r=>r.event==='auxiliary-input');xs[1].inputIndex=xs[0].inputIndex;}],
]) check(`cap36 boundary rejects ${name}`,()=>{const v=auxiliaryFixture();mutate(v);assert.throws(()=>auxiliary.auditEvidence(v));});
const files=['codex-f2-final-pair-auxiliary.cjs','check-codex-f2-final-pair-auxiliary.cjs','codex-f2-auxiliary.cjs'];
const report={status:checks.every(r=>r.status==='PASS')?'PASS_SYNTHETIC_CONTROLS':'FAIL',directory,identities:files.map(name=>{const file=path.join(__dirname,name);return {path:file,sha256:hash(fs.readFileSync(file))};}),checks,scope:'Synthetic helper transport and cap boundaries only. No native input or helper semantic correctness is inferred.'};
const target=path.join(directory,'checks.json');fs.writeFileSync(target,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({path:target,status:report.status,passed:checks.filter(r=>r.status==='PASS').length,total:checks.length,failures:checks.filter(r=>r.status!=='PASS')}));if(report.status==='FAIL')process.exitCode=1;
