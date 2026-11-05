'use strict';
// Root-owned evidence only. Import does not launch applications or touch a database.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const c = require('./codex-f2-task-due-date-timed-campaign.cjs'), compact = require('./codex-f2-compact-store.cjs');
const repo = path.resolve(__dirname, '../..'), base = path.join(repo, 'out-test/feature-tests/PB-02/overnight-20261011');
const NP = path.join(base, 'f02-native-timed-preparation'), local = path.join(base, 'f02-due-date-validation');
const DIRECTORY = path.join(base, 'native-f2-task-due-date-timed-session');
const scope = require(path.join(base, 'f05-signed-webhook-validation/f05-scope.cjs'));
const regression = require(path.join(local, 'run-regressions-v3.cjs'));
const validators = require('./codex-f2-task-due-date-timed-report-validators.cjs');
const read = file => compact.readJson(file), write = (file, value) => compact.writeJson(file, value);
const NODE = Object.freeze({ path: '/Users/bahaabunojaim/.npm/_npx/d18f28baf1132559/node_modules/node/bin/node', sha256: '68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b' });
const controllerQualification = Object.freeze({ path: path.join(base, 'f04-board-description-validation/process-observer-correction/qualification.json'), sha256: 'ba91d7ba325e6abf43c21d7991c520fa6527e84b298c650eba65090169743ed5' });
const ADAPTATION = Object.freeze({ path: path.join(NP, 'oracles/adaptation.json'), sha256: '6fb54937c9f3347cf610ed2271a335e08d8ab8c47c936ef4720ee9370febf25c' });
const MIGRATION_QUALIFICATION = Object.freeze({ path: path.join(NP, 'migration/qualification.json'), sha256: '20b7df0997817f58170298a7ae04e98e66e6bcadf287c8e04ed68b8f0d57fe2d' });
const ORACLES = Object.freeze({ api: path.join(NP, 'oracles/f02-api-oracle.cjs'), ui: path.join(NP, 'oracles/f02-ui-oracle.cjs'),
  regressions: regression.ORACLES.api, frontend: regression.ORACLES.frontend, f05: regression.ORACLES.f05,
  f04: regression.ORACLES.f04, f06: regression.ORACLES.f06, f04ui: regression.ORACLES.f04ui, f06ui: regression.ORACLES.f06ui,
  'migration-initialize-old': path.join(NP, 'migration/migration-oracle.cjs'), 'migration-seed-old': path.join(NP, 'migration/migration-oracle.cjs'),
  'migration-up': path.join(NP, 'migration/migration-oracle.cjs'), 'migration-down-up': path.join(NP, 'migration/migration-oracle.cjs') });
