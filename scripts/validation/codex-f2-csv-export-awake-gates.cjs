/* Campaign-owned root API/browser gates. Import is read-only; CLI requires an actual waiting native gate. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const c = require('./codex-f2-csv-export-awake-campaign.cjs'), compact = require('./codex-f2-compact-store.cjs');
const repo = path.resolve(__dirname, '../..'), base = path.join(repo, 'out-test/feature-tests/PB-02/overnight-20261011');
const local = path.join(base, 'f06-csv-export-validation'), f04 = path.join(base, 'f04-board-description-validation');
const csv = require(path.join(local, 'f06-csv-evidence.cjs'));
const HANDOFF = Object.freeze({ path: path.join(base, 'f06-native-preparation/local-qualification-handoff.json'), sha256: 'f519d2919c7ddf1d03e57fb530d2803a6242b215a00d6c04efddcc8bfb72d7e2' });
const scope = require(path.join(base, 'f05-signed-webhook-validation/f05-scope.cjs'));
const controllerQualification = { path: path.join(f04, 'process-observer-correction/qualification.json'), sha256: 'ba91d7ba325e6abf43c21d7991c520fa6527e84b298c650eba65090169743ed5' };
const NODE = Object.freeze({ path: '/Users/bahaabunojaim/.npm/_npx/d18f28baf1132559/node_modules/node/bin/node', sha256: '68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b' });
const ORACLES = Object.freeze({ api: path.join(local, 'f06-api-oracle.cjs'), ui: path.join(local, 'f06-ui-layout-observe-oracle.cjs'),
  regressions: path.join(f04, 'all-eight-api-logfile-oracle.cjs'), frontend: path.join(base, 'f2-workload-preparation/oracle/frontend-oracle.cjs'),
  f04: path.join(f04, 'f04-api-logfile-oracle.cjs'), f05: path.join(base, 'f05-bounded-invocation-validation/timed-f05-entry.cjs') });
const read = file => compact.readJson(file), write = (file, data) => compact.writeJson(file, data);
function dependencies() {
  const handoff = c.pinned(HANDOFF); for (const pin of handoff.pins) assert.deepEqual(c.identity(pin.path), pin);
  const q = c.pinned(controllerQualification); assert.equal(q.passedControls, 35); assert.deepEqual(c.identity(q.controller.path), q.controller);
  for (const pin of q.controls) assert.deepEqual(c.identity(pin.path), pin);
  c.candidateProvenance();
  const f05Qualification = { path: path.join(base, 'f05-bounded-invocation-validation/qualification-review.json'), sha256: '444f9794035d02ade98496c4e21910aab7364260bb4726c5033c96fe148a90cb' };
  const f05 = c.pinned(f05Qualification);
  const legacy = require('./codex-f2-board-description-gates.cjs').dependencies();
  const pins = [c.identity(__filename), NODE, HANDOFF, ...handoff.pins, controllerQualification, q.controller, ...q.controls,
    ...Object.values(ORACLES).map(c.identity), ...legacy.pins, f05Qualification,
    ...f05.coreImplementationPins, ...f05.runnerPins, ...f05.controllerPins,
    c.identity(path.join(local, 'f06-api-acceptance.cjs')), c.identity(path.join(local, 'f06-csv-evidence.cjs')),
    c.identity(path.join(local, 'f06-ui-acceptance-layout-observe.cjs')), c.identity(path.join(base, 'f2-api-readiness-validation/api-lifecycle.cjs'))];
  for (const pin of pins) assert.deepEqual(c.identity(pin.path), pin);
  return { pins: require('./pb02-unique-pins.cjs').uniquePins(pins), runner: require(q.controller.path) };
}
function bugSourcePaths() { return [...new Set(c.pinned(c.CASE_CONTRACT).cases.filter(row => row.kind === 'seeded-bug').map(row => row.mutation.path))].sort(); }
function assertApplication(report, campaign) {
  assert.equal(report.workspace, campaign.workspace); assert.equal(report.runtime, path.join(campaign.directory, 'runtime'));
  assert.equal(report.contractSha256, c.CASE_CONTRACT.sha256); assert.equal(report.readiness.status, 'READY');
  assert.deepEqual(report.process.exit, { code: 0, signal: null });
  assert.equal(report.runtimeOwnerSha256, c.identity(path.join(report.runtime, 'database-owner.json')).sha256);
  assert.deepEqual(Object.keys(report.sourceHashes).sort(), bugSourcePaths());
  for (const [relative, sha256] of Object.entries(report.sourceHashes)) assert.equal(sha256, campaign.fixture.files[relative].sha256);
}
function assertF04Api(report, campaign) {
  assertApplication(report, campaign); assert.equal(report.oracleSha256, c.identity(ORACLES.f04).sha256);
  assert.equal(report.status, 'PASS'); assert.deepEqual(report.selectedCaseIds, ['F2-F04']);
  assert.deepEqual(report.cases, [{ id: 'F2-F04', status: 'PASS' }]); assert(report.schemaBeforeCase.includes('description'));
  assert(report.boardReceipts.some(row => row.method === 'PATCH' && row.status === 404));
}
// Quote only large integer tokens outside JSON strings before parsing SQL row text.
// This preserves IDs losslessly; strings, including numeric-looking names, are untouched.
function sqlRow(raw) {
  assert.equal(typeof raw, 'string');
  return JSON.parse(raw.replace(/"(?:[^"\\]|\\.)*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    token => /^-?\d{16,}$/.test(token) ? JSON.stringify(token) : token));
}
function csvRows(report) {
  const f = report.fixture, before = report.sqlSnapshots[0].snapshot, lists = before.tables.list.map(sqlRow), cards = before.tables.card.map(sqlRow), boards = before.tables.board.map(sqlRow);
  assert.deepEqual(Object.keys(before.tables), csv.TABLES); assert.equal(report.sqlSnapshots[0].label, 'before-exports');
  for (const id of [f.targetBoardId, f.emptyBoardId, f.sameProjectBoardId, f.otherProjectBoardId]) assert.match(id, /^\d+$/);
  assert.equal(new Set([f.targetBoardId, f.emptyBoardId, f.sameProjectBoardId, f.otherProjectBoardId]).size, 4);
  const board = id => { const rows = boards.filter(row => String(row.id) === id); assert.equal(rows.length, 1); return rows[0]; };
  const target = board(f.targetBoardId); assert.equal(String(target.project_id), String(board(f.sameProjectBoardId).project_id));
  assert.notEqual(String(target.project_id), String(board(f.otherProjectBoardId).project_id)); board(f.emptyBoardId);
  const member = before.tables.board_membership.map(sqlRow), managers = before.tables.project_manager.map(sqlRow);
  assert(member.some(row => String(row.board_id) === f.targetBoardId && String(row.user_id) === f.viewerId && row.role === 'viewer'));
  assert(managers.some(row => String(row.project_id) === String(target.project_id) && String(row.user_id) === f.managerId));
  assert(!member.some(row => String(row.board_id) === f.targetBoardId && String(row.user_id) === f.managerId));
  assert.equal(f.outsiderIds.length, 2);
  for (const id of f.outsiderIds) { assert(!member.some(row => String(row.board_id) === f.targetBoardId && String(row.user_id) === id)); assert(!managers.some(row => String(row.project_id) === String(target.project_id) && String(row.user_id) === id)); }
  const ownLists = new Map(lists.filter(row => String(row.board_id) === f.targetBoardId).map(row => [String(row.id), row]));
  const ownCards = cards.filter(row => String(row.board_id) === f.targetBoardId && ownLists.has(String(row.list_id)));
  const compareId = (a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
  ownCards.sort((a, b) => { const al = ownLists.get(String(a.list_id)), bl = ownLists.get(String(b.list_id)); return Number(al.position) - Number(bl.position) || compareId(al.id, bl.id) || Number(a.position) - Number(b.position) || compareId(a.id, b.id); });
  assert.equal(ownCards.length, 5); assert.deepEqual(ownCards.map(row => String(row.id)).sort(), [...f.cardIds].sort());
  assert(ownCards.some(row => row.description === null)); assert(ownCards.some(row => row.description === 'CSV "body", next\r\nLF\nCR\rend'));
  assert.equal(f.sentinelCardIds.length, 3);
  for (const id of f.sentinelCardIds) { assert(cards.some(row => String(row.id) === id)); assert(!ownCards.some(row => String(row.id) === id)); }
  assert(!cards.some(row => String(row.board_id) === f.emptyBoardId));
  for (const table of ['task','label','card_label','card_membership']) assert(before.tables[table].length > 0);
  const records = ownCards.map(row => [String(row.id), ownLists.get(String(row.list_id)).name, row.name, row.description]);
  assert.deepEqual(f.expectedRows, records, 'Expected export rows join full SQL evidence without lossy IDs');
  return records;
}
function assertCsvApi(report, campaign, absent, artifact) {
  assert.equal(report.workspace, campaign.workspace); assert.equal(report.runtime, path.join(campaign.directory, 'runtime'));
  assert.deepEqual(report.oracle, c.identity(ORACLES.api)); assert.deepEqual(report.contract, c.CASE_CONTRACT);
  assert.deepEqual(report.runtimeOwner, c.identity(path.join(report.runtime, 'database-owner.json')));
  assert.equal(report.readiness.status, 'READY'); assert.deepEqual(report.process.exit, { code: 0, signal: null });
  assert.deepEqual(report.dependencies, ['f06-api-acceptance.cjs','f06-csv-evidence.cjs'].map(file => c.identity(path.join(local, file))).concat(c.identity(path.join(base,'f2-api-readiness-validation/api-lifecycle.cjs'))));
  assert.equal(report.initialization.code, 0); assert.equal(report.initialization.signal, null); assert.equal(report.initialization.error, null);
  assert.deepEqual(report.selectedCaseIds, ['F2-F06']); assert.equal(report.cases.length, 1); assert.equal(report.cases[0].id, 'F2-F06');
  const sourcePaths = [...bugSourcePaths(), 'server/config/routes.js','server/api/controllers/boards/export-csv.js','server/api/helpers/boards/export-csv.js','server/utils/csv.js'];
  assert.deepEqual(Object.keys(report.sourceHashes).sort(), sourcePaths.sort());
  const expected = c.expectedSnapshotHashes(campaign.fixture, absent ? [] : c.SELECTED);
  for (const relative of sourcePaths) assert.equal(report.sourceHashes[relative], expected[relative] ?? null);
  assert.deepEqual(report.coverage.sqlTables, csv.TABLES); assert.equal(report.coverage.executedLayer, 'API_RAW_CSV_AND_FULL_BUSINESS_SQL_ROWS');
  assert(Number.isFinite(Date.parse(report.startedAt)) && Date.parse(report.finishedAt) >= Date.parse(report.startedAt));
  const records = csvRows(report), names = absent ? ['admin'] : ['admin','viewer','manager','repeat','same-project-outsider','other-project-outsider','unauthenticated','missing-board','empty-board'];
  assert.deepEqual(report.exports.map(row => row.name), names); assert.equal(report.sqlSnapshots.length, names.length + 1);
  const statuses = [200,200,200,200,404,404,401,404,200], before = report.sqlSnapshots[0].snapshot;
  report.exports.forEach((row, index) => {
    const id = row.name === 'empty-board' ? report.fixture.emptyBoardId : row.name === 'missing-board' ? '9223372036854775806' : report.fixture.targetBoardId;
    assert.equal(row.method, 'GET'); assert.equal(row.url, `/api/boards/${id}/export.csv`);
    const file = path.join(artifact, row.name + '.body'); assert.equal(row.bodyFile.path, file); assert.deepEqual(c.identity(file), row.bodyFile);
    const bytes = fs.readFileSync(file); assert.equal(bytes.length, row.bytes); assert.equal(c.hash(bytes), row.sha256); assert.equal(bytes.toString('base64'), row.bodyBase64);
    const snapshot = report.sqlSnapshots[index + 1]; assert.equal(snapshot.label, 'after-' + row.name);
    assert.deepEqual(row.sql, csv.verifyUnchanged(before, snapshot.snapshot));
    if (absent) { assert.equal(row.status, 404); assert.equal(row.acceptance, undefined); }
    else if (statuses[index] === 200) assert.deepEqual(row.acceptance, csv.verifyDownload(row, row.name === 'empty-board' ? [] : records, id));
    else { csv.verifyDenied(row, statuses[index]); assert.deepEqual(row.acceptance, { status: 'PASS_EXPECTED_DENIAL' }); }
  });
  if (absent) { assert.equal(report.status, 'FAIL'); assert.equal(report.cases[0].status, 'FAIL'); assert.equal(report.cases[0].errorType, 'ASSERTION_FAILURE'); assert.equal(report.cases[0].error, 'CSV export returns 200\n\n404 !== 200\n'); assert.deepEqual(report.cases[0].assertion, { actual: 404, expected: 200, operator: 'strictEqual' }); }
  else { assert.equal(report.status, 'PASS'); assert.deepEqual(report.cases, [{ id: 'F2-F06', status: 'PASS' }]); }
}
function assertWrapping(m) {
  for (const value of [m.box.left,m.box.right,m.box.top,m.box.bottom,m.clientWidth,m.scrollWidth,m.contentLeft,m.contentRight,m.parent.left,m.parent.right,m.viewport.width,m.settings.bottom,m.card.top]) assert(Number.isFinite(value));
  assert(m.rects.length > 1 && m.rects.every(r => [r.left,r.right,r.top,r.bottom].every(Number.isFinite)));
  assert.deepEqual(m.lineTops, [...new Set(m.rects.map(r => r.top))]); assert(m.lineTops.length > 1, 'Long text must occupy multiple lines');
  assert(m.scrollWidth <= m.clientWidth + 1); assert(m.rects.every(r => r.left >= m.contentLeft - 1 && r.right <= m.contentRight + 1));
  assert(m.box.left >= m.parent.left - 1 && m.box.right <= m.parent.right + 1);
  assert(m.box.left >= -1 && m.box.right <= m.viewport.width + 1); assert(m.settings.bottom <= m.box.top + 1 && m.box.bottom <= m.card.top + 1);
}
function assertUI(report, campaign, artifact) {
  assertApplication(report, campaign); assert.equal(report.oracleSha256, c.identity(ORACLES.ui).sha256);
  assert.equal(report.status, 'PASS'); assert.deepEqual(report.selectedCaseIds, ['F2-F06-UI','F2-F04-WRAP-UI']);
  assert.deepEqual(report.cases, [{ id: 'F2-F06-UI', status: 'PASS' }, { id: 'F2-F04-WRAP-UI', status: 'PASS' }]); assert.deepEqual(report.browserErrors, []);
  assert.equal(report.uiChecks.length, 1); const ui = report.uiChecks[0]; assert.equal(ui.id, 'F2-F06-UI'); assert.equal(ui.role, 'viewer');
  assert.equal(ui.duplicateSuppressed, true); assert.equal(ui.visible404AndRecovery, true); assert.equal(ui.unauthorizedLogout, true);
  const boardId = /^board-(\d+)\.csv$/.exec(ui.first.filename)?.[1]; assert(boardId); assert.equal(ui.requests.length, 5);
  for (const row of ui.requests) assert.deepEqual(row, { method: 'GET', path: `/api/boards/${boardId}/export.csv`, query: '', hasBearer: true });
  assert.deepEqual(ui.downloads, Array(3).fill(ui.first.filename));
  for (const [key, name] of [['first','F06-viewer-export.csv'],['recovered','F06-recovered-export.csv']]) {
    const item = ui[key], file = path.join(artifact, name); assert.equal(item.file, file); assert.equal(c.identity(file).sha256, item.sha256); assert.equal(fs.statSync(file).size, item.bytes);
    assert.equal(item.filename, ui.first.filename); assert.deepEqual(item.urls.created, item.urls.revoked); assert.equal(new Set(item.urls.created).size, item.urls.created.length); assert.equal(item.urls.created.length, key === 'first' ? 1 : 3);
  }
  const bytes = fs.readFileSync(ui.first.file); assert.deepEqual(bytes, fs.readFileSync(ui.recovered.file)); assert.deepEqual(bytes, fs.readFileSync(path.join(artifact,'F06-pending-export.csv')));
  assert.equal(csv.parseCSV(bytes).length, 2); assert.deepEqual(csv.parseCSV(bytes)[0], csv.HEADER);
  assert.equal(report.layoutChecks.length, 2); assert.deepEqual(report.layoutChecks.map(m => m.viewport), [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]);
  for (const m of report.layoutChecks) assertWrapping(m); assert(Math.abs(report.layoutChecks[0].box.width - 640) <= 1);
  assert.equal(report.wrappingNegative.kind, 'Owned browser style fault injection, not source-build mutant'); assert.equal(report.wrappingNegative.textPreserved, true); assert.equal(report.wrappingNegative.detected, true);
  assert.throws(() => assertWrapping(report.wrappingNegative.measurement));
}
function assertRegressions(api, frontend, feature, campaign) {
  assertApplication(api, campaign); assert.equal(api.oracleSha256, c.identity(ORACLES.regressions).sha256); assert.equal(api.status, 'PASS');
  assert.equal(frontend.workspace, campaign.workspace); assert.equal(frontend.status, 'PASS'); assert.equal(frontend.oracleSha256, c.identity(ORACLES.frontend).sha256);
  assert.deepEqual(Object.keys(frontend.sourceHashes).sort(), ['client/src/components/Card/Tasks.jsx', 'client/src/models/List.js']);
  const cases = [...api.cases, ...frontend.cases]; assert.equal(cases.length, 12); assert(cases.every(row => row.status === 'PASS')); assert.deepEqual(cases.map(row => row.id).sort(), [...c.INITIAL_CASES].sort());
  for (const [relative, sha256] of Object.entries(frontend.sourceHashes)) assert.equal(sha256, campaign.fixture.files[relative].sha256);
  assert.equal(feature.status, 'PASS_F05_SIGNED_WEBHOOKS'); assert.equal(feature.workspace, campaign.workspace); assert.equal(feature.runtime, path.join(campaign.directory, 'runtime'));
  assert.deepEqual(feature.failures, []); assert.deepEqual(feature.receiverErrors, []); assert.deepEqual(feature.process.exit, { code: 0, signal: null });
  assert.equal(feature.events.length, 6); assert.equal(feature.receiver.cleanup.status, 'DRAINED'); assert.equal(feature.receiver.cleanup.forcedConnections, false);
  assert.deepEqual(feature.initialization, { code: 0, signal: null }); assert.equal(feature.caseId, 'F2-F05');
  const f05Qualification = read(path.join(base, 'f05-signed-webhook-validation/qualification-review.json'));
  assert.deepEqual(feature.sourceIdentities, f05Qualification.implementationPins.slice(0, 8).sort((a, b) => a.path.localeCompare(b.path)));
  const receipt = require(path.join(base, 'f05-signed-webhook-validation/f05-receipts.cjs'));
  const logs = feature.finalChecks.checkedLogs.map(pin => { assert.equal(c.identity(pin.path).sha256, pin.sha256); const bytes=fs.readFileSync(pin.path);assert.equal(bytes.length,pin.bytes);return {path:pin.path,bytes}; });
  assert.deepEqual(receipt.verifyFinal(feature.events, feature.fixture, logs), feature.finalChecks); return cases;
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
    : [campaign.workspace, 'f06-' + kind + '-' + name, output, runtime, ...(name === 'api' ? ['F2-F06'] : name === 'f04' ? ['F2-F04'] : name === 'ui' ? ['F2-F06-UI,F2-F04-WRAP-UI'] : [])];
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
  return { status: 'PASS_EXACT_F06_INVOCATION_AND_SOURCE_JOIN', name: row.name };
}
function verifyGate(campaign, kind, gate) {
  const { runner } = dependencies(); assert.equal(gate.kind, kind); assert.equal(gate.status, 'REVIEWED_REAL_EVIDENCE');
  assert.deepEqual(gate.files.map(pin => pin.path), campaign.evidenceFiles[kind]);
  for (const pin of gate.files) assert.deepEqual(c.identity(pin.path), pin);
  const report = read(gate.files[0].path), state = gateState(campaign, kind);
  assert.equal(report.status, 'PASS_ROOT_F06_' + kind.toUpperCase()); assert.equal(report.kind, kind);
  assert.deepEqual(report.campaign, c.identity(path.join(campaign.directory, 'campaign.json')));
  assert.equal(report.workspace, campaign.workspace); assert.equal(report.runtime, path.join(campaign.directory, 'runtime'));
  assert.deepEqual(report.requestBoundary, state.boundary); assert.deepEqual(report.completedPatchIds, state.completed);
  assert(report.startedAt >= state.request.at && report.endedAt >= report.startedAt);
  assert.deepEqual(report.finalBoundary.files.hashes, c.expectedSnapshotHashes(campaign.fixture, state.completed));
  if (kind === 'final') {
    assert.deepEqual(report.reusedGates.map(row => row.kind), ['validation', 'restored']);
    for (const row of report.reusedGates) { assert.equal(row.identity.path,path.join(campaign.directory,'gates',row.kind+'.json')); assert.deepEqual(c.identity(row.identity.path), row.identity); verifyGate(campaign, row.kind, read(row.identity.path)); }
    const restored=read(campaign.evidenceFiles.restored[0]); assert.deepEqual(report.finalBoundary.buildSnapshot,restored.finalBoundary.buildSnapshot); assert.deepEqual(state.request.boundary.buildSnapshot,restored.finalBoundary.buildSnapshot);
    assert.equal(report.executions.length, 0); return { status: report.status, newApplicationLaunches: 0 };
  }
  const names = kind === 'checkpoint' ? ['api', 'regressions', 'frontend', 'f05', 'f04'] : ['api', 'regressions', 'frontend', 'f05', 'f04', 'ui'];
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
    if(row.name==='api'){assert(Date.parse(results.api.startedAt)>=Date.parse(execution.startedAt));assert(Date.parse(results.api.finishedAt)<=Date.parse(execution.finishedAt));}
    if (row.name === 'f05') {
      const feature = results.f05; assert.deepEqual(feature.scope, row.scope); assert.equal(feature.artifact, path.dirname(row.report.path));
      assert.equal(feature.receiver.pid, execution.pid, 'Signed webhook receiver belongs to the invoked oracle');
      for (const boundary of [feature.sourceBoundaryBefore, feature.sourceBoundaryAfter]) {
        for (const key of ['sourceFiles', 'sourceSha256', 'indexSha256', 'documentationSha256', 'dependencyFiles', 'panelIds']) assert.deepEqual(boundary[key], row.sourceBoundaryAfter[key]);
      }
    }
  }
  assertCsvApi(results.api, campaign, kind === 'checkpoint', path.dirname(invocationSpec(campaign,kind,'api').reportFile)); assertRegressions(results.regressions, results.frontend, results.f05, campaign); assertF04Api(results.f04,campaign);
  assert.deepEqual(report.runtimeIdentity, scope.runtimeIdentity(report.runtime));
  if (kind === 'checkpoint') {
    const context = read(gate.files[1].path); assert.deepEqual(context.priorCheckpoint, c.PRIOR_NATIVE_CHECKPOINT); assert.deepEqual(context.localQualification,c.QUALIFICATION); assert.deepEqual(context.plan,c.PLAN);
    assert.equal(context.priorPrelaunchAggregateStatus,'FAIL'); assert.equal(context.supplementalReviewerPrelaunchPinned,false);
  } else {
    const uiArtifact = path.dirname(invocationSpec(campaign,kind,'ui').reportFile); assertUI(results.ui, campaign, uiArtifact);
    assert.deepEqual(report.screenshots.map(pin => pin.path), ['F06-viewer-export.png','F04-long-description-1440.png','F04-long-description-390.png'].map(name => path.join(uiArtifact,name)));
    for (const pin of report.screenshots) assert.deepEqual(c.identity(pin.path),pin);
    assert.equal(report.nativeBuild.path,path.join(campaign.directory,'segment-1/window-A/reply-'+c.BUILD_ORDINAL+'.json'));
    const native = read(report.nativeBuild.path); assert.deepEqual(c.identity(report.nativeBuild.path), report.nativeBuild);
    assert.equal(native.ordinal, c.BUILD_ORDINAL); assert(native.afterBoundary.buildSnapshot);
    assert.deepEqual(report.finalBoundary.buildSnapshot, native.afterBoundary.buildSnapshot, 'Root API/browser gates never rebuild native assets');
    assert.deepEqual(state.request.boundary.buildSnapshot, native.afterBoundary.buildSnapshot);
  }
  return { status: report.status, bugCases: 12, f05RawReceipts: 6, f04Present: true, csvPresent: kind !== 'checkpoint', csvRequests: kind === 'checkpoint' ? 1 : 9, sqlTables: 15, noNewMigrationCredit: true };
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
    const api = await run('api', kind === 'checkpoint' ? 1 : 0); assertCsvApi(api, campaign, kind === 'checkpoint', path.dirname(invocationSpec(campaign,kind,'api').reportFile));
    const regression = await run('regressions'), frontend = await run('frontend'), f05 = await run('f05'); assertRegressions(regression, frontend, f05, campaign);
    assertF04Api(await run('f04'),campaign);
    if (kind !== 'checkpoint') {
      const ui = await run('ui'), uiArtifact=path.dirname(invocationSpec(campaign,kind,'ui').reportFile); assertUI(ui,campaign,uiArtifact);
      report.screenshots=['F06-viewer-export.png','F04-long-description-1440.png','F04-long-description-390.png'].map(name=>c.identity(path.join(uiArtifact,name)));
      report.nativeBuild = c.identity(path.join(directory, 'segment-1/window-A/reply-' + c.BUILD_ORDINAL + '.json'));
    }
  }

  report.finalBoundary = c.verifyBoundary(campaign.fixture, state.completed, state.panelIds);
  report.status = 'PASS_ROOT_F06_' + kind.toUpperCase(); report.endedAt = Date.now();
  report.scope = 'Root-run CSV API and viewer UI plus wide/narrow F04 wrapping on exact native assets. Preserves twelve repairs,F05,F04. Fifteen business-table snapshots exclude auth/session/sequences/transient writes; UI401/404 are injected client controls. No new migration, database restart, exhaustive mobile/accessibility or endurance credit.';
  write(path.join(artifact, 'review.json'), report);
  if (kind === 'checkpoint') write(path.join(artifact, 'prior-context.json'), { priorCheckpoint: c.PRIOR_NATIVE_CHECKPOINT, priorPrelaunchAggregateStatus: 'FAIL', supplementalReviewerPrelaunchPinned: false,
    localQualification: c.QUALIFICATION, plan: c.PLAN, scope: 'Final candidate-v3 qualification precedes ten guided native file approvals; no CSV implementation or responsive-description correction preapplied. Native25 retains original strict FAIL and explicit postrun supplemental functional basis. Earlier local serializer lint and narrow UI failures remain historical, not erased.' });
  const gate = { kind, status: 'REVIEWED_REAL_EVIDENCE', files: campaign.evidenceFiles[kind].map(c.identity), review: report.scope };
  const verified = verifyGate(campaign, kind, gate); write(path.join(directory, 'gates', kind + '.json'), gate);
  console.log(JSON.stringify({ ...verified, report: c.identity(path.join(artifact, 'review.json')) }));
}
module.exports = { NODE, ORACLES, HANDOFF, controllerQualification, dependencies, assertApplication, assertF04Api, sqlRow, csvRows, assertCsvApi, assertWrapping, assertUI, assertRegressions,
  gateState, invocationSpec, assertScopeRecords, assertInvocationRecords, verifyGate, executeGate };
if (require.main === module) executeGate(path.resolve(process.argv[2]), process.argv[3]).catch(error => { console.error(error.stack); process.exitCode = 1; });
