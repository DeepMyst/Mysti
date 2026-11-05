/* Independent HTTP-date portability checks. No editor, provider or network use. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const evidenceRoot = path.resolve(__dirname, '../../out-test/feature-tests');
const timezones = ['UTC', 'Asia/Amman', 'America/Los_Angeles'];
const nowMs = Date.UTC(1994, 10, 6, 8, 49, 30);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// RFC 9110 section 5.6.7: all three HTTP-date forms represent GMT.
// Expected milliseconds are independent literals; no Date.parse-derived oracle.
const vectors = [
  { name: 'IMF-fixdate', value: 'Sun, 06 Nov 1994 08:49:37 GMT', expected: 7000 },
  { name: 'obsolete RFC850', value: 'Sunday, 06-Nov-94 08:49:37 GMT', expected: 7000 },
  { name: 'obsolete asctime', value: 'Sun Nov  6 08:49:37 1994', expected: 7000 },
  { name: 'past IMF-fixdate clamps to zero', value: 'Sun, 06 Nov 1994 08:49:29 GMT', expected: 0 },
  { name: 'past RFC850 clamps to zero', value: 'Sunday, 06-Nov-94 08:49:29 GMT', expected: 0 },
  { name: 'past asctime clamps to zero', value: 'Sun Nov  6 08:49:29 1994', expected: 0 },
  { name: 'trimmed integer delta seconds', value: ' 2 ', expected: 2000 },
  { name: 'zero delta seconds', value: '0', expected: 0 },
  { name: 'fractional delta seconds rejected', value: '0.5', expected: undefined },
  { name: 'fractional date seconds rejected', value: 'Sun, 06 Nov 1994 08:49:37.5 GMT', expected: undefined },
  { name: 'impossible calendar date rejected', value: 'Fri, 31 Feb 1995 08:49:37 GMT', expected: undefined },
  { name: 'nonsensical date rejected', value: 'not-a-date', expected: undefined },
  { name: 'negative delta seconds rejected', value: '-1', expected: undefined },
  { name: 'empty string rejected', value: '', expected: undefined },
  { name: 'non-string rejected', value: 2, expected: undefined },
];

function ownedFixture(supplied) {
  assert.equal(typeof supplied, 'string', 'Supply an owned src/retry.cjs');
  const root = fs.realpathSync(evidenceRoot);
  const file = fs.realpathSync(supplied);
  const allowed = ['PB-02', 'PB-03'].some(name => file.startsWith(path.join(root, name) + path.sep));
  assert(allowed, 'Only realpath-confined PB-02/PB-03 owned fixtures are allowed');
  assert(path.basename(file) === 'retry.cjs' && path.basename(path.dirname(file)) === 'src', 'Only the owned src/retry.cjs module may be loaded');
  assert(fs.statSync(file).isFile());
  return file;
}
function encoded(value) {
  if (value === undefined) return { type: 'undefined' };
  if (typeof value === 'number' && !Number.isFinite(value)) return { type: 'nonfinite', value: String(value) };
  return { type: typeof value, value };
}
function worker(supplied) {
  const file = ownedFixture(supplied), original = fs.readFileSync(file);
  assert(timezones.includes(process.env.TZ), 'Worker requires an explicit tested timezone');
  const api = require(file);
  assert.equal(typeof api.retryAfterMs, 'function', 'Fixture must export retryAfterMs');
  const checks = vectors.map(vector => {
    try {
      const actual = api.retryAfterMs(vector.value, nowMs);
      return { name: vector.name, status: Object.is(actual, vector.expected) ? 'PASS' : 'FAIL',
        input: vector.value, expected: encoded(vector.expected), actual: encoded(actual) };
    } catch (error) {
      return { name: vector.name, status: 'FAIL', input: vector.value, expected: encoded(vector.expected),
        error: { name: error.name, message: error.message } };
    }
  });
  const unchanged = fs.readFileSync(file).equals(original);
  return { status: checks.every(check => check.status === 'PASS') && unchanged ? 'PASS' : 'FAIL',
    timezone: process.env.TZ, observedTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    utcOffsetMinutesAtFixtureInstant: new Date(nowMs).getTimezoneOffset(), nowMs,
    sourceSha256: sha256(original), fixtureSourceUnchanged: unchanged, checks };
}
function run(supplied) {
  const file = ownedFixture(supplied), original = fs.readFileSync(file), sourceSha256 = sha256(original);
  const runs = timezones.map(timezone => {
    const child = spawnSync(process.execPath, [__filename, '--worker', file], {
      cwd: path.dirname(file), env: { ...process.env, TZ: timezone },
      encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
    });
    let report;
    try { report = JSON.parse(child.stdout); } catch { /* Malformed worker output remains a failed check. */ }
    const trustworthy = report && report.timezone === timezone && report.sourceSha256 === sourceSha256
      && report.checks?.length === vectors.length && report.fixtureSourceUnchanged === true;
    return { timezone, exitCode: child.status, signal: child.signal, timedOut: child.error?.code === 'ETIMEDOUT',
      status: trustworthy && child.status === 0 && report.status === 'PASS' ? 'PASS' : 'FAIL', report,
      stdoutSha256: sha256(child.stdout || ''), stderrSha256: sha256(child.stderr || ''),
      ...(child.error ? { error: { name: child.error.name, code: child.error.code } } : {}) };
  });
  const unchanged = fs.readFileSync(file).equals(original);
  const checks = runs.flatMap(run => run.report?.checks || []);
  return { status: runs.every(run => run.status === 'PASS') && unchanged ? 'PASS' : 'FAIL',
    checkedAt: new Date().toISOString(), oracleSha256: sha256(fs.readFileSync(__filename)),
    source: file, sourceSha256, nowMs, timezones, runs,
    passed: checks.filter(check => check.status === 'PASS').length,
    failed: checks.filter(check => check.status === 'FAIL').length,
    expectedChecks: timezones.length * vectors.length, fixtureSourceUnchanged: unchanged,
    realProviderInputs: 0, editorLaunches: 0, networkRequests: 0,
    authority: 'RFC 9110 section 5.6.7, HTTP-date represents GMT for all three accepted formats',
    scope: 'Read-only execution of one explicitly owned fixture in three separate Node subprocesses. No product, native fixture or user configuration is corrected.' };
}

module.exports = { run, worker, ownedFixture, timezones, vectors };
if (require.main === module) {
  try {
    const result = process.argv[2] === '--worker' ? worker(process.argv[3]) : run(process.argv[2]);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n'); process.exitCode = result.status === 'PASS' ? 0 : 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ status: 'FAIL', error: { name: error.name, message: error.message },
      realProviderInputs: 0, editorLaunches: 0, networkRequests: 0 }) + '\n'); process.exitCode = 1;
  }
}
