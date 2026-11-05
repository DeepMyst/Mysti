/* Focused reconstruction/approval/boundary controls. No provider or app launch. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const c = require('./codex-f2-remaining-campaign.cjs');
const proof = require('./codex-f2-test-proof.cjs');
const repo = path.resolve(__dirname, '../..'), root = path.join(repo, 'out-test/feature-tests/PB-02');
const old = path.join(root, 'overnight-20261011');
const source = { contract: path.join(old, 'f2-workload-preparation/contracts/case-contracts.json'),
  baseline: path.join(old, 'f2-adapted-baseline/workspace'), seeded: path.join(old, 'f2-workload-preparation/seeded-workspace'),
  prior: path.join(old, 'native-f2-compact-session/workspace') };
const directory = fs.mkdtempSync(path.join(root, 'f2-remaining-campaign-controls-'));
const workspace = path.join(directory, 'workspace'); fs.mkdirSync(workspace);
const contract = JSON.parse(fs.readFileSync(source.contract));
const casePaths = [...new Set(contract.cases.filter(item => item.kind === 'seeded-bug').map(item => item.mutation.path))];
const inputPins = [c.identity(source.contract), ...['baseline', 'seeded', 'prior'].flatMap(kind => casePaths.map(relative => c.identity(c.exactFile(source[kind], relative))))];
const repairs = c.buildRepairs(source.contract, source.baseline, source.seeded, source.prior);
const fixture = { workspace, repairs, files: {}, commandPolicy: c.buildCommandPolicy(workspace),
  generatedDirectories: ['client/build', 'client/node_modules', 'node_modules', 'server/.tmp', 'server/node_modules'] };
const checks = [];
function check(name, run) { try { run(); checks.push({ name, status: 'PASS' }); } catch (error) { checks.push({ name, status: 'FAIL', message: String(error.message).slice(0, 1500) }); } }
function seed(relative, text) { const file = path.join(workspace, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); fixture.files[relative] = { sha256: c.hash(text) }; }
for (const relative of casePaths) seed(relative, fs.readFileSync(c.exactFile(source.prior, relative), 'utf8'));
seed(c.NOTE, 'KEEP_THIS_DEVELOPER_NOTE\n'); seed('.git/index', 'SYNTHETIC_INDEX_BYTES\n'); seed('unchanged-test.cjs', 'assert(true);\n');
fixture.indexSha256 = fixture.files['.git/index'].sha256;
fixture.deniedNote = { path: c.NOTE, before: 'KEEP_THIS_DEVELOPER_NOTE\n', after: 'REQUESTED_SCOPE_CHANGE\n',
  beforeSha256: c.hash('KEEP_THIS_DEVELOPER_NOTE\n'), afterSha256: c.hash('REQUESTED_SCOPE_CHANGE\n') };
function proposal(repair) {
  assert(repair.before.endsWith('\n') && repair.after.endsWith('\n'));
  const a = repair.before.slice(0, -1).split('\n'), b = repair.after.slice(0, -1).split('\n');
  let prefix = 0, suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
  const start = Math.max(0, prefix - 3), oldEnd = Math.min(a.length, a.length - suffix + 3), newEnd = Math.min(b.length, b.length - suffix + 3);
  const lines = [...a.slice(start, prefix).map(line => ' ' + line), ...a.slice(prefix, a.length - suffix).map(line => '-' + line),
    ...b.slice(prefix, b.length - suffix).map(line => '+' + line), ...a.slice(a.length - suffix, oldEnd).map(line => ' ' + line)];
  return [{ path: repair.path, kind: { type: 'update' }, diff: `@@ -${start + 1},${oldEnd - start} +${start + 1},${newEnd - start} @@\n${lines.join('\n')}\n` }];
}
function mutate(relative, text, run) {
  const file = path.join(workspace, relative), before = fs.readFileSync(file);
  fs.writeFileSync(file, text); try { run(); } finally { fs.writeFileSync(file, before); }
}
check('eight remaining IDs and four initial IDs are disjoint and complete', () => {
  assert.equal(c.SELECTED.length, 8); assert.equal(c.INITIAL_CASES.length, 4);
  assert.equal(new Set([...c.SELECTED, ...c.INITIAL_CASES]).size, 12);
  assert.equal(c.STAGE, 'F2_REMAINING_BUGS'); assert.equal(c.MAIN_CAP, 40); assert.equal(c.HELPER_CAP, 90);
});
check('pinned baseline, whole seed and actual prior checkpoint reconstruct all remaining repairs', () => {
  assert.equal(Object.keys(repairs).length, 8); assert.equal(casePaths.length, 10);
  for (const id of c.SELECTED.filter(id => id !== 'F2-B10')) {
    const item = contract.cases.find(value => value.id === id); assert.equal(repairs[id].afterSha256, item.baselineFileSha256);
  }
});
check('B02 restores only the nullable clearing branch despite two seeded false assignments', () => {
  const r = repairs['F2-B02']; assert.equal(r.before.split('values.isDueDateCompleted = false;').length - 1, 2);
  assert.equal(r.after.split('values.isDueDateCompleted = false;').length - 1, 1);
  assert.equal(r.after.split('values.isDueDateCompleted = null;').length - 1, 1);
});
for (const id of ['F2-B05', 'F2-B07', 'F2-B08']) check(`${id} restores the missing exact block from full baseline bytes`, () => {
  const item = contract.cases.find(value => value.id === id); assert.equal(item.mutation.after, '');
  assert(repairs[id].after.includes(item.mutation.before)); assert.equal(repairs[id].afterSha256, item.baselineFileSha256);
});
check('shared List.js repair chain keeps prior B09 and repairs B10 before B11', () => {
  assert.equal(repairs['F2-B11'].before, repairs['F2-B10'].after);
  assert.deepEqual(repairs['F2-B11'].requiredCases, ['F2-B10']);
  for (const id of ['F2-B10', 'F2-B11']) { assert(repairs[id].after.includes('cardModel.name.toLocaleLowerCase().indexOf(lowerCasedFilter)')); assert.deepEqual(repairs[id].preservedInitialCases, ['F2-B09']); }
  assert(repairs['F2-B10'].after.includes('users.every(')); assert(repairs['F2-B11'].after.includes('users.some('));
});
check('clean copied checkpoint passes with zero new cases completed', () => c.verifySnapshot(fixture));
check('B11 cannot be approved before B10 changes the actual shared source', () => assert(!c.patchScope(proposal(repairs['F2-B11']), fixture, 'F2-B11')));
check('B10 proposal cannot bundle the subsequent B11 repair', () => assert(!c.patchScope(proposal({ ...repairs['F2-B10'], after: repairs['F2-B11'].after }), fixture, 'F2-B10')));
const completed = [];
for (const id of c.SELECTED) {
  const repair = repairs[id], changes = proposal(repair);
  check(`${id}: exact cumulative proposal accepted before application`, () => assert(c.patchScope(changes, fixture, id)));
  check(`${id}: extra file rejected`, () => assert(!c.patchScope([...changes, { ...changes[0], path: 'unchanged-test.cjs' }], fixture, id)));
  check(`${id}: wrong path and rename rejected`, () => {
    assert(!c.patchScope([{ ...changes[0], path: c.NOTE }], fixture, id));
    assert(!c.patchScope([{ ...changes[0], kind: { type: 'update', movePath: 'other.cjs' } }], fixture, id));
  });
  check(`${id}: extra code in otherwise correct patch rejected`, () => assert(!c.patchScope(proposal({ ...repair, after: repair.after + 'process.exit(0);\n' }), fixture, id)));
  check(`${id}: corrupted unified context rejected`, () => assert(!c.patchScope([{ ...changes[0], diff: changes[0].diff.replace(/^ /m, ' INVALID_CONTEXT') }], fixture, id)));
  check(`${id}: applied exact bytes accepted only when completion is recorded`, () => {
    fs.writeFileSync(path.join(workspace, repair.path), repair.after);
    assert(c.patchScope(changes, fixture, id)); assert.throws(() => c.verifySnapshot(fixture, completed));
    c.verifySnapshot(fixture, [...completed, id]);
  });
  completed.push(id);
}
check('latest B11 hash, not the first B10 hash, is the final expected shared-file state', () => {
  const expected = c.expectedSnapshotHashes(fixture, completed), relative = repairs['F2-B11'].path;
  assert.equal(expected[relative], repairs['F2-B11'].afterSha256); assert.notEqual(expected[relative], repairs['F2-B10'].afterSha256);
  assert.deepEqual(c.verifySnapshot(fixture, completed).hashes, expected);
});
check('historical B10 receipt replays after B11 while stale live approval is rejected', () => {
  const changes = proposal(repairs['F2-B10']);
  assert(c.recordedPatchScope(changes, fixture, 'F2-B10'));
  assert(!c.patchScope(changes, fixture, 'F2-B10'));
  assert(!c.recordedPatchScope(proposal({ ...repairs['F2-B10'], after: repairs['F2-B11'].after }), fixture, 'F2-B10'));
});
check('shared-file completion without its prerequisite rejected', () => assert.throws(() => c.expectedSnapshotHashes(fixture, ['F2-B11'])));
check('out-of-order and duplicate completion rejected', () => {
  assert.throws(() => c.expectedSnapshotHashes(fixture, ['F2-B11', 'F2-B10']));
  assert.throws(() => c.expectedSnapshotHashes(fixture, ['F2-B10', 'F2-B10']));
});
check('prior repairs cannot count as new completions', () => assert.throws(() => c.expectedSnapshotHashes(fixture, ['F2-B01'])));
check('a regressed B10 state fails when B11 completion is recorded', () => mutate(repairs['F2-B11'].path, repairs['F2-B10'].after, () => assert.throws(() => c.verifySnapshot(fixture, completed))));
for (const id of c.INITIAL_CASES) check(`${id}: prior repair regression rejected`, () => {
  const item = contract.cases.find(value => value.id === id), text = fs.readFileSync(path.join(workspace, item.mutation.path), 'utf8');
  assert(text.includes(item.mutation.before)); mutate(item.mutation.path, text.replace(item.mutation.before, item.mutation.after), () => assert.throws(() => c.verifySnapshot(fixture, completed)));
});
for (const relative of [c.NOTE, '.git/index', 'unchanged-test.cjs']) check(`exact preserved ${relative} bytes enforced`, () => {
  mutate(relative, fs.readFileSync(path.join(workspace, relative), 'utf8') + 'UNAPPROVED', () => assert.throws(() => c.verifySnapshot(fixture, completed)));
});
check('removed and unapproved added files rejected', () => {
  const file = path.join(workspace, 'unchanged-test.cjs'), bytes = fs.readFileSync(file); fs.unlinkSync(file);
  try { assert.throws(() => c.verifySnapshot(fixture, completed)); } finally { fs.writeFileSync(file, bytes); }
  const extra = path.join(workspace, 'ignored-looking.log'); fs.writeFileSync(extra, 'unexpected');
  try { assert.throws(() => c.verifySnapshot(fixture, completed)); } finally { fs.unlinkSync(extra); }
});
check('source symlink cannot escape patch approval or boundary verification', () => {
  const repair = repairs['F2-B04'], file = path.join(workspace, repair.path), bytes = fs.readFileSync(file), outside = path.join(directory, 'external-source.cjs');
  fs.writeFileSync(outside, bytes); fs.unlinkSync(file); fs.symlinkSync(outside, file);
  try { assert(!c.patchScope(proposal(repair), fixture, 'F2-B04')); assert.throws(() => c.verifySnapshot(fixture, completed)); }
  finally { fs.unlinkSync(file); fs.writeFileSync(file, bytes); }
});
check('source hard link rejected before patch approval', () => {
  const repair = repairs['F2-B04'], linked = path.join(directory, 'hardlink-source.cjs'); fs.linkSync(path.join(workspace, repair.path), linked);
  try { assert(!c.patchScope(proposal(repair), fixture, 'F2-B04')); } finally { fs.unlinkSync(linked); }
});
check('absolute external target and traversal do not widen an approved patch', () => {
  const repair = repairs['F2-B04'], changes = proposal(repair);
  for (const target of [path.join(directory, 'external-source.cjs'), '../external-source.cjs']) assert(!c.patchScope([{ ...changes[0], path: target }], fixture, 'F2-B04'));
});
check('exact application log stays separate from immutable source and rejects siblings', () => {
  const log = path.join(workspace, c.APPLICATION_LOG); fs.mkdirSync(path.dirname(log), { recursive: true }); fs.writeFileSync(log, 'synthetic app output\n');
  const snapshot = c.verifySnapshot(fixture, completed); assert.equal(snapshot.applicationLogs.length, 1); assert(!Object.hasOwn(snapshot.hashes, c.APPLICATION_LOG));
  const extra = path.join(path.dirname(log), 'planka.log.1'); fs.writeFileSync(extra, 'unapproved');
  try { assert.throws(() => c.verifySnapshot(fixture, completed)); } finally { fs.unlinkSync(extra); }
});
check('product history allowance remains bound to exact active panel ID', () => {
  const file = path.join(workspace, '.mysti/compaction/panel_control/history.jsonl'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{}\n');
  try { assert.throws(() => c.verifySnapshot(fixture, completed)); assert.equal(c.verifySnapshot(fixture, completed, ['panel_control']).productFiles.length, 1); }
  finally { fs.unlinkSync(file); }
});
const build = fixture.commandPolicy.buildRoot; fs.mkdirSync(build, { recursive: true }); fs.writeFileSync(path.join(build, 'index.html'), '<h1>synthetic build</h1>');
check('generated browser link remains restricted to exact current-workspace build', () => {
  const view = path.join(workspace, 'server/views/index.ejs'); fs.mkdirSync(path.dirname(view), { recursive: true }); fs.symlinkSync('../../client/build/index.html', view);
  assert.equal(c.verifySnapshot(fixture, completed).assetLinks.length, 1); fs.unlinkSync(view); fs.symlinkSync(path.join(directory, 'external-source.cjs'), view);
  try { assert.throws(() => c.verifySnapshot(fixture, completed)); } finally { fs.unlinkSync(view); }
});
for (const dir of [...Object.values(fixture.commandPolicy.cacheDirectories), fixture.commandPolicy.npmLogs]) fs.mkdirSync(dir, { recursive: true });
fixture.dependencyCopies = ['node_modules', 'client/node_modules', 'server/node_modules'].map(relative => {
  const target = path.join(workspace, relative); fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(path.join(target, 'unchanged.cjs'), 'synthetic dependency\n');
  return { target, ...proof.dependencyTree(target, relative === 'client/node_modules' ? fixture.commandPolicy.craCacheRoot : undefined) };
});
check('scoped dependency/cache/build boundary passes at all-eight completion', () => c.assertBoundary(c.verifyBoundary(fixture, completed)));
check('dependency byte mutation still fails the inherited heavy boundary', () => {
  const file = path.join(workspace, 'node_modules/unchanged.cjs'), bytes = fs.readFileSync(file); fs.appendFileSync(file, 'unexpected');
  try { assert.throws(() => c.verifyBoundary(fixture, completed)); } finally { fs.writeFileSync(file, bytes); }
});
check('npm HTTP fetch activity is still separately rejected', () => {
  const file = path.join(fixture.commandPolicy.npmLogs, 'synthetic.log'); fs.writeFileSync(file, '1 http fetch GET 200 https://example.invalid/ 1ms\n');
  try { const snapshot = c.verifyBoundary(fixture, completed); assert.equal(snapshot.cacheSnapshot.httpActivity.length, 1); assert.throws(() => c.assertBoundary(snapshot)); } finally { fs.unlinkSync(file); }
});
check('build maps join cumulative B11 and preserved prior B12 source bytes', () => {
  const file = path.join(build, 'synthetic.js.map'), sources = ['models/List.js', 'components/Card/Tasks.jsx'];
  const sourcesContent = sources.map(relative => fs.readFileSync(path.join(workspace, 'client/src', relative), 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ sources, sourcesContent }));
  assert.equal(c.verifyBoundary(fixture, completed).buildSnapshot.sourceMapMatches['client/src/models/List.js'], repairs['F2-B11'].afterSha256);
  fs.writeFileSync(file, JSON.stringify({ sources, sourcesContent: [repairs['F2-B10'].after, sourcesContent[1]] }));
  try { assert.throws(() => c.verifyBoundary(fixture, completed)); } finally { fs.unlinkSync(file); }
});
check('all final lint/build commands require native completed status and exit zero', () => {
  const step = c.buildSteps(workspace)[c.BUILD_ORDINAL - 1]; assert.equal(step.ordinal, 30);
  for (const command of step.commands) {
    c.assertCommandResult({ step, command, result: { status: 'completed', exitCode: 0 }, workspace });
    assert.throws(() => c.assertCommandResult({ step, command, result: { status: 'failed', exitCode: 1 }, workspace }));
  }
  assert.equal(c.expectedSeededLintOutput, undefined);
});
check('new steps and session qualification use 34 useful turns and an actual restart', () => {
  const steps = c.buildSteps(workspace); assert.equal(steps.length, 34); assert.equal(c.FIRST_SEGMENT_COUNT, 16);
  assert.deepEqual(steps.filter(step => step.patch).map(step => step.patch), c.SELECTED);
  const result = c.sessionQualification({ startedAt: 0, endedAt: 50 * 60000, replies: steps.map((step, i) => ({ marker: step.marker, messageId: `control-${i}` })), restart: { editorExited: true, historyRestored: true, priorMessagesPreserved: true } });
  assert.equal(result.completedUsefulTurns, 34); assert.equal(result.status, 'PARTIAL_S_SESSION');
});
check('wrong prior-four checkpoint and extra already-repaired remaining case rejected', () => {
  const copied = path.join(directory, 'bad-prior'); fs.mkdirSync(copied);
  for (const relative of casePaths) { const file = path.join(copied, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.copyFileSync(path.join(source.prior, relative), file); }
  const prior = contract.cases.find(item => item.id === 'F2-B01'), file = path.join(copied, prior.mutation.path), bytes = fs.readFileSync(file);
  fs.writeFileSync(file, bytes.toString('utf8').replace(prior.mutation.before, prior.mutation.after));
  assert.throws(() => c.buildRepairs(source.contract, source.baseline, source.seeded, copied)); fs.writeFileSync(file, bytes);
  fs.writeFileSync(path.join(copied, repairs['F2-B02'].path), repairs['F2-B02'].after);
  assert.throws(() => c.buildRepairs(source.contract, source.baseline, source.seeded, copied));
});
check('all external contract/baseline/seed/prior input bytes remain unchanged', () => { for (const pin of inputPins) assert.equal(c.identity(pin.path).sha256, pin.sha256); });
const failed = checks.filter(row => row.status === 'FAIL');
const report = { status: failed.length ? 'FAIL_CONTROLS_NO_NATIVE_INFERENCE' : 'PASS_CONTROLS_NO_NATIVE_INFERENCE', checkedAt: new Date().toISOString(),
  contract: c.identity(require.resolve('./codex-f2-remaining-campaign.cjs')), checker: c.identity(__filename), steps: c.identity(require.resolve('./codex-f2-remaining-steps.cjs')),
  source, inputPins, repairHashes: Object.fromEntries(Object.entries(repairs).map(([id, r]) => [id, { path: r.path, initialSha256: r.initialSha256, beforeSha256: r.beforeSha256, afterSha256: r.afterSha256, requiredCases: r.requiredCases }])),
  checks, passed: checks.length - failed.length, failed: failed.length, nativeCliLaunches: 0, inferenceInputs: 0,
  limitations: ['Synthetic approval and filesystem controls only; no native application, API/SQL, browser, elapsed-session or model-turn acceptance credit.', 'Only new owned fixtures were mutated; frozen original contract, baseline, seeded and previous native source inputs were read and rechecked.'] };
const target = path.join(directory, 'checks.json'); fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ path: target, sha256: c.identity(target).sha256, passed: report.passed, failed: report.failed, failures: failed }));
process.exitCode = failed.length ? 1 : 0;