const PHASES = Object.freeze(['checkpoint', 'validation', 'restored', 'final']);
const POSITIVE = Object.freeze(['api', 'ui', 'regressions', 'frontend', 'f05', 'f04', 'f06', 'f04ui', 'f06ui']);
function executionNames(kind) {
  assert(PHASES.includes(kind));
  if (kind === 'checkpoint') return ['migration-initialize-old', 'regressions', 'frontend', 'f05', 'f04', 'f06', 'migration-seed-old'];
  if (kind === 'validation') return ['migration-up', 'migration-down-up', ...POSITIVE];
  return kind === 'restored' ? [...POSITIVE] : [];
}
function phaseScope(kind) {
  assert(PHASES.includes(kind));
  const coverage = {
    checkpoint: 'Seven root invocations: initialize the fresh old schema, run five retained baselines (all12 repairs,F05,F04 API,F06 API), then seed old rows last. No F02 positive API/UI or migration-up claim.',
    validation: 'Eleven root invocations: named migration up and down/up first, then nine oracles including87 F02 API cases,7 UI core cases and two controlled503-to-real-retry recoveries, plus all12/F05/F04/F06 on exact native assets.',
    restored: 'Nine root oracles repeat F02 API87/UI7+2 and all retained regressions after the actual editor restart, on the same owned database. No migration repeats or new PostgreSQL restart.',
    final: 'Zero new root application invocations; exact pinned validation and restored gates are recursively verified and reused.'
  };
  return coverage[kind] + ' No native PostgreSQL restart is run or claimed; local restart qualification remains separate. Auth/session/sequences/transient writes and general concurrency/mobile/accessibility remain outside full15 business-row evidence.';
}
function dependencies() {
  const provenance = c.candidateProvenance(), q = c.pinned(controllerQualification);
  assert.equal(q.passedControls, 35); assert.deepEqual(c.identity(q.controller.path), q.controller);
  const adapter = c.pinned(ADAPTATION);
  for (const item of adapter.adapters) {
    assert.deepEqual(c.identity(item.source.path), item.source); assert.deepEqual(c.identity(item.target.path), item.target);
    let text = fs.readFileSync(item.source.path, 'utf8');
    for (const replacement of item.exactReplacements) { assert(text.includes(replacement.before)); text = text.replaceAll(replacement.before, replacement.after); }
    assert.equal(text, fs.readFileSync(item.target.path, 'utf8'));
  }
  assert.deepEqual(c.identity(adapter.pathGuard.path), adapter.pathGuard);
  const legacy = require('./codex-f2-csv-export-sequential-gates.cjs').dependencies();
  const migration = require(path.join(NP, 'migration/migration-binding.cjs'));
  const migrationQualification = c.pinned(MIGRATION_QUALIFICATION);
  assert.equal(migrationQualification.status, 'QUALIFIED_N31_MIGRATION_SOURCE_ADAPTATION_WITH_INHERITED_CONTROLS');
  assert.equal(migrationQualification.fullInputsPreflightRequiredBeforeRuntime, true);
  assert.equal(migrationQualification.preflightOrder, 'AFTER_OWNED_POSTGRES_START_BEFORE_EDITOR_OR_APPLICATION');
  assert.deepEqual(c.identity(migrationQualification.firstInputsChecker.path), migrationQualification.firstInputsChecker);
  const readFlagsQualification = c.pinned(migrationQualification.readOnlyGuardCorrectionQualification);
  assert.equal(readFlagsQualification.status, 'PASS_QUALIFIED_SUPPLEMENTAL_READ_ONLY_PREFLIGHT_FLAG_CORRECTION');
  const readFlagsChecks = c.pinned(migrationQualification.readOnlyGuardCorrectionChecks);
  assert.equal(readFlagsChecks.checks.length, 66); assert(readFlagsChecks.checks.every(row => row.status === 'PASS'));
  const oldQualification = c.pinned(migrationQualification.inheritedQualification);
  assert.equal(oldQualification.status, 'PASS_SYNTHETIC_F02_NATIVE_MIGRATION_ADAPTER_39');
  assert.equal(oldQualification.firstExecution.exitCode, 0); assert.equal(oldQualification.firstExecution.attempt, 1);
  assert.deepEqual(migrationQualification.inheritedChecks, oldQualification.checks);
  const inheritedChecks = c.pinned(migrationQualification.inheritedChecks);
  assert.equal(inheritedChecks.checks.length, 39); assert(inheritedChecks.checks.every(row => row.status === 'PASS'));
  const executableQualification = c.pinned(migrationQualification.executableQualification);
  assert.equal(executableQualification.status, 'PASS_BOUNDED_F02_INSTALLED_EXECUTABLE_IDENTITY_QUALIFICATION');
  assert.deepEqual(migrationQualification.executableChecks, executableQualification.qualification.report);
  const executableChecks = c.pinned(migrationQualification.executableChecks);
  assert.equal(executableChecks.checks.length, 24); assert(executableChecks.checks.every(row => row.status === 'PASS'));
  const migrationAdaptation = c.pinned(migrationQualification.adaptation);
  assert.deepEqual(migrationQualification.sourcePins, migrationAdaptation.sourcePins);
  for (const row of migrationAdaptation.rows) {
    assert.deepEqual(c.identity(row.source.path), row.source); assert.deepEqual(c.identity(row.target.path), row.target);
    let text = fs.readFileSync(row.source.path, 'utf8');
    for (const replacement of migrationAdaptation.namespaceReplacements) text = text.replaceAll(replacement.before, replacement.after);
    for (const replacement of row.exactReplacements) text = text.replaceAll(replacement.before, replacement.after);
    assert.equal(text, fs.readFileSync(row.target.path, 'utf8'), 'Qualified migration source normalization');
  }
  const manifest = read(path.join(local, 'regression-v3-source-pins.json'));
  const pins = [c.identity(__filename), ...c.timingPins(), NODE, controllerQualification, q.controller, ...q.controls, ADAPTATION, adapter.pathGuard,
    ...adapter.adapters.flatMap(row => [row.source, row.target]), ...legacy.pins, ...manifest.pins,
    ...Object.values(ORACLES).map(c.identity), ...Object.values(migration.LEGACY_PINS),
    MIGRATION_QUALIFICATION, migrationQualification.firstInputsChecker, migrationQualification.readOnlyGuardCorrectionQualification, migrationQualification.readOnlyGuardCorrectionChecks, migrationQualification.adaptation, migrationQualification.inheritedQualification, migrationQualification.inheritedChecks, migrationQualification.executableQualification, migrationQualification.executableChecks, ...Object.values(executableQualification.sources), ...migrationQualification.sourcePins,
    ...['migration-binding.cjs', 'fresh-state.cjs', 'migration-report.cjs'].map(name => c.identity(path.join(NP, 'migration', name))),
    c.identity(require.resolve('./codex-f2-task-due-date-timed-report-validators.cjs')),
    c.identity(require.resolve('./check-codex-f2-task-due-date-timed-gates.cjs')), c.identity(require.resolve('./audit-vscode-codex-f2-task-due-date-timed.cjs')),
    c.identity(path.join(local, 'run-regressions-v3.cjs')), c.identity(path.join(local, 'regression-v3-source-pins.json')),
    c.identity(path.join(local, 'run-api-v5.cjs')), c.identity(path.join(local, 'run-ui-v4.cjs')),
    ...provenance.qualification.codePins, ...provenance.qualification.currentReports, ...provenance.qualification.preservedFindings];
  for (const pin of pins) assert.deepEqual(c.identity(pin.path), pin);
  return { pins: require('./pb02-unique-pins.cjs').uniquePins(pins), runner: require(q.controller.path) };
}
function gateState(campaign, kind) {
  assert.equal(campaign.stage, c.STAGE); assert(PHASES.includes(kind)); assert.equal(campaign.directory, DIRECTORY);
  assert.equal(campaign.workspace, path.join(DIRECTORY, 'workspace')); assert.equal(campaign.evidenceDirectory, path.join(DIRECTORY, 'evidence'));
  const completed = kind === 'checkpoint' ? [] : [...c.SELECTED], segment = ['restored', 'final'].includes(kind) ? 2 : 1;
  const owner = path.join(campaign.directory, `segment-${segment}/window-A`), step = c.buildSteps(campaign.workspace).find(row => row.evidence === kind);
  const requests = read(path.join(owner, 'observations.json')).filter(row => row.event === 'external-evidence-needed' && row.kind === kind);
  assert.equal(requests.length, 1); const request = requests[0]; assert.equal(request.marker, step.marker);
  assert.deepEqual(request.files.completedCases, completed); assert.equal(request.panelIds.length, segment);
  assert.equal(new Set(request.panelIds).size, segment);
  const boundary = c.identity(path.join(owner, 'boundary-evidence-' + kind + '.json')), record = read(boundary.path);
  assert(record.at <= request.at); assert.deepEqual(record.snapshot, request.boundary); assert.deepEqual(request.files, request.boundary.files);
  assert.deepEqual(request.files.hashes, c.expectedSnapshotHashes(campaign.fixture, completed));
  return { completed, segment, owner, step, request, boundary, panelIds: request.panelIds };
}
function invocationSpec(campaign, kind, name, panelIds = []) {
  assert(executionNames(kind).includes(name), 'Only the exact ordered gate inventory may run');
  const artifact = path.join(campaign.evidenceDirectory, kind), runtime = path.join(campaign.directory, 'runtime');
  const output = path.join(artifact, name), scopeFile = path.join(artifact, name + '-scope.json');
  let args;
  if (name.startsWith('migration-')) args = [name.slice('migration-'.length), path.join(campaign.directory, 'campaign.json'),
    c.identity(path.join(campaign.directory, 'campaign.json')).sha256, c.identity(require.resolve('./codex-f2-task-due-date-timed-campaign.cjs')).sha256, JSON.stringify(panelIds)];
  else if (name === 'frontend') args = [campaign.workspace, output + '.json', regression.FRONTEND_CASES.join(',')];
  else if (name === 'f05') args = [campaign.workspace, output, runtime, scopeFile, path.join(artifact, 'f05-timing.jsonl')];
  else args = [campaign.workspace, 'f02-' + kind + '-' + name, output, runtime,
    name === 'api' ? 'F2-F02' : name === 'ui' ? 'F2-F02-UI' : name === 'regressions' ? regression.API_CASES.join(',') : name === 'f04' ? 'F2-F04' : name === 'f06' ? 'F2-F06' : name === 'f04ui' ? 'F2-F04-UI' : 'F2-F06-UI,F2-F04-WRAP-UI'];
  return { command: [NODE.path, ORACLES[name], ...args], scopeFile, reportFile: name === 'frontend' ? output + '.json' : path.join(output, 'result.json'),
    executionFile: path.join(artifact, name + '-execution.json'), reservationFile: path.join(artifact, name + '-reservation.json'),
    expectedExit: 0, deadlineMs: name === 'f05' ? 420000 : name === 'ui' ? 300000 : name === 'api' || name.startsWith('migration-') ? 240000 : 120000 };
}
function needsAssets(kind, name) {
  return kind !== 'checkpoint' && name !== 'initial' && POSITIVE.indexOf(name) >= POSITIVE.indexOf('ui');
}
function assertScopeRecords({ campaign, kind, name, captured, requestBoundary, panelIds, initialScope }) {
  assert.equal(captured.schemaVersion, 1); assert.equal(captured.purpose, 'PB02_F05_SOURCE_RUNTIME_SCOPE');
  assert.equal(captured.workspace, campaign.workspace); assert.equal(captured.runtime, path.join(campaign.directory, 'runtime'));
  assert.deepEqual(captured.panelIds, panelIds); assert.deepEqual(captured.runtimeIdentity, initialScope.runtimeIdentity);
  assert.deepEqual(captured.dependencyTrees, initialScope.dependencyTrees); assert.deepEqual(captured.source.directories, initialScope.source.directories);
  const expected = Object.fromEntries(Object.entries(c.expectedSnapshotHashes(campaign.fixture, kind === 'checkpoint' ? [] : c.SELECTED)).map(([file, sha256]) => [file, { kind: 'file', sha256 }]));
  for (const file of requestBoundary.buildSnapshot?.files || []) { assert.equal(file.path, path.join(campaign.workspace, 'client/build', file.relative)); expected['client/build/' + file.relative] = { kind: 'file', sha256: file.sha256 }; }
  const links = needsAssets(kind, name) ? Object.entries(c.ASSET_LINKS) : requestBoundary.files.assetLinks.map(row => [row.relative, row.target]);
  for (const [relative, target] of links) { assert.equal(c.ASSET_LINKS[relative], target); expected[relative] = { kind: 'owned-asset-link', target: path.relative(path.dirname(path.join(campaign.workspace, relative)), path.join(campaign.workspace, target)) }; }
  assert.deepEqual(captured.source.files, expected, 'Exact original source, current native build and owned asset links'); return expected;
}
function assertInvocationRecords({ campaign, kind, row, captured, execution, reservation, requestBoundary, panelIds, startedAt, endedAt, initialScope, runner }) {
  const spec = invocationSpec(campaign, kind, row.name, panelIds);
  assert.deepEqual(row.command, spec.command); assert.deepEqual(execution.command, spec.command);
  for (const key of ['scope', 'report', 'execution', 'reservation']) assert.equal(row[key].path, spec[key + 'File']);
  assert.deepEqual(reservation.command, spec.command); assert.equal(reservation.cwd, repo); assert.equal(reservation.deadlineMs, spec.deadlineMs);
  assert.equal(reservation.expectedExit, 0); assert.equal(reservation.retries, 0); assert.deepEqual(reservation.scope, row.scope);
  (runner || dependencies().runner).requireSuccessfulInvocation(execution, 0);
  assert.equal(execution.cwd, repo); assert.equal(execution.deadlineMs, spec.deadlineMs); assert.deepEqual(execution.signals, []);
  assert(Number.isFinite(startedAt) && Number.isFinite(endedAt) && reservation.at >= startedAt);
  assert(Date.parse(execution.startedAt) >= reservation.at && Date.parse(execution.finishedAt) <= endedAt);
  assertScopeRecords({ campaign, kind, name: row.name, captured, requestBoundary, panelIds, initialScope });
  const after = row.sourceBoundaryAfter;
  assert.equal(after.sourceFiles, Object.keys(captured.source.files).length); assert.equal(after.sourceSha256, c.hash(JSON.stringify(captured.source)));
  assert.equal(after.indexSha256, campaign.fixture.indexSha256); assert.equal(after.documentationSha256, captured.source.files['server/.env.sample'].sha256);
  assert.equal(after.dependencyFiles, captured.dependencyTrees.reduce((sum, tree) => sum + tree.files, 0)); assert.deepEqual(after.panelIds, panelIds);
  return { status: 'PASS_EXACT_F02_INVOCATION_AND_SOURCE_JOIN', name: row.name };
}
function reportState(campaign, kind) {
  return { workspace: campaign.workspace, runtime: path.join(campaign.directory, 'runtime'), expected: c.expectedSnapshotHashes(campaign.fixture, kind === 'checkpoint' ? [] : c.SELECTED),
    helpers: { ...require(path.join(base, 'f06-csv-export-validation/run-regressions-v3.cjs')), assertSourceHashes: assertRecordedSourceHashes }, pins: [] };
}
function assertRecordedSourceHashes(report, expected) {
  // Historical checkpoint reports precede approved overlapping edits. Current disk bytes
  // belong to the later stage; the retained per-invocation scope joins the recorded stage.
  // executeGate still captures/verifies actual source for each command and its final boundary.
  assert(report.sourceHashes && Object.keys(report.sourceHashes).length > 0);
  for (const [relative, sha256] of Object.entries(report.sourceHashes)) {
    assert(Object.hasOwn(expected, relative)); assert.match(sha256, /^[a-f0-9]{64}$/);
    assert.equal(sha256, expected[relative], 'Report source matches its exact historical stage: ' + relative);
  }
}
function assertFeatureSources(report, state, ui) {
  const catalog = c.pinned(c.CASE_CONTRACT), paths = [...new Set([...catalog.cases.filter(row => row.kind === 'seeded-bug').map(row => row.mutation.path),
    'server/config/routes.js', 'server/api/models/Task.js', 'server/api/controllers/tasks/create.js', 'server/api/controllers/tasks/update.js',
    'server/api/helpers/tasks/create-one.js', 'server/api/helpers/tasks/update-one.js', 'server/db/migrations/20261012000200_add_task_due_date.js',
    ...(ui ? ['client/src/components/CardModal/Tasks/Item.jsx', 'client/src/components/CardModal/Tasks/Item.module.scss', 'client/src/components/CardModal/Tasks/Tasks.jsx', 'client/src/models/Task.js', 'client/src/locales/en-US/core.js'] : [])])].sort();
  assert.deepEqual(Object.keys(report.sourceHashes).sort(), paths); for (const file of paths) assert.equal(report.sourceHashes[file], state.expected[file]);
  assert.deepEqual(report.contract, c.CASE_CONTRACT); assert.deepEqual(report.runtimeOwner, c.identity(path.join(state.runtime, 'database-owner.json')));
  assert.deepEqual(report.initialization, { code: 0, signal: null, error: null }); assert.deepEqual(report.applicationEnvironment, { TZ: 'UTC' });
}
function validateResult(campaign, kind, name, result, state, priors) {
  const spec = invocationSpec(campaign, kind, name, state.panelIds), artifact = path.dirname(spec.reportFile), input = reportState(campaign, kind);
  if (name.startsWith('migration-')) {
    const binding = require(path.join(NP, 'migration/migration-binding.cjs')), phase = name.slice('migration-'.length);
    const migration = require(path.join(NP, 'migration/migration-report.cjs'));
    if (phase === 'initialize-old') assert.deepEqual(c.identity(result.initialization.log.path), result.initialization.log);
    return migration.validateMigrationReport(result, { phase, workspace: campaign.workspace, runtime: input.runtime,
      campaign: c.identity(path.join(campaign.directory, 'campaign.json')), contract: c.identity(require.resolve('./codex-f2-task-due-date-timed-campaign.cjs')),
      runtimeOwner: c.identity(path.join(input.runtime, 'database-owner.json')), runtimePorts: c.identity(path.join(input.runtime, 'ports.json')),
      panelIds: state.panelIds, oracle: c.identity(ORACLES[name]), dependencies: ['migration-binding.cjs', 'fresh-state.cjs'].map(file => c.identity(path.join(NP, 'migration', file))).concat(binding.LEGACY_PINS['migration-evidence.cjs']),
      completedCases: state.completed, hashes: input.expected, indexSha256: campaign.fixture.indexSha256,
      postgresPort: read(path.join(input.runtime, 'ports.json')).postgres, node: NODE.path,
      oldMigrationNames: Object.keys(campaign.fixture.files).filter(file => file.startsWith('server/db/migrations/') && file.endsWith('.js')).map(file => path.basename(file)).sort() }, priors);
  }
  if (name === 'api') { assertFeatureSources(result, input, false); return validators.assertApi(result, { ...input, label: 'f02-' + kind + '-api' }, artifact); }
  if (name === 'ui') { assertFeatureSources(result, input, true); return validators.assertUi(result, { ...input, label: 'f02-' + kind + '-ui' }, artifact); }
  if (name === 'regressions') return regression.app(result, input, regression.API_CASES, ORACLES[name]);
  if (name === 'frontend') { input.helpers.assertCases(result, regression.FRONTEND_CASES, input.workspace); assert.equal(result.oracleSha256, c.identity(ORACLES[name]).sha256); return regression.sourceHashes(result, input, ['client/src/models/List.js', 'client/src/components/Card/Tasks.jsx']); }
  if (name === 'f05') return regression.checkF05(result, input, artifact, spec.scopeFile);
  if (name === 'f06') return regression.checkCsv(result, input, artifact);
  if (name === 'f04ui') return regression.checkF04UI(result, input, artifact);
  if (name === 'f06ui') return regression.checkF06UI(result, input, artifact);
  assert.equal(name, 'f04'); regression.app(result, input, ['F2-F04'], ORACLES.f04); assert(result.schemaBeforeCase.includes('description')); assert(result.boardReceipts.some(row => row.method === 'PATCH' && row.status === 404));
}
function migrationPriors(campaign, kind) {
  if (kind !== 'validation') return {};
  return Object.fromEntries(['initialize-old', 'seed-old'].map(phase => { const file = path.join(campaign.evidenceDirectory, 'checkpoint', 'migration-' + phase, 'result.json'); return [phase, { pin: c.identity(file), doc: read(file) }]; }));
}
function assertNativeBuild(campaign, state, report) {
  const file = path.join(campaign.directory, 'segment-1/window-A/reply-' + c.BUILD_ORDINAL + '.json');
  assert.deepEqual(report.nativeBuild, c.identity(file)); const reply = read(file); assert.equal(reply.ordinal, c.BUILD_ORDINAL);
  assert(reply.afterBoundary.buildSnapshot); assert.deepEqual(state.request.boundary.buildSnapshot, reply.afterBoundary.buildSnapshot);
  assert.deepEqual(report.finalBoundary.buildSnapshot, reply.afterBoundary.buildSnapshot, 'External oracles never rebuild native assets');
  const hashes = c.expectedSnapshotHashes(campaign.fixture, c.SELECTED), maps = reply.afterBoundary.buildSnapshot.featureSourceMapMatches;
  const wanted = c.PATCHES.filter(row => row.path.startsWith('client/')).map(row => row.path).sort(); assert.equal(wanted.length, 7);
  assert.deepEqual(Object.keys(maps).sort(), wanted); for (const file of wanted) assert.equal(maps[file], hashes[file]);
}
function assertFinalBoundary(campaign, kind, state, report) {
  const before = state.request.boundary, after = report.finalBoundary;
  const { auditBoundary } = require('./audit-vscode-codex-f2-task-due-date-timed.cjs');
  for (const boundary of [before, after]) {
    c.assertBoundary(boundary); auditBoundary(campaign.fixture, boundary, state.completed, state.panelIds, kind !== 'checkpoint');
  }
  for (const key of ['dependencySnapshots', 'cacheSnapshot', 'buildSnapshot'])
    assert.deepEqual(after[key], before[key], 'External evidence cannot alter native dependencies, command caches or build: ' + key);
  if (kind === 'final') assert.deepEqual(after.applicationTemporarySnapshot, before.applicationTemporarySnapshot, 'Final reuse launches no application');
  // Application temporary files/logs may grow only inside their exact schema-checked roots during real app phases.
  // They are not asserted equal to the pre-app snapshot. Source/index/dependency/build bytes remain strict.
  if (kind === 'checkpoint') assert.deepEqual(after.files.assetLinks, before.files.assetLinks);
  else {
    const links = after.files.assetLinks;
    assert.deepEqual(links.map(row => row.relative).sort(), Object.keys(c.ASSET_LINKS).sort());
    for (const row of links) {
      assert.deepEqual(Object.keys(row).sort(), ['generatedFiles', 'relative', 'target']);
      assert.equal(row.target, c.ASSET_LINKS[row.relative]);
      const files = after.buildSnapshot.files.filter(file => 'client/build/' + file.relative === row.target || ('client/build/' + file.relative).startsWith(row.target + '/'))
        .map(file => ({ relative: 'client/build/' + file.relative, sha256: file.sha256 })).sort((a, b) => a.relative.localeCompare(b.relative));
      assert(files.length > 0); assert.deepEqual([...row.generatedFiles].sort((a, b) => a.relative.localeCompare(b.relative)), files);
    }
  }
  assert.equal(report.nativePostgresRestartClaimed, false);
}
function verifyGate(campaign, kind, gate) {
  const { runner } = dependencies(), state = gateState(campaign, kind);
  assert.equal(gate.kind, kind); assert.equal(gate.status, 'REVIEWED_REAL_EVIDENCE');
  assert.deepEqual(gate.files.map(pin => pin.path), campaign.evidenceFiles[kind]); for (const pin of gate.files) assert.deepEqual(c.identity(pin.path), pin);
  const report = read(gate.files[0].path); assert.equal(report.status, 'PASS_ROOT_F02_' + kind.toUpperCase()); assert.equal(report.kind, kind);
  assert.equal(report.scope, phaseScope(kind));
  assert.deepEqual(report.campaign, c.identity(path.join(campaign.directory, 'campaign.json'))); assert.equal(report.workspace, campaign.workspace);
  assert.equal(report.runtime, path.join(campaign.directory, 'runtime')); assert.deepEqual(report.requestBoundary, state.boundary); assert.deepEqual(report.completedPatchIds, state.completed);
  assert(report.startedAt >= state.request.at && report.endedAt >= report.startedAt); assertFinalBoundary(campaign, kind, state, report);
  assert.deepEqual(report.runtimeIdentity, scope.runtimeIdentity(report.runtime));
  assert.deepEqual(report.executions.map(row => row.name), executionNames(kind));
  if (kind === 'final') {
    assert.deepEqual(report.reusedGates.map(row => row.kind), ['validation', 'restored']);
    for (const row of report.reusedGates) { assert.equal(row.identity.path, path.join(campaign.directory, 'gates', row.kind + '.json')); assert.deepEqual(c.identity(row.identity.path), row.identity); verifyGate(campaign, row.kind, read(row.identity.path)); }
    const restored = read(campaign.evidenceFiles.restored[0]); assert.deepEqual(report.finalBoundary.buildSnapshot, restored.finalBoundary.buildSnapshot); assert.deepEqual(state.request.boundary.buildSnapshot, restored.finalBoundary.buildSnapshot);
    return { status: report.status, newApplicationLaunches: 0, nativePostgresRestartClaimed: false };
  }
  assert.equal(report.initialScope.path, path.join(path.dirname(gate.files[0].path), 'initial-scope.json')); assert.deepEqual(c.identity(report.initialScope.path), report.initialScope);
  const initialScope = read(report.initialScope.path); assert.deepEqual(initialScope.runtimeIdentity, report.runtimeIdentity); assert.deepEqual(report.runtimeIdentity, scope.runtimeIdentity(report.runtime));
  assertScopeRecords({ campaign, kind, name: 'initial', captured: initialScope, requestBoundary: state.request.boundary, panelIds: state.panelIds, initialScope });
  if (kind === 'validation') verifyGate(campaign, 'checkpoint', read(path.join(campaign.directory, 'gates/checkpoint.json')));
  const priors = migrationPriors(campaign, kind); let lastFinished = report.startedAt;
  for (const row of report.executions) {
    for (const pin of [row.execution, row.report, row.scope, row.reservation]) { c.contained(path.dirname(gate.files[0].path), pin.path); assert.deepEqual(c.identity(pin.path), pin); }
    const execution = read(row.execution.path), captured = read(row.scope.path), reservation = read(row.reservation.path), result = read(row.report.path);
    assertInvocationRecords({ campaign, kind, row, captured, execution, reservation, requestBoundary: state.request.boundary, panelIds: state.panelIds, startedAt: lastFinished, endedAt: report.endedAt, initialScope, runner });
    lastFinished = Date.parse(execution.finishedAt);
    if (result.startedAt) { assert(Date.parse(result.startedAt) >= Date.parse(execution.startedAt)); assert(Date.parse(result.finishedAt) <= lastFinished); }
    validateResult(campaign, kind, row.name, result, state, priors);
    if (row.name.startsWith('migration-')) priors[row.name.slice('migration-'.length)] = { pin: row.report, doc: result };
    if (row.name === 'f05') { assert.equal(result.receiver.pid, execution.pid); for (const boundary of [result.sourceBoundaryBefore, result.sourceBoundaryAfter]) for (const key of ['sourceFiles', 'sourceSha256', 'indexSha256', 'documentationSha256', 'dependencyFiles', 'panelIds']) assert.deepEqual(boundary[key], row.sourceBoundaryAfter[key]); }
  }
  if (kind === 'checkpoint') {
    const context = read(gate.files[1].path); assert.deepEqual(context.priorCheckpoint, c.PRIOR_NATIVE_CHECKPOINT); assert.deepEqual(context.localQualification, c.QUALIFICATION); assert.deepEqual(context.plan, c.PLAN);
    assert.equal(context.priorNative28Mechanical, 'PASS_MECHANICAL_18'); assert.equal(context.priorNative28Aggregate, 'PARTIAL_F2_CSV_EXPORT_SEQUENTIAL_EVIDENCE');
    assert.equal(context.historicalNative25Strict, 'FAIL'); assert.equal(context.supplementalReviewerPrelaunchPinned, false);
  } else assertNativeBuild(campaign, state, report);
  assert.equal(report.nativePostgresRestartClaimed, false);
  return { status: report.status, bugCases: 12, priorFeatures: ['F2-F05', 'F2-F04', 'F2-F06'], f02Present: kind !== 'checkpoint', apiCases: kind === 'checkpoint' ? 0 : 87, uiCore: kind === 'checkpoint' ? 0 : 7, uiRecovery: kind === 'checkpoint' ? 0 : 2, nativePostgresRestartClaimed: false };
}
async function executeGate(directory, kind) {
  const { runner } = dependencies(); assert.deepEqual(c.identity(process.execPath), NODE); assert.equal(directory, DIRECTORY);
  const campaign = read(path.join(directory, 'campaign.json')), state = gateState(campaign, kind), runtime = path.join(directory, 'runtime'), artifact = path.join(campaign.evidenceDirectory, kind);
  assert(!fs.existsSync(path.join(artifact, 'review.json')) && !fs.existsSync(path.join(directory, 'gates', kind + '.json')));
  write(path.join(artifact, 'gate-reservation.json'), { kind, at: Date.now(), campaign: c.identity(path.join(directory, 'campaign.json')), retries: 0 });
  const report = { schemaVersion: 1, status: 'RUNNING', kind, campaign: c.identity(path.join(directory, 'campaign.json')), workspace: campaign.workspace, runtime,
    startedAt: Date.now(), requestBoundary: state.boundary, completedPatchIds: state.completed, runtimeIdentity: scope.runtimeIdentity(runtime), executions: [], nativePostgresRestartClaimed: false };
  c.verifyBoundary(campaign.fixture, state.completed, state.panelIds);
  try {
    if (kind !== 'final') { const file = path.join(artifact, 'initial-scope.json'); write(file, scope.capture(campaign.workspace, runtime, state.panelIds)); report.initialScope = c.identity(file); }
    const priors = migrationPriors(campaign, kind);
    for (const name of executionNames(kind)) {
      if (needsAssets(kind, name)) for (const [relative, target] of Object.entries(c.ASSET_LINKS)) {
        const file = path.join(campaign.workspace, relative), destination = path.join(campaign.workspace, target); assert(fs.existsSync(destination));
        if (!fs.existsSync(file)) fs.symlinkSync(path.relative(path.dirname(file), destination), file);
        assert(fs.lstatSync(file).isSymbolicLink()); assert.equal(fs.readlinkSync(file), path.relative(path.dirname(file), destination)); assert.equal(fs.realpathSync(file), destination);
      }
      const spec = invocationSpec(campaign, kind, name, state.panelIds), captured = scope.capture(campaign.workspace, runtime, state.panelIds); write(spec.scopeFile, captured);
      write(spec.reservationFile, { command: spec.command, cwd: repo, deadlineMs: spec.deadlineMs, expectedExit: 0, retries: 0, at: Date.now(), scope: c.identity(spec.scopeFile) });
      let execution, sourceBoundaryAfter;
      try { execution = await runner.runBounded({ executable: NODE.path, args: spec.command.slice(1), cwd: repo,
        env: { ...process.env, ...campaign.fixture.commandPolicy.environment, PATH: path.dirname(NODE.path) + path.delimiter + process.env.PATH }, logFile: path.join(artifact, name + '.log'), deadlineMs: spec.deadlineMs });
        write(spec.executionFile, execution);
      } finally { sourceBoundaryAfter = scope.verify(captured, campaign.workspace, runtime); }
      const row = { name, command: spec.command, execution: c.identity(spec.executionFile), report: fs.existsSync(spec.reportFile) ? c.identity(spec.reportFile) : null,
        scope: c.identity(spec.scopeFile), reservation: c.identity(spec.reservationFile), sourceBoundaryAfter };
      report.executions.push(row); runner.requireSuccessfulInvocation(execution, 0); assert(row.report, 'Actual report required');
      const result = read(spec.reportFile); validateResult(campaign, kind, name, result, state, priors);
      if (name.startsWith('migration-')) priors[name.slice('migration-'.length)] = { pin: row.report, doc: result };
    }
    if (kind === 'final') report.reusedGates = ['validation', 'restored'].map(phase => ({ kind: phase, identity: c.identity(path.join(directory, 'gates', phase + '.json')) }));
    else if (kind !== 'checkpoint') report.nativeBuild = c.identity(path.join(directory, 'segment-1/window-A/reply-' + c.BUILD_ORDINAL + '.json'));
    report.finalBoundary = c.verifyBoundary(campaign.fixture, state.completed, state.panelIds); report.status = 'PASS_ROOT_F02_' + kind.toUpperCase(); report.endedAt = Date.now();
    report.scope = phaseScope(kind);
    write(path.join(artifact, 'review.json'), report);
    if (kind === 'checkpoint') write(path.join(artifact, 'prior-context.json'), { priorCheckpoint: c.PRIOR_NATIVE_CHECKPOINT, localQualification: c.QUALIFICATION, plan: c.PLAN,
      priorNative28Mechanical: 'PASS_MECHANICAL_18', priorNative28Aggregate: 'PARTIAL_F2_CSV_EXPORT_SEQUENTIAL_EVIDENCE', historicalNative25Strict: 'FAIL', supplementalReviewerPrelaunchPinned: false,
      scope: 'Fresh old schema plus retained-feature baseline precede old-row fixture seeding. The eleven supplied local changes are not preapplied. Native28 acceptance is bounded; native25 original strict FAIL and postrun supplemental basis remain historical. Migration/API/UI/local controls establish distinct layers.' });
    const gate = { kind, status: 'REVIEWED_REAL_EVIDENCE', files: campaign.evidenceFiles[kind].map(c.identity), review: report.scope };
    const verified = verifyGate(campaign, kind, gate); write(path.join(directory, 'gates', kind + '.json'), gate); console.log(JSON.stringify({ ...verified, report: c.identity(path.join(artifact, 'review.json')) }));
  } catch (error) { write(path.join(artifact, 'failure.json'), { ...report, status: 'FAIL_ROOT_F02_' + kind.toUpperCase(), endedAt: Date.now(), error: { name: error.name, message: error.message, stack: error.stack } }); throw error; }
}
module.exports = { NODE, ORACLES, ADAPTATION, MIGRATION_QUALIFICATION, controllerQualification, DIRECTORY, executionNames, phaseScope, needsAssets, dependencies, gateState, invocationSpec,
  assertScopeRecords, assertInvocationRecords, reportState, assertRecordedSourceHashes, assertFeatureSources, validateResult, migrationPriors, assertNativeBuild, assertFinalBoundary, verifyGate, executeGate };
if (require.main === module) executeGate(path.resolve(process.argv[2]), process.argv[3]).catch(error => { console.error(error.stack); process.exitCode = 1; });
