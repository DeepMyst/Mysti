/* Campaign-owned root API/browser gates. Import is read-only; CLI requires an actual waiting native gate. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const c = require('./codex-f2-board-description-campaign.cjs'), compact = require('./codex-f2-compact-store.cjs');
const repo = path.resolve(__dirname, '../..'), base = path.join(repo, 'out-test/feature-tests/PB-02/overnight-20261011');
const local = path.join(base, 'f04-board-description-validation');
const scope = require(path.join(base, 'f05-signed-webhook-validation/f05-scope.cjs'));
const controllerQualification = { path: path.join(local, 'process-observer-correction/qualification.json'), sha256: 'ba91d7ba325e6abf43c21d7991c520fa6527e84b298c650eba65090169743ed5' };
const NODE = Object.freeze({ path: '/Users/bahaabunojaim/.npm/_npx/d18f28baf1132559/node_modules/node/bin/node', sha256: '68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b' });
const ORACLES = Object.freeze({ api: path.join(local, 'f04-api-logfile-oracle.cjs'), ui: path.join(local, 'f04-ui-layout-oracle.cjs'),
  regressions: path.join(local, 'all-eight-api-logfile-oracle.cjs'), frontend: path.join(base, 'f2-workload-preparation/oracle/frontend-oracle.cjs'),
  f05: path.join(base, 'f05-bounded-invocation-validation/timed-f05-entry.cjs') });
const read = file => compact.readJson(file), write = (file, data) => compact.writeJson(file, data);
function dependencies() {
  const q = c.pinned(controllerQualification); assert.equal(q.passedControls, 35); assert.deepEqual(c.identity(q.controller.path), q.controller);
  for (const pin of q.controls) assert.deepEqual(c.identity(pin.path), pin);
  const original = c.candidateProvenance().qualification;
  const f05 = read(path.join(base, 'f05-bounded-invocation-validation/qualification-review.json'));
  const pins = [c.identity(__filename), NODE, controllerQualification, q.controller, ...q.controls,
    ...Object.values(ORACLES).map(c.identity), ...original.codePins,
    c.identity(path.join(local, 'f04-ui-layout-acceptance.cjs')), c.identity(path.join(base, 'f2-api-readiness-validation/api-lifecycle.cjs')),
    c.identity(path.join(base, 'f2-workload-preparation/oracle/feature-acceptance.cjs')), ...f05.coreImplementationPins, ...f05.runnerPins];
  for (const pin of pins) assert.deepEqual(c.identity(pin.path), pin);
  return { pins: require('./pb02-unique-pins.cjs').uniquePins(pins), runner: require(q.controller.path) };
}
function assertApplication(report, campaign) {
  assert.equal(report.workspace, campaign.workspace); assert.equal(report.runtime, path.join(campaign.directory, 'runtime'));
  assert.equal(report.contractSha256, c.CASE_CONTRACT.sha256); assert.equal(report.readiness.status, 'READY');
  assert.deepEqual(report.process.exit, { code: 0, signal: null });
  assert.equal(report.runtimeOwnerSha256, c.identity(path.join(report.runtime, 'database-owner.json')).sha256);
  const sourcePaths = [...new Set(c.pinned(c.CASE_CONTRACT).cases.filter(row => row.kind === 'seeded-bug').map(row => row.mutation.path))].sort();
  assert.deepEqual(Object.keys(report.sourceHashes).sort(), sourcePaths);
  for (const [relative, sha256] of Object.entries(report.sourceHashes)) assert.equal(sha256, campaign.fixture.files[relative].sha256);
}
function assertF04Api(report, campaign, absent) {
  assertApplication(report, campaign); assert.equal(report.oracleSha256, c.identity(ORACLES.api).sha256);
  assert.deepEqual(report.selectedCaseIds, ['F2-F04']); assert.equal(report.cases.length, 1); assert.equal(report.cases[0].id, 'F2-F04');
  if (absent) {
    assert.equal(report.status, 'FAIL'); assert.equal(report.cases[0].status, 'FAIL'); assert.equal(report.cases[0].errorType, 'ASSERTION_FAILURE');
    assert.match(report.cases[0].error, /new board description defaults to null/); assert(!report.schemaBeforeCase.includes('description'));
    assert.equal(report.boardReceipts.length, 1); const receipt = report.boardReceipts[0];
    assert.equal(receipt.method, 'POST'); assert.equal(receipt.status, 200); assert(!Object.hasOwn(receipt.response.item, 'description'));
  } else { assert.equal(report.status, 'PASS'); assert.deepEqual(report.cases, [{ id: 'F2-F04', status: 'PASS' }]); assert(report.schemaBeforeCase.includes('description')); }
}
function assertMigrationRecords(before, after, runtimeIdentity) {
  assert.equal(before.kind, 'BEFORE_F04_MIGRATION'); assert.equal(after.kind, 'AFTER_F04_MIGRATION');
  assert.deepEqual(before.runtimeIdentity, runtimeIdentity); assert.deepEqual(after.runtimeIdentity, runtimeIdentity);
  assert.deepEqual(after.database, before.database, 'Same database and PostgreSQL process start');
  assert.equal(before.database.name, 'f2_baseline'); assert.equal(before.database.user, 'f2_fixture');
  assert(Number.isFinite(Date.parse(before.database.postmasterStartedAt)));
  assert.equal(before.descriptionColumnAbsent, true); assert(!Object.hasOwn(before.row, 'description'));
  assert.equal(after.descriptionColumnAbsent, false);
  assert(before.row && typeof before.row.id === 'string' && before.row.id.length > 0);
  assert.deepEqual(after.row, { ...before.row, description: null });
  const receipt = before.creationReceipt; assert.equal(receipt.status, 200); assert.equal(receipt.method, 'POST');
  assert.equal(receipt.url, `/api/projects/${before.row.project_id}/boards`);
  assert.deepEqual({ id: receipt.response.item.id, project_id: receipt.response.item.projectId, name: receipt.response.item.name }, before.row);
  assert(!Object.hasOwn(receipt.response.item, 'description'));
  assert.equal(after.beforeRecordSha256, c.hash(JSON.stringify(before)));
  return 'PASS_EXACT_PREMIGRATION_BOARD_DEFAULT_NULL';
}
function assertUI(report, campaign) {
  assertApplication(report, campaign); assert.equal(report.oracleSha256, c.identity(ORACLES.ui).sha256);
  assert.equal(report.status, 'PASS'); assert.deepEqual(report.cases, [{ id: 'F2-F04-UI', status: 'PASS' }]);
  assert.deepEqual(report.browserErrors, []); assert.equal(report.positiveUIControls.length, 1); assert.equal(report.positiveUIControls[0].authenticatedBoardAndCardVisible, true);
  assert.equal(report.layoutChecks.length, 1); const layout = report.layoutChecks[0];
  assert.equal(layout.overlap, false); assert(Number.isFinite(layout.contrast) && layout.contrast >= 4.5);
  for (const box of [layout.descriptionBox, layout.settingsBox, layout.cardBox]) assert(box && box.width > 0 && box.height > 0);
  assert(layout.settingsBox.y + layout.settingsBox.height <= layout.descriptionBox.y);
  assert(layout.descriptionBox.y + layout.descriptionBox.height <= layout.cardBox.y);
}
function assertRegressions(api, frontend, feature, campaign) {
  assertApplication(api, campaign); assert.equal(api.oracleSha256, c.identity(ORACLES.regressions).sha256); assert.equal(api.status, 'PASS');
  assert.equal(frontend.workspace, campaign.workspace); assert.equal(frontend.status, 'PASS');
  assert.equal(frontend.oracleSha256, c.identity(ORACLES.frontend).sha256);
  assert.deepEqual(Object.keys(frontend.sourceHashes).sort(), ['client/src/components/Card/Tasks.jsx', 'client/src/models/List.js']);
  const cases = [...api.cases, ...frontend.cases]; assert.equal(cases.length, 12); assert(cases.every(row => row.status === 'PASS'));
  assert.deepEqual(cases.map(row => row.id).sort(), [...c.INITIAL_CASES].sort());
  for (const [relative, sha256] of Object.entries(frontend.sourceHashes)) assert.equal(sha256, campaign.fixture.files[relative].sha256);
  assert.equal(feature.status, 'PASS_F05_SIGNED_WEBHOOKS'); assert.equal(feature.workspace, campaign.workspace); assert.equal(feature.runtime, path.join(campaign.directory, 'runtime'));
  assert.deepEqual(feature.failures, []); assert.deepEqual(feature.receiverErrors, []); assert.deepEqual(feature.process.exit, { code: 0, signal: null });
  assert.equal(feature.events.length, 6); assert.equal(feature.receiver.cleanup.status, 'DRAINED'); assert.equal(feature.receiver.cleanup.forcedConnections, false);
  assert.deepEqual(feature.initialization, { code: 0, signal: null }); assert.equal(feature.caseId, 'F2-F05');
  const f05Qualification = read(path.join(base, 'f05-signed-webhook-validation/qualification-review.json'));
  assert.deepEqual(feature.sourceIdentities, f05Qualification.implementationPins.slice(0, 8).sort((a, b) => a.path.localeCompare(b.path)));
  const receipt = require(path.join(base, 'f05-signed-webhook-validation/f05-receipts.cjs'));
  const logs = feature.finalChecks.checkedLogs.map(pin => { assert.equal(c.identity(pin.path).sha256, pin.sha256); return { path: pin.path, bytes: fs.readFileSync(pin.path) }; });
  assert.deepEqual(receipt.verifyFinal(feature.events, feature.fixture, logs), feature.finalChecks);
  return cases;
}
function gateState(campaign, kind) {
  assert.equal(campaign.stage, c.STAGE); assert(['checkpoint', 'validation', 'restored', 'final'].includes(kind));
  const completed = kind === 'checkpoint' ? [] : [...c.SELECTED], segment = ['restored', 'final'].includes(kind) ? 2 : 1;
  const owner = path.join(campaign.directory, `segment-${segment}/window-A`), step = c.buildSteps(campaign.workspace).find(row => row.evidence === kind);
  const observations = read(path.join(owner, 'observations.json'));
  const requests = observations.filter(row => row.event === 'external-evidence-needed' && row.kind === kind); assert.equal(requests.length, 1);
  const request = requests[0]; assert.equal(request.marker, step.marker); assert.deepEqual(request.files.completedCases, completed);
  assert(Array.isArray(request.panelIds) && request.panelIds.length === segment);
  const boundaryFile = path.join(owner, 'boundary-evidence-' + kind + '.json'); const record = read(boundaryFile);
  assert.deepEqual(record.snapshot, request.boundary); assert(record.at <= request.at);
  assert.deepEqual(request.files, request.boundary.files); assert.deepEqual(request.files.hashes, c.expectedSnapshotHashes(campaign.fixture, completed));
  return { completed, segment, step, owner, request, boundary: c.identity(boundaryFile), panelIds: request.panelIds };
}
function invocationSpec(campaign, kind, name) {
  assert(['checkpoint', 'validation', 'restored'].includes(kind)); assert(Object.hasOwn(ORACLES, name));
  assert(kind !== 'checkpoint' || name !== 'ui');
  const artifact = path.join(campaign.evidenceDirectory, kind), runtime = path.join(campaign.directory, 'runtime');
  const scopeFile = path.join(artifact, name + '-scope.json'), output = path.join(artifact, name);
  const reportFile = name === 'frontend' ? output + '.json' : path.join(output, 'result.json');
  const args = name === 'frontend' ? [campaign.workspace, reportFile] : name === 'f05' ? [campaign.workspace, output, runtime, scopeFile, path.join(artifact, 'f05-timing.jsonl')]
    : [campaign.workspace, 'f04-' + kind + '-' + name, output, runtime, ...(name === 'api' ? ['F2-F04'] : name === 'ui' ? ['F2-F04-UI'] : [])];
  return { command: [NODE.path, ORACLES[name], ...args], scopeFile, reportFile, executionFile: path.join(artifact, name + '-execution.json'),
    expectedExit: kind === 'checkpoint' && name === 'api' ? 1 : 0, deadlineMs: name === 'f05' ? 420000 : 120000 };
}
function assertScopeRecords({ campaign, kind, name, captured, requestBoundary, panelIds, initialScope }) {
  assert.equal(captured.schemaVersion, 1); assert.equal(captured.purpose, 'PB02_F05_SOURCE_RUNTIME_SCOPE');
  assert.equal(captured.workspace, campaign.workspace); assert.equal(captured.runtime, path.join(campaign.directory, 'runtime'));
  assert.deepEqual(captured.panelIds, panelIds); assert.deepEqual(captured.runtimeIdentity, initialScope.runtimeIdentity);
  assert.deepEqual(captured.dependencyTrees, initialScope.dependencyTrees); assert.deepEqual(captured.source.directories, initialScope.source.directories);
  const expected = Object.fromEntries(Object.entries(c.expectedSnapshotHashes(campaign.fixture, kind === 'checkpoint' ? [] : c.SELECTED)).map(([name, sha256]) => [name, { kind: 'file', sha256 }]));
  for (const file of requestBoundary.buildSnapshot?.files || []) {
    assert.equal(file.path, path.join(campaign.workspace, 'client/build', file.relative));
    expected['client/build/' + file.relative] = { kind: 'file', sha256: file.sha256 };
  }
  const links = name === 'ui' ? Object.entries(c.ASSET_LINKS) : requestBoundary.files.assetLinks.map(row => [row.relative, row.target]);
  for (const [relative, target] of links) {
    assert.equal(c.ASSET_LINKS[relative], target);
    expected[relative] = { kind: 'owned-asset-link', target: path.relative(path.dirname(path.join(campaign.workspace, relative)), path.join(campaign.workspace, target)) };
  }
  assert.deepEqual(captured.source.files, expected, 'Exact source, build and approved asset-link inventory');
  return expected;
}
function assertInvocationRecords({ campaign, kind, row, captured, execution, requestBoundary, panelIds, startedAt, endedAt, initialScope, runner }) {
  const spec = invocationSpec(campaign, kind, row.name);
  assert.deepEqual(row.command, spec.command); assert.deepEqual(execution.command, spec.command);
  assert.equal(row.scope.path, spec.scopeFile); assert.equal(row.report.path, spec.reportFile); assert.equal(row.execution.path, spec.executionFile);
  (runner || dependencies().runner).requireSuccessfulInvocation(execution, spec.expectedExit);
  assert.equal(execution.cwd, repo); assert.equal(execution.deadlineMs, spec.deadlineMs); assert.deepEqual(execution.signals, []);
  assert(Number.isFinite(startedAt) && Number.isFinite(endedAt));
  assert(Date.parse(execution.startedAt) >= startedAt && Date.parse(execution.finishedAt) <= endedAt);
  assertScopeRecords({ campaign, kind, name: row.name, captured, requestBoundary, panelIds, initialScope });
  const after = row.sourceBoundaryAfter;
  assert.equal(after.sourceFiles, Object.keys(captured.source.files).length); assert.equal(after.sourceSha256, c.hash(JSON.stringify(captured.source)));
  assert.equal(after.indexSha256, campaign.fixture.indexSha256); assert.equal(after.documentationSha256, captured.source.files['server/.env.sample'].sha256);
  assert.equal(after.dependencyFiles, captured.dependencyTrees.reduce((n, tree) => n + tree.files, 0)); assert.deepEqual(after.panelIds, panelIds);
  return { status: 'PASS_EXACT_F04_INVOCATION_AND_SOURCE_JOIN', name: row.name };
}
function verifyGate(campaign, kind, gate) {
  const { runner } = dependencies(); assert.equal(gate.kind, kind); assert.equal(gate.status, 'REVIEWED_REAL_EVIDENCE');
  assert.deepEqual(gate.files.map(pin => pin.path), campaign.evidenceFiles[kind]);
  for (const pin of gate.files) assert.deepEqual(c.identity(pin.path), pin);
  const report = read(gate.files[0].path), state = gateState(campaign, kind);
  assert.equal(report.status, 'PASS_ROOT_F04_' + kind.toUpperCase()); assert.equal(report.kind, kind);
  assert.deepEqual(report.campaign, c.identity(path.join(campaign.directory, 'campaign.json')));
  assert.equal(report.workspace, campaign.workspace); assert.equal(report.runtime, path.join(campaign.directory, 'runtime'));
  assert.deepEqual(report.requestBoundary, state.boundary); assert.deepEqual(report.completedPatchIds, state.completed);
  assert(report.startedAt >= state.request.at && report.endedAt >= report.startedAt);
  assert.deepEqual(report.finalBoundary.files.hashes, c.expectedSnapshotHashes(campaign.fixture, state.completed));
  if (kind === 'final') {
    assert.deepEqual(report.reusedGates.map(row => row.kind), ['validation', 'restored']);
    for (const row of report.reusedGates) { assert.deepEqual(c.identity(row.identity.path), row.identity); verifyGate(campaign, row.kind, read(row.identity.path)); }
    assert.equal(report.executions.length, 0); return { status: report.status, newApplicationLaunches: 0 };
  }
  const names = kind === 'checkpoint' ? ['api', 'regressions', 'frontend', 'f05'] : ['api', 'regressions', 'frontend', 'f05', 'ui'];
  assert.deepEqual(report.executions.map(row => row.name), names);
  assert.equal(report.initialScope.path, path.join(path.dirname(gate.files[0].path), 'initial-scope.json'));
  assert.deepEqual(c.identity(report.initialScope.path), report.initialScope); const initialScope = read(report.initialScope.path);
  assert.deepEqual(initialScope.runtimeIdentity, report.runtimeIdentity); assert.deepEqual(report.runtimeIdentity, scope.runtimeIdentity(report.runtime));
  assertScopeRecords({ campaign, kind, name: 'api', captured: initialScope, requestBoundary: state.request.boundary, panelIds: state.panelIds, initialScope });
  const results = {};
  for (const row of report.executions) {
    for (const pin of [row.execution, row.report, row.scope]) { c.contained(path.dirname(gate.files[0].path), pin.path); assert.deepEqual(c.identity(pin.path), pin); }
    const execution = read(row.execution.path), captured = read(row.scope.path);
    assertInvocationRecords({ campaign, kind, row, captured, execution, requestBoundary: state.request.boundary, panelIds: state.panelIds,
      startedAt: report.startedAt, endedAt: report.endedAt, initialScope, runner });
    results[row.name] = read(row.report.path);
    if (row.name === 'f05') {
      const feature = results.f05; assert.deepEqual(feature.scope, row.scope); assert.equal(feature.artifact, path.dirname(row.report.path));
      assert.equal(feature.receiver.pid, execution.pid, 'Signed webhook receiver belongs to the invoked oracle');
      for (const boundary of [feature.sourceBoundaryBefore, feature.sourceBoundaryAfter]) {
        for (const key of ['sourceFiles', 'sourceSha256', 'indexSha256', 'documentationSha256', 'dependencyFiles', 'panelIds']) assert.deepEqual(boundary[key], row.sourceBoundaryAfter[key]);
      }
    }
  }
  assertF04Api(results.api, campaign, kind === 'checkpoint'); assertRegressions(results.regressions, results.frontend, results.f05, campaign);
  assert.deepEqual(report.runtimeIdentity, scope.runtimeIdentity(report.runtime));
  if (kind === 'checkpoint') {
    assert.equal(report.preMigrationBoard.kind, 'BEFORE_F04_MIGRATION');
    assert.deepEqual(report.preMigrationBoard.creationReceipt, results.api.boardReceipts[0]);
    assert.deepEqual(report.preMigrationBoard.runtimeIdentity, report.runtimeIdentity);
  } else {
    assertUI(results.ui, campaign); const baseline = read(campaign.evidenceFiles.checkpoint[0]);
    assert.deepEqual(report.migration.before, baseline.preMigrationBoard);
    assertMigrationRecords(report.migration.before, report.migration.after, report.runtimeIdentity);
    assert.deepEqual(c.identity(report.screenshot.path), report.screenshot);
    const native = read(report.nativeBuild.path); assert.deepEqual(c.identity(report.nativeBuild.path), report.nativeBuild);
    assert.equal(native.ordinal, c.BUILD_ORDINAL); assert(native.afterBoundary.buildSnapshot);
    assert.deepEqual(report.finalBoundary.buildSnapshot, native.afterBoundary.buildSnapshot, 'Root API/browser gates never rebuild native assets');
    assert.deepEqual(state.request.boundary.buildSnapshot, native.afterBoundary.buildSnapshot);
  }
  return { status: report.status, bugCases: 12, f05RawReceipts: 6, f04Present: kind !== 'checkpoint' };
}
async function migrationRecord(workspace, runtime, before, receipt) {
  const ports = read(path.join(runtime, 'ports.json')), req = createRequire(path.join(workspace, 'server/package.json'));
  const db = new (req('pg').Client)({ host: '127.0.0.1', port: ports.postgres, user: 'f2_fixture', password: 'f2-local-synthetic-only', database: 'f2_baseline' });
  await db.connect();
  try {
    const databaseRow = (await db.query('SELECT current_database() AS name,current_user AS "user",pg_postmaster_start_time() AS started,inet_server_port() AS port')).rows[0];
    assert.equal(databaseRow.port, ports.postgres);
    const database = { name: databaseRow.name, user: databaseRow.user, postmasterStartedAt: databaseRow.started.toISOString(), port: databaseRow.port };
    const columns = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='board'")).rows.map(row => row.column_name);
    const id = before ? before.row.id : receipt.response.item.id;
    const fields = before ? 'id,project_id,name,description' : 'id,project_id,name';
    const rows = (await db.query('SELECT ' + fields + ' FROM board WHERE id=$1', [id])).rows; assert.equal(rows.length, 1);
    const result = { kind: before ? 'AFTER_F04_MIGRATION' : 'BEFORE_F04_MIGRATION', runtimeIdentity: scope.runtimeIdentity(runtime), database, descriptionColumnAbsent: !columns.includes('description'), row: rows[0] };
    if (before) { result.beforeRecordSha256 = c.hash(JSON.stringify(before)); assertMigrationRecords(before, result, result.runtimeIdentity); }
    else { assert(result.descriptionColumnAbsent); result.creationReceipt = receipt; }
    return result;
  } finally { await db.end(); }
}
async function executeGate(directory, kind) {
  const { runner } = dependencies(); assert.deepEqual(c.identity(process.execPath), NODE);
  const campaign = read(path.join(directory, 'campaign.json')); assert.equal(campaign.directory, directory);
  const state = gateState(campaign, kind), runtime = path.join(directory, 'runtime'), artifact = path.join(campaign.evidenceDirectory, kind);
  assert(!fs.existsSync(path.join(artifact, 'review.json')) && !fs.existsSync(path.join(directory, 'gates', kind + '.json')));
  const report = { schemaVersion: 1, status: 'RUNNING', kind, campaign: c.identity(path.join(directory, 'campaign.json')), workspace: campaign.workspace, runtime,
    startedAt: Date.now(), requestBoundary: state.boundary, completedPatchIds: state.completed, runtimeIdentity: scope.runtimeIdentity(runtime), executions: [] };
  c.verifyBoundary(campaign.fixture, state.completed, state.panelIds);
  if (kind !== 'final') {
    const file = path.join(artifact, 'initial-scope.json'); write(file, scope.capture(campaign.workspace, runtime, state.panelIds)); report.initialScope = c.identity(file);
  }
  async function run(name, expectedExit = 0) {
    const workspace = campaign.workspace;
    if (name === 'ui') for (const [relative, target] of Object.entries(c.ASSET_LINKS)) {
      const file = path.join(workspace, relative), destination = path.join(workspace, target); assert(fs.existsSync(destination));
      if (!fs.existsSync(file)) fs.symlinkSync(path.relative(path.dirname(file), destination), file);
      assert(fs.lstatSync(file).isSymbolicLink()); assert.equal(fs.realpathSync(file), destination);
    }
    const spec = invocationSpec(campaign, kind, name), { scopeFile, reportFile, command, deadlineMs } = spec; assert.equal(expectedExit, spec.expectedExit);
    const captured = scope.capture(workspace, runtime, state.panelIds); write(scopeFile, captured);
    write(path.join(artifact, name + '-reservation.json'), { command, cwd: repo, deadlineMs, expectedExit, retries: 0, at: Date.now(), scope: c.identity(scopeFile) });
    const execution = await runner.runBounded({ executable: NODE.path, args: command.slice(1), cwd: repo,
      env: { ...process.env, ...campaign.fixture.commandPolicy.environment, PATH: path.dirname(NODE.path) + path.delimiter + process.env.PATH }, logFile: path.join(artifact, name + '.log'), deadlineMs });
    const executionFile = spec.executionFile; write(executionFile, execution); runner.requireSuccessfulInvocation(execution, expectedExit);
    const boundary = scope.verify(captured, workspace, runtime);
    report.executions.push({ name, command, execution: c.identity(executionFile), report: c.identity(reportFile), scope: c.identity(scopeFile), sourceBoundaryAfter: boundary });
    return read(reportFile);
  }
  if (kind === 'final') {
    report.reusedGates = ['validation', 'restored'].map(kind => ({ kind, identity: c.identity(path.join(directory, 'gates', kind + '.json')) }));
  } else {
    const api = await run('api', kind === 'checkpoint' ? 1 : 0); assertF04Api(api, campaign, kind === 'checkpoint');
    if (kind === 'checkpoint') report.preMigrationBoard = await migrationRecord(campaign.workspace, runtime, null, api.boardReceipts[0]);
    else {
      const before = read(campaign.evidenceFiles.checkpoint[0]).preMigrationBoard;
      report.migration = { before, after: await migrationRecord(campaign.workspace, runtime, before) };
    }
    const regression = await run('regressions'), frontend = await run('frontend'), f05 = await run('f05'); assertRegressions(regression, frontend, f05, campaign);
    if (kind !== 'checkpoint') {
      const ui = await run('ui'); assertUI(ui, campaign); report.screenshot = c.identity(path.join(artifact, 'ui/F04-description.png'));
      report.nativeBuild = c.identity(path.join(directory, 'segment-1/window-A/reply-' + c.BUILD_ORDINAL + '.json'));
    }
  }
  report.finalBoundary = c.verifyBoundary(campaign.fixture, state.completed, state.panelIds);
  report.status = 'PASS_ROOT_F04_' + kind.toUpperCase(); report.endedAt = Date.now();
  report.scope = 'Root-run application/browser evidence on native workspace. Preserves prior twelve repairs and F05; migration follows the same pre-column board. No database restart or exhaustive mobile/accessibility/endurance credit.';
  write(path.join(artifact, 'review.json'), report);
  if (kind === 'checkpoint') write(path.join(artifact, 'prior-context.json'), { priorCheckpoint: c.PRIOR_NATIVE_CHECKPOINT, priorPrelaunchAggregateStatus: 'FAIL', supplementalReviewerPrelaunchPinned: false,
    localQualification: c.QUALIFICATION, plan: c.PLAN, scope: 'Local design qualification precedes this guided native editing run; zero F04 implementation preapplied. Native24 functional acceptance uses explicit supplemental basis.' });
  const gate = { kind, status: 'REVIEWED_REAL_EVIDENCE', files: campaign.evidenceFiles[kind].map(c.identity), review: report.scope };
  const verified = verifyGate(campaign, kind, gate); write(path.join(directory, 'gates', kind + '.json'), gate);
  console.log(JSON.stringify({ ...verified, report: c.identity(path.join(artifact, 'review.json')) }));
}
module.exports = { NODE, ORACLES, controllerQualification, dependencies, assertApplication, assertF04Api, assertMigrationRecords, assertUI, assertRegressions,
  gateState, invocationSpec, assertScopeRecords, assertInvocationRecords, verifyGate, migrationRecord, executeGate };
if (require.main === module) executeGate(path.resolve(process.argv[2]), process.argv[3]).catch(error => { console.error(error.stack); process.exitCode = 1; });
