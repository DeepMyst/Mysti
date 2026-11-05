'use strict';
const fs = require('node:fs'), path = require('node:path'), a = require('node:assert/strict');
const c = require('./codex-f2-webhook-verification-campaign.cjs');
const invocation = require('./codex-f2-webhook-verification-invocation.cjs');
const root = path.resolve(__dirname, '../../out-test/feature-tests/PB-02');
const out = fs.mkdtempSync(path.join(root, 'f2-webhook-verification-contract-controls-')), checks = [];
const clone = value => JSON.parse(JSON.stringify(value));
function test(name, run) { try { run(); checks.push({ name, status: 'PASS' }); } catch (error) { checks.push({ name, status: 'FAIL', error: error.stack }); } }
const checkpoint = c.pinned(c.PRIOR_NATIVE_CHECKPOINT), priorCampaign = c.pinned(checkpoint.campaign);
const b = path.join(root, 'overnight-20261011'), sourcePaths = [...new Set([...c.frozenCases().map(row => row.mutation.path), ...c.PATCHES.map(row => row.path)])];
const dirs = ['baseline', 'seeded', 'prior'].map(name => path.join(out, name));
const originals = [path.join(b, 'f2-adapted-baseline/workspace'), path.join(b, 'f2-workload-preparation/seeded-workspace'), checkpoint.workspace];
for (const [index, dir] of dirs.entries()) for (const relative of sourcePaths) {
  const target = path.join(dir, relative); fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(originals[index], relative), target, fs.constants.COPYFILE_EXCL);
}
const make = () => c.buildRepairs(c.CASE_CONTRACT.path, ...dirs);
const fixture = { ...priorCampaign.fixture, repairs: {}, files: Object.fromEntries(Object.entries(checkpoint.sourceSnapshot.hashes).map(([relative, sha256]) => [relative, { sha256 }])) };
function changed(file, body, check) { const old = fs.readFileSync(file); try { fs.writeFileSync(file, body); check(); } finally { fs.writeFileSync(file, old); } }
test('Actual partial native checkpoint retains 1010 source hashes and no accepted feature', () => {
  const ready = c.assertNativePreparationReady(); a.equal(ready.status, 'VERIFIED_PARTIAL_NATIVE_PATCH_BINDING');
  a.deepEqual(ready.completedFeatures, []); a.deepEqual(ready.files, checkpoint.sourceSnapshot); a.equal(Object.keys(ready.files.hashes).length, 1010);
});
test('An accepted predecessor without F05 is not an interchangeable continuation binding', () => a.throws(() => c.assertNativePreparationReady(checkpoint.priorCheckpoint)));
test('A changed binding hash rejects before preparation', () => a.throws(() => c.assertNativePreparationReady({ ...c.PRIOR_NATIVE_CHECKPOINT, sha256: '0'.repeat(64) })));
test('The eleven actual source files contain twelve repairs plus both F05 patches', () => { a.equal(sourcePaths.length, 11); a.deepEqual(make(), {}); });
test('Reverting the F05 helper to its pre-feature version rejects', () => changed(path.join(dirs[2], c.PATCHES[0].path), fs.readFileSync(path.join(dirs[0], c.PATCHES[0].path)), () => a.throws(make)));
test('Reverting F05 documentation rejects', () => changed(path.join(dirs[2], c.PATCHES[1].path), fs.readFileSync(path.join(dirs[0], c.PATCHES[1].path)), () => a.throws(make)));
test('The qualification workspace mutant is rejected as native source', () => {
  const file = path.join(dirs[2], c.PATCHES[0].path), body = fs.readFileSync(file, 'utf8'); a.equal(body.split('  if (webhook.secret) {').length, 2);
  changed(file, body.replace('  if (webhook.secret) {', "  if (webhook.secret && event !== 'cardUpdate') {"), () => a.throws(make));
});
test('An earlier frontend repair cannot be lost', () => changed(path.join(dirs[2], 'client/src/models/List.js'), 'lost repair', () => a.throws(make)));
test('Changed original seed rejects', () => changed(path.join(dirs[1], 'client/src/models/List.js'), 'changed seed', () => a.throws(make)));
test('Changed baseline rejects', () => changed(path.join(dirs[0], 'client/src/models/List.js'), 'changed baseline', () => a.throws(make)));
test('Expected fixture hashes retain all source bytes', () => a.deepEqual(c.expectedSnapshotHashes(fixture), checkpoint.sourceSnapshot.hashes));
test('A fixture cannot smuggle a new repair', () => a.throws(() => c.checkedRepairs({ ...fixture, repairs: { F05: {} } })));
test('A fixture cannot drop documentation or helper changes', () => { for (const p of c.PATCHES) { const bad = clone(fixture); bad.files[p.path].sha256 = p.beforeSha256; a.throws(() => c.checkedRepairs(bad)); } });
test('Historical patch IDs cannot count as new completions', () => { a.deepEqual(c.SELECTED, []); a.throws(() => c.expectedSnapshotHashes(fixture, c.HISTORICAL_PATCH_IDS)); });
test('All native patch purposes are denied', () => { for (const id of [...c.INITIAL_CASES, ...c.HISTORICAL_PATCH_IDS, 'deny-notes', undefined]) { a.equal(c.patchScope([], fixture, id), false); a.equal(c.recordedPatchScope([], fixture, id), false); } });
const steps = c.buildSteps(fixture.workspace);
test('Six unique read-only tasks use three turns before and after restart', () => { a.deepEqual(steps.map(s => s.ordinal), [1, 2, 3, 4, 5, 6]); a.deepEqual(steps.map(s => s.segment), [1, 1, 1, 2, 2, 2]); a.equal(new Set(steps.map(s => s.marker)).size, 6); a(steps.every(s => s.patch === undefined && s.expectedNonzero === undefined)); });
test('Only native task5 requests exact offline server lint', () => { a.equal(c.LINT_ORDINAL, 5); a.deepEqual(c.BOUNDARY_ORDINALS, [5]); a.equal(c.BUILD_ORDINAL, null); a.equal(steps[4].commands.length, 1); a.equal(steps[4].requiresEscalation.length, 1); a.match(steps[4].commands[0], /ESLINT_USE_FLAT_CONFIG=false npm run server:lint$/); a(steps.filter(s => s.ordinal !== 5).every(s => s.requiresEscalation.length === 0)); });
test('Positive evidence is gated at checkpoint, after restart and final handoff', () => a.deepEqual(steps.filter(s => s.evidence).map(s => [s.ordinal, s.evidence]), [[1, 'checkpoint'], [4, 'validation'], [6, 'final']]));
test('The prompt cannot be converted into a new patch task', () => a.throws(() => c.promptFor({ ...steps[0], patch: 'F2-F05_HELPER' }, steps[0].commands)));
test('A substituted command rejects', () => a.throws(() => c.promptFor(steps[0], ['echo unrelated'])));
test('All successful task results require the first completed zero exit', () => { for (const step of steps) { c.assertCommandResult({ step, result: { status: 'completed', exitCode: 0 } }); a.throws(() => c.assertCommandResult({ step, result: { status: 'completed', exitCode: 1 } })); a.throws(() => c.assertCommandResult({ step, result: { status: 'inProgress', exitCode: 0 } })); } });
test('Elapsed time alone cannot manufacture session acceptance', () => { const q = c.sessionQualification({ startedAt: 0, endedAt: 50 * 60000, replies: steps.map(s => ({ messageId: String(s.ordinal) })), restart: { editorExited: true, historyRestored: true, priorMessagesPreserved: true } }); a.equal(q.status, 'PARTIAL_S_SESSION'); a.equal(q.P, 'NOT_RUN'); });
const rawFeature = c.pinned(checkpoint.functionalAssertions), bugs = c.pinned(checkpoint.regressions);
test('Historical raw receipts remain positive assertions without feature acceptance', () => { const result = c.assertPositiveEvidence({ fixture, feature: rawFeature, bugRegressions: bugs }); a.deepEqual(result.featureIds, []); a.deepEqual(result.verifiedFunctionalFeatureIds, [c.FEATURE_ID]); });
test('Missing create signature rejects', () => { const feature = clone(rawFeature); delete feature.events.find(e => e.body.event === 'cardCreate' && e.route === '/signed-allowed').headers['x-planka-signature']; a.throws(() => c.assertPositiveEvidence({ fixture, feature, bugRegressions: bugs })); });
test('One failing regression prevents positive evidence admission', () => { const bad = clone(bugs); bad.cases[0].status = 'FAIL'; a.throws(() => c.assertPositiveEvidence({ fixture, feature: rawFeature, bugRegressions: bad })); });
test('Positive raw assertions cannot bypass missing native lint', () => a.throws(() => c.assertFeatureEvidence({ fixture, feature: rawFeature, bugRegressions: bugs, completedPatchIds: [] })));
test('Lint with nonzero exit rejects', () => a.throws(() => c.assertFeatureEvidence({ fixture, feature: rawFeature, bugRegressions: bugs, completedPatchIds: [], lintStep: steps[4], lintResult: { status: 'completed', exitCode: 1 } })));
const qualified = invocation.qualifiedRunner(), positive = qualified.qualification.cases.find(row => row.label === 'positive');
const execution = c.pinned(positive.execution), timing = fs.readFileSync(positive.timing.path, 'utf8').trim().split('\n').map(JSON.parse), feature = c.pinned(positive.functionalReport);
const record = () => ({ ...qualified, execution: clone(execution), timing: clone(timing), feature: clone(feature), notBefore: 0, notAfter: Date.now() });
test('Actual qualified positive invocation joins pinned receipts and phase journal', () => a.equal(invocation.assertBoundedInvocation({ featurePin: positive.functionalReport, executionPin: positive.execution, timingPin: positive.timing, nodeIdentity: qualified.node, evidenceDirectory: path.dirname(c.BOUNDED_QUALIFICATION.path), notBefore: 0, notAfter: Date.now() }).status, 'PASS_BOUNDED_F05_INVOCATION'));
const rejectRecord = (name, mutate) => test(name, () => { const r = record(); mutate(r); a.throws(() => invocation.assertInvocationRecords(r)); });
rejectRecord('Timeout with exit0 is rejected', r => { r.execution.timedOut = true; });
rejectRecord('Original sync timeout record is not accepted as a bounded invocation', r => { r.execution = c.pinned(checkpoint.oracleInvocation); });
rejectRecord('Late close at the deadline is rejected', r => { r.execution.closed.elapsedMs = r.execution.deadlineMs; });
rejectRecord('Missing close receipt is rejected', r => { r.execution.closed = null; });
rejectRecord('A signaled process is rejected', r => { r.execution.signal = 'SIGTERM'; });
rejectRecord('A leftover observed identity is rejected', r => { r.execution.remainingObserved = [r.execution.rootIdentity]; });
rejectRecord('A controller cleanup signal disqualifies successful invocation', r => { r.execution.signals = [{ signal: 'SIGTERM' }]; });
rejectRecord('Changing the oracle command is rejected', r => { r.execution.command[1] = '/tmp/alternate.cjs'; });
rejectRecord('An unrelated child PID cannot supply the journal', r => { r.timing[0].pid++; });
rejectRecord('An unrelated receiver PID cannot supply the receipts', r => { r.feature.receiver.pid++; });
rejectRecord('Changed wrapper identity is rejected', r => { r.timing[0].wrapper.sha256 = '0'.repeat(64); });
rejectRecord('Changed core identity is rejected', r => { r.timing[0].core.sha256 = '0'.repeat(64); });
rejectRecord('Missing postflight verification is rejected', r => { r.timing.splice(5, 2); });
rejectRecord('A thrown verification phase is rejected', r => { r.timing[6].outcome = 'threw'; });
rejectRecord('An out-of-order journal is rejected', r => { r.timing[4].seq = 9; });
rejectRecord('Negative phase duration is rejected', r => { r.timing[6].elapsedMs = -1; });
rejectRecord('A raw negative feature report is rejected', r => { r.feature.status = 'FAIL'; });
rejectRecord('A changed phase summary is rejected', r => { r.execution.phaseTimings = []; });
rejectRecord('Evidence outside its consuming window is rejected', r => { r.notBefore = Date.parse(r.execution.finishedAt) + 1; });
rejectRecord('A foreign UID identity is rejected', r => { r.execution.observed[0].uid++; });
const report = { status: checks.every(row => row.status === 'PASS') ? 'PASS_CONTROLS_NO_NATIVE_INFERENCE' : 'FAIL', checks,
  sources: [__filename, require.resolve('./codex-f2-webhook-verification-campaign.cjs'), require.resolve('./codex-f2-webhook-verification-steps.cjs'), require.resolve('./codex-f2-webhook-verification-invocation.cjs')].map(c.identity),
  priorCheckpoint: c.PRIOR_NATIVE_CHECKPOINT, boundedQualification: c.BOUNDED_QUALIFICATION, nativeInputs: 0, editorLaunches: 0, applicationLaunches: 0,
  scope: 'Owned eleven-file source copies and read-only replay of actual historical evidence. Synthetic negative record controls never alter original reports. No native24 or feature acceptance.' };
const output = path.join(out, 'checks.json'); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ report: c.identity(output), checks: checks.length, failures: checks.filter(row => row.status !== 'PASS') }));
process.exitCode = report.status === 'FAIL' ? 1 : 0;
