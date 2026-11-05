/* Owned authorization controls; no editor, provider, app, database or dependency install. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const c = require('./codex-f2-task-due-date-retry-campaign.cjs');
const proof = require('./codex-f2-test-proof.cjs');
const root = path.resolve(__dirname, '../../out-test/feature-tests/PB-02');
const overnight = path.join(root, 'overnight-20261011');
const directory = fs.mkdtempSync(path.join(root, 'f02-campaign-controls-')), workspace = path.join(directory, 'workspace');
fs.mkdirSync(workspace); const checks = [], clone = value => JSON.parse(JSON.stringify(value));
function check(name, run) { try { run(); checks.push({ name, status: 'PASS' }); } catch (error) { checks.push({ name, status: 'FAIL', error: String(error.stack).slice(0, 2000) }); } }
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function mutate(file, text, run) { const before = fs.readFileSync(file); fs.writeFileSync(file, text); try { run(); } finally { fs.writeFileSync(file, before); } }
const priorRecord = c.pinned(c.PRIOR_NATIVE_CHECKPOINT); c.assertPriorCheckpointRecord(priorRecord); c.draftProvenance();
const binding = { workspace: priorRecord.workspace, files: priorRecord.files, completedFeatures: priorRecord.completedFeatures,
  priorMechanicalStatus: priorRecord.mechanical, priorAggregateStatus: priorRecord.mechanicalAggregateStatus, inheritedAcceptanceBasis: priorRecord.priorAcceptanceBasis };
check('pending qualification fails closed before preparation', () => {
  if (c.QUALIFICATION === null) assert.throws(() => c.assertNativePreparationReady(), /Final local F02 qualification is unresolved/);
  else assert.equal(c.assertNativePreparationReady().status, 'VERIFIED_NATIVE28_F06_CHECKPOINT_WITH_INHERITED_SUPPLEMENTAL_BASIS');
});
for (const [relative, sha256] of Object.entries(binding.files.hashes)) {
  const from = c.exactFile(binding.workspace, relative); assert.equal(c.identity(from).sha256, sha256);
  const to = path.join(workspace, relative); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
}
const repairs = Object.fromEntries(c.PATCHES.map((row, index) => [row.id, { path: row.path, kind: row.kind,
  before: row.kind === 'add' ? '' : fs.readFileSync(path.join(workspace, row.path), 'utf8'), beforeSha256: row.beforeSha256,
  after: fs.readFileSync(row.candidate.path, 'utf8'), afterSha256: row.afterSha256, initialSha256: row.beforeSha256,
  requiredCases: c.SELECTED.slice(0, index), featureId: c.FEATURE_ID, completionKind: 'INTERNAL_PATCH_ONLY' }]));
const fixture = { workspace, repairs, files: Object.fromEntries(Object.entries(binding.files.hashes).map(([p, sha256]) => [p, { sha256 }])),
  indexSha256: binding.files.indexSha256, commandPolicy: c.buildCommandPolicy(workspace), generatedDirectories: ['client/build', 'client/node_modules', 'node_modules', 'server/.tmp', 'server/node_modules'] };
const proposed = row => [{ path: row.path, kind: row.kind === 'add' ? { type: 'add' } : { type: 'update', move_path: null }, diff: fs.readFileSync(row.patch.path, 'utf8') }];
check('actual native28 preserves mechanical PASS, aggregate PARTIAL and historical N25 failure', () => {
  assert.equal(binding.priorMechanicalStatus, 'PASS_MECHANICAL_18'); assert.equal(binding.priorAggregateStatus, 'PARTIAL_F2_CSV_EXPORT_SEQUENTIAL_EVIDENCE');
  assert.equal(binding.inheritedAcceptanceBasis.strictAggregateStatus, 'FAIL'); assert.equal(binding.inheritedAcceptanceBasis.supplementalReviewerPrelaunchPinned, false);
  assert.deepEqual(binding.completedFeatures, ['F2-F05', 'F2-F04', 'F2-F06']); assert.equal(Object.keys(binding.files.hashes).length, 1015);
  assert.throws(() => c.assertNativePreparationReady({ ...c.PRIOR_NATIVE_CHECKPOINT, sha256: '0'.repeat(64) }));
});
check('baseline copied without any F02 candidate changes', () => { c.verifySnapshot(fixture); assert.equal(c.SELECTED.length, 11); assert.equal(c.PATCHES.filter(p => p.kind === 'add').length, 1); });
check('later approval cannot precede the first actual patch', () => assert(!c.patchScope(proposed(c.PATCHES[1]), fixture, c.SELECTED[1])));
let completed = [];
for (const pin of c.PATCHES) {
  const repair = repairs[pin.id], proposal = proposed(pin), file = path.join(workspace, pin.path);
  check(pin.id + ': exact observed native kind and diff admitted', () => assert(c.patchScope(proposal, fixture, pin.id)));
  check(pin.id + ': duplicate files, traversal, unrelated path, kind and rename rejected', () => {
    assert(!c.patchScope([...proposal, ...proposal], fixture, pin.id));
    for (const extra of [{ path: '../outside.js' }, { path: 'server/unrelated.js' }, { kind: { type: 'delete' } }, { kind: { type: pin.kind, move_path: 'elsewhere.js' } }, { kind: { type: pin.kind, movePath: 'elsewhere.js' } }, { kind: { type: pin.kind, unexpected: true } }]) assert(!c.patchScope([{ ...proposal[0], ...extra }], fixture, pin.id));
  });
  check(pin.id + ': extra content and hidden hunks rejected', () => {
    for (const extra of ['+unexpected();\n', '\n@@ -0,0 +1,1 @@\n+hidden();\n']) assert(!c.patchScope([{ ...proposal[0], diff: proposal[0].diff + extra }], fixture, pin.id));
  });
  check(pin.id + ': symlink and hardlink destinations rejected without writing external file', () => {
    const held = file + '.held', outside = path.join(directory, pin.id + '.outside'); write(outside, repair.before || 'outside\n');
    if (fs.existsSync(file)) fs.renameSync(file, held);
    try {
      fs.symlinkSync(outside, file); assert(!c.patchScope(proposal, fixture, pin.id)); fs.unlinkSync(file);
      fs.linkSync(outside, file); assert(!c.patchScope(proposal, fixture, pin.id)); fs.unlinkSync(file);
      assert.equal(fs.readFileSync(outside, 'utf8'), repair.before || 'outside\n');
    } finally { if (fs.existsSync(file)) fs.unlinkSync(file); if (fs.existsSync(held)) fs.renameSync(held, file); }
  });
  if (pin.kind === 'add') {
    check(pin.id + ': dangling symlink and unexpected preexisting bytes rejected', () => {
      fs.symlinkSync(path.join(directory, 'absent'), file); try { assert(!c.patchScope(proposal, fixture, pin.id)); } finally { fs.unlinkSync(file); }
      write(file, 'foreign\n'); try { assert(!c.patchScope(proposal, fixture, pin.id)); } finally { fs.unlinkSync(file); }
    });
    check(pin.id + ': exact raw/addition/unified representations and no truncated payload', () => {
      const alternatives = [repair.after, repair.after.slice(0, -1).split('\n').map(s => '+' + s).join('\n') + '\n', proposal[0].diff];
      for (const diff of alternatives) assert(c.patchScope([{ ...proposal[0], diff }], fixture, pin.id));
      assert(!c.patchScope([{ ...proposal[0], diff: repair.after.slice(0, -2) }], fixture, pin.id));
    });
  }
  check(pin.id + ': only recorded completion admits the exact resulting file', () => {
    write(file, repair.after); assert(c.recordedPatchScope(proposal, fixture, pin.id)); assert(c.patchScope(proposal, fixture, pin.id));
    assert.throws(() => c.verifySnapshot(fixture, completed)); c.verifySnapshot(fixture, [...completed, pin.id]);
  });
  completed.push(pin.id);
}
check('completion IDs are an exact ordered prefix, never feature or prior bug credits', () => {
  for (const ids of [[c.FEATURE_ID], c.INITIAL_CASES, [c.SELECTED[1]], [...completed].reverse(), [...completed, completed[0]]]) assert.throws(() => c.expectedSnapshotHashes(fixture, ids));
  assert.equal(Object.keys(c.expectedSnapshotHashes(fixture, completed)).length, 1016);
});
for (const relative of [c.NOTE, '.git/index', 'server/api/helpers/utils/send-webhooks.js', 'server/.env.sample', 'client/src/models/List.js', 'client/src/components/Card/Tasks.jsx', 'client/src/components/BoardActions/Description.jsx', 'server/api/models/Board.js']) {
  check('preserved prior state rejects change: ' + relative, () => mutate(path.join(workspace, relative), 'changed\n', () => assert.throws(() => c.verifySnapshot(fixture, completed))));
}
check('unknown source file rejected', () => { const file = path.join(workspace, 'unexpected.js'); write(file, 'x\n'); try { assert.throws(() => c.verifySnapshot(fixture, completed)); } finally { fs.unlinkSync(file); } });
const newPin = c.PATCHES.find(row => row.kind === 'add');
check('new-file parent symlink rejected even if it points to identical copied bytes', () => {
  const parent = path.dirname(path.join(workspace, newPin.path)), held = parent + '.held'; fs.renameSync(parent, held); fs.symlinkSync(held, parent);
  try { assert(!c.patchScope(proposed(newPin), fixture, newPin.id)); } finally { fs.unlinkSync(parent); fs.renameSync(held, parent); }
});
for (const dir of [...Object.values(fixture.commandPolicy.cacheDirectories), fixture.commandPolicy.npmLogs]) fs.mkdirSync(dir, { recursive: true });
fixture.dependencyCopies = ['node_modules', 'client/node_modules', 'server/node_modules'].map(relative => {
  const target = path.join(workspace, relative); write(path.join(target, 'unchanged.cjs'), 'synthetic dependency\n');
  return { target, ...proof.dependencyTree(target, relative === 'client/node_modules' ? fixture.commandPolicy.craCacheRoot : undefined) };
});
const steps = c.buildSteps(workspace), before = c.verifyBoundary(fixture, completed), buildStep = steps[c.BUILD_ORDINAL - 1];
check('nineteen useful tasks have ordered approvals, four command gates and 17+2 split', () => {
  assert.equal(steps.length, 19); assert.equal(c.FIRST_SEGMENT_COUNT, 17);
  assert(steps[0].commands.find(command => command.endsWith(' npm --version')).includes("npm_config_offline='true'")); assert.deepEqual(steps[0].requiresEscalation, []);
  assert.deepEqual(steps.filter(s => s.patch).map(s => s.patch), [...c.SELECTED]);
  assert.deepEqual(steps.filter(s => s.requiresEscalation.length).map(s => s.ordinal), [13, 14, 15, 16]);
  assert.deepEqual(steps.filter(s => s.evidence).map(s => s.evidence), ['checkpoint', 'validation', 'restored', 'final']);
  assert.equal(buildStep.nativeBuild, true); assert.equal(steps.filter(s => s.segment === 2).length, 2);
  for (const s of steps.filter(s => s.requiresEscalation.length)) { assert.equal(s.commands.length, 1); assert(s.commands[0].includes("npm_config_offline='true'")); assert(c.promptFor(s, s.commands).includes('normal approval card')); }
});
check('only first successful completed command can qualify', () => {
  c.assertCommandResult({ step: buildStep, result: { status: 'completed', exitCode: 0 } });
  for (const result of [{ status: 'failed', exitCode: 0 }, { status: 'completed', exitCode: 1 }]) assert.throws(() => c.assertCommandResult({ step: buildStep, result }));
  assert.throws(() => c.assertCommandResult({ step: { expectedNonzero: true }, result: { status: 'completed', exitCode: 0 } }));
});
check('nonbuild permits owned cache writes but preserves source/build/dependencies', () => {
  write(path.join(fixture.commandPolicy.npmLogs, 'control.log'), 'timing Completed\n'); c.assertCommandBoundary(before, c.verifyBoundary(fixture, completed), steps[12]);
  mutate(path.join(workspace, 'node_modules/unchanged.cjs'), 'bad\n', () => assert.throws(() => c.verifyBoundary(fixture, completed)));
  mutate(path.join(fixture.commandPolicy.npmLogs, 'control.log'), '1 http fetch GET https://example.invalid/\n', () => assert.throws(() => c.assertCommandBoundary(before, c.verifyBoundary(fixture, completed), steps[12])));
});
const wanted = [...new Set(['client/src/models/List.js', 'client/src/components/Card/Tasks.jsx', ...c.PATCHES.filter(row => row.path.startsWith('client/') && /\.(js|jsx)$/.test(row.path)).map(row => row.path)])];
const map = { sources: wanted.map(row => row.replace('client/src/', '../')), sourcesContent: wanted.map(row => fs.readFileSync(path.join(workspace, row), 'utf8')) };
const mapFile = path.join(fixture.commandPolicy.buildRoot, 'main.js.map'); write(mapFile, JSON.stringify(map)); write(path.join(fixture.commandPolicy.buildRoot, 'index.html'), '<h1>synthetic build</h1>');
const cssRelative = 'client/src/components/CardModal/Tasks/Item.module.scss';
const cssMap = { sources: [cssRelative.replace('client/src/', '')], sourcesContent: [fs.readFileSync(path.join(workspace, cssRelative), 'utf8')] };
const cssFile = path.join(fixture.commandPolicy.buildRoot, 'main.css.map'); write(cssFile, JSON.stringify(cssMap));
check('six dueDate JS/JSX sources and task SCSS required alongside existing List/Tasks build mappings', () => {
  const after = c.verifyBoundary(fixture, completed); assert.equal(Object.keys(after.buildSnapshot.featureSourceMapMatches).length, 7);
  c.assertCommandBoundary(before, after, buildStep); assert.throws(() => c.assertCommandBoundary(before, after, steps[12]));
});
check('missing or wrong dueDate source content rejects otherwise valid build', () => {
  const missing = clone(map); missing.sources.pop(); missing.sourcesContent.pop(); mutate(mapFile, JSON.stringify(missing), () => assert.throws(() => c.verifyBoundary(fixture, completed)));
  const wrong = clone(map); wrong.sourcesContent[3] += 'wrong'; mutate(mapFile, JSON.stringify(wrong), () => assert.throws(() => c.verifyBoundary(fixture, completed)));
});
for (const [name, change] of [
  ['missing SCSS', m => { m.sources = []; m.sourcesContent = []; }],
  ['wrong SCSS bytes', m => { m.sourcesContent[0] += 'wrong'; }],
  ['foreign SCSS path suffix', m => { m.sources[0] = 'foreign/' + m.sources[0]; }],
  ['duplicate SCSS source', m => { m.sources.push(m.sources[0]); m.sourcesContent.push(m.sourcesContent[0]); }],
]) check(name + ' rejects build provenance', () => { const changed = clone(cssMap); change(changed); mutate(cssFile, JSON.stringify(changed), () => assert.throws(() => c.verifyBoundary(fixture, completed))); });
check('entry-actions suffix does not masquerade as actions/tasks source', () => {
  const changed = clone(map); changed.sources.push('../entry-actions/tasks.js'); changed.sourcesContent.push('different entry action bytes');
  mutate(mapFile, JSON.stringify(changed), () => c.verifyBoundary(fixture, completed));
  const missing = clone(changed), index = missing.sources.indexOf('../actions/tasks.js'); assert(index >= 0);
  missing.sources.splice(index, 1); missing.sourcesContent.splice(index, 1);
  mutate(mapFile, JSON.stringify(missing), () => assert.throws(() => c.verifyBoundary(fixture, completed)));
});
check('duplicate JS source joins rejected' , () => { const changed=clone(map); changed.sources.push(changed.sources[2]); changed.sourcesContent.push(changed.sourcesContent[2]); mutate(mapFile,JSON.stringify(changed),()=>assert.throws(()=>c.verifyBoundary(fixture,completed))); });
check('prior checkpoint cannot relabel original failures or omit accepted work', () => {
  const original = c.pinned(c.PRIOR_NATIVE_CHECKPOINT); c.assertPriorCheckpointRecord(original);
  for (const [key,value] of [['mechanicalAuditStatus','PASS'],['mechanical','PASS_MECHANICAL_19'],['acceptedReplies',19],['pendingFeatures',[]]]) {
    const changed = clone(original); changed[key] = value; assert.throws(() => c.assertPriorCheckpointRecord(changed));
  }
});
check('nineteen tasks do not imply S/W/E/P acceptance even after elapsed time', () => {
  const result = c.sessionQualification({ startedAt: 0, endedAt: 3600000, replies: steps.map(s => ({ messageId: String(s.ordinal) })), restart: { editorExited: true, historyRestored: true, priorMessagesPreserved: true } });
  assert.equal(result.status, 'PARTIAL_S_SESSION'); assert.equal(result.W, 'NOT_RUN'); assert(result.issues.length);
});
for (const [relative, sha256] of Object.entries(binding.files.hashes)) assert.equal(c.identity(c.exactFile(binding.workspace, relative)).sha256, sha256, 'Actual native28 untouched by controls');
const result = { schemaVersion: 1, status: checks.every(c => c.status === 'PASS') ? 'PASS' : 'FAIL', directory, checks,
  counts: { passed: checks.filter(c => c.status === 'PASS').length, failed: checks.filter(c => c.status === 'FAIL').length, nativeInputs: 0, editorLaunches: 0 },
  inputs: [c.identity(__filename), c.identity(require.resolve('./codex-f2-task-due-date-retry-campaign.cjs')), c.identity(require.resolve('./codex-f2-task-due-date-retry-steps.cjs')), c.PLAN, ...(c.QUALIFICATION ? [c.QUALIFICATION] : []), c.PRIOR_NATIVE_CHECKPOINT],
  qualificationPending: c.QUALIFICATION === null,
  limitations: 'Synthetic authorization/build boundaries only. Actual add receipt representation, native causal audit, runtime gates and native acceptance remain unexecuted.' };
fs.writeFileSync(path.join(directory, 'checks.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: result.status, ...result.counts, report: path.join(directory, 'checks.json'), failures: checks.filter(c => c.status === 'FAIL') }, null, 2));
if (result.status !== 'PASS') process.exitCode = 1;
