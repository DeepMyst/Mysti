/* PB-02 profile compatibility independent artifact acceptance. Never launches an editor/model. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readStoredConversations, messageProjection, toolProjection } = require('./audit-vscode-claude.cjs');
const { exactCommand, verifyPreservedBase, verifyCopiedFixture, verifyOwnedProfiles } = require('./codex-profile-validation-contract.cjs');
const expected = ['DEFAULT_A', 'DEFAULT_RECOVERY'];
const attemptMarkers = ['UNSUPPORTED_A', 'DEFAULT_A', 'UNSUPPORTED_PADDED_A', 'DEFAULT_RECOVERY'];
const scopes = { DEFAULT_A: { commands: ['cat README.md'] }, DEFAULT_RECOVERY: {} };
const UNSUPPORTED_PROFILE_MESSAGE = "This Codex CLI cannot use named profiles with Mysti's app-server connection. Clear mysti.codexProfile in Settings and retry to use your base Codex configuration. No model request was submitted.";
const { assertToolOutputProjection } = require('./codex-full-oracle.cjs');
const { auditEvidence: auditAuxiliary } = require('./codex-profile-compatibility-auxiliary.cjs');
const os = require('node:os');
const repo = path.resolve(__dirname, '../..');
const root = path.join(repo, 'out-test/feature-tests/PB-02');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');
const hash = file => digest(fs.readFileSync(file));
const clean = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
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
  return name === 'bash' && input.cwd === workspace && (scope.commands || []).some(command => exactCommand(input.command, command));
}

function auditCommon(directory) {
  contained(root, directory);
  const manifest = read(path.join(directory, 'prepared.json'));
  assert.equal(manifest.case, 'PB-02'); assert.equal(manifest.stage, 'PROFILE_COMPATIBILITY_2');
  assert.equal(manifest.artifactDir, directory); assert.equal(manifest.preparedBeforeActivation, true);
  assert.deepEqual(Object.keys(manifest.windows), ['A']); assert.equal(manifest.plannedSuccessfulTurns, 2); assert.equal(manifest.maxForwardedInputs, 3);
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
  pinned.forEach(identity);
  identity(manifest.profileFilesIdentity);
  assert.equal(manifest.profileValidation.controlOnly, false, 'Native acceptance cannot use synthetic profile fixtures');
  assert.deepEqual(manifest.profileValidation, read(manifest.profileFilesIdentity.path));
  assert.deepEqual(manifest.profileValidation, read(path.join(directory, 'profile-files.json')));
  verifyOwnedProfiles(manifest.profileValidation);
  for (const dependency of ['audit-vscode-claude.cjs', 'audit-vscode-codex-profile-compatibility.cjs', 'codex-profile-validation-contract.cjs',
    'codex-semantic-followup-contract.cjs', 'pb02-profile-compatibility-cli-runtime.cjs', 'codex-profile-compatibility-auxiliary.cjs', 'codex-full-oracle.cjs']) {
    assert(pinned.some(value => value.path === require.resolve('./' + dependency)), `Profile compatibility dependency must be pinned: ${dependency}`);
  }
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
  assert.equal(hash(path.join(manifest.compiledDirectory, 'codex-profile-compatibility.test.js')), reservation.harnessSha256);
  assert.equal(hash(path.join(manifest.compiledDirectory, 'codex-profile-compatibility-observer.js')), reservation.observerSha256);
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
  assert.deepEqual(inputs.map(value => value.inputIndex), [1, 2]);
  assert.deepEqual(read(manifest.counterFile), { forwardedInputs: 2, maxInputs: 3 }); assert(!fs.existsSync(manifest.counterFile + '.lock'));
  const cleanup = read(path.join(owner.directory, 'editor-exit-process-check.json'));
  assert.equal(cleanup.status, 'PASS_OBSERVED_IDENTITIES_EXITED'); assert.deepEqual(cleanup.remaining, []); assert.deepEqual(cleanup.unverifiedLiveReceiptPids, []);
  assert.equal(cleanup.conversationalInputs, 2); assert.equal(cleanup.auxiliaryInputs, receipts.filter(value => value.event === 'auxiliary-input').length);
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
  return { manifest, owner, receipts, inputs, ancestry, pinned, reservation, source, artifact };
}

function auditHistoryArtifacts(workspace, panelId, artifacts) {
  assert.equal(typeof panelId, 'string');
  const segment = panelId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120); assert(segment && !/^_+$/.test(segment));
  const history = `.mysti/compaction/${segment}/history.jsonl`;
  assert.equal(new Set(artifacts.map(value => value.relative)).size, artifacts.length);
  for (const item of artifacts) {
    assert(['.mysti/compaction/.gitignore', history].includes(item.relative), 'Only the current owned panel history may be added');
    const file = path.join(workspace, item.relative); contained(workspace, file);
    assert(!fs.lstatSync(file).isSymbolicLink()); assert.equal(hash(file), item.sha256);
    const bytes = fs.readFileSync(file, 'utf8');
    if (item.relative === '.mysti/compaction/.gitignore') { assert.equal(bytes, '*\n'); continue; }
    const rows = bytes.split('\n').filter(Boolean).map(line => JSON.parse(line)); assert(rows.length > 0);
    rows.forEach((row, index) => {
      assert.equal(row.seq, index + 1); assert(Number.isFinite(row.ts)); assert(['user', 'assistant', 'system'].includes(row.role));
      assert(['text', 'tool_use', 'tool_result'].includes(row.kind)); assert.equal(typeof row.content, 'string'); assert(Number.isFinite(row.tokensEst) && row.tokensEst >= 0);
      assert(row.msgId === undefined || typeof row.msgId === 'string'); assert(Object.keys(row).every(key => ['seq', 'ts', 'role', 'kind', 'content', 'tokensEst', 'msgId'].includes(key)));
    });
  }
}

function auditWorkspace(common, acceptance) {
  const fixture = common.manifest.fixture;
  assert.deepEqual(fixture.editableFiles, []);
  assert.equal(fixture.workspace, common.owner.workspace);
  verifyPreservedBase(fixture);
  assert.deepEqual(acceptance.preservedBase, fixture.base);
  const actual = verifyCopiedFixture(fixture, acceptance.panelId);
  auditHistoryArtifacts(common.owner.workspace, acceptance.panelId, actual.productArtifacts);
  assert.deepEqual(acceptance.files, actual, 'Every copied file and owned runtime addition must match the saved final snapshot');
  return actual;
}

function turnWire(common, input) {
  const start = common.receipts.indexOf(input);
  const next = common.receipts.findIndex((value, index) => index > start && value.event === 'request' && value.wrapperPid === input.wrapperPid);
  return common.receipts.slice(start, next === -1 ? undefined : next).filter(value => value.wrapperPid === input.wrapperPid);
}
function verifyTools(common, input, turnHash, tools, wire, scope, allowIncomplete = false, liveEvents) {
  const native = wire.filter(value => ['tool-start', 'tool-result'].includes(value.event));
  const results = native.filter(value => value.event === 'tool-result');
  const liveResults = liveEvents?.filter(value => value.type === 'toolResult');
  const ids = new Set();
  const verified = tools.map(persistedTool => {
    let tool = persistedTool;
    assert.equal(typeof tool.id, 'string'); assert(tool.id.length > 0); assert(!ids.has(tool.id)); ids.add(tool.id);
    assert(permittedTool(tool, scope, common.owner.workspace), `Tool ${tool.name} exceeds the declared turn scope`);
    assert.notEqual(tool.proposalOnly, true); assert.notEqual(tool.historicalOnly, true);
    const itemIdHash = digest(tool.id);
    const starts = native.filter(value => value.event === 'tool-start' && value.itemIdHash === itemIdHash);
    assert(starts.length > 0, 'Persisted tool must have an actual native start');
    for (const started of starts) {
      assert.equal(started.sessionHash, input.sessionHash); assert.equal(started.turnHash, turnHash); assert.equal(started.inputIndex, input.inputIndex);
    }
    const matches = results.filter(value => value.itemIdHash === itemIdHash);
    if (!matches.length && allowIncomplete) {
      assert.notEqual(tool.status, 'completed', 'Interrupted tool without result must never be labelled completed');
      return { tool, result: null };
    }
    const result = one(matches, 'Exactly one native result per persisted tool');
    assert.equal(result.sessionHash, input.sessionHash); assert.equal(result.turnHash, turnHash); assert.equal(result.inputIndex, input.inputIndex);
    let outputProjection;
    if (liveResults) {
      const liveTool = one(liveResults.filter(value => value.payload?.id === tool.id), 'One actual live output per persisted native item').payload;
      assert.equal(liveTool.name, tool.name); assert.equal(liveTool.status, tool.status); assert.deepEqual(liveTool.input, tool.input);
      outputProjection = assertToolOutputProjection({ nativeResult: result, liveTool, persistedTool });
      tool = liveTool;
    } else {
      // Pure receipt-only callers still need exact full output equality. Acceptance
      // paths below always supply the actual public events before persistence.
      assert.equal(result.outputSha256, digest(String(tool.output)), 'Public result bytes must match the actual native item');
    }
    const name = String(tool.name).toLowerCase();
    if (name === 'bash') {
      assert.equal(result.type, 'commandExecution'); assert.equal(result.commandSha256, digest(JSON.stringify(tool.input.command)));
      assert.equal(result.ownedCwd, true);
      if (!allowIncomplete) { assert.equal(result.status, 'completed'); assert.equal(result.exitCode, 0); assert.equal(tool.status, 'completed'); }
    } else {
      assert.equal(result.type, 'fileChange');
      assert.deepEqual(result.changes, tool.input.changes.map(change => ({ relativePath: path.relative(common.owner.workspace, path.resolve(common.owner.workspace, change.path)), kind: change.kind.type, diffSha256: digest(change.diff) })));
      if (scope.patch === 'deny' || scope.readonly || scope.holdPatch) {
        assert.notEqual(result.status, 'completed'); assert.notEqual(tool.status, 'completed');
      } else { assert.equal(result.status, 'completed'); assert.equal(tool.status, 'completed'); }
    }
    assert(starts.some(value => value.type === result.type));
    return { tool, result, ...(outputProjection ? { outputProjection } : {}) };
  });
  for (const event of liveResults || []) assert(verified.some(value => value.result && value.tool.id === event.payload?.id), 'Every live tool result must appear in the persisted transcript');
  for (const result of results) assert(verified.some(value => value.result === result), 'Every native tool result must appear in the owned public transcript');
  if (!allowIncomplete) {
    for (const start of native.filter(value => value.event === 'tool-start')) assert(verified.some(value => digest(value.tool.id) === start.itemIdHash), 'No hidden native tool start');
  }
  return verified;
}
function auditJourney(common, acceptance, stored) {
  const { owner, manifest, inputs, receipts } = common;
  assert(!receipts.some(value => value.event === 'unexpected-tool-item'), 'Unexpected native tools cannot disappear from acceptance');
  const observations = read(path.join(owner.directory, 'observations.json'));
  const events = read(path.join(owner.directory, 'events-main.json'));
  assert.equal(acceptance.status, 'PASS_PROFILE_COMPATIBILITY_TRANSPORT'); assert.equal(acceptance.stage, 'PROFILE_COMPATIBILITY_2');
  assert.equal(acceptance.semanticReview, 'ROOT_INDEPENDENT_REVIEW_REQUIRED');
  assert.equal(acceptance.counts.completedTurns, 2); assert.equal(acceptance.counts.conversationalInputs, 2);
  assert.equal(acceptance.counts.publicUserAttempts, 4); assert.equal(acceptance.counts.rejectedAttempts, 2);
  assert.equal(acceptance.counts.auxiliaryInputs, receipts.filter(value => value.event === 'auxiliary-input').length);
  assert.equal(typeof acceptance.sourceId, 'string'); assert(acceptance.sourceId.length > 0);
  assert.equal(typeof acceptance.panelId, 'string'); assert(acceptance.panelId.length > 0);
  assert(events.some(value => value.type === 'initialState' && value.payload.panelId === acceptance.panelId));
  const conversation = one(stored.conversations.filter(value => value.id === acceptance.sourceId), 'Exactly one owned disk conversation');
  assert.equal(acceptance.finalConversation.id, conversation.id);
  assert.deepEqual(conversation.messages.map(messageProjection), acceptance.finalConversation.messages.map(messageProjection));
  assert.equal(new Set(conversation.messages.map(value => value.id)).size, conversation.messages.length);
  assert.deepEqual(acceptance.replies.map(value => value.marker), expected);
  // Negative error-message persistence is checked against actual error payloads below.
  assert.deepEqual(conversation.messages.filter(value => value.role === 'assistant' && acceptance.replies.some(reply => reply.messageId === value.id)).map(value => value.id), acceptance.replies.map(value => value.messageId));
  assert.equal(conversation.messages.filter(value => value.role === 'user').length, 4);
  assert.equal(events.filter(value => value.type === 'responseComplete').length, 2);
  assert.deepEqual(conversation.messages.filter(value => value.role === 'user').map(messageProjection),
    events.filter(value => value.type === 'messageAdded' && value.payload?.role === 'user').map(value => messageProjection(value.payload)), 'Every actual user turn must persist exactly');
  for (const foreign of stored.conversations.filter(value => value.id !== acceptance.sourceId)) assert(!foreign.messages.some(value => ['user', 'assistant'].includes(value.role)), 'Fresh profile-compatibility run cannot contain unaccounted conversational work');
  const sessionHashes = new Set(), turnHashes = new Set();
  const proofs = acceptance.replies.map((reply, index) => {
    const scope = scopes[reply.marker], input = inputs[index];
    assert.deepEqual(reply.scope, scope);
    assert.equal(reply.ordinal, index + 1); assert.equal(reply.panelId, acceptance.panelId); assert.equal(reply.conversationId, acceptance.sourceId);
    assert.equal(reply.provider, 'openai-codex'); assert.equal(reply.model, manifest.model); assert.deepEqual(reply.request, input);
    assert(input.outsideMemoryMarkers.includes(reply.marker));
    assert(input.outsideMemoryMarkers.every(marker => attemptMarkers.slice(0, attemptMarkers.indexOf(reply.marker) + 1).includes(marker)), 'No future or foreign request marker may contaminate this turn');
    assert.equal(input.model, manifest.model); assert.equal(input.effort, 'low');
    const nativeSession = common.receipts.filter(value => value.event === 'session' && value.wrapperPid === input.wrapperPid && value.at <= input.at).at(-1);
    assert(nativeSession && ['thread/start', 'thread/resume'].includes(nativeSession.method), 'Each request needs an acknowledged actual native session');
    assert.equal(nativeSession.sessionHash, input.sessionHash);
    if (index === 0) assert.equal(nativeSession.method, 'thread/start', 'The supplement must begin in a fresh native thread');
    assert.equal(nativeSession.actualModel, manifest.model, 'Native thread/start and resume must acknowledge the selected model');
    assert.equal(nativeSession.requestedModel, manifest.model, 'Native setup must request the selected model explicitly');
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
    assert.deepEqual(reply.permissionDecisionIds, interval.filter(value => value.type === 'permissionRequest').map(value => value.payload.id));
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
    const verified = verifyTools(common, input, started.turnHash, reply.tools, wire, scope, false, interval);
    assert.equal(verified.length, index === 0 ? 1 : 0, 'Only one exact read command on DEFAULT_A, and no tools on recovery');
    assert.equal(reply.toolOutputEvidence.length, verified.length);
    for (const item of verified) {
      assert.deepEqual(one(reply.toolOutputEvidence.filter(value => value.itemId === item.tool.id), 'Recorded exact output projection'), item.outputProjection);
    }
    for (const [relative, original] of Object.entries(manifest.fixture.files)) {
      assert.equal(reply.beforeFiles.hashes[relative], original.sha256, 'Copied files must remain unchanged before each reply');
      assert.equal(recorded.afterFiles.hashes[relative], original.sha256, 'Copied files must remain unchanged after each reply');
    }
    const results = nativeTools.filter(value => value.event === 'tool-result');
    const user = conversation.messages[conversation.messages.indexOf(saved) - 1];
    assert.equal(user?.role, 'user'); assert(user.content.includes(`PB02_REQUEST:${reply.marker}`));
    return { marker: reply.marker, inputIndex: input.inputIndex, messageId: reply.messageId, contentSha256: digest(reply.content),
      actualModel: nativeSession.actualModel, turnHash: started.turnHash, nativeToolIds: results.map(value => value.itemIdHash) };
  });
  assert.deepEqual(receipts.filter(value => ['tool-start', 'tool-result'].includes(value.event)), acceptance.replies.flatMap(value => value.nativeTools),
    'Every actual native tool item must belong to one of the two completed replies');
  assert.equal(receipts.filter(value => value.event === 'turn-started').length, 2);
  assert.equal(receipts.filter(value => value.event === 'turn-completed').length, 2);
  assert.equal(sessionHashes.size, 1, 'All successful replies belong to the same fresh profile compatibility thread');
  return { observations, events, conversation, proofs };
}

function auditStderrSummaries(common) {
  const { receipts } = common;
  const invocations = receipts.filter(value => value.event === 'invocation'), summaries = receipts.filter(value => value.event === 'stderr-summary');
  assert.equal(new Set(invocations.map(value => value.wrapperPid)).size, invocations.length, 'Each transparent invocation has one wrapper identity');
  const used = new Set();
  const proofs = invocations.map(invocation => {
    assert(['app-server', 'probe'].includes(invocation.kind), 'No auxiliary or single-shot fallback on the main lane');
    if (invocation.kind === 'probe') assert.deepEqual(invocation.args, ['--version']);
    const summary = one(summaries.filter(value => value.wrapperPid === invocation.wrapperPid), 'Each native child has one complete stderr summary');
    used.add(summary);
    assert(Number.isSafeInteger(summary.bytes) && summary.bytes >= 0); assert(/^[a-f0-9]{64}$/.test(summary.sha256));
    assert.equal(typeof summary.runtimeOnlyProfileArgument, 'boolean');
    assert(Object.keys(summary).every(key => ['window', 'provider', 'at', 'wrapperPid', 'event', 'bytes', 'sha256', 'runtimeOnlyProfileArgument'].includes(key)), 'Diagnostic receipts contain only the approved summary fields');
    if (summary.bytes === 0) { assert.equal(summary.sha256, digest('')); assert.equal(summary.runtimeOnlyProfileArgument, false); }
    const isProbe = invocation.kind === 'probe';
    const start = one(receipts.filter(value => value.wrapperPid === invocation.wrapperPid && value.event === (isProbe ? 'probe-start' : 'start')), 'Every invocation owns one actual child start');
    const exit = one(receipts.filter(value => value.wrapperPid === invocation.wrapperPid && value.event === (isProbe ? 'probe-exit' : 'exit')), 'Every invocation owns one actual child exit');
    assert(Number.isSafeInteger(start.childPid) && start.childPid > 0); assert.equal(exit.childPid, start.childPid);
    assert(receipts.indexOf(invocation) < receipts.indexOf(start) && receipts.indexOf(start) < receipts.indexOf(summary) && receipts.indexOf(summary) < receipts.indexOf(exit));
    assert(summary.at >= start.at && summary.at <= exit.at);
    const named = invocation.kind === 'app-server' && invocation.selectedProfile !== undefined;
    assert.equal(summary.runtimeOnlyProfileArgument, named, 'Only the two explicitly named-profile attempts produce the exact native unsupported-argument signature');
    if (named) { assert(summary.bytes > 0); assert.equal(exit.exitCode, 1); assert.equal(exit.signal, null); }
    return { wrapperPid: invocation.wrapperPid, childPid: start.childPid, kind: invocation.kind, selectedProfile: invocation.selectedProfile,
      stderrBytes: summary.bytes, stderrSha256: summary.sha256, runtimeOnlyProfileArgument: summary.runtimeOnlyProfileArgument,
      exitCode: exit.exitCode, signal: exit.signal };
  });
  assert.equal(used.size, summaries.length, 'No detached diagnostic summary');
  for (const event of ['start', 'probe-start', 'exit', 'probe-exit']) {
    assert(receipts.filter(value => value.event === event).every(value => invocations.some(invocation => invocation.wrapperPid === value.wrapperPid)), 'No unreported native child lifecycle');
  }
  return proofs;
}

function auditProfileAttempts(common, acceptance, journey) {
  const { receipts, inputs, manifest, ancestry } = common, configuration = manifest.profileValidation;
  const { events, observations, conversation } = journey;
  const stderrDiagnostics = auditStderrSummaries(common);
  assert.deepEqual(acceptance.attempts.map(value => value.marker), attemptMarkers);
  const users = conversation.messages.filter(value => value.role === 'user'); assert.equal(users.length, 4);
  const errorMessages = [], usedInvocations = new Set(), usedRpc = new Set(), proofs = [];
  const appInvocations = receipts.filter(value => value.event === 'invocation' && value.kind === 'app-server');
  const namedProfile = configuration.profiles.A;
  const expectedRaw = [namedProfile.name, '', `  ${namedProfile.name}  `, ''];
  let count = 0;
  for (const [index, attempt] of acceptance.attempts.entries()) {
    assert.equal(attempt.configRaw, expectedRaw[index]); assert.equal(attempt.configReadback, attempt.configRaw);
    for (const key of ['selectedAt', 'started', 'ended']) assert(Number.isFinite(attempt[key]));
    assert(attempt.selectedAt <= attempt.started && attempt.started <= attempt.ended);
    if (index) {
      assert(acceptance.attempts[index - 1].ended <= attempt.selectedAt);
      const selection = one(observations.filter(value => value.event === 'profile-selection' && value.selectedAt === attempt.selectedAt), 'Every subsequent selection is an explicit public configuration update');
      for (const key of ['configRaw', 'configReadback', 'receiptStartIndex', 'inputCountBefore']) assert.deepEqual(selection[key], attempt[key]);
    }
    assert.equal(attempt.userMessageId, users[index].id); assert(users[index].content.includes(`PB02_REQUEST:${attempt.marker}`));
    const publicUser = one(events.filter(value => value.type === 'messageAdded' && value.payload?.id === attempt.userMessageId), 'Each attempted user message has one actual public event');
    assert(publicUser.at >= attempt.started && publicUser.at <= attempt.ended);
    assert.deepEqual(messageProjection(publicUser.payload), messageProjection(users[index]));
    const interval = events.filter(value => value.at >= attempt.started && value.at <= attempt.ended);
    assert.deepEqual(attempt.capturedEvents, interval, 'Saved attempt events are the exact actual public interval');
    const errors = interval.filter(value => ['error', 'authError', 'requestCancelled'].includes(value.type));
    assert.deepEqual(attempt.errorEvents || [], errors);
    const recorded = one(observations.filter(value => value.event === 'profile-attempt' && value.marker === attempt.marker), 'Every profile attempt has exactly one observation');
    for (const key of Object.keys(attempt)) assert.deepEqual(recorded[key], attempt[key]);
    const begin = attempt.receiptStartIndex, end = attempt.receiptEndIndex;
    assert(Number.isSafeInteger(begin) && Number.isSafeInteger(end) && begin >= 0 && end >= begin && end <= receipts.length);
    if (index) assert(begin >= acceptance.attempts[index - 1].receiptEndIndex, 'Attempt receipt intervals cannot overlap');
    else assert.equal(begin, 0, 'Initial named selection covers startup before the first public send');
    const wire = receipts.slice(begin, end); assert(wire.every(value => value.at <= attempt.ended));
    const submitted = wire.filter(value => value.event === 'request'), positive = expected.includes(attempt.marker);
    assert.equal(attempt.inputCountBefore, count); if (positive) count++; assert.equal(attempt.inputCountAfter, count);
    assert.equal(submitted.length, positive ? 1 : 0, 'Rejected profile startup is not a forwarded inference input');
    const invocations = wire.filter(value => value.event === 'invocation' && value.kind === 'app-server');
    assert(invocations.length >= 1, 'Every attempt reaches its explicitly selected native CLI mode');
    if (positive) assert.equal(invocations.length, 1, 'An explicit default selection starts exactly one process');
    for (const invocation of invocations) { assert(!usedInvocations.has(invocation)); usedInvocations.add(invocation); }
    const rpcs = wire.filter(value => value.event === 'rpc-request');
    for (const rpc of rpcs) {
      assert(['initialize', 'config/read', 'thread/start', 'thread/resume', 'turn/start'].includes(rpc.method));
      assert(/^[a-f0-9]{64}$/.test(rpc.rpcIdHash)); assert(!usedRpc.has(rpc)); usedRpc.add(rpc);
      assert.equal(rpc.selectedProfile, positive ? undefined : namedProfile.name);
      assert(invocations.some(invocation => invocation.wrapperPid === rpc.wrapperPid), 'No hidden process receives native setup or model input');
    }
    if (positive) {
      assert.equal(errors.length, 0);
      const reply = one(acceptance.replies.filter(value => value.marker === attempt.marker), 'Default selection owns one completed reply');
      assert.equal(attempt.replyId, reply.messageId); assert.equal(attempt.started, reply.started);
      assert(reply.completedAt <= attempt.ended); assert.deepEqual(submitted[0], reply.request);
      assert.equal(interval.filter(value => value.type === 'responseComplete').length, 1);
      const rpc = one(rpcs.filter(value => value.method === 'turn/start'), 'One native turn request per successful default attempt');
      assert.equal(rpc.rpcIdHash, submitted[0].rpcIdHash); assert.equal(rpc.wrapperPid, submitted[0].wrapperPid); assert.equal(rpc.sessionHash, submitted[0].sessionHash);
    } else {
      assert.equal(attempt.replyId, undefined); assert.equal(errors.length, 1); assert.equal(errors[0].type, 'error');
      assert.equal(interval.filter(value => value.type === 'responseComplete').length, 0);
      assert(!interval.some(value => ['toolUse', 'toolResult', 'permissionRequest'].includes(value.type)));
      const payload = errors[0].payload, text = typeof payload === 'string' ? payload : payload?.error;
      assert.equal(text, UNSUPPORTED_PROFILE_MESSAGE, 'Exact actionable native compatibility diagnostic must be preserved');
      assert.equal(typeof attempt.visibleError, 'string');
      assert.equal(attempt.visibleError.replace(/\s+/g, ' ').trim(), `Error: ${text}`.replace(/\s+/g, ' ').trim());
      if (payload?.message) {
        assert.equal(payload.message.role, 'assistant');
        const saved = one(conversation.messages.filter(value => value.id === payload.message.id), 'Actual partial error message persists exactly once');
        assert.deepEqual(messageProjection(saved), messageProjection(payload.message)); assert(!saved.toolCalls?.length); errorMessages.push(saved.id);
      }
      assert(!wire.some(value => ['session', 'request', 'turn-started', 'turn-completed', 'tool-start', 'tool-result', 'approval-request', 'approval-decision', 'thread-config', 'profile-config', 'effective-tool-config'].includes(value.event)));
      assert(rpcs.every(value => value.method === 'initialize'), 'Unsupported argument may receive initialize, but no config or thread request');
      assert(!wire.some(value => value.event === 'rpc-result' && value.success === true), 'Unsupported startup cannot acknowledge successful native initialization');
    }
    for (const invocation of invocations) {
      assert.equal(invocation.codeHomeMatches, true);
      assert.deepEqual(invocation.args, positive ? ['app-server'] : ['--profile', namedProfile.name, 'app-server']);
      assert.equal(invocation.selectedProfile, positive ? undefined : namedProfile.name);
      assert.equal(invocation.profileOwnedPath, positive ? undefined : namedProfile.path);
      assert.equal(invocation.profileFileSha256, positive ? null : namedProfile.sha256);
      const start = one(wire.filter(value => value.event === 'start' && value.wrapperPid === invocation.wrapperPid), 'Each selected process has one actual start');
      const diagnostic = one(stderrDiagnostics.filter(value => value.wrapperPid === invocation.wrapperPid), 'Selected process has one independently joined diagnostic');
      assert.equal(diagnostic.runtimeOnlyProfileArgument, !positive);
      if (!positive) {
        const summary = one(wire.filter(value => value.event === 'stderr-summary' && value.wrapperPid === invocation.wrapperPid), 'Rejected process summary precedes the recorded end of its attempt');
        assert.equal(summary.runtimeOnlyProfileArgument, true);
        one(wire.filter(value => value.event === 'exit' && value.wrapperPid === invocation.wrapperPid), 'Rejected process exits before the next explicit selection');
      }
      for (const pid of [invocation.wrapperPid, start.childPid]) {
        const births = ancestry.processIdentities.filter(value => value.pid === pid);
        if (!positive && births.length === 0) continue; // Immediate argument rejection can fit between 250ms samples.
        assert.equal(births.length, 1); assert.equal(typeof births[0].startedAt, 'string');
      }
      if (positive) {
        assert(!wire.some(value => value.event === 'rpc-result' && value.success !== true || value.event === 'native-error' && !value.willRetry));
        const sessionMethod = attempt.marker === 'DEFAULT_A' ? 'thread/start' : 'thread/resume';
        assert.deepEqual(rpcs.map(value => value.method), ['initialize', 'config/read', sessionMethod, 'turn/start']);
        const configRpc = rpcs.find(value => value.method === 'config/read');
        const configResult = one(wire.filter(value => value.event === 'rpc-result' && value.method === 'config/read' && value.rpcIdHash === configRpc.rpcIdHash), 'Base config/read has an actual successful response');
        const observed = one(wire.filter(value => value.event === 'profile-config'), 'The whitelisted base-config observation is accounted without claiming a loaded named profile');
        assert.equal(configResult.wrapperPid, invocation.wrapperPid); assert.equal(configResult.success, true);
        assert.equal(observed.wrapperPid, invocation.wrapperPid); assert.equal(observed.rpcIdHash, configRpc.rpcIdHash); assert.equal(observed.selectedProfile, undefined);
        assert(wire.indexOf(configRpc) < wire.indexOf(configResult) && wire.indexOf(configResult) < wire.indexOf(observed));
        assert(wire.indexOf(observed) < wire.indexOf(rpcs.find(value => value.method === sessionMethod)));
        assert.equal(submitted[0].wrapperPid, invocation.wrapperPid);
        if (attempt.marker === 'DEFAULT_RECOVERY') {
          assert.notEqual(invocation.wrapperPid, acceptance.replies[0].request.wrapperPid);
          assert.equal(submitted[0].sessionHash, acceptance.replies[0].request.sessionHash);
          assert.equal(acceptance.replies[1].nativeSession.method, 'thread/resume');
        }
      }
    }
    proofs.push({ marker: attempt.marker, userMessageId: attempt.userMessageId, inputCountBefore: attempt.inputCountBefore,
      inputCountAfter: attempt.inputCountAfter, replyId: attempt.replyId, visibleErrors: errors.length,
      nativeSetupInvocations: invocations.length, forwardedModelInputs: submitted.length,
      invocationPids: invocations.map(value => value.wrapperPid),
      sampledInvocationPids: invocations.filter(value => ancestry.processIdentities.some(identity => identity.pid === value.wrapperPid)).map(value => value.wrapperPid),
      receiptStartIndex: begin, receiptEndIndex: end });
  }
  assert.equal(count, 2); assert.equal(inputs.length, 2);
  assert.equal(usedInvocations.size, appInvocations.length); assert.equal(usedRpc.size, receipts.filter(value => value.event === 'rpc-request').length);
  for (const event of ['profile-config', 'effective-tool-config', 'session']) assert.equal(receipts.filter(value => value.event === event).length, 2, `Exactly two acknowledged base-configuration setups: ${event}`);
  const expectedAssistants = [...acceptance.replies.map(value => value.messageId), ...errorMessages];
  assert.deepEqual(conversation.messages.filter(value => value.role === 'assistant').map(value => value.id).sort(), expectedAssistants.sort());
  assert.equal(events.filter(value => ['error', 'authError', 'requestCancelled'].includes(value.type)).length, 2);
  assert.equal(observations.filter(value => value.event === 'profile-selection').length, 3, 'Only the three specified explicit configuration changes are recorded');
  return { proofs, stderrDiagnostics, namedProfileLoaded: false, recoveryRequiresExplicitClear: true };
}

function auditPermissions(common, acceptance, journey) {
  const publicRequests = journey.events.filter(value => value.type === 'permissionRequest');
  const decisions = journey.observations.filter(value => value.event === 'permission-decision');
  assert.equal(new Set(publicRequests.map(value => value.payload.id)).size, publicRequests.length);
  assert.equal(new Set(decisions.map(value => value.id)).size, decisions.length);
  assert.equal(decisions.length, publicRequests.length, 'No detached harness permission decisions');
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
    assert.equal(native.method, 'item/commandExecution/requestApproval');
    const result = one(reply.nativeTools.filter(value => value.event === 'tool-result' && value.itemIdHash === native.itemIdHash), 'Approval owns the exact native item result');
    assert(common.receipts.indexOf(response) < common.receipts.indexOf(common.receipts.find(value => value === result || JSON.stringify(value) === JSON.stringify(result))), 'Tool completion must follow the actual native permission response');
    if (denied) assert.notEqual(result.status, 'completed'); else assert.equal(result.status, 'completed');
    for (const [relative, original] of Object.entries(common.manifest.fixture.files)) {
      assert.equal(decision.beforeFiles.hashes[relative], original.sha256, 'Every copied file is unchanged before permission');
    }
    return { publicId: request.id, nativeRequestIdHash: native.nativeRequestIdHash, itemIdHash: native.itemIdHash,
      inputIndex: input.inputIndex, decision: response.decision, inputSha256: decision.inputSha256 };
  });
  assert.equal(paired.size, requests.length, 'Every actual native approval request must be accounted for');
  assert.equal(usedResponses.size, responses.length, 'Every actual native approval decision must be accounted for');
  return proofs;
}

function auditAuxiliaryArtifacts(common) {
  const { manifest, owner } = common, auxiliary = manifest.auxiliary;
  assert.equal(auxiliary.maxInputs, 5); assert.equal(auxiliary.routingSetting, 'mysti.claudeCodePath');
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
    counter: fs.existsSync(auxiliary.counterFile) ? read(auxiliary.counterFile) : { forwardedInputs: 0, maxInputs: 5 },
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
  const profiles = verifyOwnedProfiles(common.manifest.profileValidation);
  const attempts = auditProfileAttempts(common, acceptance, journey);
  const auxiliary = auditAuxiliaryArtifacts(common);
  const inputAccounting = { mainConversationInputs: common.inputs.length, mainLaneAuxiliaryInputs: acceptance.counts.auxiliaryInputs,
    helperInputs: auxiliary.counts.submitted, mainInputCap: 3, helperInputCap: 5, combinedSubmittedInputs: common.inputs.length + auxiliary.counts.submitted,
    helperInferenceValidation: auxiliary.inferenceValidation };
  assert.equal(inputAccounting.mainLaneAuxiliaryInputs, 0);
  verifyPreservedBase(common.manifest.fixture);
  return { status: 'PASS_PROFILE_COMPATIBILITY_TRANSPORT', checkedAt: new Date().toISOString(), auditorSha256: hash(__filename),
    preservedBase: common.manifest.fixture.base,
    sourceIdentity: common.manifest.sourceIdentity, packageIdentity: common.manifest.packageIdentity,
    bundleSha256: common.manifest.bundleSha256, chatSha256: common.manifest.chatSha256, pinnedIdentities: common.pinned,
    compiledJourneySha256: common.reservation.harnessSha256, observerSha256: common.reservation.observerSha256,
    receipts: common.owner.receiptPaths.map(file => ({ file, sha256: hash(file) })),
    evidenceSha256: Object.fromEntries(['acceptance.json', 'observations.json', 'events-main.json'].map(file => [file, hash(path.join(common.owner.directory, file))])),
    counts: acceptance.counts, auxiliary, inputAccounting, replies: journey.proofs, attempts: attempts.proofs,
    nativeProfileCompatibility: { namedProfileLoaded: attempts.namedProfileLoaded, recoveryRequiresExplicitClear: attempts.recoveryRequiresExplicitClear },
    stderrDiagnostics: attempts.stderrDiagnostics, profiles, permissions, workspace,
    disk: { database: stored.database, conversationId: journey.conversation.id, messageIds: journey.conversation.messages.map(value => value.id),
      projectionSha256: digest(JSON.stringify(journey.conversation.messages.map(messageProjection))) },
    observedProcessIdentitiesExited: common.ancestry.processIdentities.length, processSamplingMs: 250,
    semanticReview: 'ROOT_INDEPENDENT_REVIEW_REQUIRED',
    elapsedCampaigns: { S: 'NOT_RUN', W: 'NOT_RUN', E: 'NOT_RUN', P: 'NOT_RUN' },
    scope: common.manifest.scope,
    limits: ['Named profiles are rejected by this CLI app-server; completed replies use the base configuration only after explicit clears. No successful named-profile loading is claimed.',
      'PID and birth cleanup verifies observed processes at 250ms sampling; processes entirely between samples can be missed.',
      'This covers four profile-compatibility attempts and two completed replies; it does not rerun full25 or establish elapsed-profile coverage.'] };
}
module.exports = { audit, auditCommon, auditWorkspace, auditHistoryArtifacts, auditJourney, auditPermissions, auditAuxiliaryArtifacts, permittedTool, turnWire, verifyTools, auditProfileAttempts, auditStderrSummaries, expected, attemptMarkers, scopes, UNSUPPORTED_PROFILE_MESSAGE };
if (require.main === module) {
  const directory = path.resolve(process.env.MYSTI_PB02_PROFILE_COMPATIBILITY_ARTIFACT_DIR || ''); contained(root, directory);
  const primary = path.join(directory, 'independent-audit.json');
  const output = fs.existsSync(primary) ? path.join(directory, `independent-audit-${Date.now()}.json`) : primary;
  try {
    const result = audit(directory); fs.writeFileSync(output, JSON.stringify(result, null, 2), { flag: 'wx' }); console.log(JSON.stringify(result));
  } catch (error) {
    const result = { status: 'FAIL', checkedAt: new Date().toISOString(), auditorSha256: hash(__filename),
      error: { name: error.name, message: error.message }, scope: 'PB-02 profile compatibility read-only owned-artifact audit; no editor or model launch' };
    fs.writeFileSync(output, JSON.stringify(result, null, 2), { flag: 'wx' }); console.error(JSON.stringify(result)); process.exitCode = 1;
  }
}
