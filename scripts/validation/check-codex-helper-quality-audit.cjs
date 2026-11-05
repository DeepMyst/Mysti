/* Synthetic owned helper-quality evidence controls. No editor, model, or production writes. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const audit = require('./audit-vscode-codex-helper-quality.cjs');
const { buildCases, buildAllowlist } = require('./codex-helper-quality-contract.cjs');
const sha = value => createHash('sha256').update(value).digest('hex'), clone = value => structuredClone(value);
const directory = fs.mkdtempSync(path.resolve(__dirname, '../../out-test/feature-tests/PB-02/codex-helper-quality-audit-controls-'));
const checks = []; let fixtureIndex = 0;
function check(name, run) { try { run(); checks.push({ name, status: 'PASS' }); } catch (error) { checks.push({ name, status: 'FAIL', error: error.message }); } }
function classification(caseId) {
  if (caseId === 'NONE') return { questions: [], planOptions: [], context: 'Explanation only.' };
  if (caseId === 'PLANS') return { questions: [], planOptions: [
    { id: 'same', title: 'Café local checks', summary: 'Keep checks in boundedDelay.', approach: 'Validate finite inputs inside boundedDelay.', pros: ['One place'], cons: ['Repetition'], complexity: 'low' },
    { id: 'same', title: 'مرحبا shared checks', summary: 'Extract shared validation.', approach: 'Share validateRetryPolicy between boundedDelay and jitter.', pros: ['Consistency'], cons: ['Indirection'], complexity: 'medium' },
  ], context: 'Two approaches.' };
  return { questions: [{ id: 'q1', question: 'Which format should the Café مرحبا report use?', inputType: 'radio', questionType: 'clarifying',
    options: [{ id: 'a', label: 'JSON', value: 'json' }, { id: 'b', label: 'CSV', value: 'csv' }], required: true }], planOptions: [], context: 'Missing preference.' };
}
function fixture() {
  const owned = path.join(directory, `case-${++fixtureIndex}`); fs.mkdirSync(owned);
  const owner = { directory: owned, workspace: path.join(owned, 'workspace'), cliDirectory: path.join(owned, 'cli') };
  fs.mkdirSync(owner.cliDirectory); const outputDirectory = path.join(owner.cliDirectory, 'helper-outputs'); fs.mkdirSync(outputDirectory, { mode: 0o700 });
  const cases = buildCases('PB02_SERVICE_abcdef'), allowlist = buildAllowlist(cases), model = 'gpt-5.6-sol';
  const files = { 'README.md': { sha256: sha('immutable'), bytes: 9 } }, snapshot = { hashes: { 'README.md': sha('immutable') } };
  const common = { owner, inputs: [], receipts: [], manifest: { model, token: 'PB02_SERVICE_abcdef', cases, allowlist, fixture: { files } } };
  const acceptance = { stage: 'HELPER_QUALITY_3', status: 'CAPTURED_HELPER_QUALITY_3', panels: [],
    counts: { completedTurns: 3, conversationalInputs: 3, auxiliaryInputs: 0 }, semanticReview: 'ROOT_INDEPENDENT_REVIEW_REQUIRED' };
  const stored = { conversations: [] }, observations = [], eventSets = {}, auxiliaryReceipts = [];
  let helperIndex = 0;
  cases.forEach((definition, index) => {
    const at = 100 + index * 10000, panelId = `panel-${index}`, conversationId = `conversation-${index}`, wrapperPid = 5000 + index * 10;
    const sessionHash = sha(`thread-${index}`), turnHash = sha(`turn-${index}`), inputIndex = index + 1;
    const events = [{ type: 'initialState', at: at - 1, payload: { panelId } }]; eventSets[definition.caseId] = events;
    const user = { id: `user-${index}`, role: 'user', content: definition.prompt, timestamp: at };
    events.push({ type: 'messageAdded', at, payload: clone(user) }, { type: 'responseStarted', at: at + 1, payload: {} });
    const add = (event, offset, data = {}) => { const row = { event, at: at + offset, wrapperPid, ...data }; common.receipts.push(row); return row; };
    add('invocation', 1, { kind: 'app-server', args: ['app-server'] }); add('start', 2, { childPid: wrapperPid + 1 });
    add('effective-tool-config', 3, { mcpNames: [], appNames: [] });
    const session = add('session', 4, { method: 'thread/start', sessionHash, requestedModel: model, actualModel: model, modelProvider: 'openai',
      returnedPolicy: { approvalPolicy: 'untrusted', sandbox: 'readOnly', networkAccess: false, ownedCwd: true } });
    const input = add('request', 5, { inputIndex, sessionHash, model, effort: 'low', outsideMemoryMarkers: [definition.marker],
      policy: { approvalPolicy: 'untrusted', sandbox: 'read-only', ownedCwd: true, effort: 'low', mcpAllDisabled: true, appsAllDisabled: true, appsDefaultDisabled: true, mcpNames: [], appNames: [] } });
    common.inputs.push(input); add('turn-started', 6, { inputIndex, sessionHash, turnHash });
    add('assistant-message', 19, { inputIndex, sessionHash, turnHash, itemType: 'agentMessage', itemIdHash: sha(`item-${index}`), phase: 'final_answer', textBytes: Buffer.byteLength(definition.expectedReply), textSha256: sha(definition.expectedReply) });
    const completed = add('turn-completed', 20, { inputIndex, sessionHash, turnHash, status: 'completed' });
    const assistant = { id: `reply-${index}`, role: 'assistant', provider: 'openai-codex', model, content: definition.expectedReply, toolCalls: [], timestamp: at + 25 };
    const conversation = { id: conversationId, title: `Café ${definition.caseId}`, messages: [user, assistant] }; stored.conversations.push(clone(conversation));
    events.push({ type: 'responseComplete', at: at + 25, payload: { message: clone(assistant) } });
    const reply = { ordinal: index + 1, marker: definition.marker, panelId, conversationId, messageId: assistant.id, provider: 'openai-codex', model,
      content: assistant.content, scope: {}, tools: [], nativeTools: [], toolOutputEvidence: [], permissionDecisionIds: [], request: clone(input), nativeSession: clone(session), turnCompleted: clone(completed),
      started: at, completedAt: at + 25, beforeFiles: clone(snapshot) };
    observations.push({ event: 'native-response', at: at + 26, ...clone(reply), afterFiles: clone(snapshot) });
    const panel = { caseId: definition.caseId, panelId, conversationId, reply, userMessage: clone(user), finalConversation: clone(conversation), tab: { label: 'Mysti', viewType: 'mainThreadWebview-mysti.detachedChat' },
      helperWait: { started: at + 25, deadline: at + 35025, ended: at + 100, timedOut: false },
      dom: { capturedAt: at + 103, title: { historyConversationId: conversationId, historyTitle: conversation.title, historyOpenedAt: at + 95, visibleAt: at + 99 },
        titleObservations: [{ conversationId, title: conversation.title, at: at + 99, visible: true }], suggestions: [], plans: [], questions: [] } };
    for (const purpose of audit.PURPOSES) {
      const helperPid = 6000 + ++helperIndex, entry = allowlist.entries.find(value => value.caseId === definition.caseId && value.purpose === purpose);
      const text = purpose === 'title' ? conversation.title : purpose === 'classification' ? JSON.stringify(classification(definition.caseId))
        : JSON.stringify([{ title: 'Review café 😀', description: 'Inspect the owned example', prompt: 'Explain the owned example.' }]);
      const bytes = Buffer.from(text), relativePath = `helper-outputs/${helperIndex}-${helperPid}.stdout`;
      fs.writeFileSync(path.join(owner.cliDirectory, relativePath), bytes, { mode: 0o600, flag: 'wx' });
      const inputAt = at + (purpose === 'title' ? 5 : 26), resultAt = at + (purpose === 'title' ? 30 : 40);
      const base = { wrapperPid: helperPid, inputIndex: helperIndex };
      const submitted = { ...base, inputBytes: entry.inputBytes, inputSha256: entry.inputSha256, inputEnded: true, purpose };
      auxiliaryReceipts.push({ ...base, event: 'auxiliary-start', at: inputAt - 2 }, { ...base, event: 'auxiliary-input', at: inputAt - 1 },
        { ...submitted, event: 'auxiliary-submission', at: inputAt },
        { ...submitted, event: 'auxiliary-capture-authorization', at: inputAt, status: 'OWNED_ALLOWLIST', caseId: definition.caseId },
        { ...base, event: 'auxiliary-output-progress', at: resultAt - 1, stream: 'stdout', bytes: bytes.length, sha256: sha(bytes) },
        { ...base, event: 'auxiliary-output-capture', at: resultAt - 1, caseId: definition.caseId, purpose, inputSha256: entry.inputSha256, completeInput: true,
          relativePath, bytes: bytes.length, sha256: sha(bytes), overflow: false },
        { ...submitted, event: 'auxiliary-result', at: resultAt, exitCode: 0, signal: null, stdoutBytes: bytes.length, stdoutSha256: sha(bytes) },
        { ...base, event: 'exit', at: resultAt + 1, exitCode: 0, signal: null });
      const parsed = audit.parseHelperOutput(purpose, text);
      if (purpose === 'title') events.push({ type: 'titleUpdated', at: resultAt + 2, payload: { conversationId, title: parsed } });
      if (purpose === 'suggestion') {
        const suggestions = parsed.map((value, n) => ({ id: `suggestion-${at + 42}-${n}`, ...value }));
        events.push({ type: 'suggestionsReady', at: resultAt + 2, payload: { suggestions } });
        panel.dom.suggestions = parsed.map(value => ({ title: value.title, tooltip: value.description || value.message, color: value.color, icon: value.icon }));
      }
      if (purpose === 'classification' && definition.caseId === 'PLANS') {
        events.push({ type: 'planOptions', at: resultAt + 2, payload: { options: parsed.planOptions, messageId: reply.messageId, originalQuery: definition.prompt, syntheticPlanId: `plan-${index}`, conversationId } });
        panel.dom.plans = parsed.planOptions.map(value => ({ optionId: value.id, messageId: reply.messageId, title: value.title, summary: value.summary, complexity: value.complexity, text: value.title + '\n' + value.summary }));
      }
      if (purpose === 'classification' && definition.caseId === 'QUESTIONS') {
        const questions = parsed.questions.map(value => ({ question: value.question, header: value.question, options: value.options.map(option => ({ label: option.label, description: option.description || '' })), multiSelect: false }));
        events.push({ type: 'askUserQuestion', at: resultAt + 2, payload: { source: 'detected', messageId: reply.messageId, toolCallId: 'delivery-uuid', questions } });
        panel.dom.questions = [{ toolCallId: 'delivery-uuid', text: questions[0].question + '\nJSON\nCSV', questionTexts: questions.map(value => value.question), optionLabels: questions.flatMap(value => value.options.map(option => option.label)) }];
      }
    }
    events.push({ type: 'conversationHistory', at: at + 98, payload: { conversations: [clone(conversation)], currentId: conversationId } }); events.sort((a, b) => a.at - b.at);
    const receiptStartIndex = common.receipts.length;
    const summary = add('stderr-summary', 107, { bytes: 0, sha256: sha(''), runtimeOnlyProfileArgument: false });
    const exit = add('exit', 108, { childPid: wrapperPid + 1, exitCode: null, signal: 'SIGTERM' });
    panel.lifecycleBoundary = { action: 'public-owned-chat-tab-close', panelId, tab: clone(panel.tab), started: at + 105, closedAt: at + 106, ended: at + 110,
      closeAccepted: true, tabAbsent: true, frameDetached: true, tabCloseEventSeen: true, receiptStartIndex, receiptEndIndex: common.receipts.length,
      finalWrapperPid: wrapperPid, finalChildPid: wrapperPid + 1, finalInputIndex: inputIndex, terminalStatus: 'complete', summary: clone(summary), exit: clone(exit), inputCountBefore: inputIndex, inputCountAfter: inputIndex };
    observations.push({ event: 'owned-chat-tab', at: at + 104, caseId: definition.caseId, panelId, ...clone(panel.tab) },
      { event: 'lifecycle-boundary', at: at + 111, caseId: definition.caseId, ...clone(panel.lifecycleBoundary) });
    acceptance.panels.push(panel);
  });
  return { common, acceptance, stored, observations, eventSets, auxiliaryReceipts, auxiliary: { outputDirectory } };
}
function seal(value) {
  fs.writeFileSync(path.join(value.common.owner.directory, 'observations.json'), JSON.stringify(value.observations), { flag: 'wx' });
  for (const [caseId, events] of Object.entries(value.eventSets)) fs.writeFileSync(path.join(value.common.owner.directory, `events-${caseId}.json`), JSON.stringify(events), { flag: 'wx' });
  for (const panel of value.acceptance.panels) fs.writeFileSync(path.join(value.common.owner.directory, `title-observations-${panel.caseId}.json`), JSON.stringify(panel.dom.titleObservations), { flag: 'wx' });
}
function verify(value) {
  const journey = audit.auditJourney(value.common, value.acceptance, value.stored);
  const lifecycle = audit.auditMainLifecycle(value.common, journey);
  const captured = audit.auditCapturedOutputs(value.common.owner, value.common.manifest.allowlist, value.auxiliaryReceipts, value.auxiliary);
  const quality = audit.auditHelperQuality(value.common, journey, captured);
  return { journey, lifecycle, captured, quality, status: audit.aggregateStatus(lifecycle, quality) };
}
function control(name, change, expected = 'FAIL') {
  check(name, () => { const value = fixture(); change?.(value); seal(value);
    if (expected === 'FAIL') assert.throws(() => verify(value));
    else { const result = verify(value); assert.equal(result.status, expected); if (expected === 'PASS_HELPER_QUALITY') assert.equal(result.quality.verifiedOutputs, 9); }
  });
}
control('Three native replies and all nine actual helper outputs join owned live, DOM and durable evidence', undefined, 'PASS_HELPER_QUALITY');
control('Suggestions can be cleared after a valid helper response when interactive cards arrive', value => {
  for (const panel of value.acceptance.panels.slice(1)) { value.eventSets[panel.caseId].push({ type: 'clearSuggestions', at: panel.dom.capturedAt - 1 }); panel.dom.suggestions = []; }
}, 'PASS_HELPER_QUALITY');
for (const [name, mutate] of [
  ['Wrong stage cannot be accepted', v => { v.acceptance.stage = 'PROFILE_LIFECYCLE_2'; }],
  ['Native collection cannot claim transport acceptance', v => { v.acceptance.status = 'PASS_HELPER_QUALITY_TRANSPORT'; }],
  ['Main reply count is exact', v => { v.acceptance.counts.completedTurns = 2; }],
  ['Main inputs cannot hide helpers', v => { v.acceptance.counts.auxiliaryInputs = 9; }],
  ['Panels cannot share ownership identities', v => { v.acceptance.panels[1].panelId = v.acceptance.panels[0].panelId; }],
  ['Cases cannot share a native thread', v => { v.common.receipts.find(row => row.event === 'session' && row.wrapperPid === 5010).sessionHash = sha('thread-0'); }],
  ['A different requested model fails transport evidence', v => { v.common.inputs[0].model = 'other'; }],
  ['High effort cannot silently replace the selected Low', v => { v.common.inputs[0].effort = 'high'; }],
  ['Untrusted policy cannot be disabled', v => { v.common.inputs[0].policy.approvalPolicy = 'never'; }],
  ['Native external tools remain disabled', v => { v.common.inputs[0].policy.appsAllDisabled = false; }],
  ['An actual native tool is never authorized', v => { v.common.receipts.push({ event: 'tool-start', wrapperPid: 5020 }); }],
  ['A public permission request is never authorized', v => { v.eventSets.NONE.push({ type: 'permissionRequest', at: 125 }); }],
  ['An autonomous decision cannot earn passive helper quality credit', v => { v.eventSets.NONE.push({ type: 'autonomousDecision', at: 145 }); }],
  ['A plan auto-selection timer is outside the manual scenario', v => { v.eventSets.NONE.push({ type: 'semiAutonomousPlanTimer', at: 145 }); }],
  ['A question auto-answer timer is outside the manual scenario', v => { v.eventSets.NONE.push({ type: 'semiAutonomousQuestionTimer', at: 145 }); }],
  ['Native assistant hashes must match actual public text', v => { v.common.receipts.find(row => row.event === 'assistant-message').textSha256 = sha('changed'); }],
  ['Missing native assistant metadata cannot earn literal credit', v => { v.common.receipts = v.common.receipts.filter(row => !(row.event === 'assistant-message' && row.inputIndex === 1)); }],
  ['Live assistant content must equal durable content', v => { v.eventSets.NONE.find(row => row.type === 'responseComplete').payload.message.content = 'changed'; }],
  ['Exact owned user prompt cannot change in storage', v => { v.stored.conversations[0].messages[0].content = 'foreign'; }],
  ['Foreign conversational work cannot disappear', v => { v.stored.conversations.push({ id: 'foreign', messages: [{ role: 'user', content: 'foreign' }] }); }],
  ['Missing native terminal is rejected', v => { v.common.receipts = v.common.receipts.filter(row => !(row.event === 'turn-completed' && row.inputIndex === 1)); }],
  ['Named profile invocation is forbidden', v => { v.common.receipts.find(row => row.event === 'invocation').args = ['--profile', 'private', 'app-server']; }],
  ['Missing final stderr summary preserves strict lifecycle failure', v => { v.common.receipts = v.common.receipts.filter(row => !(row.event === 'stderr-summary' && row.wrapperPid === 5020)); }],
  ['Missing final exit preserves strict lifecycle failure', v => { v.common.receipts.pop(); }],
  ['No native restart after the final tab closes', v => { v.common.receipts.push({ event: 'rpc-request', wrapperPid: 5020, at: 2300 }); }],
  ['Tab close must be publicly accepted', v => { v.acceptance.panels[0].lifecycleBoundary.closeAccepted = false; }],
  ['Actual tab-close event is required', v => { v.acceptance.panels[0].lifecycleBoundary.tabCloseEventSeen = false; }],
  ['Foreign tab cannot close this case', v => { v.acceptance.panels[0].lifecycleBoundary.tab.viewType = 'other'; }],
  ['Post-close public events cannot be invented', v => { v.eventSets.NONE.push({ type: 'settingsSync', at: 300 }); }],
]) control(name, mutate);

const capture = (v, index = 1) => v.auxiliaryReceipts.find(row => row.event === 'auxiliary-output-capture' && row.inputIndex === index);
const result = (v, index = 1) => v.auxiliaryReceipts.find(row => row.event === 'auxiliary-result' && row.inputIndex === index);
function replaceBody(v, index, text) {
  const row = capture(v, index), bytes = Buffer.from(text); fs.writeFileSync(path.join(v.common.owner.cliDirectory, row.relativePath), bytes);
  row.bytes = bytes.length; row.sha256 = sha(bytes); Object.assign(result(v, index), { stdoutBytes: bytes.length, stdoutSha256: sha(bytes) });
}
for (const [name, mutate] of [
  ['Captured output path cannot escape its owning CLI directory', v => { capture(v).relativePath = '../foreign.stdout'; }],
  ['Captured bytes require the exact recorded digest', v => { fs.appendFileSync(path.join(v.common.owner.cliDirectory, capture(v).relativePath), 'changed'); }],
  ['Capture cannot claim an unrelated completed input', v => { capture(v).inputSha256 = sha('foreign'); }],
  ['Capture authorization must match exact stdin bytes', v => { v.auxiliaryReceipts.find(row => row.event === 'auxiliary-capture-authorization').inputBytes++; }],
  ['Unknown inputs cannot authorize body retention', v => { v.auxiliaryReceipts.find(row => row.event === 'auxiliary-capture-authorization').status = 'UNKNOWN_UNRETAINED'; }],
  ['Incomplete stdin cannot authorize body retention', v => { capture(v).completeInput = false; }],
  ['Duplicate authorization cannot hide multiple ownership claims', v => { v.auxiliaryReceipts.push(clone(v.auxiliaryReceipts.find(row => row.event === 'auxiliary-capture-authorization'))); }],
  ['Progressive capture prefix must match actual file bytes', v => { const row = clone(capture(v)); row.bytes--; row.sha256 = sha('wrong'); v.auxiliaryReceipts.splice(v.auxiliaryReceipts.indexOf(capture(v)), 0, row); }],
  ['Final full native output must match retained bytes', v => { result(v).stdoutSha256 = sha('different'); }],
  ['Capture files remain private', v => { fs.chmodSync(path.join(v.common.owner.cliDirectory, capture(v).relativePath), 0o644); }],
  ['An unaccounted body file is rejected', v => { fs.writeFileSync(path.join(v.auxiliary.outputDirectory, 'foreign.stdout'), 'x', { mode: 0o600 }); }],
  ['A symlink body file is rejected', v => { const file = path.join(v.common.owner.cliDirectory, capture(v).relativePath); fs.renameSync(file, file + '.original'); fs.symlinkSync(file + '.original', file); }],
  ['Oversized retained output is rejected', v => { replaceBody(v, 1, 'x'.repeat(32769)); }],
  ['Overflow flag requires the actual limit receipt', v => { capture(v).overflow = true; }],
  ['Manifest output directory cannot redirect retained bodies', v => { v.auxiliary.outputDirectory = v.common.owner.directory; }],
]) control(name, mutate);
for (const [name, mutate] of [
  ['Malformed classification remains partial with no classification credit', v => { replaceBody(v, 2, '{invalid'); }],
  ['Malformed suggestions remain partial with no suggestion credit', v => { replaceBody(v, 3, '[invalid'); }],
  ['Nonzero helper process cannot earn credit for plausible output', v => { result(v).exitCode = 1; }],
  ['A signalled helper cannot earn semantic credit', v => { result(v).exitCode = null; result(v).signal = 'SIGTERM'; }],
  ['Unknown helper terminal remains partial', v => { v.auxiliaryReceipts = v.auxiliaryReceipts.filter(row => !(row.inputIndex === 1 && ['auxiliary-result', 'exit'].includes(row.event))); }],
  ['Empty successful helper remains partial', v => { replaceBody(v, 1, ''); }],
  ['Wrong title in public UI remains partial', v => { v.eventSets.NONE.find(row => row.type === 'titleUpdated').payload.title = 'wrong'; }],
  ['Title must be visible in the correct owned history row', v => { v.acceptance.panels[0].dom.title.historyConversationId = 'foreign'; }],
  ['Title helper alone cannot prove the visible title', v => { v.acceptance.panels[0].dom.title.historyTitle = 'wrong'; }],
  ['Missing public title update is partial', v => { v.eventSets.NONE = v.eventSets.NONE.filter(row => row.type !== 'titleUpdated'); }],
  ['Missing public history evidence is partial', v => { v.eventSets.NONE = v.eventSets.NONE.filter(row => row.type !== 'conversationHistory'); }],
  ['Title visibility requires an actual matching passive DOM observation', v => { v.acceptance.panels[0].dom.titleObservations = []; }],
  ['Title visibility cannot borrow a different title observation', v => { v.acceptance.panels[0].dom.titleObservations[0].title = 'foreign'; }],
  ['Wrong normalized suggestion payload remains partial', v => { v.eventSets.NONE.find(row => row.type === 'suggestionsReady').payload.suggestions[0].message = 'wrong'; }],
  ['Wrong suggestion tooltip remains partial', v => { v.acceptance.panels[0].dom.suggestions[0].tooltip = 'wrong'; }],
  ['Missing visible suggestions without an actual clear remains partial', v => { v.acceptance.panels[0].dom.suggestions = []; }],
  ['Plan cards must retain distinct normalized IDs', v => { v.acceptance.panels[1].dom.plans[1].optionId = 'same'; }],
  ['Plan event must belong to this actual assistant reply', v => { v.eventSets.PLANS.find(row => row.type === 'planOptions').payload.messageId = 'foreign'; }],
  ['Plan event must belong to this actual conversation', v => { v.eventSets.PLANS.find(row => row.type === 'planOptions').payload.conversationId = 'foreign'; }],
  ['Helper none outcome cannot be inferred from a missing card alone', v => { replaceBody(v, 2, JSON.stringify(classification('PLANS'))); }],
  ['Unexpected public plan on the NONE case remains partial', v => { v.eventSets.NONE.push({ type: 'planOptions', at: 142, payload: {} }); }],
  ['Question must retain detected source attribution', v => { v.eventSets.QUESTIONS.find(row => row.type === 'askUserQuestion').payload.source = 'native'; }],
  ['Question card must join the actual public delivery UUID', v => { v.acceptance.panels[2].dom.questions[0].toolCallId = 'foreign'; }],
  ['Question labels must match normalized native output', v => { v.acceptance.panels[2].dom.questions[0].optionLabels[1] = 'XML'; }],
]) control(name, mutate, 'PARTIAL_HELPER_QUALITY');

check('Unknown completed input stays metadata-only and cannot earn body or semantic credit', () => {
  const v = fixture(), index = 2, rows = v.auxiliaryReceipts.filter(row => row.inputIndex === index), old = capture(v, index);
  fs.unlinkSync(path.join(v.common.owner.cliDirectory, old.relativePath)); v.auxiliaryReceipts = v.auxiliaryReceipts.filter(row => row !== old);
  for (const row of rows.filter(row => ['auxiliary-submission', 'auxiliary-capture-authorization', 'auxiliary-result'].includes(row.event))) row.inputSha256 = sha('unknown literal');
  const auth = rows.find(row => row.event === 'auxiliary-capture-authorization'); auth.status = 'UNKNOWN_UNRETAINED'; delete auth.caseId;
  seal(v); const verified = verify(v); assert.equal(verified.quality.status, 'PARTIAL_HELPER_QUALITY'); assert(verified.quality.issues.some(value => value.code === 'UNKNOWN_HELPER_INPUT_UNRETAINED'));
});
check('Literal mismatch preserves exact native/live/durable evidence and earns no quality credit for that case', () => {
  const v = fixture(), panel = v.acceptance.panels[0], text = 'Unexpected but fully observed café reply.';
  panel.reply.content = text; panel.finalConversation.messages[1].content = text; v.stored.conversations[0].messages[1].content = text;
  v.eventSets.NONE.find(row => row.type === 'responseComplete').payload.message.content = text;
  v.observations.find(row => row.event === 'native-response').content = text;
  Object.assign(v.common.receipts.find(row => row.event === 'assistant-message'), { textBytes: Buffer.byteLength(text), textSha256: sha(text) });
  seal(v); const verified = verify(v); assert.equal(verified.quality.status, 'PARTIAL_HELPER_QUALITY');
  assert.equal(verified.quality.verifiedOutputs, 6); assert(verified.quality.issues.some(value => value.code === 'MAIN_LITERAL_MISMATCH'));
});
check('Independent helper normalization preserves Unicode and reserves future valid plan handles', () => {
  const parsed = audit.parseHelperOutput('classification', JSON.stringify({ questions: [], context: 'مرحبا', planOptions: [
    { title: 'Café', approach: 'A' }, { id: 'plan1', title: '€ 😀', approach: 'B' }, { id: 'plan1', title: 'C', approach: 'C' },
  ] }));
  assert.deepEqual(parsed.planOptions.map(value => value.id), ['plan1-1', 'plan1', 'plan3']);
  assert.deepEqual(parsed.planOptions.map(value => value.title), ['Café', '€ 😀', 'C']); assert.equal(parsed.context, 'مرحبا');
});
for (const [name, purpose, text] of [
  ['Malformed title cannot be empty', 'title', '   '],
  ['Classifier empty arrays must actually be arrays', 'classification', '{"questions":{},"planOptions":[],"context":"x"}'],
  ['Malformed question must not silently earn empty credit', 'classification', '{"questions":[{"question":3}],"planOptions":[],"context":"x"}'],
  ['An optionless malformed question cannot be silently filtered into NONE', 'classification', '{"questions":[{"question":"Choose one","options":[]}],"planOptions":[],"context":"x"}'],
  ['An unknown question input type cannot be given semantic credit', 'classification', '{"questions":[{"question":"Choose one","inputType":"alien","options":[{"label":"A"}]}],"planOptions":[],"context":"x"}'],
  ['Suggestion arrays must contain actual useful entries', 'suggestion', '[]'],
  ['Suggestion prompt cannot be missing', 'suggestion', '[{"title":"a","description":"b"}]'],
]) check(name, () => assert.throws(() => audit.parseHelperOutput(purpose, text)));
const native = (id, text, itemType = 'agentMessage') => ({ itemIdHash: sha(id), itemType, textBytes: Buffer.byteLength(text), textSha256: sha(text) });
check('Native commentary and final answer join only through the product two-newline boundary', () => {
  const rows = [native('a', 'Café commentary.'), native('b', 'مرحبا final 😀')];
  assert.equal(audit.joinNativeAssistantMessages(rows, 'Café commentary.\n\nمرحبا final 😀').messages, 2);
  assert.throws(() => audit.joinNativeAssistantMessages(rows, 'Café commentary.مرحبا final 😀'));
});
check('Native plan text is accounted as assistant content', () => assert.equal(audit.joinNativeAssistantMessages([native('a', 'Plan text', 'plan')], 'Plan text').messages, 1));
check('Existing newline boundaries must not gain invented extra lines', () => {
  const rows = [native('a', 'First\n'), native('b', '\nSecond')]; assert.equal(audit.joinNativeAssistantMessages(rows, 'First\n\nSecond').messages, 2);
  assert.throws(() => audit.joinNativeAssistantMessages(rows, 'First\n\n\nSecond'));
});
check('Native duplicated item receipts cannot manufacture public text', () => assert.throws(() => audit.joinNativeAssistantMessages([native('a', 'x'), native('a', 'x')], 'x\n\nx')));

function syncBoundary(v, index) {
  const panel = v.acceptance.panels[index], observed = v.observations.find(row => row.event === 'lifecycle-boundary' && row.caseId === panel.caseId);
  Object.assign(observed, clone(panel.lifecycleBoundary), { at: panel.lifecycleBoundary.ended + 1 });
}
function unknownMainShutdown(v, index, missing = ['stderr-summary', 'exit']) {
  const panel = v.acceptance.panels[index], boundary = panel.lifecycleBoundary;
  const removed = v.common.receipts.flatMap((row, i) => row.wrapperPid === boundary.finalWrapperPid && missing.includes(row.event) ? [i] : []);
  v.common.receipts = v.common.receipts.filter((row, i) => !removed.includes(i));
  for (const [i, value] of v.acceptance.panels.entries()) {
    for (const key of ['receiptStartIndex', 'receiptEndIndex']) value.lifecycleBoundary[key] -= removed.filter(n => n < value.lifecycleBoundary[key]).length;
    if (i === index) {
      value.lifecycleBoundary.terminalStatus = 'UNOBSERVED';
      if (missing.includes('stderr-summary')) value.lifecycleBoundary.summary = null;
      if (missing.includes('exit')) value.lifecycleBoundary.exit = null;
      value.lifecycleBoundary.ended = value.lifecycleBoundary.closedAt + 2000;
    }
    syncBoundary(v, i);
  }
}
check('Complete helper quality stays independently verified when all three exact final main shutdowns are unobserved', () => {
  const v = fixture(); for (let index = 0; index < 3; index++) unknownMainShutdown(v, index);
  seal(v); const verified = verify(v);
  assert.equal(verified.status, 'PARTIAL_MAIN_SHUTDOWN'); assert.equal(verified.lifecycle.status, 'PARTIAL_MAIN_SHUTDOWN');
  assert.equal(verified.lifecycle.issues.length, 3); assert.equal(verified.quality.status, 'PASS_HELPER_QUALITY'); assert.equal(verified.quality.verifiedOutputs, 9);
  for (const process of verified.lifecycle.processes) { assert.equal(process.summary, null); assert.equal(process.exit, null); }
});
control('Observed stderr with an unobserved final exit remains a bounded partial', v => unknownMainShutdown(v, 2, ['exit']), 'PARTIAL_MAIN_SHUTDOWN');
control('Observed exit with an unobserved stderr summary remains a bounded partial', v => unknownMainShutdown(v, 2, ['stderr-summary']), 'PARTIAL_MAIN_SHUTDOWN');
control('Both helper quality and main shutdown absence retain independent partial statuses', v => {
  unknownMainShutdown(v, 2); replaceBody(v, 2, '{invalid');
}, 'PARTIAL_HELPER_QUALITY_AND_MAIN_SHUTDOWN');
for (const [name, mutate] of [
  ['An observed main terminal cannot be hidden by null', v => { const b = v.acceptance.panels[2].lifecycleBoundary; b.summary = null; b.exit = null; b.terminalStatus = 'UNOBSERVED'; syncBoundary(v, 2); }],
  ['Unknown shutdown cannot claim complete transport', v => { unknownMainShutdown(v, 2); v.acceptance.panels[2].lifecycleBoundary.terminalStatus = 'complete'; syncBoundary(v, 2); }],
  ['Unknown shutdown still requires the exact child identity', v => { unknownMainShutdown(v, 2); v.acceptance.panels[2].lifecycleBoundary.finalChildPid++; syncBoundary(v, 2); }],
  ['Unknown shutdown still requires actual frame destruction', v => { unknownMainShutdown(v, 2); v.acceptance.panels[2].lifecycleBoundary.frameDetached = false; syncBoundary(v, 2); }],
  ['Unknown exit cannot shorten the actual two-second observation', v => { unknownMainShutdown(v, 2); v.acceptance.panels[2].lifecycleBoundary.ended--; syncBoundary(v, 2); }],
  ['Duplicate main exits cannot be collapsed', v => { v.common.receipts.push(clone(v.common.receipts.at(-1))); }],
  ['A present terminal cannot have a foreign child PID', v => { v.common.receipts.at(-1).childPid++; }],
  ['A present stderr terminal cannot claim invalid digest metadata', v => { v.common.receipts.find(row => row.event === 'stderr-summary').sha256 = sha('nonempty'); }],
  ['Unowned incomplete app-server invocation cannot use the case shutdown exception', v => { v.common.receipts.push({ event: 'invocation', kind: 'app-server', args: ['app-server'], wrapperPid: 9000, at: 40000 }, { event: 'start', wrapperPid: 9000, childPid: 9001, at: 40001 }); }],
]) control(name, mutate);
function overlappingProbe(v) {
  const boundary = v.acceptance.panels[2].lifecycleBoundary, at = boundary.started;
  v.common.receipts.push({ event: 'invocation', kind: 'probe', args: ['--version'], wrapperPid: 9000, at: at + 1 },
    { event: 'probe-start', wrapperPid: 9000, childPid: 9001, at: at + 2 },
    { event: 'stderr-summary', wrapperPid: 9000, at: at + 3, bytes: 0, sha256: sha(''), runtimeOnlyProfileArgument: false },
    { event: 'probe-exit', wrapperPid: 9000, childPid: 9001, at: at + 4, exitCode: 0, signal: null });
  v.common.receipts.sort((a, b) => a.at - b.at); boundary.receiptEndIndex = v.common.receipts.length; syncBoundary(v, 2);
}
control('A complete exact --version discovery probe may overlap public tab close without model work', overlappingProbe, 'PASS_HELPER_QUALITY');
control('A discovery probe cannot carry hidden model RPC work', v => { overlappingProbe(v); v.common.receipts.push({ event: 'rpc-request', wrapperPid: 9000, method: 'turn/start', at: 30000 }); });
control('A discovery probe cannot borrow the missing final main terminal exception', v => { overlappingProbe(v); v.common.receipts = v.common.receipts.filter(row => !(row.wrapperPid === 9000 && row.event === 'probe-exit')); });
control('A named discovery invocation cannot be accepted as a base version probe', v => { overlappingProbe(v); v.common.receipts.find(row => row.wrapperPid === 9000 && row.event === 'invocation').args = ['--profile', 'foreign', '--version']; });
check('Title latency is reported only from joined actual worker, public and visible-history timestamps', () => {
  const v = fixture(); seal(v); const verified = verify(v), timing = verified.quality.proofs[0].purposes.title.timing;
  assert.deepEqual(timing, { workerStartedAt: 103, submittedAt: 105, firstStdoutAt: 129, resultAt: 130, exitAt: 131,
    mainSendStartedAt: 100, titleUpdatedAt: 132, historyOpenedAt: 195, visibleHistoryAt: 199,
    submissionToResultMs: 25, submissionToFirstStdoutMs: 24, workerStartToResultMs: 27,
    resultToTitleUpdatedMs: 2, titleUpdatedToVisibleHistoryMs: 67, mainSendToVisibleHistoryMs: 99 });
});
check('Generated title keeps a whole astral character exactly within 50 UTF-16 units', () => assert.equal(audit.parseHelperOutput('title', '  ' + 'A'.repeat(48) + '😀 more  '), 'A'.repeat(48) + '😀'));
check('Generated title excludes a crossing astral character rather than creating a lone surrogate', () => assert.equal(audit.parseHelperOutput('title', 'A'.repeat(49) + '😀 more'), 'A'.repeat(49)));
check('Generated title retains the existing ASCII bound without a fallback ellipsis', () => assert.equal(audit.parseHelperOutput('title', 'A'.repeat(51)), 'A'.repeat(50)));
control('A complete helper result without its observed exit cannot earn semantic credit', v => {
  v.auxiliaryReceipts = v.auxiliaryReceipts.filter(row => !(row.inputIndex === 1 && row.event === 'exit'));
}, 'PARTIAL_HELPER_QUALITY');
control('A properly bounded 32KiB overflow retains evidence but receives no semantic credit', v => {
  replaceBody(v, 1, 'x'.repeat(32768)); const row = capture(v); row.overflow = true;
  Object.assign(result(v), { stdoutBytes: 32769, stdoutSha256: sha('x'.repeat(32769)) });
  v.auxiliaryReceipts.splice(v.auxiliaryReceipts.indexOf(row), 0, { event: 'auxiliary-capture-limit', at: row.at, wrapperPid: row.wrapperPid,
    inputIndex: 1, caseId: 'NONE', purpose: 'title', maxBytes: 32768 });
}, 'PARTIAL_HELPER_QUALITY');
control('A helper exit after the bounded observation receives no UI quality credit', v => {
  const row = v.auxiliaryReceipts.find(value => value.inputIndex === 1 && value.event === 'exit'); row.at = v.acceptance.panels[0].helperWait.ended + 1;
}, 'PARTIAL_HELPER_QUALITY');
check('A copied DOM title array cannot replace different retained passive observations', () => {
  const v = fixture(); seal(v); v.acceptance.panels[0].dom.titleObservations[0].title = 'invented'; assert.throws(() => verify(v));
});

const report = { status: checks.every(value => value.status === 'PASS') ? 'PASS' : 'FAIL', passed: checks.filter(value => value.status === 'PASS').length,
  failed: checks.filter(value => value.status === 'FAIL').length, checks, auditorSha256: sha(fs.readFileSync(require.resolve('./audit-vscode-codex-helper-quality.cjs'))),
  inferenceInputs: 0, editorLaunches: 0, scope: 'Synthetic native/public/durable, authorized helper capture, normalization, actual DOM projection and strict lifecycle controls. Full filesystem and process accounting remain separately exercised by preparation and auxiliary controls.' };
fs.writeFileSync(path.join(directory, 'checks.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ directory, status: report.status, passed: report.passed, failed: report.failed, failures: checks.filter(value => value.status === 'FAIL') }));
if (report.failed) process.exitCode = 1;
