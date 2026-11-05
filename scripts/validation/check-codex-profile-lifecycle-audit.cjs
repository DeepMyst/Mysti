/* Synthetic two-reply transcript and approval controls. No editor or inference. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const audit = require('./audit-vscode-codex-profile-lifecycle.cjs');
const { assertToolOutputProjection } = require('./codex-full-oracle.cjs');
const sha = value => createHash('sha256').update(value).digest('hex'), clone = value => structuredClone(value);
const directory = fs.mkdtempSync(path.resolve(__dirname, '../../out-test/feature-tests/PB-02/codex-profile-lifecycle-audit-controls-'));
const checks = []; let fixtureIndex = 0;
function check(name, action) {
  try { action(); checks.push({ name, status: 'PASS' }); }
  catch (error) { checks.push({ name, status: 'FAIL', error: { name: error.name, message: error.message } }); }
}
function fixture(withApproval = false) {
  const owned = path.join(directory, `case-${++fixtureIndex}`); fs.mkdirSync(owned);
  const owner = { directory: owned, workspace: path.join(owned, 'workspace') };
  const model = 'gpt-5.6-sol', panelId = 'profile-panel', conversationId = 'profile-conversation';
  const files = Object.fromEntries(['README.md', 'src/retry.cjs', 'attachments/brief.txt'].map(name => [name, { sha256: sha(name), bytes: name.length }]));
  const snapshot = { hashes: Object.fromEntries(Object.entries(files).map(([key, value]) => [key, value.sha256])) };
  const profileValidation = { codeHome: '/owned/codex', invalidValue: '../pb02-invalid', profiles: {
    A: { name: 'pb02-a', path: '/owned/codex/pb02-a.config.toml', sha256: sha('profileA'), contextWindow: 262144 },
    B: { name: 'pb02-b', path: '/owned/codex/pb02-b.config.toml', sha256: sha('profileB'), contextWindow: 262145 },
  }, missing: { name: 'pb02-missing', path: '/owned/codex/pb02-missing.config.toml' } };
  const common = { owner, manifest: { model, fixture: { files }, profileValidation }, inputs: [], receipts: [], ancestry: { processIdentities: [] } };
  const levels = ['low', 'medium', 'high', 'xhigh'];
  const events = [{ type: 'initialState', at: 50, payload: { panelId, settings: { provider: 'openai-codex', model, effortLevel: 'low' },
    providerManifest: { providers: [{ id: 'openai-codex', capabilities: { effortLevels: levels } }] } } }], observations = [], replies = [], messages = [], attempts = [];
  const highDom = { settingsSelect: 'high', inlineSelect: 'high', label: 'High', sliderValue: '2', sliderValueText: 'High' };
  const lowDom = { settingsSelect: 'low', inlineSelect: 'low', label: 'Low', sliderValue: '0', sliderValueText: 'Low' };
  observations.push({ event: 'effort-startup', at: 60, configuredDefault: 'low', settingsEvents: clone(events), dom: clone(highDom) });
  events.push({ type: 'modelChanged', at: 70, payload: { model, provider: 'openai-codex', customModel: model } });
  observations.push({ event: 'effort-selected', at: 81, started: 75, ended: 80, effort: 'low', configuredAfter: 'low',
    before: clone(highDom), after: clone(lowDom), levels: clone(levels), settingsSyncEvents: [] });
  const raw = ['pb02-a', '', '  pb02-a  ', ''];
  const sessionHash = sha('fresh-thread'); let session, inputCount = 0;
  for (const [attemptIndex, marker] of audit.attemptMarkers.entries()) {
    const started = 100 + attemptIndex * 100, completedAt = started + 40, ended = started + 45;
    const receiptStartIndex = common.receipts.length, inputCountBefore = inputCount;
    observations.push({ event: 'effort-before-send', marker, at: started - 1, dom: clone(lowDom) });
    const positive = audit.expected.includes(marker), index = replies.length, inputIndex = positive ? ++inputCount : undefined;
    const wrapperPid = 4242 + attemptIndex * 100;
    const user = { id: `user-${attemptIndex}`, role: 'user', content: `PB02_REQUEST:${marker} Synthetic profile check.`, timestamp: started };
    messages.push(user); events.push({ type: 'messageAdded', at: started, payload: clone(user) }, { type: 'responseStarted', at: started + 1, payload: {} });
    const add = (event, offset, fields = {}) => { const value = { event, at: started + offset, wrapperPid,
      ...(event === 'rpc-request' ? { selectedProfile: positive ? undefined : raw[attemptIndex].trim() } : {}), ...fields }; common.receipts.push(value); return value; };
    {
      const profile = profileValidation.profiles.A;
      add('invocation', 1, { args: positive ? ['app-server'] : ['--profile', profile.name, 'app-server'], kind: 'app-server',
        ...(positive ? {} : { selectedProfile: profile.name, profileOwnedPath: profile.path }),
        profileFileSha256: positive ? null : profile.sha256, codeHomeMatches: true });
      add('start', 2, { childPid: wrapperPid + 1 });
      common.ancestry.processIdentities.push(...[wrapperPid, wrapperPid + 1].map(pid => ({ pid, startedAt: 'Sun Oct 11 10:00:00 2026' })));
      add('rpc-request', 3, { method: 'initialize', rpcIdHash: sha(`initialize-${wrapperPid}`) });
      if (!positive) {
        const stderr = '--profile only applies to runtime commands and `codex mcp`: synthetic native diagnostic';
        add('stderr-summary', 14, { bytes: Buffer.byteLength(stderr), sha256: sha(stderr), runtimeOnlyProfileArgument: true });
        add('exit', 15, { childPid: wrapperPid + 1, exitCode: 1, signal: null });
      } else {
        const rpcIdHash = sha(`config-${wrapperPid}`), method = marker === 'DEFAULT_A' ? 'thread/start' : 'thread/resume';
        add('rpc-request', 4, { method: 'config/read', rpcIdHash });
        add('rpc-result', 5, { method: 'config/read', rpcIdHash, success: true });
        add('profile-config', 5, { rpcIdHash, model: 'base-native-model', reasoningEffort: 'medium', contextWindow: 131072 });
        add('effective-tool-config', 5, { mcpNames: [], appNames: [] });
        add('rpc-request', 6, { method, rpcIdHash: sha(`thread-${wrapperPid}`), sessionHash: method === 'thread/resume' ? sessionHash : undefined });
        session = add('session', 7, { method, sessionHash, requestedModel: model, actualModel: model, modelProvider: 'openai',
          returnedPolicy: { approvalPolicy: 'untrusted', sandbox: 'readOnly', networkAccess: false, ownedCwd: true } });
      }
    }
    if (!positive) {
      events.push({ type: 'error', at: started + 20, payload: "This Codex CLI cannot use named profiles with Mysti's app-server connection. Clear mysti.codexProfile in Settings and retry to use your base Codex configuration. No model request was submitted." });
    } else {
      const turnHash = sha(`turn-${index}`), rpcIdHash = sha(`turn-request-${index}`);
      add('rpc-request', 9, { method: 'turn/start', rpcIdHash, sessionHash });
      const input = add('request', 10, { method: 'turn/start', rpcIdHash, inputIndex, sessionHash, model, effort: 'low', outsideMemoryMarkers: audit.attemptMarkers.slice(0, attemptIndex + 1),
        policy: { approvalPolicy: 'untrusted', sandbox: 'read-only', ownedCwd: true, effort: 'low', mcpAllDisabled: true, appsAllDisabled: true, appsDefaultDisabled: true, mcpNames: [], appNames: [] } });
      common.inputs.push(input); add('turn-started', 11, { inputIndex, sessionHash, turnHash });
      const tools = [], toolOutputEvidence = [], permissionDecisionIds = [], nativeTools = [];
      if (index === 0) {
        const output = 'Owned synthetic source read: مرحبا • café • € • 😀\n'.repeat(150) + 'Exact fixture README.\n';
        const live = { id: 'read-item', name: 'Bash', status: 'completed', input: { command: ['/bin/zsh', '-lc', audit.scopes[marker].commands[0]], cwd: owner.workspace }, output };
        const persisted = clone(live); persisted.output = output.slice(0, 4096); persisted.truncated = true;
        const start = add('tool-start', 12, { inputIndex, sessionHash, turnHash, itemIdHash: sha(live.id), type: 'commandExecution' });
        if (withApproval) {
          const id = 'approval-card', details = { toolName: 'Bash', toolInput: clone(live.input) }, inputSha256 = sha(JSON.stringify(details.toolInput));
          const request = add('approval-request', 14, { inputIndex, sessionHash, turnHash, itemIdHash: start.itemIdHash,
            method: 'item/commandExecution/requestApproval', toolInputSha256: inputSha256, nativeRequestIdHash: sha('approval-id') });
          add('approval-decision', 20, { inputIndex, nativeRequestIdHash: request.nativeRequestIdHash, decision: 'accept' });
          events.push({ type: 'permissionRequest', at: started + 15, payload: { id, details } });
          observations.push({ event: 'permission-decision', at: started + 21, id, name: 'bash', input: clone(live.input), inputSha256,
            approved: true, expectedDenial: false, beforeFiles: clone(snapshot) });
          permissionDecisionIds.push(id);
        }
        const result = add('tool-result', 30, { ...start, event: 'tool-result', at: started + 30, status: 'completed', exitCode: 0, commandSha256: sha(JSON.stringify(live.input.command)), ownedCwd: true, outputSha256: sha(output) });
        nativeTools.push(start, result); tools.push(persisted); events.push({ type: 'toolResult', at: started + 31, payload: live });
        toolOutputEvidence.push(assertToolOutputProjection({ nativeResult: result, liveTool: live, persistedTool: persisted }));
      }
      const turnCompleted = add('turn-completed', 35, { inputIndex, sessionHash, turnHash, status: 'completed' });
      const message = { id: `reply-${index}`, role: 'assistant', provider: 'openai-codex', model, content: `Synthetic native reply. PB02_DONE:${marker}`, toolCalls: clone(tools), timestamp: completedAt };
      messages.push(message); events.push({ type: 'responseComplete', at: completedAt, payload: { message: clone(message) } });
      const reply = { ordinal: index + 1, marker, panelId, conversationId, messageId: message.id, provider: 'openai-codex', model, content: message.content,
        tools, toolOutputEvidence, request: clone(input), nativeSession: clone(session), started, completedAt, turnCompleted: clone(turnCompleted), nativeTools: clone(nativeTools), scope: clone(audit.scopes[marker]), beforeFiles: clone(snapshot), permissionDecisionIds };
      replies.push(reply); observations.push({ event: 'native-response', ...clone(reply), afterFiles: clone(snapshot) });
    }
    const capturedEvents = events.filter(value => value.at >= started && value.at <= ended);
    const attempt = { marker, configRaw: raw[attemptIndex], configReadback: raw[attemptIndex], selectedAt: started - 5, started, ended, userMessageId: user.id,
      receiptStartIndex, receiptEndIndex: common.receipts.length, inputCountBefore, inputCountAfter: inputCount,
      capturedEvents: clone(capturedEvents), errorEvents: clone(capturedEvents.filter(value => value.type === 'error')),
      ...(!positive ? { visibleError: 'Error: ' + capturedEvents.find(value => value.type === 'error').payload } : {}),
      ...(positive ? { replyId: replies.at(-1).messageId } : {}) };
    if (attemptIndex) observations.push({ event: 'profile-selection', at: attempt.selectedAt, selectedAt: attempt.selectedAt, configRaw: attempt.configRaw, configReadback: attempt.configReadback, receiptStartIndex: attempt.receiptStartIndex, inputCountBefore: attempt.inputCountBefore });
    attempts.push(attempt); observations.push({ event: 'profile-attempt', at: ended, ...clone(attempt) });
  }
  for (const wrapperPid of [4342, 4542]) {
    common.receipts.push({ event: 'stderr-summary', at: 900, wrapperPid, bytes: 0, sha256: sha(''), runtimeOnlyProfileArgument: false },
      { event: 'exit', at: 901, wrapperPid, childPid: wrapperPid + 1, exitCode: null, signal: 'SIGTERM' });
  }
  const conversation = { id: conversationId, messages };
  const acceptance = { stage: 'PROFILE_LIFECYCLE_2', status: 'PASS_PROFILE_LIFECYCLE_TRANSPORT', sourceId: conversationId, panelId, replies, attempts,
    finalConversation: clone(conversation), counts: { completedTurns: 2, conversationalInputs: 2, publicUserAttempts: 4, rejectedAttempts: 2, auxiliaryInputs: 0 }, semanticReview: 'ROOT_INDEPENDENT_REVIEW_REQUIRED' };
  return { common, acceptance, stored: { conversations: [clone(conversation)] }, events, observations };
}
function seal(value) {
  fs.writeFileSync(path.join(value.common.owner.directory, 'events-main.json'), JSON.stringify(value.events), { flag: 'wx' });
  fs.writeFileSync(path.join(value.common.owner.directory, 'observations.json'), JSON.stringify(value.observations), { flag: 'wx' });
}
function verify(value) {
  const journey = audit.auditJourney(value.common, value.acceptance, value.stored);
  return { journey, permissions: audit.auditPermissions(value.common, value.acceptance, journey), attempts: audit.auditProfileAttempts(value.common, value.acceptance, journey), effort: audit.auditExplicitEffort(value.common, value.acceptance, journey) };
}
function control(name, mutate, accepts = false, approval = false) {
  check(name, () => { const value = fixture(approval); mutate?.(value); seal(value); if (accepts) assert.equal(verify(value).journey.proofs.length, 2); else assert.throws(() => verify(value)); });
}
control('Four attempts and two explicit-default replies join native, live and durable evidence without claiming named-profile loading', undefined, true);
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
  ['Future request markers cannot leak into first reply', v => { v.common.inputs[0].outsideMemoryMarkers.push('DEFAULT_RECOVERY'); }],
  ['Unrequested extra scope is rejected', v => { v.acceptance.replies[1].scope.commands = ['cat src/retry.cjs']; }],
  ['Missing actual completion is rejected', v => { v.events = v.events.filter(e => !(e.type === 'responseComplete' && e.payload.message.id === 'reply-0')); }],
  ['Duplicate actual completion is rejected', v => { v.events.push(clone(v.events.find(e => e.type === 'responseComplete'))); }],
  ['Stored assistant text cannot differ from actual public terminal', v => { v.stored.conversations[0].messages.find(m => m.id === 'reply-0').content = 'changed'; }],
  ['Error within a supposedly successful reply is rejected', v => { v.events.push({ type: 'error', at: 125, payload: { message: 'failed' } }); }],
  ['Missing saved observation is rejected', v => { v.observations.pop(); }],
  ['Changed saved source after reply is rejected', v => { v.observations.find(e => e.event === 'native-response').afterFiles.hashes['src/retry.cjs'] = sha('changed'); }],
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
  ['Detached harness decisions are rejected', v => { v.observations.push({ ...clone(v.observations.find(e => e.event === 'permission-decision')), id: 'detached' }); }],
  ['Wrong native approval method is rejected', v => { v.common.receipts.find(e => e.event === 'approval-request').method = 'item/fileChange/requestApproval'; }],
]) control(name, mutate, false, true);

function syncAttempt(value, index) {
  const attempt = value.acceptance.attempts[index];
  attempt.capturedEvents = clone(value.events.filter(event => event.at >= attempt.started && event.at <= attempt.ended));
  attempt.errorEvents = clone(attempt.capturedEvents.filter(event => ['error', 'authError', 'requestCancelled'].includes(event.type)));
  const at = value.observations.findIndex(event => event.event === 'profile-attempt' && event.marker === attempt.marker);
  value.observations[at] = { event: 'profile-attempt', at: attempt.ended, ...clone(attempt) };
  if (index) {
    const selection = value.observations.find(event => event.event === 'profile-selection' && event.selectedAt === attempt.selectedAt);
    for (const key of ['configRaw', 'configReadback', 'receiptStartIndex', 'inputCountBefore']) selection[key] = attempt[key];
  }
}
function insertReceipts(value, index, items) {
  const end = value.acceptance.attempts[index].receiptEndIndex; value.common.receipts.splice(end, 0, ...items);
  for (let i = index; i < value.acceptance.attempts.length; i++) {
    if (i > index) value.acceptance.attempts[i].receiptStartIndex += items.length;
    value.acceptance.attempts[i].receiptEndIndex += items.length; syncAttempt(value, i);
  }
}
function extraNamedFailure(value, index = 0) {
  const attempt = value.acceptance.attempts[index], rows = clone(value.common.receipts.slice(attempt.receiptStartIndex, attempt.receiptEndIndex));
  for (const row of rows) { row.wrapperPid = 4252; if (row.childPid) row.childPid = 4253; row.at += 20; }
  insertReceipts(value, index, rows);
}
const invocation = (value, wrapperPid = 4242) => value.common.receipts.find(event => event.event === 'invocation' && event.wrapperPid === wrapperPid);
const summary = (value, wrapperPid = 4242) => value.common.receipts.find(event => event.event === 'stderr-summary' && event.wrapperPid === wrapperPid);
control('Advisory warm startup and public send may each reject the exact named profile without inference', extraNamedFailure, true);
control('Prior default process stderr and exit may arrive inside the next rejected named-profile attempt', value => {
  const moved = value.common.receipts.filter(event => event.wrapperPid === 4342 && ['stderr-summary', 'exit'].includes(event.event));
  value.common.receipts = value.common.receipts.filter(event => !moved.includes(event));
  moved.forEach((event, index) => { event.at = 330 + index; }); insertReceipts(value, 2, moved);
}, true);
control('Named argument rejection may exit before any initialize frame reaches the native child', value => {
  for (const index of [2, 0]) {
    const attempt = value.acceptance.attempts[index];
    const at = value.common.receipts.findIndex((event, receiptIndex) => receiptIndex >= attempt.receiptStartIndex && receiptIndex < attempt.receiptEndIndex && event.event === 'rpc-request');
    value.common.receipts.splice(at, 1);
    for (let i = index; i < value.acceptance.attempts.length; i++) {
      if (i > index) value.acceptance.attempts[i].receiptStartIndex--;
      value.acceptance.attempts[i].receiptEndIndex--; syncAttempt(value, i);
    }
  }
}, true);
control('Fast argument-rejection children may exit between ancestry samples without becoming model inputs', value => {
  value.common.ancestry.processIdentities = value.common.ancestry.processIdentities.filter(item => ![4242, 4243, 4442, 4443].includes(item.pid));
}, true);
control('Default configuration metadata is independent of the explicitly requested turn model and effort', value => {
  for (const config of value.common.receipts.filter(event => event.event === 'profile-config')) { delete config.model; delete config.reasoningEffort; delete config.contextWindow; }
}, true);
control('Default context window may numerically equal an owned marker without claiming named-profile loading', value => {
  for (const config of value.common.receipts.filter(event => event.event === 'profile-config')) config.contextWindow = 262144;
}, true);
control('A real partial assistant carried by an error persists exactly without inventing a completion', value => {
  const message = { id: 'actual-error-message', role: 'assistant', content: 'Partial error detail', provider: 'openai-codex', model: 'gpt-5.6-sol', toolCalls: [] };
  const event = value.events.find(event => event.type === 'error'); event.payload = { error: event.payload, message: clone(message) };
  value.stored.conversations[0].messages.splice(1, 0, clone(message)); value.acceptance.finalConversation = clone(value.stored.conversations[0]); syncAttempt(value, 0);
}, true);
control('A transparent version probe has its own complete stderr and exit accounting', value => {
  const wrapperPid = 4800;
  value.common.receipts.push({ event: 'invocation', at: 1000, wrapperPid, kind: 'probe', args: ['--version'] },
    { event: 'probe-start', at: 1001, wrapperPid, childPid: 4801 },
    { event: 'stderr-summary', at: 1002, wrapperPid, bytes: 0, sha256: sha(''), runtimeOnlyProfileArgument: false },
    { event: 'probe-exit', at: 1003, wrapperPid, childPid: 4801, exitCode: 0, signal: null });
}, true);
for (const [name, change] of [
  ['Four attempt markers are exact and ordered', value => { value.acceptance.attempts[0].marker = 'OTHER'; }],
  ['Both rejected sends remain in the public user count', value => { value.acceptance.counts.publicUserAttempts = 2; }],
  ['Rejected startup count is separate from model inputs', value => { value.acceptance.counts.rejectedAttempts = 0; }],
  ['No successful default reply may be relabeled as a named-profile result', value => { value.acceptance.replies[0].marker = 'UNSUPPORTED_A'; }],
  ['The first named setting cannot silently be cleared', value => { value.acceptance.attempts[0].configRaw = ''; value.acceptance.attempts[0].configReadback = ''; syncAttempt(value, 0); }],
  ['Default reply requires an actual empty setting', value => { value.acceptance.attempts[1].configRaw = 'pb02-a'; value.acceptance.attempts[1].configReadback = 'pb02-a'; syncAttempt(value, 1); }],
  ['A whitespace-only setting cannot substitute for explicit clear', value => { value.acceptance.attempts[1].configRaw = '  '; value.acceptance.attempts[1].configReadback = '  '; syncAttempt(value, 1); }],
  ['The padded raw value must survive configuration readback', value => { value.acceptance.attempts[2].configReadback = 'pb02-a'; syncAttempt(value, 2); }],
  ['Explicit clear requires a joined public configuration-selection observation', value => { value.observations = value.observations.filter(event => !(event.event === 'profile-selection' && event.configRaw === '')); }],
  ['Explicit clear readback cannot disagree with its selection observation', value => { value.observations.find(event => event.event === 'profile-selection').configReadback = 'pb02-a'; }],
  ['Automatic hidden profile changes cannot masquerade as the three explicit selections', value => { value.observations.push({ ...clone(value.observations.find(event => event.event === 'profile-selection')), selectedAt: 990 }); }],
  ['Rejected startup cannot increment the model-input counter', value => { value.acceptance.attempts[0].inputCountAfter = 1; syncAttempt(value, 0); }],
  ['A generic incomplete-response error cannot replace the compatibility diagnostic', value => { value.events.find(event => event.type === 'error').payload = 'The answer above is incomplete. Retry.'; syncAttempt(value, 0); }],
  ['Mapped diagnostic cannot lose the explicit-clear instruction', value => { value.events.find(event => event.type === 'error').payload = audit.UNSUPPORTED_PROFILE_MESSAGE.replace('Clear mysti.codexProfile in Settings and retry to use your base Codex configuration. ', ''); syncAttempt(value, 0); }],
  ['Visible error must retain the exact public diagnostic', value => { value.acceptance.attempts[0].visibleError = 'Error: generic failure'; syncAttempt(value, 0); }],
  ['Authentication errors do not establish CLI profile incompatibility', value => { value.events.find(event => event.type === 'error').type = 'authError'; syncAttempt(value, 0); }],
  ['Duplicate public rejection errors are rejected', value => { value.events.push(clone(value.events.find(event => event.type === 'error'))); syncAttempt(value, 0); }],
  ['Negative attempts cannot claim a completed reply', value => { value.acceptance.attempts[0].replyId = 'reply-0'; syncAttempt(value, 0); }],
  ['Every rejected native process needs the exact stderr signature', value => { summary(value).runtimeOnlyProfileArgument = false; }],
  ['Repeated rejected startups each need their own signature', value => { extraNamedFailure(value); summary(value, 4252).runtimeOnlyProfileArgument = false; }],
  ['The default process cannot carry an unsupported named-profile signature', value => { summary(value, 4342).runtimeOnlyProfileArgument = true; }],
  ['Zero stderr bytes cannot support the native signature', value => { summary(value).bytes = 0; }],
  ['A stderr digest must be a complete SHA256', value => { summary(value).sha256 = 'short'; }],
  ['Empty stderr digest is independently verified', value => { summary(value, 4342).sha256 = sha('different'); }],
  ['Diagnostic receipts never contain raw native stderr', value => { summary(value).raw = 'not allowed'; }],
  ['Duplicate native stderr summaries are rejected', value => { value.common.receipts.push(clone(summary(value))); }],
  ['Orphan native stderr summaries are rejected', value => { value.common.receipts.push({ ...clone(summary(value)), wrapperPid: 9999 }); }],
  ['Native summary must precede its actual child exit', value => {
    const rows = value.common.receipts, at = rows.indexOf(summary(value)), item = rows.splice(at, 1)[0]; rows.splice(at + 1, 0, item);
  }],
  ['Native failure must be a nonzero parser exit', value => { value.common.receipts.find(event => event.event === 'exit').exitCode = 0; }],
  ['Native signature plus interruption is not the expected parser rejection', value => { value.common.receipts.find(event => event.event === 'exit').signal = 'SIGTERM'; }],
  ['Missing native child exit cannot be replaced by an error message', value => { value.common.receipts = value.common.receipts.filter(event => !(event.event === 'exit' && event.wrapperPid === 4242)); }],
  ['Child exit must match the started native child', value => { value.common.receipts.find(event => event.event === 'exit').childPid = 999; }],
  ['Padded profile selection must reach native argv already trimmed', value => { invocation(value, 4442).args[1] = '  pb02-a  '; }],
  ['Named profile cannot silently launch default arguments', value => { invocation(value).args = ['app-server']; }],
  ['Default arguments must not retain a named profile', value => { invocation(value, 4342).args = ['--profile', 'pb02-a', 'app-server']; }],
  ['Default receipt must omit selected profile attribution', value => { invocation(value, 4342).selectedProfile = 'pb02-a'; }],
  ['Default receipt must omit an owned named-profile path', value => { invocation(value, 4342).profileOwnedPath = '/owned/codex/pb02-a.config.toml'; }],
  ['Default receipt must not claim the named-profile file hash', value => { invocation(value, 4342).profileFileSha256 = sha('profileA'); }],
  ['Named rejected profile still needs its exact owned file identity', value => { invocation(value).profileFileSha256 = sha('other'); }],
  ['Native home must match the existing owned-profile descriptor', value => { invocation(value).codeHomeMatches = false; }],
  ['Rejected initialize cannot acknowledge success', value => insertReceipts(value, 0, [{ event: 'rpc-result', at: 125, wrapperPid: 4242, method: 'initialize', success: true, rpcIdHash: sha('initialize-4242') }])],
  ['Rejected profile cannot advance to config read', value => insertReceipts(value, 0, [{ event: 'rpc-request', at: 125, wrapperPid: 4242, selectedProfile: 'pb02-a', method: 'config/read', rpcIdHash: sha('forbidden') }])],
  ['Rejected profile cannot create a native session', value => insertReceipts(value, 0, [{ event: 'session', at: 125, wrapperPid: 4242, sessionHash: sha('hidden') }])],
  ['Rejected profile cannot forward a turn', value => insertReceipts(value, 0, [{ event: 'request', at: 125, wrapperPid: 4242, inputIndex: 99 }])],
  ['Default RPCs cannot retain named-profile attribution', value => { value.common.receipts.find(event => event.event === 'rpc-request' && event.wrapperPid === 4342).selectedProfile = 'pb02-a'; }],
  ['Default configuration observation cannot claim a loaded named profile', value => { value.common.receipts.find(event => event.event === 'profile-config').selectedProfile = 'pb02-a'; }],
  ['Default config response must join its actual RPC', value => { value.common.receipts.find(event => event.event === 'profile-config').rpcIdHash = sha('foreign'); }],
  ['Recovery must resume the established native thread', value => { value.common.receipts.find(event => event.event === 'rpc-request' && event.method === 'thread/resume').method = 'thread/start'; }],
  ['Successful default processes require captured PID/birth identities', value => { value.common.ancestry.processIdentities = value.common.ancestry.processIdentities.filter(item => item.pid !== 4343); }],
  ['Single-shot execution fallback is rejected', value => { invocation(value).kind = 'auxiliary'; }],
  ['A claimed version probe cannot hide arbitrary CLI arguments', value => { invocation(value).kind = 'probe'; }],
  ['Initial attempt receipt range cannot omit earlier startup', value => { value.acceptance.attempts[0].receiptStartIndex = 1; syncAttempt(value, 0); }],
  ['Late unassigned native setup is rejected', value => { value.common.receipts.push({ event: 'rpc-request', at: 990, wrapperPid: 4542, method: 'initialize', rpcIdHash: sha('late') }); }],
]) control(name, change);

const effortObservation = (value, event) => value.observations.find(item => item.event === event);
control('Startup may show High despite configured Low; explicit selection validation does not reclassify that observation', value => {
  value.events[0].payload.settings.effortLevel = 'high';
  effortObservation(value, 'effort-startup').settingsEvents = clone(value.events.filter(event => ['initialState', 'settingsSync'].includes(event.type) && event.at <= 60));
}, true);
control('Startup may have no rendered effort slider yet', value => {
  const dom = effortObservation(value, 'effort-startup').dom; dom.sliderValue = null; dom.sliderValueText = null;
}, true);
control('Startup already Low remains a valid observed baseline before the explicit public action', value => {
  effortObservation(value, 'effort-startup').dom = clone(effortObservation(value, 'effort-selected').after);
}, true);
control('A real settingsSync during selection is retained exactly when the host sends one', value => {
  const event = { type: 'settingsSync', at: 78, payload: { effortLevel: 'low' } };
  value.events.push(event); effortObservation(value, 'effort-selected').settingsSyncEvents = [clone(event)];
}, true);
control('A later safe settingsSync that retains Low is accepted', value => {
  value.events.push({ type: 'settingsSync', at: 90, payload: { effortLevel: 'low' } });
}, true);
for (const [name, change] of [
  ['Missing startup effort observation is rejected', value => { value.observations = value.observations.filter(event => event.event !== 'effort-startup'); }],
  ['Duplicate startup effort observations are rejected', value => { value.observations.push(clone(effortObservation(value, 'effort-startup'))); }],
  ['Configured Low must be recorded independently of startup UI state', value => { effortObservation(value, 'effort-startup').configuredDefault = 'high'; }],
  ['Startup settings events cannot be silently discarded', value => { effortObservation(value, 'effort-startup').settingsEvents = []; }],
  ['Startup settings evidence must equal the actual event bytes', value => { effortObservation(value, 'effort-startup').settingsEvents[0].payload.settings.effortLevel = 'high'; }],
  ['Safe initial settings cannot contain private configuration', value => {
    value.events[0].payload.settings.secret = 'synthetic'; effortObservation(value, 'effort-startup').settingsEvents[0].payload.settings.secret = 'synthetic';
  }],
  ['Safe settings event fields retain their scalar types', value => {
    value.events[0].payload.settings.effortLevel = { hidden: true }; effortObservation(value, 'effort-startup').settingsEvents[0].payload.settings.effortLevel = { hidden: true };
  }],
  ['Missing actual effort selection is rejected', value => { value.observations = value.observations.filter(event => event.event !== 'effort-selected'); }],
  ['Repeated effort selection cannot hide extra UI work', value => { value.observations.push(clone(effortObservation(value, 'effort-selected'))); }],
  ['Effort selection must follow the startup evidence', value => { effortObservation(value, 'effort-selected').started = 59; }],
  ['Effort selection must follow an actual model acknowledgement', value => { value.events = value.events.filter(event => event.type !== 'modelChanged'); }],
  ['A stale acknowledgement before startup cannot authorize this model selection', value => { value.events.find(event => event.type === 'modelChanged').at = 40; }],
  ['Wrong selected effort is rejected', value => { effortObservation(value, 'effort-selected').effort = 'high'; }],
  ['Configuration readback after public selection must be Low', value => { effortObservation(value, 'effort-selected').configuredAfter = 'high'; }],
  ['Final selected DOM cannot remain High', value => { effortObservation(value, 'effort-selected').after = clone(effortObservation(value, 'effort-selected').before); }],
  ['Settings selector cannot disagree with inline selector', value => { effortObservation(value, 'effort-selected').after.settingsSelect = 'high'; }],
  ['Inline selector cannot disagree with the selected setting', value => { effortObservation(value, 'effort-selected').after.inlineSelect = 'high'; }],
  ['Visible effort label must agree with Low', value => { effortObservation(value, 'effort-selected').after.label = 'High'; }],
  ['Actual slider index must select the Low option', value => { effortObservation(value, 'effort-selected').after.sliderValue = '2'; }],
  ['Actual slider aria text must agree with Low', value => { effortObservation(value, 'effort-selected').after.sliderValueText = 'High'; }],
  ['Unrendered slider cannot prove completed effort selection', value => { effortObservation(value, 'effort-selected').after.sliderValue = null; }],
  ['Actual option list cannot omit Low', value => { effortObservation(value, 'effort-selected').levels = ['medium', 'high']; }],
  ['Duplicate options cannot manufacture a slider index', value => { effortObservation(value, 'effort-selected').levels.push('low'); }],
  ['Actual option list must match the public Codex capabilities', value => { effortObservation(value, 'effort-selected').levels = ['low', 'high']; }],
  ['A fabricated settingsSync acknowledgement is rejected', value => { effortObservation(value, 'effort-selected').settingsSyncEvents = [{ type: 'settingsSync', at: 78, payload: { effortLevel: 'low' } }]; }],
  ['Actual settingsSync during selection cannot disappear', value => { value.events.push({ type: 'settingsSync', at: 78, payload: { effortLevel: 'low' } }); }],
  ['Later settingsSync must not silently restore High', value => { value.events.push({ type: 'settingsSync', at: 90, payload: { effortLevel: 'high' } }); }],
  ['Later initialState must not silently restore High', value => { value.events.push({ type: 'initialState', at: 90, payload: { panelId: value.acceptance.panelId, settings: { effortLevel: 'high' } } }); }],
  ['All four sends need actual effort observations', value => { value.observations = value.observations.filter(event => !(event.event === 'effort-before-send' && event.marker === 'UNSUPPORTED_A')); }],
  ['Before-send evidence must follow the actual attempt order', value => { value.observations.find(event => event.event === 'effort-before-send').marker = 'DEFAULT_RECOVERY'; }],
  ['Before-send observation cannot occur after its public send', value => { value.observations.find(event => event.event === 'effort-before-send').at = 101; }],
  ['Before-send observation cannot precede the explicit selection', value => { value.observations.find(event => event.event === 'effort-before-send').at = 79; }],
  ['Later send observation cannot reuse stale prior-turn DOM evidence', value => { value.observations.filter(event => event.event === 'effort-before-send')[1].at = 140; }],
  ['Rejected attempts also require Low in the actual composer', value => { value.observations.find(event => event.event === 'effort-before-send').dom.label = 'High'; }],
  ['Recovery send must still show Low in both selectors', value => { value.observations.filter(event => event.event === 'effort-before-send')[3].dom.inlineSelect = 'high'; }],
  ['Extra before-send DOM fields cannot smuggle unreviewed evidence', value => { value.observations.find(event => event.event === 'effort-before-send').dom.hidden = 'extra'; }],
]) control(name, change);

// The inherited transcript controls above retain their exact component scope.
// These controls independently exercise the new public lifecycle boundary.
function lifecycleFixture() {
  const value = fixture();
  const finalWrapperPid = value.common.inputs.at(-1).wrapperPid;
  const summary = value.common.receipts.find(row => row.event === 'stderr-summary' && row.wrapperPid === finalWrapperPid);
  const exit = value.common.receipts.find(row => row.event === 'exit' && row.wrapperPid === finalWrapperPid);
  summary.at = 905; exit.at = 906;
  value.acceptance.lifecycleBoundary = { action: 'public-owned-chat-tab-close', panelId: value.acceptance.panelId,
    tab: { label: 'Mysti', viewType: 'mainThreadWebview-mysti.detachedChat' }, started: 902, closedAt: 904, ended: 907,
    closeAccepted: true, tabAbsent: true, frameDetached: true, tabCloseEventSeen: true,
    receiptStartIndex: value.common.receipts.indexOf(summary), receiptEndIndex: value.common.receipts.length,
    finalWrapperPid, finalChildPid: exit.childPid, finalInputIndex: 2, summary: clone(summary), exit: clone(exit), inputCountBefore: 2, inputCountAfter: 2 };
  value.observations.push({ event: 'owned-chat-tab', at: 65, panelId: value.acceptance.panelId, ...clone(value.acceptance.lifecycleBoundary.tab) });
  value.observations.push({ event: 'lifecycle-boundary-start', at: 903,
    ...Object.fromEntries(['panelId', 'tab', 'started', 'receiptStartIndex', 'finalWrapperPid', 'finalChildPid'].map(key => [key, clone(value.acceptance.lifecycleBoundary[key])])) });
  syncBoundary(value); return value;
}
function syncBoundary(value) {
  value.observations = value.observations.filter(row => row.event !== 'lifecycle-boundary');
  value.observations.push({ event: 'lifecycle-boundary', at: 908, ...clone(value.acceptance.lifecycleBoundary) });
  const closing = value.observations.find(row => row.event === 'lifecycle-boundary-start');
  if (closing) for (const key of ['panelId', 'tab', 'started', 'receiptStartIndex', 'finalWrapperPid', 'finalChildPid']) closing[key] = clone(value.acceptance.lifecycleBoundary[key]);
}
function verifyBoundary(value) { return audit.auditLifecycleBoundary(value.common, value.acceptance, { events: value.events, observations: value.observations }); }
function lifecycleControl(name, change, accepts = false) {
  check(name, () => { const value = lifecycleFixture(); change?.(value); if (accepts) verifyBoundary(value); else assert.throws(() => verifyBoundary(value)); });
}
check('Complete four-attempt journey, explicit effort and public final-process closure compose successfully', () => {
  const value = lifecycleFixture(); seal(value); const verified = verify(value);
  assert.equal(verified.journey.proofs.length, 2); assert.equal(verifyBoundary(value).finalInputIndex, 2);
});
lifecycleControl('Actual SIGTERM shutdown remains a successful observed lifecycle boundary', undefined, true);
lifecycleControl('Actual clean child exit is accepted without inventing a signal', value => {
  const exit = value.common.receipts.at(-1); exit.exitCode = 0; exit.signal = null; value.acceptance.lifecycleBoundary.exit = clone(exit); syncBoundary(value);
}, true);
lifecycleControl('Actual escalation signal is preserved rather than relabeled as clean shutdown', value => {
  const exit = value.common.receipts.at(-1); exit.signal = 'SIGKILL'; value.acceptance.lifecycleBoundary.exit = clone(exit); syncBoundary(value);
}, true);
lifecycleControl('Native child may exit before public close promise resolves', value => {
  value.acceptance.lifecycleBoundary.closedAt = 907; syncBoundary(value);
}, true);
lifecycleControl('Product view type without the public bridge prefix is still joined exactly', value => {
  value.acceptance.lifecycleBoundary.tab.viewType = 'mysti.detachedChat'; value.observations.find(row => row.event === 'owned-chat-tab').viewType = 'mysti.detachedChat'; syncBoundary(value);
}, true);
lifecycleControl('Current title may be observed immediately before closing the previously captured owned tab', value => {
  const owned = value.observations.find(row => row.event === 'owned-chat-tab'); owned.at = 902; owned.label = 'Generated conversation title';
  value.acceptance.lifecycleBoundary.tab.label = owned.label; syncBoundary(value);
}, true);
for (const [name, change] of [
  ['Missing lifecycle boundary is rejected', value => { delete value.acceptance.lifecycleBoundary; }],
  ['Unreviewed extra boundary fields are rejected', value => { value.acceptance.lifecycleBoundary.hidden = true; syncBoundary(value); }],
  ['Private process-kill action cannot replace public owned tab close', value => { value.acceptance.lifecycleBoundary.action = 'kill-process'; syncBoundary(value); }],
  ['Foreign panel cannot authorize final-process closure', value => { value.acceptance.lifecycleBoundary.panelId = 'foreign'; syncBoundary(value); }],
  ...['closeAccepted', 'tabAbsent', 'frameDetached', 'tabCloseEventSeen'].map(key => [`Lifecycle proof requires true ${key}`, value => { value.acceptance.lifecycleBoundary[key] = false; syncBoundary(value); }]),
  ['Missing captured public tab identity is rejected', value => { value.observations = value.observations.filter(row => row.event !== 'owned-chat-tab'); }],
  ['Duplicate captured tabs cannot obscure ownership', value => { value.observations.push(clone(value.observations.find(row => row.event === 'owned-chat-tab'))); }],
  ['Captured tab must belong to this public panel', value => { value.observations.find(row => row.event === 'owned-chat-tab').panelId = 'foreign'; }],
  ['Captured tab label must equal the closed tab label', value => { value.acceptance.lifecycleBoundary.tab.label = 'Another tab'; syncBoundary(value); }],
  ['Foreign view type is rejected even with matching observations', value => { value.acceptance.lifecycleBoundary.tab.viewType = 'mysti.canvas'; value.observations.find(row => row.event === 'owned-chat-tab').viewType = 'mysti.canvas'; syncBoundary(value); }],
  ['Lookalike public view type suffix is rejected', value => { value.acceptance.lifecycleBoundary.tab.viewType += '-foreign'; syncBoundary(value); }],
  ['Current tab identity cannot first be recorded after closing starts', value => { value.observations.find(row => row.event === 'owned-chat-tab').at = 903; }],
  ['Close cannot start before the final public attempt settles', value => { value.acceptance.lifecycleBoundary.started = 440; syncBoundary(value); }],
  ['Close resolution cannot precede the close action', value => { value.acceptance.lifecycleBoundary.closedAt = 901; syncBoundary(value); }],
  ['Boundary cannot finish before public tab closure', value => { value.acceptance.lifecycleBoundary.ended = 903; syncBoundary(value); }],
  ['Nonfinite timing cannot prove native shutdown ordering', value => { value.acceptance.lifecycleBoundary.ended = NaN; syncBoundary(value); }],
  ['Public events after frame close cannot masquerade as the preserved snapshot', value => { value.events.push({ type: 'responseStarted', at: 903 }); }],
  ['Missing lifecycle observation is rejected', value => { value.observations = value.observations.filter(row => row.event !== 'lifecycle-boundary'); }],
  ['Duplicate lifecycle observations are rejected', value => { value.observations.push(clone(value.observations.find(row => row.event === 'lifecycle-boundary'))); }],
  ['Missing public close-start observation is rejected', value => { value.observations = value.observations.filter(row => row.event !== 'lifecycle-boundary-start'); }],
  ['Duplicate close-start actions are rejected', value => { value.observations.push(clone(value.observations.find(row => row.event === 'lifecycle-boundary-start'))); }],
  ['Close-start action must retain the final wrapper identity', value => { value.observations.find(row => row.event === 'lifecycle-boundary-start').finalWrapperPid++; }],
  ['Close-start action cannot be observed after the public close resolves', value => { value.observations.find(row => row.event === 'lifecycle-boundary-start').at = 905; }],
  ['Changed saved lifecycle observation is rejected', value => { value.observations.find(row => row.event === 'lifecycle-boundary').finalWrapperPid++; }],
  ['Lifecycle observation cannot precede its complete evidence', value => { value.observations.find(row => row.event === 'lifecycle-boundary').at = 906; }],
  ['Receipt range cannot omit the final stderr summary', value => { value.acceptance.lifecycleBoundary.receiptStartIndex++; syncBoundary(value); }],
  ['Receipt range cannot omit the final exit', value => { value.acceptance.lifecycleBoundary.receiptEndIndex--; syncBoundary(value); }],
  ['Receipt range cannot claim future unobserved rows', value => { value.acceptance.lifecycleBoundary.receiptEndIndex++; syncBoundary(value); }],
  ['Receipt range cannot swallow the completed turn', value => { value.acceptance.lifecycleBoundary.receiptStartIndex = 0; syncBoundary(value); }],
  ['Fractional receipt offsets are rejected', value => { value.acceptance.lifecycleBoundary.receiptStartIndex += 0.5; syncBoundary(value); }],
  ['Final wrapper must own the second model input', value => { value.acceptance.lifecycleBoundary.finalWrapperPid = 4342; syncBoundary(value); }],
  ['Final child must join the actual native start', value => { value.acceptance.lifecycleBoundary.finalChildPid++; syncBoundary(value); }],
  ['Final input index cannot reuse the first reply', value => { value.acceptance.lifecycleBoundary.finalInputIndex = 1; syncBoundary(value); }],
  ['Missing final summary preserves failure', value => { value.common.receipts = value.common.receipts.filter(row => row !== value.common.receipts.at(-2)); }],
  ['Missing final exit preserves failure', value => { value.common.receipts.pop(); }],
  ['Duplicate final summaries are rejected', value => { value.common.receipts.push(clone(value.common.receipts.at(-2))); }],
  ['Duplicate final exits are rejected', value => { value.common.receipts.push(clone(value.common.receipts.at(-1))); }],
  ['Summary must precede actual child exit in receipt order', value => { const rows = value.common.receipts; [rows[rows.length - 2], rows[rows.length - 1]] = [rows.at(-1), rows.at(-2)]; }],
  ['Final summary must arrive after close starts', value => { value.common.receipts.at(-2).at = 901; }],
  ['Final exit cannot arrive after boundary evidence was saved', value => { value.common.receipts.at(-1).at = 908; }],
  ['Summary must precede actual child exit in wall time', value => { value.common.receipts.at(-2).at = 906.5; }],
  ['Final default process cannot claim the named-profile diagnostic', value => { value.common.receipts.at(-2).runtimeOnlyProfileArgument = true; }],
  ['Empty stderr must retain the exact empty digest', value => { value.common.receipts.at(-2).sha256 = sha('changed'); }],
  ['Changed copied summary cannot stand in for actual receipts', value => { value.acceptance.lifecycleBoundary.summary.sha256 = sha('changed'); syncBoundary(value); }],
  ['Changed copied exit cannot stand in for actual receipts', value => { value.acceptance.lifecycleBoundary.exit.exitCode = 0; syncBoundary(value); }],
  ['An exit without either native code or signal is rejected', value => { const row = value.common.receipts.at(-1); row.signal = null; value.acceptance.lifecycleBoundary.exit = clone(row); syncBoundary(value); }],
  ['String exit code cannot replace actual native exit type', value => { const row = value.common.receipts.at(-1); row.exitCode = '0'; value.acceptance.lifecycleBoundary.exit = clone(row); syncBoundary(value); }],
  ['Before-close counter must already contain both completed inputs', value => { value.acceptance.lifecycleBoundary.inputCountBefore = 1; syncBoundary(value); }],
  ['After-close counter must remain exactly two', value => { value.acceptance.lifecycleBoundary.inputCountAfter = 3; syncBoundary(value); }],
  ...['invocation', 'probe-start', 'start', 'rpc-request', 'request', 'turn-started', 'tool-start'].map(event => [`No ${event} work may begin during the public close interval`, value => {
    const boundary = value.acceptance.lifecycleBoundary;
    value.common.receipts.splice(boundary.receiptStartIndex, 0, { event, at: 903, wrapperPid: boundary.finalWrapperPid }); boundary.receiptEndIndex++; syncBoundary(value);
  }]),
  ...['invocation', 'rpc-request', 'request'].map(event => [`No late ${event} may appear after the boundary is recorded`, value => { value.common.receipts.push({ event, at: 909, wrapperPid: 9999 }); }]),
]) lifecycleControl(name, change);

// Exercise the exact native/live/persisted-output verifier used by auditJourney.
function toolFixture(output = 'Owned exact source read\n') {
  const workspace = '/owned';
  const live = { id: 'actual-item', name: 'Bash', status: 'completed', input: { cwd: workspace, command: ['/bin/zsh', '-lc', audit.scopes.DEFAULT_A.commands[0]] }, output };
  const persisted = clone(live); if (output.length > 4096) { persisted.output = output.slice(0, 4096); persisted.truncated = true; }
  const input = { inputIndex: 1, sessionHash: sha('thread') }, turnHash = sha('turn');
  const start = { event: 'tool-start', itemIdHash: sha(live.id), sessionHash: input.sessionHash, turnHash, inputIndex: 1, type: 'commandExecution' };
  const result = { ...start, event: 'tool-result', status: 'completed', exitCode: 0, ownedCwd: true, commandSha256: sha(JSON.stringify(live.input.command)), outputSha256: sha(output) };
  return { common: { owner: { workspace } }, input, turnHash, tools: [persisted], wire: [start, result], scope: clone(audit.scopes.DEFAULT_A), events: [{ type: 'toolResult', payload: live }] };
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
  failed: checks.filter(value => value.status === 'FAIL').length, checks, auditorSha256: sha(fs.readFileSync(require.resolve('./audit-vscode-codex-profile-lifecycle.cjs'))),
  inferenceInputs: 0, editorLaunches: 0, scope: 'Synthetic receipt, approval, live-output and durable-conversation controls. Filesystem/preserved-tree checks are covered by dedicated preparation controls; native semantic correctness is not claimed.' };
fs.writeFileSync(path.join(directory, 'checks.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ directory, status: result.status, passed: result.passed, failed: result.failed, failures: checks.filter(value => value.status === 'FAIL') }));
if (result.failed) process.exitCode = 1;
