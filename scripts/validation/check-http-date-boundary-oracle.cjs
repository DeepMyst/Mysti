/* Controls only: actual failing fixture is read; corrections exist only in new synthetic copies. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const oracle = require('./http-date-boundary-oracle.cjs');
const baseline = require('./http-date-portability-oracle.cjs');
const root = path.resolve(__dirname, '../../out-test/feature-tests/PB-02');
const source = oracle.ownedFixture(process.argv[2]);
const original = fs.readFileSync(source), hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(original), 'f27afe083b5d63eb4e4ce2406fd0d9f49348b9913bd269d73bc0da3de89b9fe7', 'Controls target the preserved known Q03/Q04 failing fixture');
const baselinePath = require.resolve('./http-date-portability-oracle.cjs'), baselineBytes = fs.readFileSync(baselinePath);
const directory = fs.mkdtempSync(path.join(root, 'http-date-boundary-controls-')), checks = [];
function check(name, action) { action(); checks.push({ name, status: 'PASS' }); }
function copy(name, text) {
  const file = path.join(directory, name, 'src/retry.cjs'); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { flag: 'wx' }); return file;
}
function evaluate(file, name, script = require.resolve('./http-date-boundary-oracle.cjs')) {
  const child = spawnSync(process.execPath, [script, file], { encoding: 'utf8', timeout: 25000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(child.signal, null); assert.equal(child.error, undefined);
  const artifact = path.join(directory, name + '.json'); fs.writeFileSync(artifact, child.stdout, { flag: 'wx' });
  return { exitCode: child.status, report: JSON.parse(child.stdout), artifact };
}
const text = original.toString('utf8');
const replacements = [
  { before: '( [1-9]|[12][0-9]|3[01])', after: '( [1-9]|0[1-9]|[12][0-9]|3[01])' },
  { before: 'Math.floor(new Date(nowMs).getUTCFullYear() / 100) * 100', after: 'Math.floor((new Date(nowMs).getUTCFullYear() + 50) / 100) * 100' },
];
let actual, green;
try {
  check('Successor retains all old15 vectors and exact per-vector expectations', () => {
    assert.equal(oracle.vectors.length, 45); assert.equal(oracle.vectorManifest.length, 45);
    for (const [index, vector] of baseline.vectors.entries()) {
      const retained = oracle.vectors[index];
      assert.equal(retained.name, vector.name); assert.deepEqual(retained.value, vector.value);
      assert(Object.is(retained.expected, vector.expected)); assert.equal(retained.nowMs, Date.UTC(1994, 10, 6, 8, 49, 30));
    }
  });
  check('Actual generated source passes original45 but fails exactly21 new checks across3TZ', () => {
    const previous = evaluate(source, 'actual-old45', baselinePath);
    assert.equal(previous.exitCode, 0); assert.equal(previous.report.passed, 45); assert.equal(previous.report.failed, 0);
    actual = evaluate(source, 'actual-expanded-red'); assert.equal(actual.exitCode, 1);
    assert.equal(actual.report.passed, 114); assert.equal(actual.report.failed, 21); assert.equal(actual.report.expectedChecks, 135);
    assert.equal(actual.report.sourceSha256, hash(original)); assert.equal(actual.report.fixtureSourceUnchanged, true);
    const failing = oracle.vectors.filter(vector => vector.name.startsWith('Q03 asctime zero-padded') || vector.name.startsWith('Q04 RFC850 next-century')
      || ['RFC850 one second before fifty-year cutoff', 'RFC850 exactly at fifty-year cutoff'].includes(vector.name)).map(vector => vector.name);
    for (const run of actual.report.runs) assert.deepEqual(run.report.checks.filter(value => value.status === 'FAIL').map(value => value.name), failing);
  });
  check('Independent failures persist when only one parser correction is applied', () => {
    for (const replacement of replacements) assert.equal(text.split(replacement.before).length, 2);
    const dayOnly = evaluate(copy('SYNTHETIC-day-only', text.replace(replacements[0].before, replacements[0].after)), 'synthetic-day-only');
    assert.equal(dayOnly.exitCode, 1); assert.equal(dayOnly.report.failed, 12);
    const yearOnly = evaluate(copy('SYNTHETIC-year-only', text.replace(replacements[1].before, replacements[1].after)), 'synthetic-year-only');
    assert.equal(yearOnly.exitCode, 1); assert.equal(yearOnly.report.failed, 9);
  });
  check('A crude year-only past cutoff still fails the exact fifty-year timestamp boundary', () => {
    const crude = text.replace(replacements[0].before, replacements[0].after).replace(replacements[1].before + ';', replacements[1].before
      + ';\n    if (year < new Date(nowMs).getUTCFullYear() - 50) year += 100;');
    const result = evaluate(copy('SYNTHETIC-crude-year-only-cutoff', crude), 'synthetic-crude-year-only-cutoff');
    assert.equal(result.exitCode, 1); assert.equal(result.report.failed, 6);
    for (const run of result.report.runs) assert.deepEqual(run.report.checks.filter(value => value.status === 'FAIL').map(value => value.name),
      ['RFC850 one second before fifty-year cutoff', 'RFC850 exactly at fifty-year cutoff']);
  });
  check('Both minimal corrections pass135 in a synthetic copy, with no real agent repair claim', () => {
    const corrected = replacements.reduce((value, replacement) => value.replace(replacement.before, replacement.after), text);
    green = evaluate(copy('SYNTHETIC-both-corrections', corrected), 'synthetic-both-green');
    assert.equal(green.exitCode, 0); assert.equal(green.report.passed, 135); assert.equal(green.report.failed, 0);
    assert.equal(green.report.sourceSha256, hash(corrected)); assert.equal(green.report.fixtureSourceUnchanged, true);
  });
  check('Changing greater-than to greater-or-equal is rejected at exactly fifty years', () => {
    const corrected = replacements.reduce((value, replacement) => value.replace(replacement.before, replacement.after), text);
    assert.equal(corrected.split('candidate.getTime() > boundary.getTime()').length, 2);
    const wrongBoundary = corrected.replace('candidate.getTime() > boundary.getTime()', 'candidate.getTime() >= boundary.getTime()');
    const result = evaluate(copy('SYNTHETIC-wrong-inclusive-cutoff', wrongBoundary), 'synthetic-wrong-inclusive-cutoff');
    assert.equal(result.exitCode, 1); assert.equal(result.report.failed, 3);
    for (const run of result.report.runs) assert.deepEqual(run.report.checks.filter(value => value.status === 'FAIL').map(value => value.name), ['RFC850 exactly at fifty-year cutoff']);
  });
  check('Foreign files PB03 paths wrong basenames and symlink escapes reject before loading', () => {
    const foreign = path.resolve(__dirname, '../../package.json'); assert.throws(() => oracle.ownedFixture(foreign), /PB-02/);
    const alias = path.join(directory, 'escape/src/retry.cjs'); fs.mkdirSync(path.dirname(alias), { recursive: true }); fs.symlinkSync(foreign, alias);
    assert.throws(() => oracle.ownedFixture(alias), /PB-02/);
    const wrongName = path.join(directory, 'wrong.cjs'); fs.writeFileSync(wrongName, text); assert.throws(() => oracle.ownedFixture(wrongName));
    const otherRoot = path.resolve(root, '../PB-03');
    // Existing foreign-case source is sufficient if present; no PB-03 fixture is created.
    if (fs.existsSync(otherRoot)) assert.throws(() => oracle.ownedFixture(otherRoot));
  });
  check('Missing or throwing export remains a failed oracle report', () => {
    const malformed = copy('SYNTHETIC-missing-export', 'module.exports = {};\n');
    const result = evaluate(malformed, 'synthetic-missing-export'); assert.equal(result.exitCode, 1); assert.equal(result.report.status, 'FAIL');
    const throws = copy('SYNTHETIC-throwing-export', 'exports.retryAfterMs = () => { throw new Error("synthetic failure"); };\n');
    const failure = evaluate(throws, 'synthetic-throwing-export'); assert.equal(failure.exitCode, 1); assert.equal(failure.report.failed, 135);
  });
  assert(fs.readFileSync(source).equals(original)); assert(fs.readFileSync(baselinePath).equals(baselineBytes));
  const report = { status: 'PASS', checkedAt: new Date().toISOString(), directory, checks,
    vectorSet: oracle.vectorSet, vectorSetSha256: oracle.vectorSetSha256, vectors: oracle.vectorManifest,
    source, sourceSha256: hash(original), originalSourceUnchanged: true, originalOracleUnchanged: true,
    baselineOracleSha256: hash(baselineBytes), oracleSha256: hash(fs.readFileSync(require.resolve('./http-date-boundary-oracle.cjs'))),
    controlScriptSha256: hash(fs.readFileSync(__filename)), syntheticCorrections: replacements,
    actual: { artifact: actual.artifact, passed: actual.report.passed, failed: actual.report.failed, expectedChecks: actual.report.expectedChecks },
    syntheticGreen: { artifact: green.artifact, passed: green.report.passed, failed: green.report.failed, sourceSha256: green.report.sourceSha256 },
    realProviderInputs: 0, editorLaunches: 0, networkRequests: 0,
    scope: 'Only new explicitly SYNTHETIC copies are corrected. Actual generated source and earlier pinned45-vector oracle remain byte-identical. Green is oracle/control validation, never actual model repair.' };
  fs.writeFileSync(path.join(directory, 'checks.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, artifact: path.join(directory, 'checks.json'), expectedChecks: 135,
    vectorSetSha256: report.vectorSetSha256, actualPassed: report.actual.passed, actualFailed: report.actual.failed, syntheticGreenPassed: report.syntheticGreen.passed }));
} catch (error) {
  fs.writeFileSync(path.join(directory, 'checks.json'), JSON.stringify({ status: 'FAIL', checks,
    originalSourceUnchanged: fs.readFileSync(source).equals(original), originalOracleUnchanged: fs.readFileSync(baselinePath).equals(baselineBytes),
    error: { name: error.name, message: error.message } }, null, 2), { flag: 'wx' });
  console.error(error); process.exitCode = 1;
}
