/* PB-01 independent read-only acceptance. No editor, CLI or model is launched. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const repo = path.resolve(__dirname, '../..');
const auditRoot = path.join(repo, 'out-test/feature-tests/PB-01');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');
const hash = file => digest(fs.readFileSync(file));
function contained(root, file) {
  const relative = path.relative(root, file);
  assert(relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative), 'Expected a scoped owned path');
}
function identity(value) {
  assert(value && typeof value.path === 'string' && /^[a-f0-9]{64}$/.test(value.sha256));
  assert.equal(hash(value.path), value.sha256, `Pinned identity changed: ${value.path}`);
}
function loadReceipts(owner) {
  assert(Array.isArray(owner.receiptPaths) && owner.receiptPaths.length > 0);
  return owner.receiptPaths.flatMap(file => {
    contained(owner.directory, file);
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  }).sort((left, right) => left.at - right.at);
}

function auditCommon(directory) {
  contained(auditRoot, directory);
  const manifest = read(path.join(directory, 'prepared.json'));
  assert.equal(manifest.case, 'PB-01'); assert.equal(manifest.artifactDir, directory);
  assert.equal(manifest.preparedBeforeActivation, true);
  assert.deepEqual(Object.keys(manifest.windows), ['A']);
  const owner = manifest.windows.A;
  contained(directory, owner.directory); contained(owner.directory, owner.workspace);
  contained(fs.realpathSync(path.join(repo, '.vscode-test/profiles')), fs.realpathSync(owner.profile));
  const marker = read(path.join(owner.profile, '.mysti-test-owned.json'));
  assert.equal(marker.case, 'PB-01'); assert.equal(marker.window, 'A'); assert.equal(marker.profile, fs.realpathSync(owner.profile));
  assert.equal(manifest.fixture.workspace, owner.workspace);
  assert.equal(manifest.maxForwardedInputs, 30); assert.equal(manifest.plannedSuccessfulTurns, 25);
  for (const extension of [manifest.sourcePackage, owner.installedExtension]) {
    const metadata = read(path.join(extension, 'package.json'));
    assert.equal(metadata.name, 'mysti'); assert.equal(metadata.publisher.toLowerCase(), 'deepmyst');
    assert.equal(hash(path.join(extension, 'dist/extension.js')), manifest.bundleSha256);
    assert.equal(hash(path.join(extension, 'media/chat/chat.js')), manifest.chatSha256);
  }
  const pinned = [...Object.values(manifest.executableIdentities), ...manifest.wrapperIdentities,
    ...manifest.harnessDependencyIdentities, manifest.nodeIdentity, manifest.readiness];
  for (const value of pinned) identity(value);
  if (manifest.runtimeIdentity) for (const file of manifest.runtimeIdentity.files) {
    const absolute = path.resolve(manifest.runtimeIdentity.root, file.relative);
    contained(manifest.runtimeIdentity.root, absolute); assert.equal(hash(absolute), file.sha256);
  }
  const reservation = read(path.join(directory, 'launch-reservation.json'));
  assert.equal(reservation.plannedConversationRequests, 30);
  assert.equal(hash(path.join(repo, 'out-vscode-test/claude.test.js')), reservation.harnessSha256);
  assert.equal(hash(path.join(repo, 'out-vscode-test/claude-observer.js')), reservation.observerSha256);
  assert.equal(hash(path.join(manifest.helper, 'extension.cjs')), reservation.helperSha256);
  const launch = read(path.join(owner.directory, 'launch.json'));
  assert.equal(launch.profile, owner.profile); assert.equal(launch.installedExtension, owner.installedExtension);
  assert.equal(launch.extensionTestsPathUsed, false);
  assert(launch.args.every(argument => !/extensionTestsPath/i.test(argument)));
  assert(launch.args.includes(`--user-data-dir=${owner.profile}`));
  assert(launch.args.includes(`--extensions-dir=${owner.extensionsDir}`));
  assert(launch.args.includes(owner.workspace));
  const ready = read(path.join(owner.directory, 'helper-ready.json'));
  assert.equal(ready.extensionTestsPathUsed, false);
  assert([undefined, false, 'NOT_EXPOSED_BY_PUBLIC_API'].includes(ready.productUnderDevelopment));
  assert.equal(ready.profile, owner.profile);
  const registry = read(path.join(owner.directory, 'registry-readiness.json'));
  assert.equal(registry.pathMatches, true);
  assert.equal(registry.actualPath, fs.realpathSync(owner.installedExtension));
  const outcome = read(path.join(directory, 'native-result.json'));
  assert.equal(outcome.status, 'PASS');
  const exit = read(path.join(owner.directory, 'editor-exit.json'));
  assert.equal(exit.code, 0); assert.equal(exit.signal, null); assert.equal(exit.timedOut, false);
  assert.equal(exit.helper.failures, 0); assert.equal(exit.helper.normalQuitRequested, true);
  assert.deepEqual(exit.helper.testFailures, []);
  for (const file of ['watchdog-failure.json', 'driver-fatal.json']) assert(!fs.existsSync(path.join(directory, file)));
  for (const file of ['forced-cleanup.json', 'driver-error.json']) assert(!fs.existsSync(path.join(owner.directory, file)));

  const receipts = loadReceipts(owner);
  const forbidden = new Set(['input-cap-refusal', 'oversized-input-refusal', 'instrumentation-error', 'wrapper-rejected-settings', 'launch-error']);
  assert(!receipts.some(value => forbidden.has(value.event)), 'Wrapper refusal or instrumentation failure must remain a failed native journey');
  for (const value of receipts) {
    assert.equal(value.provider, 'claude-code'); assert.equal(value.window, 'A');
    assert(Number.isSafeInteger(value.wrapperPid) && value.wrapperPid > 0 && Number.isFinite(value.at));
  }
  const inputs = receipts.filter(value => value.event === 'request' || value.event === 'native-command');
  assert(inputs.length > 0 && inputs.length <= 30);
  assert.deepEqual(inputs.map(value => value.inputIndex).sort((a, b) => a - b), Array.from({ length: inputs.length }, (_, index) => index + 1));
  const counter = read(manifest.counterFile);
  assert.equal(counter.forwardedInputs, inputs.length); assert.equal(counter.maxInputs, 30);
  assert(!fs.existsSync(manifest.counterFile + '.lock'));
  const cleanup = read(path.join(owner.directory, 'editor-exit-process-check.json'));
  assert.equal(cleanup.status, 'PASS_OBSERVED_IDENTITIES_EXITED');
  assert.deepEqual(cleanup.remaining, []); assert.deepEqual(cleanup.unverifiedLiveReceiptPids, []);
  assert.equal(cleanup.conversationalInputs, inputs.filter(value => value.event === 'request').length);
  assert.equal(cleanup.auxiliaryInputs, receipts.filter(value => value.event === 'auxiliary-input').length);
  const ancestry = read(path.join(owner.directory, 'process-ancestry.json'));
  assert(ancestry.processIdentities.length > 0); assert.equal(ancestry.sampleIntervalMs, 250);
  assert.equal(cleanup.observedIdentityCount, ancestry.processIdentities.length);
  const live = new Map(execFileSync('ps', ['-axo', 'pid=,lstart='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/); assert(match); return [+match[1], match[2]];
  }));
  for (const captured of ancestry.processIdentities) assert.notEqual(live.get(captured.pid), captured.startedAt, `Observed owned process remains: ${captured.pid}`);
  for (const receipt of receipts) for (const pid of [receipt.wrapperPid, receipt.childPid].filter(Boolean)) {
    if (!live.has(pid)) continue;
    const prior = ancestry.processIdentities.filter(value => value.pid === pid);
    assert((prior.length && prior.every(value => value.startedAt !== live.get(pid)))
      || (Number.isFinite(Date.parse(live.get(pid))) && Date.parse(live.get(pid)) > receipt.at), `Unverified surviving receipt PID: ${pid}`);
  }
  return { manifest, owner, receipts, inputs, ancestry, pinned, reservation };
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
    } else if (relative === '.mysti/plans/pb01-native.md') {
      assert(bytes.length > 0); assert(!bytes.includes(0)); kind = 'declared-native-plan';
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

function readStoredConversations(owner) {
  const database = path.join(owner.profile, 'User/globalStorage/state.vscdb');
  assert(fs.existsSync(database), 'Ordinary editor must have real disk-backed storage');
  const program = `import sqlite3,json,sys\ndb=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)\nrows=list(db.execute("SELECT value FROM ItemTable WHERE lower(key)='deepmyst.mysti'"))\nassert len(rows)==1\nblob=json.loads(rows[0][0]).get('mysti.conversations',{})\nassert blob.get('schemaVersion')==1\nentries=blob.get('conversations',[])\nfor entry in entries: assert isinstance(entry,list) and len(entry)==2 and entry[0]==entry[1].get('id')\nprint(json.dumps([entry[1] for entry in entries]))`;
  const conversations = JSON.parse(execFileSync('python3', ['-c', program, database], { encoding: 'utf8', timeout: 10000, maxBuffer: 32 * 1024 * 1024 }));
  assert.equal(new Set(conversations.map(value => value.id)).size, conversations.length);
  return { database, conversations };
}

const expectedReplies = ['DIAGNOSE', 'REGRESSION', 'PATCH_DESIGN', 'PATCH_APPLY', 'BASE_TESTS', 'DENY_CANARY',
  'NATIVE_QUESTION', 'QUESTION_ANSWER', 'JITTER_REVIEW', 'JITTER_TESTS', 'RETRY_REVIEW', 'REVISION_DESIGN',
  'REVISION_APPLY', 'REVISION_TESTS', 'UNRELATED', 'RETURN_TASK', 'OTHER_PANEL', 'ORIGINAL_PANEL',
  'READONLY_CANARY', 'STOP_RECOVERY', 'ATTACHMENTS', 'NATIVE_PLAN', 'PLAN_FOLLOWUP', 'COMPACT_RECALL', 'FINAL_VERIFY'];
const requiredTools = { DIAGNOSE: ['read'], REGRESSION: ['read'], PATCH_APPLY: ['edit'], BASE_TESTS: ['bash'],
  JITTER_TESTS: ['edit', 'bash'], RETRY_REVIEW: ['read'], REVISION_APPLY: ['edit'], REVISION_TESTS: ['bash'],
  ATTACHMENTS: ['read'], PLAN_FOLLOWUP: ['bash'], FINAL_VERIFY: ['bash'] };
const toolProjection = tool => Object.fromEntries(['id', 'name', 'status', 'input', 'output', 'proposalOnly', 'historicalOnly', 'truncated']
  .filter(key => tool[key] !== undefined).map(key => [key, tool[key]]));
const messageProjection = message => ({ id: message.id, role: message.role, content: message.content, provider: message.provider,
  model: message.model, toolCalls: (message.toolCalls || []).map(toolProjection), usage: message.usage,
  attachments: (message.attachments || []).map(value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'base64Data'))) });
function exactlyOne(values, label) { assert.equal(values.length, 1, label); return values[0]; }
function nativeToolSucceeded(tool, wire) {
  return tool.status === 'completed' && typeof tool.output === 'string'
    && wire.some(value => value.event === 'tool-start' && value.toolIdHash === digest(tool.id) && String(value.name).toLowerCase() === String(tool.name).toLowerCase())
    && wire.some(value => value.event === 'tool-result' && value.toolIdHash === digest(tool.id) && value.success === true && value.outputSha256 === digest(tool.output));
}
function turnWire(receipts, inputs, input) {
  const next = inputs.find(value => value.inputIndex > input.inputIndex && value.wrapperPid === input.wrapperPid);
  return receipts.filter(value => value.wrapperPid === input.wrapperPid && value.at >= input.at && (!next || value.at < next.at));
}

function auditJourney(common, acceptance, stored) {
  const { manifest, owner, receipts, inputs } = common;
  const observations = read(path.join(owner.directory, 'observations.json'));
  const panelEvents = Object.fromEntries(['main', 'other'].map(label => [label, read(path.join(owner.directory, `events-${label}.json`))]));
  const requests = inputs.filter(value => value.event === 'request'), commands = inputs.filter(value => value.event === 'native-command');
  const rejected = acceptance.faults.invalidModel;
  assert([0, 1].includes(rejected.forwardedRejectedInputs));
  assert.equal(acceptance.counts.completedTurns, 25); assert.equal(acceptance.counts.stoppedInputs, 2);
  assert.equal(acceptance.counts.rejectedAttempts, 1); assert.equal(rejected.rejectedAttempts, 1);
  assert.equal(acceptance.counts.forwardedRejectedInputs, rejected.forwardedRejectedInputs);
  assert.equal(requests.length, 27 + rejected.forwardedRejectedInputs); assert.equal(commands.length, 1);
  assert.equal(inputs.length, 28 + rejected.forwardedRejectedInputs);
  assert.equal(acceptance.counts.conversationInputs, requests.length); assert.equal(acceptance.counts.nativeCommands, commands.length);
  assert.equal(acceptance.counts.forwardedTotal, inputs.length);
  assert.equal(acceptance.counts.auxiliaryInputs, receipts.filter(value => value.event === 'auxiliary-input').length);
  assert.equal(commands[0].command, '/compact');
  assert(requests.every(value => Array.isArray(value.outsideMemoryMarkers) && !value.outsideMemoryMarkers.some(marker => ['QUEUED_ONE', 'QUEUED_TWO'].includes(marker))), 'Removed queued prompts never dispatch, including in later transcript context');
  assert.notEqual(acceptance.sourceId, acceptance.otherConversationId); assert.notEqual(acceptance.sourcePanelId, acceptance.otherPanelId);
  assert.deepEqual(acceptance.liveTabs.map(value => value.label).sort(), ['main', 'other']);
  for (const tab of acceptance.liveTabs) {
    assert.equal(tab.stillOpen, true); assert(Number.isInteger(tab.group) && tab.group > 0);
    assert(tab.viewType.includes('mysti.detachedChat')); assert.equal(typeof tab.tabLabel, 'string');
    assert.equal(tab.panelId, tab.label === 'main' ? acceptance.sourcePanelId : acceptance.otherPanelId);
    assert.equal(tab.conversationId, tab.label === 'main' ? acceptance.sourceId : acceptance.otherConversationId);
    assert(observations.some(value => value.event === 'panel-created' && value.label === tab.label && value.panelId === tab.panelId && value.conversationId === tab.conversationId));
    assert(panelEvents[tab.label].some(value => value.type === 'initialState' && value.payload.panelId === tab.panelId));
  }
  assert(observations.some(value => value.event === 'live-tabs' && value.tabs.length === 2 && value.tabs.every(tab => tab.stillOpen)), 'Both actual editor tabs coexisted');

  const ownedConversations = [acceptance.sourceId, acceptance.otherConversationId].map(id => exactlyOne(stored.conversations.filter(value => value.id === id), 'Owned conversation must be on disk'));
  assert.equal(acceptance.conversations.length, 2);
  for (const conversation of ownedConversations) {
    const publicConversation = exactlyOne(acceptance.conversations.filter(value => value.id === conversation.id), 'Final public history ownership');
    assert.deepEqual(conversation.messages.map(messageProjection), publicConversation.messages.map(messageProjection), 'Final public transcript must match disk IDs, exact content, attribution, tools, usage and attachment metadata');
    assert.equal(new Set(conversation.messages.map(value => value.id)).size, conversation.messages.length);
    assert(conversation.messages.every(value => !(value.attachments || []).some(attachment => attachment.base64Data !== undefined)), 'Embedded file bytes must not enter durable history');
  }
  assert.deepEqual(acceptance.replies.map(value => value.marker), expectedReplies);
  const accountedInputs = new Set();
  const replyProofs = acceptance.replies.map((reply, index) => {
    assert.equal(reply.ordinal, index + 1); assert.equal(reply.provider, 'claude-code'); assert.equal(reply.model, 'sonnet');
    const other = reply.marker === 'OTHER_PANEL'; assert.equal(reply.label, other ? 'other' : 'main');
    assert.equal(reply.panelId, other ? acceptance.otherPanelId : acceptance.sourcePanelId);
    assert.equal(reply.conversationId, other ? acceptance.otherConversationId : acceptance.sourceId);
    const input = exactlyOne(requests.filter(value => value.inputIndex === reply.requestInputIndex), 'Exactly one native frame per completed reply');
    assert.deepEqual(reply.request, input); assert(input.outsideMemoryMarkers.includes(reply.marker));
    if (index > 0) {
      assert(reply.requestInputIndex > acceptance.replies[index - 1].requestInputIndex, 'Completed reply receipts retain actual conversational order');
      assert(reply.started >= acceptance.replies[index - 1].completedAt);
    }
    assert.equal(input.model, 'sonnet'); assert.equal(input.policy.effort, 'low'); assert.equal(input.policy.outputFormat, 'stream-json');
    assert(input.at >= reply.started && input.at <= reply.completedAt); assert(!accountedInputs.has(input.inputIndex)); accountedInputs.add(input.inputIndex);
    const terminal = exactlyOne(panelEvents[reply.label].filter(value => value.type === 'responseComplete' && value.payload?.message?.id === reply.messageId), 'Exactly one public completion for each real reply');
    assert.equal(terminal.at, reply.completedAt); assert.equal(terminal.payload.message.content, reply.content);
    assert.deepEqual(JSON.parse(JSON.stringify((terminal.payload.message.toolCalls || []).map(tool => ({ id: tool.id, name: tool.name, status: tool.status, input: tool.input, output: tool.output })))), reply.tools);
    const conversation = ownedConversations.find(value => value.id === reply.conversationId);
    const saved = exactlyOne(conversation.messages.filter(value => value.id === reply.messageId), 'Completed reply persisted once in its owning conversation');
    assert.equal(saved.role, 'assistant'); assert.equal(saved.content, reply.content); assert.equal(saved.provider, reply.provider); assert.equal(saved.model, reply.model);
    assert.deepEqual(messageProjection(saved), messageProjection(terminal.payload.message));
    assert(!panelEvents[reply.label].some(value => value.at >= reply.started && value.at <= reply.completedAt && ['error', 'authError', 'requestCancelled'].includes(value.type)));
    assert(panelEvents[reply.label].some(value => value.type === 'responseStarted' && value.at >= reply.started && value.at <= reply.completedAt));
    if (!['NATIVE_QUESTION', 'NATIVE_PLAN'].includes(reply.marker)) assert(reply.content.includes(`PB01_DONE:${reply.marker}`));
    const wire = turnWire(receipts, inputs, input).filter(value => value.at <= reply.completedAt);
    const results = wire.filter(value => value.event === 'native-result');
    assert(results.length > 0 && results.every(value => value.isError === false), 'A visible completed reply requires successful native completion');
    assert.deepEqual(reply.nativeResults, results);
    for (const name of requiredTools[reply.marker] || []) {
      const candidates = reply.tools.filter(value => String(value.name).toLowerCase() === name && nativeToolSucceeded(value, wire));
      assert(candidates.length > 0, `Actual successful ${name} with exact native output must substantiate the public tool card`);
      if (name === 'bash') {
        assert(candidates.some(value => value.input.command === 'node --test test/retry.test.cjs' && /# fail 0\b/.test(String(value.output))));
        assert(wire.some(value => value.event === 'tool-start' && value.exactVisibleTestCommand === true));
      }
    }
    assert(reply.tools.every(value => !['proposed', 'unconfirmed', 'running'].includes(value.status)), 'Completed native turns must not silently count unresolved tools as success');
    return { marker: reply.marker, inputIndex: input.inputIndex, messageId: reply.messageId, contentSha256: digest(reply.content), toolIds: reply.tools.map(value => digest(value.id)) };
  });
  const byMarker = marker => exactlyOne(acceptance.replies.filter(value => value.marker === marker), marker);
  assert.deepEqual(byMarker('OTHER_PANEL').request.outsideMemoryMarkers, ['OTHER_PANEL']);
  assert(byMarker('OTHER_PANEL').content.includes(manifest.otherPanelToken)); assert(!byMarker('OTHER_PANEL').content.includes(manifest.token));
  for (const reply of acceptance.replies.filter(value => value.label === 'main')) {
    assert(!reply.request.outsideMemoryMarkers.includes('OTHER_PANEL')); assert(!reply.content.includes(manifest.otherPanelToken));
  }
  for (const marker of ['RETURN_TASK', 'ORIGINAL_PANEL', 'COMPACT_RECALL']) assert(byMarker(marker).content.includes(manifest.token));
  assert(byMarker('ATTACHMENTS').content.includes(manifest.attachmentToken) && /blue/i.test(byMarker('ATTACHMENTS').content));
  assert(byMarker('COMPACT_RECALL').content.includes(manifest.attachmentToken) && /1[,.]?500/.test(byMarker('COMPACT_RECALL').content));

  const invalidObservation = exactlyOne(observations.filter(value => value.event === 'invalid-model-rejected'), 'One invalid model attempt');
  const invalidInput = requests.filter(value => value.at >= rejected.selectedAt && value.at <= invalidObservation.at);
  assert.equal(invalidInput.length, rejected.forwardedRejectedInputs);
  if (invalidInput.length) { assert.deepEqual(rejected.request, invalidInput[0]); assert.equal(invalidInput[0].model, manifest.invalidModel); assert(invalidInput[0].outsideMemoryMarkers.includes('INVALID_MODEL')); accountedInputs.add(invalidInput[0].inputIndex); }
  else assert.equal(rejected.request, undefined);
  const invalidStarts = receipts.filter(value => value.event === 'start' && value.at >= rejected.selectedAt && value.at <= invalidObservation.at && value.policy.model === manifest.invalidModel);
  assert(invalidStarts.length > 0); assert.deepEqual(rejected.launches, invalidStarts);
  assert(rejected.errors.some(value => /model/i.test(JSON.stringify(value.payload)) && /invalid|not found|not available|not exist|unknown|not support/i.test(JSON.stringify(value.payload))));
  for (const error of rejected.errors) assert(panelEvents.main.some(value => JSON.stringify(value) === JSON.stringify(error)));
  assert(!panelEvents.main.some(value => value.at >= rejected.selectedAt && value.at <= invalidObservation.at && value.type === 'responseComplete'));
  assert(!receipts.some(value => value.at >= rejected.selectedAt && value.at <= invalidObservation.at && value.event === 'tool-start'));
  assert(byMarker('RETURN_TASK').started > invalidObservation.at);

  assert.deepEqual(acceptance.faults.stops.map(value => value.kind), ['pending-approval', 'text-stream']);
  const stopProofs = acceptance.faults.stops.map(stop => {
    const expectedIndex = byMarker('READONLY_CANARY').requestInputIndex + (stop.kind === 'pending-approval' ? 1 : 2);
    const input = exactlyOne(requests.filter(value => value.inputIndex === expectedIndex && value.outsideMemoryMarkers.includes(stop.marker)
      && value.inputIndex < byMarker('STOP_RECOVERY').requestInputIndex && !accountedInputs.has(value.inputIndex)), `One actual ${stop.kind} request`);
    accountedInputs.add(input.inputIndex);
    const nextInput = inputs.find(value => value.inputIndex === input.inputIndex + 1);
    const interval = panelEvents.main.filter(value => value.at >= input.at && (!nextInput || value.at < nextInput.at));
    const cancelled = exactlyOne(interval.filter(value => value.type === 'requestCancelled'), 'One cancellation acknowledgement per stopped request');
    assert(!interval.some(value => value.type === 'responseComplete'), 'Stopped requests cannot acquire a late successful terminal');
    const partial = cancelled.payload?.message;
    if (partial) {
      const saved = exactlyOne(ownedConversations[0].messages.filter(value => value.id === partial.id), 'Every useful Stop snapshot, including pending approval, persists exactly once');
      assert.deepEqual(messageProjection(saved), messageProjection(partial));
      assert(!panelEvents.main.some(value => value.type === 'responseComplete' && value.payload?.message?.id === partial.id));
    }
    if (stop.kind === 'pending-approval') {
      assert.equal(stop.queuedRemoved, 2);
      const permission = exactlyOne(interval.filter(value => value.type === 'permissionRequest' && value.payload.id === stop.permissionId), 'Stop owned a pending real approval');
      assert.equal(String(permission.payload.details.toolName).toLowerCase(), 'edit');
      assert.equal(path.resolve(owner.workspace, permission.payload.details.toolInput.file_path), path.join(owner.workspace, manifest.fixture.deniedCanary));
      assert(!observations.some(value => value.event === 'permission-decision' && value.id === stop.permissionId));
    } else {
      assert(partial && partial.content.length > 0); assert.deepEqual(partial, stop.partialMessage);
      assert(interval.some(value => value.type === 'responseChunk' && typeof value.payload.content === 'string' && value.payload.content.length > 0));
    }
    return { kind: stop.kind, inputIndex: input.inputIndex, cancelledAt: cancelled.at, partialMessageId: cancelled.payload?.message?.id };
  });
  assert.equal(accountedInputs.size, requests.length, 'Every forwarded request is explicitly accounted for');
  const acknowledgedAssistantIds = [...acceptance.replies.map(value => value.messageId), ...stopProofs.map(value => value.partialMessageId).filter(Boolean)];
  const assistantIds = new Set(acknowledgedAssistantIds);
  assert.equal(assistantIds.size, acknowledgedAssistantIds.length, 'Every completed reply and retained Stop snapshot needs a distinct message ID');
  for (const conversation of ownedConversations) {
    const expected = [...acceptance.replies.filter(value => value.conversationId === conversation.id).map(value => value.messageId),
      ...(conversation.id === acceptance.sourceId ? stopProofs.map(value => value.partialMessageId).filter(Boolean) : [])];
    assert.deepEqual(conversation.messages.filter(value => value.role === 'assistant').map(value => value.id).sort(), expected.sort(), 'Exact owned assistant count; no lost Stop snapshot, unaccounted reply or late completion');
  }
  assert.equal(Object.values(panelEvents).flat().filter(value => value.type === 'responseComplete' && value.payload?.message).length, 25);

  return { observations, panelEvents, requests, commands, replyProofs, stopProofs, ownedConversations, byMarker };
}

function auditPermissions(common, acceptance, journey) {
  const { receipts, manifest, owner, inputs } = common;
  const controls = receipts.filter(value => value.event === 'native-control-request');
  const responses = receipts.filter(value => value.event === 'native-control-response');
  const pairs = controls.map((request, index) => {
    assert(/^[a-f0-9]{64}$/.test(request.nativeRequestIdHash));
    const startIndex = receipts.indexOf(request);
    const next = controls.slice(index + 1).find(value => value.wrapperPid === request.wrapperPid && value.nativeRequestIdHash === request.nativeRequestIdHash);
    const matched = responses.filter(value => value.wrapperPid === request.wrapperPid && value.nativeRequestIdHash === request.nativeRequestIdHash
      && receipts.indexOf(value) > startIndex && (!next || receipts.indexOf(value) < receipts.indexOf(next)));
    assert(matched.length <= 1, 'A native control request cannot receive duplicate responses');
    const stopped = journey.stopProofs.find(stop => {
      const input = inputs.find(value => value.inputIndex === stop.inputIndex);
      return request.wrapperPid === input.wrapperPid && request.at >= input.at && request.at <= stop.cancelledAt;
    });
    if (!matched.length) assert(stopped && request.subtype === 'can_use_tool', 'Only a native approval abandoned by an actual Stop may have no flushed response');
    if (request.subtype === 'hook_callback') { assert(matched.length === 1 && ['ask', 'deny'].includes(matched[0].hookDecision)); }
    if (request.subtype === 'can_use_tool' && matched.length) assert(['allow', 'deny'].includes(matched[0].behavior));
    if (['AskUserQuestion', 'ExitPlanMode'].includes(request.toolName) && request.subtype === 'can_use_tool') assert.equal(matched[0]?.behavior, 'deny', 'Question and plan tools may not implicitly execute or change native authority');
    return { request, response: matched[0], stopped, publicRequest: undefined, decision: undefined };
  });
  assert.equal(pairs.filter(value => value.response).length, responses.length, 'Every outgoing control response must match an observed request occurrence');
  const publicRequests = Object.entries(journey.panelEvents).flatMap(([label, events]) => events.filter(value => value.type === 'permissionRequest').map(value => ({ label, ...value })));
  assert.equal(new Set(publicRequests.map(value => value.payload.id)).size, publicRequests.length, 'A public approval delivery is unique');
  const decisions = journey.observations.filter(value => value.event === 'permission-decision');
  assert.equal(new Set(decisions.map(value => value.id)).size, decisions.length, 'Each permission card is answered at most once');
  const stoppedId = acceptance.faults.stops.find(value => value.kind === 'pending-approval').permissionId;
  for (const publicRequest of publicRequests) {
    const payload = publicRequest.payload, tool = String(payload.details.toolName).toLowerCase(), input = payload.details.toolInput;
    const inputSha256 = digest(JSON.stringify(input));
    const native = pairs.filter(pair => !pair.publicRequest && pair.request.subtype === 'can_use_tool'
      && String(pair.request.toolName).toLowerCase() === tool && pair.request.inputSha256 === inputSha256 && pair.request.at <= publicRequest.at)
      .sort((a, b) => b.request.at - a.request.at)[0];
    assert(native, 'Every public approval card must trace to an actual native blocking request'); native.publicRequest = publicRequest;
    const decision = decisions.find(value => value.id === payload.id);
    if (payload.id === stoppedId) {
      assert.equal(decision, undefined); assert(native.stopped); assert(native.response?.behavior !== 'allow', 'Stop can never approve the pending canary');
      continue;
    }
    assert(decision); native.decision = decision; assert.equal(decision.label, publicRequest.label);
    assert.equal(decision.inputSha256, inputSha256); assert.equal(decision.tool, tool);
    assert.equal(native.response?.behavior, decision.approved ? 'allow' : 'deny', 'Actual wire permission decision must match the public click');
    if (decision.approved && tool === 'edit') assert(manifest.fixture.editableFiles.includes(decision.relative));
    if (decision.approved && tool === 'write') assert.equal(decision.relative, '.mysti/plans/pb01-native.md');
    if (decision.approved && tool === 'bash') assert.equal(input.command, 'node --test test/retry.test.cjs');
    if (decision.approved) assert(['read', 'edit', 'write', 'bash'].includes(tool), 'No undeclared broad tool authority');
    for (const [relative, original] of Object.entries(manifest.fixture.files)) if (!manifest.fixture.editableFiles.includes(relative)) assert.equal(decision.before.hashes[relative], original.sha256, 'Protected bytes stayed unchanged before each decision');
  }
  assert.equal(decisions.length, publicRequests.length - 1, 'Only the intentionally stopped approval remains unanswered by a user');
  for (const pair of pairs) if (pair.request.subtype === 'can_use_tool' && pair.response?.behavior === 'allow'
    && ['Edit', 'Write', 'Bash'].includes(pair.request.toolName)) assert(pair.decision?.approved, 'Native mutation or shell permission requires the observed public approval');
  const denial = exactlyOne(decisions.filter(value => value.expectedDenial && !value.approved), 'Exactly one explicit public canary denial');
  assert.equal(denial.relative, manifest.fixture.deniedCanary);
  assert(acceptance.faults.deniedCanary.decisions.some(value => value.id === denial.id));
  const readonly = journey.byMarker('READONLY_CANARY'); assert.equal(readonly.request.policy.permissionMode, 'plan');
  const readOnlyWire = turnWire(receipts, inputs, readonly.request).filter(value => value.at <= readonly.completedAt);
  const readOnlyOutcome = auditReadOnly({ wire: readOnlyWire, readonly, proof: acceptance.faults.readonlyWrite,
    fixture: manifest.fixture, limits: acceptance.limits });
  const readOnlyCards = publicRequests.filter(value => value.at >= readonly.started && value.at <= readonly.completedAt);
  assert.equal(readOnlyCards.length, 0, 'Native read-only enforcement must not depend on a public approval card');
  assert.equal(acceptance.faults.readonlyWrite.permissionRequests, readOnlyCards.length);
  assert(!decisions.some(value => value.at >= readonly.started && value.at <= readonly.completedAt && value.tool === 'edit'), 'A manual denial must not disguise read-only policy failure');
  for (const start of receipts.filter(value => value.event === 'tool-start' && value.name === 'Edit' && value.relativePath === manifest.fixture.deniedCanary)) {
    assert(!receipts.some(value => value.event === 'tool-result' && value.wrapperPid === start.wrapperPid && value.toolIdHash === start.toolIdHash && value.success === true));
  }
  assert.equal(hash(path.join(owner.workspace, manifest.fixture.deniedCanary)), manifest.fixture.files[manifest.fixture.deniedCanary].sha256);
  return { nativeRequests: controls.length, nativeResponses: responses.length, publicPermissionCards: publicRequests.length,
    readOnlyOutcome,
    approved: decisions.filter(value => value.approved).length, explicitDenials: decisions.filter(value => !value.approved).length,
    pendingApprovalStoppedWithoutUserApproval: 1, unflushedRequestsAbandonedByStop: pairs.filter(value => !value.response).length,
    mappings: pairs.map(value => ({ wrapperPid: value.request.wrapperPid, nativeRequestIdHash: value.request.nativeRequestIdHash,
      subtype: value.request.subtype, tool: value.request.toolName, toolIdHash: value.request.toolIdHash,
      response: value.response?.behavior || value.response?.hookDecision, publicPermissionId: value.publicRequest?.payload.id,
      publicDecision: value.decision ? value.decision.approved ? 'allow' : 'deny' : undefined, stopped: !!value.stopped })) };
}

function auditReadOnly({ wire, readonly, proof, fixture, limits }) {
  assert.equal(proof.replyId, readonly.messageId);
  assert.deepEqual(proof.request, readonly.request);
  const tools = wire.filter(value => value.event === 'tool-start');
  const attempted = tools.filter(value => value.name === 'Edit');
  assert(tools.every(value => ['Read', 'Edit'].includes(value.name) && value.relativePath === fixture.deniedCanary), 'Read-only canary scenario permits only its declared native Read/Edit tools');
  if (proof.status === 'PASS_NATIVE_TOOL_DENIAL') {
    assert(attempted.length > 0, 'Native read-only enforcement requires an actual write attempt');
    assert(attempted.every(value => value.relativePath === fixture.deniedCanary));
    assert(attempted.every(value => wire.some(result => result.event === 'tool-result' && result.toolIdHash === value.toolIdHash && result.success === false)), 'Read-only write was actually refused by the backend');
  } else {
    assert.equal(proof.status, 'PARTIAL_MODEL_REFUSAL_NO_NATIVE_WRITE_ATTEMPT');
    assert.equal(attempted.length, 0); assert(limits.length > 0, 'No actual native denial means partial coverage');
    assert(tools.every(value => value.name === 'Read' && value.relativePath === fixture.deniedCanary), 'Model refusal cannot disguise another native write or unauthorized tool');
    assert(/cannot|can['’]t|won['’]t|will not|did not attempt|not (?:permitted|allowed)|unable|refus|forbid|prohibit/i.test(readonly.content), 'Explicit model refusal is required');
    assert(/read.?only|plan(?:ning)? mode|permission/i.test(readonly.content));
  }
  for (const relative of Object.keys(fixture.files)) {
    assert.equal(typeof proof.beforeFiles?.hashes?.[relative], 'string');
    assert.equal(proof.files?.hashes?.[relative], proof.beforeFiles.hashes[relative], 'Read-only turn preserves every fixture file, including earlier developer/agent edits');
  }
  assert.equal(proof.files.hashes[fixture.deniedCanary], fixture.files[fixture.deniedCanary].sha256);
  return proof.status;
}

function auditInteractions(common, acceptance, journey) {
  const { receipts, inputs, manifest } = common;
  const diagnoses = [];
  for (const [kind, marker, toolName, followup] of [['question', 'NATIVE_QUESTION', 'AskUserQuestion', 'QUESTION_ANSWER'], ['plan', 'NATIVE_PLAN', 'ExitPlanMode', 'PLAN_FOLLOWUP']]) {
    const value = acceptance.interactive[kind], reply = journey.byMarker(marker), next = journey.byMarker(followup);
    assert(value && ['PASS_NATIVE_FOLLOWUP', 'INCOMPLETE'].includes(value.status));
    assert(next.started > reply.started && next.requestInputIndex === reply.requestInputIndex + 1);
    if (value.status === 'INCOMPLETE') {
      assert(acceptance.limits.length > 0);
      const native = turnWire(receipts, inputs, reply.request).filter(item => item.event === 'tool-start' && item.name === toolName);
      const deliveries = journey.panelEvents.main.filter(item => item.at >= reply.started && item.at <= next.started
        && item.type === (kind === 'question' ? 'askUserQuestion' : 'planOptions'));
      const absentSourceNativeQuestion = kind === 'question' && native.length > 0 && deliveries.some(item => item.payload?.source === undefined
        && Array.isArray(item.payload?.questions) && item.payload.questions.length > 0
        && journey.panelEvents.main.some(tool => tool.type === 'toolUse' && tool.at >= reply.started && tool.at <= item.at
          && tool.payload?.name === 'AskUserQuestion' && native.some(call => call.toolIdHash === digest(tool.payload.id))));
      diagnoses.push({ interaction: kind, nativeToolReceipts: native.length, publicDeliveries: deliveries.length,
        diagnosis: absentSourceNativeQuestion ? 'HARNESS_SOURCE_TAG_FILTER_PREVENTED_NATIVE_FOLLOWUP_COVERAGE'
          : 'NATIVE_INTERACTION_INCOMPLETE_REVIEW_OBSERVED_EVIDENCE',
        detail: absentSourceNativeQuestion ? 'The actual native question and public card were observed without a source tag. The pinned harness required source=tool and used a manual follow-up; this does not establish backend omission.'
          : 'The run used a manual follow-up. No complete native interaction claim is made.' });
      continue;
    }
    assert.equal(value.publicOwner, acceptance.sourcePanelId); assert.equal(value.followupInputIndex, next.requestInputIndex);
    const native = turnWire(receipts, inputs, reply.request).filter(item => item.event === 'tool-start' && item.name === toolName);
    assert(native.length > 0); assert.deepEqual(value.nativeToolIdHashes, native.map(item => item.toolIdHash));
    const delivery = exactlyOne(journey.panelEvents.main.filter(item => item.at >= reply.started && item.at <= next.started
      && item.type === (kind === 'question' ? 'askUserQuestion' : 'planOptions')
      && (kind === 'question' ? item.payload?.toolCallId === value.deliveryId : item.payload?.syntheticPlanId === value.syntheticPlanId)), `Actual native ${kind} delivery`);
    if (kind === 'question') {
      assert([undefined, 'tool'].includes(delivery.payload.source), 'A detected prose question is not a native question');
      assert(Array.isArray(delivery.payload.questions) && delivery.payload.questions.length > 0);
      assert(delivery.payload.questions.every(question => question && typeof question.question === 'string' && question.question.trim()
        && Array.isArray(question.options) && question.options.every(option => option && typeof option.label === 'string' && option.label.trim())));
      const publicTool = journey.panelEvents.main.find(item => item.type === 'toolUse' && item.at >= reply.started && item.at <= delivery.at
        && item.payload?.name === 'AskUserQuestion' && native.some(call => call.toolIdHash === digest(item.payload.id)));
      assert(publicTool, 'Native tool ID must connect the actual question tool to its public card');
      assert.deepEqual(publicTool.payload.input.questions, delivery.payload.questions);
    } else assert.equal(delivery.payload.source, 'exit-plan-mode');
    if (kind === 'plan') { assert.equal(value.conversationId, acceptance.sourceId); assert.equal(value.selection, 'ask-before-edit'); }
    else assert.equal(value.selection, 'Floor');
  }
  const attachment = acceptance.interactive.attachments; assert.equal(attachment.status, 'PASS_REAL_FILE_ATTACHMENTS');
  assert.equal(attachment.replyId, journey.byMarker('ATTACHMENTS').messageId);
  assert.deepEqual(attachment.preparedHashes, ['attachments/brief.txt', 'attachments/status-blue.png'].map(file => manifest.fixture.files[file].sha256));
  const attached = journey.panelEvents.main.filter(value => value.type === 'fileAttachmentSelected').flatMap(value => value.payload.attachments || []);
  for (const file of ['brief.txt', 'status-blue.png']) assert(attached.some(value => value.fileName === file));
  const compact = acceptance.interactive.compact, command = journey.commands[0];
  assert.equal(compact.receiptInputIndex, command.inputIndex); assert(command.at >= compact.started && command.at <= compact.completedAt);
  assert.equal(compact.sessionHashBefore, compact.sessionHashAfter); assert(/^[a-f0-9]{64}$/.test(compact.sessionHashBefore));
  assert.equal(command.sessionHash, compact.sessionHashBefore);
  const actualStatuses = journey.panelEvents.main.filter(value => value.type === 'compactionStatus' && value.at >= compact.started && value.at <= compact.completedAt);
  assert.deepEqual(compact.events, actualStatuses); assert(!actualStatuses.some(value => value.payload.status === 'error'));
  exactlyOne(actualStatuses.filter(value => value.payload.status === 'complete'), 'One actual compaction completion');
  const compactResults = turnWire(receipts, inputs, command).filter(value => value.event === 'native-result' && value.at <= compact.completedAt);
  assert(compactResults.length > 0 && compactResults.every(value => value.isError === false), 'Native /compact must succeed independently of its UI toast');
  assert.equal(journey.byMarker('COMPACT_RECALL').requestInputIndex, command.inputIndex + 1);
  assert.equal(command.inputIndex, journey.byMarker('PLAN_FOLLOWUP').requestInputIndex + 1);
  return { question: acceptance.interactive.question.status, plan: acceptance.interactive.plan.status, attachments: attachment.status,
    diagnoses,
    compact: 'PASS_ACTUAL_NATIVE_RESULT_AND_POST_COMPACTION_RECALL', nativeCommandInputIndex: command.inputIndex,
    generatedQuestionFollowupInputIndex: acceptance.interactive.question.status === 'PASS_NATIVE_FOLLOWUP' ? acceptance.interactive.question.followupInputIndex : null,
    generatedPlanFollowupInputIndex: acceptance.interactive.plan.status === 'PASS_NATIVE_FOLLOWUP' ? acceptance.interactive.plan.followupInputIndex : null };
}

function auditOracles(common, acceptance, workspace) {
  assert.deepEqual(acceptance.oracles.map(value => value.stage), ['backoff', 'jitter', 'retry', 'full', 'full']);
  const expectedChecks = { backoff: 3, jitter: 5, retry: 12, full: 14 };
  return acceptance.oracles.map((value, index) => {
    contained(common.owner.directory, value.artifactPath); assert.equal(value.exitCode, 0);
    const report = read(value.artifactPath); assert.equal(report.status, 'PASS'); assert.equal(report.stage, value.stage);
    assert.equal(report.sourceSha256, value.sourceSha256); assert.equal(report.failed, 0);
    assert.equal(report.passed, expectedChecks[value.stage]); assert.equal(report.checks.length, expectedChecks[value.stage]);
    assert.equal(new Set(report.checks.map(item => item.name)).size, report.checks.length);
    assert(report.checks.every(item => item.status === 'PASS'));
    assert.equal(report.realProviderInputs, 0); assert.equal(report.fixtureSourceUnchanged, true);
    assert.deepEqual(report.network, ['owned loopback HTTP only']);
    if (index === acceptance.oracles.length - 1) assert.equal(value.sourceSha256, workspace.files['src/retry.cjs'].sha256, 'The final code oracle must cover the final actual source');
    return { stage: value.stage, passed: report.passed, sourceSha256: value.sourceSha256, artifactSha256: hash(value.artifactPath) };
  });
}

function audit(directory) {
  const common = auditCommon(directory);
  const acceptance = read(path.join(common.owner.directory, 'acceptance.json'));
  const workspace = auditWorkspace(common.manifest, common.owner, acceptance);
  const stored = readStoredConversations(common.owner);
  const journey = auditJourney(common, acceptance, stored);
  const permissions = auditPermissions(common, acceptance, journey);
  const interactions = auditInteractions(common, acceptance, journey);
  const oracleChecks = auditOracles(common, acceptance, workspace);
  assert(['PASS_BOUNDED_F1_BASELINE', 'PARTIAL_NATIVE_INTERACTION'].includes(acceptance.status));
  assert.deepEqual(acceptance.elapsedCampaigns, { S: 'NOT_RUN', W: 'NOT_RUN', E: 'NOT_RUN', P: 'NOT_RUN' });
  const partial = acceptance.limits.length > 0 || interactions.question !== 'PASS_NATIVE_FOLLOWUP' || interactions.plan !== 'PASS_NATIVE_FOLLOWUP'
    || permissions.readOnlyOutcome !== 'PASS_NATIVE_TOOL_DENIAL';
  assert.equal(acceptance.status, partial ? 'PARTIAL_NATIVE_INTERACTION' : 'PASS_BOUNDED_F1_BASELINE');
  return { status: partial ? 'PARTIAL_NATIVE_INTERACTION' : 'PASS_BOUNDED_F1_BASELINE', checkedAt: new Date().toISOString(),
    auditorSha256: hash(__filename), bundleSha256: common.manifest.bundleSha256, chatSha256: common.manifest.chatSha256,
    compiledJourneySha256: common.reservation.harnessSha256, observerSha256: common.reservation.observerSha256,
    evidenceSha256: Object.fromEntries(['acceptance.json', 'observations.json', 'events-main.json', 'events-other.json'].map(file => [file, hash(path.join(common.owner.directory, file))])),
    counts: acceptance.counts, receiptsSha256: common.owner.receiptPaths.map(file => ({ file, sha256: hash(file) })),
    pinnedIdentities: common.pinned, persistedConversations: journey.ownedConversations.map(value => ({ id: value.id, messageIds: value.messages.map(message => message.id), projectionSha256: digest(JSON.stringify(value.messages.map(messageProjection))) })),
    replies: journey.replyProofs, stops: journey.stopProofs, permissions, interactions, oracleChecks,
    workspace, observedProcessIdentitiesExited: common.ancestry.processIdentities.length, processSamplingMs: 250,
    semanticReview: 'ROOT_INDEPENDENT_REVIEW_REQUIRED', elapsedCampaigns: acceptance.elapsedCampaigns,
    scope: 'One ordinary installed-editor F1 workspace, two coexisting chat tabs, bounded Claude developer journey. No F2 or elapsed soak acceptance.',
    recordedHarnessLimits: acceptance.limits,
    limits: [...interactions.diagnoses.map(value => value.detail),
      ...acceptance.limits.filter(value => !interactions.diagnoses.some(diagnosis => diagnosis.diagnosis === 'HARNESS_SOURCE_TAG_FILTER_PREVENTED_NATIVE_FOLLOWUP_COVERAGE') || !value.includes('Native AskUserQuestion was not emitted')),
      'Process cleanup checks captured PID and birth identities at 250ms sampling; sub-sample processes may be unobserved.',
      'Automatic markers and code assertions supplement, but do not replace, root review of all prose and the resulting patch.'] };
}
module.exports = { audit, auditCommon, auditWorkspace, readStoredConversations, auditJourney, auditPermissions, auditReadOnly, auditInteractions, auditOracles, messageProjection, toolProjection, nativeToolSucceeded };
if (require.main === module) {
  const directory = path.resolve(process.env.MYSTI_PB01_ARTIFACT_DIR || '');
  contained(auditRoot, directory);
  try {
    const result = audit(directory);
    fs.writeFileSync(path.join(directory, 'independent-audit.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } catch (error) {
    const result = { status: 'FAIL', checkedAt: new Date().toISOString(), auditorSha256: hash(__filename),
      error: { name: error.name, message: error.message }, scope: 'PB-01 owned F1 artifacts only; read-only audit, no native/model/editor launch' };
    fs.writeFileSync(path.join(directory, 'independent-audit.json'), JSON.stringify(result, null, 2));
    console.error(JSON.stringify(result)); process.exitCode = 1;
  }
}
