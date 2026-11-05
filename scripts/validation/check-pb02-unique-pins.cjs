'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { uniquePins } = require('./pb02-unique-pins.cjs');
const c = require('./codex-f2-signed-webhook-campaign.cjs');
const a = require('./audit-vscode-codex-f2-signed-webhook.cjs');
const root = path.resolve(__dirname, '../../out-test/feature-tests/PB-02');
const directory = fs.mkdtempSync(path.join(root, 'unique-manifest-pins-controls-'));
const file = path.join(root, 'overnight-20261011/native-f2-signed-webhook-session/segment-1/prepared.json');
const manifest = JSON.parse(fs.readFileSync(file));
const checks = [], copy = value => JSON.parse(JSON.stringify(value));
function check(name, run) { try { run(); checks.push({ name, status: 'PASS' }); } catch (error) { checks.push({ name, status: 'FAIL', error: error.stack }); } }
const before = copy(manifest.harnessDependencyIdentities), after = uniquePins(before);
check('actual first manifest reproduces five duplicate declarations and the exact rejected guard', () => {
  assert.equal(before.length - after.length, 5);
  assert.throws(() => a.auditFeatureDependencies(manifest.campaign, before), /Exactly one prelaunch feature dependency pin/);
});
check('deduplicated actual declarations satisfy the unchanged feature guard', () => {
  a.auditFeatureDependencies(manifest.campaign, after);
  a.auditAuditorProvenance(after);
});
check('every original identity remains present exactly once', () => {
  for (const pin of before) assert.deepEqual(after.filter(row => row.path === pin.path), [pin]);
});
check('deduplication preserves first declaration order and leaves inputs unchanged', () => {
  assert.deepEqual(after.map(row => row.path), [...new Set(before.map(row => row.path))]);
  assert.deepEqual(before, manifest.harnessDependencyIdentities);
});
check('returned entries cannot mutate the supplied declarations', () => {
  const input = copy(before), result = uniquePins(input); result[0].sha256 = '0'.repeat(64);
  assert.deepEqual(input, before);
});
check('conflicting duplicate identity is rejected rather than silently selected', () => {
  assert.throws(() => uniquePins([...before, { ...before[0], sha256: '0'.repeat(64) }]), /Conflicting manifest identity/);
});
check('malformed digest is rejected', () => assert.throws(() => uniquePins([{ ...before[0], sha256: 'invalid' }])));
check('extra identity fields are rejected', () => assert.throws(() => uniquePins([{ ...before[0], ignored: true }])));
check('relative paths are rejected', () => assert.throws(() => uniquePins([{ ...before[0], path: 'relative.js' }])));
check('the successor preparer changes only manifest pin assembly after normal helper creation', () => {
  const original = fs.readFileSync(path.join(__dirname, 'prepare-vscode-codex-f2-signed-webhook.cjs'), 'utf8');
  const insertion = "manifest.harnessDependencyIdentities.push(c.identity(__filename), c.identity(require.resolve('./pb02-unique-pins.cjs')), c.identity(require.resolve('./check-pb02-unique-pins.cjs')));\nmanifest.harnessDependencyIdentities = require('./pb02-unique-pins.cjs').uniquePins(manifest.harnessDependencyIdentities);\n";
  assert.deepEqual(fs.readFileSync(path.join(__dirname, 'prepare-vscode-codex-f2-signed-webhook-dedup.cjs'), 'utf8'), original.replace('write(manifestFile, manifest); console.log', insertion + 'write(manifestFile, manifest); console.log'));
});
check('source, qualification and original failed manifest identities remain unchanged', () => {
  for (const pin of before) assert.deepEqual(c.identity(pin.path), pin);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), manifest);
});
const failed = checks.filter(row => row.status === 'FAIL');
const report = { status: failed.length ? 'FAIL' : 'PASS_MANIFEST_IDENTITY_CONTROLS', checkedAt: new Date().toISOString(), checks,
  originalManifest: c.identity(file), sources: ['pb02-unique-pins.cjs', 'check-pb02-unique-pins.cjs', 'prepare-vscode-codex-f2-signed-webhook-dedup.cjs'].map(name => c.identity(path.join(__dirname, name))),
  scope: 'Read-only replay of the actual stopped preparation manifest and owned in-memory controls. No application, editor, model or preparation launched.' };
const target = path.join(directory, 'checks.json'); fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ report: c.identity(target), passed: checks.length - failed.length, total: checks.length, failures: failed }));
process.exitCode = failed.length ? 1 : 0;
