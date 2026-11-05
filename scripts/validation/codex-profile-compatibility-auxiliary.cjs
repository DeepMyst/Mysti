/* Pure PB-02 profile compatibility text-worker accounting. Never launches an editor or model.
 * Independent policy copied from the preserved auditor; no prior artifacts are changed.
 */
'use strict';
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const sha = value => createHash('sha256').update(value).digest('hex');
const shaPattern = /^[a-f0-9]{64}$/;
const MAX_INPUTS = 5;
// Independent expected policy, deliberately not imported from the wrapper.
const EXPECTED_ARGS = Object.freeze([
  '--print', '--output-format', 'text', '--model', 'claude-haiku-4-5-20251001',
  '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--setting-sources', '', '--settings', '{"disableAllHooks":true}',
  '--safe-mode', '--no-chrome', '--no-session-persistence',
  '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
]);
const key = value => `${value.pid}|${value.startedAt}`;
function integer(value) { assert(Number.isSafeInteger(value) && value >= 0, 'Expected nonnegative count'); }
function one(values, label) { assert.equal(values.length, 1, label); return values[0]; }
function output(value) {
  for (const stream of ['stdout', 'stderr']) {
    integer(value[`${stream}Bytes`]); assert(shaPattern.test(value[`${stream}Sha256`]));
    if (value[`${stream}Bytes`] === 0) assert.equal(value[`${stream}Sha256`], sha(''));
  }
  assert(value.exitCode === null || Number.isInteger(value.exitCode));
  assert(value.signal === null || /^SIG[A-Z0-9]+$/.test(value.signal));
}

