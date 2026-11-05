/* Synthetic F2 auditor controls. No editor, provider, app, or external process is launched. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const a = require('./audit-vscode-codex-f2-causal.cjs'), c = require('./codex-f2-compact-campaign.cjs'), auxiliary = require('./codex-f2-auxiliary.cjs');
const EXPECTED_ARGS = auxiliary.EXPECTED_ARGS;
const compact = require('./codex-f2-compact-store.cjs');
const { expectedSeededLintOutput } = require('./codex-f2-seeded-lint.cjs');
const { assertToolOutputProjection } = require('./codex-full-oracle.cjs');
const { joinNativeAssistantMessages } = require('./audit-vscode-codex-helper-quality.cjs');
const root = path.resolve(__dirname, '../../out-test/feature-tests/PB-02');
const directory = fs.mkdtempSync(path.join(root, 'f2-causal-audit-controls-')), workspace = path.join(directory, 'workspace');
fs.mkdirSync(workspace); const checks = [], hash = c.hash, copy = value => JSON.parse(JSON.stringify(value));
const check = (name, fn) => { try { fn(); checks.push({ name, status: 'PASS' }); } catch (error) { checks.push({ name, status: 'FAIL', error: error.stack }); } };
const prepared = path.join(root, 'overnight-20261011/f2-workload-preparation');
const repairs = c.buildRepairs(path.join(prepared, 'contracts/case-contracts.json'), path.join(root, 'overnight-20261011/f2-adapted-baseline/workspace'), path.join(prepared, 'seeded-workspace'));
const fixture = { workspace, repairs, files: {}, generatedDirectories: [] };
function seed(relative, text) { const file = path.join(workspace, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, { flag: 'wx' }); fixture.files[relative] = { sha256: hash(text) }; }
for (const repair of Object.values(repairs)) seed(repair.path, repair.before);
seed(c.NOTE, 'KEEP_THIS_DEVELOPER_NOTE\n'); seed('.git/index', 'EXACT_SYNTHETIC_INDEX\n'); seed('immutable.test.js', 'assert(true);\n');
fixture.indexSha256 = fixture.files['.git/index'].sha256;
fixture.deniedNote = { path: c.NOTE, before: 'KEEP_THIS_DEVELOPER_NOTE\n', after: 'REQUESTED_SCOPE_CHANGE\n', beforeSha256: hash('KEEP_THIS_DEVELOPER_NOTE\n'), afterSha256: hash('REQUESTED_SCOPE_CHANGE\n') };
let proposalNumber = 0;
function proposal(repair) {
  const before = path.join(directory, `before-${++proposalNumber}`), after = path.join(directory, `after-${proposalNumber}`);
  fs.writeFileSync(before, repair.before, { flag: 'wx' }); fs.writeFileSync(after, repair.after, { flag: 'wx' }); let diff;
  try { execFileSync('/usr/bin/diff', ['-u', before, after], { encoding: 'utf8' }); throw Error('Expected differing correction'); }
  catch (error) { assert.equal(error.status, 1); diff = error.stdout.split('\n').slice(2).join('\n'); }
  return [{ path: repair.path, kind: { type: 'update' }, diff }];
}
const proposals = Object.fromEntries([...Object.entries(repairs), ['deny-notes', fixture.deniedNote]].map(([id, repair]) => [id, proposal(repair)]));
fixture.commandPolicy = c.buildCommandPolicy(workspace);
fixture.dependencyCopies = ['node_modules', 'client/node_modules', 'server/node_modules'].map(relative => ({ target: path.join(workspace, relative), treeSha256: hash(relative), files: 1 }));
const steps = c.buildSteps(workspace), panels = ['synthetic-panel'];
function snapshot(completedCases = []) {
  return { hashes: Object.fromEntries(Object.entries(fixture.files).map(([file, pin]) => [file, completedCases.map(id => repairs[id]).find(row => row.path === file)?.afterSha256 || pin.sha256])),
    completedCases: completedCases.slice(), indexSha256: fixture.indexSha256, productFiles: [], applicationLogs: [] };
}
function boundary(completedCases = [], built = false) {
  const files = snapshot(completedCases), policy = fixture.commandPolicy;
  const sourceMapMatches = Object.fromEntries(['client/src/models/List.js', 'client/src/components/Card/Tasks.jsx'].map(name => [name, files.hashes[name]]));
  return { files, dependencySnapshots: fixture.dependencyCopies.map(({ target, treeSha256, files }) => ({ target, treeSha256, files })),
    cacheSnapshot: { root: policy.craCacheRoot, files: [], fileCount: 0, bytes: 0, httpActivity: [] },
    buildSnapshot: built ? { root: policy.buildRoot, files: [{ relative: 'static/js/main.js.map', path: path.join(policy.buildRoot, 'static/js/main.js.map'), sha256: hash('map'), bytes: 3 }], fileCount: 1, bytes: 3, sourceMapMatches } : null,
    applicationTemporarySnapshot: null };
}
function turn(ordinal = 1, options = {}) {
  const step = steps[ordinal - 1], completedCases = steps.slice(0, ordinal - 1).filter(row => row.patch && row.patch !== 'deny-notes').map(row => row.patch);
  const commands = [...step.commands], started = 1000000 + ordinal * 10000, sessionHash = hash('session'), turnHash = hash(`turn-${ordinal}`), wrapperPid = 21001;
  const base = { provider: 'openai-codex', window: 'A', wrapperPid }, wire = [], events = [], observations = [];
  const add = (event, offset, fields = {}) => { const row = { ...base, event, at: started + offset, ...fields }; wire.push(row); return row; };
  const configuration = add('effective-tool-config', 0, { mcpNames: [], appNames: [] });
  const session = add('session', 1, { sessionHash, requestedModel: 'gpt-5.6-sol', actualModel: 'gpt-5.6-sol', method: 'thread/start', returnedPolicy: { approvalPolicy: 'untrusted', sandbox: 'readOnly', ownedCwd: true, networkAccess: false } });
  const input = add('request', 3, { inputIndex: ordinal, model: 'gpt-5.6-sol', effort: 'low', sessionHash, markers: [step.marker], outsideMemoryMarkers: [step.marker], memoryMarkers: [],
    policy: { ownedCwd: true, mcpAllDisabled: true, appsAllDisabled: true, appsDefaultDisabled: true, mcpNames: configuration.mcpNames, appNames: configuration.appNames, approvalPolicy: 'untrusted', sandbox: 'read-only', effort: 'low' } });
  const native = (event, offset, fields = {}) => add(event, offset, { inputIndex: ordinal, sessionHash, turnHash, ...fields });
  const prompt = c.promptFor(step, commands), user = { id: `user-${ordinal}`, role: 'user', content: prompt };
  events.push({ type: 'messageAdded', at: started + 2, payload: user }, { type: 'responseStarted', at: started + 4, payload: {} });
  native('turn-started', 5);
  const toolCalls = [], outputEvidence = [];
  const actions = [...commands.map(command => ({ name: 'Bash', input: { command, cwd: workspace } })),
    ...(step.patch && !(step.patch === 'deny-notes' && options.refusal) ? [{ name: 'Edit', input: { changes: copy(proposals[step.patch]) } }] : [])];
  for (const [i, action] of actions.entries()) {
    const at = 10 + i * 20, id = `tool-${ordinal}-${i}`, itemIdHash = hash(id), edit = action.name === 'Edit', denied = edit && step.patch === 'deny-notes';
    const seededLint = !edit && ordinal === 21 && c.exactCommand(action.input.command, steps[20].commands[1]);
    const status = denied || seededLint ? 'failed' : options.failedNonzero && step.expectedNonzero ? 'failed' : 'completed';
    const output = options.output || (edit ? JSON.stringify(action.input.changes) : seededLint ? expectedSeededLintOutput(workspace) : step.expectedNonzero ? 'npm error Missing script: \"client:tset\"\n' : 'actual synthetic output\n');
    const live = { id, ...action, status, output }, persisted = { ...copy(live), output: output.slice(0, 4096), ...(output.length > 4096 ? { truncated: true } : {}) };
    const metadata = edit ? { type: 'fileChange', changes: action.input.changes.map(change => ({ relativePath: change.path, kind: 'update', diffSha256: hash(change.diff) })) }
      : { type: 'commandExecution', commandSha256: hash(JSON.stringify(action.input.command)), ownedCwd: true, exitCode: seededLint || step.expectedNonzero ? 1 : 0 };
    native('tool-start', at, { itemIdHash, type: metadata.type });
    events.push({ type: 'toolUse', at: started + at + 1, payload: { ...copy(live), status: 'running', output: undefined } });
    if (!options.withoutApprovals || edit) {
      const approvalId = `approval-${ordinal}-${i}`, nativeRequestIdHash = hash(approvalId);
      native('approval-request', at + 2, { itemIdHash, nativeRequestIdHash, method: edit ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval', toolInputSha256: hash(JSON.stringify(action.input)) });
      events.push({ type: 'permissionRequest', at: started + at + 3, payload: { id: approvalId, details: { toolName: action.name, toolInput: copy(action.input) } } });
      observations.push({ event: 'permission-decision', at: started + at + 4, marker: step.marker, id: approvalId, name: action.name.toLowerCase(), input: copy(action.input), approved: !denied, expectedDenial: denied, beforeFiles: snapshot(completedCases) });
      native('approval-decision', at + 5, { nativeRequestIdHash, decision: denied ? 'decline' : 'accept' });
    }
    const result = native('tool-result', at + 6, { itemIdHash, ...metadata, status, outputSha256: hash(output) });
    events.push({ type: 'toolResult', at: started + at + 7, payload: live }); toolCalls.push(persisted);
    outputEvidence.push(assertToolOutputProjection({ nativeResult: result, liveTool: live, persistedTool: persisted }));
  }
  const content = `Observed evidence. PB02_DONE:${step.marker}.`, message = { id: `assistant-${ordinal}`, role: 'assistant', content, provider: 'openai-codex', model: 'gpt-5.6-sol', toolCalls };
  const assistant = native('assistant-message', 500, { itemIdHash: hash(`assistant-native-${ordinal}`), itemType: 'agentMessage', textBytes: Buffer.byteLength(content), textSha256: hash(content) });
  const terminal = native('turn-completed', 501, { status: 'completed' });
  const completedAt = started + 502; events.push({ type: 'responseComplete', at: completedAt, payload: { message: copy(message) } });
  const next = [...completedCases, ...(step.patch && step.patch !== 'deny-notes' ? [step.patch] : [])];
  const reply = { ordinal, marker: step.marker, started, completedAt, prompt, message, messageId: message.id, commands, scope: step.patch || null, request: input, session, terminal,
    beforeFiles: snapshot(completedCases), afterFiles: snapshot(next), beforeBoundary: step.requiresEscalation.length ? boundary(completedCases) : null, afterBoundary: step.requiresEscalation.length ? boundary(next, ordinal === 21) : null, nativeTools: wire.filter(row => ['tool-start', 'tool-result'].includes(row.event)), outputEvidence,
    nativeText: joinNativeAssistantMessages([assistant], content) };
  return { fixture, step, reply, events, observations, wire, storedMessage: copy(message), commands, completedCases, panelIds: panels };
}
function negative(name, change, ordinal = 1, options) { check(name, () => { const value = turn(ordinal, options); change(value); assert.throws(() => a.auditTurn(value)); }); }
for (const step of steps) check(`${step.marker}: exact synthetic native/live/approval/durable joins pass`, () => a.auditTurn(turn(step.ordinal)));
// Meaningful causal controls: preserve exact native/public/durable data and
// change only asynchronous delivery timing, or the true captured-send bound.
const originalAuditor = require('./audit-vscode-codex-f2-compact.cjs');
for (const delay of [2, 5, 11, 19, 100]) check(`browser user delivery delayed ${delay}ms after native request remains valid`, () => {
  const value = turn(3), user = value.events.find(row => row.type === 'messageAdded');
  user.at = value.reply.request.at + delay; value.events.sort((x, y) => x.at - y.at);
  assert.throws(() => originalAuditor.auditTurn(value), /user\.at <= input\.at/);
  const result = a.auditTurn(value); assert.equal(result.input.at, value.reply.request.at);
  assert.equal(result.userAt, user.at); assert(user.at > result.input.at);
});
check('native request exactly at captured send lower bound remains valid', () => {
  const value = turn(3); value.reply.request.at = value.reply.started;
  value.wire.find(row => row.event === 'effective-tool-config').at = value.reply.started - 2;
  value.wire.find(row => row.event === 'session').at = value.reply.started - 1;
  a.auditTurn(value);
});
check('native request before captured send is rejected by the actual lower-bound guard', () => {
  const value = turn(3); value.reply.request.at = value.reply.started - 1;
  value.wire.find(row => row.event === 'effective-tool-config').at = value.reply.started - 4;
  value.wire.find(row => row.event === 'session').at = value.reply.started - 3;
  assert.throws(() => a.auditTurn(value), /Native request must follow captured send start/);
});
check('native request after public completion is rejected by the actual upper-bound guard', () => {
  const value = turn(3); value.reply.request.at = value.reply.completedAt + 1;
  assert.throws(() => a.auditTurn(value), /Native request must follow captured send start/);
});
for (const [name, mutate] of [
  ['stale user event before captured send', value => { value.events.find(row => row.type === 'messageAdded').at = value.reply.started - 1; }],
  ['user event after completion', value => { value.events.find(row => row.type === 'messageAdded').at = value.reply.completedAt + 1; }],
  ['duplicate exact user event', value => { value.events.push(copy(value.events.find(row => row.type === 'messageAdded'))); }],
  ['wrong current prompt in public user event', value => { value.events.find(row => row.type === 'messageAdded').payload.content += '\nWRONG'; }],
  ['duplicate native request', value => { value.wire.push(copy(value.reply.request)); }],
  ['wrong native input index', value => { value.reply.request.inputIndex = 4; }],
  ['native turn starts before its request', value => { value.wire.find(row => row.event === 'turn-started').at = value.reply.request.at - 1; }],
  ['wrong native session', value => { value.reply.request.sessionHash = hash('foreign'); }],
  ['wrong durable assistant', value => { value.storedMessage.content += ' WRONG'; }],
]) check(`delayed user delivery still rejects ${name}`, () => {
  const value = turn(3); value.events.find(row => row.type === 'messageAdded').at = value.reply.request.at + 19;
  mutate(value); assert.throws(() => a.auditTurn(value));
});
const originalPin = c.identity(path.join(__dirname, 'audit-vscode-codex-f2-compact.cjs'));
check('post-run provenance requires exact original prelaunch auditor and discloses new auditor was not pinned', () => {
  const result = a.auditAuditorProvenance([originalPin]);
  assert.equal(result.kind, 'ADDITIVE_POST_RUN_REVIEW'); assert.equal(result.successorPrelaunchPinned, false);
  assert.equal(result.originalPrelaunchPinned, true); assert.deepEqual(result.originalAuditor, originalPin);
});
for (const [name, pins] of [
  ['missing original', []], ['wrong original hash', [{ ...originalPin, sha256: hash('forged') }]],
  ['wrong original path', [{ ...originalPin, path: originalPin.path + '.other' }]],
  ['duplicate original', [originalPin, originalPin]],
  ['successor cannot substitute for prelaunch original', [c.identity(path.join(__dirname, 'audit-vscode-codex-f2-causal.cjs'))]],
]) check(`post-run provenance rejects ${name}`, () => assert.throws(() => a.auditAuditorProvenance(pins)));
// Modify every native/live/durable projection consistently, so these cases test
// result policy rather than merely failing an unrelated hash-equality guard.
function joinedCommandResult(value, index, fields) {
  const tool = value.reply.message.toolCalls[index], id = tool.id;
  const result = value.wire.find(row => row.event === 'tool-result' && row.itemIdHash === hash(id));
  const live = value.events.find(row => row.type === 'toolResult' && row.payload.id === id).payload;
  const output = fields.output ?? live.output, status = fields.status ?? result.status;
  result.status = status; result.exitCode = fields.exitCode ?? result.exitCode; result.outputSha256 = hash(output);
  live.status = status; live.output = output;
  for (const message of [value.reply.message, value.storedMessage, value.events.find(row => row.type === 'responseComplete').payload.message]) {
    const persisted = message.toolCalls.find(row => row.id === id); persisted.status = status; persisted.output = output.slice(0, 4096);
    if (output.length > 4096) persisted.truncated = true; else delete persisted.truncated;
  }
  value.reply.outputEvidence = value.reply.message.toolCalls.map(persisted => assertToolOutputProjection({
    nativeResult: value.wire.find(row => row.event === 'tool-result' && row.itemIdHash === hash(persisted.id)),
    liveTool: value.events.find(row => row.type === 'toolResult' && row.payload.id === persisted.id).payload, persistedTool: persisted,
  }));
}
check('step21 permits only exact characterized server lint while client lint and build succeed', () => {
  const value = turn(21), result = a.auditTurn(value);
  assert.equal(value.step.expectedNonzero, undefined);
  assert.deepEqual(result.verifiedTools.map(row => [row.tool.status, row.result.exitCode]), [['completed', 0], ['failed', 1], ['completed', 0]]);
  assert.equal(value.events.find(row => row.type === 'toolResult' && row.payload.id === 'tool-21-1').payload.output, expectedSeededLintOutput(workspace));
});
for (const [name, fields] of [
  ['different seeded file', { output: expectedSeededLintOutput(workspace).replace('/server/api/controllers/cards/delete.js', '/server/api/controllers/cards/update.js') }],
  ['different source line', { output: expectedSeededLintOutput(workspace).replace('47:1', '48:1') }],
  ['additional lint error', { output: expectedSeededLintOutput(workspace) + '\nUnexpected fourth error\n' }],
  ['missing seeded diagnostic', { output: expectedSeededLintOutput(workspace).replace(`${workspace}/server/api/controllers/users/update.js\n  60:1  error  Delete \`⏎\`  prettier/prettier\n\n`, '') }],
  ['permission failure instead of lint', { output: 'npm error code EPERM\ncache write denied\n' }],
  ['tool startup failure', { output: 'eslint: command not found\n', exitCode: 127 }],
  ['same exact output but exit2', { exitCode: 2 }],
  ['same exact output but completed status', { status: 'completed' }],
  ['same exact output but successful exit', { exitCode: 0 }],
  ['success output hiding expected seed errors', { status: 'completed', exitCode: 0, output: 'Everything is clean\n' }],
]) check(`joined server lint result rejects ${name}`, () => {
  const value = turn(21); joinedCommandResult(value, 1, fields); assert.throws(() => a.auditTurn(value));
});
for (const [index, label] of [[0, 'client lint'], [2, 'client build']]) {
  check(`joined ${label} failure cannot borrow server lint exception`, () => {
    const value = turn(21); joinedCommandResult(value, index, { status: 'failed', exitCode: 1, output: expectedSeededLintOutput(workspace) }); assert.throws(() => a.auditTurn(value));
  });
  check(`joined ${label} completed status with nonzero exit is rejected`, () => {
    const value = turn(21); joinedCommandResult(value, index, { status: 'completed', exitCode: 1 }); assert.throws(() => a.auditTurn(value));
  });
}
check('step-wide nonzero flag cannot widen the specific server lint exception', () => {
  const value = turn(21); value.step = { ...value.step, expectedNonzero: true }; assert.throws(() => a.auditTurn(value));
});
check('exact server lint text in another task does not authorize failure', () => {
  const value = turn(3); joinedCommandResult(value, 0, { status: 'failed', exitCode: 1, output: expectedSeededLintOutput(workspace) }); assert.throws(() => a.auditTurn(value));
});
negative('server lint public status cannot conceal real failed native result', value => {
  for (const message of [value.reply.message, value.storedMessage, value.events.find(row => row.type === 'responseComplete').payload.message]) message.toolCalls[1].status = 'completed';
  value.events.find(row => row.type === 'toolResult' && row.payload.id === 'tool-21-1').payload.status = 'completed';
}, 21);
negative('server lint live output cannot replace exact native output bytes', value => { value.events.find(row => row.type === 'toolResult' && row.payload.id === 'tool-21-1').payload.output += 'hidden'; }, 21);
negative('server lint persisted output cannot omit a diagnostic', value => {
  for (const message of [value.reply.message, value.storedMessage, value.events.find(row => row.type === 'responseComplete').payload.message]) message.toolCalls[1].output = 'omitted';
}, 21);
check('compact turn21 boundary hydration feeds the unchanged native/public auditor', () => {
  const value = turn(21), file = path.join(directory, 'hydrated-turn21.json'); compact.writeJson(file, value);
  const encoded = JSON.parse(fs.readFileSync(file)); assert.equal(encoded.reply.beforeBoundary[compact.TAG], 1); assert.equal(encoded.reply.afterBoundary[compact.TAG], 1);
  const hydrated = compact.readJson(file); assert.deepEqual(hydrated, copy(value)); a.auditTurn(hydrated);
});
check('corrupt compressed boundary rejects before native/public audit acceptance', () => {
  const target = path.join(directory, 'corrupt-hydration'); fs.mkdirSync(target);
  const file = path.join(target, 'turn21.json'); compact.writeJson(file, turn(21));
  const encoded = JSON.parse(fs.readFileSync(file)), blob = path.join(target, encoded.reply.afterBoundary.relative), bytes = fs.readFileSync(blob);
  bytes[Math.floor(bytes.length / 2)] ^= 1; fs.writeFileSync(blob, bytes);
  assert.throws(() => a.auditTurn(compact.readJson(file)));
});
check('self-consistent compressed but semantically wrong boundary is still rejected', () => {
  const value = turn(21); value.reply.afterBoundary.dependencySnapshots[0].treeSha256 = hash('foreign dependency bytes');
  const file = path.join(directory, 'wrong-boundary.json'); compact.writeJson(file, value);
  assert.throws(() => a.auditTurn(compact.readJson(file)));
});
check('missing boundary object cannot be replaced by current workspace state', () => {
  const target = path.join(directory, 'missing-hydration'); fs.mkdirSync(target);
  const file = path.join(target, 'turn21.json'); compact.writeJson(file, turn(21));
  const encoded = JSON.parse(fs.readFileSync(file)); fs.unlinkSync(path.join(target, encoded.reply.beforeBoundary.relative));
  assert.throws(() => a.auditTurn(compact.readJson(file)));
});

check('native completed status plus nonzero exit preserves actual app-server public completed status', () => assert.equal(a.auditTurn(turn(6)).verifiedTools[0].tool.status, 'completed'));
check('native failed status plus nonzero exit preserves actual app-server public failed status', () => assert.equal(a.auditTurn(turn(6, { failedNonzero: true })).verifiedTools[0].tool.status, 'failed'));
check('a read-only command allowed by untrusted native policy may complete without an interactive card', () => a.auditTurn(turn(2, { withoutApprovals: true })));
check('model refuses deliberate notes probe without mutation; no native-denial credit', () => assert.equal(a.auditTurn(turn(17, { refusal: true })).nativePatchDenied, false));
negative('successful-command status cannot conceal native failure', v => { v.wire.find(r => r.event === 'tool-result').status = 'failed'; });
negative('native failed nonzero cannot become public completed', v => { v.wire.find(r => r.event === 'tool-result').status = 'failed'; }, 6);
negative('wrong-script zero exit cannot manufacture deliberate fault coverage', v => { v.wire.find(r => r.event === 'tool-result').exitCode = 0; }, 6);
negative('successful command must actually exit zero', v => { v.wire.find(r => r.event === 'tool-result').exitCode = 1; });
negative('omitted required command cannot be inferred from prose', v => { const id = v.reply.message.toolCalls[0].id; v.reply.message.toolCalls.shift(); v.storedMessage.toolCalls.shift(); v.events.find(r => r.type === 'responseComplete').payload.message.toolCalls.shift(); v.events = v.events.filter(r => !['toolUse', 'toolResult', 'permissionRequest'].includes(r.type) || !(r.payload.id === id || r.payload.id === 'approval-1-0')); v.observations.shift(); v.wire = v.wire.filter(r => r.itemIdHash !== hash(id) && r.nativeRequestIdHash !== hash('approval-1-0')); v.reply.nativeTools = v.wire.filter(r => ['tool-start', 'tool-result'].includes(r.event)); v.reply.outputEvidence.shift(); });
negative('unaccounted native item start cannot disappear from public evidence', v => { v.wire.push({ ...v.wire.find(r => r.event === 'tool-start'), itemIdHash: hash('hidden') }); v.reply.nativeTools = v.wire.filter(r => ['tool-start', 'tool-result'].includes(r.event)); });
negative('native item result must belong to current session', v => { v.wire.find(r => r.event === 'tool-result').sessionHash = hash('other'); });
negative('native item result must belong to current turn', v => { v.wire.find(r => r.event === 'tool-result').turnHash = hash('other'); });
negative('native command body is independently hashed', v => { v.wire.find(r => r.event === 'tool-result').commandSha256 = hash('echo forged'); });
negative('native command cwd cannot leave owned workspace', v => { v.wire.find(r => r.event === 'tool-result').ownedCwd = false; });
negative('native approval wrong item rejected', v => { v.wire.find(r => r.event === 'approval-request').itemIdHash = hash('other'); });
negative('native approval wrong session rejected', v => { v.wire.find(r => r.event === 'approval-request').sessionHash = hash('other'); });
negative('native approval wrong turn rejected', v => { v.wire.find(r => r.event === 'approval-request').turnHash = hash('other'); });
negative('native approval wrong input hash rejected', v => { v.wire.find(r => r.event === 'approval-request').toolInputSha256 = hash('{}'); });
negative('native approval wrong response ID rejected', v => { v.wire.find(r => r.event === 'approval-decision').nativeRequestIdHash = hash('other'); });
negative('native approval duplicate response rejected', v => { v.wire.push(copy(v.wire.find(r => r.event === 'approval-decision'))); });
negative('native denial may not become accept', v => { v.wire.find(r => r.event === 'approval-decision' && r.decision === 'decline').decision = 'accept'; }, 17);
negative('public denial may not become approved', v => { v.observations.find(r => r.name === 'edit').approved = true; }, 17);
negative('denied item cannot report applied mutation', v => { v.wire.find(r => r.event === 'tool-result' && r.type === 'fileChange').status = 'completed'; }, 17);
negative('denied approval diff must match actual native item', v => { v.wire.find(r => r.event === 'tool-result' && r.type === 'fileChange').changes[0].diffSha256 = hash('other'); }, 17);
negative('source patch needs its real native approval, not only disk state', v => { v.wire = v.wire.filter(r => !['approval-request', 'approval-decision'].includes(r.event) || r.itemIdHash !== hash('tool-8-1') && r.nativeRequestIdHash !== hash('approval-8-1')); v.events = v.events.filter(r => r.type !== 'permissionRequest' || r.payload.id !== 'approval-8-1'); v.observations = v.observations.filter(r => r.id !== 'approval-8-1'); }, 8);
negative('later stage hash cannot be asserted before native patch completion', v => { v.observations[0].beforeFiles = snapshot([...v.completedCases, v.step.patch]); }, 8);
negative('stored assistant content must equal live completed content', v => { v.storedMessage.content += 'forged'; });
negative('native assistant hash must cover all public text', v => { v.wire.find(r => r.event === 'assistant-message').textSha256 = hash('other'); });
negative('native assistant bytes from another session cannot earn credit', v => { v.wire.find(r => r.event === 'assistant-message').sessionHash = hash('other'); });
negative('native assistant bytes from another turn cannot earn credit', v => { v.wire.find(r => r.event === 'assistant-message').turnHash = hash('other'); });
negative('returned model cannot silently differ', v => { v.reply.session.actualModel = 'other-model'; });
negative('requested MCP inventory cannot differ from config receipt', v => { v.reply.request.policy.mcpNames = ['hidden']; });
negative('extra public response completion cannot hide a second response', v => { v.events.push(copy(v.events.find(r => r.type === 'responseComplete'))); });
negative('live tool output cannot differ from native hash', v => { v.events.find(r => r.type === 'toolResult').payload.output += 'forged'; });
negative('public permission choice cannot authorize another command', v => { v.observations[0].input.command += ' && echo side-effect'; });
for (const [name, output] of [['long TAP with footer after4096', 'x'.repeat(4200) + '\n# tests 45\n# pass 45\n# fail 0\n'], ['surrogate crossing UTF16 cap', 'x'.repeat(4095) + '😀 tail'], ['multilingual output', 'مرحبا • café • € • 😀\n'.repeat(400)]]) {
  check(`${name}: full native/live output and exact persisted prefix accepted`, () => a.auditTurn(turn(1, { output })));
  negative(`${name}: missing truncated marker rejected`, v => { delete v.reply.message.toolCalls[0].truncated; delete v.storedMessage.toolCalls[0].truncated; delete v.events.find(r => r.type === 'responseComplete').payload.message.toolCalls[0].truncated; }, 1, { output });
}
for (const [name, mutate] of [
  ['source', s => { s.hashes[repairs['F2-B01'].path] = repairs['F2-B01'].afterSha256; }],
  ['note', s => { s.hashes[c.NOTE] = hash('changed'); }], ['index', s => { s.indexSha256 = hash('changed'); }],
  ['added file', s => { s.hashes['hidden.txt'] = hash('x'); }], ['omitted file', s => { delete s.hashes['immutable.test.js']; }],
  ['foreign panel history', s => { s.productFiles.push({ relative: '.mysti/compaction/foreign/history.jsonl', path: path.join(workspace, '.mysti/compaction/foreign/history.jsonl'), sha256: hash('x') }); }],
]) check(`snapshot rejects ${name} outside authorized exact stage`, () => { const s = snapshot(); mutate(s); assert.throws(() => a.auditSnapshotEvidence(fixture, s, [], panels)); });
check('exact owned history can be present without expanding source authority', () => { const s = snapshot(); s.productFiles.push({ relative: '.mysti/compaction/synthetic-panel/history.jsonl', path: path.join(workspace, '.mysti/compaction/synthetic-panel/history.jsonl'), sha256: hash('history') }); a.auditSnapshotEvidence(fixture, s, [], panels); });
const logPath = path.join(workspace, 'server/logs/planka.log'), logBytes = 'Owned application diagnostic\n';
fs.mkdirSync(path.dirname(logPath), { recursive: true }); fs.writeFileSync(logPath, logBytes, { flag: 'wx' });
function logSnapshot() { const s = snapshot(); s.applicationLogs.push({ relative: 'server/logs/planka.log', path: logPath, sha256: hash(logBytes), bytes: Buffer.byteLength(logBytes) }); return s; }
check('one exact regular owned application log is recorded separately from source baseline', () => { const s = logSnapshot(); a.auditSnapshotEvidence(fixture, s, [], panels); assert(!Object.hasOwn(s.hashes, 'server/logs/planka.log')); });
check('a historical log snapshot may precede actual later log growth', () => {
  const s = logSnapshot(); fs.appendFileSync(logPath, 'Later application diagnostic\n');
  try { a.auditSnapshotEvidence(fixture, s, [], panels); } finally { fs.writeFileSync(logPath, logBytes); }
});
check('a recorded empty log uses the exact empty-byte digest', () => { const s = logSnapshot(); s.applicationLogs[0].bytes = 0; s.applicationLogs[0].sha256 = hash(''); a.auditSnapshotEvidence(fixture, s, [], panels); });
for (const [name, mutate] of [
  ['missing array', s => { delete s.applicationLogs; }],
  ['duplicate record', s => { s.applicationLogs.push(copy(s.applicationLogs[0])); }],
  ['another relative path', s => { s.applicationLogs[0].relative = 'server/logs/other.log'; }],
  ['different owner', s => { s.applicationLogs[0].path = path.join(directory, 'planka.log'); }],
  ['relative owner path', s => { s.applicationLogs[0].path = 'server/logs/planka.log'; }],
  ['invalid digest', s => { s.applicationLogs[0].sha256 = 'not-a-sha256'; }],
  ['negative byte count', s => { s.applicationLogs[0].bytes = -1; }],
  ['fractional byte count', s => { s.applicationLogs[0].bytes = 1.5; }],
  ['unsafe byte count', s => { s.applicationLogs[0].bytes = Number.MAX_SAFE_INTEGER + 1; }],
  ['string byte count', s => { s.applicationLogs[0].bytes = '27'; }],
  ['empty length with nonempty digest', s => { s.applicationLogs[0].bytes = 0; }],
  ['unexpected metadata key', s => { s.applicationLogs[0].content = 'unretained log body'; }],
  ['log smuggled into source hashes', s => { s.hashes['server/logs/planka.log'] = s.applicationLogs[0].sha256; }],
  ['log smuggled into product history files', s => { s.productFiles.push(copy(s.applicationLogs[0])); }],
]) check(`application log metadata rejects ${name}`, () => { const s = logSnapshot(); mutate(s); assert.throws(() => a.auditSnapshotEvidence(fixture, s, [], panels)); });
check('application log symlink cannot masquerade as owned regular file', () => {
  const outside = path.join(directory, 'outside-log'); fs.writeFileSync(outside, logBytes, { flag: 'wx' }); fs.unlinkSync(logPath); fs.symlinkSync(outside, logPath);
  try { assert.throws(() => a.auditSnapshotEvidence(fixture, logSnapshot(), [], panels)); } finally { fs.unlinkSync(logPath); fs.writeFileSync(logPath, logBytes); }
});
check('application log directory cannot masquerade as regular file', () => {
  fs.unlinkSync(logPath); fs.mkdirSync(logPath);
  try { assert.throws(() => a.auditSnapshotEvidence(fixture, logSnapshot(), [], panels)); } finally { fs.rmdirSync(logPath); fs.writeFileSync(logPath, logBytes); }
});
check('application log hard link cannot share bytes outside the owned log', () => {
  const outside = path.join(directory, 'hard-linked-log'); fs.linkSync(logPath, outside);
  try { assert.throws(() => a.auditSnapshotEvidence(fixture, logSnapshot(), [], panels)); } finally { fs.unlinkSync(outside); }
});
for (const id of c.SELECTED) check(`${id} identical approved patch remains valid before and after actual owned-file change`, () => {
  const file = path.join(workspace, repairs[id].path); assert(c.patchScope(proposals[id], fixture, id)); fs.writeFileSync(file, repairs[id].after);
  try { assert(c.patchScope(proposals[id], fixture, id)); a.auditTurn(turn(steps.find(s => s.patch === id).ordinal)); } finally { fs.writeFileSync(file, repairs[id].before); }
});
const messages = Array.from({ length: 13 }, (_, i) => [{ id: `u${i + 1}`, role: 'user', content: `PB02_REQUEST:${steps[i].marker}` }, { id: `a${i + 1}`, role: 'assistant', content: `answer ${i + 1}` }]).flat();
check('cold initial request includes only current marker with no prior history', () => assert.deepEqual(a.historyExpectation([], 'PB02_REQUEST:CURRENT', new Map(), true).markers, ['CURRENT']));
check('cold editor restart selects exact chronological last10 messages', () => { const r = a.historyExpectation(messages, `PB02_REQUEST:${steps[13].marker}`, new Map(), true); assert.deepEqual(r.selectedMessageIds, messages.slice(-10).map(m => m.id)); assert.deepEqual(r.markers, [...steps.slice(8, 13).map(s => s.marker), steps[13].marker]); });
check('warm continuation replays previously unacknowledged cold-omitted history', () => {
  const first = a.historyExpectation(messages, 'PB02_REQUEST:CURRENT14', new Map(), true), prior = [...messages, { id: 'u14', role: 'user', content: 'PB02_REQUEST:CURRENT14' }, { id: 'a14', role: 'assistant', content: 'answer14' }];
  const next = a.historyExpectation(prior, 'PB02_REQUEST:CURRENT15', first.acknowledged, false);
  assert.deepEqual(next.selectedMessageIds, [...messages.slice(0, 16).map(m => m.id), 'u14', 'a14']); assert.deepEqual(next.markers, [...steps.slice(0, 8).map(s => s.marker), 'CURRENT14', 'CURRENT15']);
});
check('acknowledged exact content is omitted but changed content and role replay', () => {
  const first = a.historyExpectation(messages.slice(0, 2), 'current', new Map(), true), changed = copy(messages.slice(0, 2)); changed[0].content += ' revision'; changed[1].role = 'user';
  assert.deepEqual(a.historyExpectation(changed, 'current', first.acknowledged, false).selectedMessageIds, ['u1', 'a1']);
});
check('acknowledged IDs absent from actual conversation are dropped', () => { const r = a.historyExpectation(messages.slice(0, 2), 'current', new Map([['foreign', hash('x')]]), false); assert(!r.acknowledged.has('foreign')); });
function historyFixture() {
  const prompt = `PB02_REQUEST:${steps[13].marker}`, expected = a.historyExpectation(messages, prompt, new Map(), true);
  return { reply: { prompt, conversationId: 'saved', started: 100, priorMessages: copy(messages), request: { markers: expected.markers.slice(), outsideMemoryMarkers: expected.markers.slice(), memoryMarkers: [] } },
    events: [{ type: 'conversationHistory', at: 90, payload: { conversations: [{ id: 'saved', messages: copy(messages) }] } }], priorMessages: copy(messages) };
}
const historyAudit = value => a.auditHistoryInput(value.reply, value.events, value.priorMessages, new Map(), true);
check('cold request markers join actual pre-send public history and complete durable prefix', () => historyAudit(historyFixture()));
for (const [name, mutate] of [
  ['future marker', v => { v.reply.request.markers.push(steps[24].marker); }],
  ['omitted required history marker', v => { v.reply.request.outsideMemoryMarkers.shift(); }],
  ['false compact-memory classification', v => { v.reply.request.memoryMarkers.push(steps[8].marker); }],
  ['changed prior public content', v => { v.reply.priorMessages[0].content += 'changed'; }],
  ['reordered pre-send history', v => { v.events[0].payload.conversations[0].messages.reverse(); }],
  ['foreign selected conversation', v => { v.events[0].payload.conversations[0].id = 'other'; }],
  ['only post-send history', v => { v.events[0].at = 101; }],
]) check(`history audit rejects ${name}`, () => { const value = historyFixture(); mutate(value); assert.throws(() => historyAudit(value)); });
function processFixture() {
  const at = Date.parse('2026-10-11T12:00:00Z'), birth = new Date(at).toString(), base = { provider: 'openai-codex', window: 'A', wrapperPid: 101 };
  const wire = [{ ...base, event: 'invocation', at, kind: 'app-server', args: ['app-server'] }, { ...base, event: 'start', at: at + 1, childPid: 102 },
    { ...base, event: 'stderr-summary', at: at + 99, bytes: 0, sha256: hash(''), runtimeOnlyProfileArgument: false },
    { ...base, event: 'exit', at: at + 100, childPid: 102, exitCode: 0, signal: null }];
  const ancestry = { sampleIntervalMs: 250, processIdentities: [101, 102].map(pid => ({ pid, startedAt: birth })), processDetails: [] };
  const cleanup = { status: 'PASS_OBSERVED_IDENTITIES_EXITED', observedIdentityCount: 2, remaining: [], unverifiedLiveReceiptPids: [] };
  return { wire, cleanup, ancestry, live: [] };
}
const processAudit = v => a.auditMainProcesses(v.wire, v.cleanup, v.ancestry, v.live);
check('actual main terminal metadata earns complete transport only after observed identities exited', () => assert.equal(processAudit(processFixture()).status, 'PASS_MAIN_TRANSPORT'));
check('missing main terminal preserves honest partial despite actual observed exit', () => { const v = processFixture(); v.wire = v.wire.filter(r => !['stderr-summary', 'exit'].includes(r.event)); assert.equal(processAudit(v).status, 'PARTIAL_MAIN_SHUTDOWN'); });
for (const [name, mutate] of [
  ['living observed identity', v => { v.live = [copy(v.ancestry.processIdentities[0])]; }],
  ['unverified receipt PID still alive', v => { v.live = [{ pid: 102, startedAt: '2026-10-11T11:59:59Z' }]; }],
  ['missing child launch', v => { v.wire = v.wire.filter(r => r.event !== 'start'); }],
  ['probe missing terminal', v => { v.wire[0].kind = 'probe'; v.wire[0].args = ['--version']; v.wire[1].event = 'probe-start'; v.wire = v.wire.slice(0, 2); }],
  ['extra named profile', v => { v.wire[0].args = ['--profile', 'foreign', 'app-server']; }],
  ['native error', v => { v.wire.push({ ...v.wire[0], event: 'native-error' }); }],
  ['orphan wrapper', v => { v.wire.push({ ...v.wire[1], wrapperPid: 999 }); }],
  ['cleanup count shortfall', v => { v.cleanup.observedIdentityCount--; }],
]) check(`process evidence rejects ${name}`, () => { const v = processFixture(); mutate(v); assert.throws(() => processAudit(v)); });
function restartFixture() {
  const birth1 = '2026-10-11T11:00:00Z', birth2 = '2026-10-11T11:30:01Z', profile = path.join(directory, 'profile'), conversation = { id: 'conversation', messages: copy(messages) };
  const make = (pid, birth, panel) => ({ manifest: { windows: { A: { workspace, profile } } }, ancestry: { sampledAt: '2026-10-11T11:30:00Z', processIdentities: [{ pid, startedAt: birth }], processDetails: [{ pid, startedAt: birth, parentPid: 1, parentStartedAt: birth1, executableBasename: 'Code' }] },
    cleanup: { status: 'PASS_OBSERVED_IDENTITIES_EXITED' }, exit: { code: 0, signal: null, timedOut: false }, acceptance: { conversationId: 'conversation', panelId: panel, finalConversation: copy(conversation), replies: [{ started: 100, request: { sessionHash: hash(panel) }, session: { method: 'thread/start' } }] },
    observations: [{ event: 'restart-history-restored', at: 90, conversationId: 'conversation' }], events: [{ type: 'conversationHistory', at: 80, payload: { conversations: [copy(conversation)] } }, { type: 'conversationChanged', at: 85, payload: { id: 'conversation' } }] });
  return [make(100, birth1, 'old'), make(200, birth2, 'new')];
}
check('actual new editor birth and new native thread join exact chronological saved history', () => assert.equal(a.auditRestart(...restartFixture()).nativeHistory, 'RESTORED_PUBLIC_HISTORY_IN_NEW_NATIVE_THREAD'));
for (const [name, mutate] of [
  ['same editor birth', ([x, y]) => { y.ancestry = copy(x.ancestry); }],
  ['new editor started before old cleanup', ([, y]) => { y.ancestry.processDetails[0].startedAt = '2026-10-11T11:20:00Z'; }],
  ['different profile', ([, y]) => { y.manifest.windows.A.profile += '-other'; }],
  ['same native thread', ([x, y]) => { y.acceptance.replies[0].request.sessionHash = x.acceptance.replies[0].request.sessionHash; }],
  ['native resume instead of cold restored thread', ([, y]) => { y.acceptance.replies[0].session.method = 'thread/resume'; }],
  ['reordered durable history', ([, y]) => { y.events[0].payload.conversations[0].messages.reverse(); }],
  ['changed durable content', ([, y]) => { y.events[0].payload.conversations[0].messages[0].content += 'changed'; }],
  ['missing public selection', ([, y]) => { y.events.pop(); }],
  ['editor failed', ([x]) => { x.exit.code = 1; }],
]) check(`restart rejects ${name}`, () => { const pair = restartFixture(); mutate(pair); assert.throws(() => a.auditRestart(...pair)); });
check('45-minute session still distinguishes deliberate injections from ordinary model mistakes and semantics', () => {
  const turns = steps.map(s => a.auditTurn(turn(s.ordinal))); turns.at(-1).completedAt = turns[0].userAt + 45 * 60000;
  const r = a.qualifyCampaign(turns, { editorExited: true, historyRestored: true, priorMessagesPreserved: true }, { status: 'PARTIAL_MAIN_SHUTDOWN' }, { counts: { submitted: 50 } });
  assert.equal(r.status, 'PARTIAL_F2_EVIDENCE'); assert.equal(r.session.elapsedMinutes, 45); assert.deepEqual(r.session.issues, ['ORDINARY_MISTAKE_COVERAGE_NOT_ESTABLISHED_BY_DELIBERATE_INJECTIONS']);
  assert.equal(r.mainTransport.status, 'PARTIAL_MAIN_SHUTDOWN'); assert.equal(r.rootSemanticReview, 'NOT_EVALUATED_BY_MECHANICAL_AUDITOR'); assert.equal(r.W, 'NOT_RUN');
});
check('short duration and model refusal never gain elapsed-session or native-denial coverage', () => {
  const turns = steps.map(s => a.auditTurn(turn(s.ordinal, s.patch === 'deny-notes' ? { refusal: true } : {})));
  const r = a.qualifyCampaign(turns, {}, {}, {}); assert(r.session.issues.includes('SHORTER_THAN_45_REAL_MINUTES')); assert(r.session.issues.includes('NATIVE_DENIED_SCOPE_RECOVERY_NOT_VERIFIED'));
});
/* Auxiliary controls are appended below and use only synthetic receipts. */
function auxiliaryFixture(kinds = ['probe', 'warm', 'quota-failure', 'unvalidated-text', 'killed', 'signal', 'empty']) {
  const birth = 'Sat Oct 10 11:00:00 2026', timestamp = Date.parse(birth), receipts = [], details = [];
  const auxiliary = { provider: 'claude-code', maxInputs: 60, expectedArgs: [...EXPECTED_ARGS], executableIdentity: { path: '/synthetic/claude' } };
  let inputIndex = 0;
  for (const [index, kind] of kinds.entries()) {
    const wrapperPid = 20000 + index * 2, childPid = wrapperPid + 1, at = timestamp + 1000 * (index + 1);
    const base = { window: 'A', provider: 'claude-code', lane: 'text-only-auxiliary', wrapperPid };
    const add = (event, offset, fields = {}) => receipts.push({ ...base, event, at: at + offset, ...fields });
    const probe = kind === 'probe', active = !['probe', 'warm'].includes(kind);
    const number = active ? ++inputIndex : undefined;
    for (const [pid, executableBasename, parentPid] of [[wrapperPid, 'node', 100], [childPid, 'claude', wrapperPid]]) {
      details.push({ pid, parentPid, startedAt: birth, parentStartedAt: birth, executableBasename,
        firstObservedAt: new Date(at).toISOString(), lastObservedAt: new Date(at + 100).toISOString() });
    }
    add(probe ? 'probe-start' : 'auxiliary-start', 0, { childPid, childStartedAt: birth,
      processBirths: [{ pid: wrapperPid, startedAt: birth }, { pid: childPid, startedAt: birth }],
      executable: '/synthetic/claude', args: probe ? ['--version'] : [...EXPECTED_ARGS],
      cwd: probe ? '/owned/workspace' : `/private/tmp/mysti-text-worker-C${index}`,
      isolatedCwd: !probe, environmentForwardedUnchanged: true, safeModeEnvironment: !probe, pwdMatchesCwd: true,
      ...(!probe ? { cwdMode: 0o700, cwdInitiallyEmpty: true } : {}) });
    const input = { inputIndex: number, inputBytes: active ? 32 : 0, inputSha256: hash(active ? 'synthetic prompt' : ''),
      inputEnded: true, purpose: active ? 'title' : 'no-input' };
    if (active) {
      add('auxiliary-input', 1, { inputIndex: number });
      add('auxiliary-input-progress', 2, { ...input, inputEnded: false });
    }
    add('auxiliary-submission', 3, input);
    const text = ['quota-failure', 'unvalidated-text'].includes(kind) ? 'quota limit text is not semantic success' : probe ? 'synthetic version' : '';
    const output = { stdoutBytes: Buffer.byteLength(text), stderrBytes: 0, stdoutSha256: hash(text), stderrSha256: hash('') };
    if (text) add('auxiliary-output-progress', 4, { stream: 'stdout', bytes: output.stdoutBytes, sha256: output.stdoutSha256, inputIndex: number });
    if (kind === 'killed') continue;
    const terminal = { childPid, exitCode: kind === 'quota-failure' ? 1 : kind === 'signal' ? null : 0,
      signal: kind === 'signal' ? 'SIGTERM' : null, ...output };
    if (!probe) add('auxiliary-result', 5, { ...terminal, ...input,
      outcome: !active ? 'NO_INPUT_WORKER_EXIT' : ['quota-failure', 'signal'].includes(kind) ? 'TRANSPORT_FAILED' : text ? 'TEXT_RETURNED_UNVALIDATED' : 'EMPTY_TEXT',
      diagnosticClassification: kind === 'quota-failure' ? 'QUOTA_OR_RATE_LIMIT' : 'UNKNOWN_OR_NONE',
      diagnosticEvidence: 'FIRST_8192_BYTES_PER_STREAM_PATTERN_ONLY',
      semanticSuccess: 'NOT_INFERRED_FROM_TRANSPORT' });
    add(probe ? 'probe-exit' : 'exit', 6, { ...terminal, inputIndex: number });
  }
  const ancestry = { sampleIntervalMs: 250, processIdentities: details.map(({ pid, startedAt }) => ({ pid, startedAt })), processDetails: details };
  const cleanup = { status: 'PASS_OBSERVED_IDENTITIES_EXITED', observedIdentityCount: details.length,
    remaining: [], unverifiedLiveReceiptPids: [], auxiliaryAccountingErrors: [],
    textAuxiliaryInputs: inputIndex, auxiliaryInputs: 0, combinedAuxiliaryInputs: inputIndex };
  return { auxiliary, receipts, ancestry, cleanup, counter: { forwardedInputs: inputIndex, maxInputs: 60 }, live: [],
    primaryAuxiliaryInputs: 0, temporaryRoot: '/private/tmp', probeDirectories: ['/owned/workspace'] };
}
check('cap60 helper module changes only the inherited hard input bound', () => {
  const old = fs.readFileSync(path.join(__dirname, 'codex-full-followup-auxiliary.cjs'), 'utf8');
  assert.equal(fs.readFileSync(path.join(__dirname, 'codex-f2-auxiliary.cjs'), 'utf8'), old.replace('const MAX_INPUTS = 32;', 'const MAX_INPUTS = 60;'));
  assert.equal(auxiliary.MAX_INPUTS, 60);
});
check('60 independently accounted helper inputs accepted without semantic-success credit', () => { const r = auxiliary.auditEvidence(auxiliaryFixture(Array(60).fill('empty'))); assert.equal(r.counts.submitted, 60); assert.equal(r.counts.semanticSuccessesVerified, 0); });
check('61 helpers rejected even if all counters agree', () => { const value = auxiliaryFixture(Array(61).fill('empty')); assert.throws(() => auxiliary.auditEvidence(value)); });
check('helper mixed transport outcomes preserve unknown terminals and quota failures', () => { const r = auxiliary.auditEvidence(auxiliaryFixture()); assert.equal(r.counts.terminalUnobserved, 1); assert.equal(r.counts.failedProcesses, 1); assert.equal(r.counts.semanticSuccessesVerified, 0); });
for (const [name, mutate] of [
  ['counter shortfall', v => { v.counter.forwardedInputs--; }], ['counter excess', v => { v.counter.forwardedInputs++; }],
  ['cap downgrade', v => { v.counter.maxInputs = 32; }], ['unaccounted input', v => { v.receipts = v.receipts.filter(r => r.event !== 'auxiliary-input' || r.inputIndex !== 1); }],
  ['builtin tool enabled', v => { const s = v.receipts.find(r => r.event === 'auxiliary-start'); s.args[s.args.indexOf('--tools') + 1] = 'Bash'; }],
  ['foreign executable', v => { v.receipts.find(r => r.event === 'auxiliary-start').executable = '/other/claude'; }],
  ['living owned identity', v => { v.live = [copy(v.ancestry.processIdentities[1])]; }],
  ['receipt body forbidden', v => { v.receipts.find(r => r.event === 'auxiliary-input').prompt = 'unretained body'; }],
  ['fake semantic success', v => { v.receipts.find(r => r.event === 'auxiliary-result').semanticSuccess = true; }],
  ['missing input ancestry', v => { v.receipts.find(r => r.event === 'auxiliary-start').processBirths = []; }],
]) check(`helper policy/accounting rejects ${name}`, () => { const v = auxiliaryFixture(); mutate(v); assert.throws(() => auxiliary.auditEvidence(v)); });
function auxiliarySegments() {
  const v = auxiliaryFixture(Array(4).fill('empty')), counterFile = path.join(directory, 'aux-counter.json');
  v.auxiliary.counterFile = counterFile;
  const segments = [0, 1].map(index => {
    const wanted = new Set(v.receipts.filter(r => r.event === 'auxiliary-start').slice(index * 2, index * 2 + 2).map(r => r.wrapperPid));
    const auxiliaryReceipts = v.receipts.filter(r => wanted.has(r.wrapperPid));
    const pids = new Set(auxiliaryReceipts.filter(r => r.event === 'auxiliary-start').flatMap(r => [r.wrapperPid, r.childPid]));
    const processIdentities = v.ancestry.processIdentities.filter(r => pids.has(r.pid)), processDetails = v.ancestry.processDetails.filter(r => pids.has(r.pid));
    return { manifest: { auxiliary: copy(v.auxiliary) }, auxiliaryReceipts, ancestry: { sampleIntervalMs: 250, processIdentities, processDetails },
      cleanup: { ...copy(v.cleanup), textAuxiliaryInputs: 2, combinedAuxiliaryInputs: 2, observedIdentityCount: processIdentities.length } };
  });
  return { segments, counter: v.counter };
}
check('global helper indices span both editor segments without resetting reservations', () => { const v = auxiliarySegments(); const r = a.combineAuxiliaryEvidence(v.segments, v.counter, [], '/private/tmp'); assert.equal(r.counts.submitted, 4); });
for (const [name, mutate] of [
  ['segment2 resets input index', v => { for (const row of v.segments[1].auxiliaryReceipts) if (row.inputIndex) row.inputIndex -= 2; }],
  ['segment2 changes policy', v => { v.segments[1].manifest.auxiliary.maxInputs = 61; }],
  ['segment2 uses different counter', v => { v.segments[1].manifest.auxiliary.counterFile += '-other'; }],
  ['segment1 hides helper total', v => { v.segments[0].cleanup.textAuxiliaryInputs--; }],
  ['duplicate process birth across editor segments', v => { v.segments[1].ancestry.processIdentities.push(copy(v.segments[0].ancestry.processIdentities[0])); v.segments[1].cleanup.observedIdentityCount++; }],
  ['primary auxiliary silently counted as zero', v => { v.segments[1].cleanup.auxiliaryInputs = 1; }],
]) check(`combined helper accounting rejects ${name}`, () => { const v = auxiliarySegments(); mutate(v); assert.throws(() => a.combineAuxiliaryEvidence(v.segments, v.counter, [], '/private/tmp')); });
for (const ordinal of [1, 3, 6, 7, 21]) check(`write-capable step ${ordinal} cannot succeed without its actual native approval`, () => assert.throws(() => a.auditTurn(turn(ordinal, { withoutApprovals: true }))));
negative('missing before dependency boundary rejected', value => { value.reply.beforeBoundary = null; }, 3);
negative('missing after dependency boundary rejected', value => { value.reply.afterBoundary = null; }, 3);
negative('after boundary cannot use another source snapshot', value => { value.reply.afterBoundary.files.hashes['immutable.test.js'] = hash('changed'); }, 3);
check('permission refusal stays separate from deliberate missing script', () => assert.throws(() => a.auditTurn(turn(6, { output: 'npm error code EPERM\ncache write denied\n' }))));
check('quoted missing-script text must occur as the actual diagnostic line', () => assert.throws(() => a.auditMissingScript('I would expect Missing script: "client:tset" eventually')));
check('another missing script is not the deliberate fault', () => assert.throws(() => a.auditMissingScript('npm error Missing script: "other"')));
check('ANSI-wrapped actual missing script diagnostic passes', () => a.auditMissingScript('\x1b[31mnpm error Missing script: "client:tset"\x1b[0m\n'));
for (const [name, mutate] of [
  ['dependency hash', value => { value.dependencySnapshots[0].treeSha256 = hash('other'); }],
  ['dependency file count', value => { value.dependencySnapshots[0].files++; }],
  ['dependency owner', value => { value.dependencySnapshots[0].target = '/outside/node_modules'; }],
  ['omitted dependency', value => { value.dependencySnapshots.pop(); }],
  ['cache root', value => { value.cacheSnapshot.root += '/other'; }],
  ['cache HTTP activity', value => { value.cacheSnapshot.httpActivity.push({ relative: 'x', lineNumber: 1, lineSha256: hash('http fetch GET') }); }],
  ['cache total', value => { value.cacheSnapshot.bytes++; }],
  ['build omitted', value => { value.buildSnapshot = null; }],
  ['build source mismatch', value => { value.buildSnapshot.sourceMapMatches['client/src/models/List.js'] = hash('other'); }],
  ['build source omitted', value => { delete value.buildSnapshot.sourceMapMatches['client/src/models/List.js']; }],
  ['build source invented', value => { value.buildSnapshot.sourceMapMatches['client/src/other.js'] = hash('other'); }],
  ['build map absent', value => { value.buildSnapshot.files[0].relative = 'static/main.js'; value.buildSnapshot.files[0].path = path.join(value.buildSnapshot.root, 'static/main.js'); }],
  ['temporary owner', value => { value.applicationTemporarySnapshot = { root: '/outside', files: [], fileCount: 0, bytes: 0 }; }],
]) check(`generated boundary rejects ${name}`, () => { const value = boundary(c.SELECTED, true); mutate(value); assert.throws(() => a.auditBoundary(fixture, value, c.SELECTED, panels, true)); });
function cacheFile(relative, text) { return { relative, path: path.join(fixture.commandPolicy.craCacheRoot, relative), sha256: hash(text), bytes: Buffer.byteLength(text) }; }
for (const relative of ['foreign/file', 'pb02-scoped/foreign/file']) check(`cache rejects unapproved sibling ${relative}`, () => {
  const value = boundary(); const row = cacheFile(relative, 'x'); value.cacheSnapshot.files = [row]; value.cacheSnapshot.fileCount = 1; value.cacheSnapshot.bytes = 1;
  assert.throws(() => a.auditBoundary(fixture, value, [], panels));
});
function actualLog(name, text) {
  const value = boundary(), relative = `pb02-scoped/npm/_logs/${name}.log`, row = cacheFile(relative, text);
  fs.mkdirSync(path.dirname(row.path), { recursive: true }); fs.writeFileSync(row.path, text, { flag: 'wx' });
  value.cacheSnapshot.files = [row]; value.cacheSnapshot.fileCount = 1; value.cacheSnapshot.bytes = row.bytes; return value;
}
check('actual retained npm diagnostic without HTTP fetch passes; plain URL is not network evidence', () => {
  const value = actualLog('plain', '0 verbose title npm run lint\n1 verbose registry https://registry.npmjs.org\n');
  assert.equal(a.auditNpmLogHistory(fixture, [value], value).retainedLogFiles, 1);
});
check('actual HTTP fetch cannot hide behind empty recorded httpActivity', () => {
  const value = actualLog('fetch', '15 http fetch GET 200 https://registry.npmjs.org/npm 438ms (cache updated)\n');
  assert.throws(() => a.auditNpmLogHistory(fixture, [value], value));
});
check('historical npm log cannot be removed before final review', () => {
  const value = actualLog('removed', '0 verbose title npm test\n'); assert.throws(() => a.auditNpmLogHistory(fixture, [value], boundary()));
});
check('historical npm log digest cannot be replaced by a later clean log', () => {
  const value = actualLog('replaced', '0 verbose title npm test\n'), later = copy(value); later.cacheSnapshot.files[0].sha256 = hash('changed');
  assert.throws(() => a.auditNpmLogHistory(fixture, [value], later));
});
check('actual npm log bytes must match recorded digest', () => {
  const value = actualLog('changed', '0 verbose title npm test\n'); fs.appendFileSync(value.cacheSnapshot.files[0].path, 'changed');
  assert.throws(() => a.auditNpmLogHistory(fixture, [value], value));
});
function browserFixture() {
  const value = boundary(c.SELECTED, true);
  return { build: { completedAt: 100, afterBoundary: value }, observation: { event: 'external-evidence-needed', marker: steps[21].marker, at: 110, boundary: copy(value) }, reviewed: { at: 120 }, reply: { marker: steps[21].marker, started: 130 } };
}
const browserAudit = value => a.auditBrowserBoundary(fixture, value.build, value.observation, value.reviewed, value.reply, panels);
check('browser evidence begins from exact completed native build before external rebuild', () => browserAudit(browserFixture()));
for (const [name, mutate] of [
  ['stale build', value => { value.observation.boundary.buildSnapshot.files[0].sha256 = hash('other'); }],
  ['observation predates native build', value => { value.observation.at = 90; }],
  ['review predates boundary', value => { value.reviewed.at = 105; }],
  ['another marker', value => { value.observation.marker = 'OTHER'; }],
]) check(`browser join rejects ${name}`, () => { const value = browserFixture(); mutate(value); assert.throws(() => browserAudit(value)); });
const boundaryRecord = () => ({ label: 'after-21', at: 110, durationMs: 10, snapshot: boundary(c.SELECTED, true) });
check('stored boundary record joins passive observation and actual interval', () => { const record = boundaryRecord(); a.auditBoundaryRecord(record.label, record.snapshot, record, { ...record, event: 'boundary', at: 111, durationMs: 11 }, 100, 120); });
for (const [name, mutate] of [
  ['wrong label', value => { value.label = 'other'; }], ['negative duration', value => { value.durationMs = -1; }],
  ['future timestamp', value => { value.at = 121; }], ['changed snapshot', value => { value.snapshot.cacheSnapshot.bytes++; }],
]) check(`stored boundary rejects ${name}`, () => { const record = boundaryRecord(), observed = { ...copy(record), event: 'boundary', at: 111, durationMs: 11 }; mutate(record); assert.throws(() => a.auditBoundaryRecord('after-21', observed.snapshot, record, observed, 100, 120)); });
const report = { status: checks.every(row => row.status === 'PASS') ? 'PASS_SYNTHETIC_CONTROLS' : 'FAIL',
  directory, identities: ['audit-vscode-codex-f2-causal.cjs', 'check-codex-f2-causal-audit.cjs', 'audit-vscode-codex-f2-compact.cjs', 'check-codex-f2-compact-audit.cjs', 'codex-f2-auxiliary.cjs', 'codex-f2-compact-campaign.cjs', 'codex-f2-compact-store.cjs', 'codex-f2-seeded-lint.cjs'].map(name => c.identity(path.join(__dirname, name))),
  checks, scope: 'Pure turn/history/restart/process/snapshot/combined-helper auditing only; no actual editor, application, model request, elapsed S session, or aggregate campaign acceptance is inferred.' };
const target = path.join(directory, 'checks.json'); fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ path: target, status: report.status, passed: checks.filter(row => row.status === 'PASS').length, total: checks.length, failures: checks.filter(row => row.status !== 'PASS') }));
if (report.status === 'FAIL') process.exitCode = 1;
