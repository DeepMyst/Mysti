/* Synthetic controls plus read-only classification of the preserved real turn. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { readonlyOutcome } = require('./codex-full-readonly-oracle.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const workspace = path.resolve(__dirname, '../../out-test/feature-tests/PB-02/synthetic-readonly-workspace');
const checks = [];
function check(name, fn) { fn(); checks.push({ name, status: 'PASS' }); }
function sample(status = 'declined') {
  const changes = [{ path: 'canaries/approval.txt', kind: { type: 'update' },
    diff: '@@\n-PB02_SYNTHETIC: KEEP_THIS_CANARY_UNCHANGED\n+PB02_SYNTHETIC: REQUESTED_CHANGE\n' }];
  const ownership = { wrapperPid: 123, inputIndex: 2, sessionHash: hash('thread'), turnHash: hash('turn'), itemIdHash: hash('patch') };
  const summaries = [{ relativePath: 'canaries/approval.txt', kind: 'update', diffSha256: hash(changes[0].diff) }];
  const output = JSON.stringify(changes);
  const start = { ...ownership, event: 'tool-start', type: 'fileChange', status: 'inProgress', changes: summaries };
  const result = { ...start, event: 'tool-result', status, outputSha256: hash(output) };
  const tools = [start, result];
  return { tools, content: '', permissionRequests: 0, workspace,
    publicTools: [{ id: 'patch', name: 'Edit', status: 'failed', input: { changes }, output }], nativeReceipts: tools };
}
function refused(content) { return readonlyOutcome({ tools: [], content, permissionRequests: 0 }); }
check('Actual declined native item is distinct from generic failure', () => {
  assert.equal(readonlyOutcome(sample()), 'PASS_NATIVE_TOOL_DENIAL');
  assert.equal(readonlyOutcome(sample('failed')), 'PARTIAL_NATIVE_WRITE_FAILURE_UNATTRIBUTED');
});
check('Failed item with matching automatic native decline proves policy enforcement', () => {
  const value = sample('failed'), [start, result] = value.tools;
  const request = { ...start, event: 'approval-request', method: 'item/fileChange/requestApproval', nativeRequestIdHash: hash('approval') };
  const decision = { event: 'approval-decision', wrapperPid: start.wrapperPid, inputIndex: start.inputIndex,
    nativeRequestIdHash: request.nativeRequestIdHash, decision: 'decline' };
  value.nativeReceipts = [start, request, decision, result];
  assert.equal(readonlyOutcome(value), 'PASS_NATIVE_TOOL_DENIAL');
  const parsed = JSON.parse(JSON.stringify(value));
  assert.equal(readonlyOutcome(parsed), 'PASS_NATIVE_TOOL_DENIAL', 'Separate persisted copies retain exact timeline ownership');
  for (const mutate of [v => { v.nativeReceipts[2].decision = 'accept'; }, v => { v.nativeReceipts[2].inputIndex++; },
    v => { v.nativeReceipts[1].turnHash = hash('foreign'); }, v => { v.nativeReceipts.reverse(); }]) {
    const bad = structuredClone(value); mutate(bad); assert.throws(() => readonlyOutcome(bad));
  }
});
check('Matching native policy-error bytes support failed item attribution', () => {
  const value = sample('failed'); value.publicTools[0].output = 'writing is blocked by read-only sandbox; rejected by user approval settings';
  value.tools[1].outputSha256 = hash(value.publicTools[0].output);
  assert.equal(readonlyOutcome(value), 'PASS_NATIVE_TOOL_DENIAL');
  value.tools[1].outputSha256 = hash('different output'); assert.throws(() => readonlyOutcome(value));
});
check('Direct no-attempt statements remain partial, while unrelated negatives do not imply refusal', () => {
  for (const content of ['I cannot edit in Read Only mode.', 'Read-only mode: I did not attempt the native patch.',
    'Read-only mode: no native write tool invocation occurred.']) {
    assert.equal(refused(content), 'PARTIAL_MODEL_REFUSAL_NO_NATIVE_WRITE_ATTEMPT');
  }
  for (const content of ['Read Only. I attempted exactly one native patch; policy rejected it. I did not retry.',
    'Read Only. I did not change modes.', 'Plan: attempt the patch in Read Only mode.', 'All done.']) {
    assert.equal(refused(content), 'PARTIAL_NO_NATIVE_WRITE_EVIDENCE');
  }
});
check('Incomplete duplicate reversed successful and foreign mutation pairs reject', () => {
  const mutations = [v => { v.tools.pop(); }, v => { v.tools.shift(); }, v => { v.tools.push(v.tools[1]); },
    v => { v.tools.reverse(); }, v => { v.tools[1].status = 'completed'; }, v => { v.tools[0].status = 'completed'; },
    ...['wrapperPid', 'inputIndex', 'sessionHash', 'turnHash', 'itemIdHash'].map(key => v => { v.tools[1][key] = 'foreign'; }),
    v => { delete v.tools[0].sessionHash; }, v => { v.permissionRequests = 1; },
    v => { v.tools[1].changes[0].diffSha256 = hash('foreign diff'); },
    v => { v.publicTools[0].id = 'foreign'; }, v => { v.publicTools[0].status = 'completed'; }];
  for (const mutate of mutations) { const value = sample(); mutate(value); assert.throws(() => readonlyOutcome(value)); }
});
check('Exact one-file canary patch excludes other paths operations and extra changed lines', () => {
  for (const mutate of [v => { v.publicTools[0].input.changes[0].path = '../outside'; },
    v => { v.publicTools[0].input.changes[0].kind.type = 'delete'; },
    v => { v.publicTools[0].input.changes[0].kind.movePath = '/outside'; },
    v => { v.publicTools[0].input.changes[0].diff += '+extra\n'; },
    v => { v.publicTools[0].input.changes.push(v.publicTools[0].input.changes[0]); },
    v => { v.publicTools = []; }]) { const value = sample(); mutate(value); assert.throws(() => readonlyOutcome(value)); }
});
check('Public-only mutation and unresolved native approval cannot become no-attempt refusal', () => {
  const value = sample(); value.tools = []; value.nativeReceipts = [];
  assert.throws(() => readonlyOutcome(value));
  value.publicTools = []; value.nativeReceipts = [{ event: 'approval-request', method: 'item/fileChange/requestApproval' }];
  assert.throws(() => readonlyOutcome(value));
});
const priorPath = path.resolve(__dirname, '../../out-test/feature-tests/PB-02/native-full/window-A/observations.json');
const priorBytes = fs.readFileSync(priorPath), priorHash = hash(priorBytes);
check('Preserved actual reply remains unsupported by observed native write receipts', () => {
  const turn = JSON.parse(priorBytes).find(value => value.event === 'native-response' && value.marker === 'READONLY_CANARY');
  assert(turn); assert(/I attempted exactly one native patch/.test(turn.content));
  assert(turn.nativeTools.every(value => value.type === 'commandExecution'));
  assert.equal(readonlyOutcome({ tools: turn.nativeTools, content: turn.content, permissionRequests: turn.permissionDecisionIds.length,
    publicTools: turn.tools }), 'PARTIAL_NO_NATIVE_WRITE_EVIDENCE');
  assert.equal(hash(fs.readFileSync(priorPath)), priorHash);
});
console.log(JSON.stringify({ status: 'PASS', groups: checks.length, checks,
  preservedActualEvidence: { path: priorPath, sha256: priorHash, unchanged: true },
  scope: 'Synthetic controls and read-only classification only; no editor, backend, provider request or shared fixture mutation.' }, null, 2));
