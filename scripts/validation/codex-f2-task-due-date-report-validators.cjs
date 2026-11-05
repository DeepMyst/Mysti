'use strict';
// Native-envelope adapters of frozen local API-v5 and UI-v4 report assertions.
// Importing this module never launches a driver, application, browser or database.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const c = require('./codex-f2-task-due-date-campaign.cjs'), compact = require('./codex-f2-compact-store.cjs');
const base = path.resolve(__dirname, '../../out-test/feature-tests/PB-02/overnight-20261011');
const local = path.join(base, 'f02-due-date-validation'), NP = path.join(base, 'f02-native-preparation');
const UI = path.join(NP, 'oracles'), API = path.join(UI, 'f02-api-oracle.cjs');
const csv = require(path.join(base, 'f06-csv-export-validation/f06-csv-evidence.cjs'));
const { CORE_IDS } = require(path.join(local, 'run-ui.cjs'));
const read = file => compact.readJson(file);
function pin(file, sha256) { c.contained(path.resolve(base, '..'), file); assert.equal(fs.realpathSync(file), file); const s=fs.lstatSync(file); assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()); const p=c.identity(file); if(sha256!==undefined)assert.equal(p.sha256,sha256);return p; }
function checkPins(pins) { for(const p of pins) assert.deepEqual(pin(p.path,p.sha256),p); }
const RECOVERY_IDS = ['set-failure-restores-confirmed-and-retries', 'clear-failure-restores-confirmed-and-retries'];
const FAILURE_TEXT = 'Could not confirm the task due date. The last confirmed date is shown. You can retry.';
function coreIds(vectors) {
  return [...vectors.valid.map(v => 'create-' + v.id), 'create-omitted', 'create-null',
    ...vectors.valid.map(v => 'update-' + v.id), 'rename-omits-date', 'complete-omits-date', 'reorder-omits-date',
    'clear-preserves-completion', 'due-date-update-preserves-completion',
    ...vectors.invalid.flatMap(v => ['invalid-create-' + v.id, 'invalid-update-' + v.id]),
    ...['viewer', 'outsider', 'unauthenticated'].flatMap(role => [role + '-create', role + '-update']),
    'editor-foreign-task', 'missing-task', 'missing-card', 'viewer-reloads-due-date'];
}
function assertApi(r, state, artifact) {
  assert.equal(r.status, 'CORE_AND_PROFILE_PASS'); assert.deepEqual(r.cases, [{ id: 'F2-F02', status: 'CORE_AND_PROFILE_PASS' }]);
  assert.deepEqual(r.selectedCaseIds, ['F2-F02']); assert.equal(r.workspace, state.workspace); assert.equal(r.runtime, state.runtime);
  assert.equal(r.label, state.label);
  assert.deepEqual(r.oracle, pin(API));
  const dependencies = ['f02-api-acceptance.cjs', 'f02-api-vectors.cjs', 'f02-task-mutation-guard.cjs', 'f02-forensic-snapshot.cjs', 'f02-profile-acceptance.cjs', 'f02-profile-fixture-position.cjs'].map(name => pin(path.join(local, 'oracle-v5', name)));
  dependencies.push(pin(path.join(base, 'f06-csv-export-validation/f06-csv-evidence.cjs')), pin(path.join(base, 'f2-api-readiness-validation/api-lifecycle.cjs')));
  assert.deepEqual(r.dependencies, [pin(path.join(NP, 'oracles/native-paths.cjs')), ...dependencies]);
  const contractPin = pin(path.join(base, 'f2-workload-preparation/contracts/case-contracts.json'));
  assert.deepEqual(r.contract, contractPin); assert.deepEqual(r.runtimeOwner, pin(path.join(state.runtime, 'database-owner.json')));
  assert.equal(r.readiness.status, 'READY'); assert.deepEqual(r.process.exit, { code: 0, signal: null });
  assert.deepEqual(r.initialization, { code: 0, signal: null, error: null });
  assert.equal(r.featureAcceptanceClaimed, false); assert.deepEqual(r.applicationEnvironment, { TZ: 'UTC' });
  const vectors = require(path.join(local, 'oracle-v5/f02-api-vectors.cjs')), profile = require(path.join(local, 'oracle-v5/f02-profile-acceptance.cjs'));
  const ids = coreIds(vectors); assert.equal(ids.length, 61); assert.equal(new Set(ids).size, 61);
  assert.equal(r.coreStatus, 'PASS_REQUIRED_CORE_CASES'); assert.equal(r.coreCaseCount, 61);
  assert.deepEqual(r.coreCases.map(row => row.id), ids); assert(r.coreCases.every(row => row.status === 'PASS'));
  assert.equal(r.profileCases.length, 26); assert.equal(r.profile.status, 'PASS_PREDECLARED_UTC_PROFILE');
  assert.equal(r.profile.decisionsApproved, true); assert.equal(r.profile.appTimezone, 'UTC');
  assert(Array.isArray(r.profile.timezone) && r.profile.timezone.length === 1 && typeof r.profile.timezone[0].TimeZone === 'string');
  assert.deepEqual(profile.assertResults(r.profileCases), { status: 'PASS_PREDECLARED_UTC_PROFILE_CASES', count: 26, accepted: 16, rejected: 10 });
  assert.deepEqual(r.profile.result, profile.assertResults(r.profileCases));
  const fixturePosition = require(path.join(local, 'oracle-v5/f02-profile-fixture-position.cjs'));
  const target = r.coreCases.find(row => row.id === 'create-' + vectors.valid.at(-1).id);
  const positionPlan = fixturePosition.assertRecord(r.profileFixturePosition, {
    cardId: r.fixture.cardId, targetId: target.expectedState.id, siblingTaskId: r.fixture.siblingTaskId,
  });
  const profileCreates = r.profileCases.filter(row => row.expectedState && row.id.startsWith('profile-create-'));
  assert.equal(profileCreates.length, 8); assert.equal(profileCreates[0].expectedState.position, positionPlan.nextPosition);
  for (let i = 0; i < profileCreates.length; i++) {
    assert.equal(profileCreates[i].expectedState.position, positionPlan.nextPosition + i * fixturePosition.STRIDE);
    assert.deepEqual(r.requests[profileCreates[i].mutationRequestIndex - 1].request.position, profileCreates[i].expectedState.position);
  }
  const catalog = read(contractPin.path), bugPaths = catalog.cases.filter(row => row.kind === 'seeded-bug').map(row => row.mutation.path);
  const sourcePaths = [...new Set([...bugPaths, 'server/config/routes.js', 'server/api/models/Task.js', 'server/api/controllers/tasks/create.js',
    'server/api/controllers/tasks/update.js', 'server/api/helpers/tasks/create-one.js', 'server/api/helpers/tasks/update-one.js', 'server/db/migrations/20261012000200_add_task_due_date.js'])].sort();
  assert.deepEqual(Object.keys(r.sourceHashes).sort(), sourcePaths);
  for (const relative of sourcePaths) { assert.equal(r.sourceHashes[relative], state.expected[relative]); pin(path.join(state.workspace, relative), state.expected[relative]); }
  const sql = csv;
  assert.deepEqual(r.coverage.tables, sql.TABLES);
  assert(r.sqlSnapshots.length > 0); assert.equal(new Set(r.sqlSnapshots.map(row => row.path)).size, r.sqlSnapshots.length);
  r.sqlSnapshots.forEach((row, index) => {
    assert.equal(row.path, path.join(artifact, `sql-${String(index + 1).padStart(3, '0')}.json`)); pin(row.path, row.sha256);
    assert.equal(row.tables, 15); const snapshot = read(row.path);
    assert.equal(snapshot.format, 'POSTGRES_ROW_TO_JSON_TEXT_FULL_ROWS_ORDERED_BY_ID'); assert.deepEqual(Object.keys(snapshot.tables), sql.TABLES);
    for (const table of sql.TABLES) assert(snapshot.tables[table].every(value => typeof value === 'string'));
  });
  r.requests.forEach((row, index) => {
    assert.equal(row.error, undefined); assert.equal(row.body.path, path.join(artifact, `http-${String(index + 1).padStart(3, '0')}.body`)); pin(row.body.path, row.body.sha256);
    const bytes = fs.readFileSync(row.body.path); assert.equal(bytes.length, row.bytes);
    let parsed; try { parsed = JSON.parse(bytes.toString('utf8')); } catch { parsed = bytes.toString('utf8'); } assert.deepEqual(parsed, row.response);
  });
  assert.equal(r.denialForensics.length, 51);
  for (const row of r.denialForensics) {
    assert.equal(row.snapshotStatus, 'COMPLETE'); assert.equal(row.budgetMs, 15000); assert.equal(row.deadlineExceeded, false);
    assert.equal(row.requestError, null); assert.equal(row.snapshotError, null); assert.equal(row.comparisonError, null);
    assert.equal(row.noWrite.status, 'PASS_NO_OBSERVED_BUSINESS_TABLE_WRITES'); assert.equal(row.noWrite.tables, 15);
  }
  checkPins(state.pins || []);
  assertDeniedSql(r, artifact);
  return { report: pin(path.join(artifact, 'result.json')), status: r.status, requiredCoreCases: 61, profileCases: 26,
    acceptedProfileCases: 16, rejectedProfileCases: 10, profileFixturePosition: positionPlan, deniedForensics: 51, requests: r.requests.length, sqlSnapshots: r.sqlSnapshots.length,
    applicationTimezone: 'UTC', databaseTimezone: r.profile.timezone, featureAcceptanceClaimed: false,
    scope: 'Actual HTTP/SQL core and predeclared UTC date profile only. Migration, browser, database restart and retained-feature regressions remain separate; no native/editor acceptance.' };
}
function assertRecovery(r) {
  assert.deepEqual(r.uiRecoveryChecks.map(row => row.id), RECOVERY_IDS); assert.deepEqual(r.uiDiagnostics, []);
  assert.equal(r.failureInstrumentation.length, 1); const state = r.failureInstrumentation[0].evidence;
  assert.equal(r.failureInstrumentation[0].mode, 'CONTROLLED_SOCKET_ROUTE'); assert.deepEqual(state.errors, []);
  assert.equal(state.injections.length, 2); assert.equal(state.taskPatches.length, 2);
  const expected = ['2034-05-06T07:08:09.321Z', null], confirmed = ['2030-01-02T03:04:05.123', '2034-05-06T07:08:09.321'];
  for (let i = 0; i < 2; i++) {
    const row = r.uiRecoveryChecks[i], injection = row.failure.injection, request = row.retry.request;
    assert.equal(row.status, 'PASS_CONTROLLED_FAILURE_AND_REAL_RETRY'); assert.equal(row.zone, 'UTC'); assert.equal(row.tables, 15);
    assert.equal(row.parentAndSiblingCompleteRowsPreserved, true); assert.equal(row.expected.dueDate, expected[i]);
    assert.equal(row.exactTaskId, row.expected.id); assert.match(row.exactTaskId, /^\d+$/);
    assert.deepEqual(injection, state.injections[i]); assert.equal(injection.taskId, row.exactTaskId);
    assert.deepEqual(injection.request, { dueDate: expected[i] }); assert.equal(injection.status, 503);
    assert.equal(injection.forwardedToServer, false); assert.equal(injection.hasBearer, true);
    assert(Number.isSafeInteger(injection.sentAt) && injection.sentAt >= injection.at);
    assert.equal(row.failure.sql.status, 'PASS_NO_OBSERVED_BUSINESS_TABLE_WRITES'); assert.equal(row.failure.sql.tables, 15);
    assert.deepEqual(row.failure.observed.alerts, [FAILURE_TEXT]); assert.equal(row.failure.observed.value, confirmed[i]);
    assert.equal(row.failure.observed.retryEnabled, true); assert.equal(row.failure.observed.saveDisabled, true);
    assert.deepEqual(request, state.taskPatches[i]); assert.equal(request.path, '/api/tasks/' + row.exactTaskId);
    assert.equal(request.method, 'PATCH'); assert.equal(request.hasBearer, true); assert.equal(request.forwardedToServer, true);
    assert.deepEqual(request.request, { dueDate: expected[i] }); assert.equal(request.response.kind, 'REAL_SERVER_FRAME');
    assert.equal(request.response.status, 200); assert(request.at >= injection.sentAt && request.response.at >= request.at);
    assert.equal(request.response.body.item.dueDate, expected[i]);
    require(path.join(local, 'oracle-v2/f02-task-mutation-guard.cjs')).assertWireFields(request.response.body.item, row.expected);
    assert.equal(row.retry.visibleErrorCleared, true); assert.equal(row.retry.retryControlCleared, true);
    assert.equal(row.reload.expectedLocal, expected[i] === null ? '' : expected[i].slice(0, -1));
    for (const event of [injection, request]) {
      const matches = state.connections.filter(c => c.id === event.connectionId); assert.equal(matches.length, 1); const c = matches[0];
      assert(c.openedAt <= event.at); assert(c.serverFrames > 0);
      assert(c.upgradedAt && c.upgradedAt <= event.at || c.engineOpenAt && c.socketConnectedAt && c.engineOpenAt <= c.socketConnectedAt && c.socketConnectedAt <= event.at);
      for (const field of ['clientClosedAt', 'serverClosedAt', 'engineClosedAt']) assert(c[field] === null || c[field] >= event.at);
    }
  }
  return { status: 'PASS_CONTROLLED_SET_CLEAR_FAILURE_AND_REAL_RETRY', count: 2, arbitraryFailureRecoveryClaimed: false };
}
function assertUi(r, input, artifact) {
  assert.equal(r.workspace, input.workspace); assert.equal(r.runtime, input.runtime); assert.equal(r.label, input.label);
  assert.equal(r.status, 'CORE_AND_RECOVERY_PASS'); assert.equal(r.featureAcceptanceClaimed, false);
  assert.deepEqual(r.selectedCaseIds, ['F2-F02-UI']); assert.deepEqual(r.cases, [{ id: 'F2-F02-UI', status: 'CORE_AND_RECOVERY_PASS' }]);
  assert.equal(r.readiness.status, 'READY'); assert.deepEqual(r.process.exit, { code: 0, signal: null });
  assert.equal(r.browserClosed, true); assert.deepEqual(r.browserErrors, []); assert.deepEqual(r.browserCleanupErrors || [], []);
  assert.deepEqual(r.uiChecks.map(row => row.id), CORE_IDS); assert(r.uiChecks.every(row => row.status === 'PASS'));
  const recovery = assertRecovery(r), sql = csv;
  for (const p of [...r.sqlSnapshots, ...r.screenshots]) { assert.equal(path.dirname(p.path), artifact); pin(p.path, p.sha256); }
  for (const row of r.uiRecoveryChecks) {
    for (const p of [row.failure.before,row.failure.after,row.retry.before,row.retry.after,row.reload.before,row.reload.after]) {
      assert(r.sqlSnapshots.some(value => value.path === p.path && value.sha256 === p.sha256));
    }
    assert.deepEqual(sql.verifyUnchanged(read(row.failure.before.path),read(row.failure.after.path)),row.failure.sql);
    sql.verifyUnchanged(read(row.reload.before.path),read(row.reload.after.path));
  }
  assert.deepEqual(r.oracle, pin(path.join(UI, 'f02-ui-oracle.cjs')));
  assert.deepEqual(r.dependencies, ['./native-paths.cjs','../../f02-due-date-validation/ui-v3/f02-ui-acceptance.cjs','../../f02-due-date-validation/ui-v3/f02-ui-wire.cjs','../../f02-due-date-validation/oracle-v2/f02-task-mutation-guard.cjs','../../f06-csv-export-validation/f06-csv-evidence.cjs','../../f2-api-readiness-validation/api-lifecycle.cjs'].map(relative => pin(path.resolve(UI, relative))));
  assertUiSql(r, artifact);
  return { report: pin(path.join(artifact, 'result.json')), status: r.status, coreChecks: 7, recovery,
    featureAcceptanceClaimed: false, limits: ['Two controlled503 cases followed by actual server retries only. No held-ACK pending-state/concurrent-update/arbitrary transport recovery coverage.', 'Separate API, migration/restart and retained-feature regressions remain required; no native/editor acceptance.'] };
}

