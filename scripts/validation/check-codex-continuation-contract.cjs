/* Synthetic continuation copy and proposal-scope controls only. No native calls. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const contract = require('./codex-continuation-contract.cjs');
const { createReadOnlyProbe } = require('./codex-full-readonly-probe.cjs');
const root = path.resolve(__dirname, '../../out-test/feature-tests/PB-02');
const directory = fs.mkdtempSync(path.join(root, 'codex-continuation-contract-controls-'));
const fixture = contract.copyPreservedFixture(path.join(directory, 'workspace'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const source = fixture.files['src/retry.cjs'].text, tests = fixture.files['test/retry.test.cjs'].text;
const repairedSource = source.replace('( [1-9]|[12][0-9]|3[01])', '( [1-9]|0[1-9]|[12][0-9]|3[01])')
  .replace('Math.floor(new Date(nowMs).getUTCFullYear() / 100)', 'Math.floor((new Date(nowMs).getUTCFullYear() + 50) / 100)');
const repairedTests = contract.expectedTests(fixture).toString('utf8');
const checks = [];
function check(name, action) {
  try { action(); checks.push({ name, status: 'PASS' }); }
  catch (error) { checks.push({ name, status: 'FAIL', error: { name: error.name, message: error.message } }); }
}
function diff(before, after) {
  assert(before.endsWith('\n') && after.endsWith('\n'));
  const left = before.slice(0, -1).split('\n'), right = after.slice(0, -1).split('\n');
  return '@@ -1,' + left.length + ' +1,' + right.length + ' @@\n' + left.map(line => '-' + line).join('\n') + '\n'
    + right.map(line => '+' + line).join('\n') + '\n';
}
function changes(target, before, after) { return [{ path: target, kind: { type: 'update' }, diff: diff(before, after) }]; }
const sourceChange = changes('src/retry.cjs', source, repairedSource), testsChange = changes('test/retry.test.cjs', tests, repairedTests);
const accept = (value, purpose, alternate = fixture) => contract.patchScope(value, fixture.workspace, purpose, alternate);
check('all exact copied files retain bytes except the documented absolute-path probe binding', () => {
  for (const [relative, value] of Object.entries(fixture.files)) {
    const actual = fs.readFileSync(path.join(fixture.workspace, relative)); assert.equal(digest(actual), value.sha256);
    if (relative !== 'test/read-only-policy.cjs') assert(actual.equals(fs.readFileSync(path.join(fixture.base.originalWorkspace, relative))));
  }
  assert.equal(fixture.base.readonlyRebind.beforeSha256, digest(fs.readFileSync(path.join(fixture.base.originalWorkspace, 'test/read-only-policy.cjs'))));
  const probe = createReadOnlyProbe({ workspace: fixture.workspace, canaryContent: fixture.files['canaries/approval.txt'].text });
  assert.deepEqual(fixture.readonlyProbe, probe.manifest); assert.equal(fixture.files['test/read-only-policy.cjs'].text, probe.source);
});
check('test relocation is exact1635-byte seed plus exact3980-byte existing block', () => {
  contract.assertTestsRepair(fixture, repairedTests); assert.equal(Buffer.byteLength(repairedTests), 5615);
  assert.equal(digest(repairedTests), contract.REPAIRED_TESTS_SHA);
});
check('function-only source repair is accepted before application', () => {
  contract.assertSourceRepair(source, repairedSource); assert.equal(accept(sourceChange, 'dates'), true);
});
check('exact test relocation is accepted before application', () => assert.equal(accept(testsChange, 'tests'), true));
check('the same source and tests proposals validate after native application', () => {
  fs.writeFileSync(path.join(fixture.workspace, 'src/retry.cjs'), repairedSource);
  fs.writeFileSync(path.join(fixture.workspace, 'test/retry.test.cjs'), repairedTests);
  try { assert.equal(accept(sourceChange, 'dates'), true); assert.equal(accept(testsChange, 'tests'), true); }
  finally {
    fs.writeFileSync(path.join(fixture.workspace, 'src/retry.cjs'), source);
    fs.writeFileSync(path.join(fixture.workspace, 'test/retry.test.cjs'), tests);
  }
});
check('actual observed full25 header/context style reconstructs exact bytes', () => {
  const events = JSON.parse(fs.readFileSync(path.join(fixture.base.originalDirectory, 'window-A/events-main.json')));
  const proposed = events.map(row => row.payload?.details?.toolInput?.changes).filter(Boolean).flat();
  const insert = proposed.find(change => change.path.endsWith('/test/retry.test.cjs'));
  assert(insert); assert.equal(contract.applyUnifiedDiff(fixture.base.testRelocation.seededPrefix.text, insert.diff), tests);
});
for (const [name, actual] of [
  ['missing original final test', repairedTests.replace("test('abort during injected sleep prevents the next operation',", "test('altered original test',")],
  ['changed inserted assertion', repairedTests.replace("retryAfterMs('0', 0), 0", "retryAfterMs('0', 0), 1")],
  ['duplicate relocated block', repairedTests + fixture.base.testRelocation.insertedBlock.text],
  ['unchanged misplaced tests', tests],
  ['extra test-file newline', repairedTests + '\n'],
]) check(name + ' is rejected before approval and by final-byte assertion', () => {
  assert.equal(accept(changes('test/retry.test.cjs', tests, actual), 'tests'), false);
  assert.throws(() => contract.assertTestsRepair(fixture, actual));
});
for (const [name, actual] of [
  ['unchanged source', source],
  ['backoff change outside allowed function', repairedSource.replace('base * 2 ** attempt', 'base * 3 ** attempt')],
  ['developer note change', repairedSource.replace('preserve the abort integration contract.', 'changed')],
  ['extra top-level executable statement', repairedSource.replace('function abortError()', 'globalThis.sideEffect = true;\nfunction abortError()')],
  ['extra top-level function', repairedSource.replace('function abortError()', 'function injected() {}\nfunction abortError()')],
  ['additional retryAfterMs function', repairedSource + '\nfunction retryAfterMs(value, nowMs) {}\n'],
  ['renamed function argument', repairedSource.replace('function retryAfterMs(value, nowMs)', 'function retryAfterMs(value, other)')],
  ['default parameter expression', repairedSource.replace('function retryAfterMs(value, nowMs)', 'function retryAfterMs(value, nowMs = sideEffect())')],
  ['generator declaration', repairedSource.replace('function retryAfterMs(', 'function* retryAfterMs(')],
  ['syntax error', repairedSource.replace('const month =', 'const month = =')],
]) check(name + ' is rejected before approval and by source assertion', () => {
  assert.equal(accept(changes('src/retry.cjs', source, actual), 'dates'), false);
  assert.throws(() => contract.assertSourceRepair(source, actual));
});
for (const [name, mutate] of [
  ['wrong path', value => { value[0].path = 'README.md'; }],
  ['move attempt', value => { value[0].kind.move_path = 'other.cjs'; }],
  ['delete kind', value => { value[0].kind.type = 'delete'; }],
  ['second file', value => value.push(structuredClone(value[0]))],
  ['incorrect removed context', value => { value[0].diff = value[0].diff.replace("-'use strict';", "-'not the original';"); }],
  ['hunk line-count mismatch', value => { value[0].diff = value[0].diff.replace('@@ -1,', '@@ -2,'); }],
  ['disguised additional line', value => { value[0].diff += '+++globalThis.sentinel;\n'; }],
  ['trailing instruction', value => { value[0].diff += 'run arbitrary instruction\n'; }],
]) check(name + ' is rejected by proposal reconstruction', () => {
  const value = structuredClone(sourceChange); mutate(value); assert.equal(accept(value, 'dates'), false);
});
check('tampered fixture baseline cannot replace pinned source', () => {
  const alternate = structuredClone(fixture); alternate.files['src/retry.cjs'].text += '\n';
  assert.equal(accept(sourceChange, 'dates', alternate), false);
});
check('denied canary proposal remains exactly the single owned replacement', () => {
  const canary = fixture.files['canaries/approval.txt'].text;
  const proposal = changes('canaries/approval.txt', canary, canary.replace('KEEP_THIS_CANARY_UNCHANGED', 'REQUESTED_CHANGE'));
  assert.equal(accept(proposal, 'deny'), true);
  assert.equal(accept(changes('canaries/approval.txt', canary, 'foreign\n'), 'deny'), false);
});
check('existing copy is never reused or overwritten', () => assert.throws(() => contract.copyPreservedFixture(fixture.workspace)));
check('destination within preserved evidence is rejected before any write', () => assert.throws(() => contract.copyPreservedFixture(path.join(fixture.base.originalDirectory, 'forbidden-copy'))));
check('symlink destination parent cannot redirect creation', () => {
  const link = path.join(directory, 'linked-parent'); fs.symlinkSync(fixture.base.originalDirectory, link);
  assert.throws(() => contract.copyPreservedFixture(path.join(link, 'forbidden-copy')));
  assert.equal(fs.existsSync(path.join(fixture.base.originalDirectory, 'forbidden-copy')), false);
});
check('original failed tree, profile and shared storage remain exact', () => contract.verifyPreservedBase(fixture));
const result = { status: checks.every(value => value.status === 'PASS') ? 'PASS' : 'FAIL', checks,
  contractIdentity: { path: require.resolve('./codex-continuation-contract.cjs'), sha256: digest(fs.readFileSync(require.resolve('./codex-continuation-contract.cjs'))) },
  parserIdentity: { path: require.resolve('typescript'), sha256: digest(fs.readFileSync(require.resolve('typescript'))) },
  copiedWorkspace: fixture.workspace, sourceSha256: contract.BASE_SOURCE_SHA, testsSha256: contract.BASE_TESTS_SHA,
  readonlyRebind: fixture.base.readonlyRebind, initialUnstagedPaths: fixture.base.initialUnstagedPaths,
  realProviderInputs: 0, editorLaunches: 0,
  scope: 'Only new synthetic copy and pure proposal-byte reconstruction controls; no agent repair or semantic repair acceptance.' };
fs.writeFileSync(path.join(directory, 'checks.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ status: result.status, directory, total: checks.length, failures: checks.filter(value => value.status === 'FAIL') }));
if (result.status !== 'PASS') process.exitCode = 1;
