/* PB-02 helper quality independent artifact acceptance. Never launches an editor/model. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readStoredConversations, messageProjection, toolProjection } = require('./audit-vscode-claude.cjs');
const { buildCases, buildAllowlist, verifyPreservedBase, verifyCopiedFixture } = require('./codex-helper-quality-contract.cjs');
const { auditEvidence: auditAuxiliary } = require('./codex-helper-quality-auxiliary.cjs');
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
const CASE_IDS = ['NONE', 'PLANS', 'QUESTIONS'];
const PURPOSES = ['title', 'classification', 'suggestion'];
const COLORS = ['blue', 'green', 'purple', 'orange', 'indigo', 'teal'];
const PLAN_ICONS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣'];
const SUGGESTION_ICONS = ['💡', '🔧', '📝', '🚀', '✨', '🎯'];
function ownedFile(directory, file) {
  contained(directory, file); assert(!fs.lstatSync(file).isSymbolicLink());
  assert(fs.lstatSync(file).isFile()); contained(fs.realpathSync(directory), fs.realpathSync(file)); return file;
}
function uniqueIds(values, prefix) {
  const valid = value => typeof value === 'string' && value.trim().length > 0;
  const reserved = new Set(values.map(value => value.id).filter(valid)), used = new Set();
  return values.map((value, index) => {
    let id = valid(value.id) ? value.id : '';
    if (!id || used.has(id)) { const base = `${prefix}${index + 1}`; id = base; let n = 1; while (used.has(id) || reserved.has(id)) id = `${base}-${n++}`; }
    used.add(id); return { ...value, id };
  });
}
/** Independent projection of the pinned production helper outputs; never invokes private application code. */
function parseHelperOutput(purpose, text) {
  assert(PURPOSES.includes(purpose)); assert.equal(typeof text, 'string'); assert(text.trim(), 'Empty helper output has no semantic credit');
  if (purpose === 'title') {
    const trimmed = text.trim(); let end = Math.min(50, trimmed.length);
    if (end < trimmed.length && /[\uD800-\uDBFF]/.test(trimmed[end - 1]) && /[\uDC00-\uDFFF]/.test(trimmed[end])) end--;
    return trimmed.slice(0, end);
  }
  const match = text.match(purpose === 'suggestion' ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/);
  assert(match, 'Helper must return parseable JSON'); const parsed = JSON.parse(match[0]);
  if (purpose === 'suggestion') {
    assert(Array.isArray(parsed) && parsed.length > 0);
    for (const item of parsed) {
      assert(item && typeof item === 'object' && !Array.isArray(item));
      assert.equal(typeof item.title, 'string'); assert(item.title.trim());
      assert.equal(typeof item.description, 'string'); assert.equal(typeof item.prompt, 'string'); assert(item.prompt.trim());
    }
    return parsed.slice(0, 6).map((item, index) => ({ title: item.title, description: item.description,
      message: item.prompt, icon: SUGGESTION_ICONS[index], color: COLORS[index] }));
  }
  assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  assert(Array.isArray(parsed.questions) && Array.isArray(parsed.planOptions)); assert.equal(typeof parsed.context, 'string');
  for (const question of parsed.questions) {
    assert(question && typeof question === 'object' && !Array.isArray(question));
    assert.equal(typeof question.question, 'string'); assert(question.question.trim());
    assert(question.options === undefined || Array.isArray(question.options));
    assert(question.inputType === undefined || ['select', 'radio', 'checkbox', 'text'].includes(question.inputType));
    assert((question.options?.length || 0) > 0 || question.inputType === 'text', 'Malformed questions cannot disappear into an empty classification');
    for (const option of question.options || []) {
      assert(option && typeof option === 'object' && !Array.isArray(option));
      assert.equal(typeof option.label, 'string'); assert(option.label.trim());
      assert(option.description === undefined || typeof option.description === 'string');
      assert(option.value === undefined || typeof option.value === 'string');
    }
  }
  const questions = uniqueIds(parsed.questions.filter(q => q.question && ((q.options?.length || 0) > 0 || q.inputType === 'text')).map(q => ({
    id: q.id, question: q.question, inputType: ['select', 'radio', 'checkbox', 'text'].includes(q.inputType) ? q.inputType : 'radio',
    options: uniqueIds((q.options || []).map(option => ({ id: option.id, label: option.label, description: option.description,
      value: String(option.value || option.label || '') })), 'opt'), placeholder: q.placeholder,
    required: q.required !== false, questionType: ['clarifying', 'meta'].includes(q.questionType) ? q.questionType : 'clarifying',
  })), 'q');
  for (const option of parsed.planOptions) {
    assert(option && typeof option === 'object' && !Array.isArray(option));
    assert.equal(typeof option.title, 'string'); assert(option.title.trim()); assert.equal(typeof option.approach, 'string'); assert(option.approach.trim());
    assert(option.summary === undefined || typeof option.summary === 'string');
    for (const field of ['pros', 'cons']) assert(option[field] === undefined || Array.isArray(option[field]));
  }
  const planOptions = uniqueIds(parsed.planOptions.filter(option => option.title && option.approach).map((option, index) => ({
    id: option.id, title: option.title.substring(0, 60), summary: String(option.summary || '').substring(0, 200), approach: option.approach,
    pros: Array.isArray(option.pros) ? option.pros.map(String).slice(0, 5) : [], cons: Array.isArray(option.cons) ? option.cons.map(String).slice(0, 5) : [],
    complexity: ['low', 'medium', 'high'].includes(option.complexity) ? option.complexity : 'medium', icon: PLAN_ICONS[index % 6], color: COLORS[index % 6],
  })), 'plan');
  return clean({ questions, planOptions, context: parsed.context.substring(0, 500) });
}

