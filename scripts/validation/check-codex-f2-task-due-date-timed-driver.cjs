'use strict';
// Pure qualification of extracted new-driver predicates, never the driver entrypoint.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), ts = require('typescript');
const repo = path.resolve(__dirname, '../..'), root = fs.realpathSync(path.join(repo, 'out-test/feature-tests/PB-02'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const identity = file => ({ path: fs.realpathSync(file), sha256: hash(fs.readFileSync(file)) });
const pins = [
  ['tests-vscode/codex-f2-task-due-date-timed.test.ts', 'a29cca2edcb1cd87078a325797d59f61b322c8088b9882224bd10bdbeb2ea6d9'],
  ['tests-vscode/codex-f2-task-due-date-timed-observer.ts', 'bfd156553ef0c491bb6756ccf73a63994d6ea48b9665ebd4dd306f0fc7140c39'],
].map(([relative, sha256]) => ({ path: path.join(repo, relative), sha256 }));
const priorPins = [
  ['tests-vscode/codex-f2-csv-export-sequential.test.ts', '1517dd6244730028cc62ae0b7f631a0b584d3982f74a676292351c5919759309'],
  ['tests-vscode/codex-f2-csv-export-sequential-observer.ts', '7f5ca4c7a4e05da7d8fd77f2cfd719d23eb654ac3d8cbc6d4cf6051d047af00e'],
].map(([relative, sha256]) => ({ path: path.join(repo, relative), sha256 }));
const directory = fs.mkdtempSync(path.join(root, 'f2-task-due-date-timed-driver-controls-'));
const reportPath = path.join(directory, 'checks.json'), checks = [];
const dependencies = [__filename, require.resolve('typescript'), path.join(repo, 'scripts/validation/codex-f2-test-proof.cjs'),
  path.join(repo, 'scripts/validation/codex-f2-campaign.cjs'), path.join(repo, 'scripts/validation/codex-continuation-contract.cjs'),
  path.join(repo, 'scripts/validation/codex-stage-oracle.cjs'), path.join(repo, 'scripts/validation/ordinary-profile-runner.cjs')].map(identity);
const report = { schemaVersion: 1, status: 'RUNNING', directory, checks, pins, priorPins, dependencies, startedAt: new Date().toISOString(),
  qualification: 'STATIC_AND_ISOLATED_DRIVER_PREDICATES_ONLY', nativeLaunches: 0, editorLaunches: 0, modelRequests: 0,
  priorCheckerFinding: 'The earlier ephemeral checker used cross-VM objects in deepStrictEqual and failed on realm prototypes. This checker evaluates extracted functions in the same JavaScript realm. No driver change was needed for that checker-only failure.',
  limits: ['Only extracted functions from the new driver are transpiled in memory; no frozen tests are compiled.',
    'The whole driver, application, preparation, editor and model are never invoked.',
    'Mocked controls provide no native F02 feature, restart or session acceptance credit.'] };
function check(name, fn) {
  try { fn(); checks.push({ name, status: 'PASS' }); }
  catch (error) { checks.push({ name, status: 'FAIL', error: error.message }); throw error; }
}
async function checkAsync(name, fn) {
  try { await fn(); checks.push({ name, status: 'PASS' }); }
  catch (error) { checks.push({ name, status: 'FAIL', error: error.message }); throw error; }
}
async function main() {
  for (const pin of [...pins, ...priorPins]) assert.deepEqual(identity(pin.path), pin);
  const runnerSource = ts.createSourceFile('ordinary-profile-runner.cjs', fs.readFileSync(path.join(repo, 'scripts/validation/ordinary-profile-runner.cjs'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const reservations = [];
  function reservation(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(runnerSource) === 'maxTextAuxiliaryInputs') reservations.push(node.initializer.getText(runnerSource));
    ts.forEachChild(node, reservation);
  }
  reservation(runnerSource); assert.deepEqual(reservations, ['manifest.auxiliary.maxInputs']);
  const reserved = new Function('manifest', 'return ' + reservations[0])({ auxiliary: { maxInputs: 48 } });
  assert.equal(reserved, 48);
  report.auxiliaryReservationProbe = { status: 'PASS', actualRunnerExpression: reservations[0], suppliedManifestCap: 48, reservedCap: reserved,
    limit: 'Pure evaluation of the existing reservation expression; no runner, launch reservation or editor was invoked.' };
  const source = fs.readFileSync(pins[0].path, 'utf8');
  const parsed = ts.createSourceFile(pins[0].path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const observer = ts.createSourceFile(pins[1].path, fs.readFileSync(pins[1].path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = {};
  function visit(node) { if (ts.isFunctionDeclaration(node) && node.name) declarations[node.name.text] = node.getText(parsed); ts.forEachChild(node, visit); }
  visit(parsed);
  const exactCommand = require('./codex-f2-test-proof.cjs').exactCommand;
  function attach(context, name) {
    assert.equal(typeof declarations[name], 'string');
    const compiled = ts.transpileModule(declarations[name], { compilerOptions: { target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
    assert.equal((compiled.diagnostics || []).length, 0);
    context[name] = new Function(...Object.keys(context), compiled.outputText + '; return ' + name + ';')(...Object.values(context));
    return context;
  }
  function context(rows) { return attach({ assert, contract: { hash, exactCommand }, receipts: () => rows }, 'assertUniqueNativeAttempts'); }
  const command = "cat 'server/example.js'", step = { ordinal: 2, marker: 'F2F02_02', patch: 'F2-F02_P01' };
  const row = (input, id = 'one', event = 'tool-start', type = 'commandExecution') => ({ inputIndex: 2, event, itemIdHash: id, type, commandSha256: hash(JSON.stringify(input)), ownedCwd: true });
  check('new TypeScript source and observer parse', () => assert.equal(parsed.parseDiagnostics.length + observer.parseDiagnostics.length, 0));
  check('one direct command, repeated start notification, one result', () => context([row(command), row(command), row(command, 'one', 'tool-result')]).assertUniqueNativeAttempts(step, [command]));
  check('all existing shell array and quoted wrapper forms remain accepted', () => {
    for (const shell of ['/bin/zsh', '/bin/bash', '/bin/sh']) for (const flag of ['-c', '-lc']) {
      const variants = [[shell, flag, command], `${shell} ${flag} '${command}'`, `${shell} ${flag} "${command}"`,
        `${shell} ${flag} '${command.replace(/'/g, "'\\''")}'`, `${shell} ${flag} '${command.replace(/'/g, `'"'"'`)}'`];
      for (const value of variants) { assert(exactCommand(value, command)); context([row(value)]).assertUniqueNativeAttempts(step, [command]); }
    }
  });
  check('a new native item retry of the same command fails', () => assert.throws(() => context([row(command), row(command, 'two')]).assertUniqueNativeAttempts(step, [command])));
  check('a retry using a different accepted wrapper fails', () => assert.throws(() => context([row(command), row(['/bin/zsh', '-lc', command], 'two')]).assertUniqueNativeAttempts(step, [command])));
  check('unrequested command fails', () => assert.throws(() => context([row('cat external')]).assertUniqueNativeAttempts(step, [command])));
  check('foreign command cwd fails', () => assert.throws(() => context([{ ...row(command), ownedCwd: false }]).assertUniqueNativeAttempts(step, [command])));
  check('duplicate result fails', () => assert.throws(() => context([row(command, 'one', 'tool-result'), row(command, 'one', 'tool-result')]).assertUniqueNativeAttempts(step, [command])));
  check('one patch tool item may have start and result', () => context([row('', 'one', 'tool-start', 'fileChange'), row('', 'one', 'tool-result', 'fileChange')]).assertUniqueNativeAttempts(step, [command]));
  check('second patch tool item fails', () => assert.throws(() => context([row('', 'one', 'tool-start', 'fileChange'), row('', 'two', 'tool-start', 'fileChange')]).assertUniqueNativeAttempts(step, [command])));
  check('unrequested patch fails', () => assert.throws(() => context([row('', 'one', 'tool-start', 'fileChange')]).assertUniqueNativeAttempts({ ...step, patch: undefined }, [command])));
  function applied(kind, resultKind = kind, results = 1) {
    const diff = '+x\n', observations = [{ event: 'permission-decision', marker: step.marker, name: 'edit', approved: true, input: { changes: [{ diff }] } }];
    return attach({ assert, path, contract: { hash, identity: () => ({ sha256: 'after' }) }, owner: { workspace: '/fixture' },
      manifest: { fixture: { repairs: { 'F2-F02_P01': { path: 'file.js', kind, afterSha256: 'after' } } } }, observations, completedCases: [],
      receipts: () => Array.from({ length: results }, () => ({ event: 'tool-result', inputIndex: 2, type: 'fileChange', status: 'completed', changes: [{ relativePath: 'file.js', kind: resultKind, diffSha256: hash(diff) }] })),
      record: (event, details) => observations.push({ event, ...details }) }, 'observeAppliedPatch');
  }
  check('update receipt retains update kind', () => { const c = applied('update'); c.observeAppliedPatch(step); assert.deepEqual(c.completedCases, ['F2-F02_P01']); });
  check('new-file receipt accepts add kind', () => { const c = applied('add'); c.observeAppliedPatch(step); assert.deepEqual(c.completedCases, ['F2-F02_P01']); });
  check('polling applied patch does not duplicate completion', () => { const c = applied('add'); c.observeAppliedPatch(step); c.observeAppliedPatch(step); assert.equal(c.completedCases.length, 1); });
  check('add receipt mislabeled as update fails', () => assert.throws(() => applied('add', 'update').observeAppliedPatch(step)));
  check('duplicate completed patch results fail', () => assert.throws(() => applied('add', 'add', 2).observeAppliedPatch(step)));
  function approvalContext(cards, patch = false) {
    const observations = [], clicks = [];
    const context = attach({ assert, contract: { exactCommand, patchScope: () => patch }, owner: { workspace: '/fixture' }, manifest: { fixture: {} }, observations,
      completedCases: [], decisions: new Set(), events: async () => cards, assertUniqueNativeAttempts: () => {}, observeAppliedPatch: () => {}, files: () => ({ snapshot: true }),
      frame: { locator: selector => ({ click: async () => clicks.push(selector) }) }, record: (event, details) => observations.push({ event, ...details }) }, 'permissions');
    return { context, clicks, observations };
  }
  const card = (id, input, name = 'bash') => ({ type: 'permissionRequest', payload: { id, details: { toolName: name, toolInput: input } } });
  await checkAsync('duplicate shell-wrapper approval is denied before second approval', async () => {
    const cards = [card('first', { cwd: '/fixture', command })], a = approvalContext(cards);
    await a.context.permissions(0, step, [command]); cards.push(card('second', { cwd: '/fixture', command: ['/bin/zsh', '-lc', command] }));
    await assert.rejects(a.context.permissions(0, step, [command])); assert.equal(a.clicks.length, 2); assert(a.clicks[0].includes('approve')); assert(a.clicks[1].includes('deny'));
  });
  await checkAsync('duplicate patch approval is denied before second approval', async () => {
    const cards = [card('first', { changes: [{ path: 'file.js' }] }, 'edit')], a = approvalContext(cards, true);
    await a.context.permissions(0, step, []); cards.push(card('second', { changes: [{ path: 'file.js' }] }, 'edit'));
    await assert.rejects(a.context.permissions(0, step, [])); assert(a.clicks[1].includes('deny'));
  });
  await checkAsync('duplicate approval card ID fails before any click', async () => {
    const cards = [card('same', { cwd: '/fixture', command }), card('same', { cwd: '/fixture', command })], a = approvalContext(cards);
    await assert.rejects(a.context.permissions(0, step, [command])); assert.equal(a.clicks.length, 0);
  });
  // Exercise the actual changed admission assertions without mounting an editor.
  const admissionStart = source.indexOf('      assert.strictEqual(contract.TURN_COUNT,');
  const admissionEnd = source.indexOf('      assert.strictEqual(manifest.stage,', admissionStart);
  assert(admissionStart > 0 && admissionEnd > admissionStart);
  const admission = ts.transpileModule(source.slice(admissionStart, admissionEnd), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true,
  });
  assert.equal((admission.diagnostics || []).length, 0);
  const admit = new Function('assert', 'contract', 'manifest', admission.outputText);
  const fixture = () => ({ fixture: { repairs: Object.fromEntries(Array.from({ length: 11 }, (_, i) =>
    ['P' + i, { kind: i ? 'update' : 'add' }])) } });
  const configuration = () => ({ TURN_COUNT: 19, FIRST_SEGMENT_COUNT: 17, BUILD_ORDINAL: 16, LINT_ORDINAL: 15,
    BOUNDARY_ORDINALS: [13, 14, 15, 16], SELECTED: Array.from({ length: 11 }, (_, i) => 'P' + i),
    STAGE: 'F2_TASK_DUE_DATE_TIMED_SEQUENTIAL', MAIN_CAP: 24, HELPER_CAP: 48 });
  check('actual F02 admission accepts 19 tasks, 17+2, eleven patches and exact caps', () => admit(assert, configuration(), fixture()));
  for (const [key, value] of Object.entries({ TURN_COUNT: 18, FIRST_SEGMENT_COUNT: 16, BUILD_ORDINAL: 15,
    LINT_ORDINAL: 14, STAGE: 'F2_CSV_EXPORT_SEQUENTIAL', MAIN_CAP: 25, HELPER_CAP: 49 })) {
    check('actual admission rejects wrong ' + key, () => assert.throws(() => admit(assert, { ...configuration(), [key]: value }, fixture())));
  }
  check('actual admission rejects old ten-patch inventory', () => assert.throws(() => admit(assert, { ...configuration(), SELECTED: configuration().SELECTED.slice(1) }, fixture())));
  check('actual admission rejects old verification ordinals', () => assert.throws(() => admit(assert, { ...configuration(), BOUNDARY_ORDINALS: [12, 13, 14, 15] }, fixture())));
  check('actual admission rejects zero add files', () => { const value = fixture(); value.fixture.repairs.P0.kind = 'update'; assert.throws(() => admit(assert, configuration(), value)); });
  check('actual admission rejects nine updates while add count remains one', () => { const value = fixture(); delete value.fixture.repairs.P1; assert.throws(() => admit(assert, configuration(), value)); });
  check('native retry, permissions, send/history and source boundary functions equal frozen N28 bytes', () => {
    const priorSource = fs.readFileSync(priorPins[0].path, 'utf8'), priorParsed = ts.createSourceFile(priorPins[0].path, priorSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const priorFunctions = {};
    function previous(node) { if (ts.isFunctionDeclaration(node) && node.name) priorFunctions[node.name.text] = node.getText(priorParsed); ts.forEachChild(node, previous); }
    previous(priorParsed);
    for (const name of ['record', 'boundary', 'until', 'events', 'history', 'observeAppliedPatch', 'assertUniqueNativeAttempts', 'permissions', 'send']) {
      assert.equal(declarations[name], priorFunctions[name], name);
    }
  });
  check('driver and observer use only the new feature namespace with the frozen observer implementation', () => {
    assert(!source.includes('MYSTI_PB02_F2_CSV_EXPORT_SEQUENTIAL'));
    assert(source.includes('MYSTI_PB02_F2_TASK_DUE_DATE_TIMED_SEQUENTIAL_ARTIFACT_DIR'));
    assert(source.includes('scripts/validation/codex-f2-task-due-date-timed-campaign.cjs'));
    assert.equal(fs.readFileSync(pins[1].path, 'utf8'), '/** Existing public observer, with a separate F02 task due date driver identity. */\nexport { installCodexF2CompactObserver as installCodexF2TaskDueDateTimedObserver } from \'./codex-f2-compact-observer\';\n');
  });
  assert.equal(checks.length, 33);
  for (const pin of [...pins, ...priorPins, ...dependencies]) assert.deepEqual(identity(pin.path), pin);
}
main().then(() => { report.status = 'PASS_STATIC_AND_ISOLATED_DRIVER_CHECKS'; }).catch(error => {
  report.status = 'FAIL'; report.error = { message: error.message, stack: error.stack }; process.exitCode = 1;
}).finally(() => {
  report.completedAt = new Date().toISOString(); report.count = checks.length;
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, count: checks.length, report: identity(reportPath) }));
});
