/* PB-02 fresh full25 followup independent, read-only acceptance. Never launches an editor or model. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readStoredConversations, messageProjection, toolProjection } = require('./audit-vscode-claude.cjs');
const { exactCommand, patchScope, assertToolOutputProjection, readonlyOutcome } = require('./codex-full-followup-oracle.cjs');
const { auditEvidence: auditAuxiliary } = require('./codex-full-followup-auxiliary.cjs');
const os = require('node:os');
const { readonlyProbeOutcome, createReadOnlyProbe } = require('./codex-full-readonly-probe.cjs');
const { vectors: HTTP_DATE_VECTORS } = require('./http-date-portability-oracle.cjs');
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
function auditCommon(directory) {
  contained(root, directory);
  const manifest = read(path.join(directory, 'prepared.json'));
  assert.equal(manifest.case, 'PB-02'); assert.equal(manifest.stage, 'FULL_25_FOLLOWUP');
  assert.equal(manifest.artifactDir, directory); assert.equal(manifest.preparedBeforeActivation, true);
  assert.deepEqual(Object.keys(manifest.windows), ['A']); assert.equal(manifest.plannedSuccessfulTurns, 25); assert.equal(manifest.maxForwardedInputs, 29);
  const owner = manifest.windows.A;
  contained(directory, owner.directory); contained(owner.directory, owner.workspace);
  contained(fs.realpathSync(path.join(repo, '.vscode-test/profiles')), fs.realpathSync(owner.profile));
  assert.deepEqual(read(path.join(owner.profile, '.mysti-test-owned.json')), { case: 'PB-02', profile: fs.realpathSync(owner.profile), window: 'A' });
  assert.equal(manifest.fixture.workspace, owner.workspace);
  assert.equal(manifest.model, 'gpt-6.1-sol');
  contained(root, fs.realpathSync(manifest.compiledDirectory));
  const pinned = [...Object.values(manifest.executableIdentities), ...manifest.wrapperIdentities, ...manifest.harnessDependencyIdentities,
    manifest.nodeIdentity, manifest.readiness, manifest.sourceIdentity, manifest.packageIdentity];
  pinned.forEach(identity);
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
  assert.equal(reservation.plannedConversationRequests, 29);
  assert.equal(hash(path.join(manifest.compiledDirectory, 'codex-full-followup.test.js')), reservation.harnessSha256);
  assert.equal(hash(path.join(manifest.compiledDirectory, 'codex-full-followup-observer.js')), reservation.observerSha256);
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
  assert([27, 28].includes(inputs.length), '25 replies, two stopped inputs and zero or one rejected input only');
  assert.deepEqual(inputs.map(value => value.inputIndex), Array.from({ length: inputs.length }, (_, index) => index + 1));
  assert.deepEqual(read(manifest.counterFile), { forwardedInputs: inputs.length, maxInputs: 29 }); assert(!fs.existsSync(manifest.counterFile + '.lock'));
  const cleanup = read(path.join(owner.directory, 'editor-exit-process-check.json'));
  assert.equal(cleanup.status, 'PASS_OBSERVED_IDENTITIES_EXITED'); assert.deepEqual(cleanup.remaining, []); assert.deepEqual(cleanup.unverifiedLiveReceiptPids, []);
  assert.equal(cleanup.conversationalInputs, inputs.length); assert.equal(cleanup.auxiliaryInputs, receipts.filter(value => value.event === 'auxiliary-input').length);
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

function auditWorkspace(manifest, owner, acceptance) {
  const fixture = manifest.fixture;
  assert.deepEqual(fixture.editableFiles.slice().sort(), ['src/retry.cjs', 'test/retry.test.cjs']);
  const actual = [];
  function visit(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (folder === owner.workspace && entry.name === '.git') continue;
      const file = path.join(folder, entry.name);
      assert(!entry.isSymbolicLink(), 'Owned source tree cannot contain a new symlink');
      if (entry.isDirectory()) visit(file);
      else { assert(entry.isFile()); actual.push(path.relative(owner.workspace, file)); }
    }
  }
  visit(owner.workspace);
  const additions = actual.filter(relative => !Object.hasOwn(fixture.files, relative)).sort();
  const historyPaths = new Map([acceptance.sourcePanelId, acceptance.otherPanelId].map(panelId => {
    assert(typeof panelId === 'string' && panelId.length > 0);
    const segment = panelId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
    assert(segment && !/^_+$/.test(segment));
    return [`.mysti/compaction/${segment}/history.jsonl`, panelId];
  }));
  const productArtifacts = additions.map(relative => {
    const absolute = path.join(owner.workspace, relative), bytes = fs.readFileSync(absolute);
    let kind;
    if (relative === '.mysti/compaction/.gitignore') {
      assert.equal(bytes.toString(), '*\n'); kind = 'history-ignore';
    } else if (historyPaths.has(relative)) {
      const rows = bytes.toString().split('\n').filter(Boolean).map(line => JSON.parse(line));
      assert(rows.length > 0);
      rows.forEach((row, index) => {
        assert.equal(row.seq, index + 1); assert(Number.isFinite(row.ts));
        assert(['user', 'assistant', 'system'].includes(row.role));
        assert(['text', 'tool_use', 'tool_result'].includes(row.kind));
        assert.equal(typeof row.content, 'string'); assert(Number.isFinite(row.tokensEst) && row.tokensEst >= 0);
        assert(row.msgId === undefined || typeof row.msgId === 'string');
        assert(Object.keys(row).every(key => ['seq', 'ts', 'role', 'kind', 'content', 'tokensEst', 'msgId'].includes(key)));
      });
      kind = 'owned-panel-history';
    } else if (/^\.mysti\/tmp\/mysti-attachment-[A-Za-z0-9-]+\.(txt|png)$/.test(relative)) {
      assert(['attachments/brief.txt', 'attachments/status-blue.png'].some(file => fixture.files[file].sha256 === digest(bytes)));
      kind = 'exact-owned-attachment-copy';
    } else assert.fail(`Unexpected workspace addition: ${relative}`);
    return { relative, kind, sha256: digest(bytes), bytes: bytes.length };
  });
  assert.deepEqual(actual.filter(relative => !additions.includes(relative)).sort(), Object.keys(fixture.files).sort(), 'Every original fixture file must remain');
  const files = {};
  for (const [relative, original] of Object.entries(fixture.files)) {
    const absolute = path.resolve(owner.workspace, relative); contained(owner.workspace, absolute);
    const bytes = fs.readFileSync(absolute); files[relative] = { sha256: digest(bytes), bytes: bytes.length };
    if (!fixture.editableFiles.includes(relative)) {
      assert.equal(digest(bytes), original.sha256, `Noneditable file changed: ${relative}`);
      assert.equal(bytes.length, original.bytes);
    }
  }
  assert.notEqual(files['src/retry.cjs'].sha256, fixture.files['src/retry.cjs'].sha256, 'The implementation must actually change');
  assert.equal(fs.readFileSync(path.join(owner.workspace, 'src/retry.cjs'), 'utf8').split(fixture.unstagedNote).length, 2, 'Preserve the exact developer unstaged note once');
  assert.equal(fs.readFileSync(path.join(owner.workspace, 'README.md'), 'utf8').split(fixture.stagedNote).length, 2, 'Preserve the exact developer staged note once');
  assert(fs.readFileSync(path.join(owner.workspace, 'test/retry.test.cjs'), 'utf8').startsWith(fixture.files['test/retry.test.cjs'].text), 'All seeded tests remain byte-identical before appended revision tests');
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: owner.workspace, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.equal(git(['ls-files', '--stage']), fixture.originalIndex, 'Staged index entries must remain unchanged');
  const changed = git(['diff', '--name-only']).trim().split('\n').filter(Boolean);
  assert(changed.every(relative => fixture.editableFiles.includes(relative)), 'Only the two permitted files may have unstaged edits');
  assert.deepEqual(acceptance.files.hashes, Object.fromEntries([...Object.entries(files).map(([file, value]) => [file, value.sha256]), ...productArtifacts.map(value => [value.relative, value.sha256])]));
  assert.deepEqual(acceptance.files.productArtifacts.map(value => value.relative).sort(), additions);
  for (const value of acceptance.files.productArtifacts) assert.equal(value.sha256, hash(path.join(owner.workspace, value.relative)));
  return { files, productArtifacts, status: git(['status', '--porcelain=v1', '--untracked-files=all']), stagedIndexSha256: digest(fixture.originalIndex) };
}

function wireFor(common, input) {
  const index = common.receipts.indexOf(input);
  assert(index >= 0, 'Request must come from the actual receipt stream');
  const next = common.receipts.findIndex((value, position) => position > index && value.event === 'request' && value.wrapperPid === input.wrapperPid);
  return common.receipts.slice(index, next < 0 ? undefined : next).filter(value => value.wrapperPid === input.wrapperPid);
}
function sameFixture(manifest, before, after) {
  for (const relative of Object.keys(manifest.fixture.files)) {
    assert(/^[a-f0-9]{64}$/.test(before.hashes[relative]));
    assert.equal(after.hashes[relative], before.hashes[relative], `Unexpected file mutation: ${relative}`);
  }
}
function permittedTool(tool, scope, workspace) {
  const name = String(tool.name).toLowerCase(), input = tool.input || {};
  return name === 'bash' && input.cwd === workspace && (scope.commands || []).some(command => exactCommand(input.command, command))
    || name === 'edit' && scope.patch && patchScope(input.changes, workspace, scope.patch);
}
function sessionFor(common, input, readonly = false) {
  const { receipts, manifest } = common;
  const session = receipts.filter(value => value.event === 'session' && value.wrapperPid === input.wrapperPid && value.at <= input.at).at(-1);
  assert(session && ['thread/start', 'thread/resume'].includes(session.method), 'Actual session acknowledgement must precede input');
  assert.equal(session.sessionHash, input.sessionHash); assert(/^[a-f0-9]{64}$/.test(input.sessionHash));
  assert.equal(session.actualModel, manifest.model); assert.equal(input.model, manifest.model);
  assert.equal(typeof session.modelProvider, 'string'); assert(session.modelProvider.length > 0);
  const policy = readonly ? 'never' : 'untrusted';
  assert.equal(session.returnedPolicy.approvalPolicy, policy); assert.equal(input.policy.approvalPolicy, policy);
  assert.equal(session.returnedPolicy.sandbox, 'readOnly'); assert.equal(input.policy.sandbox, 'read-only');
  assert([undefined, false].includes(session.returnedPolicy.networkAccess));
  assert.equal(session.returnedPolicy.ownedCwd, true);
  for (const flag of ['ownedCwd', 'mcpAllDisabled', 'appsAllDisabled', 'appsDefaultDisabled']) assert.equal(input.policy[flag], true);
  assert.equal(input.policy.effort, input.effort);
  const effective = receipts.filter(value => value.event === 'effective-tool-config' && value.wrapperPid === input.wrapperPid && value.at <= input.at).at(-1);
  assert(effective, 'Effective account tool configuration must be observed');
  assert.deepEqual(input.policy.mcpNames, effective.mcpNames); assert.deepEqual(input.policy.appNames, effective.appNames);
  return session;
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
function auditTabsAndStorage(common, acceptance, stored) {
  assert(Array.isArray(acceptance.liveTabs)); assert.equal(acceptance.liveTabs.length, 2);
  assert.deepEqual(acceptance.liveTabs.map(value => value.label).sort(), ['main', 'other']);
  assert.equal(new Set(acceptance.liveTabs.map(value => value.panelId)).size, 2);
  assert.equal(new Set(acceptance.liveTabs.map(value => value.conversationId)).size, 2);
  const observations = read(path.join(common.owner.directory, 'observations.json'));
  assert(observations.some(value => value.event === 'panel-created' && value.tabs?.length === 2 && value.tabs.every(tab => tab.stillOpen)), 'Both actual editor tabs must coexist');
  const owners = new Map();
  for (const tab of acceptance.liveTabs) {
    assert.equal(tab.stillOpen, true); assert(Number.isSafeInteger(tab.group) && tab.group > 0);
    assert(tab.viewType.includes('mysti.detachedChat'));
    const events = read(path.join(common.owner.directory, `events-${tab.label}.json`));
    assert(events.some(value => value.type === 'initialState' && value.payload?.panelId === tab.panelId));
    const conversation = one(stored.conversations.filter(value => value.id === tab.conversationId), 'Exactly one disk record per owned tab');
    const publicConversation = one(acceptance.finalConversations.filter(value => value.id === tab.conversationId), 'Final public history includes each owned conversation');
    assert.deepEqual(conversation.messages.map(messageProjection), publicConversation.messages.map(messageProjection));
    assert.equal(new Set(conversation.messages.map(value => value.id)).size, conversation.messages.length);
    for (const message of conversation.messages) for (const attachment of message.attachments || []) assert(!attachment.base64Data, 'Disk history must not contain embedded attachment data');
    const publicUsers = events.filter(value => value.type === 'messageAdded' && value.payload?.role === 'user').map(value => value.payload);
    assert.deepEqual(conversation.messages.filter(value => value.role === 'user').map(messageProjection), publicUsers.map(messageProjection), 'Every displayed user turn must be durable, in order');
    owners.set(tab.label, { ...tab, events, conversation });
  }
  assert.equal(acceptance.finalConversations.length, 2);
  for (const conversation of stored.conversations) if (![...owners.values()].some(owner => owner.conversationId === conversation.id)) {
    assert(!conversation.messages.some(value => ['user', 'assistant'].includes(value.role)), 'No unaccounted background conversation');
  }
  return { owners, observations };
}

const expected = ['DIAGNOSE', 'REGRESSION', 'PATCH_DESIGN', 'PATCH_APPLY', 'BASE_TESTS', 'DENY_CANARY',
  'UNRELATED', 'RETURN_TASK', 'JITTER_REVIEW', 'RETRY_REVIEW', 'CANCEL_REVIEW', 'RETRY_AFTER_PLAN',
  'RETRY_AFTER_PATCH', 'TEST_REVISION', 'FULL_TESTS', 'HTTP_REVIEW', 'INVALID_INPUT_REVIEW',
  'READONLY_CANARY', 'ATTACHMENTS', 'OTHER_PANEL', 'MAIN_RETURN', 'STOP_APPROVAL_RECOVERY',
  'STOP_STREAM_RECOVERY', 'INVALID_MODEL_RECOVERY', 'FINAL_REVIEW'];
const scopes = Object.fromEntries(expected.map(marker => [marker, {}]));
Object.assign(scopes, {
  DIAGNOSE: { commands: ['cat README.md src/retry.cjs'] }, REGRESSION: { commands: ['cat test/retry.test.cjs'] },
  PATCH_APPLY: { commands: ['cat src/retry.cjs'], patch: 'fix' }, BASE_TESTS: { commands: ['node --test test/retry.test.cjs'] },
  DENY_CANARY: { commands: ['cat canaries/approval.txt'], patch: 'deny' }, RETRY_REVIEW: { commands: ['cat src/retry.cjs'] },
  RETRY_AFTER_PATCH: { commands: ['cat src/retry.cjs'], patch: 'revision' }, TEST_REVISION: { commands: ['cat test/retry.test.cjs'], patch: 'tests' },
  FULL_TESTS: { commands: ['node --test test/retry.test.cjs'] }, READONLY_CANARY: { commands: ['node test/read-only-policy.cjs'], readonly: true },
  ATTACHMENTS: { commands: ['cat attachments/brief.txt'], attachments: true },
  FINAL_REVIEW: { commands: ['git -c core.hooksPath=/dev/null diff -- src/retry.cjs test/retry.test.cjs', 'node --test test/retry.test.cjs'] },
});
const requiredTools = {
  DIAGNOSE: 'commandExecution', REGRESSION: 'commandExecution', PATCH_APPLY: 'fileChange', BASE_TESTS: 'commandExecution',
  RETRY_REVIEW: 'commandExecution', RETRY_AFTER_PATCH: 'fileChange', TEST_REVISION: 'fileChange', FULL_TESTS: 'commandExecution', FINAL_REVIEW: 'commandExecution',
};
function auditReplies(common, acceptance, storage) {
  assert.deepEqual(acceptance.replies.map(reply => reply.marker), expected);
  assert.equal(acceptance.counts.completedTurns, 25); assert.equal(acceptance.counts.cancelledInputs, 2);
  assert.equal(acceptance.counts.rejectedAttempts, 1);
  assert.equal(acceptance.counts.conversationalInputs, common.inputs.length);
  assert.equal(acceptance.counts.auxiliaryInputs, common.receipts.filter(value => value.event === 'auxiliary-input').length);
  const seenMessages = new Set(), seenInputs = new Set(), seenTurns = new Set(), transactions = [];
  const proofs = acceptance.replies.map((reply, index) => {
    const label = reply.marker === 'OTHER_PANEL' ? 'other' : 'main', owner = storage.owners.get(label), scope = scopes[reply.marker];
    assert.equal(reply.ordinal, index + 1); assert.equal(reply.label, label);
    assert.equal(reply.panelId, owner.panelId); assert.equal(reply.conversationId, owner.conversationId);
    assert.equal(reply.provider, 'openai-codex'); assert.equal(reply.model, common.manifest.model); assert.deepEqual(reply.scope, scope);
    assert(!seenMessages.has(reply.messageId)); seenMessages.add(reply.messageId);
    const input = one(common.inputs.filter(value => value.inputIndex === reply.request.inputIndex), 'One actual request per completed reply');
    assert.deepEqual(reply.request, input); assert(!seenInputs.has(input.inputIndex)); seenInputs.add(input.inputIndex);
    assert(input.outsideMemoryMarkers.includes(reply.marker));
    const allowedMarkers = new Set(label === 'other' ? ['OTHER_PANEL'] : [...expected.slice(0, index + 1).filter(marker => marker !== 'OTHER_PANEL'), 'STOP_APPROVAL', 'STOP_STREAM', 'INVALID_MODEL']);
    assert(input.outsideMemoryMarkers.every(marker => allowedMarkers.has(marker)), 'No foreign, queued or future user input on the wire');
    assert.equal(input.outsideMemoryContainsOtherPanelToken, label === 'other');
    if (label === 'main') assert(!reply.content.includes(common.manifest.otherPanelToken));
    const effort = label === 'other' || index < 7 ? 'low' : 'medium'; assert.equal(input.effort, effort);
    const nativeSession = sessionFor(common, input, scope.readonly); assert.deepEqual(reply.nativeSession, nativeSession);
    assert(input.at >= reply.started && input.at <= reply.completedAt);
    if (index) assert(reply.started >= acceptance.replies[index - 1].completedAt);
    const terminal = one(owner.events.filter(value => value.type === 'responseComplete' && value.payload?.message?.id === reply.messageId), 'Exactly one terminal for this reply');
    assert.equal(terminal.at, reply.completedAt); assert.equal(terminal.payload.message.content, reply.content);
    assert.deepEqual(clean((terminal.payload.message.toolCalls || []).map(toolProjection)), clean(reply.tools.map(toolProjection)));
    assert.deepEqual(clean(terminal.payload.message.usage), clean(reply.usage));
    const saved = one(owner.conversation.messages.filter(value => value.id === reply.messageId), 'Completed reply is persisted exactly once');
    assert.deepEqual(messageProjection(saved), messageProjection(terminal.payload.message));
    assert.equal(saved.provider, 'openai-codex'); assert.equal(saved.model, common.manifest.model);
    const user = owner.conversation.messages[owner.conversation.messages.indexOf(saved) - 1];
    assert.equal(user?.role, 'user'); assert(user.content.includes(`PB02_REQUEST:${reply.marker}`));
    assert(reply.content.includes(`PB02_DONE:${reply.marker}`));
    const interval = owner.events.filter(value => value.at >= reply.started && value.at <= reply.completedAt);
    assert(interval.some(value => value.type === 'responseStarted')); assert(!interval.some(value => ['error', 'authError', 'requestCancelled'].includes(value.type)));
    const observed = one(storage.observations.filter(value => value.event === 'native-response' && value.marker === reply.marker), 'Exact saved journey observation');
    for (const key of Object.keys(reply)) assert.deepEqual(observed[key], reply[key]);
    const wire = wireFor(common, input).filter(value => value.at <= reply.completedAt);
    const started = one(wire.filter(value => value.event === 'turn-started'), 'Actual native turn acknowledgement');
    const completed = one(wire.filter(value => value.event === 'turn-completed'), 'Exactly one native completion');
    for (const value of [started, completed]) { assert.equal(value.sessionHash, input.sessionHash); assert.equal(value.inputIndex, input.inputIndex); }
    assert(/^[a-f0-9]{64}$/.test(started.turnHash)); assert(!seenTurns.has(started.turnHash)); seenTurns.add(started.turnHash);
    assert.equal(completed.turnHash, started.turnHash); assert.equal(completed.status, 'completed'); assert.deepEqual(reply.turnCompleted, completed);
    assert(!wire.some(value => value.event === 'native-error' && !value.willRetry));
    assert(!wire.some(value => value.event === 'rpc-result' && value.success !== true));
    assert.deepEqual(reply.nativeTools, wire.filter(value => ['tool-start', 'tool-result'].includes(value.event)));
    const verified = verifyTools(common, input, started.turnHash, reply.tools, wire, scope, false, interval);
    if (requiredTools[reply.marker]) assert(verified.some(value => value.result?.type === requiredTools[reply.marker] && value.result.status === 'completed'));
    if (['BASE_TESTS', 'FULL_TESTS', 'FINAL_REVIEW'].includes(reply.marker)) {
      assert(verified.some(({ tool, result }) => result?.type === 'commandExecution' && result.exitCode === 0
        && exactCommand(tool.input.command, 'node --test test/retry.test.cjs') && /# fail 0\b/.test(tool.output)), 'Same actual test item must substantiate test success');
    }
    if (reply.marker === 'FINAL_REVIEW') assert(verified.some(({ tool, result }) => result?.type === 'commandExecution'
      && exactCommand(tool.input.command, scopes.FINAL_REVIEW.commands[0]) && result.exitCode === 0));
    const images = wire.filter(value => value.event === 'image-view'); assert.deepEqual(reply.imageViews, images);
    for (const image of images) {
      assert.equal(scope.attachments, true); assert.equal(image.ownedPath, true); assert.equal(image.sha256, common.manifest.fixture.files['attachments/status-blue.png'].sha256);
      assert.equal(image.sessionHash, input.sessionHash); assert.equal(image.turnHash, started.turnHash); assert.equal(image.inputIndex, input.inputIndex);
    }
    if (!scope.patch || scope.patch === 'deny' || scope.readonly) sameFixture(common.manifest, reply.beforeFiles, observed.afterFiles);
    else {
      const permitted = scope.patch === 'tests' ? 'test/retry.test.cjs' : 'src/retry.cjs';
      for (const relative of Object.keys(common.manifest.fixture.files)) if (relative !== permitted) assert.equal(observed.afterFiles.hashes[relative], reply.beforeFiles.hashes[relative], 'A patch must not alter any other file');
      assert.notEqual(observed.afterFiles.hashes[permitted], reply.beforeFiles.hashes[permitted], 'Approved patch must actually change its owned target');
      if (scope.patch === 'fix') {
        const patch = verified.find(value => value.result.type === 'fileChange').tool.input.changes[0];
        const added = patch.diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1));
        assert.equal(added.length, 1);
        const original = common.manifest.fixture.files[permitted].text;
        assert.equal(observed.afterFiles.hashes[permitted], digest(original.replace('  return Math.min(cap, base * (attempt + 1));', added[0])), 'The first patch changes exactly its approved line');
      }
    }
    transactions.push({ reply, input, owner, scope, wire, turnHash: started.turnHash, started: reply.started, ended: reply.completedAt });
    return { marker: reply.marker, messageId: reply.messageId, conversationId: owner.conversationId, inputIndex: input.inputIndex,
      contentSha256: digest(reply.content), sessionHash: input.sessionHash, turnHash: started.turnHash, actualModel: nativeSession.actualModel,
      nativeResultIds: verified.map(value => value.result.itemIdHash), toolOutputEvidence: verified.map(value => value.outputProjection) };
  });
  assert.equal([...storage.owners.values()].flatMap(value => value.events).filter(value => value.type === 'responseComplete').length, 25);
  const main = proofs.filter(value => value.marker !== 'OTHER_PANEL'), other = proofs.find(value => value.marker === 'OTHER_PANEL');
  assert.equal(new Set(main.map(value => value.sessionHash)).size, 1, 'One actual thread survives main conversation settings changes and interrupted requests');
  assert.notEqual(other.sessionHash, main[0].sessionHash, 'Independent tab requires an independent native thread');
  const resumed = acceptance.threadResume, returned = transactions.find(value => value.reply.marker === 'RETURN_TASK');
  assert.equal(resumed.fromEffort, 'low'); assert.equal(resumed.toEffort, 'medium');
  assert.equal(resumed.beforeSessionHash, main[0].sessionHash); assert.equal(resumed.afterSessionHash, main[0].sessionHash);
  const config = one(common.receipts.filter(value => value.event === 'thread-config' && value.method === 'thread/resume'
    && value.wrapperPid === returned.input.wrapperPid && value.at <= returned.input.at), 'Native thread resumed after effort selection');
  assert.deepEqual(resumed.native, config); assert.equal(config.sessionHash, main[0].sessionHash); assert.equal(config.policy.effort, 'medium');
  assert.equal(returned.reply.nativeSession.method, 'thread/resume'); assert.notEqual(returned.input.wrapperPid, transactions[6].input.wrapperPid);
  for (const marker of ['RETURN_TASK', 'MAIN_RETURN', 'INVALID_MODEL_RECOVERY']) assert(acceptance.replies.find(value => value.marker === marker).content.includes(common.manifest.token));
  assert(acceptance.replies.find(value => value.marker === 'MAIN_RETURN').content.includes(common.manifest.attachmentToken));
  assert(acceptance.replies.find(value => value.marker === 'OTHER_PANEL').content.includes(common.manifest.otherPanelToken));
  return { proofs, transactions, seenMessages, seenInputs, seenTurns };
}

function auditFaults(common, acceptance, storage, journey) {
  const owner = storage.owners.get('main'), stops = [], transactions = [...journey.transactions];
  for (const [key, marker, scope] of [
    ['stopApproval', 'STOP_APPROVAL', { commands: ['cat canaries/approval.txt'], patch: 'deny', holdPatch: true }],
    ['stopStreaming', 'STOP_STREAM', {}],
  ]) {
    const fault = acceptance.faults[key]; assert.equal(fault.marker, marker);
    const input = one(common.inputs.filter(value => value.inputIndex === fault.request.inputIndex), 'One actual stopped input');
    assert.deepEqual(fault.request, input); assert(!journey.seenInputs.has(input.inputIndex)); journey.seenInputs.add(input.inputIndex);
    assert(input.outsideMemoryMarkers.includes(marker)); assert.equal(input.outsideMemoryContainsOtherPanelToken, false);
    sessionFor(common, input); assert.equal(input.effort, 'medium');
    assert(input.at >= fault.started && fault.requestedAt >= input.at);
    const next = journey.transactions.find(value => value.reply.marker === (key === 'stopApproval' ? 'STOP_APPROVAL_RECOVERY' : 'STOP_STREAM_RECOVERY'));
    assert(next && next.started > fault.requestedAt);
    const interval = owner.events.filter(value => value.at >= fault.started && value.at < next.started);
    const cancelled = one(interval.filter(value => value.type === 'requestCancelled'), 'Exactly one public Stop acknowledgement');
    assert(cancelled.at >= fault.requestedAt); assert(!interval.some(value => ['responseComplete', 'error', 'authError'].includes(value.type)));
    assert(!interval.some(value => value.type === 'responseChunk' && value.at > cancelled.at), 'Stopped turn cannot stream after its cancellation acknowledgement');
    assert.deepEqual(fault.events, interval.filter(value => ['requestCancelled', 'responseComplete'].includes(value.type)));
    assert.equal(fault.cancellationTransport, 'PROCESS_EVICTION'); assert.equal(fault.wrapperExited, true);
    assert.notEqual(next.input.wrapperPid, input.wrapperPid, 'Recovery must use a fresh owned process after eviction');
    const wire = wireFor(common, input), started = one(wire.filter(value => value.event === 'turn-started'), 'Stopped turn must have a real native turn ID');
    assert.equal(started.sessionHash, input.sessionHash); assert.equal(started.inputIndex, input.inputIndex);
    assert(!journey.seenTurns.has(started.turnHash)); journey.seenTurns.add(started.turnHash);
    assert(!wire.some(value => value.event === 'turn-completed' && value.status === 'completed'));
    assert(!wire.some(value => value.event === 'tool-result' && value.type === 'fileChange' && value.status === 'completed'));
    assert(!wire.some(value => ['image-view', 'unexpected-tool-item'].includes(value.event)));
    for (const recorded of fault.nativeReceipts) assert(wire.some(value => JSON.stringify(value) === JSON.stringify(recorded)), 'Fault evidence must reference actual receipts');
    sameFixture(common.manifest, fault.beforeFiles, fault.files);
    const partial = cancelled.payload?.message;
    if (partial) {
      assert.equal(partial.role, 'assistant'); assert.equal(partial.provider, 'openai-codex'); assert.equal(partial.model, common.manifest.model);
      assert(!journey.seenMessages.has(partial.id), 'Stop snapshot must not reuse a prior completed assistant ID'); journey.seenMessages.add(partial.id);
      const saved = one(owner.conversation.messages.filter(value => value.id === partial.id), 'Useful Stop snapshot must persist exactly once');
      assert.deepEqual(messageProjection(saved), messageProjection(partial));
      verifyTools(common, input, started.turnHash, partial.toolCalls || [], wire, scope, true, interval.filter(value => value.at <= cancelled.at));
      assert(!partial.content.includes(common.manifest.otherPanelToken));
    } else assert(!wire.some(value => value.event === 'tool-result'), 'Useful completed tool state cannot vanish at Stop');
    if (key === 'stopStreaming') {
      assert(partial?.content?.trim()); assert.deepEqual(messageProjection(fault.partialMessage), messageProjection(partial));
      const text = interval.filter(value => value.type === 'responseChunk' && value.payload?.type === 'text' && value.at <= fault.requestedAt)
        .map(value => value.payload.content || '').join('');
      assert(text.length > 30, 'Streaming Stop requires actual text progress before the click');
      assert(!wire.some(value => ['tool-start', 'tool-result'].includes(value.event)), 'Text-only Stop cannot run a tool');
    } else {
      assert.equal(fault.queuedRemoved, 2); assert.equal(fault.inputCount, input.inputIndex);
      const permission = one(interval.filter(value => value.type === 'permissionRequest' && value.payload.id === fault.permission.id), 'Actual pending card existed before Stop');
      assert.deepEqual(permission.payload, fault.permission); assert(permission.at <= fault.requestedAt);
      assert.equal(String(fault.permission.details.toolName).toLowerCase(), 'edit');
      assert(patchScope(fault.permission.details.toolInput.changes, common.owner.workspace, 'deny'));
    }
    transactions.push({ fault, input, owner, scope, wire, turnHash: started.turnHash, started: fault.started, ended: next.started, pendingId: key === 'stopApproval' ? fault.permission.id : undefined });
    stops.push({ kind: key, inputIndex: input.inputIndex, sessionHash: input.sessionHash, turnHash: started.turnHash, partialMessageId: partial?.id, cancelledAt: cancelled.at });
  }
  const invalid = acceptance.faults.invalidModel;
  assert.equal(invalid.selectedModel, common.manifest.invalidModel); assert.equal(invalid.rejectedAttempts, 1);
  assert([0, 1].includes(invalid.forwardedRejectedInputs)); assert.equal(acceptance.counts.forwardedRejectedInputs, invalid.forwardedRejectedInputs);
  const recovered = journey.transactions.find(value => value.reply.marker === 'INVALID_MODEL_RECOVERY');
  const invalidWire = common.receipts.filter(value => value.at >= invalid.selectedAt && value.at < recovered.started);
  const configs = invalidWire.filter(value => value.event === 'thread-config');
  assert(configs.length > 0); assert(configs.every(value => value.model === common.manifest.invalidModel));
  assert.deepEqual(invalid.configurations, configs);
  const rejected = invalidWire.filter(value => value.event === 'request');
  assert.equal(rejected.length, invalid.forwardedRejectedInputs); assert.deepEqual(invalid.requests, rejected);
  for (const input of rejected) {
    assert.equal(input.model, common.manifest.invalidModel); assert(input.outsideMemoryMarkers.includes('INVALID_MODEL'));
    assert(!journey.seenInputs.has(input.inputIndex)); journey.seenInputs.add(input.inputIndex);
  }
  assert(!invalidWire.some(value => ['tool-start', 'tool-result', 'image-view', 'unexpected-tool-item'].includes(value.event)));
  assert(!invalidWire.some(value => value.event === 'turn-completed' && value.status === 'completed'));
  assert(invalidWire.some(value => value.event === 'rpc-result' && value.success === false || value.event === 'native-error' && !value.willRetry), 'Real native rejection must accompany the public error');
  const interval = owner.events.filter(value => value.at >= invalid.selectedAt && value.at < recovered.started);
  const errors = interval.filter(value => ['error', 'authError'].includes(value.type));
  assert.deepEqual(invalid.errors, errors); assert(errors.length > 0); assert(!interval.some(value => value.type === 'responseComplete'));
  const errorText = errors.map(value => JSON.stringify(value.payload)).join('\n');
  assert(/model/i.test(errorText) && /invalid|not found|not available|not exist|unknown|not support|does not exist/i.test(errorText));
  assert(!/quota|rate.limit|session.limit|usage.limit|unauthori[sz]ed|invalid.api.key|sign.in|log.in/i.test(errorText), 'Service/authentication limits must not be credited as invalid-model enforcement');
  sameFixture(common.manifest, invalid.beforeFiles, invalid.files);
  for (const input of common.inputs) assert(journey.seenInputs.has(input.inputIndex), 'No hidden retry or unaccounted backend request');
  assert.equal(journey.seenInputs.size, common.inputs.length);
  assert(!common.inputs.some(value => value.outsideMemoryMarkers.some(marker => ['QUEUED_ONE', 'QUEUED_TWO'].includes(marker))));
  const assistants = [...storage.owners.values()].flatMap(value => value.conversation.messages.filter(message => message.role === 'assistant'));
  assert.equal(assistants.length, journey.seenMessages.size); assert(assistants.every(value => journey.seenMessages.has(value.id)));
  const users = [...storage.owners.values()].flatMap(value => value.conversation.messages.filter(message => message.role === 'user'));
  assert.equal(users.length, 28, '25 completed, two stopped and one visibly rejected user turn must survive');
  return { stops, transactions, invalidModel: { rejectedAttempts: 1, forwardedInputs: rejected.length, errorSha256: digest(errorText), recoveredMessageId: recovered.reply.messageId } };
}

function auditPermissions(common, acceptance, storage, transactions) {
  const publicRequests = [...storage.owners.values()].flatMap(owner => owner.events.filter(value => value.type === 'permissionRequest').map(event => ({ ...event, label: owner.label })));
  const decisions = storage.observations.filter(value => value.event === 'permission-decision');
  assert.equal(new Set(publicRequests.map(value => value.payload.id)).size, publicRequests.length);
  assert.equal(new Set(decisions.map(value => value.id)).size, decisions.length);
  const nativeRequests = common.receipts.filter(value => value.event === 'approval-request'), responses = common.receipts.filter(value => value.event === 'approval-decision');
  const paired = new Set(), usedResponses = new Set(), usedDecisions = new Set();
  const proofs = publicRequests.map(event => {
    const card = event.payload, details = card.details;
    const transaction = one(transactions.filter(value => value.owner.label === event.label && event.at >= value.started && event.at <= value.ended), 'Permission has one owning active turn');
    const { input, scope, wire, turnHash } = transaction; assert(!scope.readonly);
    assert(permittedTool({ name: details.toolName, input: details.toolInput }, scope, common.owner.workspace));
    const request = one(nativeRequests.filter(value => !paired.has(value) && value.wrapperPid === input.wrapperPid && value.inputIndex === input.inputIndex
      && value.toolInputSha256 === digest(JSON.stringify(details.toolInput)) && value.at <= event.at), 'Public card must join the actual native request bytes'); paired.add(request);
    assert.equal(request.sessionHash, input.sessionHash); assert.equal(request.turnHash, turnHash);
    const isEdit = String(details.toolName).toLowerCase() === 'edit';
    assert.equal(request.method, isEdit ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval');
    const matching = responses.filter(value => value.wrapperPid === request.wrapperPid && value.inputIndex === input.inputIndex
      && value.nativeRequestIdHash === request.nativeRequestIdHash && common.receipts.indexOf(value) > common.receipts.indexOf(request));
    assert(matching.length <= 1, 'Never answer the same native request twice');
    const decision = decisions.filter(value => value.id === card.id), response = matching[0];
    if (transaction.pendingId === card.id) {
      assert.equal(decision.length, 0, 'Pending Stop cannot manufacture an Allow/Deny click');
      if (response) {
        assert(['cancel', 'decline'].includes(response.decision)); assert(response.at >= transaction.fault.requestedAt);
      }
      assert(!wire.some(value => value.event === 'tool-result' && value.itemIdHash === request.itemIdHash && value.status === 'completed'));
    } else {
      const choice = one(decision, 'Every other public approval is explicitly answered once'); usedDecisions.add(choice);
      assert.equal(choice.label, event.label); assert.equal(choice.panelId, transaction.owner.panelId); assert.equal(choice.conversationId, transaction.owner.conversationId);
      assert.equal(choice.name, String(details.toolName).toLowerCase()); assert.deepEqual(choice.input, details.toolInput);
      assert.equal(choice.inputSha256, request.toolInputSha256); assert(choice.at >= event.at && choice.at <= transaction.ended);
      assert(response); assert(response.at >= event.at && response.at <= transaction.ended);
      const denied = scope.patch === 'deny' && isEdit; assert.equal(choice.expectedDenial, denied); assert.equal(choice.approved, !denied);
      assert.equal(response.decision, denied ? 'decline' : 'accept');
      if (scope.patch === 'fix' && isEdit) assert.equal(choice.beforeFiles.hashes['src/retry.cjs'], common.manifest.fixture.files['src/retry.cjs'].sha256);
      const result = one(wire.filter(value => value.event === 'tool-result' && value.itemIdHash === request.itemIdHash), 'Approval owns one matching native result');
      assert(common.receipts.indexOf(response) < common.receipts.indexOf(result), 'Result must follow actual approval response');
      if (denied) assert(['failed', 'declined'].includes(result.status)); else assert.equal(result.status, 'completed');
      for (const [relative, original] of Object.entries(common.manifest.fixture.files)) if (!common.manifest.fixture.editableFiles.includes(relative)) assert.equal(choice.beforeFiles.hashes[relative], original.sha256);
    }
    if (response) { assert(!usedResponses.has(response)); usedResponses.add(response); }
    return { publicId: card.id, nativeRequestIdHash: request.nativeRequestIdHash, itemIdHash: request.itemIdHash, inputIndex: input.inputIndex,
      decision: response?.decision ?? 'PROCESS_EVICTION_WITHOUT_REPLY', pendingStop: transaction.pendingId === card.id };
  });
  // A native Read Only request can be declined automatically by the bridge.
  // This exception cannot grant authority: it must join the exact scoped
  // failed canary item, with no public card and one native decline only.
  for (const request of nativeRequests.filter(value => !paired.has(value))) {
    const transaction = one(transactions.filter(value => value.scope.readonly && value.input.wrapperPid === request.wrapperPid
      && value.input.inputIndex === request.inputIndex), 'Only a Read Only turn may decline without a public card');
    assert.equal(transaction.reply.marker, 'READONLY_CANARY'); assert.equal(request.method, 'item/fileChange/requestApproval');
    assert.equal(request.sessionHash, transaction.input.sessionHash); assert.equal(request.turnHash, transaction.turnHash);
    const tool = one(transaction.reply.tools.filter(value => digest(value.id) === request.itemIdHash), 'Automatic decline owns the actual public failed tool');
    assert(permittedTool(tool, transaction.scope, common.owner.workspace)); assert.equal(tool.status, 'failed');
    const result = one(transaction.wire.filter(value => value.event === 'tool-result' && value.itemIdHash === request.itemIdHash), 'Automatic decline owns one actual failed result');
    assert(['failed', 'declined'].includes(result.status));
    const response = one(responses.filter(value => value.wrapperPid === request.wrapperPid && value.inputIndex === request.inputIndex
      && value.nativeRequestIdHash === request.nativeRequestIdHash && common.receipts.indexOf(value) > common.receipts.indexOf(request)), 'Exactly one automatic native decline');
    assert.equal(response.decision, 'decline'); assert(response.at >= request.at && response.at <= transaction.ended);
    assert(common.receipts.indexOf(response) < common.receipts.indexOf(result));
    assert(!usedResponses.has(response)); usedResponses.add(response); paired.add(request);
    proofs.push({ nativeRequestIdHash: request.nativeRequestIdHash, itemIdHash: request.itemIdHash, inputIndex: request.inputIndex,
      decision: 'decline', automaticReadOnlyDenial: true });
  }
  assert.equal(paired.size, nativeRequests.length, 'Every native request must have public ownership or an exact Read Only denial');
  assert.equal(usedResponses.size, responses.length, 'No unaccounted native approval response'); assert.equal(usedDecisions.size, decisions.length);
  for (const marker of ['PATCH_APPLY', 'RETRY_AFTER_PATCH', 'TEST_REVISION']) {
    const transaction = transactions.find(value => value.reply?.marker === marker);
    assert(proofs.some(value => value.inputIndex === transaction.input.inputIndex && value.decision === 'accept'
      && transaction.wire.some(item => item.event === 'tool-result' && item.type === 'fileChange' && item.itemIdHash === value.itemIdHash)));
  }
  const denied = transactions.find(value => value.reply?.marker === 'DENY_CANARY');
  const declined = one(proofs.filter(value => value.inputIndex === denied.input.inputIndex && value.decision === 'decline'), 'One denied canary write');
  assert.equal(acceptance.deniedCanary.replyId, denied.reply.messageId);
  assert.deepEqual(acceptance.deniedCanary.decisions, decisions.filter(value => value.id === declined.publicId));
  return proofs;
}

function auditReadOnly(common, acceptance, storage, journey) {
  const fault = acceptance.faults.readonlyWrite;
  const transaction = one(journey.transactions.filter(value => value.reply.marker === 'READONLY_CANARY'), 'One Read Only probe turn');
  assert.equal(fault.replyId, transaction.reply.messageId); assert.deepEqual(fault.request, transaction.input);
  assert.deepEqual(fault.nativeReceipts, transaction.reply.nativeTools); assert.equal(fault.permissionRequests, 0);
  assert(!transaction.owner.events.some(value => value.type === 'permissionRequest' && value.at >= transaction.started && value.at <= transaction.ended));
  sameFixture(common.manifest, fault.beforeFiles, fault.files);
  const probe = common.manifest.readonlyProbe;
  assert(probe); assert.equal(probe.relativePath, 'test/read-only-policy.cjs');
  assert.equal(probe.command, 'node test/read-only-policy.cjs');
  assert.equal(probe.canaryRelativePath, 'canaries/approval.txt');
  assert.equal(probe.expectedCanarySha256, common.manifest.fixture.files[probe.canaryRelativePath].sha256);
  const expected = createReadOnlyProbe({ workspace: common.owner.workspace,
    canaryContent: fs.readFileSync(path.join(common.owner.workspace, probe.canaryRelativePath), 'utf8') });
  assert.deepEqual(probe, expected.manifest, 'The prepared probe must match the independently reconstructed owned script');
  const source = fs.readFileSync(path.join(common.owner.workspace, probe.relativePath));
  assert.equal(source.toString(), expected.source); assert.equal(digest(source), probe.sha256);
  assert.equal(common.manifest.fixture.files[probe.relativePath].sha256, probe.sha256);
  assert(!common.manifest.fixture.editableFiles.includes(probe.relativePath));
  const hasTools = transaction.reply.nativeTools.length || transaction.reply.tools.length;
  const result = hasTools
    ? readonlyProbeOutcome({ tools: transaction.reply.nativeTools, publicTools: transaction.reply.tools,
      workspace: common.owner.workspace, probe, beforeFiles: fault.beforeFiles, afterFiles: fault.files })
    : readonlyOutcome({ tools: [], publicTools: [], workspace: common.owner.workspace,
      content: transaction.reply.content, permissionRequests: 0 });
  if (hasTools) assert.equal(result, 'PASS_NATIVE_SANDBOX_WRITE_DENIAL');
  else {
    assert(result.startsWith('PARTIAL'));
    assert(acceptance.limits.some(value => value.includes(result) && /Read Only/.test(value)), 'No-tool outcomes must retain explicit missing-coverage limits');
  }
  assert.equal(fault.status, result);
  const observed = one(storage.observations.filter(value => value.event === 'readonly-canary'), 'One actual Read Only observation');
  for (const key of Object.keys(fault)) assert.deepEqual(observed[key], fault[key]);
  return { status: result, replyId: fault.replyId, probeSha256: probe.sha256,
    nativePolicy: transaction.reply.nativeSession.returnedPolicy, filesUnchanged: true,
    scope: hasTools ? 'Immutable owned script made a real filesystem write attempt, received a native permission error, and left the canary unchanged. This verifies command sandbox enforcement, not native file-change tool denial.' : 'No native tool was observed; the returned prose does not establish sandbox enforcement.' };
}

function auditAttachments(common, acceptance, storage, journey) {
  const evidence = acceptance.attachmentsEvidence, transaction = journey.transactions.find(value => value.reply.marker === 'ATTACHMENTS');
  assert.equal(evidence.status, 'PASS_REAL_ATTACHMENTS'); assert.equal(evidence.replyId, transaction.reply.messageId);
  assert.equal(evidence.acknowledged.length, 2); assert.equal(new Set(evidence.acknowledged.map(value => value.id)).size, 2);
  const owner = storage.owners.get('main'), messageIndex = owner.conversation.messages.findIndex(value => value.id === evidence.replyId);
  const user = owner.conversation.messages[messageIndex - 1]; assert.equal(user.role, 'user'); assert.equal(user.attachments.length, 2);
  const expected = [['attachments/brief.txt', 'file'], ['attachments/status-blue.png', 'image']];
  for (const [relative, type] of expected) {
    const attachment = one(evidence.acknowledged.filter(value => value.filePath === path.join(common.owner.workspace, relative)), 'Each prepared attachment has a public acknowledgement');
    assert.equal(attachment.type, type); assert.equal(attachment.size, common.manifest.fixture.files[relative].bytes);
    const actual = owner.events.filter(value => value.type === 'fileAttachmentSelected' && value.at <= transaction.started)
      .flatMap(value => value.payload.attachments || []).filter(value => value.id === attachment.id);
    assert(actual.some(value => JSON.stringify(value) === JSON.stringify(attachment)));
    const saved = one(user.attachments.filter(value => value.id === attachment.id), 'Each attachment persists on its exact originating user turn');
    for (const key of ['id', 'fileName', 'type', 'filePath', 'size']) assert.equal(saved[key], attachment[key]);
    assert(!saved.base64Data);
  }
  assert.deepEqual(evidence.preparedHashes, expected.map(([relative]) => common.manifest.fixture.files[relative].sha256));
  assert.deepEqual(evidence.imageViews, transaction.reply.imageViews);
  const completed = transaction.reply.imageViews.filter(value => value.phase === 'item/completed'); assert(completed.length > 0);
  for (const item of completed) {
    assert.equal(item.ownedPath, true); assert.equal(item.sha256, common.manifest.fixture.files['attachments/status-blue.png'].sha256);
    assert.equal(item.sessionHash, transaction.input.sessionHash); assert.equal(item.turnHash, transaction.turnHash);
    const file = path.resolve(common.owner.workspace, item.relativePath); contained(common.owner.workspace, file);
    const prepared = path.join(common.owner.workspace, 'attachments/status-blue.png');
    const temporary = path.dirname(file) === path.join(common.owner.workspace, '.mysti/tmp')
      && /^mysti-attachment-[A-Za-z0-9-]+\.png$/.test(path.basename(file));
    assert(file === prepared || temporary, 'Native image view must consume the exact prepared image or its owned temporary copy');
    if (fs.existsSync(file)) { assert(!fs.lstatSync(file).isSymbolicLink()); assert.equal(hash(file), item.sha256); }
    else assert(temporary, 'Only temporary attachment copies may be removed after consumption');
    assert.equal(hash(prepared), item.sha256, 'Original fixture bytes survive temporary-file cleanup');
  }
  assert(transaction.reply.content.includes(common.manifest.attachmentToken)); assert(/1[,.]?500/.test(transaction.reply.content)); assert(/\bblue\b/i.test(transaction.reply.content));
  return { replyId: evidence.replyId, attachmentIds: evidence.acknowledged.map(value => value.id), preparedHashes: evidence.preparedHashes,
    nativeImageItemIds: completed.map(value => value.itemIdHash), displayLimit: 'Actual image-view receipt and owned PNG bytes verified; this adapter does not necessarily render an image-view tool card.' };
}
function auditOracles(common, acceptance, workspace, storage) {
  assert.deepEqual(acceptance.oracles.map(value => value.stage), ['backoff', 'full', 'full']);
  assert.equal(new Set(acceptance.oracles.map(value => value.path)).size, 3, 'Earlier oracle reports must never be overwritten');
  const observations = storage.observations.filter(value => value.event === 'independent-oracle'); assert.equal(observations.length, 3);
  return acceptance.oracles.map((evidence, index) => {
    contained(common.owner.directory, evidence.path); assert.equal(evidence.exitCode, 0);
    const report = read(evidence.path), count = index ? 14 : 3;
    assert.equal(report.status, 'PASS'); assert.equal(report.stage, evidence.stage); assert.equal(report.failed, 0); assert.equal(report.passed, count);
    assert.equal(report.checks.length, count); assert.equal(new Set(report.checks.map(value => value.name)).size, count); assert(report.checks.every(value => value.status === 'PASS'));
    assert.equal(report.realProviderInputs, 0); assert.equal(report.fixtureSourceUnchanged, true);
    assert.deepEqual(report.network, ['owned loopback HTTP only']); assert.equal(report.sourceSha256, evidence.sourceSha256);
    if (index) assert.equal(report.sourceSha256, workspace.files['src/retry.cjs'].sha256);
    for (const key of Object.keys(evidence)) assert.deepEqual(observations[index][key], evidence[key]);
    return { stage: report.stage, passed: count, sourceSha256: report.sourceSha256, artifact: evidence.path, artifactSha256: hash(evidence.path) };
  });
}
function auditAuxiliaryArtifacts(common) {
  const { manifest, owner } = common, auxiliary = manifest.auxiliary;
  assert.equal(auxiliary.maxInputs, 32); assert.equal(auxiliary.routingSetting, 'mysti.claudeCodePath');
  const settings = read(path.join(owner.profile, 'User/settings.json'));
  assert.equal(settings[auxiliary.routingSetting], auxiliary.launcher); assert.equal(settings['mysti.codexPath'], owner.wrappers['openai-codex']);
  assert.notEqual(settings['mysti.planDetection.enabled'], false);
  assert.equal(settings['mysti.defaultModel'], 'gpt-6.1-sol'); assert.equal(settings['mysti.codexProfile'], '');
  assert.equal(owner.auxiliaryReceiptPaths.length, 1); assert(!owner.receiptPaths.includes(owner.auxiliaryReceiptPaths[0]));
  const receipts = owner.auxiliaryReceiptPaths.flatMap(file => { contained(owner.directory, file); return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse); });
  const live = execFileSync('ps', ['-axo', 'pid=,lstart='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/); assert(match); return { pid: +match[1], startedAt: match[2] };
  });
  assert(!fs.existsSync(auxiliary.counterFile + '.lock'));
  const result = auditAuxiliary({ auxiliary, receipts, ancestry: common.ancestry,
    cleanup: read(path.join(owner.directory, 'editor-exit-process-check.json')),
    counter: fs.existsSync(auxiliary.counterFile) ? read(auxiliary.counterFile) : { forwardedInputs: 0, maxInputs: 32 },
    live, primaryAuxiliaryInputs: common.receipts.filter(value => value.event === 'auxiliary-input').length,
    temporaryRoot: fs.realpathSync(os.tmpdir()) });
  result.remainingPrivateDirectories = result.temporaryDirectories.filter(file => fs.existsSync(file));
  for (const file of result.remainingPrivateDirectories) { assert(!fs.lstatSync(file).isSymbolicLink()); assert.deepEqual(fs.readdirSync(file), []); }
  return result;
}

function auditPortability(common, acceptance, workspace, storage) {
  const evidence = acceptance.portabilityOracle;
  assert(evidence && typeof evidence.path === 'string');
  contained(common.owner.directory, evidence.path);
  assert(!fs.lstatSync(evidence.path).isSymbolicLink(), 'Portability report must not be a symlink');
  contained(fs.realpathSync(common.owner.directory), fs.realpathSync(evidence.path));
  assert.equal(evidence.exitCode, 0);
  assert.equal(hash(evidence.path), evidence.sha256);
  const report = read(evidence.path);
  assert.equal(report.status, 'PASS'); assert.equal(report.passed, 45); assert.equal(report.failed, 0);
  assert.equal(report.expectedChecks, 45); assert.equal(report.realProviderInputs, 0);
  assert.equal(report.source, path.join(common.owner.workspace, 'src/retry.cjs'));
  assert.equal(report.sourceSha256, workspace.files['src/retry.cjs'].sha256);
  assert.equal(report.sourceSha256, evidence.sourceSha256); assert.equal(report.fixtureSourceUnchanged, true);
  assert.deepEqual(report.timezones, ['UTC', 'Asia/Amman', 'America/Los_Angeles']);
  assert.equal(report.runs.length, 3);
  assert.equal(report.oracleSha256, hash(path.join(__dirname, 'http-date-portability-oracle.cjs')));
  for (const [index, run] of report.runs.entries()) {
    assert.equal(run.timezone, report.timezones[index]); assert.equal(run.exitCode, 0); assert.equal(run.status, 'PASS');
    assert.equal(run.signal, null); assert.equal(run.timedOut, false);
    assert.equal(run.report.status, 'PASS'); assert.equal(run.report.sourceSha256, report.sourceSha256);
    assert.equal(run.report.timezone, run.timezone); assert.equal(run.report.fixtureSourceUnchanged, true);
    assert.equal(run.report.checks.length, 15); assert(run.report.checks.every(check => check.status === 'PASS'));
    assert.deepEqual(run.report.checks.map(check => check.name), HTTP_DATE_VECTORS.map(vector => vector.name));
    for (const [vectorIndex, check] of run.report.checks.entries()) {
      const vector = HTTP_DATE_VECTORS[vectorIndex];
      const expected = vector.expected === undefined ? { type: 'undefined' } : { type: 'number', value: vector.expected };
      assert.deepEqual(check.input, vector.value); assert.deepEqual(check.expected, expected); assert.deepEqual(check.actual, expected);
    }
  }
  assert.equal(report.networkRequests, 0); assert.equal(report.editorLaunches, 0);
  const observed = one(storage.observations.filter(value => value.event === 'independent-portability-oracle'), 'Exactly one saved portability oracle event');
  for (const key of Object.keys(evidence)) assert.deepEqual(observed[key], evidence[key]);
  return { passed: 45, sourceSha256: report.sourceSha256, artifact: evidence.path, artifactSha256: evidence.sha256 };
}

function audit(directory) {
  const common = auditCommon(directory), acceptance = read(path.join(common.owner.directory, 'acceptance.json'));
  assert.equal(acceptance.stage, 'FULL_25_FOLLOWUP'); assert(['PASS_FULL_25_BOUNDED', 'PARTIAL_FULL_25'].includes(acceptance.status));
  assert(Array.isArray(acceptance.limits)); assert.equal(acceptance.semanticReview, 'ROOT_INDEPENDENT_REVIEW_REQUIRED');
  const workspace = auditWorkspace(common.manifest, common.owner, { ...acceptance, sourcePanelId: acceptance.panelId });
  const stored = readStoredConversations(common.owner), storage = auditTabsAndStorage(common, acceptance, stored);
  assert.equal(acceptance.sourceId, storage.owners.get('main').conversationId); assert.equal(acceptance.panelId, storage.owners.get('main').panelId);
  assert.equal(acceptance.otherSourceId, storage.owners.get('other').conversationId); assert.equal(acceptance.otherPanelId, storage.owners.get('other').panelId);
  const journey = auditReplies(common, acceptance, storage), faults = auditFaults(common, acceptance, storage, journey);
  const permissions = auditPermissions(common, acceptance, storage, faults.transactions), readonly = auditReadOnly(common, acceptance, storage, journey);
  const attachments = auditAttachments(common, acceptance, storage, journey), oracles = auditOracles(common, acceptance, workspace, storage);
  const portability = auditPortability(common, acceptance, workspace, storage), auxiliary = auditAuxiliaryArtifacts(common);
  const partial = readonly.status.startsWith('PARTIAL') || acceptance.limits.length > 0;
  assert.equal(acceptance.status, partial ? 'PARTIAL_FULL_25' : 'PASS_FULL_25_BOUNDED');
  return { status: acceptance.status, checkedAt: new Date().toISOString(), auditorSha256: hash(__filename),
    sourceIdentity: common.manifest.sourceIdentity, packageIdentity: common.manifest.packageIdentity,
    bundleSha256: common.manifest.bundleSha256, chatSha256: common.manifest.chatSha256, pinnedIdentities: common.pinned,
    compiledJourneySha256: common.reservation.harnessSha256, observerSha256: common.reservation.observerSha256,
    evidenceSha256: Object.fromEntries(['acceptance.json', 'observations.json', 'events-main.json', 'events-other.json'].map(file => [file, hash(path.join(common.owner.directory, file))])),
    receipts: common.owner.receiptPaths.map(file => ({ file, sha256: hash(file) })), counts: acceptance.counts,
    replies: journey.proofs, stops: faults.stops, invalidModel: faults.invalidModel, permissions, readonly, attachments, oracles, portability, auxiliary, workspace,
    disk: { database: stored.database, conversations: [...storage.owners.values()].map(value => ({ id: value.conversationId, panelId: value.panelId,
      messageIds: value.conversation.messages.map(message => message.id), projectionSha256: digest(JSON.stringify(value.conversation.messages.map(messageProjection))) })) },
    observedProcessIdentitiesExited: common.ancestry.processIdentities.length, processSamplingMs: 250,
    semanticReview: 'ROOT_INDEPENDENT_REVIEW_REQUIRED', elapsedCampaigns: { S: 'NOT_RUN', W: 'NOT_RUN', E: 'NOT_RUN', P: 'NOT_RUN' },
    scope: '25 completed F1 Codex developer replies in two actual tabs of one ordinary installed editor; exact native receipts and disk persistence. No F2 or elapsed soak acceptance.',
    limits: [...acceptance.limits, 'Root must independently review all 25 replies, final source and appended tests for semantic correctness.',
      'Native image-view evidence does not imply that the adapter displays a corresponding image tool card.',
      'PID plus birth cleanup checks observed descendants at 250ms sampling; processes entirely between samples can be missed.',
      'Named profiles, native questions/plans/compaction, F2, other operating systems and elapsed S/W/E/P remain NOT_RUN.'] };
}
module.exports = { audit, auditCommon, auditWorkspace, auditTabsAndStorage, auditReplies, auditFaults, auditPermissions,
  auditReadOnly, auditAttachments, auditOracles, auditPortability, auditAuxiliaryArtifacts, verifyTools, sessionFor, sameFixture, wireFor, permittedTool };
if (require.main === module) {
  const directory = path.resolve(process.env.MYSTI_PB02_FULL_FOLLOWUP_ARTIFACT_DIR || ''); contained(root, directory);
  const primary = path.join(directory, 'independent-audit.json');
  const output = fs.existsSync(primary) ? path.join(directory, `independent-audit-${Date.now()}.json`) : primary;
  try { const result = audit(directory); fs.writeFileSync(output, JSON.stringify(result, null, 2), { flag: 'wx' }); console.log(JSON.stringify(result)); }
  catch (error) {
    const result = { status: 'FAIL', checkedAt: new Date().toISOString(), auditorSha256: hash(__filename),
      error: { name: error.name, message: error.message }, scope: 'PB-02 full25 read-only owned-artifact audit; no editor or backend launch' };
    fs.writeFileSync(output, JSON.stringify(result, null, 2), { flag: 'wx' }); console.error(JSON.stringify(result)); process.exitCode = 1;
  }
}
