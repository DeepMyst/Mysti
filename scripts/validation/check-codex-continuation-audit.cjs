/* New synthetic continuation audit controls. Existing controls and evidence are immutable. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const auditorPath = path.join(__dirname, 'audit-vscode-codex-continuation.cjs');
const audit = require(auditorPath);
const sha = value => createHash('sha256').update(value).digest('hex');
const artifactRoot = path.resolve(__dirname, '../../out-test/feature-tests/PB-02');
const directory = fs.mkdtempSync(path.join(artifactRoot, 'codex-continuation-audit-controls-'));
const contract = require('./codex-continuation-contract.cjs');
const copiedFixture = contract.copyPreservedFixture(path.join(directory, 'workspace'));
const sourceBefore = copiedFixture.files['src/retry.cjs'].text;
const sourceAfter = sourceBefore.replace('( [1-9]|[12][0-9]|3[01])', '( [1-9]|0[1-9]|[12][0-9]|3[01])')
  .replace('Math.floor(new Date(nowMs).getUTCFullYear() / 100)', 'Math.floor((new Date(nowMs).getUTCFullYear() + 50) / 100)');
function makeDiff(before, after) {
  const left = before.slice(0, -1).split('\n'), right = after.slice(0, -1).split('\n');
  return '@@ -1,' + left.length + ' +1,' + right.length + ' @@\n' + left.map(line => '-' + line).join('\n') + '\n'
    + right.map(line => '+' + line).join('\n') + '\n';
}
const canaryBefore = copiedFixture.files['canaries/approval.txt'].text;
const canaryDiff = makeDiff(canaryBefore, canaryBefore.replace('KEEP_THIS_CANARY_UNCHANGED', 'REQUESTED_CHANGE'));
const checks = [];
function check(name, action) {
  try { action(); checks.push({ name, status: 'PASS' }); }
  catch (error) { checks.push({ name, status: 'FAIL', error: { name: error.name, message: error.message } }); }
}
const clone = value => structuredClone(value);
function toolFixture() {
  const tool = { id: 'tool1', name: 'Bash', status: 'completed', input: { command: ['/bin/zsh', '-lc', 'node --test test/retry.test.cjs'], cwd: '/owned' }, output: '# tests 6\n# pass 6\n# fail 0\n' };
  const input = { inputIndex: 1, sessionHash: sha('thread') }, turn = sha('turn');
  const start = { event: 'tool-start', itemIdHash: sha(tool.id), sessionHash: input.sessionHash, turnHash: turn, inputIndex: 1, type: 'commandExecution' };
  const result = { ...start, event: 'tool-result', status: 'completed', exitCode: 0, commandSha256: sha(JSON.stringify(tool.input.command)), ownedCwd: true, outputSha256: sha(tool.output) };
  return { common: { owner: { workspace: '/owned' }, manifest: { fixture: copiedFixture } }, input, turn, tool, wire: [start, result], scope: { commands: ['node --test test/retry.test.cjs'] } };
}
function verifyTool(f) { return audit.verifyTools(f.common, f.input, f.turn, [f.tool], f.wire, f.scope); }
function permissionFixture() {
  const common = { owner: { workspace: copiedFixture.workspace }, manifest: { fixture: copiedFixture }, receipts: [] };
  const owner = { label: 'main', panelId: 'panel1', conversationId: 'chat1', events: [] }, decisions = [], transactions = [];
  const markers = ['REPAIR_DATES', 'REPAIR_DATES_CONTROL', 'REPAIR_TESTS', 'DENY_CANARY', 'STOP_APPROVAL'];
  markers.forEach((marker, index) => {
    const purpose = ['dates', 'dates', 'tests', 'deny', 'deny'][index], target = index === 2 ? 'test/retry.test.cjs' : index >= 3 ? 'canaries/approval.txt' : 'src/retry.cjs';
    const diff = index < 2 ? makeDiff(sourceBefore, sourceAfter) : index === 2 ? makeDiff(copiedFixture.files['test/retry.test.cjs'].text, contract.expectedTests(copiedFixture).toString()) : canaryDiff;
    const input = { inputIndex: index + 1, wrapperPid: index + 100, sessionHash: sha('thread') };
    const scope = { patch: purpose, ...(index === 4 ? { holdPatch: true } : {}) }, turnHash = sha(`turn${index}`), at = 100 * (index + 1);
    const details = { toolName: 'Edit', toolInput: { changes: [{ path: target, kind: { type: 'update' }, diff }] } };
    const card = { id: `card${index}`, details }, publicEvent = { type: 'permissionRequest', at: at + 10, payload: card };
    owner.events.push(publicEvent);
    const request = { event: 'approval-request', wrapperPid: input.wrapperPid, inputIndex: input.inputIndex, sessionHash: input.sessionHash, turnHash,
      at: at + 5, method: 'item/fileChange/requestApproval', nativeRequestIdHash: sha(`rpc${index}`), itemIdHash: sha(`item${index}`), toolInputSha256: sha(JSON.stringify(details.toolInput)) };
    const response = { event: 'approval-decision', wrapperPid: input.wrapperPid, inputIndex: input.inputIndex, nativeRequestIdHash: request.nativeRequestIdHash, at: at + 30, decision: index === 4 ? 'cancel' : index === 3 ? 'decline' : 'accept' };
    const result = { event: 'tool-result', type: 'fileChange', itemIdHash: request.itemIdHash, at: at + 40, status: index >= 3 ? 'declined' : 'completed' };
    const wire = index === 4 ? [request, response] : [request, response, result]; common.receipts.push(...wire);
    if (index !== 4) decisions.push({ event: 'permission-decision', label: 'main', panelId: owner.panelId, conversationId: owner.conversationId, at: at + 35,
      id: card.id, name: 'edit', input: details.toolInput, inputSha256: request.toolInputSha256, approved: index !== 3, expectedDenial: index === 3,
      beforeFiles: { hashes: Object.fromEntries(Object.entries(common.manifest.fixture.files).map(([file, value]) => [file, value.sha256])) } });
    transactions.push({ owner, scope, input, wire, turnHash, started: at, ended: at + 90,
      ...(index === 4 ? { pendingId: card.id, fault: { requestedAt: at + 25 } } : { reply: { marker, messageId: `reply${index}` } }) });
  });
  return { common, acceptance: { deniedCanary: { replyId: 'reply3', decisions: [decisions[3]] } }, storage: { owners: new Map([['main', owner]]), observations: decisions }, transactions };
}
function verifyPermissions(f) { return audit.auditPermissions(f.common, f.acceptance, f.storage, f.transactions); }
function faultFixture() {
  const fixture = copiedFixture, snapshot = { hashes: Object.fromEntries(Object.entries(fixture.files).map(([file, value]) => [file, value.sha256])) };
  const common = { manifest: { model: 'model-ok', invalidModel: 'invalid-synthetic', fixture, otherPanelToken: 'FOREIGN' }, inputs: [], receipts: [] };
  const owner = { label: 'main', panelId: 'main-panel', events: [], conversation: { messages: [] } };
  const storage = { owners: new Map([['main', owner]]) };
  const journey = { seenInputs: new Set(), seenMessages: new Set(), seenTurns: new Set(), transactions: [] };
  for (let i = 1; i <= 14; i++) {
    common.inputs.push({ event: 'request', inputIndex: i, wrapperPid: i, outsideMemoryMarkers: ['COMPLETED'] }); journey.seenInputs.add(i);
    const id = `reply${i}`; journey.seenMessages.add(id); owner.conversation.messages.push({ id, role: 'assistant', content: 'Completed reply' });
  }
  for (let i = 1; i <= 17; i++) owner.conversation.messages.push({ id: `user${i}`, role: 'user', content: 'Synthetic user' });
  const acceptance = { faults: {}, counts: { forwardedRejectedInputs: 0 } };
  [['stopApproval', 'STOP_APPROVAL', 2600], ['stopStreaming', 'STOP_STREAM', 2800]].forEach(([key, marker, at], offset) => {
    const inputIndex = 15 + offset, wrapperPid = 100 + offset, turnHash = sha(marker), sessionHash = sha('thread');
    const policy = { approvalPolicy: 'untrusted', sandbox: 'read-only', ownedCwd: true, effort: 'medium', mcpAllDisabled: true, appsAllDisabled: true, appsDefaultDisabled: true, mcpNames: [], appNames: [] };
    const input = { event: 'request', inputIndex, wrapperPid, sessionHash, outsideMemoryMarkers: [marker], outsideMemoryContainsOtherPanelToken: false, at, model: 'model-ok', effort: 'medium', policy };
    common.inputs.push(input);
    common.receipts.push({ event: 'effective-tool-config', wrapperPid, at: at - 20, mcpNames: [], appNames: [] },
      { event: 'session', wrapperPid, at: at - 10, method: 'thread/resume', sessionHash, actualModel: 'model-ok', modelProvider: 'openai', returnedPolicy: { approvalPolicy: 'untrusted', sandbox: 'readOnly', networkAccess: false, ownedCwd: true } }, input);
    const start = { event: 'turn-started', wrapperPid, inputIndex, sessionHash, turnHash, at: at + 10 }; common.receipts.push(start);
    const cancellation = { type: 'requestCancelled', at: at + 60, payload: {} };
    if (offset) {
      const partial = { id: 'partial1', role: 'assistant', provider: 'openai-codex', model: 'model-ok', content: 'A useful synthetic partial response preserving stopped work.' };
      cancellation.payload.message = partial; owner.conversation.messages.push(clone(partial));
      owner.events.push({ type: 'responseChunk', at: at + 20, payload: { type: 'text', content: partial.content } });
    }
    owner.events.push(cancellation);
    const fault = { marker, started: at - 1, requestedAt: at + 50, request: input, cancellationTransport: 'PROCESS_EVICTION', wrapperExited: true,
      nativeReceipts: [input, start], beforeFiles: snapshot, files: clone(snapshot), events: [cancellation] };
    if (!offset) {
      fault.permission = { id: 'pending-card', details: { toolName: 'Edit', toolInput: { changes: [{ path: 'canaries/approval.txt', kind: { type: 'update' }, diff: canaryDiff }] } } };
      owner.events.push({ type: 'permissionRequest', at: at + 20, payload: fault.permission }); fault.queuedRemoved = 2; fault.inputCount = inputIndex;
    } else fault.partialMessage = cancellation.payload.message;
    acceptance.faults[key] = fault;
    journey.transactions.push({ reply: { marker: offset ? 'STOP_STREAM_RECOVERY' : 'STOP_APPROVAL_RECOVERY' }, started: at + 100, input: { wrapperPid: 900 + offset } });
  });
  const error = { type: 'error', at: 3010, payload: { message: 'Model invalid-synthetic is not available' } };
  owner.events.push(error);
  const config = { event: 'thread-config', at: 3005, model: 'invalid-synthetic' }, rpc = { event: 'rpc-result', at: 3006, success: false };
  common.receipts.push(config, rpc); common.owner = { workspace: copiedFixture.workspace };
  acceptance.faults.invalidModel = { selectedAt: 3000, selectedModel: 'invalid-synthetic', rejectedAttempts: 1, forwardedRejectedInputs: 0,
    configurations: [config], requests: [], errors: [error], beforeFiles: snapshot, files: clone(snapshot) };
  journey.transactions.push({ reply: { marker: 'INVALID_MODEL_RECOVERY', messageId: 'reply14' }, started: 3100, input: { wrapperPid: 999 } });
  return { common, acceptance, storage, journey };
}
function verifyFault(f) { return audit.auditFaults(f.common, f.acceptance, f.storage, f.journey); }
function automaticReadonlyFixture() {
  const f = permissionFixture(), transaction = clone(f.transactions[3]);
  transaction.input.wrapperPid = 500; transaction.input.inputIndex = 6; transaction.scope.readonly = true;
  transaction.started = 600; transaction.ended = 690; transaction.reply.marker = 'READONLY_CANARY';
  const tool = { id: 'automatic-edit', name: 'Edit', status: 'failed', input: clone(f.storage.observations[3].input) }; transaction.reply.tools = [tool];
  transaction.wire.forEach((value, index) => { value.wrapperPid = 500; value.inputIndex = 6; value.at = 610 + index * 10; value.itemIdHash = sha(tool.id); value.nativeRequestIdHash = sha('automatic-rpc'); });
  f.common.receipts.push(...transaction.wire); f.transactions.push(transaction); return f;
}
  check('exact native item/output/command ownership accepts the real successful item', () => assert.equal(verifyTool(toolFixture()).length, 1));
  for (const [name, change] of [
    ['wrong native output cannot prove the displayed test success', f => f.wire[1].outputSha256 = sha('different output')],
    ['foreign native turn cannot prove this tool', f => f.wire[1].turnHash = sha('foreign turn')],
    ['forged command cannot borrow a genuine output', f => f.wire[1].commandSha256 = sha('other command')],
    ['hidden additional tool result is rejected', f => f.wire.push({ ...f.wire[1], itemIdHash: sha('hidden') })],
    ['proposal cannot count as native execution', f => f.tool.proposalOnly = true],
    ['unconfirmed tool cannot count as success', f => f.tool.status = 'unconfirmed'],
  ]) check(name, () => { const f = toolFixture(); change(f); assert.throws(() => verifyTool(f)); });
  check('approved patches denied canary and pending Stop map distinct actual request IDs', () => assert.equal(verifyPermissions(permissionFixture()).length, 5));
  for (const [name, change] of [
    ['duplicate native response is rejected', f => f.common.receipts.push({ ...f.common.receipts.find(value => value.event === 'approval-decision') })],
    ['missing public approval is rejected', f => f.storage.observations.shift()],
    ['pre-approval source mutation is rejected', f => f.storage.observations[0].beforeFiles.hashes['src/retry.cjs'] = sha('already changed')],
    ['pending Stop cannot emit native allow', f => f.common.receipts.at(-1).decision = 'accept'],
    ['wrong native input cannot claim public consent', f => f.common.receipts[0].toolInputSha256 = sha('other input')],
  ]) check(name, () => { const f = permissionFixture(); change(f); assert.throws(() => verifyPermissions(f)); });
  check('automatic native Read Only decline can settle without granting a public approval', () => assert(verifyPermissions(automaticReadonlyFixture()).some(value => value.automaticReadOnlyDenial)));
  check('automatic Read Only cannot grant native permission', () => { const f = automaticReadonlyFixture(); f.common.receipts.at(-2).decision = 'accept'; assert.throws(() => verifyPermissions(f)); });
  check('two Stops retain useful partial exactly once and do not fabricate completion', () => assert.equal(verifyFault(faultFixture()).stops.length, 2));
  for (const [name, change] of [
    ['Stop partial cannot reuse a completed assistant ID', f => f.acceptance.faults.stopStreaming.events[0].payload.message.id = 'reply1'],
    ['acknowledged partial cannot disappear from disk', f => f.storage.owners.get('main').conversation.messages = f.storage.owners.get('main').conversation.messages.filter(value => value.id !== 'partial1')],
    ['acknowledged partial must preserve exact content on disk', f => f.storage.owners.get('main').conversation.messages.find(value => value.id === 'partial1').content = 'changed'],
    ['late Stop completion is rejected', f => f.storage.owners.get('main').events.push({ type: 'responseComplete', at: 2865, payload: { message: { id: 'late' } } })],
    ['post-cancel streaming is rejected', f => f.storage.owners.get('main').events.push({ type: 'responseChunk', at: 2865, payload: { type: 'text', content: 'late text' } })],
    ['no-progress Stop cannot claim mid-stream coverage', f => f.storage.owners.get('main').events = f.storage.owners.get('main').events.filter(value => value.type !== 'responseChunk')],
    ['service quota cannot count as invalid-model enforcement', f => f.acceptance.faults.invalidModel.errors[0].payload.message = 'Model invalid-synthetic not available: session quota limit'],
  ]) check(name, () => { const f = faultFixture(); change(f); assert.throws(() => verifyFault(f)); });

const fixture=(output='ok\n')=>{
 const live={id:'exact-native-item',name:'Bash',status:'completed',input:{command:['/bin/zsh','-lc','node --test test/retry.test.cjs'],cwd:'/owned'},output};
 const persisted=structuredClone(live); if(output.length>4096){persisted.output=output.slice(0,4096);persisted.truncated=true;}
 const input={inputIndex:1,sessionHash:sha('thread')},turn=sha('turn');
 const start={event:'tool-start',itemIdHash:sha(live.id),sessionHash:input.sessionHash,turnHash:turn,inputIndex:1,type:'commandExecution'};
 const result={...start,event:'tool-result',status:'completed',exitCode:0,commandSha256:sha(JSON.stringify(live.input.command)),ownedCwd:true,outputSha256:sha(output)};
 return {common:{owner:{workspace:'/owned'},manifest:{fixture:copiedFixture}},input,turn,persisted,wire:[start,result],scope:{commands:['node --test test/retry.test.cjs']},events:[{type:'toolResult',payload:live}]};
};
const verify=f=>audit.verifyTools(f.common,f.input,f.turn,[f.persisted],f.wire,f.scope,false,f.events);

check('Exact short native/live/persisted output remains accepted',()=>assert.equal(verify(fixture()).length,1));
check('Full native/live result accepts exactly bounded explicitly marked persistence',()=>{const f=fixture('full output\n'.repeat(600));const x=verify(f)[0];assert.equal(x.tool.output,f.events[0].payload.output);assert.equal(x.outputProjection.persistedOutputLength,4096);});
check('Storage boundary counts UTF-16 units including split surrogate pairs',()=>{const f=fixture('a'.repeat(4095)+'😀'+'tail');assert.equal(verify(f)[0].outputProjection.persistedOutputLength,4096);});
check('Exact4096 output needs no output truncation flag',()=>assert.equal(verify(fixture('x'.repeat(4096))).length,1));
check('Short output may retain truncation flag for separately bounded input metadata',()=>{const f=fixture();f.persisted.truncated=true;assert.equal(verify(f).length,1);});
for(const [name,mutate] of [
 ['Missing actual live output cannot be substituted with persisted bytes',f=>f.events=[]],
 ['Duplicate actual live item is ambiguous',f=>f.events.push(structuredClone(f.events[0]))],
 ['Wrong native full output SHA is rejected',f=>f.wire[1].outputSha256=sha('other')],
 ['Wrong live full output is rejected',f=>f.events[0].payload.output='other'],
 ['Foreign live item ID cannot satisfy current result',f=>f.events[0].payload.id='foreign'],
 ['Different live command cannot borrow genuine native output',f=>f.events[0].payload.input.command=['other']],
 ['Different live status cannot claim completed persistence',f=>f.events[0].payload.status='failed'],
 ['Unexpected live tool result cannot disappear from persistence',f=>f.events.push({type:'toolResult',payload:{...f.events[0].payload,id:'hidden'}})],
]) check(name,()=>{const f=fixture();mutate(f);assert.throws(()=>verify(f));});
for(const [name,mutate] of [
 ['Long output prefix without explicit truncation marker fails',f=>delete f.persisted.truncated],
 ['Corrupted bounded prefix fails',f=>f.persisted.output='y'+f.persisted.output.slice(1)],
 ['Arbitrary shorter prefix is not accepted as documented storage bound',f=>f.persisted.output=f.persisted.output.slice(0,2000)],
]) check(name,()=>{const f=fixture('x'.repeat(7000));mutate(f);assert.throws(()=>verify(f));});
check('Pending tool at Stop need not invent a completed live result',()=>{const f=fixture();f.wire.pop();f.persisted.status='cancelled';delete f.persisted.output;f.events=[];assert.equal(audit.verifyTools(f.common,f.input,f.turn,[f.persisted],f.wire,f.scope,true,f.events)[0].result,null);});

// Report schema controls derive from preserved synthetic successor evidence, copied into new
// synthetic ownership only. They do not run or claim another timezone oracle.
const seedPath = path.join(artifactRoot, 'http-date-boundary-controls-uQatOl/synthetic-both-green.json');
const seedBytes = fs.readFileSync(seedPath), seed = JSON.parse(seedBytes);
const seedSource = fs.readFileSync(seed.source);
assert.equal(seed.status, 'PASS'); assert.equal(seed.passed, 135); assert.equal(sha(seedSource), seed.sourceSha256);
let portabilityIndex = 0;
function portabilityFixture() {
  const owned = path.join(directory, `portability-${++portabilityIndex}`), workspacePath = path.join(owned, 'workspace');
  fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
  const source = path.join(workspacePath, 'src/retry.cjs'); fs.writeFileSync(source, seedSource, { flag: 'wx' });
  const report = clone(seed); report.source = source;
  const evidence = { path: path.join(owned, 'oracle-http-date.json'), exitCode: 0, sourceSha256: report.sourceSha256 };
  return { report, common: { owner: { directory: owned, workspace: workspacePath } },
    workspace: { files: { 'src/retry.cjs': { sha256: report.sourceSha256 } } },
    acceptance: { boundaryOracle: evidence }, storage: { observations: [] } };
}
function sealPortability(value) {
  const evidence = value.acceptance.boundaryOracle;
  fs.writeFileSync(evidence.path, JSON.stringify(value.report, null, 2), { flag: 'wx' });
  evidence.sha256 = sha(fs.readFileSync(evidence.path));
  value.storage.observations = [{ event: 'independent-boundary-oracle', ...clone(evidence) }];
}
function verifyPortability(value) { return audit.auditBoundary(value.common, value.acceptance, value.workspace, value.storage); }
function portabilityCheck(name, mutateReport, mutateEvidence, accepts = false) {
  check(name, () => {
    const value = portabilityFixture(); mutateReport?.(value.report, value); sealPortability(value); mutateEvidence?.(value);
    if (accepts) assert.equal(verifyPortability(value).passed, 135);
    else assert.throws(() => verifyPortability(value));
  });
}
portabilityCheck('all135 successor synthetic oracle vectors satisfy the report acceptance path in a new synthetic copy', undefined, undefined, true);
for (const [name, mutate] of [
  ['failure totals cannot be accepted', report => { report.status = 'FAIL'; report.passed = 132; report.failed = 3; }],
  ['schema mismatch is rejected', report => { report.schema = 2; }],
  ['vector set identity mismatch is rejected', report => { report.vectorSet = 'OTHER'; }],
  ['vector set digest mismatch is rejected', report => { report.vectorSetSha256 = sha('other vectors'); }],
  ['vector count mismatch is rejected', report => { report.vectorCount--; }],
  ['added vector count mismatch is rejected', report => { report.addedVectorCount--; }],
  ['old baseline identity mismatch is rejected', report => { report.baselineOracle.sha256 = sha('other baseline'); }],
  ['old baseline clock mismatch is rejected', report => { report.baselineOracle.nowMs++; }],
  ['child vector set digest mismatch is rejected', report => { report.runs[1].report.vectorSetSha256 = sha('other vectors'); }],
  ['vector supplied clock mismatch is rejected', report => { report.runs[1].report.checks[0].nowMs++; }],
  ['vector group mismatch is rejected', report => { report.runs[1].report.checks[0].group = 'other group'; }],
  ['missing timezone cannot hide behind135 aggregate count', report => report.runs.pop()],
  ['duplicate timezone cannot count as three independent processes', report => { report.runs[2] = clone(report.runs[0]); }],
  ['reordered timezone set is rejected', report => report.timezones.reverse()],
  ['44 child vectors cannot hide behind135 aggregate count', report => report.runs[1].report.checks.pop()],
  ['failed vector cannot hide beneath PASS totals', report => { report.runs[1].report.checks[2].status = 'FAIL'; }],
  ['failed child cannot hide beneath PASS totals', report => { report.runs[1].status = 'FAIL'; }],
  ['failed worker report cannot hide beneath PASS totals', report => { report.runs[1].report.status = 'FAIL'; }],
  ['child source identity must match final source', report => { report.runs[1].report.sourceSha256 = sha('foreign source'); }],
  ['source mutation invalidates portability evidence', report => { report.fixtureSourceUnchanged = false; }],
  ['child source mutation invalidates portability evidence', report => { report.runs[1].report.fixtureSourceUnchanged = false; }],
  ['worker timezone must match its requested timezone', report => { report.runs[1].report.timezone = 'UTC'; }],
  ['nonzero child exit is rejected', report => { report.runs[1].exitCode = 1; }],
  ['signalled child is rejected', report => { report.runs[1].signal = 'SIGTERM'; }],
  ['timed-out child is rejected', report => { report.runs[1].timedOut = true; }],
  ['wrong oracle implementation identity is rejected', report => { report.oracleSha256 = sha('different oracle'); }],
  ['wrong source path is rejected', report => { report.source = '/foreign/src/retry.cjs'; }],
  ['duplicate vector label is rejected', report => { report.runs[1].report.checks[1].name = report.runs[1].report.checks[0].name; }],
  ['arbitrary replacement vector label is rejected', report => { report.runs[1].report.checks[1].name = 'different vector'; }],
  ['altered vector input is rejected', report => { report.runs[1].report.checks[0].input = 'different input'; }],
  ['altered expected value cannot redefine correctness', report => { report.runs[1].report.checks[0].expected.value = 1; }],
  ['incorrect actual value cannot hide beneath PASS', report => { report.runs[1].report.checks[0].actual.value = 1; }],
  ['undefined result must retain its exact encoding', report => { report.runs[1].report.checks[8].actual = { type: 'number', value: 0 }; }],
  ['network activity cannot count as this independent oracle', report => { report.networkRequests = 1; }],
  ['provider input cannot count as this independent oracle', report => { report.realProviderInputs = 1; }],
  ['editor launch cannot count as this independent oracle', report => { report.editorLaunches = 1; }],
]) portabilityCheck(name, mutate);
for (const [name, mutate] of [
  ['wrong report digest is rejected', value => { value.acceptance.boundaryOracle.sha256 = sha('foreign report'); }],
  ['nonzero enclosing oracle exit is rejected', value => { value.acceptance.boundaryOracle.exitCode = 1; }],
  ['final workspace source digest must match report', value => { value.workspace.files['src/retry.cjs'].sha256 = sha('foreign source'); }],
  ['evidence source digest must match report', value => { value.acceptance.boundaryOracle.sourceSha256 = sha('foreign source'); }],
  ['missing portability observation is rejected', value => { value.storage.observations = []; }],
  ['duplicate portability observation is rejected', value => { value.storage.observations.push(clone(value.storage.observations[0])); }],
  ['changed portability observation is rejected', value => { value.storage.observations[0].sourceSha256 = sha('foreign source'); }],
  ['unowned report path is rejected', value => { value.acceptance.boundaryOracle.path = seedPath; }],
  ['owned-path symlink cannot substitute an unowned report', value => {
    const reportPath = value.acceptance.boundaryOracle.path, foreignPath = path.join(directory, `foreign-report-${portabilityIndex}.json`);
    fs.renameSync(reportPath, foreignPath); fs.symlinkSync(foreignPath, reportPath);
  }],
]) portabilityCheck(name, undefined, mutate);
contract.verifyPreservedBase(copiedFixture);
assert(fs.readFileSync(seedPath).equals(seedBytes)); assert(fs.readFileSync(seed.source).equals(seedSource));
const result = {
  status: checks.every(value => value.status === 'PASS') ? 'PASS' : 'FAIL',
  auditorSha256: sha(fs.readFileSync(auditorPath)),
  helperSha256: sha(fs.readFileSync(path.join(__dirname, 'codex-full-oracle.cjs'))),
  boundaryOracleSha256: sha(fs.readFileSync(path.join(__dirname, 'http-date-boundary-oracle.cjs'))),
  preservedPortabilitySeed: { path: seedPath, sha256: sha(seedBytes), source: seed.source, sourceSha256: sha(seedSource), unchanged: true },
  coverage: { inheritedAuditChecks: 23, outputProjectionChecks: 17, portabilityChecks: portabilityIndex,
    excludedLegacyReadOnlyChecks: 6, exclusionReason: 'Superseded file-change Read Only classifier controls are covered by the new command-probe controls; the two still-valid automatic-decline approval controls remain here.' },
  passed: checks.filter(value => value.status === 'PASS').length, failed: checks.filter(value => value.status === 'FAIL').length, checks,
  inferenceInputs: 0, editorLaunches: 0, cliLaunches: 0,
  scope: 'Synthetic receipt and successor copied-report acceptance checks only; no native acceptance or fresh135-vector execution claim.',
};
fs.writeFileSync(path.join(directory, 'checks.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ directory, status: result.status, passed: result.passed, failed: result.failed, failures: checks.filter(value => value.status === 'FAIL') }));
if (result.failed) process.exitCode = 1;
