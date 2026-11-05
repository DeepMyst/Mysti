/* Additive prelaunch-pinned read-only F05 verification auditor. Read-only; no editor, model, Git refresh or application launch. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const c = require('./codex-f2-webhook-verification-campaign.cjs');
const plan = require('./codex-f2-webhook-verification-steps.cjs');
const { dependencyTree } = require('./codex-f2-test-proof.cjs');
const aux = require('./codex-f2-signed-webhook-auxiliary.cjs');
const { readStoredConversations, messageProjection, toolProjection } = require('./audit-vscode-claude.cjs');
const { assertToolOutputProjection } = require('./codex-full-oracle.cjs');
const { joinNativeAssistantMessages } = require('./audit-vscode-codex-helper-quality.cjs');
const repo = path.resolve(__dirname, '../..'), root = path.join(repo, 'out-test/feature-tests/PB-02');
const compact = require('./codex-f2-compact-store.cjs');
const read = file => file.startsWith(root + path.sep) ? compact.readJson(file) : JSON.parse(fs.readFileSync(file, 'utf8')), hash = c.hash;
const one = (values, why) => { assert.equal(values.length, 1, why); return values[0]; };
const key = value => `${value.pid}|${value.startedAt}`;
function ownedFile(directory, file) { c.contained(directory, file); assert.equal(fs.realpathSync(file), file); assert(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink()); return file; }
function pin(value) { assert(value && /^[a-f0-9]{64}$/.test(value.sha256)); assert.equal(c.identity(value.path).sha256, value.sha256, `Pinned bytes changed: ${value.path}`); return value; }
function auditAuditorProvenance(pins) {
  const required = ['audit-vscode-codex-f2-webhook-verification.cjs', 'check-codex-f2-webhook-verification-audit.cjs',
    'codex-f2-webhook-verification-campaign.cjs', 'codex-f2-webhook-verification-steps.cjs', 'codex-f2-signed-webhook-auxiliary.cjs', 'codex-f2-webhook-verification-invocation.cjs'];
  const identities = required.map(name => {
    const file = path.join(__dirname, name), recorded = one(pins.filter(value => value.path === file), 'Exactly one prelaunch auditor dependency pin: ' + name);
    assert.deepEqual(recorded, c.identity(file), 'Prelaunch auditor dependency identity cannot change'); return pin(recorded);
  });
  return { kind: 'PRELAUNCH_PINNED_F05_REVIEW', auditorPrelaunchPinned: true, identities,
    timingBasis: 'Native request follows captured driver send start; public messageAdded timestamps record asynchronous browser delivery, not host emission.' };
}
const bounded = require('./codex-f2-webhook-verification-invocation.cjs');
const apiReadiness=require('./audit-vscode-codex-f2-verification.cjs');
function featureDependencies() {
  apiReadiness.auditApiEvidence({apiEvidence:apiReadiness.API_EVIDENCE});
  const {plan,qualification}=c.candidateProvenance(), runner=bounded.qualifiedRunner();
  return require('./pb02-unique-pins.cjs').uniquePins([...Object.values(apiReadiness.API_EVIDENCE),
    c.identity(require.resolve('./audit-vscode-codex-f2-verification.cjs')),c.PLAN,c.QUALIFICATION,c.CASE_CONTRACT,
    ...qualification.implementationPins.slice(0,8),...plan.candidate.changes.flatMap(row=>[row.draftAfter,row.qualifiedArchivedAfter]),
    c.PRIOR_NATIVE_CHECKPOINT,c.PRIOR_REVIEW,c.PRIOR_CLEANUP,c.PRIOR_PRESERVATION,c.BOUNDED_QUALIFICATION,
    runner.qualification.validation,runner.qualification.controls,...runner.qualification.runnerPins,
    c.identity(require.resolve('./codex-f2-webhook-verification-invocation.cjs')),
    c.identity(require.resolve('./codex-f2-signed-webhook-campaign.cjs')),c.identity(require.resolve('./codex-f2-signed-webhook-steps.cjs'))]);
}
function auditFeatureDependencies(campaign,pins) {
  const expected=featureDependencies(); assert.deepEqual(campaign.featureDependencies,expected);
  for(const dependency of expected) { pin(dependency); assert.deepEqual(one(pins.filter(value=>value.path===dependency.path),'Exactly one prelaunch feature dependency pin'),dependency); }
  return expected;
}
function auditEvidenceInventory(campaign) {
  assert.equal(campaign.evidenceDirectory,path.join(campaign.directory,'evidence'));
  const kinds=[...new Set(c.buildSteps(campaign.workspace).map(step=>step.evidence).filter(Boolean))];
  const expected=Object.fromEntries(kinds.map(kind=>[kind,[path.join(campaign.evidenceDirectory,kind,'review.json'),...(kind==='checkpoint'?[path.join(campaign.evidenceDirectory,kind,'prior-context.json')]:[])]]));
  assert.deepEqual(campaign.evidenceFiles,expected,'Exact evidence inventory includes both fresh checkpoint and preserved context documents');
  return {kinds,checkpointDocuments:expected.checkpoint.slice()};
}
function receipts(file) { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse); }
function auditGeneratedFiles(value, expectedRoot) {
  assert(value && typeof value === 'object'); assert.equal(value.root, expectedRoot); assert(Array.isArray(value.files));
  assert.equal(value.fileCount, value.files.length); assert.equal(new Set(value.files.map(row => row.relative)).size, value.files.length);
  let bytes = 0;
  for (const row of value.files) {
    assert.deepEqual(Object.keys(row).sort(), ['bytes', 'path', 'relative', 'sha256']);
    assert.equal(typeof row.relative, 'string'); assert(row.relative && !path.isAbsolute(row.relative));
    assert.equal(path.normalize(row.relative), row.relative); assert(!row.relative.split(/[\\/]/).some(part => ['..', '.'].includes(part)));
    assert.equal(row.path, path.join(expectedRoot, row.relative)); assert(row.path.startsWith(expectedRoot + path.sep));
    assert(/^[a-f0-9]{64}$/.test(row.sha256)); assert(Number.isSafeInteger(row.bytes) && row.bytes >= 0);
    if (!row.bytes) assert.equal(row.sha256, hash('')); bytes += row.bytes; assert(Number.isSafeInteger(bytes));
  }
  assert.equal(value.bytes, bytes); return { files: value.fileCount, bytes };
}
function auditBoundary(fixture, boundary, completedCases, panelIds, requireBuild = false) {
  assert.deepEqual(fixture.commandPolicy, c.buildCommandPolicy(fixture.workspace));
  assert.deepEqual(Object.keys(boundary).sort(), ['applicationTemporarySnapshot', 'buildSnapshot', 'cacheSnapshot', 'dependencySnapshots', 'files']);
  auditSnapshotEvidence(fixture, boundary.files, completedCases, panelIds);
  const policy = fixture.commandPolicy;
  assert.deepEqual(boundary.dependencySnapshots, fixture.dependencyCopies.map(row => ({ target: row.target, treeSha256: row.treeSha256, files: row.files })), 'Every dependency tree outside the exact client cache remains unchanged');
  const cache = boundary.cacheSnapshot; assert.deepEqual(Object.keys(cache).sort(), ['bytes', 'fileCount', 'files', 'httpActivity', 'root']);
  auditGeneratedFiles(cache, policy.craCacheRoot); assert.deepEqual(cache.httpActivity, [], 'Observed npm HTTP fetch activity exceeds the declared command scope');
  for (const row of cache.files) {
    const parts = row.relative.split(path.sep); assert(policy.craCacheChildren.includes(parts[0]), 'No generated cache sibling outside exact allowlist');
    if (parts[0] === 'pb02-scoped') assert(['jest', 'npm', 'tmp'].includes(parts[1]), 'No command cache sibling outside exact roots');
  }
  const build = boundary.buildSnapshot;
  if (build !== null) {
    assert.deepEqual(Object.keys(build).sort(), ['bytes', 'fileCount', 'files', 'root', 'sourceMapMatches']); auditGeneratedFiles(build, policy.buildRoot);
    const selected = ['client/src/models/List.js', 'client/src/components/Card/Tasks.jsx'];
    assert(Object.keys(build.sourceMapMatches).every(name => selected.includes(name)));
    for (const [name, sha256] of Object.entries(build.sourceMapMatches)) assert.equal(sha256, boundary.files.hashes[name], 'Build map joins the exact authorized source bytes');
    if (requireBuild) { assert.deepEqual(Object.keys(build.sourceMapMatches).sort(), selected.sort()); assert(build.files.some(row => row.relative.endsWith('.js.map'))); }
  } else assert(!requireBuild, 'Actual build and selected source maps are required');
  if (boundary.applicationTemporarySnapshot !== null) {
    assert.deepEqual(Object.keys(boundary.applicationTemporarySnapshot).sort(), ['bytes', 'fileCount', 'files', 'root']);
    auditGeneratedFiles(boundary.applicationTemporarySnapshot, path.join(fixture.workspace, 'server/.tmp'));
  }
  return { dependencyTrees: boundary.dependencySnapshots.length, cache: { files: cache.fileCount, bytes: cache.bytes }, build: build && { files: build.fileCount, bytes: build.bytes } };
}
function auditStageBoundary(fixture,boundary,completedCases,panelIds) {
  const result=auditBoundary(fixture,boundary,completedCases,panelIds,false);
  assert.equal(boundary.buildSnapshot,null,'Fresh server-only F05 workflow cannot create or claim a client build');return result;
}
function auditNpmLogHistory(fixture, boundaries, finalBoundary) {
  const prefix = fixture.commandPolicy.npmLogs + path.sep;
  const logs = value => value.cacheSnapshot.files.filter(row => row.path.startsWith(prefix));
  const finalLogs = new Map(logs(finalBoundary).map(row => [row.path, row]));
  for (const boundary of boundaries) for (const row of logs(boundary)) assert.deepEqual(finalLogs.get(row.path), row, 'Earlier completed npm logs cannot disappear or change before independent review');
  const observed = [];
  for (const row of finalLogs.values()) {
    ownedFile(fixture.workspace, row.path); assert.equal(fs.statSync(row.path).nlink, 1); assert.equal(fs.statSync(row.path).size, row.bytes); assert.equal(c.identity(row.path).sha256, row.sha256);
    assert(row.bytes <= 5 * 1024 * 1024, 'Bounded npm log inspection');
    const lines = fs.readFileSync(row.path, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => { if (/\bhttp\s+fetch\b/i.test(line)) observed.push({ relative: row.relative, lineNumber: index + 1, lineSha256: hash(line) }); });
  }
  assert.deepEqual(observed, [], 'Actual retained npm logs contain HTTP fetch activity');
  return { retainedLogFiles: finalLogs.size, observedHttpFetchRecords: 0, scope: 'No HTTP fetch record in the complete retained owned npm log set; no claim of universal network observation.' };
}
function auditBoundaryRecord(label, snapshot, record, observed, earliest = -Infinity, latest = Infinity) {
  assert.deepEqual(Object.keys(record).sort(), ['at', 'durationMs', 'label', 'snapshot']);
  assert.equal(record.label, label); assert.deepEqual(record.snapshot, snapshot); assert.equal(observed.event, 'boundary'); assert.equal(observed.label, label); assert.deepEqual(observed.snapshot, snapshot);
  for (const value of [record.at, observed.at, record.durationMs, observed.durationMs]) assert(Number.isFinite(value));
  assert(record.durationMs >= 0 && observed.durationMs >= record.durationMs);
  assert(earliest <= record.at && record.at <= observed.at && observed.at <= latest);
}
function auditSnapshotEvidence(fixture, snapshot, completedCases, panelIds) {
  assert.deepEqual(snapshot.completedCases, completedCases); assert.equal(snapshot.indexSha256, fixture.indexSha256);
  const expected = c.expectedSnapshotHashes(fixture, completedCases);
  assert.deepEqual(snapshot.hashes, expected, 'Every original source, note, test and Git byte has the exact authorized stage hash');
  const allowed = new Set(panelIds.flatMap(id => [`.mysti/compaction/${id}/history.jsonl`, '.mysti/compaction/.gitignore']));
  assert(Array.isArray(snapshot.productFiles)); assert.equal(new Set(snapshot.productFiles.map(row => row.relative)).size, snapshot.productFiles.length);
  for (const row of snapshot.productFiles) { assert(allowed.has(row.relative)); assert.equal(row.path, path.join(fixture.workspace, row.relative)); assert(/^[a-f0-9]{64}$/.test(row.sha256)); }
  const log = 'server/logs/planka.log';
  assert(!Object.hasOwn(fixture.files, log) && !Object.hasOwn(snapshot.hashes, log), 'Generated application log never enters the original source baseline');
  assert(Array.isArray(snapshot.applicationLogs) && snapshot.applicationLogs.length <= 1);
  for (const row of snapshot.applicationLogs) {
    assert.deepEqual(Object.keys(row).sort(), ['bytes', 'path', 'relative', 'sha256']);
    assert.equal(row.relative, log); assert.equal(row.path, path.join(fixture.workspace, log));
    ownedFile(fixture.workspace, row.path); assert.equal(fs.statSync(row.path).nlink, 1, 'Application log cannot share an external hard-link identity');
    assert(/^[a-f0-9]{64}$/.test(row.sha256)); assert(Number.isSafeInteger(row.bytes) && row.bytes >= 0);
    if (row.bytes === 0) assert.equal(row.sha256, hash(''));
    // Earlier log snapshots may precede later application writes. Final actual
    // bytes are joined by verifySnapshot and the final snapshot equality below.
  }
  return { completedCases: completedCases.slice(), indexSha256: snapshot.indexSha256 };
}
function permittedTool(tool, step, commands, fixture) {
  const name = String(tool.name).toLowerCase(), input = tool.input || {};
  return name === 'bash' ? input.cwd === fixture.workspace && commands.some(command => c.exactCommand(input.command, command))
    : name === 'edit' && !!step.patch && c.recordedPatchScope(input.changes, fixture, step.patch);
}
function historyExpectation(priorMessages, currentPrompt, acknowledged, cold) {
  const fingerprint = message => hash(JSON.stringify([message.role, message.content]));
  const selected = cold ? priorMessages.slice(-10) : priorMessages.filter(message => acknowledged.get(message.id) !== fingerprint(message));
  const text = selected.map(message => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}\n`).join('') + currentPrompt;
  const markers = [...new Set([...text.matchAll(/PB02_REQUEST:([A-Z0-9_]+)/g)].map(match => match[1]))];
  const ids = new Set(priorMessages.map(message => message.id));
  const next = new Map([...acknowledged].filter(([id]) => ids.has(id)));
  for (const message of selected) next.set(message.id, fingerprint(message));
  return { markers, selectedMessageIds: selected.map(message => message.id), acknowledged: next };
}
function auditHistoryInput(reply, events, priorMessages, acknowledged, cold) {
  assert.deepEqual(reply.priorMessages.map(messageProjection), priorMessages.map(messageProjection), 'Pre-send public history joins exact durable chronological prefix');
  const history = events.filter(row => row.type === 'conversationHistory' && row.at <= reply.started).at(-1); assert(history);
  const visible = one(history.payload.conversations.filter(row => row.id === reply.conversationId), 'Actual pre-send history owns this conversation');
  assert.deepEqual(visible.messages.map(messageProjection), priorMessages.map(messageProjection));
  const expected = historyExpectation(priorMessages, reply.prompt, acknowledged, cold);
  assert.deepEqual(reply.request.markers, expected.markers); assert.deepEqual(reply.request.outsideMemoryMarkers, expected.markers); assert.deepEqual(reply.request.memoryMarkers, []);
  return expected;
}
function auditTurn({ fixture, step, reply, events, observations, wire, storedMessage, commands, completedCases, panelIds, model = 'gpt-5.6-sol' }) {
  assert.equal(reply.ordinal, step.ordinal); assert.equal(reply.marker, step.marker); assert.equal(reply.prompt, c.promptFor(step, commands)); assert.deepEqual(reply.commands, commands); assert.equal(reply.scope, step.patch || null);
  assert(Number.isFinite(reply.started) && Number.isFinite(reply.completedAt) && reply.started <= reply.completedAt);
  const interval = events.filter(row => row.at >= reply.started && row.at <= reply.completedAt);
  assert(!interval.some(row => ['error', 'authError', 'requestCancelled', 'autonomousDecision', 'semiAutonomousPlanTimer', 'semiAutonomousQuestionTimer'].includes(row.type)));
  const user = one(interval.filter(row => row.type === 'messageAdded' && row.payload?.role === 'user'), 'One actual user action for the declared task'); assert.equal(user.payload.content, reply.prompt);
  const terminal = one(interval.filter(row => row.type === 'responseComplete'), 'One actual completed response'); assert.equal(terminal.at, reply.completedAt);
  assert.deepEqual(messageProjection(terminal.payload.message), messageProjection(reply.message)); assert.deepEqual(messageProjection(storedMessage), messageProjection(reply.message));
  assert.equal(reply.messageId, reply.message.id); assert.equal(reply.message.role, 'assistant'); assert.equal(reply.message.model, model); assert.equal(reply.message.provider, 'openai-codex');
  assert(reply.message.content.includes(`PB02_DONE:${step.marker}`)); assert(interval.some(row => row.type === 'responseStarted'));
  const input = one(wire.filter(row => row.event === 'request' && row.inputIndex === step.ordinal), 'One bounded actual model request'); assert.deepEqual(reply.request, input);
  assert.equal(input.model, model); assert.equal(input.effort, 'low'); assert(input.outsideMemoryMarkers.includes(step.marker)); assert(reply.started <= input.at && input.at <= reply.completedAt, 'Native request must follow captured send start and precede completed response');
  for (const flag of ['ownedCwd', 'mcpAllDisabled', 'appsAllDisabled', 'appsDefaultDisabled']) assert.equal(input.policy[flag], true);
  assert.equal(input.policy.approvalPolicy, 'untrusted'); assert.equal(input.policy.sandbox, 'read-only'); assert.equal(input.policy.effort, 'low');
  const configuration = wire.filter(row => row.wrapperPid === input.wrapperPid && row.event === 'effective-tool-config' && row.at <= input.at).at(-1); assert(configuration);
  assert.deepEqual(input.policy.mcpNames, configuration.mcpNames); assert.deepEqual(input.policy.appNames, configuration.appNames);
  const session = wire.filter(row => row.wrapperPid === input.wrapperPid && row.event === 'session' && row.at <= input.at).at(-1); assert(session); assert.deepEqual(reply.session, session);
  assert.equal(session.sessionHash, input.sessionHash); assert.equal(session.actualModel, model); assert.equal(session.requestedModel, model);
  assert.equal(session.returnedPolicy.approvalPolicy, 'untrusted'); assert.equal(session.returnedPolicy.sandbox, 'readOnly'); assert.equal(session.returnedPolicy.ownedCwd, true); assert.notEqual(session.returnedPolicy.networkAccess, true);
  const own = wire.filter(row => row.wrapperPid === input.wrapperPid && row.inputIndex === input.inputIndex);
  const begun = one(own.filter(row => row.event === 'turn-started'), 'One real native turn start'), done = one(own.filter(row => row.event === 'turn-completed'), 'One real native turn result');
  assert.equal(done.status, 'completed'); assert.deepEqual(reply.terminal, done); assert.equal(begun.turnHash, done.turnHash); assert(/^[a-f0-9]{64}$/.test(done.turnHash));
  assert.equal(begun.sessionHash, input.sessionHash); assert.equal(done.sessionHash, input.sessionHash); assert(input.at <= begun.at && begun.at <= done.at && done.at <= terminal.at);
  const nativeMessages = own.filter(row => row.event === 'assistant-message');
  for (const row of nativeMessages) { assert.equal(row.sessionHash, input.sessionHash); assert.equal(row.turnHash, begun.turnHash); assert(row.at >= begun.at && row.at <= done.at); }
  const nativeText = joinNativeAssistantMessages(nativeMessages, reply.message.content); assert.deepEqual(reply.nativeText, nativeText);
  const tools = reply.message.toolCalls || [], ids = tools.map(row => row.id); assert.equal(new Set(ids).size, ids.length);
  const nativeTools = own.filter(row => ['tool-start', 'tool-result'].includes(row.event)); assert.deepEqual(reply.nativeTools, nativeTools);
  const verified = tools.map(tool => {
    assert(permittedTool(tool, step, commands, fixture), 'Native action exceeds exact task authority'); assert.notEqual(tool.proposalOnly, true); assert.notEqual(tool.historicalOnly, true);
    const itemIdHash = hash(tool.id), starts = nativeTools.filter(row => row.event === 'tool-start' && row.itemIdHash === itemIdHash);
    assert(starts.length > 0); const result = one(nativeTools.filter(row => row.event === 'tool-result' && row.itemIdHash === itemIdHash), 'One native tool result');
    for (const row of [...starts, result]) { assert.equal(row.sessionHash, input.sessionHash); assert.equal(row.turnHash, begun.turnHash); assert(row.at >= begun.at && row.at <= done.at); }
    assert(starts.every(row => row.at <= result.at && row.type === result.type));
    const live = one(interval.filter(row => row.type === 'toolResult' && row.payload?.id === tool.id), 'One full live tool output').payload;
    for (const field of ['name', 'status', 'input']) assert.deepEqual(live[field], tool[field]);
    const projection = assertToolOutputProjection({ nativeResult: result, liveTool: live, persistedTool: tool });
    const command = String(tool.name).toLowerCase() === 'bash';
    if (command) {
      assert.equal(result.type, 'commandExecution'); assert.equal(result.commandSha256, hash(JSON.stringify(tool.input.command))); assert.equal(result.ownedCwd, true);
      c.assertCommandResult({ step, command: tool.input.command, result, output: live.output, workspace: fixture.workspace });
      assert.equal(tool.status, result.status === 'completed' ? 'completed' : 'failed', 'Public app-server status preserves native item status independently of exit code');
    } else {
      assert.equal(result.type, 'fileChange'); assert.deepEqual(result.changes, tool.input.changes.map(change => ({ relativePath: path.relative(fixture.workspace, path.resolve(fixture.workspace, change.path)), kind: change.kind.type, diffSha256: hash(change.diff) })));
      assert.equal(result.status, 'completed'); assert.equal(tool.status, 'completed');
    }
    return { tool, result, projection, command };
  });
  assert.deepEqual(reply.outputEvidence, verified.map(row => row.projection));
  for (const row of nativeTools) assert(ids.some(id => hash(id) === row.itemIdHash), 'No hidden native start or result');
  for (const event of interval.filter(row => ['toolUse', 'toolResult'].includes(row.type))) assert(ids.includes(event.payload?.id), 'No omitted live tool');
  for (const command of commands) assert.equal(verified.filter(row => row.command && c.exactCommand(row.tool.input.command, command)).length, 1, 'Each required command executes exactly once');
  const cards = interval.filter(row => row.type === 'permissionRequest'), choices = observations.filter(row => row.event === 'permission-decision' && row.marker === step.marker);
  const requests = own.filter(row => row.event === 'approval-request'), responses = own.filter(row => row.event === 'approval-decision');
  assert.equal(new Set(cards.map(row => row.payload.id)).size, cards.length); assert.equal(new Set(choices.map(row => row.id)).size, choices.length);
  const paired = new Set(), pairedResponses = new Set();
  const approvals = cards.map(card => {
    const details = card.payload.details; assert(permittedTool({ name: details.toolName, input: details.toolInput }, step, commands, fixture));
    const request = one(requests.filter(row => !paired.has(row) && row.toolInputSha256 === hash(JSON.stringify(details.toolInput)) && row.at <= card.at), 'Public card joins exact native approval bytes'); paired.add(request);
    assert.equal(request.sessionHash, input.sessionHash); assert.equal(request.turnHash, begun.turnHash);
    const edit = String(details.toolName).toLowerCase() === 'edit', denied = false;
    assert.equal(request.method, edit ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval');
    const choice = one(choices.filter(row => row.id === card.payload.id), 'Exactly one actual public decision'); assert.deepEqual(choice.input, details.toolInput); assert.equal(choice.name, String(details.toolName).toLowerCase());
    assert.equal(choice.approved, !denied); assert.equal(choice.expectedDenial, denied); assert(choice.at >= card.at && choice.at <= reply.completedAt);
    const response = one(responses.filter(row => row.nativeRequestIdHash === request.nativeRequestIdHash), 'One exact native response to the approval'); pairedResponses.add(response);
    assert.equal(response.decision, denied ? 'decline' : 'accept'); assert(response.at >= card.at && response.at <= reply.completedAt);
    const item = one(verified.filter(row => row.result.itemIdHash === request.itemIdHash), 'Approval belongs to its actual item');
    if (edit) assert.deepEqual(item.tool.input.changes, details.toolInput.changes);
    else { assert.equal(item.tool.input.command, details.toolInput.command); assert.equal(item.tool.input.cwd, details.toolInput.cwd); }
    assert(own.indexOf(request) < own.indexOf(response) && own.indexOf(response) < own.indexOf(item.result));
    const afterThisPatch = !!step.patch && verified.some(row => !row.command && row.result.at <= choice.at && own.indexOf(row.result) < own.indexOf(request));
    auditSnapshotEvidence(fixture, choice.beforeFiles, [...completedCases, ...(afterThisPatch ? [step.patch] : [])], panelIds);
    return { id: card.payload.id, nativeRequestIdHash: request.nativeRequestIdHash, itemIdHash: request.itemIdHash, decision: response.decision };
  });
  assert.equal(paired.size, requests.length); assert.equal(pairedResponses.size, responses.length); assert.equal(choices.length, cards.length);
  assert.deepEqual(step, c.buildSteps(fixture.workspace)[step.ordinal - 1], 'Exact workspace-bound command and escalation policy');
  for (const command of step.requiresEscalation) {
    const item = one(verified.filter(row => row.command && c.exactCommand(row.tool.input.command, command)), 'Exactly one explicitly requested write-capable command');
    assert(approvals.some(row => row.itemIdHash === item.result.itemIdHash && row.decision === 'accept'), 'Each declared write-capable command requires its actual public/native approval');
  }
  for (const item of verified.filter(row => !row.command)) assert(approvals.some(row => row.itemIdHash === item.result.itemIdHash), 'Every patch requires actual native approval ownership');
  const nextCompleted = completedCases.slice();
  if (step.patch) { assert.equal(verified.filter(row => !row.command).length, 1); nextCompleted.push(step.patch); }
  auditSnapshotEvidence(fixture, reply.beforeFiles, completedCases, panelIds); auditSnapshotEvidence(fixture, reply.afterFiles, nextCompleted, panelIds);
  if (step.requiresEscalation.length) {
    auditStageBoundary(fixture, reply.beforeBoundary, completedCases, panelIds);
    auditStageBoundary(fixture, reply.afterBoundary, nextCompleted, panelIds);
    assert.deepEqual(reply.beforeBoundary.files, reply.beforeFiles); assert.deepEqual(reply.afterBoundary.files, reply.afterFiles);
    assert.equal(step.ordinal,plan.LINT_ORDINAL); c.assertLintBoundary(reply.beforeBoundary,reply.afterBoundary);
  } else { assert(reply.beforeBoundary == null && reply.afterBoundary == null); }
  return { ordinal: step.ordinal, marker: step.marker, input, user: user.payload, userAt: user.at, message: reply.message, completedAt: reply.completedAt,
    turnHash: begun.turnHash, session, nativeText, approvals, verifiedTools: verified, nextCompleted,
    deliberateFault: null, escalation: { requestedCommands: step.requiresEscalation.slice(), observedSandboxPermissions: 'NOT_OBSERVABLE_IN_RETAINED_APPROVAL_SCHEMA' } };
}
function auditMainProcesses(wire, cleanup, ancestry, live) {
  assert.equal(cleanup.status, 'PASS_OBSERVED_IDENTITIES_EXITED'); assert.deepEqual(cleanup.remaining, []); assert.deepEqual(cleanup.unverifiedLiveReceiptPids, []);
  assert.equal(ancestry.sampleIntervalMs, 250); assert.equal(cleanup.observedIdentityCount, ancestry.processIdentities.length);
  const liveByPid = new Map(live.map(row => [row.pid, row.startedAt]));
  for (const row of ancestry.processIdentities) assert.notEqual(liveByPid.get(row.pid), row.startedAt, 'An observed owned identity remains alive');
  const invocations = wire.filter(row => row.event === 'invocation'); assert(invocations.length); assert.equal(new Set(invocations.map(row => row.wrapperPid)).size, invocations.length);
  assert(!wire.some(row => /refusal|instrumentation-error|launch-error|auxiliary|unexpected-tool|image-view|native-error/.test(row.event)));
  const proofs = invocations.map(invocation => {
    assert(['app-server', 'probe'].includes(invocation.kind)); const probe = invocation.kind === 'probe'; assert.deepEqual(invocation.args, [probe ? '--version' : 'app-server']); assert.equal(invocation.selectedProfile, undefined);
    const rows = wire.filter(row => row.wrapperPid === invocation.wrapperPid);
    if (probe) assert(rows.every(row => ['invocation', 'probe-start', 'stderr-summary', 'probe-exit'].includes(row.event)));
    const start = one(rows.filter(row => row.event === (probe ? 'probe-start' : 'start')), 'Every observed main invocation has one child start'); assert(start.at >= invocation.at);
    assert(Number.isSafeInteger(start.childPid) && start.childPid > 0 && start.childPid !== start.wrapperPid);
    for (const pid of [start.wrapperPid, start.childPid]) if (liveByPid.has(pid)) assert(Date.parse(liveByPid.get(pid)) > start.at, 'Unverified living main receipt PID');
    const summaries = rows.filter(row => row.event === 'stderr-summary'), exits = rows.filter(row => row.event === (probe ? 'probe-exit' : 'exit')); assert(summaries.length <= 1 && exits.length <= 1);
    const summary = summaries[0] || null, exit = exits[0] || null; if (probe) { assert(summary); assert(exit); }
    if (summary) { assert.equal(summary.runtimeOnlyProfileArgument, false); assert(Number.isSafeInteger(summary.bytes) && summary.bytes >= 0); assert(/^[a-f0-9]{64}$/.test(summary.sha256)); if (!summary.bytes) assert.equal(summary.sha256, hash('')); assert(summary.at >= start.at); }
    if (exit) { assert.equal(exit.childPid, start.childPid); assert(exit.at >= start.at); assert(exit.exitCode === null || Number.isInteger(exit.exitCode)); assert(exit.signal === null || /^SIG[A-Z0-9]+$/.test(exit.signal)); assert(exit.exitCode !== null || exit.signal !== null); }
    if (summary && exit) { assert(summary.at <= exit.at); assert(rows.indexOf(summary) < rows.indexOf(exit)); }
    return { wrapperPid: start.wrapperPid, childPid: start.childPid, probe, summary, exit, status: summary && exit ? 'COMPLETE_TERMINAL' : 'PARTIAL_MAIN_SHUTDOWN' };
  });
  for (const row of wire) { assert.equal(row.provider, 'openai-codex'); assert.equal(row.window, 'A'); assert(Number.isFinite(row.at)); assert(invocations.some(value => value.wrapperPid === row.wrapperPid)); }
  return { status: proofs.some(row => row.status === 'PARTIAL_MAIN_SHUTDOWN') ? 'PARTIAL_MAIN_SHUTDOWN' : 'PASS_MAIN_TRANSPORT', processes: proofs };
}
function combineAuxiliaryEvidence(segments, counter, live, temporaryRoot) {
  assert.equal(segments.length, 2); const descriptor = segments[0].manifest.auxiliary;
  const allReceipts = [], identities = [], details = [];
  for (const segment of segments) {
    const own = segment.manifest.auxiliary;
    for (const field of ['provider', 'maxInputs', 'expectedArgs', 'executableIdentity', 'counterFile']) assert.deepEqual(own[field], descriptor[field]);
    const cleanup = segment.cleanup, ancestry = segment.ancestry;
    assert.equal(cleanup.status, 'PASS_OBSERVED_IDENTITIES_EXITED'); assert.deepEqual(cleanup.remaining, []); assert.deepEqual(cleanup.unverifiedLiveReceiptPids, []); assert.deepEqual(cleanup.auxiliaryAccountingErrors, []);
    assert.equal(cleanup.auxiliaryInputs, 0); const count = segment.auxiliaryReceipts.filter(row => row.event === 'auxiliary-input').length;
    assert.equal(cleanup.textAuxiliaryInputs, count); assert.equal(cleanup.combinedAuxiliaryInputs, count);
    assert.equal(ancestry.sampleIntervalMs, 250); assert.equal(cleanup.observedIdentityCount, ancestry.processIdentities.length);
    allReceipts.push(...segment.auxiliaryReceipts); identities.push(...ancestry.processIdentities); details.push(...ancestry.processDetails);
  }
  assert.equal(new Set(identities.map(key)).size, identities.length, 'Exited editor segments cannot reuse a process birth identity');
  const inputs = allReceipts.filter(row => row.event === 'auxiliary-input').length;
  const ancestry = { sampleIntervalMs: 250, processIdentities: identities, processDetails: details };
  const cleanup = { status: 'PASS_OBSERVED_IDENTITIES_EXITED', remaining: [], unverifiedLiveReceiptPids: [], auxiliaryAccountingErrors: [], observedIdentityCount: identities.length,
    textAuxiliaryInputs: inputs, auxiliaryInputs: 0, combinedAuxiliaryInputs: inputs };
  return aux.auditEvidence({ auxiliary: descriptor, receipts: allReceipts, ancestry, cleanup, counter, live, primaryAuxiliaryInputs: 0, temporaryRoot });
}
function auditRestart(first, second) {
  assert.equal(first.manifest.windows.A.profile, second.manifest.windows.A.profile); assert.equal(first.manifest.windows.A.workspace, second.manifest.windows.A.workspace);
  assert.equal(first.exit.code, 0); assert.equal(first.exit.signal, null); assert.equal(first.exit.timedOut, false); assert.equal(first.cleanup.status, 'PASS_OBSERVED_IDENTITIES_EXITED');
  const firstIdentities = new Set(first.ancestry.processIdentities.map(key)); assert(second.ancestry.processIdentities.every(row => !firstIdentities.has(key(row))), 'Second editor launch must have new observed process births');
  const roots = [first, second].map(segment => one(segment.ancestry.processDetails.filter(row => row.executableBasename === 'Code' && !segment.ancestry.processIdentities.some(parent => parent.pid === row.parentPid && parent.startedAt === row.parentStartedAt)), 'One actual root editor identity'));
  assert.notEqual(key(roots[0]), key(roots[1])); assert(Date.parse(roots[1].startedAt) >= Date.parse(first.ancestry.sampledAt) - 1000, 'Replacement editor starts after the old editor cleanup observation');
  const a = first.acceptance, b = second.acceptance; assert.equal(a.conversationId, b.conversationId); assert.notEqual(a.panelId, b.panelId);
  const restored = one(second.observations.filter(row => row.event === 'restart-history-restored'), 'Public saved-conversation selection after actual restart'); assert.equal(restored.conversationId, a.conversationId);
  const history = second.events.filter(row => row.type === 'conversationHistory' && row.at <= restored.at).at(-1); assert(history);
  const saved = one(history.payload.conversations.filter(row => row.id === a.conversationId), 'Restored conversation exists in actual public history');
  assert.deepEqual(saved.messages.map(messageProjection), a.finalConversation.messages.map(messageProjection), 'Exact chronological prior user, assistant and tool projections survive restart');
  assert(second.events.some(row => row.type === 'conversationChanged' && row.payload?.id === a.conversationId && row.at <= restored.at));
  assert(restored.at <= b.replies[0].started); assert.notEqual(a.replies.at(-1).request.sessionHash, b.replies[0].request.sessionHash); assert.equal(b.replies[0].session.method, 'thread/start');
  return { editorExited: true, historyRestored: true, priorMessagesPreserved: true, oldEditor: roots[0], newEditor: roots[1], restoredAt: restored.at,
    nativeHistory: 'RESTORED_PUBLIC_HISTORY_IN_NEW_NATIVE_THREAD' };
}
function qualifyCampaign(turns, restart, mainTransport, auxiliary) {
  assert.equal(turns.length, plan.TURN_COUNT);
  assert.deepEqual(turns.map(row => row.ordinal), Array.from({ length: plan.TURN_COUNT }, (_, i) => i + 1));
  assert(turns.every(row => row.deliberateFault === null), 'No deliberate fault is part of this continuation');
  const qualification = plan.sessionQualification({ startedAt: turns[0].userAt, endedAt: turns.at(-1).completedAt,
    replies: turns.map(row => ({ marker: row.marker, messageId: row.message.id })), restart });
  return { status: 'PARTIAL_F2_WEBHOOK_VERIFICATION_EVIDENCE', mechanical: `PASS_MECHANICAL_${plan.TURN_COUNT}`, session: qualification, mainTransport,
    auxiliary, rootSemanticReview: 'NOT_EVALUATED_BY_MECHANICAL_AUDITOR',
    featureScope: { featureId:c.FEATURE_ID, historicalPatchIds:c.HISTORICAL_PATCH_IDS.slice(),newPatchIds:[], featureCount:1, preservedBugCount:12, ordinaryMistakesCredited:0 },
    ordinaryMistakes: 'NOT_ESTABLISHED_BY_MECHANICAL_EVIDENCE', W: 'NOT_RUN', E: 'NOT_RUN', P: 'NOT_RUN' };
}
function liveIdentities() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,lstart='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/); assert(match); return { pid: +match[1], startedAt: match[2] };
  });
}
function readPriorEvidence(bindingIdentity) {
  assert(bindingIdentity,'Explicit prior native binding required'); pin(bindingIdentity);
  const ready=c.assertNativePreparationReady(bindingIdentity),binding=read(bindingIdentity.path),priorCampaign=read(pin(binding.campaign).path);
  return {bindingIdentity,binding,ready,priorCampaign};
}
function auditPriorCheckpointRecord(campaign,records) {
  const {bindingIdentity,binding,ready,priorCampaign}=records;
  assert.deepEqual(campaign.priorBinding,bindingIdentity); assert.deepEqual(campaign.fixture.priorCheckpoint,bindingIdentity);
  assert.equal(ready.status,'VERIFIED_PARTIAL_NATIVE_PATCH_BINDING');assert.deepEqual(ready.identity,bindingIdentity);
  assert.equal(binding.status,'PARTIAL_SIGNED_WEBHOOK_PATCH_CHECKPOINT_WITH_TIMED_OUT_ORACLE');assert.deepEqual(binding.completedCases,c.INITIAL_CASES);
  assert.equal(campaign.fixture.priorWorkspace,ready.workspace);assert.equal(priorCampaign.workspace,ready.workspace);
  assert.deepEqual(campaign.sourceIdentity,priorCampaign.sourceIdentity);assert.deepEqual(campaign.packageIdentity,priorCampaign.packageIdentity);
  assert.deepEqual(ready.files,binding.sourceSnapshot);assert.equal(campaign.fixture.indexSha256,binding.sourceSnapshot.indexSha256);
  assert.deepEqual(c.expectedSnapshotHashes(campaign.fixture,[]),binding.sourceSnapshot.hashes,'F05 baseline preserves every accepted bug/source/Git byte');
  for(const p of c.PATCHES)assert.equal(binding.sourceSnapshot.hashes[p.path],p.afterSha256);
  assert.deepEqual(binding.completedFeatures,[]);assert.deepEqual(binding.implementedPatchIds,c.HISTORICAL_PATCH_IDS);
  return {binding:bindingIdentity,preservedBugCases:c.INITIAL_CASES.slice(),pendingFeature:c.FEATURE_ID,historicalPatchIds:c.HISTORICAL_PATCH_IDS.slice(),newPatchIds:[],priorCoverage:'Three actual native patch turns with preserved twelve repairs. Historical oracle timeout and strict aggregate failure remain failed; no prior feature acceptance.'};
}
function auditPriorCheckpoint(campaign) {return auditPriorCheckpointRecord(campaign,readPriorEvidence(campaign.priorBinding));}
function auditFeatureReport({campaign,kind,reportPin,lintStep,lintResult,evidenceWindow}) {
  const file=ownedFile(campaign.directory,pin(reportPin).path);assert.equal(file,path.join(campaign.evidenceDirectory,kind,'review.json'));
  const review=read(file);assert.equal(review.schemaVersion,1);assert.equal(review.kind,kind);assert.equal(review.workspace,campaign.workspace);
  const checkpoint=kind==='checkpoint';assert(['checkpoint','validation','final'].includes(kind));
  assert.equal(review.status,'VERIFIED_F05_FUNCTIONAL_REPORTS');assert.deepEqual(review.priorBinding,campaign.priorBinding);
  assert.equal(review.nativeLint,kind==='final'?'JOINED_SEPARATELY_BY_NATIVE_AUDIT':'PENDING');
  const evidenceRoot=path.join(campaign.evidenceDirectory,kind==='final'?'validation':kind);
  for(const child of [review.featureReport,review.bugRegressionReport]) {ownedFile(evidenceRoot,pin(child).path);assert.equal(fs.statSync(child.path).nlink,1);}
  const feature=read(review.featureReport.path),bugRegressions=read(review.bugRegressionReport.path);
  assert.equal(feature.runtime,path.join(campaign.directory,'runtime'));c.contained(evidenceRoot,feature.artifact);c.contained(feature.artifact,review.featureReport.path);
  assert.equal(feature.nativeModelInputs,0);assert.equal(feature.editorLaunches,0);ownedFile(evidenceRoot,pin(feature.scope).path);
  assert(evidenceWindow&&Number.isFinite(evidenceWindow.notBefore)&&Number.isFinite(evidenceWindow.notAfter)&&evidenceWindow.notBefore<=evidenceWindow.notAfter);
  function interval(start,end){const a=Date.parse(start),b=Date.parse(end);assert(Number.isFinite(a)&&Number.isFinite(b));assert(evidenceWindow.notBefore<=a&&a<=b&&b<=evidenceWindow.notAfter,'Real functional checks lie between actual source completion and consuming turn');return [a,b];}
  const [started,finished]=interval(feature.startedAt,feature.finishedAt);
  assert(started<=feature.process.startedAt&&feature.process.startedAt<=feature.process.exitedAt&&feature.process.exitedAt<=feature.receiver.closedAt&&feature.receiver.closedAt<=finished);
  for(const command of bugRegressions.commands)interval(command.startedAt,command.finishedAt);
  interval(bugRegressions.checkedAt,bugRegressions.checkedAt);
  const input={fixture:campaign.fixture,feature,bugRegressions};
  const result=checkpoint?c.assertPositiveEvidence(input):c.assertFeatureEvidence({...input,completedPatchIds:[],lintStep,lintResult});
  const invocation=bounded.assertBoundedInvocation({featurePin:review.featureReport,executionPin:review.oracleInvocation,timingPin:review.phaseTiming,nodeIdentity:campaign.nodeIdentity,evidenceDirectory:evidenceRoot,notBefore:evidenceWindow.notBefore,notAfter:evidenceWindow.notAfter});
  return {kind,review:reportPin,featureReport:review.featureReport,bugRegressionReport:review.bugRegressionReport,oracleInvocation:review.oracleInvocation,phaseTiming:review.phaseTiming,result,invocation,
    lintTiming:kind==='validation'?'Functional report precedes lint; actual later lint joined only by final postrun audit':review.nativeLint};
}

function auditPriorContext(campaign,contextPin,checkpointReview) {
  assert.equal(pin(contextPin).path,path.join(campaign.evidenceDirectory,'checkpoint/prior-context.json'));ownedFile(campaign.directory,contextPin.path);
  const context=read(contextPin.path);assert.equal(context.schemaVersion,1);assert.equal(context.status,'VERIFIED_F05_PARTIAL_PATCH_CONTEXT');assert.equal(context.workspace,campaign.workspace);
  assert.deepEqual(context.priorBinding,campaign.priorBinding);assert.deepEqual(context.checkpointReview,checkpointReview);
  assert.deepEqual(context.completedBugCases,c.INITIAL_CASES);assert.equal(context.featureId,c.FEATURE_ID);assert.deepEqual(context.historicalPatchIds,c.HISTORICAL_PATCH_IDS);assert.deepEqual(context.newPatchIds,[]);assert.deepEqual(context.priorAcceptedFeatures,[]);
  assert.equal(context.indexSha256,campaign.fixture.indexSha256);assert.equal(context.initialSourceDigest,hash(JSON.stringify(c.expectedSnapshotHashes(campaign.fixture,[]))));
  return {context:contextPin,checkpointReview,priorBinding:campaign.priorBinding};
}

function auditFeatureSequence(evidence) {
  assert.deepEqual(evidence.map(row=>row.kind),['checkpoint','validation','final']);
  for(const key of ['featureReport','bugRegressionReport','oracleInvocation','phaseTiming'])assert.deepEqual(evidence[2][key],evidence[1][key],'Final handoff reuses exact accepted gate4 functional evidence; native lint is joined separately');
  assert.deepEqual(evidence[0].result.featureIds,[]);for(const row of evidence.slice(1))assert.deepEqual(row.result.featureIds,[c.FEATURE_ID]);
  return {featureIds:[c.FEATURE_ID],historicalPatchIds:c.HISTORICAL_PATCH_IDS.slice(),newPatchIds:[],preservedBugCount:12};
}

function auditCampaign(directory) {
  assert.equal(fs.realpathSync(directory), directory); c.contained(root, directory);
  const campaignPath = ownedFile(directory, path.join(directory, 'campaign.json')), campaign = read(campaignPath);
  const priorCheckpoint = auditPriorCheckpoint(campaign); auditEvidenceInventory(campaign);
  assert.equal(campaign.schemaVersion, 1); assert.equal(campaign.stage, c.STAGE); assert.equal(campaign.directory, directory); assert.equal(campaign.model, 'gpt-5.6-sol');
  assert.equal(campaign.maxForwardedInputs, c.MAIN_CAP); assert.equal(campaign.maxAuxiliaryInputs, c.HELPER_CAP); assert.equal(campaign.fixture.workspace, campaign.workspace);
  assert.deepEqual(campaign.fixture.commandPolicy, c.buildCommandPolicy(campaign.workspace));
  assert.deepEqual(campaign.commandPolicy, campaign.fixture.commandPolicy); pin(campaign.pythonIdentity);
  const initialPath = ownedFile(directory, path.join(directory, 'initial-boundary.json'));
  assert.equal(pin(campaign.fixture.initialBoundaryIdentity).path, initialPath);
  const initialBoundary = read(initialPath); auditStageBoundary(campaign.fixture, initialBoundary, [], []);
  assert.equal(initialBoundary.buildSnapshot, null); assert.equal(initialBoundary.applicationTemporarySnapshot, null);
  assert(Number.isFinite(campaign.fixture.initialBoundaryMs) && campaign.fixture.initialBoundaryMs >= 0);
  assert.deepEqual(campaign.fixture.dependencyCopies.map(row => path.relative(campaign.workspace, row.target)).sort(), ['client/node_modules', 'node_modules', 'server/node_modules']);
  for (const copy of campaign.fixture.dependencyCopies) {
    c.contained(root, copy.source); assert.equal(fs.realpathSync(copy.source), copy.source);
    assert.equal(copy.copyMode, 'darwin-clonefile-no-fallback'); assert(Number.isSafeInteger(copy.files) && copy.files >= 0); assert(/^[a-f0-9]{64}$/.test(copy.treeSha256));
    const report = read(pin(copy.cloneReport).path); ownedFile(directory, copy.cloneReport.path);
    assert.equal(report.status, 'PASS_PRIVATE_CLONE'); assert.equal(report.source, copy.source); assert.equal(report.destination, copy.target);
    for (const field of ['sourceUnchanged', 'distinctSourceTargetInodes', 'regularFilesNlinkOne', 'exactRelativeSymlinks']) assert.equal(report[field], true);
    assert.equal(report.copyMode, copy.copyMode); assert.equal(report.cloneFlags, 1); assert.equal(report.sourceTreeSha256, report.targetTreeSha256);
    assert.equal(report.helperSha256, c.identity(path.join(__dirname, 'pb02-private-clone.py')).sha256); assert.equal(report.python.executableSha256, c.identity(report.python.executable).sha256);
    assert.equal(report.python.executable, campaign.pythonIdentity.path); assert.equal(report.python.executableSha256, campaign.pythonIdentity.sha256);
    const original = dependencyTree(copy.source, copy.target === path.join(campaign.workspace, 'client/node_modules') ? path.join(copy.source, '.cache') : undefined);
    assert.equal(original.treeSha256, copy.treeSha256, 'Original dependency content outside the exact client cache remains unchanged'); assert.equal(original.files, copy.files);
  }
  for (const file of [campaign.workspace, campaign.evidenceDirectory, campaign.counterFile, campaign.auxiliaryCounterFile]) c.contained(directory, file);
  assert.equal(fs.realpathSync(campaign.workspace), campaign.workspace); assert.equal(fs.realpathSync(campaign.evidenceDirectory), campaign.evidenceDirectory);
  assert(!campaign.evidenceDirectory.startsWith(campaign.workspace + path.sep) && !campaign.workspace.startsWith(campaign.evidenceDirectory + path.sep));
  for (const value of [campaign.sourceIdentity, campaign.packageIdentity, campaign.readiness, campaign.seedReport, campaign.seedManifest, campaign.oracleManifest]) pin(value);
  const source = read(campaign.sourceIdentity.path), pack = read(campaign.packageIdentity.path);
  for (const [relative, expected] of Object.entries({ ...source.files, ...source.testFiles })) { const file = path.resolve(repo, relative); c.contained(repo, file); assert.equal(c.identity(file).sha256, expected); }
  assert.equal(c.identity(path.resolve(repo, pack.archive)).sha256, pack.sha256); assert.equal(pack.sourceSnapshotUnchanged, true); assert.equal(pack.testSnapshotUnchanged, true);
  const readiness = read(campaign.readiness.path); assert.equal(readiness.probes.version.version, 'codex-cli 0.162.0');
  for (const [file, sha256] of [[readiness.entry, readiness.entrySha256], [readiness.node, readiness.nodeSha256], [readiness.binary.path, readiness.binary.sha256]]) pin({ path: file, sha256 });
  const seedRoot = path.dirname(campaign.seedReport.path), seed = read(campaign.seedManifest.path).workspaces['seeded-workspace'];
  for (const [relative, expected] of Object.entries(seed.files)) assert.equal(c.identity(c.exactFile(seed.path, relative)).sha256, expected, 'Original frozen seeded workspace remains untouched');
  for (const [relative, expected] of Object.entries(read(campaign.oracleManifest.path).files)) assert.equal(c.identity(path.join(seedRoot, relative)).sha256, expected, 'Original external oracle/evidence remains untouched');
  assert.equal(pin(campaign.fixture.contract).sha256, c.CONTRACT_SHA); assert.equal(pin(campaign.fixture.publicIssues).sha256, c.PUBLIC_ISSUES_SHA);
  const repairs = c.buildRepairs(campaign.fixture.contract.path, path.join(root, 'overnight-20261011/f2-adapted-baseline/workspace'), seed.path, campaign.fixture.priorWorkspace); assert.deepEqual(campaign.fixture.repairs, repairs);
  assert.equal(campaign.fixture.files[c.NOTE].sha256, campaign.fixture.deniedNote.beforeSha256);
  assert.equal(campaign.fixture.deniedNote.beforeSha256, hash(campaign.fixture.deniedNote.before)); assert.equal(campaign.fixture.deniedNote.afterSha256, hash(campaign.fixture.deniedNote.after));
  const live = liveIdentities(), segments = [];
  for (const index of [1, 2]) {
    const segmentDirectory = path.join(directory, `segment-${index}`), manifestPath = ownedFile(segmentDirectory, path.join(segmentDirectory, 'prepared.json')), manifest = read(manifestPath), owner = manifest.windows.A;
    assert.equal(manifest.stage, c.STAGE); assert.equal(manifest.artifactDir, segmentDirectory); assert.equal(manifest.segment.index, index); assert.deepEqual(Object.keys(manifest.windows), ['A']); assert.equal(manifest.preparedBeforeActivation, true);
    const { identity: campaignIdentity, ...embedded } = manifest.campaign; assert.deepEqual(embedded, campaign); assert.equal(pin(campaignIdentity).path, campaignPath);
    assert.deepEqual(manifest.fixture, campaign.fixture); assert.equal(manifest.model, campaign.model); assert.equal(manifest.maxForwardedInputs, c.MAIN_CAP); assert.equal(manifest.counterFile, campaign.counterFile); assert.equal(manifest.auxiliary.counterFile, campaign.auxiliaryCounterFile);
    assert.equal(owner.workspace, campaign.workspace); assert.equal(owner.profile, campaign.profile); assert.equal(owner.sharedDataDir, campaign.sharedDataDir); c.contained(segmentDirectory, owner.directory);
    const pins = [...manifest.harnessDependencyIdentities, ...manifest.wrapperIdentities, ...Object.values(manifest.executableIdentities), manifest.nodeIdentity, manifest.sourceIdentity, manifest.packageIdentity, manifest.readiness, manifest.auxiliary.flagEvidenceIdentity]; pins.forEach(pin);
    auditAuditorProvenance(pins); auditFeatureDependencies(campaign,pins); assert(pins.some(value => value.path === require.resolve('./codex-f2-webhook-verification-auxiliary.cjs')));
    assert.deepEqual(manifest.sourceIdentity, campaign.sourceIdentity); assert.deepEqual(manifest.packageIdentity, campaign.packageIdentity);
    for (const extension of [manifest.sourcePackage, owner.installedExtension]) { assert.equal(c.identity(path.join(extension, 'dist/extension.js')).sha256, manifest.bundleSha256); assert.equal(c.identity(path.join(extension, 'media/chat/chat.js')).sha256, manifest.chatSha256); }
    assert.equal(manifest.bundleSha256, pack.bundleSha256); assert.equal(manifest.chatSha256, pack.chatSha256);
    const file = relative => ownedFile(owner.directory, path.join(owner.directory, relative));
    const acceptance = read(file('acceptance.json')), events = read(file('events.json')), observations = read(file('observations.json'));
    assert.equal(acceptance.status, 'CAPTURED_F2_SEGMENT'); assert.equal(acceptance.stage, c.STAGE); assert.equal(acceptance.segment, index); assert.deepEqual(acceptance.observations, observations);
    assert.deepEqual(acceptance.replies.map(row => row.ordinal), c.buildSteps(campaign.workspace).filter(row => row.segment === index).map(row => row.ordinal));
    assert.equal(new Set(acceptance.panelIds).size, acceptance.panelIds.length); assert.equal(acceptance.panelIds.length, index); assert.equal(acceptance.panelId, acceptance.panelIds.at(-1));
    assert(events.some(row => row.type === 'initialState' && row.payload?.panelId === acceptance.panelId));
    const wire = owner.receiptPaths.flatMap(value => receipts(ownedFile(owner.directory, value))), auxiliaryReceipts = owner.auxiliaryReceiptPaths.flatMap(value => receipts(ownedFile(owner.directory, value)));
    const ancestry = read(file('process-ancestry.json')), cleanup = read(file('editor-exit-process-check.json')), exit = read(file('editor-exit.json'));
    assert.equal(read(ownedFile(segmentDirectory, path.join(segmentDirectory, 'native-result.json'))).status, 'PASS');
    assert.equal(exit.code, 0); assert.equal(exit.signal, null); assert.equal(exit.timedOut, false); assert.equal(exit.helper.failures, 0); assert.equal(exit.helper.normalQuitRequested, true); assert.deepEqual(exit.cleanup, cleanup);
    assert.equal(cleanup.conversationalInputs, c.buildSteps(campaign.workspace).filter(row => row.segment === index).length);
    for (const relative of ['watchdog-failure.json', 'driver-fatal.json', 'window-A/forced-cleanup.json', 'window-A/driver-error.json', 'window-A/partial.json']) assert(!fs.existsSync(path.join(segmentDirectory, relative)), 'Failed run artifacts cannot become a mechanically successful campaign');
    const launch = read(file('launch.json')), reservation = read(ownedFile(segmentDirectory, path.join(segmentDirectory, 'launch-reservation.json')));
    assert.equal(launch.extensionTestsPathUsed, false); assert.equal(launch.profile, owner.profile); assert.equal(launch.installedExtension, owner.installedExtension);
    for (const argument of [owner.workspace, `--user-data-dir=${owner.profile}`, `--extensions-dir=${owner.extensionsDir}`]) assert(launch.args.includes(argument)); assert(!launch.args.some(value => /extensionTestsPath/i.test(value)));
    assert.equal(reservation.plannedConversationRequests, c.buildSteps(campaign.workspace).filter(row => row.segment === index).length); assert.equal(reservation.maxTextAuxiliaryInputs, c.HELPER_CAP);
    assert.equal(reservation.harnessSha256, c.identity(path.join(manifest.compiledDirectory, 'codex-f2-webhook-verification.test.js')).sha256); assert.equal(reservation.observerSha256, c.identity(path.join(manifest.compiledDirectory, 'codex-f2-webhook-verification-observer.js')).sha256);
    const mainTransport = auditMainProcesses(wire, cleanup, ancestry, live);
    for (const reply of acceptance.replies) assert.deepEqual(read(file(`reply-${String(reply.ordinal).padStart(2, '0')}.json`)), reply);
    segments.push({ manifest, acceptance, events, observations, wire, auxiliaryReceipts, ancestry, cleanup, exit, mainTransport, pins, acceptancePath: file('acceptance.json'), exitPath: file('editor-exit.json') });
  }
  assert.equal(pin(segments[1].manifest.segment.priorAcceptance).path, segments[0].acceptancePath); assert.equal(pin(segments[1].manifest.segment.priorEditorExit).path, segments[0].exitPath);
  assert.deepEqual(segments[1].acceptance.priorAcceptance, segments[1].manifest.segment.priorAcceptance);
  const stored = readStoredConversations(segments[1].manifest.windows.A), conversation = one(stored.conversations.filter(row => row.id === segments[0].acceptance.conversationId), 'One actual final durable F2 conversation');
  assert(stored.conversations.filter(row => row.id !== conversation.id).every(row => row.messages.length === 0), 'No foreign durable work in the owned profile');
  assert.equal(conversation.messages.length, plan.TURN_COUNT * 2); assert.equal(new Set(conversation.messages.map(row => row.id)).size, plan.TURN_COUNT * 2);
  assert.deepEqual(conversation.messages.map(messageProjection), segments[1].acceptance.finalConversation.messages.map(messageProjection));
  const steps = c.buildSteps(campaign.workspace), turns = [], boundaries = [initialBoundary]; let completedCases = [], previousCompletedAt = -Infinity;
  for (const segment of segments) {
    let acknowledged = new Map(); const first = segment.acceptance.replies[0].ordinal;
    const boundaryLabels = [];
    const joinBoundaryRecord = (label, snapshot, earliest, latest) => {
      boundaryLabels.push(label); const recordPath = ownedFile(segment.manifest.windows.A.directory, path.join(segment.manifest.windows.A.directory, `boundary-${label}.json`));
      auditBoundaryRecord(label, snapshot, read(recordPath), one(segment.observations.filter(row => row.event === 'boundary' && row.label === label), 'One actual boundary observation'), earliest, latest);
    };
    for (const reply of segment.acceptance.replies) {
      assert(reply.started > previousCompletedAt); const step = steps[reply.ordinal - 1]; assert.equal(step.segment, segment.manifest.segment.index);
      assert.equal(reply.panelId, segment.acceptance.panelId); assert.equal(reply.conversationId, conversation.id);
      let commands = step.commands;
      if (step.evidence) {
        assert(reply.evidence); const gateFile = path.join(directory, 'gates', `${step.evidence}.json`); assert.equal(pin(reply.evidence.gateIdentity).path, ownedFile(directory, gateFile));
        const { gateIdentity, ...gate } = reply.evidence; assert.deepEqual(read(gateFile), gate);
        commands = [...commands, ...c.evidenceForStep(step, gate, campaign.evidenceDirectory, campaign.workspace, campaign.evidenceFiles[step.evidence])];
        const observed = one(segment.observations.filter(row => row.event === 'external-evidence-reviewed' && row.marker === step.marker), 'Reviewed real report precedes its consuming turn');
        assert.deepEqual(observed.evidence, gate); assert.deepEqual(observed.gateIdentity, gateIdentity); assert(observed.at <= reply.started);

      } else assert.equal(reply.evidence, null);
      const message = conversation.messages[(reply.ordinal - 1) * 2 + 1];
      const turn = auditTurn({ fixture: campaign.fixture, step, reply, events: segment.events, observations: segment.observations, wire: segment.wire, storedMessage: message, commands, completedCases, panelIds: segment.acceptance.panelIds, model: campaign.model });
      assert.deepEqual(messageProjection(conversation.messages[(reply.ordinal - 1) * 2]), messageProjection(turn.user));
      const expected = auditHistoryInput(reply, segment.events, conversation.messages.slice(0, (reply.ordinal - 1) * 2), acknowledged, reply.ordinal === first);
      acknowledged = expected.acknowledged; turn.historyMessageIds = expected.selectedMessageIds;
      if (reply.ordinal === first) assert.equal(turn.session.method, 'thread/start'); else assert.equal(turn.input.sessionHash, turns.at(-1).input.sessionHash);
      completedCases = turn.nextCompleted; previousCompletedAt = reply.completedAt; turns.push(turn);
      if (step.requiresEscalation.length) {
        boundaries.push(reply.beforeBoundary, reply.afterBoundary);
        joinBoundaryRecord(`before-${reply.ordinal}`, reply.beforeBoundary, -Infinity, reply.started);
        joinBoundaryRecord(`after-${reply.ordinal}`, reply.afterBoundary, reply.completedAt, Infinity);
      }
    }
    assert.deepEqual(segment.acceptance.completedCases, completedCases); auditSnapshotEvidence(campaign.fixture, segment.acceptance.files, completedCases, segment.acceptance.panelIds);
    auditStageBoundary(campaign.fixture, segment.acceptance.finalBoundary, completedCases, segment.acceptance.panelIds);
    assert.deepEqual(segment.acceptance.finalBoundary.files, segment.acceptance.files); boundaries.push(segment.acceptance.finalBoundary);
    joinBoundaryRecord('final', segment.acceptance.finalBoundary, segment.acceptance.replies.at(-1).completedAt, segment.acceptance.at);
    assert.deepEqual(segment.observations.filter(row => row.event === 'boundary').map(row => row.label).sort(), boundaryLabels.sort());
    const n = segment.acceptance.replies.at(-1).ordinal;
    assert.deepEqual(segment.acceptance.finalConversation.messages.map(messageProjection), conversation.messages.slice(0, n * 2).map(messageProjection));
    const expectedUsers = segment.acceptance.replies.map(row => conversation.messages[(row.ordinal - 1) * 2]);
    assert.deepEqual(segment.events.filter(row => row.type === 'messageAdded' && row.payload?.role === 'user').map(row => messageProjection(row.payload)), expectedUsers.map(messageProjection));
    assert.deepEqual(segment.events.filter(row => row.type === 'responseComplete').map(row => row.payload.message.id), segment.acceptance.replies.map(row => row.messageId));
  }
  const allInputs = segments.flatMap(segment => segment.wire.filter(row => row.event === 'request')); assert.deepEqual(allInputs.map(row => row.inputIndex), Array.from({ length: plan.TURN_COUNT }, (_, i) => i + 1));
  assert.equal(new Set(turns.map(row => row.turnHash)).size, plan.TURN_COUNT); assert.deepEqual(completedCases, c.SELECTED);
  const allReplies=segments.flatMap(segment=>segment.acceptance.replies),lintReply=one(allReplies.filter(reply=>reply.ordinal===plan.LINT_ORDINAL),'Exactly one actual native server lint turn');
  const lintResults=lintReply.nativeTools.filter(row=>row.event==='tool-result'&&row.type==='commandExecution');
  const lintResult=one(lintResults,'Exactly one server lint command result'),lintStep=steps[plan.LINT_ORDINAL-1];
  assert.equal(lintResult.commandSha256,hash(JSON.stringify(lintStep.commands[0])));c.assertCommandResult({step:lintStep,result:lintResult});
  const featureEvidence=['checkpoint','validation','final'].map(kind=>{const reply=one(allReplies.filter(reply=>steps[reply.ordinal-1].evidence===kind),'One consuming feature evidence turn');
    if(kind==='validation')assert(reply.completedAt<lintReply.started);if(kind==='final')assert(lintReply.completedAt<reply.started);
    const sourceReply=one(allReplies.filter(row=>row.ordinal===3),'Read-only restart checkpoint'),validationReply=one(allReplies.filter(row=>row.ordinal===4),'Functional validation consumer');
    const evidenceWindow=kind==='checkpoint'?{notBefore:campaign.createdAt,notAfter:reply.started}:{notBefore:sourceReply.completedAt,notAfter:validationReply.started};
    return auditFeatureReport({campaign,kind,reportPin:reply.evidence.files[0],lintStep,lintResult,evidenceWindow});});
  auditFeatureSequence(featureEvidence);
  const checkpointReply=one(allReplies.filter(reply=>reply.ordinal===1),'One checkpoint consumer'),priorContext=auditPriorContext(campaign,checkpointReply.evidence.files[1],featureEvidence[0].review);
  assert.deepEqual(read(campaign.counterFile), { forwardedInputs: plan.TURN_COUNT, maxInputs: c.MAIN_CAP }); assert(!fs.existsSync(campaign.counterFile + '.lock')); assert(!fs.existsSync(campaign.auxiliaryCounterFile + '.lock'));
  const restart = auditRestart(segments[0], segments[1]);
  const workspace = c.verifySnapshot(campaign.fixture, completedCases, segments[1].acceptance.panelIds); assert.deepEqual(workspace, segments[1].acceptance.files);
  const finalBoundary = c.verifyBoundary(campaign.fixture, completedCases, segments[1].acceptance.panelIds);
  assert.deepEqual(finalBoundary, segments[1].acceptance.finalBoundary); const commandNetwork = auditNpmLogHistory(campaign.fixture, boundaries, finalBoundary);
  const settings = read(path.join(campaign.profile, 'User/settings.json')), finalOwner = segments[1].manifest.windows.A;
  assert.equal(settings['mysti.codexPath'], finalOwner.wrappers['openai-codex']); assert.equal(settings['mysti.claudeCodePath'], segments[1].manifest.auxiliary.launcher);
  assert.equal(settings['mysti.codexProfile'], ''); assert.equal(settings['mysti.defaultEffortLevel'], 'low'); assert.equal(settings['mysti.defaultMode'], 'ask-before-edit'); assert.equal(settings['mysti.autoContext'], false);
  const auxiliary = combineAuxiliaryEvidence(segments, read(campaign.auxiliaryCounterFile), live, fs.realpathSync(os.tmpdir()));
  const mainTransport = { status: segments.some(segment => segment.mainTransport.status === 'PARTIAL_MAIN_SHUTDOWN') ? 'PARTIAL_MAIN_SHUTDOWN' : 'PASS_MAIN_TRANSPORT', segments: segments.map(segment => segment.mainTransport) };
  const qualification = qualifyCampaign(turns, restart, mainTransport, auxiliary);
  return { ...qualification, stage: c.STAGE, checkedAt: new Date().toISOString(), auditor: c.identity(__filename), auditProvenance: auditAuditorProvenance(segments[0].pins), campaign: c.identity(campaignPath), priorCheckpoint, priorContext, featureEvidence, restart, workspace, finalBoundary, commandNetwork,
    counts: { publicAttempts: plan.TURN_COUNT, completedReplies: plan.TURN_COUNT, mainInputs: plan.TURN_COUNT, mainCap: c.MAIN_CAP, mainLaneAuxiliaryInputs: 0, helperInputs: auxiliary.counts.submitted, helperCap: c.HELPER_CAP },
    turns: turns.map(turn => ({ ordinal: turn.ordinal, marker: turn.marker, userId: turn.user.id, messageId: turn.message.id, userAt: turn.userAt, completedAt: turn.completedAt, sessionHash: turn.input.sessionHash, turnHash: turn.turnHash,
      approvals: turn.approvals, toolOutputs: turn.verifiedTools.map(row => row.projection), historyMessageIds: turn.historyMessageIds, deliberateFault: turn.deliberateFault, escalation: turn.escalation })),
    evidence: segments.flatMap(segment => [c.identity(segment.acceptancePath), c.identity(segment.exitPath), ...segment.pins]),
    limitations: ['This auditor and its feature dependencies must match their actual prelaunch manifest pins; older campaigns remain separate evidence.', 'Mechanical joins do not establish useful-work semantics; root semantic review remains independent.', 'Two historical file approvals represent one F05 feature; this successor authorizes zero new patches; all twelve prior bugs and five other pending features remain separate coverage.', 'Missing main terminal metadata remains unknown despite verified observed-process exit.', 'Helper transport accounting does not establish title/classification/suggestion quality.', 'Explicit escalation intent and accepted commands do not expose hidden model sandbox-permission arguments.', 'No retained npm HTTP fetch record is bounded log evidence, not universal network observation.'] };
}
module.exports = { API_EVIDENCE:apiReadiness.API_EVIDENCE, auditEvidenceInventory, featureDependencies, auditFeatureDependencies, auditFeatureReport, auditFeatureSequence, auditPriorContext, readPriorEvidence, auditPriorCheckpoint, auditPriorCheckpointRecord, auditAuditorProvenance, auditCampaign, auditTurn, auditSnapshotEvidence, auditMainProcesses, auditRestart, combineAuxiliaryEvidence, qualifyCampaign, historyExpectation, auditHistoryInput, permittedTool, auditGeneratedFiles, auditBoundary, auditStageBoundary, auditNpmLogHistory, auditBoundaryRecord };
if (require.main === module) {
  const directory = path.resolve(process.argv[2] || process.env.MYSTI_PB02_F2_WEBHOOK_VERIFICATION_CAMPAIGN_DIR || ''); c.contained(root, directory);
  const target = path.join(directory, `independent-f2-webhook-verification-audit-${Date.now()}.json`);
  try { const result = auditCampaign(directory); compact.writeJson(target, result); console.log(JSON.stringify({ path: target, status: result.status, mechanical: result.mechanical, counts: result.counts })); }
  catch (error) { fs.writeFileSync(target, JSON.stringify({ status: 'FAIL', at: new Date().toISOString(), auditor: c.identity(__filename), auditProvenance: { kind: 'PRELAUNCH_PINNED_F05_REVIEW', verificationIncomplete: true }, error: { name: error.name, message: error.message } }, null, 2) + '\n', { flag: 'wx' }); console.error(error.stack); process.exitCode = 1; }
}
