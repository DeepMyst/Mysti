/* Independent supplementary PB-02 text-worker accounting; never launches a model/editor. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const repo = path.resolve(__dirname, '../..');
const root = path.join(repo, 'out-test/feature-tests/PB-02');
const sha = value => createHash('sha256').update(value).digest('hex');
const fileSha = file => sha(fs.readFileSync(file));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const shaPattern = /^[a-f0-9]{64}$/;
// Independent expected policy, deliberately not imported from the wrapper.
const EXPECTED_ARGS = Object.freeze([
  '--print', '--output-format', 'text', '--model', 'claude-haiku-4-5-20251001',
  '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--setting-sources', '', '--settings', '{"disableAllHooks":true}',
  '--safe-mode', '--no-chrome', '--no-session-persistence',
  '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
]);
const FROZEN_PRIMARY_SHA = '97e1df1324b09f926afb2620f1bd5d1178277081227f6849c3a75bf1f5050c1d';
const ORIGINAL_AUXILIARY_SHA = '0c869b49569e62ceb6871bfbaae39f29f88b28bd970e1f7fb2d24226e024d451';
const key = value => `${value.pid}|${value.startedAt}`;
function contained(parent, child) {
  const relative = path.relative(parent, child);
  assert(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep), 'Expected owned path');
}
function integer(value) { assert(Number.isSafeInteger(value) && value >= 0, 'Expected nonnegative count'); }
function one(values, label) { assert.equal(values.length, 1, label); return values[0]; }
function identity(value) {
  assert(value && path.isAbsolute(value.path) && shaPattern.test(value.sha256), 'Expected pinned file');
  assert.equal(fs.realpathSync(value.path), value.path);
  assert.equal(fileSha(value.path), value.sha256, `Changed pinned file: ${value.path}`);
}
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
  assert.equal(auxiliary.provider, 'claude-code'); assert.equal(auxiliary.maxInputs, 12);
  assert.deepEqual(auxiliary.expectedArgs, EXPECTED_ARGS);
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
  assert(inputs.length <= 12, 'Auxiliary input cap exceeded');
  assert.deepEqual(inputs.map(value => value.inputIndex).sort((a, b) => a - b), Array.from({ length: inputs.length }, (_, i) => i + 1));
  assert.deepEqual(counter, { forwardedInputs: inputs.length, maxInputs: 12 });
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
    const wrapperBirth = one(start.processBirths.filter(value => value.pid === wrapperPid), 'Wrapper birth must be captured');
    assert.equal(typeof wrapperBirth.startedAt, 'string'); assert(Number.isFinite(Date.parse(wrapperBirth.startedAt)));
    const childBirth = start.processBirths.find(value => value.pid === start.childPid);
    if (childBirth) assert.equal(start.childStartedAt, childBirth.startedAt);
    for (const birth of start.processBirths) {
      assert([wrapperPid, start.childPid].includes(birth.pid));
      assert.notEqual(living.get(birth.pid), birth.startedAt, 'Receipt-owned process remains alive');
    }
    for (const pid of [wrapperPid, start.childPid]) {
      if (!living.has(pid)) continue;
      const birth = start.processBirths.find(value => value.pid === pid);
      assert(birth ? birth.startedAt !== living.get(pid) : Date.parse(living.get(pid)) > start.at, 'Unverified living receipt PID');
    }
    for (let i = 1; i < rows.length; i++) assert(rows[i].at >= rows[i - 1].at, 'Per-worker event times must be ordered');
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
        for (const field of ['exitCode', 'signal', 'stdoutBytes', 'stderrBytes', 'stdoutSha256', 'stderrSha256']) assert.equal(exit[field], result[field]);
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

function auditArtifacts(directory) {
  directory = fs.realpathSync(directory); contained(fs.realpathSync(root), directory);
  const manifest = read(path.join(directory, 'prepared.json')), owner = manifest.windows.A, auxiliary = manifest.auxiliary;
  assert.equal(manifest.case, 'PB-02'); assert.equal(manifest.stage, 'FIRST_EIGHT'); assert.equal(manifest.artifactDir, directory);
  assert.equal(manifest.preparedBeforeActivation, true); assert.equal(auxiliary.routingSetting, 'mysti.claudeCodePath');
  assert.equal(fileSha(path.join(__dirname, 'audit-vscode-codex.cjs')), FROZEN_PRIMARY_SHA, 'Frozen primary auditor must remain unchanged');
  assert.equal(read(path.join(directory, 'independent-audit.json')).status, 'PASS_FIRST_EIGHT_ONLY');
  const pins = [...manifest.wrapperIdentities, ...manifest.harnessDependencyIdentities, auxiliary.executableIdentity,
    auxiliary.flagEvidenceIdentity, auxiliary.helperIdentity, manifest.sourceIdentity, manifest.packageIdentity, manifest.nodeIdentity];
  let auditRevision;
  pins.forEach(value => {
    if (value.path !== __filename || fileSha(__filename) === value.sha256) { identity(value); return; }
    // Only this post-run audit correction may differ from its launch pin. The
    // product, runtime, fixture and every other dependency retain strict pins.
    assert.equal(value.sha256, ORIGINAL_AUXILIARY_SHA, 'Unexpected prior auxiliary auditor');
    const archiveDirectory = path.join(directory, 'original-harness');
    const original = one(read(path.join(archiveDirectory, 'identities.json')).files.filter(entry => entry.source === __filename), 'Original auditor archive entry');
    assert.equal(original.sha256, value.sha256);
    assert.equal(original.copy, path.join(archiveDirectory, 'scripts__validation__audit-vscode-codex-auxiliary.cjs'));
    identity({ path: original.copy, sha256: original.sha256 });
    const postExitPath = path.join(directory, 'post-exit-identity-check.json'), postExit = read(postExitPath);
    assert.equal(postExit.status, 'PASS_POST_EXIT_IDENTITIES');
    assert.deepEqual(one(postExit.pins.filter(entry => entry.path === __filename), 'Post-exit original auditor pin'), value);
    assert.deepEqual(postExit.sourceIdentity, manifest.sourceIdentity); assert.deepEqual(postExit.packageIdentity, manifest.packageIdentity);
    const originalFailurePath = path.join(directory, 'auxiliary-independent-audit.json'), originalFailure = read(originalFailurePath);
    assert.equal(originalFailure.status, 'FAIL');
    assert(originalFailure.error.message.includes('Observed Claude process has no unique instrumented child owner'));
    auditRevision = { reason: 'The original audit required every observed Claude process to be a wrapper direct child. Native descendants now require complete birth-verified ancestry to an instrumented root; no request or child-argument equivalence is inferred.',
      launchAuditor: value, archivedAuditor: { path: original.copy, sha256: original.sha256 },
      currentAuditor: { path: __filename, sha256: fileSha(__filename) },
      postExitIdentityCheck: { path: postExitPath, sha256: fileSha(postExitPath) },
      preservedFailure: { path: originalFailurePath, sha256: fileSha(originalFailurePath) } };
  });
  for (const file of [auxiliary.launcher, auxiliary.runtime]) { contained(owner.directory, file); assert(pins.some(value => value.path === fs.realpathSync(file))); }
  assert.equal(auxiliary.helperIdentity.path, path.join(repo, 'src/utils/textOnlyClaudeWorker.ts'));
  assert.equal(read(manifest.sourceIdentity.path).files['src/utils/textOnlyClaudeWorker.ts'], auxiliary.helperIdentity.sha256);
  const nativeEvidence = one(read(auxiliary.flagEvidenceIdentity.path).executables.filter(value => value.sha256 === auxiliary.executableIdentity.sha256), 'Exact native flag-evidence executable');
  assert.equal(fs.realpathSync(nativeEvidence.path), auxiliary.executableIdentity.path);
  for (const term of ['--tools <tools...>', '--strict-mcp-config', '--mcp-config <configs...>', '--setting-sources <sources>', '--safe-mode', '--no-session-persistence', 'disableAllHooks']) {
    assert(nativeEvidence.staticParserEvidence.some(value => value.term === term));
  }
  const settings = read(path.join(owner.profile, 'User/settings.json'));
  assert.equal(settings[auxiliary.routingSetting], auxiliary.launcher);
  assert.equal(settings['mysti.defaultAgent'], 'openai-codex'); assert.equal(settings['mysti.showSuggestions'], false);
  assert.notEqual(settings['mysti.planDetection.enabled'], false, 'Cannot suppress workers to manufacture zero-input evidence');
  assert.equal(read(path.join(directory, 'native-result.json')).status, 'PASS');
  const exit = read(path.join(owner.directory, 'editor-exit.json'));
  assert.equal(exit.code, 0); assert.equal(exit.signal, null); assert.equal(exit.timedOut, false); assert.equal(exit.helper.normalQuitRequested, true);
  for (const file of ['watchdog-failure.json', 'driver-fatal.json', 'window-A/forced-cleanup.json']) assert(!fs.existsSync(path.join(directory, file)));
  assert(Array.isArray(owner.auxiliaryReceiptPaths) && owner.auxiliaryReceiptPaths.length === 1);
  const lines = paths => paths.flatMap(file => { contained(owner.directory, file); return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse); });
  const receipts = lines(owner.auxiliaryReceiptPaths), primary = lines(owner.receiptPaths);
  assert(owner.auxiliaryReceiptPaths.every(file => !owner.receiptPaths.includes(file)), 'Receipt lanes must remain distinct');
  contained(owner.directory, auxiliary.counterFile); assert(!fs.existsSync(auxiliary.counterFile + '.lock'));
  const counter = fs.existsSync(auxiliary.counterFile) ? read(auxiliary.counterFile) : { forwardedInputs: 0, maxInputs: 12 };
  const ancestry = read(path.join(owner.directory, 'process-ancestry.json')), cleanup = read(path.join(owner.directory, 'editor-exit-process-check.json'));
  const live = execFileSync('ps', ['-axo', 'pid=,lstart='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/); assert(match); return { pid: +match[1], startedAt: match[2] };
  });
  const result = auditEvidence({ auxiliary, receipts, ancestry, cleanup, counter, live,
    primaryAuxiliaryInputs: primary.filter(value => value.event === 'auxiliary-input').length,
    temporaryRoot: fs.realpathSync(os.tmpdir()) });
  result.remainingPrivateDirectories = result.temporaryDirectories.filter(file => fs.existsSync(file));
  // Best-effort directory removal may lose its callback as the extension host
  // exits. Report remaining empty directories; never reinterpret them as live processes.
  for (const file of result.remainingPrivateDirectories) {
    assert(!fs.lstatSync(file).isSymbolicLink()); assert.deepEqual(fs.readdirSync(file), [], 'Private worker left unexpected files');
  }
  return { status: 'PASS_AUXILIARY_RESTRICTIONS_AND_ACCOUNTING', directory, at: new Date().toISOString(), ...result,
    primaryAudit: { path: path.join(directory, 'independent-audit.json'), sha256: fileSha(path.join(directory, 'independent-audit.json')) },
    pins, auditRevision, receiptIdentities: owner.auxiliaryReceiptPaths.map(file => ({ path: file, sha256: fileSha(file) })) };
}
module.exports = { auditEvidence, auditArtifacts, EXPECTED_ARGS };
if (require.main === module) {
  const directory = path.resolve(process.env.MYSTI_PB02_ARTIFACT_DIR || path.join(root, 'native-stage1'));
  let result;
  try { result = auditArtifacts(directory); }
  catch (error) { result = { status: 'FAIL', directory, at: new Date().toISOString(), error: { name: error.name, message: error.message } }; process.exitCode = 1; }
  let file = path.join(directory, 'auxiliary-independent-audit.json');
  if (fs.existsSync(file)) file = path.join(directory, `auxiliary-independent-audit-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: result.status, file, counts: result.counts, error: result.error }));
}
