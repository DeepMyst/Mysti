/* Read-only preparation admission controls. Never invokes main or clones dependencies. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '../..'), root = fs.realpathSync(path.join(repo, 'out-test/feature-tests/PB-02'));
const profiles = path.join(repo, '.vscode-test/profiles');
const profilesBefore = fs.readdirSync(profiles).sort();
const c = require('./codex-f2-csv-export-awake-campaign.cjs');
const p = require('./prepare-vscode-codex-f2-csv-export-awake.cjs');
const compact = require('./codex-f2-compact-store.cjs');
const directory = fs.mkdtempSync(path.join(root, 'f2-csv-export-preparation-controls-'));
const checks = [], check = (name, fn) => { try { fn(); checks.push({ name, status: 'PASS' }); } catch (error) { checks.push({ name, status: 'FAIL', error: error.stack }); } };
const write = (relative, value) => { const file = path.join(directory, relative); fs.writeFileSync(file, value, { flag: 'wx' }); return file; };
const copy = value => structuredClone(value);
const compiled = path.join(directory, 'synthetic-compiled'); fs.mkdirSync(compiled);
const target = path.join(directory, 'never-prepared');
check('F06 policy reuses the qualified independent auxiliary cap48', () => assert.equal(p.assertAuxiliaryPolicy(), 'PASS_F04_AUXILIARY_48'));
check('old cap24 auxiliary policy rejected', () => assert.throws(() => p.assertAuxiliaryPolicy({ maxInputs: 24 })));
check('oversized auxiliary policy rejected', () => assert.throws(() => p.assertAuxiliaryPolicy({ maxInputs: 49 })));
check('broader auxiliary argument policy rejected', () => assert.throws(() => p.assertAuxiliaryPolicy({ expectedArgs: ['--tools', 'all'] })));
check('import never creates profiles or a campaign', () => { assert(!fs.existsSync(target)); assert.deepEqual(fs.readdirSync(profiles).sort(), profilesBefore); });
check('fresh owned location admitted without creation', () => { p.assertPreparationLocation(target, 1, compiled); assert(!fs.existsSync(target)); });
check('invalid segment rejected', () => assert.throws(() => p.assertPreparationLocation(target, 3, compiled)));
check('outside PB02 root rejected', () => assert.throws(() => p.assertPreparationLocation(path.join(repo, 'outside-attempt'), 1, compiled)));
check('missing owned parent rejected', () => assert.throws(() => p.assertPreparationLocation(path.join(directory, 'absent/attempt'), 1, compiled)));
const alias = path.join(directory, 'alias'); fs.symlinkSync(directory, alias);
check('aliased parent rejected', () => assert.throws(() => p.assertPreparationLocation(path.join(alias, 'attempt'), 1, compiled)));
for (const marker of ['prepared.json', 'campaign.json']) {
  const ancestor = path.join(directory, marker + '-parent'); fs.mkdirSync(ancestor); fs.writeFileSync(path.join(ancestor, marker), '{}');
  check(marker + ' ancestor rejected', () => assert.throws(() => p.assertPreparationLocation(path.join(ancestor, 'attempt'), 1, compiled)));
  const nested = path.join(ancestor, 'compiled'); fs.mkdirSync(nested);
  check(marker + ' compiled ancestor rejected', () => assert.throws(() => p.assertPreparationLocation(target, 1, nested)));
}
check('existing campaign location rejected', () => assert.throws(() => p.assertPreparationLocation(compiled, 1, compiled)));
check('segment two requires prior campaign', () => assert.throws(() => p.assertPreparationLocation(target, 2, compiled)));
check('compiled path alias rejected', () => assert.throws(() => p.assertPreparationLocation(target, 1, path.join(alias, 'synthetic-compiled'))));
const file = write('pin.txt', 'owned pin bytes'), identity = c.identity(file);
check('actual regular pin admitted', () => assert.deepEqual(p.validatePins([identity]), [identity]));
check('identical duplicate pins collapse exactly once', () => assert.deepEqual(p.validatePins([identity, copy(identity)]), [identity]));
check('conflicting duplicate pin rejected', () => assert.throws(() => p.validatePins([identity, { ...identity, sha256: '0'.repeat(64) }])));
check('wrong content hash rejected', () => assert.throws(() => p.validatePins([{ ...identity, sha256: '0'.repeat(64) }])));
check('missing pinned file rejected', () => assert.throws(() => p.validatePins([{ ...identity, path: path.join(directory, 'missing-pin') }])));
check('relative pin rejected', () => assert.throws(() => p.validatePins([{ ...identity, path: 'pin.txt' }])));
check('extra pin keys rejected', () => assert.throws(() => p.validatePins([{ ...identity, permissive: true }])));
const symlink = path.join(directory, 'pin-symlink'); fs.symlinkSync(file, symlink);
check('symlink pin rejected', () => assert.throws(() => p.validatePins([{ ...identity, path: symlink }])));
const linked = path.join(directory, 'pin-hardlink'); fs.linkSync(file, linked);
check('hardlinked pin rejected', () => assert.throws(() => p.validatePins([identity]))); fs.unlinkSync(linked);
check('exact installed Node identity admitted without relaxing owned hardlink rejection', () => { const pin = require('./codex-f2-csv-export-awake-gates.cjs').NODE; assert.deepEqual(p.validatePins([pin]), [pin]); });
check('directory pin rejected', () => assert.throws(() => p.validatePins([{ ...identity, path: compiled }])));
const extra = write('extra-dependencies.json', JSON.stringify([identity, identity]));
let dependencies;
check('qualified F06 inputs plus reviewed extra dependencies admitted uniquely', () => {
  dependencies = p.qualifiedDependencies(extra); assert.equal(new Set(dependencies.map(row => row.path)).size, dependencies.length);
  for (const pin of [identity, c.identity(extra), c.PLAN, c.QUALIFICATION, c.PRIOR_NATIVE_CHECKPOINT]) assert(dependencies.some(row => row.path === pin.path && row.sha256 === pin.sha256));
});
check('complete current gate dependency set is pre-pinned', () => {
  for (const pin of require('./codex-f2-csv-export-awake-gates.cjs').dependencies().pins)
    assert(dependencies.some(row => row.path === pin.path && row.sha256 === pin.sha256));
  assert(dependencies.some(row => row.path === require.resolve('./check-codex-f2-csv-export-awake-gates.cjs')));
});
const conflicting = write('conflicting-extra.json', JSON.stringify([identity, { ...identity, sha256: '0'.repeat(64) }]));
check('conflicting extra dependency list rejected', () => assert.throws(() => p.qualifiedDependencies(conflicting)));
const emptyExtra = write('empty-extra.json', '[]');
check('supplied empty extra dependency list rejected', () => assert.throws(() => p.qualifiedDependencies(emptyExtra)));
const aliasedExtra = path.join(directory, 'aliased-extra.json'); fs.symlinkSync(extra, aliasedExtra);
check('aliased extra list rejected', () => assert.throws(() => p.qualifiedDependencies(aliasedExtra)));
const priorCheckpoint = c.pinned(c.PRIOR_NATIVE_CHECKPOINT), priorCampaign = c.pinned(priorCheckpoint.campaign);
const seedRoot = path.join(root, 'overnight-20261011/f2-workload-preparation'), contractFile = path.join(seedRoot, 'contracts/case-contracts.json');
const contract = compact.readJson(contractFile);
let paths, ready, projection;
check('source-copy admission selects exactly prior23 paths including F05 and F04', () => {
  paths = p.preservedSourcePaths(contract); assert.equal(paths.length, 23); assert(paths.includes('server/.env.sample')); assert(paths.includes('server/api/helpers/utils/send-webhooks.js'));
  assert(paths.includes('client/src/components/Board/Board.module.scss')); assert(paths.includes('client/src/components/BoardActions/Description.jsx'));
  assert(!paths.some(relative => c.PATCHES.some(row => row.kind === 'add' && row.path === relative)));
});
check('missing historical bug in inventory rejected', () => {
  const changed = copy(contract); changed.cases = changed.cases.filter(row => row.id !== c.INITIAL_CASES[0]); assert.throws(() => p.preservedSourcePaths(changed));
});
check('actual native25 binding and F06 repair specification admitted without preparation', () => {
  ready = c.assertNativePreparationReady(c.PRIOR_NATIVE_CHECKPOINT);
  const repairs = c.buildRepairs(contractFile, path.join(root, 'overnight-20261011/f2-adapted-baseline/workspace'), path.join(seedRoot, 'seeded-workspace'), ready.workspace);
  projection = { fixture: { priorWorkspace: ready.workspace, priorCheckpoint: c.PRIOR_NATIVE_CHECKPOINT, repairs,
    indexSha256: priorCampaign.fixture.indexSha256, files: Object.fromEntries(Object.entries(ready.files.hashes).map(([name, sha256]) => [name, { sha256 }])) },
    priorBinding: c.PRIOR_NATIVE_CHECKPOINT, sourceIdentity: priorCampaign.sourceIdentity, packageIdentity: priorCampaign.packageIdentity };
  assert.equal(p.assertPriorProjection(projection, ready, priorCampaign), 'PASS_EXACT_NATIVE25_SOURCE_INDEX_F05_F04_PROJECTION');
  assert.equal(Object.keys(repairs).length, 10); assert.equal(Object.values(repairs).filter(row => row.kind === 'add').length, 3);
});
for (const relative of ['server/api/helpers/utils/send-webhooks.js', 'server/.env.sample', 'client/src/models/List.js', 'client/src/components/Board/Board.module.scss', 'client/src/components/BoardActions/Description.jsx', '.git/index', c.NOTE]) check('changed prior projection rejected: ' + relative, () => {
  const changed = copy(projection); changed.fixture.files[relative].sha256 = '0'.repeat(64); assert.throws(() => p.assertPriorProjection(changed, ready, priorCampaign));
});
check('preapplied new F06 file rejected in initial projection', () => {
  const changed = copy(projection), patch = c.PATCHES.find(row => row.kind === 'add'); changed.fixture.files[patch.path] = { sha256: patch.afterSha256 };
  assert.throws(() => p.assertPriorProjection(changed, ready, priorCampaign));
});
check('fabricated prior aggregate PASS rejected', () => { const changed = copy(ready); changed.priorPrelaunchAggregateStatus = 'PASS'; assert.throws(() => p.assertPriorProjection(projection, changed, priorCampaign)); });
check('different package rejected', () => { const changed = copy(projection); changed.packageIdentity.sha256 = '0'.repeat(64); assert.throws(() => p.assertPriorProjection(changed, ready, priorCampaign)); });
check('different prior checkpoint rejected', () => { const changed = copy(projection); changed.priorBinding.sha256 = '0'.repeat(64); assert.throws(() => p.assertPriorProjection(changed, ready, priorCampaign)); });
const syntheticWorkspace = path.join(directory, 'synthetic-workspace'); fs.mkdirSync(syntheticWorkspace);
const campaign = { stage: c.STAGE, directory: target, workspace: syntheticWorkspace, evidenceDirectory: path.join(target, 'evidence') };
campaign.evidenceFiles = Object.fromEntries(['checkpoint', 'validation', 'restored', 'final'].map(kind => [kind, [path.join(campaign.evidenceDirectory, kind, 'review.json'), ...(kind === 'checkpoint' ? [path.join(campaign.evidenceDirectory, kind, 'prior-context.json')] : [])]]));
check('exact four gates and checkpoint context admitted', () => p.assertEvidenceInventory(campaign));
check('missing prior-context evidence rejected', () => { const changed = copy(campaign); changed.evidenceFiles.checkpoint.pop(); assert.throws(() => p.assertEvidenceInventory(changed)); });
check('foreign evidence path rejected', () => { const changed = copy(campaign); changed.evidenceFiles.validation[0] = '/tmp/foreign.json'; assert.throws(() => p.assertEvidenceInventory(changed)); });
check('extra browser gate rejected', () => { const changed = copy(campaign); changed.evidenceFiles.browser = []; assert.throws(() => p.assertEvidenceInventory(changed)); });
check('eighteen tasks, sixteen-plus-two, ten patches and bounded caps', () => {
  const steps = c.buildSteps(campaign.workspace); assert.equal(steps.length, 18); assert.equal(steps.filter(row => row.segment === 1).length, 16);
  assert.equal(steps.filter(row => row.segment === 2).length, 2); assert.equal(steps.filter(row => row.patch).length, 10); assert.equal(c.MAIN_CAP, 22); assert.equal(c.HELPER_CAP, 48);
});
check('exact canonical Code identity and disjoint segment passive bindings', () => {
  const first = p.editorBindings(1), second = p.editorBindings(2);
  assert.deepEqual(first.editorIdentity, second.editorIdentity);
  assert.equal(first.editorIdentity.sha256, 'e9760eca0a62d96ff2bb334ef5c8d3b677a6275a2dd0cf5a63c356b7a19435a2');
  assert.equal(first.passiveEvidenceDirectory, first.passiveEvidenceDirectories['1']);
  assert.equal(second.passiveEvidenceDirectory, first.passiveEvidenceDirectories['2']);
  assert.notEqual(first.passiveEvidenceDirectory, second.passiveEvidenceDirectory);
});
check('invalid editor binding segment rejected', () => assert.throws(() => p.editorBindings(0)));
check('raw qualification pin projection deduplicates exact pairs', () => {
  assert.deepEqual(p.qualificationPins({one:identity,nested:[{...identity, extra:'evidence metadata'}]}), [identity]);
});
check('conflicting nested qualification pins rejected', () => assert.throws(() => p.qualificationPins({one:identity,nested:[{...identity,sha256:'f'.repeat(64)}]})));
check('all controls leave campaign and profile creation untouched', () => { assert(!fs.existsSync(target)); assert.deepEqual(fs.readdirSync(profiles).sort(), profilesBefore); });
const script = require.resolve('./prepare-vscode-codex-f2-csv-export-awake.cjs');
const report = { status: checks.every(row => row.status === 'PASS') ? 'PASS_F06_PREPARATION_ADMISSION_CONTROLS' : 'FAIL', at: new Date().toISOString(),
  node: c.identity(process.execPath), preparer: c.identity(script), checker: c.identity(__filename), contract: c.identity(require.resolve('./codex-f2-csv-export-awake-campaign.cjs')),
  auxiliary: c.identity(require.resolve('./codex-f2-board-description-auxiliary.cjs')), auxiliaryChecker: c.identity(require.resolve('./check-codex-f2-board-description-auxiliary.cjs')),
  plan: c.PLAN, priorCheckpoint: c.PRIOR_NATIVE_CHECKPOINT, qualifiedDependencies: dependencies, checks,
  preparations: 0, clonedDependencies: 0, profilesCreated: 0, nativeInputs: 0, editorLaunches: 0,
  limitations: ['Import-only validators with tiny owned control files; no preparer main, source copy or dependency clone was executed.', 'New driver, auditor, runner and compiled artifacts are validated by actual preparation before creation; this report does not claim their readiness.', 'Optional extra dependencies must include the separately reviewed final campaign gate adapter and its dependencies before root launches.'] };
const reportFile = path.join(directory, 'checks.json'); fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ report: c.identity(reportFile), status: report.status, passed: checks.filter(row => row.status === 'PASS').length, total: checks.length, failures: checks.filter(row => row.status !== 'PASS') }));
if (report.status === 'FAIL') process.exitCode = 1;
