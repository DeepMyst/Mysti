/* Exercise the real runner, including failures, on development and minimum Node. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-qunit-proof-'));
const qunit = JSON.stringify(require.resolve('qunit'));
const runner = JSON.stringify(path.join(root, 'scripts', 'editor-test-runner.cjs'));
const { optionalNativeTest } = require('./editor-test-manifest.cjs');
const nativeSkip = `QUnit.module(${JSON.stringify(optionalNativeTest[0])}, () => QUnit.skip(${JSON.stringify(optionalNativeTest[1])}, () => {}));`;
const fixtures = [
  ['async serial hooks', true, `
    const order = [];
    QUnit.module('serial', hooks => {
      hooks.before(async () => { await Promise.resolve(); order.push('before'); });
      hooks.beforeEach(() => order.push('beforeEach'));
      hooks.afterEach(() => order.push('afterEach'));
      hooks.after(() => require('node:assert/strict').deepEqual(order, ['before', 'beforeEach', 'one', 'afterEach', 'beforeEach', 'two', 'afterEach']));
      QUnit.test('one', async a => { await new Promise(r => setTimeout(r, 5)); order.push('one'); a.ok(true); });
      QUnit.test('two', a => { order.push('two'); a.ok(true); });
    });`],
  ['sync assertion failure', false, `QUnit.test('throws', () => require('node:assert/strict').equal(1, 2));`],
  ['async assertion failure', false, `QUnit.test('rejects', async () => { await Promise.resolve(); throw new Error('fixture rejection'); });`],
  ['before failure', false, `QUnit.module('setup', hooks => { hooks.before(async () => { throw new Error('fixture setup'); }); QUnit.test('body', a => a.ok(true)); });`],
  ['after failure', false, `QUnit.module('cleanup', hooks => { hooks.after(async () => { throw new Error('fixture cleanup'); }); QUnit.test('body', a => a.ok(true)); });`],
  ['timeout', false, `QUnit.test('timeout', a => { a.timeout(10); return new Promise(() => {}); });`],
  ['unhandled rejection', false, `QUnit.test('outside promise', async a => { Promise.reject(new Error('fixture unhandled')); await new Promise(r => setTimeout(r, 20)); a.ok(true); });`],
  ['uncaught exception', false, `QUnit.test('outside timer', async a => { setTimeout(() => { throw new Error('fixture uncaught'); }, 1); await new Promise(r => setTimeout(r, 20)); a.ok(true); });`],
  ['expected universal native skip', true, `QUnit.test('required', a => a.ok(true)); ${nativeSkip}`, { expectedTests: [['required'], optionalNativeTest] }, { MYSTI_TEST_DESK_NATIVE: '0' }],
  ['native skip when required', false, `QUnit.test('required', a => a.ok(true)); ${nativeSkip}`, { expectedTests: [['required'], optionalNativeTest] }, { MYSTI_TEST_DESK_NATIVE: '1' }],
  ['unexpected skip', false, `QUnit.test('required', a => a.ok(true)); QUnit.skip('disabled required case', () => {});`],
  ['unexpected skipped module', false, `QUnit.test('required', a => a.ok(true)); QUnit.module.skip('disabled', () => QUnit.test('required case', a => a.ok(false)));`],
  ['focused test', false, `QUnit.test('would fail', a => a.ok(false)); QUnit.only('passes', a => a.ok(true));`],
  ['focused test alias', false, `QUnit.test('would fail', a => a.ok(false)); QUnit.test.only('passes', a => a.ok(true));`],
  ['focused module', false, `QUnit.module('would fail', () => QUnit.test('fails', a => a.ok(false))); QUnit.module.only('focused', () => QUnit.test('passes', a => a.ok(true)));`],
  ['caught focus attempt', false, `try { QUnit.only('focused', a => a.ok(true)); } catch {} QUnit.test('passes', a => a.ok(true));`],
  ['missing reviewed case', false, `QUnit.test('one', a => a.ok(true));`, { expectedTests: [['one'], ['two']] }],
  ['unreviewed additional case', false, `QUnit.test('one', a => a.ok(true)); QUnit.test('two', a => a.ok(true));`, { expectedTests: [['one']] }],
  ['complete reviewed cases', true, `QUnit.test('one', a => a.ok(true)); QUnit.test('two', a => a.ok(true));`, { expectedTests: [['one'], ['two']] }],
  ['name filter', false, `QUnit.config.filter = 'passes'; QUnit.test('would fail', a => a.ok(false)); QUnit.test('passes', a => a.ok(true));`],
  ['module filter', false, `QUnit.config.module = 'passes'; QUnit.module('would fail', () => QUnit.test('fails', a => a.ok(false))); QUnit.module('passes', () => QUnit.test('passes', a => a.ok(true)));`],
  ['module ID filter', false, `QUnit.config.moduleId = ['selected']; QUnit.test('passes', a => a.ok(true));`],
  ['test ID filter', false, `QUnit.config.testId = ['selected']; QUnit.test('passes', a => a.ok(true));`],
  ['only skipped', false, `QUnit.skip('missing required tests', () => {});`],
  ['todo', false, `QUnit.test('required', a => a.ok(true)); QUnit.todo('unfinished', a => a.ok(false));`],
  ['load failure', false, `throw new Error('fixture load failure');`],
  ['no registered tests', false, ``],
];
try {
  for (const [name, passes, source, options = {}, environment = {}] of fixtures) {
    const file = path.join(scratch, name + '.cjs');
    fs.writeFileSync(file, `const QUnit = require(${qunit});\n${source}\n`);
    const invocation = `require(${runner}).runFiles([${JSON.stringify(file)}], ${JSON.stringify(options)}).catch(error => { console.error(error); process.exitCode = 1; });`;
    const child = spawnSync(process.execPath, ['-e', invocation], { encoding: 'utf8', timeout: 4000, env: { ...process.env, ...environment } });
    assert.ifError(child.error);
    assert.equal(child.signal, null, `${name}: process terminated`);
    assert.equal(child.status, passes ? 0 : 1, `${name}: ${child.stdout}\n${child.stderr}`);
    console.log(`[Runner proof] ${name}: ${passes ? 'passes' : 'fails as required'}`);
  }
  const empty = spawnSync(process.execPath, ['-e', `require(${runner}).runFiles([]).catch(() => { process.exitCode = 1; });`], { encoding: 'utf8', timeout: 4000 });
  assert.ifError(empty.error);
  assert.equal(empty.status, 1);
  console.log(`[Runner proof] ${fixtures.length + 1} checks passed on Node ${process.versions.node}`);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