/** Pure receipt/ancestry checks. Synthetic controls exercise this exact acceptance path. */
function auditEvidence({ auxiliary, receipts, ancestry, cleanup, counter, live = [], primaryAuxiliaryInputs = 0, temporaryRoot }) {
  assert.equal(auxiliary.provider, 'claude-code'); assert.equal(auxiliary.maxInputs, MAX_INPUTS);
  assert.deepEqual(auxiliary.expectedArgs, EXPECTED_ARGS);
  integer(primaryAuxiliaryInputs);
  assert(Array.isArray(receipts)); assert(Array.isArray(live));
  assert(path.isAbsolute(temporaryRoot), 'Expected absolute private-directory root');
  assert.equal(cleanup.status, 'PASS_OBSERVED_IDENTITIES_EXITED');
  assert.deepEqual(cleanup.remaining, []); assert.deepEqual(cleanup.unverifiedLiveReceiptPids, []);
  assert.deepEqual(cleanup.auxiliaryAccountingErrors, []);
  assert.equal(ancestry.sampleIntervalMs, 250);
  assert.equal(cleanup.observedIdentityCount, ancestry.processIdentities.length);
  const identities = new Set(ancestry.processIdentities.map(key));
  assert.equal(identities.size, ancestry.processIdentities.length);
  const living = new Map(live.map(value => [value.pid, value.startedAt]));
  for (const value of ancestry.processIdentities) assert.notEqual(living.get(value.pid), value.startedAt, 'Observed owned process remains alive');
  const details = ancestry.processDetails;
  assert(Array.isArray(details));
  const detailByIdentity = new Map(details.map(value => [key(value), value]));
  assert.equal(detailByIdentity.size, details.length, 'Process details must have unique birth identities');
  assert.equal(detailByIdentity.size, identities.size, 'Every observed identity requires process details');
  for (const detail of details) assert(identities.has(key(detail)), 'Process detail must have an observed birth identity');
  const allowedEvents = new Set(['auxiliary-start', 'probe-start', 'auxiliary-input', 'auxiliary-input-progress',
    'auxiliary-submission', 'auxiliary-output-progress', 'auxiliary-result', 'probe-exit', 'exit']);
  const groups = new Map();
  for (const receipt of receipts) {
    assert.equal(receipt.provider, 'claude-code'); assert.equal(receipt.window, 'A');
    assert.equal(receipt.lane, 'text-only-auxiliary');
    assert(Number.isSafeInteger(receipt.wrapperPid) && receipt.wrapperPid > 0); assert(Number.isFinite(receipt.at));
    assert(allowedEvents.has(receipt.event), `Unexpected/refused auxiliary event: ${receipt.event}`);
    // No transcript, credentials, arbitrary environment or output bodies belong in this lane.
    for (const field of ['prompt', 'content', 'stdout', 'stderr', 'env', 'environment', 'auth', 'apiKey']) assert(!Object.hasOwn(receipt, field));
    if (!groups.has(receipt.wrapperPid)) groups.set(receipt.wrapperPid, []);
    groups.get(receipt.wrapperPid).push(receipt);
  }
  const inputs = receipts.filter(value => value.event === 'auxiliary-input');
  assert(inputs.length <= MAX_INPUTS, 'Auxiliary input cap exceeded');
  assert.deepEqual(inputs.map(value => value.inputIndex).sort((a, b) => a - b), Array.from({ length: inputs.length }, (_, i) => i + 1));
  assert.deepEqual(counter, { forwardedInputs: inputs.length, maxInputs: MAX_INPUTS });
  assert.equal(cleanup.textAuxiliaryInputs, inputs.length);
  assert.equal(cleanup.auxiliaryInputs, primaryAuxiliaryInputs);
  assert.equal(cleanup.combinedAuxiliaryInputs, primaryAuxiliaryInputs + inputs.length);
  const counts = { workers: 0, versionProbes: 0, submitted: inputs.length, completeSubmissions: 0,
    unusedWarmWorkers: 0, completedProcesses: 0, failedProcesses: 0, signalInterrupted: 0,
    terminalUnobserved: 0, returnedTextUnvalidated: 0, emptySuccessfulProcess: 0, semanticSuccessesVerified: 0 };
  const diagnostics = { QUOTA_OR_RATE_LIMIT: 0, AUTHENTICATION: 0, UNKNOWN_OR_NONE: 0 };
  const workers = [], starts = [], temporaryDirectories = new Set();
  for (const [wrapperPid, rows] of groups) {
    const start = one(rows.filter(value => ['auxiliary-start', 'probe-start'].includes(value.event)), 'Exactly one launch per captured wrapper');
    starts.push(start);
    assert.equal(start.executable, auxiliary.executableIdentity.path); assert.equal(start.environmentForwardedUnchanged, true);
    assert(Number.isSafeInteger(start.childPid) && start.childPid > 0 && start.childPid !== wrapperPid);
    assert(Array.isArray(start.processBirths));
    assert.equal(new Set(start.processBirths.map(value => value.pid)).size, start.processBirths.length, 'Launch births cannot repeat a PID');
    const wrapperBirth = one(start.processBirths.filter(value => value.pid === wrapperPid), 'Wrapper birth must be captured');
    assert.equal(typeof wrapperBirth.startedAt, 'string'); assert(Number.isFinite(Date.parse(wrapperBirth.startedAt)));
    const childBirth = start.processBirths.find(value => value.pid === start.childPid);
    if (childBirth) assert.equal(start.childStartedAt, childBirth.startedAt);
    else assert.equal(start.childStartedAt, undefined, 'Native birth cannot be asserted without its observation');
    for (const birth of start.processBirths) {
      assert([wrapperPid, start.childPid].includes(birth.pid));
      assert.equal(typeof birth.startedAt, 'string'); assert(Number.isFinite(Date.parse(birth.startedAt)));
      assert.notEqual(living.get(birth.pid), birth.startedAt, 'Receipt-owned process remains alive');
    }
    for (const pid of [wrapperPid, start.childPid]) {
      if (!living.has(pid)) continue;
      const birth = start.processBirths.find(value => value.pid === pid);
      assert(birth ? birth.startedAt !== living.get(pid) : Date.parse(living.get(pid)) > start.at, 'Unverified living receipt PID');
    }
    for (let i = 1; i < rows.length; i++) assert(rows[i].at >= rows[i - 1].at, 'Per-worker event times must be ordered');
    assert.equal(rows[0], start, 'Each captured wrapper must begin with its launch receipt');
    const requests = rows.filter(value => value.event === 'auxiliary-input');
    assert(requests.length <= 1, 'One input reservation per text worker');
    const results = rows.filter(value => value.event === 'auxiliary-result'); assert(results.length <= 1);
    const exits = rows.filter(value => ['probe-exit', 'exit'].includes(value.event)); assert(exits.length <= 1);
    const probe = start.event === 'probe-start';
    if (probe) {
      counts.versionProbes++;
      assert.deepEqual(start.args, ['--version']); assert.equal(start.isolatedCwd, false);
      assert.equal(typeof start.cwd, 'string'); assert(path.isAbsolute(start.cwd));
      assert.equal(requests.length, 0); assert.equal(results.length, 0);
      if (exits.length) { assert.equal(exits[0].event, 'probe-exit'); output(exits[0]); }
    } else {
      counts.workers++;
      assert.deepEqual(start.args, EXPECTED_ARGS); assert.equal(start.isolatedCwd, true);
      assert.equal(start.safeModeEnvironment, true); assert.equal(start.pwdMatchesCwd, true);
      assert.equal(start.cwdMode, 0o700); assert.equal(start.cwdInitiallyEmpty, true);
      assert.equal(path.dirname(start.cwd), temporaryRoot);
      assert(/^mysti-text-worker-[A-Za-z0-9]+$/.test(path.basename(start.cwd)));
      assert(!temporaryDirectories.has(start.cwd), 'A private cwd cannot be reused between workers'); temporaryDirectories.add(start.cwd);
      if (!requests.length) counts.unusedWarmWorkers++;
    }
    const input = requests[0], progress = rows.filter(value => value.event === 'auxiliary-input-progress');
    const submissions = rows.filter(value => value.event === 'auxiliary-submission'); assert(submissions.length <= 1);
    if (submissions.length && progress.length) assert(submissions[0].at >= progress.at(-1).at, 'Input cannot progress after its completed submission');
    let priorBytes = 0;
    for (const value of [...progress, ...submissions]) {
      integer(value.inputBytes); assert(shaPattern.test(value.inputSha256));
      assert(['title', 'classification', 'suggestion', 'unknown', 'no-input'].includes(value.purpose));
      assert.equal(value.inputIndex, input?.inputIndex);
      if (value.inputBytes) { assert(input && value.at >= input.at); assert(value.inputBytes >= priorBytes); }
      else { assert.equal(value.inputSha256, sha('')); assert.equal(value.purpose, 'no-input'); }
      if (value.event === 'auxiliary-input-progress') { assert(value.inputBytes > priorBytes); assert.equal(value.inputEnded, false); }
      else assert.equal(value.inputEnded, true);
      priorBytes = value.inputBytes;
    }
    if (!input) assert.equal(priorBytes, 0);
    if (input && submissions.length) counts.completeSubmissions++;
    const outputProgress = rows.filter(value => value.event === 'auxiliary-output-progress');
    let priorOutput = 0;
    for (const value of outputProgress) {
      assert.equal(value.stream, 'stdout'); integer(value.bytes); assert(value.bytes > priorOutput); assert(shaPattern.test(value.sha256));
      assert.equal(value.inputIndex, input?.inputIndex); priorOutput = value.bytes;
    }
    const result = results[0], exit = exits[0];
    if (result) {
      output(result); assert.equal(result.childPid, start.childPid); assert.equal(result.inputIndex, input?.inputIndex);
      assert.equal(result.inputBytes, priorBytes); assert.equal(result.semanticSuccess, 'NOT_INFERRED_FROM_TRANSPORT');
      assert.equal(result.purpose, [...progress, ...submissions].at(-1)?.purpose || 'no-input');
      if (input) assert(result.inputBytes > 0, 'A terminal input reservation requires recorded input bytes');
      for (const row of [...requests, ...progress, ...submissions, ...outputProgress]) assert(row.at <= result.at, 'Worker activity cannot follow its terminal result');
      assert.equal(result.diagnosticEvidence, 'FIRST_8192_BYTES_PER_STREAM_PATTERN_ONLY');
      assert.notEqual(result.diagnosticClassification, 'REJECTED_ARGUMENTS', 'Native Claude rejected the required isolation arguments');
      assert(Object.hasOwn(diagnostics, result.diagnosticClassification), 'Unexpected diagnostic category');
      diagnostics[result.diagnosticClassification]++;
      assert.equal(result.inputEnded, submissions.length > 0);
      assert.equal(result.inputSha256, [...progress, ...submissions].at(-1)?.inputSha256 || sha(''));
      assert.equal(result.stdoutBytes, priorOutput);
      if (outputProgress.length) assert.equal(result.stdoutSha256, outputProgress.at(-1).sha256);
      const expectedOutcome = !result.inputBytes ? 'NO_INPUT_WORKER_EXIT' : result.signal || result.exitCode !== 0 ? 'TRANSPORT_FAILED'
        : result.stdoutBytes ? 'TEXT_RETURNED_UNVALIDATED' : 'EMPTY_TEXT';
      assert.equal(result.outcome, expectedOutcome);
      if (input) {
        if (result.signal) counts.signalInterrupted++;
        else if (result.exitCode !== 0) counts.failedProcesses++;
        else { counts.completedProcesses++; if (result.stdoutBytes) counts.returnedTextUnvalidated++; else counts.emptySuccessfulProcess++; }
      }
    } else if (input) counts.terminalUnobserved++;
    if (exit) {
      assert.equal(exit.childPid, start.childPid); assert.equal(exit.inputIndex, input?.inputIndex); output(exit);
      if (!probe) {
        assert(result, 'A worker exit cannot omit its preceding result receipt'); assert.equal(exit.event, 'exit');
        assert(exit.at >= result.at, 'Worker exit must follow its terminal result');
        for (const field of ['exitCode', 'signal', 'stdoutBytes', 'stderrBytes', 'stdoutSha256', 'stderrSha256']) assert.equal(exit[field], result[field]);
      } else {
        assert.equal(exit.stdoutBytes, priorOutput);
        if (outputProgress.length) assert.equal(exit.stdoutSha256, outputProgress.at(-1).sha256);
      }
    }
    workers.push({ wrapperPid, childPid: start.childPid, probe, inputIndex: input?.inputIndex,
      purpose: [...progress, ...submissions].at(-1)?.purpose || 'no-input',
      diagnosticClassification: result?.diagnosticClassification,
      processOutcome: probe ? exit ? 'PROBE_EXIT_RECORDED' : 'PROBE_TERMINAL_UNOBSERVED' : !input ? 'UNUSED_WARM_WORKER'
        : !result ? 'TERMINAL_UNOBSERVED_AFTER_VERIFIED_EXIT' : result.signal ? 'SIGNAL_INTERRUPTED'
          : result.exitCode !== 0 ? 'FAILED_PROCESS' : 'COMPLETED_PROCESS_INFERENCE_UNVERIFIED' });
  }
  assert(counts.workers > 0, 'No actual restricted text-worker launch evidence');
  assert.equal(counts.submitted, counts.completedProcesses + counts.failedProcesses + counts.signalInterrupted + counts.terminalUnobserved);
  const claudeNames = new Set(['claude', 'claude.exe', 'claude-code', path.basename(auxiliary.executableIdentity.path)]);
  const observedClaude = details.filter(value => {
    const name = value.executableBasename.replace(/^\((.*)\)$/, '$1');
    return claudeNames.has(name) || /^2\.1\.\d+$/.test(name);
  });
  const claudeOwnership = observedClaude.map(process => {
    const chain = [], visited = new Set();
    let current = process;
    while (true) {
      const currentKey = key(current);
      assert(!visited.has(currentKey), 'Cyclic native process ancestry cannot establish ownership');
      visited.add(currentKey); chain.push({ pid: current.pid, startedAt: current.startedAt });
      const joined = starts.filter(start => start.childPid === current.pid && (start.childStartedAt
        ? start.childStartedAt === current.startedAt
        : Date.parse(current.startedAt) <= start.at && Date.parse(current.lastObservedAt) + 2000 >= start.at));
      if (joined.length) {
        const owner = one(joined, 'Observed native root must have one instrumented owner');
        return { pid: process.pid, startedAt: process.startedAt,
          kind: chain.length === 1 ? 'DIRECT_NATIVE_ROOT' : 'NATIVE_DESCENDANT',
          ownerWrapperPid: owner.wrapperPid, ownerNativePid: owner.childPid, chain };
      }
      // A same-number parent from a different lifetime is never sufficient.
      assert(Number.isSafeInteger(current.parentPid) && typeof current.parentStartedAt === 'string', 'Missing native parent birth identity');
      const parent = detailByIdentity.get(key({ pid: current.parentPid, startedAt: current.parentStartedAt }));
      assert(parent, 'Observed Claude process has no complete birth-verified instrumented ancestry');
      assert(Date.parse(parent.startedAt) <= Date.parse(current.startedAt), 'Native parent cannot be born after its child');
      current = parent;
    }
  });
  return { counts, diagnostics, workers, temporaryDirectories: [...temporaryDirectories], observedClaudeIdentities: observedClaude.length,
    observedClaudeDirectRoots: claudeOwnership.filter(value => value.kind === 'DIRECT_NATIVE_ROOT').length,
    observedClaudeDescendants: claudeOwnership.filter(value => value.kind === 'NATIVE_DESCENDANT').length, claudeOwnership,
    inferenceValidation: 'NOT_ESTABLISHED_BY_TEXT_TRANSPORT_RECEIPTS',
    limitations: ['Exit0 or nonempty text does not prove a successful title/classification; quota/error text may be stdout.',
      'Submitted workers without terminal receipts have unknown outcomes after verified process exit; they are not inferred model failures or successes.',
      '250ms ancestry sampling can miss short-lived children. Only observed Claude identities can be checked for wrapper ownership.',
      'Native descendants are attributed by complete PID/birth chains, not counted as additional submitted inputs. Their argv/environment and internal API retries are not observed.',
      'Diagnostic categories match only the first8192 bytes per stream; absence of a known pattern does not establish successful inference.',
      'Private-directory cleanup is best effort during extension-host exit. Remaining empty directories are reported separately from live processes.',
      'CLI managed policies remain applicable. These restrictions are not an OS sandbox.'] };
}

module.exports = { auditEvidence, EXPECTED_ARGS, MAX_INPUTS };
