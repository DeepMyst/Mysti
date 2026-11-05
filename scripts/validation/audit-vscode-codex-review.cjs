/* PB-02 peer-repair independent artifact acceptance. Never launches an editor/model. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readStoredConversations, messageProjection, toolProjection } = require('./audit-vscode-claude.cjs');
const { exactCommand, patchScope, expected, scopes, assertSourceRepair, verifyPreservedBase } = require('./codex-review-contract.cjs');
const { assertToolOutputProjection } = require('./codex-full-oracle.cjs');
const { auditEvidence: auditAuxiliary } = require('./codex-review-auxiliary.cjs');
const os = require('node:os');
const repo = path.resolve(__dirname, '../..');
const root = path.join(repo, 'out-test/feature-tests/PB-02');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');
const hash = file => digest(fs.readFileSync(file));
const clean = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const ORIGINAL_PEER_AUDITOR_SHA = 'b0509159dfa5399bd0b72b23ec47d3d2154f85cba385a9d8543f30ce272a13f7';
function contained(parent, file) {
  const relative = path.relative(parent, file);
  assert(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'Expected an owned artifact path');
}
function one(values, label) { assert.equal(values.length, 1, label); return values[0]; }
function identity(value) {
  assert(value && typeof value.path === 'string' && /^[a-f0-9]{64}$/.test(value.sha256));
  assert.equal(hash(value.path), value.sha256, `Pinned identity changed: ${value.path}`);
}
function permittedTool(tool, scope, workspace) {
  const name = String(tool.name).toLowerCase(), input = tool.input || {};
  return name === 'bash' && input.cwd === workspace && (scope.commands || []).some(command => exactCommand(input.command, command))
    || name === 'edit' && scope.patch && patchScope(input.changes, workspace, scope.patch);
}

function auditCommon(directory) {
  contained(root, directory);
  const manifest = read(path.join(directory, 'prepared.json'));
  assert.equal(manifest.case, 'PB-02'); assert.equal(manifest.stage, 'PEER_REVIEW_REPAIR');
  assert.equal(manifest.artifactDir, directory); assert.equal(manifest.preparedBeforeActivation, true);
  assert.deepEqual(Object.keys(manifest.windows), ['A']); assert.equal(manifest.plannedSuccessfulTurns, 3); assert.equal(manifest.maxForwardedInputs, 3);
  const owner = manifest.windows.A;
  contained(directory, owner.directory); contained(owner.directory, owner.workspace);
  contained(fs.realpathSync(path.join(repo, '.vscode-test/profiles')), fs.realpathSync(owner.profile));
  assert.deepEqual(read(path.join(owner.profile, '.mysti-test-owned.json')), { case: 'PB-02', profile: fs.realpathSync(owner.profile), window: 'A' });
  assert.equal(manifest.fixture.workspace, owner.workspace);
  assert.equal(manifest.model, 'gpt-5.6-sol');
  contained(root, fs.realpathSync(manifest.compiledDirectory));
  verifyPreservedBase(manifest.fixture);
  const pinned = [...Object.values(manifest.executableIdentities), ...manifest.wrapperIdentities, ...manifest.harnessDependencyIdentities,
    manifest.nodeIdentity, manifest.readiness, manifest.sourceIdentity, manifest.packageIdentity];
  let auditRevision;
  pinned.forEach(value => {
    if (value.path !== __filename || hash(__filename) === value.sha256) { identity(value); return; }
    // Permit this one evidenced post-run auditor correction only. Launch pins,
    // product files, wrappers, compiled harness and original failed report stay immutable.
    assert.equal(value.sha256, ORIGINAL_PEER_AUDITOR_SHA, 'Unexpected previous peer auditor');
    const archiveDirectory = path.join(directory, 'original-harness');
    const archive = read(path.join(archiveDirectory, 'identities.json'));
    assert.equal(archive.preparedBeforeActivation, true);
    const original = one(archive.files.filter(entry => entry.source === __filename), 'Original auditor archive entry');
    assert.equal(original.sha256, value.sha256);
    assert.equal(original.copy, path.join(archiveDirectory, 'scripts__validation__audit-vscode-codex-review.cjs'));
    identity({ path: original.copy, sha256: original.sha256 });
    const postExitPath = path.join(directory, 'post-exit-identity-check.json'), postExit = read(postExitPath);
    assert.equal(postExit.status, 'PASS_POST_EXIT_IDENTITIES');
    assert.deepEqual(postExit.pins, pinned, 'Complete launch pins must match the pre-correction check');
    assert.deepEqual(postExit.sourceIdentity, manifest.sourceIdentity); assert.deepEqual(postExit.packageIdentity, manifest.packageIdentity);
    assert.equal(postExit.preparedIdentity.path, path.join(directory, 'prepared.json')); identity(postExit.preparedIdentity);
    const failurePath = path.join(directory, 'independent-audit.json'), failure = read(failurePath);
    assert.equal(postExit.originalFailureIdentity.path, failurePath); identity(postExit.originalFailureIdentity);
    assert.equal(failure.status, 'FAIL'); assert.equal(failure.auditorSha256, ORIGINAL_PEER_AUDITOR_SHA);
    assert(failure.error.message.includes("+   'test/retry.test.cjs'"), 'Only the evidenced pre-existing diff mismatch permits this revision');
    auditRevision = {
      reason: 'Original auditor assumed that src/retry.cjs was the only unstaged file. The preserved full25 copy already had an unstaged test file. Expected diff paths now derive from the unchanged original workspace plus the approved source repair; exact copied-file byte and staged-index checks are unchanged.',
      launchAuditor: value, archivedAuditor: { path: original.copy, sha256: original.sha256 },
      currentAuditor: { path: __filename, sha256: hash(__filename) },
      postExitIdentityCheck: { path: postExitPath, sha256: hash(postExitPath) },
      preservedFailure: postExit.originalFailureIdentity,
    };
  });
  assert(pinned.some(value => value.path === require.resolve('./audit-vscode-claude.cjs')), 'Shared pure transcript helpers must be pinned');
  const source = read(manifest.sourceIdentity.path), artifact = read(manifest.packageIdentity.path);
  assert.equal(artifact.sourceSnapshotUnchanged, true); assert.equal(artifact.bundleSha256, manifest.bundleSha256); assert.equal(artifact.chatSha256, manifest.chatSha256);
  assert.equal(fs.realpathSync(artifact.extension), fs.realpathSync(manifest.sourcePackage));
  assert.equal(hash(artifact.archive), artifact.sha256); assert.equal(fs.statSync(artifact.archive).size, artifact.bytes);
  for (const [relative, sha256] of Object.entries(source.files)) {
    const absolute = path.resolve(repo, relative); contained(repo, absolute); assert.equal(hash(absolute), sha256, `Frozen source changed: ${relative}`);
  }
  for (const extension of [manifest.sourcePackage, owner.installedExtension]) {
    const metadata = read(path.join(extension, 'package.json'));
    assert.equal(metadata.name, 'mysti'); assert.equal(metadata.publisher.toLowerCase(), 'deepmyst');
    assert.equal(hash(path.join(extension, 'dist/extension.js')), manifest.bundleSha256);
    assert.equal(hash(path.join(extension, 'media/chat/chat.js')), manifest.chatSha256);
  }
  const reservation = read(path.join(directory, 'launch-reservation.json'));
  assert.equal(reservation.plannedConversationRequests, 3);
  assert.equal(hash(path.join(manifest.compiledDirectory, 'codex-review.test.js')), reservation.harnessSha256);
  assert.equal(hash(path.join(manifest.compiledDirectory, 'codex-review-observer.js')), reservation.observerSha256);
  assert.equal(hash(path.join(manifest.helper, 'extension.cjs')), reservation.helperSha256);
  const launch = read(path.join(owner.directory, 'launch.json'));
  assert.equal(launch.profile, owner.profile); assert.equal(launch.installedExtension, owner.installedExtension);
  assert.equal(launch.extensionTestsPathUsed, false); assert(launch.args.every(argument => !/extensionTestsPath/i.test(argument)));
  for (const argument of [`--user-data-dir=${owner.profile}`, `--extensions-dir=${owner.extensionsDir}`, owner.workspace]) assert(launch.args.includes(argument));
  const ready = read(path.join(owner.directory, 'helper-ready.json'));
  assert.equal(ready.extensionTestsPathUsed, false); assert.equal(ready.profile, owner.profile);
  assert([false, 'NOT_EXPOSED_BY_PUBLIC_API'].includes(ready.productUnderDevelopment));
  const registry = read(path.join(owner.directory, 'registry-readiness.json'));
  assert.equal(registry.pathMatches, true); assert.equal(registry.actualPath, fs.realpathSync(owner.installedExtension));
  assert.equal(read(path.join(directory, 'native-result.json')).status, 'PASS');
  const exit = read(path.join(owner.directory, 'editor-exit.json'));
  assert.equal(exit.code, 0); assert.equal(exit.signal, null); assert.equal(exit.timedOut, false);
  assert.equal(exit.helper.failures, 0); assert.equal(exit.helper.normalQuitRequested, true); assert.deepEqual(exit.helper.testFailures, []);
  for (const relative of ['watchdog-failure.json', 'driver-fatal.json', 'window-A/forced-cleanup.json', 'window-A/driver-error.json']) assert(!fs.existsSync(path.join(directory, relative)));
  const receipts = owner.receiptPaths.flatMap(file => {
    contained(owner.directory, file); return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  });
  for (const receipt of receipts) {
    assert.equal(receipt.provider, 'openai-codex'); assert.equal(receipt.window, 'A');
    assert(Number.isSafeInteger(receipt.wrapperPid) && receipt.wrapperPid > 0 && Number.isFinite(receipt.at));
    assert(!/refusal|instrumentation-error|launch-error|unexpected-tool-item/.test(receipt.event), 'Instrumentation failure, unsupported native tool or cap refusal preserves a failed attempt');
  }
  const inputs = receipts.filter(value => value.event === 'request');
  assert.equal(receipts.filter(value => value.event === 'auxiliary-input').length, 0, 'Only the separately capped Claude auxiliary lane is accepted');
  assert.deepEqual(inputs.map(value => value.inputIndex), [1, 2, 3]);
  assert.deepEqual(read(manifest.counterFile), { forwardedInputs: 3, maxInputs: 3 }); assert(!fs.existsSync(manifest.counterFile + '.lock'));
  const cleanup = read(path.join(owner.directory, 'editor-exit-process-check.json'));
  assert.equal(cleanup.status, 'PASS_OBSERVED_IDENTITIES_EXITED'); assert.deepEqual(cleanup.remaining, []); assert.deepEqual(cleanup.unverifiedLiveReceiptPids, []);
  assert.equal(cleanup.conversationalInputs, 3); assert.equal(cleanup.auxiliaryInputs, receipts.filter(value => value.event === 'auxiliary-input').length);
  const ancestry = read(path.join(owner.directory, 'process-ancestry.json'));
  assert(ancestry.processIdentities.length > 0); assert.equal(ancestry.sampleIntervalMs, 250); assert.equal(cleanup.observedIdentityCount, ancestry.processIdentities.length);
  const live = new Map(execFileSync('ps', ['-axo', 'pid=,lstart='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/); assert(match); return [+match[1], match[2]];
  }));
  for (const process of ancestry.processIdentities) assert.notEqual(live.get(process.pid), process.startedAt, `Observed process still alive: ${process.pid}`);
  for (const receipt of receipts) for (const pid of [receipt.wrapperPid, receipt.childPid].filter(Boolean)) {
    if (!live.has(pid)) continue;
    const prior = ancestry.processIdentities.filter(value => value.pid === pid);
    assert(prior.length && prior.every(value => value.startedAt !== live.get(pid)) || Date.parse(live.get(pid)) > receipt.at, `Unverified living receipt PID: ${pid}`);
  }
  return { manifest, owner, receipts, inputs, ancestry, pinned, reservation, source, artifact, auditRevision };
}

function auditWorkspace(common, acceptance) {
  const { manifest, owner } = common, fixture = manifest.fixture, hashes = {};
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (directory === owner.workspace && entry.name === '.git') continue;
      const file = path.join(directory, entry.name); assert(!entry.isSymbolicLink());
      if (entry.isDirectory()) visit(file); else { assert(entry.isFile()); hashes[path.relative(owner.workspace, file)] = hash(file); }
    }
  }
  visit(owner.workspace);
  for (const [relative, original] of Object.entries(fixture.files)) {
    assert(hashes[relative], 'Every original fixture file remains');
    if (relative !== 'src/retry.cjs') assert.equal(hashes[relative], original.sha256, `Unapproved file changed: ${relative}`);
  }
  const source = fs.readFileSync(path.join(owner.workspace, 'src/retry.cjs'), 'utf8');
  const original = fixture.files['src/retry.cjs'].text;
  assertSourceRepair(Buffer.from(original), Buffer.from(source));
  verifyPreservedBase(fixture);
  assert.equal(source.split(fixture.unstagedNote).length, 2); assert.equal(fs.readFileSync(path.join(owner.workspace, 'README.md'), 'utf8').split(fixture.stagedNote).length, 2);
  const extras = Object.keys(hashes).filter(relative => !Object.hasOwn(fixture.files, relative));
  const segment = acceptance.panelId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120); assert(segment && !/^_+$/.test(segment));
  const history = `.mysti/compaction/${segment}/history.jsonl`;
  for (const relative of extras) {
    const bytes = fs.readFileSync(path.join(owner.workspace, relative), 'utf8');
    if (relative === '.mysti/compaction/.gitignore') assert.equal(bytes, '*\n');
    else {
      assert.equal(relative, history, 'Only the exact owned panel history may be added');
      const rows = bytes.split('\n').filter(Boolean).map(line => JSON.parse(line)); assert(rows.length > 0);
      rows.forEach((row, index) => {
        assert.equal(row.seq, index + 1); assert(Number.isFinite(row.ts)); assert(['user', 'assistant', 'system'].includes(row.role));
        assert(['text', 'tool_use', 'tool_result'].includes(row.kind)); assert.equal(typeof row.content, 'string'); assert(Number.isFinite(row.tokensEst) && row.tokensEst >= 0);
        assert(row.msgId === undefined || typeof row.msgId === 'string'); assert(Object.keys(row).every(key => ['seq', 'ts', 'role', 'kind', 'content', 'tokensEst', 'msgId'].includes(key)));
      });
    }
  }
  const git = (args, cwd = owner.workspace) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.equal(git(['ls-files', '--stage']), fixture.originalIndex);
  assert.equal(git(['ls-files', '--stage'], fixture.base.originalWorkspace), fixture.originalIndex);
  const baselineUnstagedPaths = git(['diff', '--name-only', '-z'], fixture.base.originalWorkspace).split('\0').filter(Boolean).sort();
  assert(baselineUnstagedPaths.every(relative => Object.hasOwn(fixture.files, relative)), 'Baseline diffs must belong to exact copied fixture files');
  const expectedUnstagedPaths = [...new Set([...baselineUnstagedPaths, 'src/retry.cjs'])].sort();
  assert.deepEqual(git(['diff', '--name-only', '-z']).split('\0').filter(Boolean).sort(), expectedUnstagedPaths);
  assert.deepEqual(acceptance.files.hashes, hashes);
  assert.deepEqual(acceptance.files.productArtifacts.map(value => value.relative).sort(), extras.sort());
  for (const item of acceptance.files.productArtifacts) assert.equal(item.sha256, hashes[item.relative]);
  for (const flag of ['indexUnchanged', 'canaryUnchanged', 'preservedNotes']) assert.equal(acceptance.files[flag], true);
  return { hashes, productArtifacts: extras, baselineUnstagedPaths, expectedUnstagedPaths,
    stagedIndexSha256: digest(fixture.originalIndex), status: git(['status', '--porcelain=v1', '--untracked-files=all']) };
}

function turnWire(common, input) {
  const start = common.receipts.indexOf(input);
  const next = common.receipts.findIndex((value, index) => index > start && value.event === 'request' && value.wrapperPid === input.wrapperPid);
  return common.receipts.slice(start, next === -1 ? undefined : next).filter(value => value.wrapperPid === input.wrapperPid);
}
function auditJourney(common, acceptance, stored) {
  const { owner, manifest, inputs, receipts } = common;
  assert(!receipts.some(value => value.event === 'unexpected-tool-item'), 'Unexpected native tools cannot disappear from acceptance');
  const observations = read(path.join(owner.directory, 'observations.json'));
  const events = read(path.join(owner.directory, 'events-main.json'));
  assert.equal(acceptance.status, 'PASS_PEER_REPAIR_TRANSPORT'); assert.equal(acceptance.stage, 'PEER_REVIEW_REPAIR');
  assert.equal(acceptance.remainingFull25AndExtendedCoverage, 'NOT_RUN');
  assert.equal(acceptance.counts.completedTurns, 3); assert.equal(acceptance.counts.conversationalInputs, 3);
  assert.equal(acceptance.counts.auxiliaryInputs, receipts.filter(value => value.event === 'auxiliary-input').length);
  assert.equal(typeof acceptance.sourceId, 'string'); assert(acceptance.sourceId.length > 0);
  assert.equal(typeof acceptance.panelId, 'string'); assert(acceptance.panelId.length > 0);
  assert(events.some(value => value.type === 'initialState' && value.payload.panelId === acceptance.panelId));
  const conversation = one(stored.conversations.filter(value => value.id === acceptance.sourceId), 'Exactly one owned disk conversation');
  assert.equal(acceptance.finalConversation.id, conversation.id);
  assert.deepEqual(conversation.messages.map(messageProjection), acceptance.finalConversation.messages.map(messageProjection));
  assert.equal(new Set(conversation.messages.map(value => value.id)).size, conversation.messages.length);
  assert.deepEqual(acceptance.replies.map(value => value.marker), expected);
  assert.deepEqual(conversation.messages.filter(value => value.role === 'assistant').map(value => value.id), acceptance.replies.map(value => value.messageId), 'Exact three assistant messages, in order, with no phantom completion');
  assert.equal(conversation.messages.filter(value => value.role === 'user').length, 3);
  assert.equal(events.filter(value => value.type === 'responseComplete').length, 3);
  for (const foreign of stored.conversations.filter(value => value.id !== acceptance.sourceId)) assert(!foreign.messages.some(value => ['user', 'assistant'].includes(value.role)), 'Fresh peer-review run cannot contain unaccounted conversational work');
  const sessionHashes = new Set(), turnHashes = new Set();
  const proofs = acceptance.replies.map((reply, index) => {
    const scope = scopes[reply.marker], input = inputs[index];
    assert.equal(reply.ordinal, index + 1); assert.equal(reply.panelId, acceptance.panelId); assert.equal(reply.conversationId, acceptance.sourceId);
    assert.equal(reply.provider, 'openai-codex'); assert.equal(reply.model, manifest.model); assert.deepEqual(reply.request, input);
    assert(input.outsideMemoryMarkers.includes(reply.marker));
    assert(input.outsideMemoryMarkers.every(marker => expected.slice(0, index + 1).includes(marker)), 'No future or foreign request marker may contaminate this turn');
    assert.equal(input.model, manifest.model); assert.equal(input.effort, 'low');
    const nativeSession = common.receipts.filter(value => value.event === 'session' && value.wrapperPid === input.wrapperPid && value.at <= input.at).at(-1);
    assert(nativeSession && ['thread/start', 'thread/resume'].includes(nativeSession.method), 'Each request needs an acknowledged actual native session');
    assert.equal(nativeSession.sessionHash, input.sessionHash);
    assert.equal(nativeSession.actualModel, manifest.model, 'Native thread/start and resume must acknowledge the selected model');
    assert.equal(typeof nativeSession.modelProvider, 'string'); assert(nativeSession.modelProvider.length > 0);
    assert.equal(nativeSession.returnedPolicy.approvalPolicy, 'untrusted'); assert.equal(nativeSession.returnedPolicy.sandbox, 'readOnly');
    assert.equal(nativeSession.returnedPolicy.ownedCwd, true); assert.notEqual(nativeSession.returnedPolicy.networkAccess, true);
    assert.deepEqual(reply.nativeSession, nativeSession);
    const effectiveTools = common.receipts.filter(value => value.event === 'effective-tool-config' && value.wrapperPid === input.wrapperPid && value.at <= input.at).at(-1);
    assert(effectiveTools, 'The actual effective configuration must precede session setup');
    assert.deepEqual(input.policy.mcpNames, effectiveTools.mcpNames, 'Every configured MCP server must receive an explicit disable override');
    assert.deepEqual(input.policy.appNames, effectiveTools.appNames, 'Every configured app must receive an explicit disable override');
    assert.equal(input.policy.effort, input.effort);
    for (const key of ['ownedCwd', 'mcpAllDisabled', 'appsAllDisabled', 'appsDefaultDisabled']) assert.equal(input.policy[key], true);
    assert.equal(input.policy.approvalPolicy, 'untrusted'); assert.equal(input.policy.sandbox, 'read-only');
    assert(input.at >= reply.started && input.at <= reply.completedAt);
    if (index) assert(reply.started >= acceptance.replies[index - 1].completedAt);
    const terminal = one(events.filter(value => value.type === 'responseComplete' && value.payload?.message?.id === reply.messageId), 'One actual public completion per reply');
    assert.equal(terminal.at, reply.completedAt); assert.equal(terminal.payload.message.content, reply.content);
    assert.deepEqual(clean((terminal.payload.message.toolCalls || []).map(toolProjection)), clean(reply.tools.map(toolProjection)));
    assert.deepEqual(clean(terminal.payload.message.usage), clean(reply.usage));
    const saved = one(conversation.messages.filter(value => value.id === reply.messageId), 'Response persisted exactly once');
    assert.deepEqual(messageProjection(saved), messageProjection(terminal.payload.message));
    assert.equal(saved.provider, 'openai-codex'); assert.equal(saved.model, manifest.model);
    assert(reply.content.includes(`PB02_DONE:${reply.marker}`));
    const interval = events.filter(value => value.at >= reply.started && value.at <= reply.completedAt);
    assert(interval.some(value => value.type === 'responseStarted'));
    assert(!interval.some(value => ['error', 'authError', 'requestCancelled'].includes(value.type)));
    const recorded = one(observations.filter(value => value.event === 'native-response' && value.marker === reply.marker), 'One matching harness observation');
    for (const key of Object.keys(reply)) assert.deepEqual(recorded[key], reply[key]);
    const wire = turnWire(common, input).filter(value => value.at <= reply.completedAt);
    const started = one(wire.filter(value => value.event === 'turn-started' && value.inputIndex === input.inputIndex), 'Native turn/start acknowledged');
    const completed = one(wire.filter(value => value.event === 'turn-completed'), 'One successful native terminal');
    assert.equal(started.sessionHash, input.sessionHash); assert.equal(completed.sessionHash, input.sessionHash);
    assert(/^[a-f0-9]{64}$/.test(started.turnHash)); assert.equal(completed.turnHash, started.turnHash); assert.equal(completed.status, 'completed');
    assert.equal(completed.inputIndex, input.inputIndex); assert.deepEqual(reply.turnCompleted, completed);
    assert(!wire.some(value => value.event === 'native-error' && !value.willRetry));
    assert(!wire.some(value => value.event === 'rpc-result' && value.success !== true));
    sessionHashes.add(input.sessionHash); assert(!turnHashes.has(started.turnHash)); turnHashes.add(started.turnHash);
    const nativeTools = wire.filter(value => ['tool-start', 'tool-result'].includes(value.event));
    assert.deepEqual(reply.nativeTools, nativeTools);
    const results = nativeTools.filter(value => value.event === 'tool-result');
    assert.equal(results.length, reply.tools.length, 'Every native tool result must appear once in the public transcript');
    const verified = reply.tools.map(tool => {
      assert(permittedTool(tool, scope, owner.workspace), `Actual ${tool.name} exceeds the exact stage-one scope`);
      const result = one(results.filter(value => value.itemIdHash === digest(tool.id)), 'Native item ID owns exactly one public result');
      assert.equal(result.sessionHash, input.sessionHash); assert.equal(result.turnHash, started.turnHash);
      assert.equal(result.inputIndex, input.inputIndex);
      const live = one(interval.filter(value => value.type === 'toolResult' && value.payload?.id === tool.id), 'Exact live tool result');
      const projection = assertToolOutputProjection({ nativeResult: result, liveTool: live.payload, persistedTool: tool });
      assert.deepEqual(one(reply.toolOutputEvidence.filter(value => value.itemId === tool.id), 'Recorded output projection'), projection);
      assert(nativeTools.some(value => value.event === 'tool-start' && value.itemIdHash === result.itemIdHash && value.type === result.type && value.sessionHash === result.sessionHash && value.turnHash === result.turnHash));
      const denied = false;
      assert.equal(tool.status, denied ? 'failed' : 'completed');
      if (denied) assert.notEqual(result.status, 'completed'); else assert.equal(result.status, 'completed');
      if (String(tool.name).toLowerCase() === 'bash') {
        assert.equal(result.type, 'commandExecution'); assert.equal(result.commandSha256, digest(JSON.stringify(tool.input.command)));
        assert.equal(result.ownedCwd, true); assert.equal(result.exitCode, 0);
      } else {
        assert.equal(result.type, 'fileChange');
        assert.deepEqual(result.changes, tool.input.changes.map(change => ({ relativePath: path.relative(owner.workspace, path.resolve(owner.workspace, change.path)), kind: change.kind.type, diffSha256: digest(change.diff) })));
      }
      return { tool, result };
    });
    if (scope.required) assert(verified.some(value => value.result.type === scope.required && value.result.status === 'completed'));
    if (reply.marker === 'PEER_TESTS') assert(verified.some(({ tool, result }) => result.type === 'commandExecution'
      && exactCommand(tool.input.command, 'node --test test/retry.test.cjs') && /# fail 0\b/.test(tool.output) && result.exitCode === 0), 'The same actual test command must produce the successful output');
    const user = conversation.messages[conversation.messages.indexOf(saved) - 1];
    assert.equal(user?.role, 'user'); assert(user.content.includes(`PB02_REQUEST:${reply.marker}`));
    return { marker: reply.marker, inputIndex: input.inputIndex, messageId: reply.messageId, contentSha256: digest(reply.content),
      actualModel: nativeSession.actualModel, turnHash: started.turnHash, nativeToolIds: results.map(value => value.itemIdHash) };
  });
  assert.equal(sessionHashes.size, 1, 'Three replies belong to one fresh peer thread');
  return { observations, events, conversation, proofs };
}

function auditPermissions(common, acceptance, journey) {
  const publicRequests = journey.events.filter(value => value.type === 'permissionRequest');
  const decisions = journey.observations.filter(value => value.event === 'permission-decision');
  assert.equal(new Set(publicRequests.map(value => value.payload.id)).size, publicRequests.length);
  assert.equal(new Set(decisions.map(value => value.id)).size, decisions.length);
  const requests = common.receipts.filter(value => value.event === 'approval-request');
  const responses = common.receipts.filter(value => value.event === 'approval-decision');
  const paired = new Set(), usedResponses = new Set();
  const proofs = publicRequests.map(publicRequest => {
    const request = publicRequest.payload, details = request.details;
    const decision = one(decisions.filter(value => value.id === request.id), 'Every public native permission is explicitly answered once');
    assert.equal(decision.name, String(details.toolName).toLowerCase()); assert.deepEqual(decision.input, details.toolInput);
    assert.equal(decision.inputSha256, digest(JSON.stringify(details.toolInput))); assert(decision.at >= publicRequest.at);
    const reply = one(acceptance.replies.filter(value => value.permissionDecisionIds.includes(request.id)), 'One owning reply per public permission');
    const input = common.inputs.find(value => value.inputIndex === reply.request.inputIndex);
    assert(publicRequest.at >= reply.started && decision.at <= reply.completedAt);
    const matches = requests.filter(value => !paired.has(value) && value.wrapperPid === input.wrapperPid && value.inputIndex === input.inputIndex
      && value.toolInputSha256 === decision.inputSha256 && value.at <= publicRequest.at);
    const native = one(matches, 'Public card must uniquely join actual native approval input bytes'); paired.add(native);
    assert.equal(native.sessionHash, input.sessionHash); assert.equal(native.turnHash, reply.turnCompleted.turnHash);
    const response = one(responses.filter(value => value.wrapperPid === native.wrapperPid && value.inputIndex === native.inputIndex
      && value.nativeRequestIdHash === native.nativeRequestIdHash && common.receipts.indexOf(value) > common.receipts.indexOf(native)), 'One native response to the original request ID');
    assert(!usedResponses.has(response)); usedResponses.add(response);
    // The wrapper may observe the answer before the test resumes after click.
    assert(response.at >= publicRequest.at && response.at <= reply.completedAt);
    assert.equal(response.decision, decision.approved ? 'accept' : 'decline');
    const scope = scopes[reply.marker]; assert(permittedTool({ name: decision.name, input: decision.input }, scope, common.owner.workspace));
    const denied = false;
    assert.equal(decision.expectedDenial, denied); assert.equal(decision.approved, !denied);
    if (reply.marker === 'PEER_REPAIR' && decision.name === 'edit') {
      assert.equal(decision.beforeFiles.hashes['src/retry.cjs'], common.manifest.fixture.files['src/retry.cjs'].sha256,
        'The approved patch must still be unexecuted when the user grants permission');
    }
    assert.equal(native.method, decision.name === 'edit' ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval');
    const result = one(reply.nativeTools.filter(value => value.event === 'tool-result' && value.itemIdHash === native.itemIdHash), 'Approval owns the exact native item result');
    assert(common.receipts.indexOf(response) < common.receipts.indexOf(common.receipts.find(value => value === result || JSON.stringify(value) === JSON.stringify(result))), 'Tool completion must follow the actual native permission response');
    if (denied) assert.notEqual(result.status, 'completed'); else assert.equal(result.status, 'completed');
    for (const [relative, original] of Object.entries(common.manifest.fixture.files)) {
      if (relative !== 'src/retry.cjs') assert.equal(decision.beforeFiles.hashes[relative], original.sha256, 'Denied/unrelated files unchanged before permission');
    }
    return { publicId: request.id, nativeRequestIdHash: native.nativeRequestIdHash, itemIdHash: native.itemIdHash,
      inputIndex: input.inputIndex, decision: response.decision, inputSha256: decision.inputSha256 };
  });
  assert.equal(paired.size, requests.length, 'Every actual native approval request must be accounted for');
  assert.equal(usedResponses.size, responses.length, 'Every actual native approval decision must be accounted for');
  const patched = one(acceptance.replies.filter(value => value.marker === 'PEER_REPAIR'), 'Approved patch reply');
  assert(proofs.some(value => value.inputIndex === patched.request.inputIndex && value.decision === 'accept'
    && patched.nativeTools.some(tool => tool.type === 'fileChange' && tool.itemIdHash === value.itemIdHash)));
  return proofs;
}

function auditOracle(common, acceptance, workspace) {
  const results = acceptance.oracles.map(oracle => {
    contained(common.owner.directory, oracle.path);
    const report = read(oracle.path); assert.deepEqual(report, oracle.report);
    assert.equal(report.status, 'PASS'); assert.equal(report.failed, 0);
    assert.equal(report.sourceSha256, workspace.hashes['src/retry.cjs']); assert.equal(report.realProviderInputs, 0); assert.equal(report.fixtureSourceUnchanged, true);
    if (oracle.label === 'http-date') {
      assert.equal(report.passed, 45); assert.equal(report.expectedChecks, 45);
      assert.deepEqual(report.timezones, ['UTC', 'Asia/Amman', 'America/Los_Angeles']);
      assert.equal(report.runs.length, 3);
      assert.equal(report.oracleSha256, hash(path.join(__dirname, 'http-date-portability-oracle.cjs')));
      for (const [index, run] of report.runs.entries()) {
        assert.equal(run.timezone, report.timezones[index]); assert.equal(run.exitCode, 0); assert.equal(run.status, 'PASS');
        assert.equal(run.report.sourceSha256, report.sourceSha256); assert.equal(run.report.fixtureSourceUnchanged, true);
        assert.equal(run.report.checks.length, 15); assert(run.report.checks.every(check => check.status === 'PASS'));
      }
      assert.equal(report.networkRequests, 0); assert.equal(report.editorLaunches, 0);
    } else {
      assert.equal(oracle.label, 'full'); assert.equal(report.stage, 'full'); assert.equal(report.passed, 14); assert.equal(report.checks.length, 14);
      assert(report.checks.every(check => check.status === 'PASS')); assert.deepEqual(report.network, ['owned loopback HTTP only']);
    }
    return { label: oracle.label, passed: report.passed, sourceSha256: report.sourceSha256, artifactSha256: hash(oracle.path) };
  });
  assert.deepEqual(results.map(value => value.label), ['http-date', 'full']); return results;
}
function auditAuxiliaryArtifacts(common) {
  const { manifest, owner } = common, auxiliary = manifest.auxiliary;
  assert.equal(auxiliary.maxInputs, 8); assert.equal(auxiliary.routingSetting, 'mysti.claudeCodePath');
  const settings = read(path.join(owner.profile, 'User/settings.json'));
  assert.equal(settings[auxiliary.routingSetting], auxiliary.launcher); assert.equal(settings['mysti.codexPath'], owner.wrappers['openai-codex']);
  assert.notEqual(settings['mysti.planDetection.enabled'], false);
  assert.equal(settings['mysti.defaultModel'], 'gpt-5.6-sol'); assert.equal(settings['mysti.codexProfile'], '');
  assert.equal(owner.auxiliaryReceiptPaths.length, 1); assert(!owner.receiptPaths.includes(owner.auxiliaryReceiptPaths[0]));
  const receipts = owner.auxiliaryReceiptPaths.flatMap(file => { contained(owner.directory, file); return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse); });
  const live = execFileSync('ps', ['-axo', 'pid=,lstart='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/); assert(match); return { pid: +match[1], startedAt: match[2] };
  });
  assert(!fs.existsSync(auxiliary.counterFile + '.lock'));
  const result = auditAuxiliary({ auxiliary, receipts, ancestry: common.ancestry,
    cleanup: read(path.join(owner.directory, 'editor-exit-process-check.json')),
    counter: fs.existsSync(auxiliary.counterFile) ? read(auxiliary.counterFile) : { forwardedInputs: 0, maxInputs: 8 },
    live, primaryAuxiliaryInputs: common.receipts.filter(value => value.event === 'auxiliary-input').length,
    temporaryRoot: fs.realpathSync(os.tmpdir()) });
  result.remainingPrivateDirectories = result.temporaryDirectories.filter(file => fs.existsSync(file));
  for (const file of result.remainingPrivateDirectories) { assert(!fs.lstatSync(file).isSymbolicLink()); assert.deepEqual(fs.readdirSync(file), []); }
  return result;
}

function audit(directory) {
  const common = auditCommon(directory), acceptance = read(path.join(common.owner.directory, 'acceptance.json'));
  const workspace = auditWorkspace(common, acceptance), stored = readStoredConversations(common.owner);
  const journey = auditJourney(common, acceptance, stored), permissions = auditPermissions(common, acceptance, journey);
  const oracle = auditOracle(common, acceptance, workspace), auxiliary = auditAuxiliaryArtifacts(common);
  verifyPreservedBase(common.manifest.fixture);
  return { status: 'PASS_PEER_REPAIR_TRANSPORT', checkedAt: new Date().toISOString(), auditorSha256: hash(__filename),
    auditRevision: common.auditRevision,
    preservedBase: common.manifest.fixture.base,
    sourceIdentity: common.manifest.sourceIdentity, packageIdentity: common.manifest.packageIdentity,
    bundleSha256: common.manifest.bundleSha256, chatSha256: common.manifest.chatSha256, pinnedIdentities: common.pinned,
    compiledJourneySha256: common.reservation.harnessSha256, observerSha256: common.reservation.observerSha256,
    receipts: common.owner.receiptPaths.map(file => ({ file, sha256: hash(file) })),
    evidenceSha256: Object.fromEntries(['acceptance.json', 'observations.json', 'events-main.json'].map(file => [file, hash(path.join(common.owner.directory, file))])),
    counts: acceptance.counts, auxiliary, replies: journey.proofs, permissions, oracle, workspace,
    disk: { database: stored.database, conversationId: journey.conversation.id, messageIds: journey.conversation.messages.map(value => value.id),
      projectionSha256: digest(JSON.stringify(journey.conversation.messages.map(messageProjection))) },
    observedProcessIdentitiesExited: common.ancestry.processIdentities.length, processSamplingMs: 250,
    semanticReview: 'ROOT_INDEPENDENT_REVIEW_REQUIRED', remainingFull25AndExtendedCoverage: 'NOT_RUN',
    elapsedCampaigns: { S: 'NOT_RUN', W: 'NOT_RUN', E: 'NOT_RUN', P: 'NOT_RUN' },
    scope: common.manifest.scope,
    limits: ['Root must independently review all three replies and the patch for semantic correctness.',
      'PID and birth cleanup verifies observed processes at 250ms sampling; processes entirely between samples can be missed.',
      'Remaining 25-turn baseline, revision, second panel, failure recovery, Read Only, Stop, attachments, named profiles, other operating systems and long profiles were not run in this stage.'] };
}
module.exports = { audit, auditCommon, auditWorkspace, auditJourney, auditPermissions, auditOracle, auditAuxiliaryArtifacts, permittedTool, turnWire };
if (require.main === module) {
  const directory = path.resolve(process.env.MYSTI_PB02_REVIEW_ARTIFACT_DIR || ''); contained(root, directory);
  const primary = path.join(directory, 'independent-audit.json');
  const output = fs.existsSync(primary) ? path.join(directory, `independent-audit-${Date.now()}.json`) : primary;
  try {
    const result = audit(directory); fs.writeFileSync(output, JSON.stringify(result, null, 2), { flag: 'wx' }); console.log(JSON.stringify(result));
  } catch (error) {
    const result = { status: 'FAIL', checkedAt: new Date().toISOString(), auditorSha256: hash(__filename),
      error: { name: error.name, message: error.message }, scope: 'PB-02 peer-repair read-only owned-artifact audit; no editor or model launch' };
    fs.writeFileSync(output, JSON.stringify(result, null, 2), { flag: 'wx' }); console.error(JSON.stringify(result)); process.exitCode = 1;
  }
}
