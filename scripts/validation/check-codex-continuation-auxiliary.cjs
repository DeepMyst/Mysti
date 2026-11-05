/* Pure synthetic audit controls: no editor, backend, credentials or CLI execution. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { auditEvidence, EXPECTED_ARGS, MAX_INPUTS } = require('./codex-continuation-auxiliary.cjs');
const digest = text => createHash('sha256').update(text).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const root = path.resolve(__dirname, '../../out-test/feature-tests/PB-02');
const parent = path.join(root, 'codex-continuation-auxiliary-controls'); fs.mkdirSync(parent, { recursive: true });
const directory = fs.mkdtempSync(path.join(parent, 'synthetic-'));
function fixture(kinds = ['probe', 'warm', 'quota-failure', 'unvalidated-text', 'killed', 'signal', 'empty']) {
  const birth = 'Sat Oct 10 11:00:00 2026', timestamp = Date.parse(birth), receipts = [], details = [];
  const auxiliary = { provider: 'claude-code', maxInputs: 20, expectedArgs: [...EXPECTED_ARGS], executableIdentity: { path: '/synthetic/claude' } };
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
    const input = { inputIndex: number, inputBytes: active ? 32 : 0, inputSha256: digest(active ? 'synthetic prompt' : ''),
      inputEnded: true, purpose: active ? 'title' : 'no-input' };
    if (active) {
      add('auxiliary-input', 1, { inputIndex: number });
      add('auxiliary-input-progress', 2, { ...input, inputEnded: false });
    }
    add('auxiliary-submission', 3, input);
    const text = ['quota-failure', 'unvalidated-text'].includes(kind) ? 'quota limit text is not semantic success' : probe ? 'synthetic version' : '';
    const output = { stdoutBytes: Buffer.byteLength(text), stderrBytes: 0, stdoutSha256: digest(text), stderrSha256: digest('') };
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
  return { auxiliary, receipts, ancestry, cleanup, counter: { forwardedInputs: inputIndex, maxInputs: 20 }, live: [],
    primaryAuxiliaryInputs: 0, temporaryRoot: '/private/tmp', probeDirectories: ['/owned/workspace'] };
}
const checks = [];
function check(name, change, accept = false, oracle) {
  const value = fixture(); change?.(value);
  try {
    if (accept) { const result = auditEvidence(value); oracle?.(result); }
    else assert.throws(() => auditEvidence(value));
    checks.push({ name, status: 'PASS' });
  } catch (error) { checks.push({ name, status: 'FAIL', error: error.message }); }
}
const start = value => value.receipts.find(row => row.event === 'auxiliary-start');
check('the continuation cap is pinned independently to 20 inputs', undefined, true, () => assert.equal(MAX_INPUTS, 20));
check('exactly 20 fully accounted inputs are accepted', value => {
  Object.assign(value, fixture(Array(20).fill('empty')));
}, true, result => {
  assert.equal(result.counts.submitted, 20); assert.equal(result.counts.completedProcesses, 20);
  assert.equal(result.counts.semanticSuccessesVerified, 0);
});
check('16 expected title and classification inputs remain transport-only evidence', value => {
  Object.assign(value, fixture(Array(16).fill('unvalidated-text')));
  for (const row of value.receipts) if (row.inputIndex > 2 && Object.hasOwn(row, 'purpose')) row.purpose = 'classification';
}, true, result => {
  assert.equal(result.counts.workers, 16); assert.equal(result.counts.submitted, 16);
  assert.equal(result.counts.returnedTextUnvalidated, 16); assert.equal(result.counts.semanticSuccessesVerified, 0);
  assert.equal(result.workers.filter(worker => worker.purpose === 'title').length, 2);
  assert.equal(result.workers.filter(worker => worker.purpose === 'classification').length, 14);
});
check('21 inputs fail even when the counter and cleanup totals agree', value => {
  Object.assign(value, fixture(Array(21).fill('empty')));
});
check('the former eight-input peer policy cannot authorize this continuation', value => {
  value.auxiliary.maxInputs = 8; value.counter.maxInputs = 8;
});
check('counter cap cannot independently exceed 20', value => { value.counter.maxInputs = 21; });
check('counter shortfall cannot hide a receipt', value => { value.counter.forwardedInputs--; });
check('counter excess cannot manufacture an input receipt', value => { value.counter.forwardedInputs++; });
check('cleanup text-worker total cannot undercount receipts', value => { value.cleanup.textAuxiliaryInputs--; });
check('separate primary auxiliary inputs remain included in combined totals', value => {
  value.primaryAuxiliaryInputs = 2; value.cleanup.auxiliaryInputs = 2; value.cleanup.combinedAuxiliaryInputs += 2;
}, true, result => assert.equal(result.counts.submitted, 5));
check('negative separate auxiliary totals cannot offset the continuation lane', value => {
  value.primaryAuxiliaryInputs = -1; value.cleanup.auxiliaryInputs = -1; value.cleanup.combinedAuxiliaryInputs--;
});
check('cleanup cannot omit separate primary auxiliary inputs', value => {
  value.primaryAuxiliaryInputs = 1;
});
check('an all-warm run does not claim any submitted or successful inference', value => {
  Object.assign(value, fixture(['warm']));
}, true, result => {
  assert.equal(result.counts.submitted, 0); assert.equal(result.counts.unusedWarmWorkers, 1);
  assert.equal(result.counts.completedProcesses, 0); assert.equal(result.counts.semanticSuccessesVerified, 0);
});
check('version-only observations cannot claim a restricted worker launch', value => {
  Object.assign(value, fixture(['probe']));
});
check('valid mixed outcomes distinguish warm/version, quota failure, unvalidated stdout, killed input, signal and empty result', undefined, true, result => {
  assert.deepEqual(result.counts, { workers: 6, versionProbes: 1, submitted: 5, completeSubmissions: 5,
    unusedWarmWorkers: 1, completedProcesses: 2, failedProcesses: 1, signalInterrupted: 1,
    terminalUnobserved: 1, returnedTextUnvalidated: 1, emptySuccessfulProcess: 1, semanticSuccessesVerified: 0 });
});
check('a builtin tool cannot be enabled', value => { const args = start(value).args; args[args.indexOf('--tools') + 1] = 'Bash'; });
check('inherited MCP configuration is rejected', value => { start(value).args = start(value).args.filter(arg => arg !== '--strict-mcp-config'); });
check('foreign executable is rejected', value => { start(value).executable = '/other/claude'; });
check('a safe-mode environment downgrade is rejected', value => { start(value).safeModeEnvironment = false; });
check('changed child environment forwarding is rejected', value => { start(value).environmentForwardedUnchanged = false; });
check('inherited project cwd is rejected', value => { start(value).cwd = '/owned/workspace'; });
check('non-private cwd permissions are rejected', value => { start(value).cwdMode = 0o755; });
check('nonempty startup cwd is rejected', value => { start(value).cwdInitiallyEmpty = false; });
check('PWD does not disagree with the isolated cwd', value => { start(value).pwdMatchesCwd = false; });
check('private directories cannot be reused', value => { value.receipts.filter(row => row.event === 'auxiliary-start')[1].cwd = start(value).cwd; });
check('more permissive advertised expected policy is not trusted', value => { value.auxiliary.expectedArgs[value.auxiliary.expectedArgs.indexOf('--tools') + 1] = 'default'; });
check('cap cannot be raised', value => { value.auxiliary.maxInputs = 21; });
check('input reservation cannot be duplicated', value => { value.receipts.push(copy(value.receipts.find(row => row.event === 'auxiliary-input'))); });
check('missing input receipt cannot be concealed by a counter', value => { value.receipts = value.receipts.filter(row => row.event !== 'auxiliary-input' || row.inputIndex !== 1); });
check('a submission cannot have two purposes/terminal receipts', value => { value.receipts.push(copy(value.receipts.find(row => row.event === 'auxiliary-submission'))); });
check('probe cannot submit an inference input', value => { value.receipts.find(row => row.event === 'auxiliary-input').wrapperPid = value.receipts[0].wrapperPid; });
check('wrapper refusal preserves failed attempt', value => { value.receipts.push({ ...value.receipts[0], event: 'auxiliary-invocation-refusal' }); });
check('birth observation errors are not hidden', value => { value.receipts.push({ ...value.receipts[0], event: 'auxiliary-birth-observation-error' }); });
check('input cap refusal is not hidden', value => { value.receipts.push({ ...value.receipts[0], event: 'auxiliary-input-cap-refusal' }); });
check('missing launch receipt cannot hide an accounted worker', value => {
  const row = start(value); value.receipts = value.receipts.filter(receipt => receipt !== row);
});
check('missing terminal result cannot be concealed by a process exit', value => {
  value.receipts = value.receipts.filter(row => row.event !== 'auxiliary-result' || row.inputIndex !== 2);
});
check('missing completed submission remains explicit after a verified process exit', value => {
  Object.assign(value, fixture(['killed']));
  value.receipts = value.receipts.filter(row => row.event !== 'auxiliary-submission');
}, true, result => {
  assert.equal(result.counts.submitted, 1); assert.equal(result.counts.completeSubmissions, 0);
  assert.equal(result.counts.terminalUnobserved, 1); assert.equal(result.counts.completedProcesses, 0);
});
check('plaintext prompt cannot enter this safe receipt lane', value => { value.receipts.find(row => row.event === 'auxiliary-input').prompt = 'synthetic sensitive text'; });
check('stdout does not turn quota failure into semantic success', value => { value.receipts.find(row => row.event === 'auxiliary-result' && row.inputIndex === 1).semanticSuccess = true; });
check('new isolation option rejection cannot pass as an account failure', value => { value.receipts.find(row => row.event === 'auxiliary-result').diagnosticClassification = 'REJECTED_ARGUMENTS'; });
check('unrecognized diagnostic claims cannot invent semantic success', value => { value.receipts.find(row => row.event === 'auxiliary-result').diagnosticClassification = 'SUCCESS'; });
check('a version-only probe may inherit an editor cwd without gaining inference authority', value => { value.receipts[0].cwd = '/Applications/Visual Studio Code.app/Contents/MacOS'; }, true);
check('a failed native process cannot be labeled returned text', value => { value.receipts.find(row => row.event === 'auxiliary-result' && row.inputIndex === 1).outcome = 'TEXT_RETURNED_UNVALIDATED'; });
check('output receipt digest must join actual observed output chunks', value => { value.receipts.find(row => row.event === 'auxiliary-result' && row.inputIndex === 2).stdoutSha256 = digest('different output'); });
check('output byte counts must join actual observed chunks', value => { value.receipts.find(row => row.event === 'auxiliary-result' && row.inputIndex === 2).stdoutBytes++; });
check('input digest must join submitted bytes', value => { value.receipts.find(row => row.event === 'auxiliary-result' && row.inputIndex === 2).inputSha256 = digest('other input'); });
check('input purpose must join submitted metadata', value => { value.receipts.find(row => row.event === 'auxiliary-result' && row.inputIndex === 2).purpose = 'classification'; });
check('version output digest must join observed chunks', value => { value.receipts.find(row => row.event === 'probe-exit').stdoutSha256 = digest('other version'); });
check('native births cannot repeat a PID', value => { start(value).processBirths.push(copy(start(value).processBirths[1])); });
check('native birth cannot be asserted without its observation', value => { start(value).processBirths.pop(); });
check('a living receipt-owned process is rejected', value => { value.live = [copy(value.ancestry.processIdentities[1])]; });
check('a changed native birth cannot own an observed Claude process', value => { value.receipts[0].childStartedAt = 'Sat Oct 10 10:59:59 2026'; });
check('uninstrumented observed Claude is rejected', value => {
  const row = { ...value.ancestry.processDetails[1], pid: 90001 }; value.ancestry.processDetails.push(row);
  value.ancestry.processIdentities.push({ pid: row.pid, startedAt: row.startedAt }); value.cleanup.observedIdentityCount++;
});
check('combined totals include the separate text-worker lane', value => { value.cleanup.combinedAuxiliaryInputs = 0; });
check('known PID reuse is allowed only with a different birth', value => {
  value.live = [{ pid: value.ancestry.processIdentities[1].pid, startedAt: 'Sat Oct 10 11:10:00 2026' }];
}, true);
check('short-lived unsampled native child does not masquerade as observed coverage', value => {
  const pid = value.receipts[0].childPid;
  value.ancestry.processDetails = value.ancestry.processDetails.filter(row => row.pid !== pid);
  value.ancestry.processIdentities = value.ancestry.processIdentities.filter(row => row.pid !== pid);
  value.cleanup.observedIdentityCount--;
}, true, result => assert.equal(result.observedClaudeIdentities, 6));
function addDescendant(value, parent, pid, executableBasename = '(claude)') {
  const row = { ...parent, pid, parentPid: parent.pid, parentStartedAt: parent.startedAt, executableBasename };
  value.ancestry.processDetails.push(row);
  value.ancestry.processIdentities.push({ pid: row.pid, startedAt: row.startedAt });
  value.cleanup.observedIdentityCount++;
  return row;
}
check('a native Claude child is attributed through its exact parent birth without inventing another input', value => {
  addDescendant(value, value.ancestry.processDetails[3], 91001);
}, true, result => {
  assert.equal(result.observedClaudeIdentities, 8);
  assert.equal(result.observedClaudeDirectRoots, 7);
  assert.equal(result.observedClaudeDescendants, 1);
  assert.equal(result.counts.submitted, 5);
  assert.equal(result.claudeOwnership.find(row => row.pid === 91001).ownerNativePid, 20003);
});
check('a multi-hop native child requires every intermediate birth identity', value => {
  const intermediate = addDescendant(value, value.ancestry.processDetails[3], 91001, 'native-helper');
  addDescendant(value, intermediate, 91002);
}, true, result => {
  assert.equal(result.observedClaudeDescendants, 1);
  assert.equal(result.claudeOwnership.find(row => row.pid === 91002).chain.length, 3);
});
check('a reused parent PID with a different birth cannot attribute a native descendant', value => {
  addDescendant(value, value.ancestry.processDetails[3], 91001).parentStartedAt = 'Sat Oct 10 10:59:59 2026';
});
check('a missing intermediate parent cannot attribute a native descendant', value => {
  addDescendant(value, value.ancestry.processDetails[3], 91001).parentPid = 99999;
});
check('a cyclic parent graph cannot attribute native descendants', value => {
  const first = addDescendant(value, value.ancestry.processDetails[3], 91001);
  const second = addDescendant(value, first, 91002);
  first.parentPid = second.pid; first.parentStartedAt = second.startedAt;
});
check('ambiguous parent details cannot attribute native descendants', value => {
  addDescendant(value, value.ancestry.processDetails[3], 91001);
  value.ancestry.processDetails.push({ ...value.ancestry.processDetails[3], parentPid: 99999 });
});
check('missing process details cannot hide an observed native identity', value => {
  value.ancestry.processDetails.pop();
});
check('duplicate observed birth identities are rejected', value => {
  value.ancestry.processIdentities.push(copy(value.ancestry.processIdentities[0])); value.cleanup.observedIdentityCount++;
});
check('native descendant parent cannot be born after the child', value => {
  const row = addDescendant(value, value.ancestry.processDetails[3], 91001);
  row.startedAt = 'Sat Oct 10 10:59:59 2026'; value.ancestry.processIdentities.at(-1).startedAt = row.startedAt;
});
const result = { status: checks.every(value => value.status === 'PASS') ? 'PASS' : 'FAIL',
  scope: 'Pure synthetic receipt and process snapshots only; no model/editor/clipboard or native CLI launch.', checks };
fs.writeFileSync(path.join(directory, 'checks.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ status: result.status, directory, total: checks.length, failed: checks.filter(value => value.status === 'FAIL') }));
if (result.status !== 'PASS') process.exitCode = 1;
