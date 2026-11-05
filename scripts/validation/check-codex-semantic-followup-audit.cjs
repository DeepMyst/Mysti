/* Synthetic two-reply transcript and approval controls. No editor or inference. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const audit = require('./audit-vscode-codex-semantic-followup.cjs');
const { assertToolOutputProjection } = require('./codex-full-oracle.cjs');
const sha = value => createHash('sha256').update(value).digest('hex'), clone = value => structuredClone(value);
const directory = fs.mkdtempSync(path.resolve(__dirname, '../../out-test/feature-tests/PB-02/codex-semantic-followup-audit-controls-'));
const checks = []; let fixtureIndex = 0;
function check(name, action) {
  try { action(); checks.push({ name, status: 'PASS' }); }
  catch (error) { checks.push({ name, status: 'FAIL', error: { name: error.name, message: error.message } }); }
}
function fixture(withApproval = false) {
  const owned = path.join(directory, `case-${++fixtureIndex}`); fs.mkdirSync(owned);
  const owner = { directory: owned, workspace: path.join(owned, 'workspace') };
  const model = 'gpt-5.6-sol', panelId = 'semantic-panel', conversationId = 'semantic-conversation';
  const files = Object.fromEntries(['README.md', 'src/retry.cjs', 'attachments/brief.txt'].map(name => [name, { sha256: sha(name), bytes: name.length }]));
  const snapshot = { hashes: Object.fromEntries(Object.entries(files).map(([key, value]) => [key, value.sha256])) };
  const sessionHash = sha('fresh-thread'), wrapperPid = 4242;
  const session = { event: 'session', at: 90, wrapperPid, method: 'thread/start', sessionHash, requestedModel: model, actualModel: model, modelProvider: 'openai',
    returnedPolicy: { approvalPolicy: 'untrusted', sandbox: 'readOnly', networkAccess: false, ownedCwd: true } };
  const common = { owner, manifest: { model, fixture: { files } }, inputs: [], receipts: [
    { event: 'effective-tool-config', at: 80, wrapperPid, mcpNames: [], appNames: [] }, session,
  ] };
  const events = [{ type: 'initialState', at: 50, payload: { panelId } }], observations = [], replies = [], messages = [];
  for (const [index, marker] of audit.expected.entries()) {
    const started = 100 + index * 100, completedAt = started + 40, inputIndex = index + 1, turnHash = sha(`turn-${index}`);
    const input = { event: 'request', at: started + 10, wrapperPid, inputIndex, sessionHash, model, effort: 'low', outsideMemoryMarkers: audit.expected.slice(0, index + 1),
      policy: { approvalPolicy: 'untrusted', sandbox: 'read-only', ownedCwd: true, effort: 'low', mcpAllDisabled: true, appsAllDisabled: true, appsDefaultDisabled: true, mcpNames: [], appNames: [] } };
    common.inputs.push(input); common.receipts.push(input);
    common.receipts.push({ event: 'turn-started', at: started + 11, wrapperPid, inputIndex, sessionHash, turnHash });
    const user = { id: `user-${index}`, role: 'user', content: `PB02_REQUEST:${marker} Synthetic source review.`, timestamp: started };
    messages.push(user); events.push({ type: 'messageAdded', at: started, payload: clone(user) }, { type: 'responseStarted', at: started + 5, payload: {} });
    const tools = [], toolOutputEvidence = [], permissionDecisionIds = [], nativeTools = [];
    if (index === 0) {
      const output = 'Owned synthetic source read: مرحبا • café • € • 😀\n'.repeat(150) + 'Default cap 1000 ms; attachment budget 1500 ms.\n';
      const live = { id: 'read-item', name: 'Bash', status: 'completed', input: { command: ['/bin/zsh', '-lc', audit.scopes[marker].commands[0]], cwd: owner.workspace }, output };
      const persisted = clone(live); persisted.output = output.slice(0, 4096); persisted.truncated = true;
      const start = { event: 'tool-start', at: started + 12, wrapperPid, inputIndex, sessionHash, turnHash, itemIdHash: sha(live.id), type: 'commandExecution' };
      const result = { ...start, event: 'tool-result', at: started + 30, status: 'completed', exitCode: 0, commandSha256: sha(JSON.stringify(live.input.command)), ownedCwd: true, outputSha256: sha(output) };
      common.receipts.push(start);
      if (withApproval) {
        const id = 'approval-card', details = { toolName: 'Bash', toolInput: clone(live.input) }, inputSha256 = sha(JSON.stringify(details.toolInput));
        const request = { event: 'approval-request', at: started + 14, wrapperPid, inputIndex, sessionHash, turnHash, itemIdHash: start.itemIdHash,
          method: 'item/commandExecution/requestApproval', toolInputSha256: inputSha256, nativeRequestIdHash: sha('approval-id') };
        common.receipts.push(request, { event: 'approval-decision', at: started + 20, wrapperPid, inputIndex, nativeRequestIdHash: request.nativeRequestIdHash, decision: 'accept' });
        events.push({ type: 'permissionRequest', at: started + 15, payload: { id, details } });
        observations.push({ event: 'permission-decision', at: started + 21, id, name: 'bash', input: clone(live.input), inputSha256,
          approved: true, expectedDenial: false, beforeFiles: clone(snapshot) });
        permissionDecisionIds.push(id);
      }
      common.receipts.push(result); nativeTools.push(start, result); tools.push(persisted);
      events.push({ type: 'toolResult', at: started + 31, payload: live });
      toolOutputEvidence.push(assertToolOutputProjection({ nativeResult: result, liveTool: live, persistedTool: persisted }));
    }
    const turnCompleted = { event: 'turn-completed', at: started + 35, wrapperPid, inputIndex, sessionHash, turnHash, status: 'completed' };
    common.receipts.push(turnCompleted);
    const message = { id: `reply-${index}`, role: 'assistant', provider: 'openai-codex', model, content: `Synthetic explanation; root semantic review remains required. PB02_DONE:${marker}`, toolCalls: clone(tools), timestamp: completedAt };
    messages.push(message); events.push({ type: 'responseComplete', at: completedAt, payload: { message: clone(message) } });
    const reply = { ordinal: index + 1, marker, panelId, conversationId, messageId: message.id, provider: 'openai-codex', model, content: message.content,
      tools, toolOutputEvidence, request: clone(input), nativeSession: clone(session), started, completedAt, turnCompleted: clone(turnCompleted), nativeTools: clone(nativeTools), scope: clone(audit.scopes[marker]), beforeFiles: clone(snapshot), permissionDecisionIds };
    replies.push(reply); observations.push({ event: 'native-response', ...clone(reply), afterFiles: clone(snapshot) });
  }
  const conversation = { id: conversationId, messages };
  const acceptance = { stage: 'SEMANTIC_FOLLOWUP_2', status: 'PASS_SEMANTIC_FOLLOWUP_TRANSPORT', sourceId: conversationId, panelId, replies,
    finalConversation: clone(conversation), counts: { completedTurns: 2, conversationalInputs: 2, auxiliaryInputs: 0 }, semanticReview: 'ROOT_INDEPENDENT_REVIEW_REQUIRED' };
  return { common, acceptance, stored: { conversations: [clone(conversation)] }, events, observations };
}
function seal(value) {
  fs.writeFileSync(path.join(value.common.owner.directory, 'events-main.json'), JSON.stringify(value.events), { flag: 'wx' });
  fs.writeFileSync(path.join(value.common.owner.directory, 'observations.json'), JSON.stringify(value.observations), { flag: 'wx' });
}
function verify(value) {
  const journey = audit.auditJourney(value.common, value.acceptance, value.stored);
  return { journey, permissions: audit.auditPermissions(value.common, value.acceptance, journey) };
}
function control(name, mutate, accepts = false, approval = false) {
  check(name, () => { const value = fixture(approval); mutate?.(value); seal(value); if (accepts) assert.equal(verify(value).journey.proofs.length, 2); else assert.throws(() => verify(value)); });
}
control('Two exact read-only replies join native, live and durable evidence without claiming semantic correctness', undefined, true);
control('An exact actual command permission is joined through its native response and result', undefined, true, true);
for (const [name, mutate] of [
  ['Wrong reply markers are rejected', v => { v.acceptance.replies[1].marker = 'OTHER'; }],
  ['Wrong stage is rejected', v => { v.acceptance.stage = 'FULL_25_ACCEPTANCE'; }],
  ['Mechanical status cannot claim semantic success', v => { v.acceptance.status = 'PASS_Q05_RESOLVED'; }],
  ['Root semantic review cannot be skipped', v => { v.acceptance.semanticReview = 'PASS'; }],
  ['Wrong completion count is rejected', v => { v.acceptance.counts.completedTurns = 1; }],
  ['Wrong request count is rejected', v => { v.acceptance.counts.conversationalInputs = 3; }],
  ['Helpers cannot be mislabeled as main-lane auxiliary inputs', v => { v.acceptance.counts.auxiliaryInputs = 3; }],
  ['Wrong public panel is rejected', v => { v.events[0].payload.panelId = 'foreign'; }],
  ['Wrong durable conversation is rejected', v => { v.stored.conversations[0].id = 'foreign'; }],
  ['Duplicate stored message IDs are rejected', v => { v.stored.conversations[0].messages.push(clone(v.stored.conversations[0].messages[0])); }],
  ['A foreign populated conversation is rejected', v => { v.stored.conversations.push({ id: 'foreign', messages: [{ role: 'user', content: 'hidden' }] }); }],
  ['Missing actual user event is rejected', v => { v.events = v.events.filter(e => !(e.type === 'messageAdded' && e.payload.id === 'user-0')); }],
  ['Changed actual user text cannot hide behind correct stored text', v => { v.events.find(e => e.type === 'messageAdded').payload.content = 'foreign input'; }],
  ['Wrong reply model is rejected', v => { v.acceptance.replies[0].model = 'other-model'; }],
  ['Wrong native requested model is rejected', v => { v.common.receipts.find(e => e.event === 'session').requestedModel = 'other-model'; }],
  ['Wrong native returned model is rejected', v => { v.common.receipts.find(e => e.event === 'session').actualModel = 'other-model'; }],
  ['Existing resumed thread cannot masquerade as fresh first thread', v => { v.common.receipts.find(e => e.event === 'session').method = 'thread/resume'; }],
  ['Missing effective tool configuration is rejected', v => { v.common.receipts = v.common.receipts.filter(e => e.event !== 'effective-tool-config'); }],
  ['Wrong turn policy is rejected', v => { v.common.inputs[0].policy.approvalPolicy = 'never'; }],
  ['Enabled external tools are rejected', v => { v.common.inputs[0].policy.mcpAllDisabled = false; }],
  ['Wrong reasoning effort is rejected', v => { v.common.inputs[0].effort = 'high'; }],
  ['Future request markers cannot leak into first reply', v => { v.common.inputs[0].outsideMemoryMarkers.push('TRANSFER_AND_EVIDENCE'); }],
  ['Unrequested extra scope is rejected', v => { v.acceptance.replies[1].scope.commands = ['cat src/retry.cjs']; }],
  ['Missing actual completion is rejected', v => { v.events = v.events.filter(e => !(e.type === 'responseComplete' && e.payload.message.id === 'reply-0')); }],
  ['Duplicate actual completion is rejected', v => { v.events.push(clone(v.events.find(e => e.type === 'responseComplete'))); }],
  ['Stored assistant text cannot differ from actual public terminal', v => { v.stored.conversations[0].messages.find(m => m.id === 'reply-0').content = 'changed'; }],
  ['Error within a supposedly successful reply is rejected', v => { v.events.push({ type: 'error', at: 125, payload: { message: 'failed' } }); }],
  ['Missing saved observation is rejected', v => { v.observations.pop(); }],
  ['Changed saved source after reply is rejected', v => { v.observations[0].afterFiles.hashes['src/retry.cjs'] = sha('changed'); }],
  ['Missing native completion is rejected', v => { v.common.receipts = v.common.receipts.filter(e => !(e.event === 'turn-completed' && e.inputIndex === 2)); }],
  ['Failed native completion is rejected', v => { v.common.receipts.find(e => e.event === 'turn-completed').status = 'failed'; }],
  ['Unreported native tool result is rejected', v => { v.common.receipts.splice(4, 0, { ...clone(v.common.receipts.find(e => e.event === 'tool-result')), itemIdHash: sha('hidden') }); }],
  ['Late native tool items cannot disappear after the final public completion', v => { v.common.receipts.push({ ...clone(v.common.receipts.find(e => e.event === 'tool-result')), at: 250 }); }],
  ['An extra late native turn start is rejected', v => { v.common.receipts.push({ ...clone(v.common.receipts.find(e => e.event === 'turn-started')), at: 250 }); }],
  ['An extra late native turn completion is rejected', v => { v.common.receipts.push({ ...clone(v.common.receipts.find(e => e.event === 'turn-completed')), at: 250 }); }],
  ['Unsupported native tool item is rejected', v => { v.common.receipts.push({ event: 'unexpected-tool-item' }); }],
]) control(name, mutate);
for (const [name, mutate] of [
  ['Missing actual command approval request is rejected', v => { v.common.receipts = v.common.receipts.filter(e => e.event !== 'approval-request'); }],
  ['Missing actual approval response is rejected', v => { v.common.receipts = v.common.receipts.filter(e => e.event !== 'approval-decision'); }],
  ['Approval response cannot change native request ownership', v => { v.common.receipts.find(e => e.event === 'approval-decision').nativeRequestIdHash = sha('foreign'); }],
  ['Approval decision cannot claim a decline was accepted', v => { v.common.receipts.find(e => e.event === 'approval-decision').decision = 'decline'; }],
  ['An approval cannot authorize a different tool input', v => { v.observations.find(e => e.event === 'permission-decision').input.command = ['rm', 'source']; }],
  ['Approval before-source snapshot must remain exact', v => { v.observations.find(e => e.event === 'permission-decision').beforeFiles.hashes['src/retry.cjs'] = sha('changed'); }],
  ['Detached harness decisions are rejected', v => { v.observations.push({ ...clone(v.observations[0]), id: 'detached' }); }],
  ['Wrong native approval method is rejected', v => { v.common.receipts.find(e => e.event === 'approval-request').method = 'item/fileChange/requestApproval'; }],
]) control(name, mutate, false, true);

// Exercise the exact native/live/persisted-output verifier used by auditJourney.
function toolFixture(output = 'Owned exact source read\n') {
  const workspace = '/owned';
  const live = { id: 'actual-item', name: 'Bash', status: 'completed', input: { cwd: workspace, command: ['/bin/zsh', '-lc', audit.scopes.CORRECT_BUDGET_CAP.commands[0]] }, output };
  const persisted = clone(live); if (output.length > 4096) { persisted.output = output.slice(0, 4096); persisted.truncated = true; }
  const input = { inputIndex: 1, sessionHash: sha('thread') }, turnHash = sha('turn');
  const start = { event: 'tool-start', itemIdHash: sha(live.id), sessionHash: input.sessionHash, turnHash, inputIndex: 1, type: 'commandExecution' };
  const result = { ...start, event: 'tool-result', status: 'completed', exitCode: 0, ownedCwd: true, commandSha256: sha(JSON.stringify(live.input.command)), outputSha256: sha(output) };
  return { common: { owner: { workspace } }, input, turnHash, tools: [persisted], wire: [start, result], scope: clone(audit.scopes.CORRECT_BUDGET_CAP), events: [{ type: 'toolResult', payload: live }] };
}
function verifyTool(v) { return audit.verifyTools(v.common, v.input, v.turnHash, v.tools, v.wire, v.scope, false, v.events); }
check('Full live read bytes survive explicit4096 persisted prefix truncation', () => {
  const value = toolFixture('line مرحبا • café • € • 😀\n'.repeat(500));
  const result = verifyTool(value)[0]; assert.equal(result.tool.output, value.events[0].payload.output); assert.equal(result.outputProjection.persistedOutputLength, 4096);
});
check('Exact4096 output requires no false truncation marker', () => assert.equal(verifyTool(toolFixture('x'.repeat(4096))).length, 1));
check('Short exact output remains accepted', () => assert.equal(verifyTool(toolFixture()).length, 1));
check('Split surrogate at storage boundary preserves exact UTF16 prefix', () => assert.equal(verifyTool(toolFixture('a'.repeat(4095) + '😀tail'))[0].outputProjection.persistedOutputLength, 4096));
for (const [name, mutate] of [
  ['Missing actual live result is rejected', v => { v.events = []; }],
  ['Duplicate actual live result is rejected', v => { v.events.push(clone(v.events[0])); }],
  ['Native output SHA must match full live bytes', v => { v.wire[1].outputSha256 = sha('wrong'); }],
  ['Changed live full output is rejected', v => { v.events[0].payload.output = 'wrong'; }],
  ['Truncated stored prefix requires its explicit flag', v => { delete v.tools[0].truncated; }],
  ['Wrong stored prefix is rejected', v => { v.tools[0].output = 'wrong'; }],
  ['Arbitrary shorter persisted prefix is rejected', v => { v.tools[0].output = v.tools[0].output.slice(0, 2000); }],
  ['Tool cannot change command after native execution', v => { v.tools[0].input.command = ['cat', 'README.md']; }],
  ['Wrong live item ID is rejected', v => { v.events[0].payload.id = 'foreign'; }],
  ['Tool in second reply has no authority', v => { v.scope = {}; }],
  ['A file change is never allowed', v => { v.tools[0].name = 'Edit'; }],
  ['Wrong cwd is rejected', v => { v.tools[0].input.cwd = '/foreign'; }],
  ['A failed command cannot count as evidence', v => { v.wire[1].exitCode = 1; }],
  ['Foreign native turn cannot own this result', v => { v.wire[1].turnHash = sha('foreign'); }],
  ['Missing native start is rejected', v => { v.wire.shift(); }],
  ['Unpersisted actual tool cannot disappear', v => { v.events.push({ type: 'toolResult', payload: { ...clone(v.events[0].payload), id: 'hidden' } }); }],
]) check(name, () => { const value = toolFixture('x'.repeat(7000)); mutate(value); assert.throws(() => verifyTool(value)); });
// Validate permitted runtime additions without weakening immutable copied files.
let historyIndex = 0;
function historyControl(name, change, accepts = false) {
  check(name, () => {
    const workspace = path.join(directory, `history-${++historyIndex}`), relative = '.mysti/compaction/new-panel/history.jsonl';
    fs.mkdirSync(path.dirname(path.join(workspace, relative)), { recursive: true });
    const value = { relative, text: JSON.stringify({ seq: 1, ts: 100, role: 'user', kind: 'text', content: 'Source review.', tokensEst: 3 }) + '\n', panelId: 'new-panel' };
    change?.(value); const file = path.join(workspace, value.relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value.text, { flag: 'wx' });
    const artifact = { relative: value.relative, sha256: sha(value.text) };
    const run = () => audit.auditHistoryArtifacts(workspace, value.panelId, [artifact]);
    if (accepts) run(); else assert.throws(run);
  });
}
historyControl('Exact current-panel history rows are accepted', undefined, true);
historyControl('Exact product history ignore file is accepted', value => { value.relative = '.mysti/compaction/.gitignore'; value.text = '*\n'; }, true);
historyControl('Foreign-panel history cannot be added', value => { value.panelId = 'other-panel'; });
historyControl('Unrelated runtime additions are rejected', value => { value.relative = 'changed-config.json'; });
historyControl('Malformed history rows are rejected', value => { value.text = '{bad json'; });
historyControl('Empty history is rejected', value => { value.text = ''; });
historyControl('History sequence cannot start after missing rows', value => { value.text = value.text.replace('"seq":1', '"seq":2'); });
historyControl('Unexpected history fields are rejected', value => { value.text = JSON.stringify({ ...JSON.parse(value.text), extra: true }); });
historyControl('Invalid history roles are rejected', value => { value.text = value.text.replace('"user"', '"foreign"'); });
historyControl('History ignore cannot hide arbitrary content', value => { value.relative = '.mysti/compaction/.gitignore'; value.text = '**/secret\n'; });
const result = { status: checks.every(value => value.status === 'PASS') ? 'PASS' : 'FAIL', passed: checks.filter(value => value.status === 'PASS').length,
  failed: checks.filter(value => value.status === 'FAIL').length, checks, auditorSha256: sha(fs.readFileSync(require.resolve('./audit-vscode-codex-semantic-followup.cjs'))),
  inferenceInputs: 0, editorLaunches: 0, scope: 'Synthetic receipt, approval, live-output and durable-conversation controls. Filesystem/preserved-tree checks are covered by dedicated preparation controls; native semantic correctness is not claimed.' };
fs.writeFileSync(path.join(directory, 'checks.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ directory, status: result.status, passed: result.passed, failed: result.failed, failures: checks.filter(value => value.status === 'FAIL') }));
if (result.failed) process.exitCode = 1;