function joinNativeAssistantMessages(messages, content) {
  assert(messages.length > 0, 'Every public reply requires native assistant text');
  const bytes = Buffer.from(content), ids = new Set(); let offset = 0, previous;
  for (const message of messages) {
    assert(/^[a-f0-9]{64}$/.test(message.itemIdHash) && !ids.has(message.itemIdHash)); ids.add(message.itemIdHash);
    assert(['agentMessage', 'plan'].includes(message.itemType)); assert(Number.isSafeInteger(message.textBytes) && message.textBytes >= 0);
    assert(/^[a-f0-9]{64}$/.test(message.textSha256));
    const matches = [];
    for (let separatorBytes = 0; separatorBytes <= 2; separatorBytes++) {
      if (!bytes.subarray(offset, offset + separatorBytes).equals(Buffer.from('\n'.repeat(separatorBytes)))) continue;
      const raw = bytes.subarray(offset + separatorBytes, offset + separatorBytes + message.textBytes);
      if (raw.length !== message.textBytes || digest(raw) !== message.textSha256) continue;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      const needsBoundary = !!previous && (previous.id !== message.itemIdHash || previous.needsBoundary);
      const leading = text.match(/^[\r\n]*/)?.[0] || '';
      const required = needsBoundary && text && !/^[\r\n]+$/.test(text)
        ? Math.max(0, 2 - (((previous.trailingLineBreaks || '') + leading).split('\n').length - 1)) : 0;
      if (separatorBytes === required) matches.push({ text, separatorBytes, needsBoundary: !!(needsBoundary && /^[\r\n]+$/.test(text)) });
    }
    const match = one(matches, 'Native assistant text must join public bytes with only the exact product newline boundary');
    offset += match.separatorBytes + message.textBytes;
    if (match.text) previous = { id: message.itemIdHash, needsBoundary: match.needsBoundary,
      trailingLineBreaks: ((previous?.trailingLineBreaks || '') + '\n'.repeat(match.separatorBytes) + match.text).match(/[\r\n]*$/)?.[0].slice(-4) || '' };
  }
  assert.equal(offset, bytes.length, 'No unmatched public text can be credited to a native reply');
  return { messages: messages.length, bytes: bytes.length, sha256: digest(bytes) };
}

