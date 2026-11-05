/* Pure fixture control copies only. Never modifies the native developer workspace. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { ownedFixture } = require('./http-date-portability-oracle.cjs');
const root = path.resolve(__dirname, '../../out-test/feature-tests/PB-02');
const source = ownedFixture(process.argv[2]);
const original = fs.readFileSync(source), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const directory = fs.mkdtempSync(path.join(root, 'http-date-controls-'));
const oracle = path.join(__dirname, 'http-date-portability-oracle.cjs');
const checks = [];
function evaluate(file, name) {
  const result = spawnSync(process.execPath, [oracle, file], { encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
  const artifact = path.join(directory, name + '.json');
  fs.writeFileSync(artifact, result.stdout, { flag: 'wx' });
  assert.equal(result.signal, null); assert.equal(result.error, undefined);
  return { exitCode: result.status, report: JSON.parse(result.stdout), artifact };
}
try {
  const actual = evaluate(source, 'actual-native-red');
  assert.equal(actual.exitCode, 1); assert.equal(actual.report.status, 'FAIL');
  assert.equal(actual.report.sourceSha256, hash(original)); assert.equal(actual.report.fixtureSourceUnchanged, true);
  for (const timezone of ['Asia/Amman', 'America/Los_Angeles']) {
    assert.equal(actual.report.runs.find(run => run.timezone === timezone).report.checks.find(check => check.name === 'obsolete asctime').status, 'FAIL');
  }
  checks.push({ name: 'Actual native module exposes asctime timezone defect without mutation', status: 'PASS', artifact: actual.artifact });

  const redFile = path.join(directory, 'red-copy/src/retry.cjs'); fs.mkdirSync(path.dirname(redFile), { recursive: true });
  fs.writeFileSync(redFile, original, { flag: 'wx' });
  const red = evaluate(redFile, 'seed-copy-red'); assert.equal(red.exitCode, 1); assert.equal(red.report.sourceSha256, hash(original));
  checks.push({ name: 'Exact seeded control copy reproduces failure', status: 'PASS', artifact: red.artifact });

  const before = 'const timestamp = Date.parse(trimmed);';
  const after = "const timestamp = Date.parse(i === 2 ? trimmed + ' GMT' : trimmed);";
  const text = original.toString('utf8'); assert.equal(text.split(before).length, 2, 'Control correction targets one known seeded line only');
  const corrected = text.replace(before, after);
  const greenFile = path.join(directory, 'green-copy/src/retry.cjs'); fs.mkdirSync(path.dirname(greenFile), { recursive: true });
  fs.writeFileSync(greenFile, corrected, { flag: 'wx' });
  const green = evaluate(greenFile, 'corrected-copy-green');
  assert.equal(green.exitCode, 0); assert.equal(green.report.status, 'PASS');
  assert.equal(green.report.passed, 45); assert.equal(green.report.failed, 0);
  assert.equal(green.report.fixtureSourceUnchanged, true);
  checks.push({ name: 'Owned corrected copy passes all45 vectors in three fresh timezone processes', status: 'PASS', artifact: green.artifact });

  const outsideLink = path.join(directory, 'outside-link/src/retry.cjs'); fs.mkdirSync(path.dirname(outsideLink), { recursive: true });
  fs.symlinkSync(path.resolve(__dirname, '../../package.json'), outsideLink);
  assert.throws(() => ownedFixture(outsideLink), /Only realpath-confined/);
  assert.throws(() => ownedFixture(path.resolve(__dirname, '../../package.json')), /Only realpath-confined/);
  checks.push({ name: 'Foreign path and owned symlink escaping allowed roots are rejected before require', status: 'PASS' });

  assert(fs.readFileSync(source).equals(original)); assert.equal(hash(fs.readFileSync(redFile)), hash(original));
  assert.equal(hash(fs.readFileSync(greenFile)), hash(corrected));
  const result = { status: 'PASS', checkedAt: new Date().toISOString(), directory, originalSource: source,
    originalSourceSha256: hash(original), originalSourceUnchanged: true,
    oracleSha256: hash(fs.readFileSync(oracle)), controlScriptSha256: hash(fs.readFileSync(__filename)),
    controlCorrection: { file: greenFile, before, after, sha256: hash(corrected) }, checks,
    actualFailureCounts: { passed: actual.report.passed, failed: actual.report.failed, total: actual.report.expectedChecks },
    correctedCopyCounts: { passed: green.report.passed, failed: green.report.failed },
    realProviderInputs: 0, editorLaunches: 0, networkRequests: 0,
    scope: 'Control correction is confined to an owned synthetic copy. Native fixture and frozen codex-fixture-oracle remain unchanged.' };
  fs.writeFileSync(path.join(directory, 'checks.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ status: result.status, artifact: path.join(directory, 'checks.json') }));
} catch (error) {
  fs.writeFileSync(path.join(directory, 'checks.json'), JSON.stringify({ status: 'FAIL', checks,
    originalSourceUnchanged: fs.readFileSync(source).equals(original), error: { name: error.name, message: error.message } }, null, 2), { flag: 'wx' });
  console.error(error); process.exitCode = 1;
}
