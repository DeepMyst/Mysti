/* Additive F04 contract: exact update/create approvals, no native execution on import. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const base = require('./codex-f2-scoped-campaign.cjs');
const compact = require('./codex-f2-compact-store.cjs');
const prior = require('./codex-f2-webhook-verification-campaign.cjs');
const { applyUnifiedDiff } = require('./codex-continuation-contract.cjs');
const root = path.resolve(__dirname, '../../out-test/feature-tests/PB-02');
const overnight = path.join(root, 'overnight-20261011');
const pin = (relative, sha256) => Object.freeze({ path: path.join(overnight, relative), sha256 });
const STAGE = 'F2_BOARD_DESCRIPTION', FEATURE_ID = 'F2-F04', MAIN_CAP = 24, HELPER_CAP = 48;
const PLAN = pin('f04-native-preparation/plan.json', '779eb90590b7007f02e1f92bef092c22a6cc668208943fdc4c6c30af2b2656bd');
const QUALIFICATION = pin('f04-board-description-validation/qualification.json', '23fbbe4a067dc7e74f01255ed9a1f79d106f68e88d545ceb8408c56cd64d2ad9');
const PRIOR_NATIVE_CHECKPOINT = pin('native-f2-webhook-verification-session/root-continuation-checkpoint.json', '3ded2ada74cc0b099da8712dc0a3cf695385b26b0104003d8bcf5c3b13b02968');
const PRIOR_PRESERVATION = pin('native-preservation-after-webhook-verification-session-review.json', '4c70628507e62df8c18492190e68eb1cb71b642cf1ad9a74f00d6cd291c206d9');
function pinned(identity) {
  base.contained(root, identity.path); assert.equal(fs.realpathSync(identity.path), identity.path);
  const stat = fs.lstatSync(identity.path); assert(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(stat.nlink, 1); assert.equal(stat.uid, process.getuid());
  assert.deepEqual(base.identity(identity.path), identity); return compact.readJson(identity.path);
}
const plan = pinned(PLAN);
const PATCHES = Object.freeze(plan.changes.map(row => Object.freeze({ ...row })));
const SELECTED = Object.freeze(PATCHES.map(row => row.id)), PATCH_IDS = SELECTED;
const INITIAL_CASES = prior.INITIAL_CASES, INITIAL_FEATURES = Object.freeze(['F2-F05']);
function candidateProvenance() {
  const actual = pinned(PLAN), qualification = pinned(QUALIFICATION);
  assert.deepEqual(actual, plan); assert.equal(actual.status, 'DRAFT_NATIVE_F04_PLAN_NOT_EXECUTED');
  assert.deepEqual(actual.qualification, QUALIFICATION); assert.deepEqual(actual.priorCheckpoint, PRIOR_NATIVE_CHECKPOINT);
  assert.equal(qualification.status, 'QUALIFIED_LOCAL_F04_CANDIDATE_NATIVE_APPLICATION_PENDING');
  assert.equal(qualification.changes.length, 12); assert.equal(PATCHES.filter(row => row.kind === 'add').length, 2);
  for (const [index, row] of PATCHES.entries()) {
    const qualified = qualification.changes[index];
    for (const field of ['path', 'beforeSha256', 'afterSha256']) assert.deepEqual(row[field], qualified[field]);
    assert.deepEqual(row.candidate, qualified.draftIdentity);
    for (const file of [row.candidate, row.patch]) assert.deepEqual(base.identity(base.exactFile(root, path.relative(root, file.path))), file);
    assert.equal(row.candidate.sha256, row.afterSha256);
  }
  for (const identity of [...qualification.currentReports, ...qualification.preservedFindings, ...qualification.codePins]) assert.deepEqual(base.identity(identity.path), identity);
  return { plan: actual, qualification };
}
function assertNativePreparationReady(identity = PRIOR_NATIVE_CHECKPOINT) {
  assert.deepEqual(identity, PRIOR_NATIVE_CHECKPOINT, 'Only actual native24 may seed this continuation');
  const binding = pinned(identity), preservation = pinned(PRIOR_PRESERVATION);
  assert.equal(binding.status, 'FUNCTIONALLY_VERIFIED_F05_SUPPLEMENTAL_CHECKPOINT');
  assert.equal(binding.stage, 'F2_WEBHOOK_VERIFICATION'); assert.equal(binding.mechanicalAuditStatus, 'FAIL');
  assert.equal(binding.supplementalReviewerPrelaunchPinned, false);
  assert.equal(pinned(binding.mechanicalAudit).status, 'FAIL');
  const supplemental = pinned(binding.supplementalMechanicalAudit);
  assert.equal(supplemental.status, 'SUPPLEMENTAL_PARTIAL_F2_WEBHOOK_VERIFICATION_EVIDENCE');
  assert.equal(supplemental.mechanical, 'PASS_SUPPLEMENTAL_MECHANICAL_6');
  assert.deepEqual(binding.completedCases, INITIAL_CASES); assert.deepEqual(binding.completedFeatures, INITIAL_FEATURES);
  assert.deepEqual(binding.pendingFeatures, ['F2-F01', 'F2-F02', 'F2-F03', 'F2-F04', 'F2-F06']);
  const campaign = pinned(binding.campaign);
  assert.equal(campaign.workspace, binding.workspace);
  const snapshot = prior.verifySnapshot(campaign.fixture, [], binding.panelIds);
  assert.deepEqual(snapshot, binding.sourceSnapshot); assert.deepEqual(pinned(binding.finalBoundary).files, snapshot);
  assert.equal(preservation.status, 'PRESERVED_TWENTY_FOUR_RECORDED_NATIVE_TREES');
  assert.equal(preservation.totalRuns, 24); assert.equal(preservation.totalRecordedFiles, 1191996);
  assert.deepEqual(base.identity(preservation.manifest.path), { path: preservation.manifest.path, sha256: preservation.manifest.sha256 });
  candidateProvenance();
  for (const row of PATCHES) {
    if (row.kind === 'add') { assert(!Object.hasOwn(snapshot.hashes, row.path)); assert(!fs.existsSync(path.join(binding.workspace, row.path))); }
    else assert.equal(snapshot.hashes[row.path], row.beforeSha256);
  }
  return { status: 'VERIFIED_NATIVE24_WITH_EXPLICIT_SUPPLEMENTAL_BASIS', identity, workspace: binding.workspace,
    files: snapshot, completedBugCases: [...INITIAL_CASES], completedFeatures: [...INITIAL_FEATURES],
    priorPrelaunchAggregateStatus: 'FAIL', supplementalReviewPrelaunchPinned: false,
    sessionCredit: 'No new feature, native editing or S/W/E/P credit from local qualification' };
}
function buildRepairs(contractFile, baseline, seeded, priorWorkspace) {
  prior.buildRepairs(contractFile, baseline, seeded, priorWorkspace); candidateProvenance();
  return Object.fromEntries(PATCHES.map((row, index) => {
    const file = path.join(priorWorkspace, row.path);
    const before = row.kind === 'add' ? '' : fs.readFileSync(base.exactFile(priorWorkspace, row.path), 'utf8');
    if (row.kind === 'add') assert(!fs.existsSync(file)); else assert.equal(base.hash(before), row.beforeSha256);
    const after = fs.readFileSync(row.candidate.path, 'utf8'); assert.equal(base.hash(after), row.afterSha256);
    return [row.id, { path: row.path, kind: row.kind, before, beforeSha256: row.beforeSha256, after,
      afterSha256: row.afterSha256, initialSha256: row.beforeSha256, requiredCases: SELECTED.slice(0, index),
      featureId: FEATURE_ID, completionKind: 'INTERNAL_PATCH_ONLY' }];
  }));
}
function checkedRepairs(fixture) {
  assert.deepEqual(Object.keys(fixture.repairs), [...SELECTED]);
  for (const [index, pin] of PATCHES.entries()) {
    const repair = fixture.repairs[pin.id];
    for (const field of ['path', 'kind', 'beforeSha256', 'afterSha256']) assert.equal(repair[field], pin[field]);
    assert.equal(repair.featureId, FEATURE_ID); assert.equal(repair.completionKind, 'INTERNAL_PATCH_ONLY');
    assert.deepEqual(repair.requiredCases, SELECTED.slice(0, index)); assert.equal(repair.initialSha256, pin.beforeSha256);
    assert.equal(base.hash(repair.after), pin.afterSha256);
    if (pin.kind === 'add') { assert.equal(repair.before, ''); assert(!Object.hasOwn(fixture.files, pin.path)); }
    else { assert.equal(base.hash(repair.before), pin.beforeSha256); assert.equal(fixture.files[pin.path]?.sha256, pin.beforeSha256); }
  }
  prior.checkedRepairs({ ...fixture, repairs: {} });
}
function projectedFixture(fixture, completed = []) {
  checkedRepairs(fixture); assert(Array.isArray(completed));
  assert.deepEqual(completed, SELECTED.slice(0, completed.length), 'Exact ordered internal patch prefix');
  assert(completed.length <= SELECTED.length);
  const files = { ...fixture.files };
  for (const id of completed) files[fixture.repairs[id].path] = { sha256: fixture.repairs[id].afterSha256 };
  return { ...fixture, files };
}
function expectedSnapshotHashes(fixture, completed = []) {
  return Object.fromEntries(Object.entries(projectedFixture(fixture, completed).files).map(([name, value]) => [name, value.sha256]));
}
function verifySnapshot(fixture, completed = [], panels = []) {
  const snapshot = base.verifySnapshot(projectedFixture(fixture, completed), [], panels);
  snapshot.completedCases = [...completed]; return snapshot;
}
function verifyBoundary(fixture, completed = [], panels = []) {
  const snapshot = base.verifyBoundary(projectedFixture(fixture, completed), [], panels);
  snapshot.buildSnapshot = featureBuildSnapshot(fixture.workspace, snapshot.buildSnapshot);
  snapshot.files.completedCases = [...completed]; return snapshot;
}
function featureBuildSnapshot(workspace, snapshot) {
  if (!snapshot) return null;
  const wanted = PATCHES.filter(row => row.path.startsWith('client/') && /\.(js|jsx)$/.test(row.path)).map(row => row.path);
  assert.equal(wanted.length, 7); const featureSourceMapMatches = {};
  for (const file of snapshot.files.filter(row => row.relative.endsWith('.js.map'))) {
    const map = JSON.parse(fs.readFileSync(file.path, 'utf8'));
    assert(Array.isArray(map.sources) && Array.isArray(map.sourcesContent)); assert.equal(map.sources.length, map.sourcesContent.length);
    for (const [index, source] of map.sources.entries()) {
      for (const relative of wanted) if (source.replaceAll('\\', '/').endsWith(relative.replace('client/src/', ''))) {
        const bytes = fs.readFileSync(base.exactFile(workspace, relative), 'utf8');
        assert.equal(map.sourcesContent[index], bytes, 'F04 build map matches actual source');
        featureSourceMapMatches[relative] = base.hash(bytes);
      }
    }
  }
  assert.deepEqual(Object.keys(featureSourceMapMatches).sort(), wanted.sort(), 'All seven F04 JavaScript sources are present in the build');
  return { ...snapshot, featureSourceMapMatches };
}
function ownedTarget(workspace, relative) {
  assert.equal(fs.realpathSync(workspace), workspace); assert(!path.isAbsolute(relative));
  assert(!relative.split(/[\\/]/).includes('..')); const target = path.join(workspace, relative); base.contained(workspace, target);
  const parent = path.dirname(target); assert.equal(fs.realpathSync(parent), parent); assert(fs.lstatSync(parent).isDirectory());
  if (fs.existsSync(target) || fs.lstatSync(parent).isSymbolicLink()) {
    base.exactFile(workspace, relative); const stat = fs.lstatSync(target);
    assert.equal(stat.nlink, 1); assert.equal(stat.uid, process.getuid());
  } else {
    // lstat also rejects dangling symlinks, which existsSync alone would miss.
    assert.throws(() => fs.lstatSync(target), { code: 'ENOENT' });
  }
  return target;
}
function exactAddedDiff(diff, after) {
  assert.equal(typeof diff, 'string'); assert(after.endsWith('\n'));
  const lines = after.slice(0, -1).split('\n'), additions = lines.map(line => '+' + line).join('\n') + '\n';
  // App-server add payloads may expose content or addition lines. Every accepted
  // representation reconstructs the same pinned full bytes; no headers or extra hunks.
  return diff === after || diff === additions || diff === `@@ -0,0 +1,${lines.length} @@\n${additions}`;
}
function recordedPatchScope(changes, fixture, purpose) {
  try {
    checkedRepairs(fixture); assert(SELECTED.includes(purpose)); assert(Array.isArray(changes) && changes.length === 1);
    const repair = fixture.repairs[purpose], change = changes[0], file = ownedTarget(fixture.workspace, repair.path);
    assert.equal(typeof change.path, 'string'); assert(!change.path.split(/[\\/]/).includes('..'));
    assert.equal(path.resolve(fixture.workspace, change.path), file);
    assert(change.kind && typeof change.kind === 'object'); assert.equal(change.kind.type, repair.kind);
    assert(Object.keys(change.kind).every(key => ['type', 'move_path', 'movePath'].includes(key)));
    for (const field of ['move_path', 'movePath']) assert(change.kind[field] === undefined || change.kind[field] === null, 'No rename target');
    if (repair.kind === 'add') assert(exactAddedDiff(change.diff, repair.after));
    else assert.equal(applyUnifiedDiff(repair.before, change.diff), repair.after);
    return true;
  } catch { return false; }
}
function patchScope(changes, fixture, purpose) {
  try {
    checkedRepairs(fixture); const repair = fixture.repairs[purpose]; assert(repair);
    for (const id of repair.requiredCases) assert.equal(base.identity(ownedTarget(fixture.workspace, fixture.repairs[id].path)).sha256, fixture.repairs[id].afterSha256);
    const target = ownedTarget(fixture.workspace, repair.path);
    if (fs.existsSync(target)) assert([repair.beforeSha256, repair.afterSha256].includes(base.identity(target).sha256));
    else assert.equal(repair.kind, 'add');
    return recordedPatchScope(changes, fixture, purpose);
  } catch { return false; }
}
function assertCommandBoundary(before, after, step) {
  base.assertBoundary(before); base.assertBoundary(after);
  const source = snapshot => ({ ...snapshot.files, productFiles: snapshot.files.productFiles.map(row => ({ relative: row.relative, path: row.path })) });
  assert.deepEqual(source(after), source(before));
  for (const key of ['dependencySnapshots', 'applicationTemporarySnapshot']) assert.deepEqual(after[key], before[key]);
  if (!step.nativeBuild) assert.deepEqual(after.buildSnapshot, before.buildSnapshot);
  else {
    assert(after.buildSnapshot && after.buildSnapshot.fileCount > 0);
    assert.deepEqual(Object.keys(after.buildSnapshot.featureSourceMapMatches).sort(), PATCHES.filter(row => row.path.startsWith('client/') && /\.(js|jsx)$/.test(row.path)).map(row => row.path).sort());
  }
}
function assertCommandResult({ step, result }) {
  assert.equal(step.expectedNonzero, undefined); assert.equal(result.status, 'completed'); assert.equal(result.exitCode, 0);
}
module.exports = { ...base, ...require('./codex-f2-board-description-steps.cjs'), STAGE, FEATURE_ID, MAIN_CAP, HELPER_CAP,
  PLAN, QUALIFICATION, PRIOR_NATIVE_CHECKPOINT, PRIOR_PRESERVATION, PATCHES, SELECTED, PATCH_IDS,
  INITIAL_CASES, INITIAL_BUG_CASES: INITIAL_CASES, INITIAL_FEATURES, CASE_CONTRACT: prior.CASE_CONTRACT,
  pinned, candidateProvenance, assertNativePreparationReady, buildRepairs, checkedRepairs, projectedFixture,
  expectedSnapshotHashes, verifySnapshot, verifyBoundary, featureBuildSnapshot, ownedTarget, exactAddedDiff, recordedPatchScope, patchScope,
  assertCommandBoundary, assertCommandResult };
