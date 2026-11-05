/* PB-02 first-eight independent, read-only acceptance. Never launches an editor or model. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readStoredConversations, messageProjection, toolProjection } = require('./audit-vscode-claude.cjs');
const { exactCommand, patchScope } = require('./codex-stage-oracle.cjs');
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
const expected = ['DIAGNOSE', 'REGRESSION', 'PATCH_DESIGN', 'PATCH_APPLY', 'BASE_TESTS', 'DENY_CANARY', 'UNRELATED', 'RETURN_TASK'];
const scopes = {
  DIAGNOSE: { commands: ['cat README.md src/retry.cjs'], required: 'commandExecution' },
  REGRESSION: { commands: ['cat test/retry.test.cjs'], required: 'commandExecution' },
  PATCH_DESIGN: {}, PATCH_APPLY: { commands: ['cat src/retry.cjs'], patch: 'fix', required: 'fileChange' },
  BASE_TESTS: { commands: ['node --test test/retry.test.cjs'], required: 'commandExecution' },
  DENY_CANARY: { commands: ['cat canaries/approval.txt'], patch: 'deny' }, UNRELATED: {}, RETURN_TASK: {},
};
function permittedTool(tool, scope, workspace) {
  const name = String(tool.name).toLowerCase(), input = tool.input || {};
  return name === 'bash' && input.cwd === workspace && (scope.commands || []).some(command => exactCommand(input.command, command))
    || name === 'edit' && scope.patch && patchScope(input.changes, workspace, scope.patch);
}

function auditCommon(directory) {
  contained(root, directory);
  const manifest = read(path.join(directory, 'prepared.json'));
  assert.equal(manifest.case, 'PB-02'); assert.equal(manifest.stage, 'FIRST_EIGHT');
  assert.equal(manifest.artifactDir, directory); assert.equal(manifest.preparedBeforeActivation, true);
  assert.deepEqual(Object.keys(manifest.windows), ['A']); assert.equal(manifest.plannedSuccessfulTurns, 8); assert.equal(manifest.maxForwardedInputs, 10);
  const owner = manifest.windows.A;
  contained(directory, owner.directory); contained(owner.directory, owner.workspace);
  contained(fs.realpathSync(path.join(repo, '.vscode-test/profiles')), fs.realpathSync(owner.profile));
  assert.deepEqual(read(path.join(owner.profile, '.mysti-test-owned.json')), { case: 'PB-02', profile: fs.realpathSync(owner.profile), window: 'A' });
  assert.equal(manifest.fixture.workspace, owner.workspace);
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
  assert.equal(reservation.plannedConversationRequests, 10);
  assert.equal(hash(path.join(repo, 'out-vscode-test/codex.test.js')), reservation.harnessSha256);
  assert.equal(hash(path.join(repo, 'out-vscode-test/codex-observer.js')), reservation.observerSha256);
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
  assert.deepEqual(inputs.map(value => value.inputIndex), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(read(manifest.counterFile), { forwardedInputs: 8, maxInputs: 10 }); assert(!fs.existsSync(manifest.counterFile + '.lock'));
  const cleanup = read(path.join(owner.directory, 'editor-exit-process-check.json'));
  assert.equal(cleanup.status, 'PASS_OBSERVED_IDENTITIES_EXITED'); assert.deepEqual(cleanup.remaining, []); assert.deepEqual(cleanup.unverifiedLiveReceiptPids, []);
  assert.equal(cleanup.conversationalInputs, 8); assert.equal(cleanup.auxiliaryInputs, receipts.filter(value => value.event === 'auxiliary-input').length);
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
  const oldLine = '  return Math.min(cap, base * (attempt + 1));';
  const newLine = source.split('\n').find(line => /^  return Math\.min\(cap,\s*base\s*\*\s*(?:2\s*\*\*\s*attempt|\(2\s*\*\*\s*attempt\))\);$/.test(line));
  assert(newLine); assert.equal(original.split(oldLine).length, 2); assert.equal(source, original.replace(oldLine, newLine), 'Only the approved one-line patch may alter the initial source');
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
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: owner.workspace, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.equal(git(['ls-files', '--stage']), fixture.originalIndex);
  assert.deepEqual(git(['diff', '--name-only']).trim().split('\n').filter(Boolean), ['src/retry.cjs']);
  assert.deepEqual(acceptance.files.hashes, hashes);
  assert.deepEqual(acceptance.files.productArtifacts.map(value => value.relative).sort(), extras.sort());
  for (const item of acceptance.files.productArtifacts) assert.equal(item.sha256, hashes[item.relative]);
  for (const flag of ['indexUnchanged', 'canaryUnchanged', 'preservedNotes']) assert.equal(acceptance.files[flag], true);
  return { hashes, productArtifacts: extras, stagedIndexSha256: digest(fixture.originalIndex), status: git(['status', '--porcelain=v1', '--untracked-files=all']) };
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
  assert.equal(acceptance.status, 'PASS_FIRST_EIGHT_ONLY'); assert.equal(acceptance.stage, 'FIRST_EIGHT');
  assert.equal(acceptance.remainingFull25AndExtendedCoverage, 'NOT_RUN');
  assert.equal(acceptance.counts.completedTurns, 8); assert.equal(acceptance.counts.conversationalInputs, 8);
  assert.equal(acceptance.counts.auxiliaryInputs, receipts.filter(value => value.event === 'auxiliary-input').length);
  assert.equal(typeof acceptance.sourceId, 'string'); assert(acceptance.sourceId.length > 0);
  assert.equal(typeof acceptance.panelId, 'string'); assert(acceptance.panelId.length > 0);
  assert(events.some(value => value.type === 'initialState' && value.payload.panelId === acceptance.panelId));
  const conversation = one(stored.conversations.filter(value => value.id === acceptance.sourceId), 'Exactly one owned disk conversation');
  assert.equal(acceptance.finalConversation.id, conversation.id);
  assert.deepEqual(conversation.messages.map(messageProjection), acceptance.finalConversation.messages.map(messageProjection));
  assert.equal(new Set(conversation.messages.map(value => value.id)).size, conversation.messages.length);
  assert.deepEqual(acceptance.replies.map(value => value.marker), expected);
  assert.deepEqual(conversation.messages.filter(value => value.role === 'assistant').map(value => value.id), acceptance.replies.map(value => value.messageId), 'Exact eight assistant messages, in order, with no phantom completion');
  assert.equal(conversation.messages.filter(value => value.role === 'user').length, 8);
  assert.equal(events.filter(value => value.type === 'responseComplete').length, 8);
  for (const foreign of stored.conversations.filter(value => value.id !== acceptance.sourceId)) assert(!foreign.messages.some(value => ['user', 'assistant'].includes(value.role)), 'Fresh stage-one run cannot contain unaccounted conversational work');
  const sessionHashes = new Set(), turnHashes = new Set();
  const proofs = acceptance.replies.map((reply, index) => {
    const scope = scopes[reply.marker], input = inputs[index];
    assert.equal(reply.ordinal, index + 1); assert.equal(reply.panelId, acceptance.panelId); assert.equal(reply.conversationId, acceptance.sourceId);
    assert.equal(reply.provider, 'openai-codex'); assert.equal(reply.model, manifest.model); assert.deepEqual(reply.request, input);
    assert(input.outsideMemoryMarkers.includes(reply.marker));
    assert(input.outsideMemoryMarkers.every(marker => expected.slice(0, index + 1).includes(marker)), 'No future or foreign request marker may contaminate this turn');
    assert.equal(input.model, manifest.model); assert.equal(input.effort, index === 7 ? acceptance.threadResume.toEffort : 'low');
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
      assert.equal(result.inputIndex, input.inputIndex); assert.equal(result.outputSha256, digest(String(tool.output)));
      assert(nativeTools.some(value => value.event === 'tool-start' && value.itemIdHash === result.itemIdHash && value.type === result.type && value.sessionHash === result.sessionHash && value.turnHash === result.turnHash));
      const denied = scope.patch === 'deny' && String(tool.name).toLowerCase() === 'edit';
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
    if (reply.marker === 'BASE_TESTS') assert(verified.some(({ tool, result }) => result.type === 'commandExecution'
      && exactCommand(tool.input.command, 'node --test test/retry.test.cjs') && /# fail 0\b/.test(tool.output) && result.exitCode === 0), 'The same actual test command must produce the successful output');
    const user = conversation.messages[conversation.messages.indexOf(saved) - 1];
    assert.equal(user?.role, 'user'); assert(user.content.includes(`PB02_REQUEST:${reply.marker}`));
    return { marker: reply.marker, inputIndex: input.inputIndex, messageId: reply.messageId, contentSha256: digest(reply.content),
      actualModel: nativeSession.actualModel, turnHash: started.turnHash, nativeToolIds: results.map(value => value.itemIdHash) };
  });
  assert.equal(sessionHashes.size, 1, 'All eight replies retain the same actual native thread');
  assert(acceptance.replies.at(-1).content.includes(manifest.token));
  const resume = acceptance.threadResume;
  assert.equal(resume.fromEffort, 'low'); assert(['medium', 'high', 'xhigh'].includes(resume.toEffort));
  assert.equal(resume.beforeSessionHash, inputs[0].sessionHash); assert.equal(resume.afterSessionHash, inputs[7].sessionHash);
  const lastWire = receipts.filter(value => value.wrapperPid === inputs[7].wrapperPid && value.at <= inputs[7].at);
  const resumed = one(lastWire.filter(value => value.event === 'thread-config' && value.method === 'thread/resume'), 'Explicit setting change resumes the actual thread');
  assert.deepEqual(resume.native, resumed); assert.equal(resumed.sessionHash, inputs[0].sessionHash); assert.equal(resumed.policy.effort, resume.toEffort);
  assert.notEqual(inputs[7].wrapperPid, inputs[6].wrapperPid, 'Effort change really replaces the native process');
  assert(lastWire.some(value => value.event === 'session' && value.method === 'thread/resume' && value.sessionHash === inputs[0].sessionHash));
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
    const denied = scope.patch === 'deny' && decision.name === 'edit';
    assert.equal(decision.expectedDenial, denied); assert.equal(decision.approved, !denied);
    if (reply.marker === 'PATCH_APPLY' && decision.name === 'edit') {
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
  const patched = one(acceptance.replies.filter(value => value.marker === 'PATCH_APPLY'), 'Approved patch reply');
  assert(proofs.some(value => value.inputIndex === patched.request.inputIndex && value.decision === 'accept'
    && patched.nativeTools.some(tool => tool.type === 'fileChange' && tool.itemIdHash === value.itemIdHash)));
  const denied = one(acceptance.replies.filter(value => value.marker === 'DENY_CANARY'), 'Denied canary reply');
  const declined = proofs.filter(value => value.inputIndex === denied.request.inputIndex && value.decision === 'decline');
  assert.equal(declined.length, 1); assert.equal(acceptance.deniedCanary.replyId, denied.messageId);
  assert.deepEqual(acceptance.deniedCanary.decisions, decisions.filter(value => value.id === declined[0].publicId));
  return proofs;
}

function auditOracle(common, acceptance, workspace) {
  assert.equal(acceptance.oracle.stage, 'backoff'); contained(common.owner.directory, acceptance.oracle.path);
  const report = read(acceptance.oracle.path);
  assert.equal(report.status, 'PASS'); assert.equal(report.stage, 'backoff'); assert.equal(report.failed, 0); assert.equal(report.passed, 3);
  assert.equal(report.checks.length, 3); assert.equal(new Set(report.checks.map(value => value.name)).size, 3); assert(report.checks.every(value => value.status === 'PASS'));
  assert.equal(report.sourceSha256, workspace.hashes['src/retry.cjs']); assert.equal(report.realProviderInputs, 0); assert.equal(report.fixtureSourceUnchanged, true);
  assert.deepEqual(report.network, ['owned loopback HTTP only']);
  return { stage: report.stage, passed: report.passed, sourceSha256: report.sourceSha256, artifactSha256: hash(acceptance.oracle.path) };
}

function audit(directory) {
  const common = auditCommon(directory), acceptance = read(path.join(common.owner.directory, 'acceptance.json'));
  const workspace = auditWorkspace(common, acceptance), stored = readStoredConversations(common.owner);
  const journey = auditJourney(common, acceptance, stored), permissions = auditPermissions(common, acceptance, journey);
  const oracle = auditOracle(common, acceptance, workspace);
  return { status: 'PASS_FIRST_EIGHT_ONLY', checkedAt: new Date().toISOString(), auditorSha256: hash(__filename),
    sourceIdentity: common.manifest.sourceIdentity, packageIdentity: common.manifest.packageIdentity,
    bundleSha256: common.manifest.bundleSha256, chatSha256: common.manifest.chatSha256, pinnedIdentities: common.pinned,
    compiledJourneySha256: common.reservation.harnessSha256, observerSha256: common.reservation.observerSha256,
    receipts: common.owner.receiptPaths.map(file => ({ file, sha256: hash(file) })),
    evidenceSha256: Object.fromEntries(['acceptance.json', 'observations.json', 'events-main.json'].map(file => [file, hash(path.join(common.owner.directory, file))])),
    counts: acceptance.counts, replies: journey.proofs, permissions, oracle, workspace,
    disk: { database: stored.database, conversationId: journey.conversation.id, messageIds: journey.conversation.messages.map(value => value.id),
      projectionSha256: digest(JSON.stringify(journey.conversation.messages.map(messageProjection))) },
    observedProcessIdentitiesExited: common.ancestry.processIdentities.length, processSamplingMs: 250,
    semanticReview: 'ROOT_INDEPENDENT_REVIEW_REQUIRED', remainingFull25AndExtendedCoverage: 'NOT_RUN',
    elapsedCampaigns: { S: 'NOT_RUN', W: 'NOT_RUN', E: 'NOT_RUN', P: 'NOT_RUN' },
    scope: 'First eight completed replies in one installed-editor Codex F1 chat, actual approved patch, denied canary and native thread resume. This is not the full PB-02 baseline or a soak.',
    limits: ['Root must independently review all eight replies and the patch for semantic correctness.',
      'PID and birth cleanup verifies observed processes at 250ms sampling; processes entirely between samples can be missed.',
      'Remaining 25-turn baseline, revision, second panel, failure recovery, Read Only, Stop, attachments, named profiles, other operating systems and long profiles were not run in this stage.'] };
}
module.exports = { audit, auditCommon, auditWorkspace, auditJourney, auditPermissions, auditOracle, permittedTool, turnWire };
if (require.main === module) {
  const directory = path.resolve(process.env.MYSTI_PB02_ARTIFACT_DIR || ''); contained(root, directory);
  const primary = path.join(directory, 'independent-audit.json');
  const output = fs.existsSync(primary) ? path.join(directory, `independent-audit-${Date.now()}.json`) : primary;
  try {
    const result = audit(directory); fs.writeFileSync(output, JSON.stringify(result, null, 2), { flag: 'wx' }); console.log(JSON.stringify(result));
  } catch (error) {
    const result = { status: 'FAIL', checkedAt: new Date().toISOString(), auditorSha256: hash(__filename),
      error: { name: error.name, message: error.message }, scope: 'PB-02 stage-one read-only owned-artifact audit; no editor or model launch' };
    fs.writeFileSync(output, JSON.stringify(result, null, 2), { flag: 'wx' }); console.error(JSON.stringify(result)); process.exitCode = 1;
  }
}
