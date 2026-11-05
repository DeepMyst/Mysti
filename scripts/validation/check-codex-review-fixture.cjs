/* Known synthetic correction on a NEW copy only. Never an agent-repair claim. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { copyPreservedFixture, verifyPreservedBase, assertSourceRepair, patchScope } = require('./codex-review-contract.cjs');
const root = path.resolve(__dirname, '../../out-test/feature-tests/PB-02');
const directory = fs.mkdtempSync(path.join(root, 'codex-review-fixture-controls-'));
const fixture = copyPreservedFixture(path.join(directory, 'workspace'));
const file = path.join(fixture.workspace, 'src/retry.cjs');
const original = fs.readFileSync(file);
const checks = [];
function evaluate(script, label, args, expectedExit) {
  const result = spawnSync(process.execPath, [path.join(__dirname, script), file, ...args], { encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
  fs.writeFileSync(path.join(directory, label + '.json'), result.stdout, { flag: 'wx' });
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, expectedExit);
  return JSON.parse(result.stdout);
}
try {
  const red = evaluate('http-date-portability-oracle.cjs', 'exact-copy-red', [], 1);
  assert.equal(red.passed, 42); assert.equal(red.failed, 3); assert.equal(red.fixtureSourceUnchanged, true);
  checks.push({ name: 'Exact copied generated source reproduces all original portability failures', status: 'PASS' });
  const after = "    const timestamp = Date.parse(i === 2 ? trimmed + ' GMT' : trimmed);";
  const corrected = original.toString('utf8').replace('    const timestamp = Date.parse(trimmed);', after);
  assertSourceRepair(original, Buffer.from(corrected));
  assert.throws(() => assertSourceRepair(original, Buffer.from(corrected + '\n// unrelated edit\n')));
  assert.equal(patchScope([{ path: 'src/retry.cjs', kind: { type: 'update' }, diff: '-    const timestamp = Date.parse(trimmed);\n+' + after }], fixture.workspace, 'repair'), true);
  fs.writeFileSync(file, corrected);
  const green = evaluate('http-date-portability-oracle.cjs', 'synthetic-copy-green', [], 0);
  assert.equal(green.passed, 45); assert.equal(green.failed, 0); assert.equal(green.fixtureSourceUnchanged, true);
  const full = evaluate('codex-fixture-oracle.cjs', 'synthetic-copy-full', ['full'], 0);
  assert.equal(full.passed, 14); assert.equal(full.failed, 0);
  checks.push({ name: 'Exact permitted synthetic source repair passes 45 portability and 14 full F1 checks', status: 'PASS' });

  const templateLine = '    const timestamp = Date.parse(i === 2 ? `${trimmed} GMT` : trimmed);';
  const templateCorrected = original.toString('utf8').replace('    const timestamp = Date.parse(trimmed);', templateLine);
  assertSourceRepair(original, Buffer.from(templateCorrected));
  assert.throws(() => assertSourceRepair(original, Buffer.from(templateCorrected.replace('${trimmed}', '${sideEffect()}'))));
  assert.throws(() => assertSourceRepair(original, Buffer.from(templateCorrected + '\n// unrelated edit\n')));
  fs.writeFileSync(file, templateCorrected);
  const templateGreen = evaluate('http-date-portability-oracle.cjs', 'synthetic-template-green', [], 0);
  assert.equal(templateGreen.passed, 45); assert.equal(templateGreen.failed, 0);
  const templateFull = evaluate('codex-fixture-oracle.cjs', 'synthetic-template-full', ['full'], 0);
  assert.equal(templateFull.passed, 14); assert.equal(templateFull.failed, 0);
  checks.push({ name: 'Exact observed template-literal repair passes 45 portability and 14 full F1 checks; interpolation and unrelated edits rejected', status: 'PASS' });
  for (const [relative, value] of Object.entries(fixture.files)) if (relative !== 'src/retry.cjs') {
    assert(fs.readFileSync(path.join(fixture.workspace, relative)).equals(fs.readFileSync(path.join(fixture.base.originalWorkspace, relative))));
  }
  verifyPreservedBase(fixture);
  checks.push({ name: 'Original native-full tree and original profile/shared storage remain byte-identical', status: 'PASS' });
  fs.writeFileSync(path.join(directory, 'checks.json'), JSON.stringify({ status: 'PASS', checks, realProviderInputs: 0, editorLaunches: 0,
    scope: 'Synthetic fixture/approval/oracle controls only; no actual agent review or repair occurred.' }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ status: 'PASS', directory, checks: checks.length }));
} catch (error) {
  fs.writeFileSync(path.join(directory, 'checks.json'), JSON.stringify({ status: 'FAIL', checks, error: { name: error.name, message: error.message } }, null, 2), { flag: 'wx' });
  throw error;
}
