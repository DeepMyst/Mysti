/* Additive final-pair F2 contract. Prior final-three campaign stays frozen. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const base = require('./codex-f2-scoped-campaign.cjs');
const STAGE = 'F2_FINAL_PAIR', MAIN_CAP = 16, HELPER_CAP = 36;
const INITIAL_CASES = Object.freeze(['F2-B01', 'F2-B03', 'F2-B09', 'F2-B12', 'F2-B02', 'F2-B04', 'F2-B05', 'F2-B06', 'F2-B07', 'F2-B08']);
const PRIOR_CHECKPOINT_SHA = 'ef295ef104fbb92e894cb50cf407bdc5a60431bece1083ae67cf8cad1253ac5c';
const SELECTED = Object.freeze(['F2-B10', 'F2-B11']);
function applySeed(source, seed) {
  const { before, after, matches } = seed.mutation;
  assert.equal(typeof before, 'string'); assert(before.length > 0);
  assert.equal(typeof after, 'string'); assert.equal(matches, 1);
  assert.equal(source.split(before).length - 1, matches, `One pinned forward mutation: ${seed.id}`);
  return source.replace(before, after);
}
function buildRepairs(contractFile, baseline, seeded, priorWorkspace) {
  assert.equal(base.identity(contractFile).sha256, base.CONTRACT_SHA);
  const contract = JSON.parse(fs.readFileSync(contractFile, 'utf8'));
  assert.equal(contract.status, 'FROZEN_ACCEPTANCE_CONTRACT');
  // The frozen workload still describes its original four-case first session.
  assert.deepEqual(contract.selectedFirstSessionCaseIds, base.SELECTED);
  const cases = contract.cases.filter(item => item.kind === 'seeded-bug');
  assert.deepEqual(cases.map(item => item.id).sort(), [...INITIAL_CASES, ...SELECTED].sort());
  for (const directory of [baseline, seeded, priorWorkspace]) {
    assert.equal(typeof directory, 'string'); assert.equal(fs.realpathSync(directory), directory);
    assert(fs.lstatSync(directory).isDirectory());
  }
  const paths = new Map();
  for (const item of cases) {
    const relative = item.mutation.path;
    if (paths.has(relative)) continue;
    const related = cases.filter(value => value.mutation.path === relative);
    const original = fs.readFileSync(base.exactFile(baseline, relative), 'utf8');
    for (const other of related) assert.equal(base.hash(original), other.baselineFileSha256, `Pinned baseline: ${other.id}`);
    // Reconstruct forward from the original whole file. This also handles
    // deleted blocks and mutations whose replacement occurs elsewhere twice.
    const reconstruct = fixed => related.reduce((text, seed) => fixed.includes(seed.id) ? text : applySeed(text, seed), original);
    const fullySeeded = reconstruct([]), initial = reconstruct(INITIAL_CASES);
    assert.equal(base.identity(base.exactFile(seeded, relative)).sha256, base.hash(fullySeeded), `Exact complete seed: ${relative}`);
    assert.equal(base.identity(base.exactFile(priorWorkspace, relative)).sha256, base.hash(initial), `Exact previous ten-repair checkpoint: ${relative}`);
    paths.set(relative, { related, reconstruct, initial });
  }
  const repairs = {};
  for (const [index, id] of SELECTED.entries()) {
    const item = cases.find(value => value.id === id), relative = item.mutation.path;
    const { related, reconstruct, initial } = paths.get(relative);
    const preceding = SELECTED.slice(0, index), fixedBefore = [...INITIAL_CASES, ...preceding];
    const before = reconstruct(fixedBefore), after = reconstruct([...fixedBefore, id]);
    assert.notEqual(before, after, `Repair must change its pinned seed: ${id}`);
    repairs[id] = { path: relative, before, beforeSha256: base.hash(before), after, afterSha256: base.hash(after),
      initialSha256: base.hash(initial),
      requiredCases: preceding.filter(prior => cases.find(value => value.id === prior).mutation.path === relative),
      preservedInitialCases: related.filter(seed => INITIAL_CASES.includes(seed.id)).map(seed => seed.id),
      preservedOtherSeeds: related.filter(seed => ![...fixedBefore, id].includes(seed.id)).map(seed => seed.id) };
  }
  return repairs;
}
function checkedRepairs(fixture) {
  assert.deepEqual(Object.keys(fixture.repairs).sort(), SELECTED.slice().sort());
  const priorByPath = new Map();
  for (const id of SELECTED) {
    const repair = fixture.repairs[id];
    assert.equal(base.hash(repair.before), repair.beforeSha256); assert.equal(base.hash(repair.after), repair.afterSha256);
    assert.notEqual(repair.beforeSha256, repair.afterSha256);
    assert.equal(typeof repair.path, 'string');
    assert(fixture.files[repair.path], `Recorded source path required: ${id}`);
    assert.equal(fixture.files[repair.path].sha256, repair.initialSha256, `Initial checkpoint pin: ${id}`);
    const preceding = priorByPath.get(repair.path) || [];
    assert.deepEqual(repair.requiredCases, preceding, `Exact shared-file prerequisites: ${id}`);
    const expectedBefore = preceding.length ? fixture.repairs[preceding.at(-1)].afterSha256 : repair.initialSha256;
    assert.equal(repair.beforeSha256, expectedBefore, `Cumulative shared-file repair: ${id}`);
    priorByPath.set(repair.path, [...preceding, id]);
  }
}
function projectedFixture(fixture, completedCases) {
  checkedRepairs(fixture);
  assert(Array.isArray(completedCases)); assert.equal(new Set(completedCases).size, completedCases.length);
  assert(completedCases.every(id => SELECTED.includes(id)), 'Only this stage\'s remaining cases may complete');
  assert.deepEqual(completedCases, SELECTED.slice(0, completedCases.length), 'Exact final-stage completion prefix required');
  const files = { ...fixture.files };
  for (const id of completedCases) {
    const repair = fixture.repairs[id];
    assert(repair.requiredCases.every(prior => completedCases.includes(prior)), `Missing shared-file prerequisite: ${id}`);
    // Later repairs replace earlier expected bytes for the same path.
    files[repair.path] = { ...files[repair.path], sha256: repair.afterSha256 };
  }
  return { ...fixture, files };
}
function expectedSnapshotHashes(fixture, completedCases = []) {
  return Object.fromEntries(Object.entries(projectedFixture(fixture, completedCases).files).map(([relative, pin]) => [relative, pin.sha256]));
}
function verifySnapshot(fixture, completedCases = [], panelIds = []) {
  const projected = projectedFixture(fixture, completedCases);
  const snapshot = base.verifySnapshot(projected, [], panelIds);
  snapshot.completedCases = completedCases.slice();
  return snapshot;
}
function verifyBoundary(fixture, completedCases = [], panelIds = []) {
  const projected = projectedFixture(fixture, completedCases);
  // Preserve the scoped dependency, npm HTTP, cache, source-map, generated
  // asset, application-log and temporary-directory checks exactly.
  const snapshot = base.verifyBoundary(projected, [], panelIds);
  snapshot.files.completedCases = completedCases.slice();
  return snapshot;
}
function recordedPatchScope(changes, fixture, purpose) {
  try {
    checkedRepairs(fixture);
    const repair = purpose === 'deny-notes' ? fixture.deniedNote : fixture.repairs[purpose];
    assert(repair); const file = base.exactFile(fixture.workspace, repair.path);
    assert.equal(fs.lstatSync(file).nlink, 1, 'No source patch through a hard link');
    // Historical receipt replay uses frozen before/after bytes. Current source
    // may include a later approved repair to the same path; the auditor must
    // separately join its retained before/after snapshots and final boundary.
    return base.patchScope(changes, fixture, purpose);
  } catch { return false; }
}
function patchScope(changes, fixture, purpose) {
  try {
    const repair = purpose === 'deny-notes' ? fixture.deniedNote : fixture.repairs[purpose];
    assert(repair); const file = base.exactFile(fixture.workspace, repair.path);
    const actual = base.identity(file).sha256;
    assert([repair.beforeSha256, repair.afterSha256].includes(actual), 'Repair is scoped to its actual cumulative source state');
    return recordedPatchScope(changes, fixture, purpose);
  } catch { return false; }
}
function assertCommandResult({ step, result }) {
  assert.equal(step.expectedNonzero, undefined, 'Final-pair workflow has no inherited failing-command allowance');
  assert.equal(result.status, 'completed'); assert.equal(result.exitCode, 0);
  return 'SUCCESS';
}
function buildSteps(...args) { return require('./codex-f2-final-pair-steps.cjs').buildSteps(...args); }
function promptFor(...args) { return require('./codex-f2-final-pair-steps.cjs').promptFor(...args); }
module.exports = { ...base, ...require('./codex-f2-final-pair-steps.cjs'), STAGE, MAIN_CAP, HELPER_CAP, PRIOR_CHECKPOINT_SHA, INITIAL_CASES, SELECTED, buildRepairs, checkedRepairs,
  expectedSnapshotHashes, verifySnapshot, verifyBoundary, patchScope, recordedPatchScope, assertCommandResult, buildSteps, promptFor };