function snapshotPin(r, p, artifact) {
  assert.equal(path.dirname(p.path), artifact); assert(r.sqlSnapshots.some(x=>x.path===p.path&&x.sha256===p.sha256));
  pin(p.path,p.sha256); return read(p.path);
}
function assertDeniedSql(r, artifact) {
  for(const row of [...r.coreCases,...r.profileCases]) if(row.sql) {
    const before=snapshotPin(r,row.before,artifact),after=snapshotPin(r,row.after,artifact);
    assert.deepEqual(csv.verifyUnchanged(before,after),row.sql);
    assert.equal(r.requests[row.requestIndex-1].status,row.expectedStatus);
  }
  for(const row of r.denialForensics) assert.deepEqual(csv.verifyUnchanged(snapshotPin(r,row.before,artifact),snapshotPin(r,row.after,artifact)),row.noWrite);
}
function sqlRow(raw) {
  return JSON.parse(raw.replace(/"(?:[^"\\]|\\.)*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token=>/^-?\d{16,}$/.test(token)?JSON.stringify(token):token));
}
function assertOnlyTaskDateChanged(before, after, expected) {
  assert.deepEqual(Object.keys(before.tables),csv.TABLES); assert.deepEqual(Object.keys(after.tables),csv.TABLES);
  const find=snapshot=>{const matches=snapshot.tables.task.map(raw=>({raw,row:sqlRow(raw)})).filter(x=>String(x.row.id)===expected.id);assert.equal(matches.length,1);return matches[0];};
  const old=find(before),next=find(after);
  const without=(snapshot,selected)=>({...snapshot,tables:{...snapshot.tables,task:snapshot.tables.task.filter(raw=>raw!==selected.raw)}});
  csv.verifyUnchanged(without(before,old),without(after,next));
  const preserved=row=>Object.fromEntries(Object.entries(row).filter(([key])=>!['due_date','updated_at'].includes(key)));
  assert.deepEqual(preserved(next.row),preserved(old.row));
  assert.equal(String(next.row.id),expected.id);assert.equal(String(next.row.card_id),expected.cardId);
  assert.equal(next.row.name,expected.name);assert.equal(next.row.is_completed,expected.isCompleted);assert.equal(next.row.position,expected.position);
  if(next.row.due_date!==null) {
    assert.equal(typeof next.row.due_date,'string');
    const fraction=/\.(\d+)(?:Z|[+-]\d{2}(?::?\d{2})?)$/.exec(next.row.due_date);
    if(fraction)assert(/^0*$/.test(fraction[1].slice(3)),'SQL dueDate cannot hide nonzero submillisecond digits');
  }
  assert.equal(next.row.due_date===null?null:new Date(next.row.due_date).toISOString(),expected.dueDate);
}
function assertUiSql(r, artifact) {
  for(const row of r.uiChecks) {
    if(row.socketRequest) {assert.equal(row.socketRequest.response.status,200);assertOnlyTaskDateChanged(snapshotPin(r,row.before,artifact),snapshotPin(r,row.after,artifact),row.expected);}
    else if(row.before&&row.after) csv.verifyUnchanged(snapshotPin(r,row.before,artifact),snapshotPin(r,row.after,artifact));
    if(row.reload?.before&&row.reload?.after) csv.verifyUnchanged(snapshotPin(r,row.reload.before,artifact),snapshotPin(r,row.reload.after,artifact));
  }
  for(const row of r.uiRecoveryChecks) assertOnlyTaskDateChanged(snapshotPin(r,row.retry.before,artifact),snapshotPin(r,row.retry.after,artifact),row.expected);
}
module.exports={API,UI,NP,local,base,pin,checkPins,coreIds,assertApi,assertRecovery,assertUi,assertDeniedSql,assertOnlyTaskDateChanged,assertUiSql,sqlRow};
