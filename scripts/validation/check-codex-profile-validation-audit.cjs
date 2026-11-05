/* Synthetic five-attempt, three-reply transcript and approval controls. No editor or inference. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const audit = require('./audit-vscode-codex-profile-validation.cjs');
const { assertToolOutputProjection } = require('./codex-full-oracle.cjs');
const sha = value => createHash('sha256').update(value).digest('hex'), clone = value => structuredClone(value);
const directory = fs.mkdtempSync(path.resolve(__dirname, '../../out-test/feature-tests/PB-02/codex-profile-validation-audit-controls-'));
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
  const events = [{ type: 'initialState', at: 50, payload: { panelId } }], observations = [], replies = [], messages = [], attempts = [];
  const raw = [profileValidation.invalidValue, 'pb02-a', '  pb02-a  ', 'pb02-missing', 'pb02-b'];
  const sessionHash = sha('fresh-thread'); let session, inputCount = 0;
  for (const [attemptIndex, marker] of audit.attemptMarkers.entries()) {
    const started = 100 + attemptIndex * 100, completedAt = started + 40, ended = started + 45;
    const receiptStartIndex = common.receipts.length, inputCountBefore = inputCount;
    const positive = audit.expected.includes(marker), index = replies.length, inputIndex = positive ? ++inputCount : undefined;
    const wrapperPid = marker === 'MISSING_VALID' ? 4342 : marker === 'VALID_B_RECOVERY' ? 4442 : 4242;
    const user = { id: `user-${attemptIndex}`, role: 'user', content: `PB02_REQUEST:${marker} Synthetic profile check.`, timestamp: started };
    messages.push(user); events.push({ type: 'messageAdded', at: started, payload: clone(user) }, { type: 'responseStarted', at: started + 1, payload: {} });
    const add = (event, offset, fields = {}) => { const value = { event, at: started + offset, wrapperPid,
      ...(event === 'rpc-request' ? { selectedProfile: raw[attemptIndex].trim() } : {}), ...fields }; common.receipts.push(value); return value; };
    if (['VALID_A', 'MISSING_VALID', 'VALID_B_RECOVERY'].includes(marker)) {
      const profile = marker === 'MISSING_VALID' ? profileValidation.missing : profileValidation.profiles[marker === 'VALID_A' ? 'A' : 'B'];
      add('invocation', 1, { args: ['--profile', profile.name, 'app-server'], kind: 'app-server', selectedProfile: profile.name,
        profileOwnedPath: profile.path, profileFileSha256: profile.sha256 ?? null, codeHomeMatches: true });
      add('start', 2, { childPid: wrapperPid + 1 });
      common.ancestry.processIdentities.push(...[wrapperPid, wrapperPid + 1].map(pid => ({ pid, startedAt: 'Sun Oct 11 10:00:00 2026' })));
      add('rpc-request', 3, { method: 'initialize', rpcIdHash: sha(`initialize-${wrapperPid}`) });
      if (marker === 'MISSING_VALID') add('exit', 15, { childPid: wrapperPid + 1, exitCode: 1, signal: null });
      else {
        const rpcIdHash = sha(`config-${wrapperPid}`), method = marker === 'VALID_A' ? 'thread/start' : 'thread/resume';
        add('rpc-request', 4, { method: 'config/read', rpcIdHash });
        add('rpc-result', 5, { method: 'config/read', rpcIdHash, success: true });
        add('profile-config', 5, { rpcIdHash, selectedProfile: profile.name, model, reasoningEffort: 'low', contextWindow: profile.contextWindow });
        add('effective-tool-config', 5, { mcpNames: [], appNames: [] });
        add('rpc-request', 6, { method, rpcIdHash: sha(`thread-${wrapperPid}`), sessionHash: method === 'thread/resume' ? sessionHash : undefined });
        session = add('session', 7, { method, sessionHash, requestedModel: model, actualModel: model, modelProvider: 'openai',
          returnedPolicy: { approvalPolicy: 'untrusted', sandbox: 'readOnly', networkAccess: false, ownedCwd: true } });
      }
    }
    if (!positive) {
      events.push({ type: 'error', at: started + 20, payload: marker === 'INVALID_SAVED' ? 'Invalid Codex profile: bad name. Change mysti.codexProfile in Settings.' : 'Codex failed: configuration profile pb02-missing not found.' });
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
    attempts.push(attempt); observations.push({ event: 'profile-attempt', at: ended, ...clone(attempt) });
  }
  const conversation = { id: conversationId, messages };
  const acceptance = { stage: 'PROFILE_VALIDATION_3', status: 'PASS_PROFILE_VALIDATION_TRANSPORT', sourceId: conversationId, panelId, replies, attempts,
    finalConversation: clone(conversation), counts: { completedTurns: 3, conversationalInputs: 3, publicUserAttempts: 5, rejectedAttempts: 2, auxiliaryInputs: 0 }, semanticReview: 'ROOT_INDEPENDENT_REVIEW_REQUIRED' };
  return { common, acceptance, stored: { conversations: [clone(conversation)] }, events, observations };
}
function seal(value) {
  fs.writeFileSync(path.join(value.common.owner.directory, 'events-main.json'), JSON.stringify(value.events), { flag: 'wx' });
  fs.writeFileSync(path.join(value.common.owner.directory, 'observations.json'), JSON.stringify(value.observations), { flag: 'wx' });
}
function verify(value) {
  const journey = audit.auditJourney(value.common, value.acceptance, value.stored);
  return { journey, permissions: audit.auditPermissions(value.common, value.acceptance, journey), attempts: audit.auditProfileAttempts(value.common, value.acceptance, journey) };
}
function control(name, mutate, accepts = false, approval = false) {
  check(name, () => { const value = fixture(approval); mutate?.(value); seal(value); if (accepts) assert.equal(verify(value).journey.proofs.length, 3); else assert.throws(() => verify(value)); });
}
control('Three exact read-only replies and five attempts join native, live and durable evidence without claiming semantic correctness', undefined, true);
control('An exact actual command permission is joined through its native response and result', undefined, true, true);
for (const [name, mutate] of [
  ['Wrong reply markers are rejected', v => { v.acceptance.replies[1].marker = 'OTHER'; }],
  ['Wrong stage is rejected', v => { v.acceptance.stage = 'FULL_25_ACCEPTANCE'; }],
  ['Mechanical status cannot claim semantic success', v => { v.acceptance.status = 'PASS_Q05_RESOLVED'; }],
  ['Root semantic review cannot be skipped', v => { v.acceptance.semanticReview = 'PASS'; }],
  ['Wrong completion count is rejected', v => { v.acceptance.counts.completedTurns = 1; }],
  ['Wrong request count is rejected', v => { v.acceptance.counts.conversationalInputs = 4; }],
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
  ['Future request markers cannot leak into first reply', v => { v.common.inputs[0].outsideMemoryMarkers.push('VALID_B_RECOVERY'); }],
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

// Keep mirrored attempt evidence consistent when testing the underlying invariant.
function syncAttempt(value, index) {
  const attempt = value.acceptance.attempts[index];
  attempt.capturedEvents = clone(value.events.filter(event => event.at >= attempt.started && event.at <= attempt.ended));
  attempt.errorEvents = clone(attempt.capturedEvents.filter(event => ['error', 'authError', 'requestCancelled'].includes(event.type)));
  const at = value.observations.findIndex(event => event.event === 'profile-attempt' && event.marker === attempt.marker);
  value.observations[at] = { event: 'profile-attempt', at: attempt.ended, ...clone(attempt) };
}
function insertReceipts(value, index, items) {
  const end = value.acceptance.attempts[index].receiptEndIndex;
  value.common.receipts.splice(end, 0, ...items);
  for (let i = index; i < value.acceptance.attempts.length; i++) {
    if (i > index) value.acceptance.attempts[i].receiptStartIndex += items.length;
    value.acceptance.attempts[i].receiptEndIndex += items.length; syncAttempt(value, i);
  }
}
function extraMissing(value) {
  const attempt = value.acceptance.attempts[3], rows = clone(value.common.receipts.slice(attempt.receiptStartIndex, attempt.receiptEndIndex));
  for (const row of rows) { row.wrapperPid = 4352; if (row.childPid) row.childPid = 4353; row.at += 20; }
  insertReceipts(value, 3, rows);
  value.common.ancestry.processIdentities.push(...[4352, 4353].map(pid => ({ pid, startedAt: 'Sun Oct 11 10:00:00 2026' })));
}
control('Native prewarm and actual send may each fail for the same exact missing profile without submitting an input', extraMissing, true);
control('Fast rejected native processes retain exact start/failure/exit evidence when they fit between ancestry samples', value => {
  value.common.ancestry.processIdentities = value.common.ancestry.processIdentities.filter(item => ![4342, 4343].includes(item.pid));
}, true);
control('A real partial assistant carried by an error is persisted exactly without inventing a completion', value => {
  const message = { id: 'actual-error-message', role: 'assistant', content: 'Partial error detail', provider: 'openai-codex', model: 'gpt-5.6-sol', toolCalls: [] };
  const event = value.events.find(event => event.type === 'error'); event.payload = { error: event.payload, message: clone(message) };
  value.stored.conversations[0].messages.splice(1, 0, clone(message));
  value.acceptance.finalConversation = clone(value.stored.conversations[0]); syncAttempt(value, 0);
}, true);
const invocation = (value, name = 'pb02-a') => value.common.receipts.find(event => event.event === 'invocation' && event.selectedProfile === name);
const profileConfig = (value, name = 'pb02-a') => value.common.receipts.find(event => event.event === 'profile-config' && event.selectedProfile === name);
for (const [name, change] of [
  ['Five attempt markers are exact and ordered', value => { value.acceptance.attempts[0].marker = 'OTHER'; }],
  ['Visible error cannot conceal the public native failure detail', value => { value.acceptance.attempts[3].visibleError = 'Error: generic failure'; syncAttempt(value, 3); }],
  ['Public user attempt count includes both rejected sends', value => { value.acceptance.counts.publicUserAttempts = 3; }],
  ['Rejected attempt count remains separate from completed replies', value => { value.acceptance.counts.rejectedAttempts = 0; }],
  ['Raw invalid setting cannot silently become empty', value => { value.acceptance.attempts[0].configRaw = ''; value.acceptance.attempts[0].configReadback = ''; syncAttempt(value, 0); }],
  ['Actual configuration readback must retain the raw whitespace', value => { value.acceptance.attempts[2].configReadback = 'pb02-a'; syncAttempt(value, 2); }],
  ['A fabricated input counter cannot conceal rejected model work', value => { value.acceptance.attempts[0].inputCountAfter = 1; syncAttempt(value, 0); }],
  ['Invalid setting must surface actionable validation detail', value => { value.events.find(event => event.type === 'error').payload = 'Generic setup failed'; syncAttempt(value, 0); }],
  ['Missing native error must identify the selected missing profile', value => { value.events.filter(event => event.type === 'error')[1].payload = 'Generic failure'; syncAttempt(value, 3); }],
  ['Authentication failure cannot substitute for profile rejection', value => { value.events.find(event => event.type === 'error').type = 'authError'; syncAttempt(value, 0); }],
  ['Duplicate visible negative errors are rejected', value => { value.events.push(clone(value.events.find(event => event.type === 'error'))); syncAttempt(value, 0); }],
  ['Failure cannot claim a successful reply ID', value => { value.acceptance.attempts[0].replyId = 'reply-0'; syncAttempt(value, 0); }],
  ['Negative error assistant cannot persist different content', value => {
    const message = { id: 'error', role: 'assistant', content: 'Shown' }, event = value.events.find(event => event.type === 'error');
    event.payload = { error: event.payload, message }; value.stored.conversations[0].messages.splice(1, 0, { ...message, content: 'Different' });
    value.acceptance.finalConversation = clone(value.stored.conversations[0]); syncAttempt(value, 0);
  }],
  ['Unreported error assistant messages are rejected', value => {
    value.stored.conversations[0].messages.splice(1, 0, { id: 'phantom', role: 'assistant', content: 'Unreported failure' });
    value.acceptance.finalConversation = clone(value.stored.conversations[0]);
  }],
  ['Invalid saved profile cannot invoke the CLI', value => insertReceipts(value, 0, [{ ...clone(invocation(value)), at: 110, wrapperPid: 4000 }])],
  ['Invalid saved profile cannot send initialize', value => insertReceipts(value, 0, [{ event: 'rpc-request', at: 110, wrapperPid: 4000, method: 'initialize', rpcIdHash: sha('hidden') }])],
  ['Exact argv must select the owned A profile', value => { invocation(value).args[1] = 'default'; }],
  ['Selected-profile receipt cannot disagree with argv', value => { invocation(value).selectedProfile = 'default'; }],
  ['Every native RPC must retain the selected profile attribution', value => { value.common.receipts.find(event => event.event === 'rpc-request').selectedProfile = 'default'; }],
  ['Owned file hash must agree with the selected native profile', value => { invocation(value).profileFileSha256 = sha('different profile'); }],
  ['Profile path cannot redirect to another file', value => { invocation(value).profileOwnedPath = '/foreign/profile'; }],
  ['Native CODEX_HOME must match the owned profile location', value => { invocation(value).codeHomeMatches = false; }],
  ['Profile context marker A must come from actual config read', value => { profileConfig(value).contextWindow = 262145; }],
  ['Profile context marker B must remain distinct', value => { profileConfig(value, 'pb02-b').contextWindow = 262144; }],
  ['Profile marker cannot join another RPC ID', value => { profileConfig(value).rpcIdHash = sha('foreign RPC'); }],
  ['Profile marker cannot come from another process', value => { profileConfig(value).wrapperPid = 999; }],
  ['Profile marker must identify the selected profile', value => { profileConfig(value).selectedProfile = 'pb02-b'; }],
  ['Loaded profile model is checked independently of thread override', value => { profileConfig(value).model = 'other'; }],
  ['Loaded profile effort is checked independently of turn override', value => { profileConfig(value).reasoningEffort = 'high'; }],
  ['Native config read failure cannot be called loaded profile success', value => { value.common.receipts.find(event => event.event === 'rpc-result' && event.method === 'config/read').success = false; }],
  ['Native profile marker cannot be recorded after thread policy overrides', value => {
    const rows = value.common.receipts, at = rows.indexOf(profileConfig(value)), item = rows.splice(at, 1)[0];
    const after = rows.findIndex(event => event.event === 'rpc-request' && event.method === 'thread/start'); rows.splice(after + 1, 0, item);
  }],
  ['Whitespace selection cannot launch a second CLI process', value => insertReceipts(value, 2, [{ ...clone(invocation(value)), at: 305, wrapperPid: 4244 }])],
  ['Whitespace selection cannot reinitialize the same process', value => insertReceipts(value, 2, [{ event: 'rpc-request', at: 305, wrapperPid: 4242, method: 'initialize', rpcIdHash: sha('reinitialize') }])],
  ['Missing-profile argv cannot silently fall back to default', value => { invocation(value, 'pb02-missing').args = ['app-server']; }],
  ['Missing profile cannot falsely claim an owned file hash', value => { invocation(value, 'pb02-missing').profileFileSha256 = sha('base config'); }],
  ['Missing native process requires a failed native outcome', value => { value.common.receipts.find(event => event.event === 'exit').exitCode = 0; }],
  ['Every repeated missing-profile process needs independent failure evidence', value => {
    extraMissing(value); value.common.receipts.find(event => event.event === 'exit' && event.wrapperPid === 4352).exitCode = 0;
  }],
  ['Native missing-profile RPC failure still requires the exact child exit receipt', value => {
    const exit = value.common.receipts.find(event => event.event === 'exit');
    Object.assign(exit, { event: 'rpc-result', method: 'initialize', rpcIdHash: sha('failed'), success: false });
  }],
  ['A repeated missing-profile process cannot select another profile', value => { extraMissing(value); value.common.receipts.find(event => event.event === 'invocation' && event.wrapperPid === 4352).args[1] = 'default'; }],
  ['Missing profile cannot reach thread creation', value => insertReceipts(value, 3, [{ event: 'rpc-request', at: 420, wrapperPid: 4342, method: 'thread/start', rpcIdHash: sha('thread') }])],
  ['Unobserved PID/birth cannot prove native profile ownership', value => { value.common.ancestry.processIdentities = value.common.ancestry.processIdentities.filter(item => item.pid !== 4243); }],
  ['Receipt bounds cannot overlap adjacent attempts', value => { value.acceptance.attempts[2].receiptStartIndex--; syncAttempt(value, 2); }],
  ['Hidden late native invocation cannot disappear outside attempt bounds', value => { value.common.receipts.push({ ...clone(invocation(value)), at: 900, wrapperPid: 4999 }); }],
  ['Hidden late initialize cannot disappear outside attempt bounds', value => { value.common.receipts.push({ event: 'rpc-request', at: 900, wrapperPid: 4999, method: 'initialize', rpcIdHash: sha('late') }); }],
  ['Single-shot execution fallback is rejected regardless of reply success', value => { value.common.receipts.push({ event: 'invocation', kind: 'exec', at: 900, wrapperPid: 4999, args: ['exec'] }); }],
  ['A CLI probe cannot conceal non-version arguments', value => { value.common.receipts.push({ event: 'invocation', kind: 'probe', at: 900, wrapperPid: 4999, args: ['exec', '-'] }); }],
  ['Late public errors cannot disappear outside the five attempted sends', value => { value.events.push({ type: 'error', at: 900, payload: 'Late failure' }); }],
]) control(name, change);

// Exercise the exact native/live/persisted-output verifier used by auditJourney.
function toolFixture(output = 'Owned exact source read\n') {
  const workspace = '/owned';
  const live = { id: 'actual-item', name: 'Bash', status: 'completed', input: { cwd: workspace, command: ['/bin/zsh', '-lc', audit.scopes.VALID_A.commands[0]] }, output };
  const persisted = clone(live); if (output.length > 4096) { persisted.output = output.slice(0, 4096); persisted.truncated = true; }
  const input = { inputIndex: 1, sessionHash: sha('thread') }, turnHash = sha('turn');
  const start = { event: 'tool-start', itemIdHash: sha(live.id), sessionHash: input.sessionHash, turnHash, inputIndex: 1, type: 'commandExecution' };
  const result = { ...start, event: 'tool-result', status: 'completed', exitCode: 0, ownedCwd: true, commandSha256: sha(JSON.stringify(live.input.command)), outputSha256: sha(output) };
  return { common: { owner: { workspace } }, input, turnHash, tools: [persisted], wire: [start, result], scope: clone(audit.scopes.VALID_A), events: [{ type: 'toolResult', payload: live }] };
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
  failed: checks.filter(value => value.status === 'FAIL').length, checks, auditorSha256: sha(fs.readFileSync(require.resolve('./audit-vscode-codex-profile-validation.cjs'))),
  inferenceInputs: 0, editorLaunches: 0, scope: 'Synthetic receipt, approval, live-output and durable-conversation controls. Filesystem/preserved-tree checks are covered by dedicated preparation controls; native semantic correctness is not claimed.' };
fs.writeFileSync(path.join(directory, 'checks.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ directory, status: result.status, passed: result.passed, failed: result.failed, failures: checks.filter(value => value.status === 'FAIL') }));
if (result.failed) process.exitCode = 1;