function auditCommon(directory) {
  contained(root, directory);
  const manifest = read(path.join(directory, 'prepared.json'));
  assert.equal(manifest.case, 'PB-02'); assert.equal(manifest.stage, 'HELPER_QUALITY_3');
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
  assert.deepEqual(manifest.cases, buildCases(manifest.token));
  assert.deepEqual(manifest.allowlist, buildAllowlist(manifest.cases));
  const pinned = [...Object.values(manifest.executableIdentities), ...manifest.wrapperIdentities, ...manifest.harnessDependencyIdentities,
    manifest.nodeIdentity, manifest.readiness, manifest.sourceIdentity, manifest.packageIdentity];
  pinned.forEach(identity);
  for (const dependency of ['audit-vscode-claude.cjs', 'audit-vscode-codex-helper-quality.cjs', 'codex-helper-quality-contract.cjs',
    'codex-helper-quality-auxiliary.cjs', 'codex-semantic-followup-contract.cjs', 'codex-stage-oracle.cjs',
    'pb02-helper-quality-main-runtime.cjs', 'pb02-helper-quality-auxiliary-runtime.cjs']) {
    assert(pinned.some(value => value.path === require.resolve('./' + dependency)), `Helper quality dependency must be pinned: ${dependency}`);
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
  assert.equal(hash(path.join(manifest.compiledDirectory, 'codex-helper-quality.test.js')), reservation.harnessSha256);
  assert.equal(hash(path.join(manifest.compiledDirectory, 'codex-helper-quality-observer.js')), reservation.observerSha256);
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
  const fixture = common.manifest.fixture, panelIds = acceptance.panels.map(value => value.panelId);
  assert.deepEqual(fixture.editableFiles, []); assert.equal(fixture.workspace, common.owner.workspace);
  verifyPreservedBase(fixture); assert.deepEqual(acceptance.preservedBase, fixture.base);
  const actual = verifyCopiedFixture(fixture, panelIds);
  const permitted = new Map(panelIds.map(id => [`.mysti/compaction/${id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120)}/history.jsonl`, id]));
  for (const artifact of actual.productArtifacts) {
    const panelId = artifact.relative === '.mysti/compaction/.gitignore' ? panelIds[0] : permitted.get(artifact.relative);
    assert(panelId, 'Runtime history must belong to one of these three actual panels'); auditHistoryArtifacts(common.owner.workspace, panelId, [artifact]);
  }
  assert.deepEqual(acceptance.files, actual); return actual;
}

function auditJourney(common, acceptance, stored) {
  const { manifest, owner, inputs, receipts } = common;
  assert.equal(acceptance.stage, 'HELPER_QUALITY_3'); assert.equal(acceptance.status, 'CAPTURED_HELPER_QUALITY_3');
  assert.equal(acceptance.semanticReview, 'ROOT_INDEPENDENT_REVIEW_REQUIRED');
  assert.equal(acceptance.counts.completedTurns, 3); assert.equal(acceptance.counts.conversationalInputs, 3); assert.equal(acceptance.counts.auxiliaryInputs, 0);
  assert.deepEqual(acceptance.panels.map(value => value.caseId), CASE_IDS);
  assert.equal(new Set(acceptance.panels.map(value => value.panelId)).size, 3); assert.equal(new Set(acceptance.panels.map(value => value.conversationId)).size, 3);
  assert.deepEqual(manifest.cases.map(value => value.caseId), CASE_IDS);
  const observations = read(ownedFile(owner.directory, path.join(owner.directory, 'observations.json')));
  const sessions = new Set(), turns = new Set(), messageIds = new Set(), panels = [], issues = [];
  assert.equal(inputs.length, 3); assert.deepEqual(inputs.map(value => value.inputIndex), [1, 2, 3]);
  assert(!receipts.some(value => ['tool-start', 'tool-result', 'approval-request', 'approval-decision', 'unexpected-tool-item', 'auxiliary-input'].includes(value.event)), 'No native tools, approvals, or hidden main-lane auxiliary work is authorized');
  for (const [index, panel] of acceptance.panels.entries()) {
    const definition = manifest.cases[index], reply = panel.reply, input = inputs[index];
    assert.equal(typeof panel.panelId, 'string'); assert(panel.panelId); assert.equal(typeof panel.conversationId, 'string'); assert(panel.conversationId);
    const eventsPath = path.join(owner.directory, `events-${panel.caseId}.json`);
    if (panel.eventsPath !== undefined) assert.equal(panel.eventsPath, eventsPath);
    const events = read(ownedFile(owner.directory, eventsPath));
    for (const event of events) assert(Number.isFinite(event.at));
    assert(events.some(value => value.type === 'initialState' && value.payload?.panelId === panel.panelId));
    assert(!events.some(value => ['error', 'authError', 'requestCancelled', 'toolUse', 'toolResult', 'permissionRequest',
      'autonomousDecision', 'semiAutonomousPlanTimer', 'semiAutonomousQuestionTimer'].includes(value.type)));
    const titleObservations = read(ownedFile(owner.directory, path.join(owner.directory, `title-observations-${panel.caseId}.json`)));
    assert(Array.isArray(titleObservations)); assert.deepEqual(panel.dom.titleObservations, titleObservations);
    for (const value of titleObservations) { assert(Number.isFinite(value.at)); assert.equal(typeof value.conversationId, 'string'); assert.equal(typeof value.title, 'string'); assert.equal(value.visible, true); }
    const conversation = one(stored.conversations.filter(value => value.id === panel.conversationId), 'Exactly one owned durable conversation for each case');
    assert.equal(panel.finalConversation.id, conversation.id); assert.deepEqual(panel.finalConversation.messages.map(messageProjection), conversation.messages.map(messageProjection));
    const users = conversation.messages.filter(value => value.role === 'user'), assistants = conversation.messages.filter(value => value.role === 'assistant');
    assert.equal(users.length, 1); assert.equal(assistants.length, 1);
    for (const message of conversation.messages) { assert(!messageIds.has(message.id)); messageIds.add(message.id); }
    assert.equal(users[0].content, definition.prompt);
    const publicUser = one(events.filter(value => value.type === 'messageAdded' && value.payload?.role === 'user'), 'Exactly one actual public user send');
    assert.deepEqual(messageProjection(publicUser.payload), messageProjection(users[0]));
    if (panel.userMessage) assert.deepEqual(messageProjection(panel.userMessage), messageProjection(users[0]));
    assert.equal(reply.marker, definition.marker); assert.equal(reply.ordinal, index + 1);
    assert.equal(reply.panelId, panel.panelId); assert.equal(reply.conversationId, panel.conversationId);
    assert.equal(reply.provider, 'openai-codex'); assert.equal(reply.model, manifest.model);
    assert.deepEqual(reply.scope, {}); assert.deepEqual(reply.tools, []); assert.deepEqual(reply.nativeTools, []); assert.deepEqual(reply.permissionDecisionIds, []);
    assert.deepEqual(reply.toolOutputEvidence, []); assert.deepEqual(reply.request, input);
    assert.deepEqual(input.outsideMemoryMarkers, [definition.marker], 'Fresh cases cannot inherit another case prompt');
    assert.equal(input.model, manifest.model); assert.equal(input.effort, 'low'); assert.equal(input.policy.effort, 'low');
    assert.equal(input.policy.approvalPolicy, 'untrusted'); assert.equal(input.policy.sandbox, 'read-only');
    for (const key of ['ownedCwd', 'mcpAllDisabled', 'appsAllDisabled', 'appsDefaultDisabled']) assert.equal(input.policy[key], true);
    const configuration = receipts.filter(value => value.event === 'effective-tool-config' && value.wrapperPid === input.wrapperPid && value.at <= input.at).at(-1);
    assert(configuration); assert.deepEqual(input.policy.mcpNames, configuration.mcpNames); assert.deepEqual(input.policy.appNames, configuration.appNames);
    const session = receipts.filter(value => value.event === 'session' && value.wrapperPid === input.wrapperPid && value.at <= input.at).at(-1);
    assert(session); assert.deepEqual(reply.nativeSession, session); assert.equal(session.method, 'thread/start');
    assert.equal(session.sessionHash, input.sessionHash); assert.equal(session.actualModel, manifest.model); assert.equal(session.requestedModel, manifest.model);
    assert.equal(typeof session.modelProvider, 'string'); assert(session.modelProvider);
    assert.equal(session.returnedPolicy.approvalPolicy, 'untrusted'); assert.equal(session.returnedPolicy.sandbox, 'readOnly');
    assert.equal(session.returnedPolicy.ownedCwd, true); assert.notEqual(session.returnedPolicy.networkAccess, true);
    assert(!sessions.has(session.sessionHash)); sessions.add(session.sessionHash);
    const terminal = one(events.filter(value => value.type === 'responseComplete'), 'Exactly one public terminal');
    assert.equal(terminal.at, reply.completedAt); assert.equal(terminal.payload.message.id, reply.messageId); assert.equal(terminal.payload.message.content, reply.content);
    assert.deepEqual(messageProjection(terminal.payload.message), messageProjection(assistants[0])); assert.equal(assistants[0].provider, manifest.provider || 'openai-codex'); assert.equal(assistants[0].model, manifest.model);
    assert.deepEqual(clean(terminal.payload.message.usage), clean(reply.usage)); assert.deepEqual(terminal.payload.message.toolCalls || [], []);
    assert(Number.isFinite(reply.started) && Number.isFinite(reply.completedAt)); assert(reply.started <= input.at && input.at <= reply.completedAt);
    assert(publicUser.at >= reply.started && publicUser.at <= reply.completedAt); assert(events.some(value => value.type === 'responseStarted' && value.at >= reply.started && value.at <= reply.completedAt));
    const wire = receipts.filter(value => value.wrapperPid === input.wrapperPid && value.inputIndex === input.inputIndex);
    const begun = one(wire.filter(value => value.event === 'turn-started'), 'One acknowledged native turn');
    const completed = one(wire.filter(value => value.event === 'turn-completed'), 'One successful native turn terminal');
    assert.equal(completed.status, 'completed'); assert.equal(begun.sessionHash, input.sessionHash); assert.equal(completed.sessionHash, input.sessionHash);
    assert.equal(completed.turnHash, begun.turnHash); assert(/^[a-f0-9]{64}$/.test(begun.turnHash)); assert(!turns.has(begun.turnHash)); turns.add(begun.turnHash);
    assert(input.at <= begun.at && begun.at <= completed.at && completed.at <= reply.completedAt); assert.deepEqual(reply.turnCompleted, completed);
    const nativeMessages = wire.filter(value => value.event === 'assistant-message');
    for (const value of nativeMessages) {
      assert.equal(value.sessionHash, input.sessionHash); assert.equal(value.turnHash, begun.turnHash);
      assert(value.at >= begun.at && value.at <= completed.at);
      assert(value.phase === undefined || value.phase === null || ['commentary', 'final_answer'].includes(value.phase));
    }
    const nativeText = joinNativeAssistantMessages(nativeMessages, reply.content);
    if (reply.content !== definition.expectedReply) issues.push({ caseId: panel.caseId, code: 'MAIN_LITERAL_MISMATCH', actualSha256: digest(reply.content), expectedSha256: digest(definition.expectedReply) });
    const recorded = one(observations.filter(value => value.event === 'native-response' && value.marker === reply.marker), 'One immutable captured reply observation');
    for (const key of Object.keys(reply)) assert.deepEqual(recorded[key], reply[key]);
    for (const [relative, original] of Object.entries(manifest.fixture.files)) {
      assert.equal(reply.beforeFiles.hashes[relative], original.sha256); assert.equal(recorded.afterFiles.hashes[relative], original.sha256);
    }
    panels.push({ panel, definition, events, conversation, reply, nativeText, nativeMessages, titleObservations });
  }
  for (const event of ['request', 'turn-started', 'turn-completed']) assert.equal(receipts.filter(value => value.event === event).length, 3, `Every ${event} belongs to exactly one owned case`);
  assert.deepEqual(receipts.filter(value => value.event === 'assistant-message'), panels.flatMap(value => value.nativeMessages), 'Every native assistant item must be independently joined');
  for (const conversation of stored.conversations.filter(value => !acceptance.panels.some(panel => panel.conversationId === value.id))) assert(!conversation.messages.some(value => ['user', 'assistant'].includes(value.role)));
  return { observations, panels, issues };
}

function auditCapturedOutputs(owner, allowlist, receipts, auxiliary) {
  assert.equal(allowlist.maxOutputBytes, 32768); assert.equal(allowlist.entries.length, 9);
  assert.equal(new Set(allowlist.entries.map(value => value.inputSha256)).size, 9);
  contained(owner.directory, owner.cliDirectory); assert.equal(fs.realpathSync(owner.cliDirectory), owner.cliDirectory);
  assert(!fs.lstatSync(owner.cliDirectory).isSymbolicLink());
  const outputDirectory = path.join(owner.cliDirectory, 'helper-outputs'); assert.equal(auxiliary.outputDirectory, outputDirectory);
  contained(owner.directory, outputDirectory); assert(!fs.lstatSync(outputDirectory).isSymbolicLink());
  assert.equal(fs.realpathSync(outputDirectory), outputDirectory); assert.equal(fs.statSync(outputDirectory).mode & 0o777, 0o700);
  const groups = new Map(), outputs = [], issues = [], authorizedFiles = new Set();
  for (const row of receipts) { if (!groups.has(row.wrapperPid)) groups.set(row.wrapperPid, []); groups.get(row.wrapperPid).push(row); }
  for (const [wrapperPid, rows] of groups) {
    const inputs = rows.filter(row => row.event === 'auxiliary-input'); assert(inputs.length <= 1);
    const captures = rows.filter(row => row.event === 'auxiliary-output-capture');
    const auths = rows.filter(row => row.event === 'auxiliary-capture-authorization'); assert(auths.length <= 1);
    const limits = rows.filter(row => row.event === 'auxiliary-capture-limit'); assert(limits.length <= 1);
    if (!inputs.length) { assert.equal(captures.length, 0); assert.equal(auths.length, 0); assert.equal(limits.length, 0); continue; }
    const input = inputs[0], submissions = rows.filter(row => row.event === 'auxiliary-submission'); assert(submissions.length <= 1);
    const result = rows.find(row => row.event === 'auxiliary-result'), exit = rows.find(row => row.event === 'exit');
    const submission = submissions[0], authorization = auths[0];
    if (!authorization) {
      assert.equal(captures.length, 0); assert.equal(limits.length, 0);
      issues.push({ wrapperPid, inputIndex: input.inputIndex, code: 'CAPTURE_AUTHORIZATION_UNOBSERVED' }); continue;
    }
    assert(submission, 'Capture authorization requires a complete actual stdin submission');
    assert(rows.indexOf(authorization) > rows.indexOf(submission));
    for (const key of ['inputIndex', 'inputBytes', 'inputEnded', 'inputSha256', 'purpose']) assert.deepEqual(authorization[key], submission[key]);
    assert.equal(authorization.inputEnded, true);
    const entry = allowlist.entries.find(value => value.inputSha256 === submission.inputSha256 && value.inputBytes === submission.inputBytes && value.purpose === submission.purpose);
    if (!entry) {
      assert.equal(authorization.status, 'UNKNOWN_UNRETAINED'); assert.equal(authorization.caseId, undefined);
      assert.equal(captures.length, 0); assert.equal(limits.length, 0);
      issues.push({ wrapperPid, inputIndex: input.inputIndex, code: 'UNKNOWN_HELPER_INPUT_UNRETAINED', inputSha256: submission.inputSha256 }); continue;
    }
    assert.equal(authorization.status, 'OWNED_ALLOWLIST'); assert.equal(authorization.caseId, entry.caseId);
    const relativePath = `helper-outputs/${input.inputIndex}-${wrapperPid}.stdout`, file = path.join(owner.cliDirectory, relativePath);
    authorizedFiles.add(path.basename(file));
    if (!captures.length) { assert.equal(limits.length, 0); issues.push({ caseId: entry.caseId, purpose: entry.purpose, wrapperPid, code: 'OUTPUT_CAPTURE_UNOBSERVED' }); continue; }
    ownedFile(owner.directory, file); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const bytes = fs.readFileSync(file); assert(bytes.length <= 32768, 'Retained output remains within the owned capture cap');
    let previous = 0, overflow = false;
    for (const capture of captures) {
      assert.equal(capture.relativePath, relativePath); assert.equal(capture.inputIndex, input.inputIndex);
      assert.equal(capture.caseId, entry.caseId); assert.equal(capture.purpose, entry.purpose); assert.equal(capture.inputSha256, entry.inputSha256);
      assert.equal(capture.completeInput, true); assert.equal(typeof capture.overflow, 'boolean');
      assert(Number.isSafeInteger(capture.bytes) && capture.bytes >= previous && capture.bytes <= bytes.length);
      assert.equal(capture.sha256, digest(bytes.subarray(0, capture.bytes)), 'Every progressive capture receipt joins actual retained bytes');
      assert(rows.indexOf(capture) > rows.indexOf(authorization)); assert(capture.at >= authorization.at);
      if (result) assert(rows.indexOf(capture) < rows.indexOf(result) && capture.at <= result.at);
      if (overflow) assert.equal(capture.overflow, true); overflow ||= capture.overflow; previous = capture.bytes;
    }
    const last = captures.at(-1); assert.equal(last.bytes, bytes.length); assert.equal(last.sha256, digest(bytes));
    assert.equal(limits.length, overflow ? 1 : 0);
    if (limits.length) {
      const limit = limits[0]; assert.equal(limit.caseId, entry.caseId); assert.equal(limit.purpose, entry.purpose);
      assert.equal(limit.inputIndex, input.inputIndex); assert.equal(limit.maxBytes, 32768); assert.equal(bytes.length, 32768);
      assert(rows.indexOf(limit) > rows.indexOf(authorization) && rows.indexOf(limit) < rows.indexOf(last));
    }
    const proof = { caseId: entry.caseId, purpose: entry.purpose, wrapperPid, inputIndex: input.inputIndex,
      inputSha256: submission.inputSha256, relativePath, bytes: bytes.length, sha256: digest(bytes), authorizationAt: authorization.at,
      resultAt: result?.at, exitAt: exit?.at, eligible: false,
      timing: { workerStartedAt: rows.find(row => row.event === 'auxiliary-start')?.at ?? null, submittedAt: submission.at,
        firstStdoutAt: rows.find(row => row.event === 'auxiliary-output-progress' && row.stream === 'stdout' && row.bytes > 0)?.at ?? null,
        resultAt: result?.at ?? null, exitAt: exit?.at ?? null } };
    const reject = code => { issues.push({ caseId: entry.caseId, purpose: entry.purpose, wrapperPid, code }); outputs.push(proof); };
    if (!result || !exit) { reject('HELPER_TERMINAL_UNOBSERVED'); continue; }
    assert.equal(result.inputSha256, entry.inputSha256); assert.equal(result.inputBytes, entry.inputBytes); assert.equal(result.inputEnded, true);
    if (overflow) { assert(result.stdoutBytes > 32768); reject('HELPER_OUTPUT_CAPTURE_OVERFLOW'); continue; }
    assert.equal(result.stdoutBytes, bytes.length); assert.equal(result.stdoutSha256, digest(bytes));
    if (result.exitCode !== 0 || result.signal !== null) { reject('HELPER_PROCESS_FAILED'); continue; }
    if (!bytes.length) { reject('EMPTY_HELPER_OUTPUT'); continue; }
    let parsed;
    try { parsed = parseHelperOutput(entry.purpose, new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch (error) { reject('INVALID_HELPER_OUTPUT'); continue; }
    outputs.push({ ...proof, eligible: true, parsed });
  }
  for (const entry of fs.readdirSync(outputDirectory, { withFileTypes: true })) {
    assert(entry.isFile() && !entry.isSymbolicLink()); assert(authorizedFiles.has(entry.name), 'No output body may exist without exact completed-input authorization');
    const file = ownedFile(owner.directory, path.join(outputDirectory, entry.name)); assert(fs.statSync(file).size <= 32768); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  return { outputs, issues };
}

function auditHelperQuality(common, journey, captured) {
  const issues = [...journey.issues, ...captured.issues], proofs = [];
  for (const { panel, definition, events, conversation, reply, titleObservations } of journey.panels) {
    const wait = panel.helperWait, dom = panel.dom;
    assert(wait && dom); for (const key of ['started', 'deadline', 'ended']) assert(Number.isFinite(wait[key]));
    assert(wait.started >= reply.started && wait.started <= wait.ended); assert.equal(wait.deadline - wait.started, 35000);
    assert.equal(typeof wait.timedOut, 'boolean'); if (wait.timedOut) assert(wait.ended >= wait.deadline);
    assert(Number.isFinite(dom.capturedAt) && dom.capturedAt >= wait.ended);
    assert(Array.isArray(dom.suggestions) && Array.isArray(dom.plans) && Array.isArray(dom.questions));
    const proof = { caseId: panel.caseId, panelId: panel.panelId, conversationId: panel.conversationId, purposes: {}, boundedObservation: clean(wait) };
    const use = (purpose, verify) => {
      if (reply.content !== definition.expectedReply) {
        issues.push({ caseId: panel.caseId, purpose, code: 'CASE_LITERAL_MISMATCH_NO_QUALITY_CREDIT' });
        proof.purposes[purpose] = { status: 'UNVERIFIED' }; return;
      }
      const outputs = captured.outputs.filter(value => value.caseId === panel.caseId && value.purpose === purpose);
      if (outputs.length !== 1 || !outputs[0].eligible) {
        issues.push({ caseId: panel.caseId, purpose, code: outputs.length > 1 ? 'DUPLICATE_HELPER_OUTPUT' : 'NO_ELIGIBLE_HELPER_OUTPUT' });
        proof.purposes[purpose] = { status: 'UNVERIFIED', workerCount: outputs.length }; return;
      }
      const output = outputs[0];
      assert(output.authorizationAt >= reply.started, 'Helper evidence must belong to this observed case interval');
      if (purpose !== 'title') assert(output.authorizationAt >= reply.turnCompleted.at, 'Response helpers consume the actual completed native assistant answer');
      if (output.exitAt > wait.ended) {
        issues.push({ caseId: panel.caseId, purpose, code: 'HELPER_TERMINAL_AFTER_OBSERVATION' }); proof.purposes[purpose] = { status: 'UNVERIFIED', wrapperPid: output.wrapperPid }; return;
      }
      try {
        verify(output.parsed, output);
        proof.purposes[purpose] = { status: 'VERIFIED', wrapperPid: output.wrapperPid, inputIndex: output.inputIndex,
          inputSha256: output.inputSha256, outputSha256: output.sha256, relativePath: output.relativePath, timing: clean(output.timing) };
        if (purpose === 'title') {
          const titleUpdatedAt = events.find(value => value.type === 'titleUpdated' && value.payload?.conversationId === panel.conversationId).at;
          const timing = proof.purposes[purpose].timing;
          Object.assign(timing, { mainSendStartedAt: reply.started, titleUpdatedAt, historyOpenedAt: dom.title.historyOpenedAt, visibleHistoryAt: dom.title.visibleAt,
            submissionToResultMs: timing.resultAt - timing.submittedAt,
            submissionToFirstStdoutMs: timing.firstStdoutAt === null ? null : timing.firstStdoutAt - timing.submittedAt,
            workerStartToResultMs: timing.workerStartedAt === null ? null : timing.resultAt - timing.workerStartedAt,
            resultToTitleUpdatedMs: titleUpdatedAt - timing.resultAt,
            titleUpdatedToVisibleHistoryMs: dom.title.visibleAt - titleUpdatedAt,
            mainSendToVisibleHistoryMs: dom.title.visibleAt - reply.started });
        }
      } catch (error) {
        issues.push({ caseId: panel.caseId, purpose, code: 'PUBLIC_HELPER_PROJECTION_MISMATCH', detail: error.message });
        proof.purposes[purpose] = { status: 'UNVERIFIED', wrapperPid: output.wrapperPid, outputSha256: output.sha256 };
      }
    };
    use('title', (title, output) => {
      const event = one(events.filter(value => value.type === 'titleUpdated' && value.payload?.conversationId === panel.conversationId), 'One actual title update for the owned conversation');
      assert.equal(event.payload.title, title); assert(event.at >= output.resultAt && event.at <= dom.capturedAt);
      assert.equal(panel.finalConversation.title, title); assert.equal(conversation.title, title);
      assert.equal(dom.title.historyConversationId, panel.conversationId); assert.equal(dom.title.historyTitle, title);
      assert(Number.isFinite(dom.title.visibleAt) && Number.isFinite(dom.title.historyOpenedAt));
      assert(dom.title.historyOpenedAt <= dom.title.visibleAt && event.at <= dom.title.visibleAt && dom.title.visibleAt <= dom.capturedAt);
      assert(titleObservations.some(value => value.conversationId === panel.conversationId && value.title === title && value.visible === true
        && value.at === dom.title.visibleAt), 'Visible title must join the actual passive DOM observation');
      assert(events.some(value => value.type === 'conversationHistory' && value.at >= event.at && value.at <= dom.capturedAt
        && value.payload?.conversations?.some(item => item.id === panel.conversationId && item.title === title)));
    });
    use('suggestion', (suggestions, output) => {
      const event = one(events.filter(value => value.type === 'suggestionsReady'), 'One actual suggestionsReady event');
      assert(event.at >= output.resultAt && event.at <= dom.capturedAt); const actual = event.payload.suggestions;
      assert.equal(actual.length, suggestions.length); assert.equal(new Set(actual.map(value => value.id)).size, actual.length);
      actual.forEach((value, index) => { assert(/^suggestion-\d+-\d+$/.test(value.id)); assert.equal(Number(value.id.split('-').at(-1)), index);
        const { id, ...rest } = value; assert.deepEqual(rest, suggestions[index]); });
      const last = events.filter(value => ['suggestionsReady', 'clearSuggestions', 'suggestionsError'].includes(value.type) && value.at <= dom.capturedAt).at(-1);
      const expected = last?.type === 'suggestionsReady' ? suggestions.map(value => ({ title: value.title, tooltip: value.description || value.message, color: value.color, icon: value.icon })) : [];
      assert.deepEqual(dom.suggestions, expected);
    });
    use('classification', (classification, output) => {
      const clarifying = classification.questions.filter(value => value.questionType === 'clarifying');
      const meta = classification.questions.filter(value => value.questionType === 'meta');
      if (panel.caseId === 'NONE') { assert.equal(classification.questions.length, 0); assert.equal(classification.planOptions.length, 0); }
      if (panel.caseId === 'PLANS') { assert.equal(clarifying.length, 0); assert.equal(classification.planOptions.length, 2); }
      if (panel.caseId === 'QUESTIONS') { assert.equal(clarifying.length, 1); assert.equal(classification.planOptions.length, 0); assert.equal(clarifying[0].options.length, 2); }
      const planEvents = events.filter(value => value.type === 'planOptions'), questionEvents = events.filter(value => value.type === 'askUserQuestion');
      if (panel.caseId === 'PLANS') {
        assert.equal(questionEvents.length, 0); assert.deepEqual(dom.questions, []);
        const event = one(planEvents, 'Two plans are delivered once'); assert(event.at >= output.resultAt && event.at <= dom.capturedAt);
        const payload = event.payload; assert.equal(payload.messageId, reply.messageId); assert.equal(payload.conversationId, panel.conversationId); assert.equal(payload.originalQuery, definition.prompt);
        assert.equal(typeof payload.syntheticPlanId, 'string'); assert(payload.syntheticPlanId); assert.equal(payload.source, undefined);
        assert.deepEqual(payload.options, classification.planOptions); assert.deepEqual(payload.metaQuestions || [], meta);
        assert.equal(dom.plans.length, 2);
        dom.plans.forEach((card, index) => { const expected = classification.planOptions[index]; assert.equal(card.optionId, expected.id); assert.equal(card.messageId, reply.messageId);
          for (const key of ['title', 'summary', 'complexity']) assert.equal(card[key], expected[key]); assert.equal(typeof card.text, 'string'); assert(card.text.includes(expected.title)); });
      } else if (panel.caseId === 'QUESTIONS') {
        assert.equal(planEvents.length, 0); assert.deepEqual(dom.plans, []);
        const event = one(questionEvents, 'Detected missing-preference question is delivered once'); assert(event.at >= output.resultAt && event.at <= dom.capturedAt);
        const payload = event.payload; assert.equal(payload.source, 'detected'); assert.equal(payload.messageId, reply.messageId);
        assert.equal(typeof payload.toolCallId, 'string'); assert(payload.toolCallId);
        assert.deepEqual(payload.questions, clarifying.map(value => ({ question: value.question, header: value.question,
          options: value.options.map(option => ({ label: option.label, description: option.description || '' })), multiSelect: value.inputType === 'checkbox' })));
        const card = one(dom.questions, 'Question renders once'); assert.equal(card.toolCallId, payload.toolCallId);
        assert.deepEqual(card.questionTexts, clarifying.map(value => value.question)); assert.deepEqual(card.optionLabels, clarifying.flatMap(value => value.options.map(option => option.label)));
        assert.equal(typeof card.text, 'string'); assert(card.text.includes(clarifying[0].question));
      } else { assert.equal(planEvents.length, 0); assert.equal(questionEvents.length, 0); assert.deepEqual(dom.plans, []); assert.deepEqual(dom.questions, []); }
    });
    proofs.push(proof);
  }
  return { status: issues.length ? 'PARTIAL_HELPER_QUALITY' : 'PASS_HELPER_QUALITY', proofs, issues,
    verifiedOutputs: proofs.reduce((sum, value) => sum + Object.values(value.purposes).filter(item => item.status === 'VERIFIED').length, 0),
    limitations: ['Native helper outputs remain stochastic; the audit joins actual output to expected UI categories and projections, not broad semantic correctness.',
      'No public classifier-completed event exists for NONE; valid captured empty classification and bounded absence of cards provide its evidence.'] };
}

function auditMainLifecycle(common, journey) {
  const { receipts } = common, proofs = [], issues = [];
  const invocations = receipts.filter(row => row.event === 'invocation'); assert.equal(new Set(invocations.map(row => row.wrapperPid)).size, invocations.length);
  assert.equal(new Set(journey.panels.map(value => value.reply.request.wrapperPid)).size, 3);
  for (const invocation of invocations) {
    assert(['app-server', 'probe'].includes(invocation.kind)); assert.deepEqual(invocation.args, invocation.kind === 'probe' ? ['--version'] : ['app-server']);
    assert.equal(invocation.selectedProfile, undefined);
    const rows = receipts.filter(row => row.wrapperPid === invocation.wrapperPid), probe = invocation.kind === 'probe';
    if (probe) assert(rows.every(row => ['invocation', 'probe-start', 'stderr-summary', 'probe-exit'].includes(row.event)), 'Version probes cannot carry RPC, session or model work');
    const start = one(rows.filter(row => row.event === (probe ? 'probe-start' : 'start')), 'Each native invocation has one child');
    const summaries = rows.filter(row => row.event === 'stderr-summary'), exits = rows.filter(row => row.event === (probe ? 'probe-exit' : 'exit'));
    assert(summaries.length <= 1 && exits.length <= 1, 'Native terminal metadata cannot be duplicated');
    const summary = summaries[0] || null, exit = exits[0] || null;
    assert(Number.isSafeInteger(start.childPid) && start.childPid > 0); assert(rows.indexOf(invocation) < rows.indexOf(start));
    assert(invocation.at <= start.at);
    if (summary) {
      assert(rows.indexOf(start) < rows.indexOf(summary)); assert(summary.at >= start.at); assert.equal(summary.runtimeOnlyProfileArgument, false);
      assert(Number.isSafeInteger(summary.bytes) && summary.bytes >= 0 && /^[a-f0-9]{64}$/.test(summary.sha256));
      if (!summary.bytes) assert.equal(summary.sha256, digest(''));
    }
    if (exit) {
      assert.equal(exit.childPid, start.childPid); assert(rows.indexOf(start) < rows.indexOf(exit)); assert(exit.at >= start.at);
      assert(exit.exitCode === null || Number.isSafeInteger(exit.exitCode)); assert(exit.signal === null || /^SIG[A-Z0-9]+$/.test(exit.signal));
      assert(exit.exitCode !== null || exit.signal !== null);
    }
    if (summary && exit) { assert(rows.indexOf(summary) < rows.indexOf(exit)); assert(summary.at <= exit.at); }
    const terminalStatus = summary && exit ? 'complete' : 'UNOBSERVED';
    if (terminalStatus === 'UNOBSERVED') {
      assert(!probe, 'Probe terminal absence is outside the named final-conversation shutdown exception');
      const item = one(journey.panels.filter(value => value.reply.request.wrapperPid === invocation.wrapperPid), 'Only the exact final process of an observed owned case may have unknown shutdown metadata');
      assert.equal(item.panel.lifecycleBoundary?.terminalStatus, 'UNOBSERVED');
      issues.push({ caseId: item.panel.caseId, wrapperPid: invocation.wrapperPid, childPid: start.childPid, code: 'MAIN_SHUTDOWN_METADATA_UNOBSERVED',
        missing: [...(!summary ? ['stderr-summary'] : []), ...(!exit ? ['exit'] : [])] });
    }
    proofs.push({ wrapperPid: invocation.wrapperPid, childPid: start.childPid, kind: invocation.kind, terminalStatus, summary: clean(summary), exit: clean(exit) });
  }
  for (const row of receipts) assert(invocations.some(value => value.wrapperPid === row.wrapperPid), 'No main receipt may lack its actual invocation');
  const isShutdownObservation = row => ['stderr-summary', 'exit'].includes(row.event)
    || invocations.some(value => value.kind === 'probe' && value.wrapperPid === row.wrapperPid)
      && ['invocation', 'probe-start', 'stderr-summary', 'probe-exit'].includes(row.event);
  for (const [index, item] of journey.panels.entries()) {
    const { panel, reply, events } = item, boundary = panel.lifecycleBoundary;
    assert(boundary); assert.equal(boundary.action, 'public-owned-chat-tab-close'); assert.equal(boundary.panelId, panel.panelId);
    assert.deepEqual(boundary.tab, panel.tab); assert(/^(?:mainThreadWebview-)?mysti\.detachedChat$/.test(boundary.tab.viewType));
    for (const key of ['closeAccepted', 'tabAbsent', 'frameDetached', 'tabCloseEventSeen']) assert.equal(boundary[key], true);
    for (const key of ['started', 'closedAt', 'ended']) assert(Number.isFinite(boundary[key]));
    assert(boundary.started >= panel.dom.capturedAt && boundary.started >= panel.helperWait.ended && boundary.started >= reply.completedAt);
    assert(boundary.started <= boundary.closedAt && boundary.closedAt <= boundary.ended);
    assert(events.every(value => value.at <= boundary.started), 'Actual public events are retained before frame destruction');
    const observed = one(journey.observations.filter(value => value.event === 'lifecycle-boundary' && value.caseId === panel.caseId), 'One actual public close per owned case');
    for (const key of Object.keys(boundary)) assert.deepEqual(observed[key], boundary[key]); assert(observed.at >= boundary.ended);
    const tab = one(journey.observations.filter(value => value.event === 'owned-chat-tab' && value.caseId === panel.caseId), 'One actual owned tab identity per case');
    assert.equal(tab.panelId, panel.panelId); assert.equal(tab.label, boundary.tab.label); assert.equal(tab.viewType, boundary.tab.viewType); assert(tab.at <= boundary.started);
    const begin = boundary.receiptStartIndex, end = boundary.receiptEndIndex;
    assert(Number.isSafeInteger(begin) && Number.isSafeInteger(end) && begin >= 0 && end >= begin && end <= receipts.length);
    const during = receipts.slice(begin, end); assert(during.every(row => row.at >= boundary.started && row.at <= boundary.ended));
    assert(during.every(isShutdownObservation), 'Closing the tab performs no native work or prewarm; only complete version probes may overlap');
    assert.equal(boundary.finalInputIndex, index + 1); assert.equal(boundary.finalWrapperPid, reply.request.wrapperPid);
    const process = one(proofs.filter(value => value.wrapperPid === boundary.finalWrapperPid), 'Closing tab owns its final native process');
    assert.equal(boundary.terminalStatus, process.terminalStatus);
    assert.equal(boundary.finalChildPid, process.childPid); assert.deepEqual(boundary.summary, process.summary); assert.deepEqual(boundary.exit, process.exit);
    for (const terminal of [process.summary, process.exit].filter(Boolean)) assert(during.some(row => row === terminal || JSON.stringify(row) === JSON.stringify(terminal)), 'Every present final-process terminal is joined within the captured public close interval');
    if (!process.exit) assert(boundary.ended - boundary.closedAt >= 2000, 'Unknown exit requires the full bounded observation after public close');
    assert.equal(boundary.inputCountBefore, index + 1); assert.equal(boundary.inputCountAfter, index + 1);
    assert.equal(receipts.slice(0, begin).filter(row => row.event === 'request').length, index + 1); assert.equal(receipts.slice(0, end).filter(row => row.event === 'request').length, index + 1);
    assert(receipts.slice(begin).filter(row => row.wrapperPid === process.wrapperPid).every(row => ['stderr-summary', 'exit'].includes(row.event)));
    if (index) assert(boundary.started >= journey.panels[index - 1].panel.lifecycleBoundary.ended);
  }
  const last = journey.panels.at(-1).panel.lifecycleBoundary;
  assert(receipts.slice(last.receiptStartIndex).every(isShutdownObservation), 'No native restart after the final public close');
  return { status: issues.length ? 'PARTIAL_MAIN_SHUTDOWN' : 'PASS_MAIN_TRANSPORT', processes: proofs, issues,
    limitation: 'Missing shutdown receipts remain unobserved even when separately sampled process identities are verified exited; no exit code or signal is inferred.' };
}

function aggregateStatus(mainTransport, quality) {
  assert(['PASS_MAIN_TRANSPORT', 'PARTIAL_MAIN_SHUTDOWN'].includes(mainTransport.status));
  assert(['PASS_HELPER_QUALITY', 'PARTIAL_HELPER_QUALITY'].includes(quality.status));
  if (mainTransport.status === 'PASS_MAIN_TRANSPORT') return quality.status;
  return quality.status === 'PASS_HELPER_QUALITY' ? 'PARTIAL_MAIN_SHUTDOWN' : 'PARTIAL_HELPER_QUALITY_AND_MAIN_SHUTDOWN';
}

function auditAuxiliaryArtifacts(common) {
  const { manifest, owner } = common, auxiliary = manifest.auxiliary;
  assert.equal(auxiliary.maxInputs, 10); assert.equal(auxiliary.routingSetting, 'mysti.claudeCodePath');
  const settings = read(path.join(owner.profile, 'User/settings.json'));
  assert.equal(settings[auxiliary.routingSetting], auxiliary.launcher); assert.equal(settings['mysti.codexPath'], owner.wrappers['openai-codex']);
  assert.equal(settings['mysti.planDetection.enabled'], true); assert.equal(settings['mysti.showSuggestions'], true);
  assert.equal(settings['mysti.defaultModel'], 'gpt-5.6-sol'); assert.equal(settings['mysti.codexProfile'], '');
  assert.equal(owner.auxiliaryReceiptPaths.length, 1); assert(!owner.receiptPaths.includes(owner.auxiliaryReceiptPaths[0]));
  const receipts = owner.auxiliaryReceiptPaths.flatMap(file => fs.readFileSync(ownedFile(owner.directory, file), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
  const live = execFileSync('ps', ['-axo', 'pid=,lstart='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/); assert(match); return { pid: +match[1], startedAt: match[2] };
  });
  assert(!fs.existsSync(auxiliary.counterFile + '.lock'));
  const transport = auditAuxiliary({ auxiliary, receipts, ancestry: common.ancestry,
    cleanup: read(path.join(owner.directory, 'editor-exit-process-check.json')),
    counter: fs.existsSync(auxiliary.counterFile) ? read(auxiliary.counterFile) : { forwardedInputs: 0, maxInputs: 10 },
    live, primaryAuxiliaryInputs: 0, temporaryRoot: fs.realpathSync(os.tmpdir()) });
  transport.remainingPrivateDirectories = transport.temporaryDirectories.filter(file => fs.existsSync(file));
  for (const file of transport.remainingPrivateDirectories) { assert(!fs.lstatSync(file).isSymbolicLink()); assert.deepEqual(fs.readdirSync(file), []); }
  return { transport, receipts, captured: auditCapturedOutputs(owner, manifest.allowlist, receipts, auxiliary) };
}

function audit(directory) {
  const common = auditCommon(directory), acceptance = read(ownedFile(common.owner.directory, path.join(common.owner.directory, 'acceptance.json')));
  const workspace = auditWorkspace(common, acceptance), stored = readStoredConversations(common.owner);
  const journey = auditJourney(common, acceptance, stored), mainTransport = auditMainLifecycle(common, journey);
  const auxiliary = auditAuxiliaryArtifacts(common), quality = auditHelperQuality(common, journey, auxiliary.captured);
  verifyPreservedBase(common.manifest.fixture);
  return { status: aggregateStatus(mainTransport, quality), checkedAt: new Date().toISOString(), auditorSha256: hash(__filename),
    sourceIdentity: common.manifest.sourceIdentity, packageIdentity: common.manifest.packageIdentity, preservedBase: common.manifest.fixture.base,
    pinnedIdentities: common.pinned, compiledJourneySha256: common.reservation.harnessSha256, observerSha256: common.reservation.observerSha256,
    evidenceSha256: Object.fromEntries(['acceptance.json', 'observations.json', ...CASE_IDS.flatMap(id => [`events-${id}.json`, `title-observations-${id}.json`])].map(file => [file, hash(path.join(common.owner.directory, file))])),
    receiptIdentities: [...common.owner.receiptPaths, ...common.owner.auxiliaryReceiptPaths].map(file => ({ path: file, sha256: hash(file) })),
    counts: acceptance.counts, workspace, mainTransport, auxiliary: auxiliary.transport, helperCaptures: auxiliary.captured, quality,
    inputAccounting: { mainConversationInputs: common.inputs.length, mainLaneAuxiliaryInputs: 0, helperInputs: auxiliary.transport.counts.submitted,
      mainInputCap: 3, helperInputCap: 10, combinedSubmittedInputs: common.inputs.length + auxiliary.transport.counts.submitted, verifiedHelperOutputs: quality.verifiedOutputs },
    mainReplies: journey.panels.map(value => ({ caseId: value.panel.caseId, panelId: value.panel.panelId, conversationId: value.panel.conversationId,
      messageId: value.reply.messageId, nativeText: value.nativeText, literalMatched: value.reply.content === value.definition.expectedReply })),
    observedProcessIdentitiesExited: common.ancestry.processIdentities.length, processSamplingMs: 250,
    semanticReview: 'ROOT_INDEPENDENT_REVIEW_REQUIRED', elapsedCampaigns: { S: 'NOT_RUN', W: 'NOT_RUN', E: 'NOT_RUN', P: 'NOT_RUN' },
    limits: quality.limitations };
}
module.exports = { audit, auditCommon, auditWorkspace, auditJourney, auditMainLifecycle, auditAuxiliaryArtifacts,
  auditCapturedOutputs, auditHelperQuality, parseHelperOutput, joinNativeAssistantMessages, aggregateStatus, CASE_IDS, PURPOSES };
if (require.main === module) {
  const directory = path.resolve(process.env.MYSTI_PB02_HELPER_QUALITY_ARTIFACT_DIR || ''); contained(root, directory);
  const primary = path.join(directory, 'independent-audit.json');
  const output = fs.existsSync(primary) ? path.join(directory, `independent-audit-${Date.now()}.json`) : primary;
  try { const result = audit(directory); fs.writeFileSync(output, JSON.stringify(result, null, 2), { flag: 'wx' }); console.log(JSON.stringify(result)); }
  catch (error) {
    const result = { status: 'FAIL', checkedAt: new Date().toISOString(), auditorSha256: hash(__filename), error: { name: error.name, message: error.message },
      scope: 'Read-only owned helper-quality evidence audit; no editor or inference launched' };
    fs.writeFileSync(output, JSON.stringify(result, null, 2), { flag: 'wx' }); console.error(JSON.stringify(result)); process.exitCode = 1;
  }
}
