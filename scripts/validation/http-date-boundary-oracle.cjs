/* Successor PB-02 date oracle. Preserves the original pinned 45-check oracle. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const baselinePath = require.resolve('./http-date-portability-oracle.cjs');
const baseline = require(baselinePath);
const evidenceRoot = path.resolve(__dirname, '../../out-test/feature-tests/PB-02');
const timezones = ['UTC', 'Asia/Amman', 'America/Los_Angeles'];
const baselineNowMs = Date.UTC(1994, 10, 6, 8, 49, 30);
const vectorSet = 'PB02_HTTP_DATE_BOUNDARIES_V1';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const encoded = value => value === undefined ? { type: 'undefined' }
  : typeof value === 'number' && !Number.isFinite(value) ? { type: 'nonfinite', value: String(value) }
    : { type: typeof value, value };

// Retain every original value, expected result and 1994 fixture instant.
const vectors = baseline.vectors.map(vector => ({ ...vector, nowMs: baselineNowMs, group: 'original-portability' }));
for (const [day, weekday] of [[1, 'Tue'], [6, 'Sun'], [9, 'Wed']]) {
  const padded = String(day).padStart(2, '0'), nowMs = Date.UTC(1994, 10, day, 8, 49, 30);
  vectors.push(
    { name: `Q03 asctime zero-padded day ${padded}`, value: `${weekday} Nov ${padded} 08:49:37 1994`, nowMs, expected: 7000, group: 'asctime-day-representation' },
    { name: `Q03 equivalent space-padded day ${padded}`, value: `${weekday} Nov  ${day} 08:49:37 1994`, nowMs, expected: 7000, group: 'asctime-day-representation' },
    { name: `Q03 equivalent IMF day ${padded}`, value: `${weekday}, ${padded} Nov 1994 08:49:37 GMT`, nowMs, expected: 7000, group: 'asctime-day-representation' },
  );
}
// These historical century examples are anchored by RFC5322 section4.3's
// 00–49 interpretation and do not trigger RFC9110's >50-years-future rule.
// nowMs is the caller's supplied fixture clock, never the machine wall clock.
vectors.push(
  { name: 'Q04 RFC850 next-century 2000 from 1999', value: 'Saturday, 01-Jan-00 00:00:00 GMT', nowMs: Date.UTC(1999, 11, 31, 23, 59, 53), expected: 7000, group: 'rfc850-century' },
  { name: 'Q04 equivalent IMF 2000 from 1999', value: 'Sat, 01 Jan 2000 00:00:00 GMT', nowMs: Date.UTC(1999, 11, 31, 23, 59, 53), expected: 7000, group: 'rfc850-century' },
  { name: 'Q04 equivalent asctime 2000 from 1999', value: 'Sat Jan  1 00:00:00 2000', nowMs: Date.UTC(1999, 11, 31, 23, 59, 53), expected: 7000, group: 'rfc850-century' },
  { name: 'Q04 RFC850 next-century 2005 from 1994', value: 'Sunday, 06-Nov-05 08:49:37 GMT', nowMs: baselineNowMs, expected: 347155207000, group: 'rfc850-century' },
  { name: 'Q04 equivalent IMF 2005 from 1994', value: 'Sun, 06 Nov 2005 08:49:37 GMT', nowMs: baselineNowMs, expected: 347155207000, group: 'rfc850-century' },
  { name: 'Q04 equivalent asctime 2005 from 1994', value: 'Sun Nov  6 08:49:37 2005', nowMs: baselineNowMs, expected: 347155207000, group: 'rfc850-century' },
  { name: 'RFC850 same-century 2027 from 2026 control', value: 'Saturday, 06-Nov-27 08:49:37 GMT', nowMs: Date.UTC(2026, 10, 6, 8, 49, 30), expected: 31536007000, group: 'rfc850-preservation' },
  { name: 'Equivalent IMF 2027 from 2026 control', value: 'Sat, 06 Nov 2027 08:49:37 GMT', nowMs: Date.UTC(2026, 10, 6, 8, 49, 30), expected: 31536007000, group: 'rfc850-preservation' },
  { name: 'Equivalent asctime 2027 from 2026 control', value: 'Sat Nov  6 08:49:37 2027', nowMs: Date.UTC(2026, 10, 6, 8, 49, 30), expected: 31536007000, group: 'rfc850-preservation' },
  { name: 'RFC850 over-fifty-future 77 maps to past 1977 control', value: 'Sunday, 06-Nov-77 08:49:37 GMT', nowMs: Date.UTC(2026, 10, 6, 8, 49, 30), expected: 0, group: 'rfc850-preservation' },
  { name: 'Equivalent IMF past 1977 control', value: 'Sun, 06 Nov 1977 08:49:37 GMT', nowMs: Date.UTC(2026, 10, 6, 8, 49, 30), expected: 0, group: 'rfc850-preservation' },
  { name: 'Equivalent asctime past 1977 control', value: 'Sun Nov  6 08:49:37 1977', nowMs: Date.UTC(2026, 10, 6, 8, 49, 30), expected: 0, group: 'rfc850-preservation' },
);
// RFC9110 says MORE than fifty years: preserve the exact timestamp boundary.
// The two-digit44 field initially denotes2044 (RFC5322); one second beyond
// the cutoff denotes1944, the most recent past year with the same last digits.
vectors.push(
  { name: 'RFC850 one second before fifty-year cutoff', value: 'Sunday, 06-Nov-44 08:49:29 GMT', nowMs: baselineNowMs, expected: 1577923199000, group: 'rfc850-fifty-year-boundary' },
  { name: 'Equivalent IMF before fifty-year cutoff', value: 'Sun, 06 Nov 2044 08:49:29 GMT', nowMs: baselineNowMs, expected: 1577923199000, group: 'rfc850-fifty-year-boundary' },
  { name: 'Equivalent asctime before fifty-year cutoff', value: 'Sun Nov  6 08:49:29 2044', nowMs: baselineNowMs, expected: 1577923199000, group: 'rfc850-fifty-year-boundary' },
  { name: 'RFC850 exactly at fifty-year cutoff', value: 'Sunday, 06-Nov-44 08:49:30 GMT', nowMs: baselineNowMs, expected: 1577923200000, group: 'rfc850-fifty-year-boundary' },
  { name: 'Equivalent IMF exactly at fifty-year cutoff', value: 'Sun, 06 Nov 2044 08:49:30 GMT', nowMs: baselineNowMs, expected: 1577923200000, group: 'rfc850-fifty-year-boundary' },
  { name: 'Equivalent asctime exactly at fifty-year cutoff', value: 'Sun Nov  6 08:49:30 2044', nowMs: baselineNowMs, expected: 1577923200000, group: 'rfc850-fifty-year-boundary' },
  { name: 'RFC850 one second after cutoff maps to past1944', value: 'Monday, 06-Nov-44 08:49:31 GMT', nowMs: baselineNowMs, expected: 0, group: 'rfc850-fifty-year-boundary' },
  { name: 'Equivalent IMF past1944 after cutoff', value: 'Mon, 06 Nov 1944 08:49:31 GMT', nowMs: baselineNowMs, expected: 0, group: 'rfc850-fifty-year-boundary' },
  { name: 'Equivalent asctime past1944 after cutoff', value: 'Mon Nov  6 08:49:31 1944', nowMs: baselineNowMs, expected: 0, group: 'rfc850-fifty-year-boundary' },
);
const vectorManifest = vectors.map(vector => ({ name: vector.name, group: vector.group,
  input: vector.value, nowMs: vector.nowMs, expected: encoded(vector.expected) }));
const vectorSetSha256 = sha256(JSON.stringify(vectorManifest));
assert.equal(vectors.length, 45); assert.equal(new Set(vectors.map(vector => vector.name)).size, vectors.length);

function ownedFixture(supplied) {
  assert.equal(typeof supplied, 'string', 'Supply one owned PB-02 src/retry.cjs');
  const root = fs.realpathSync(evidenceRoot), file = fs.realpathSync(supplied);
  assert(file.startsWith(root + path.sep), 'Only realpath-confined PB-02 fixtures are allowed');
  assert.equal(path.basename(file), 'retry.cjs'); assert.equal(path.basename(path.dirname(file)), 'src');
  assert(fs.statSync(file).isFile()); return file;
}
function worker(supplied) {
  const file = ownedFixture(supplied), original = fs.readFileSync(file);
  assert(timezones.includes(process.env.TZ), 'Worker requires an explicit tested timezone');
  const api = require(file); assert.equal(typeof api.retryAfterMs, 'function');
  const checks = vectors.map((vector, index) => {
    try {
      const actual = api.retryAfterMs(vector.value, vector.nowMs);
      return { ...vectorManifest[index], actual: encoded(actual), status: Object.is(actual, vector.expected) ? 'PASS' : 'FAIL' };
    } catch (error) {
      return { ...vectorManifest[index], status: 'FAIL', error: { name: error.name, message: error.message } };
    }
  });
  const fixtureSourceUnchanged = fs.readFileSync(file).equals(original);
  return { status: fixtureSourceUnchanged && checks.every(check => check.status === 'PASS') ? 'PASS' : 'FAIL',
    vectorSet, vectorSetSha256, timezone: process.env.TZ, observedTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    sourceSha256: sha256(original), fixtureSourceUnchanged, checks };
}
function run(supplied) {
  const file = ownedFixture(supplied), original = fs.readFileSync(file), sourceSha256 = sha256(original);
  const runs = timezones.map(timezone => {
    const child = spawnSync(process.execPath, [__filename, '--worker', file], {
      cwd: path.dirname(file), env: { ...process.env, TZ: timezone }, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
    });
    let report;
    try { report = JSON.parse(child.stdout); } catch { /* Malformed output is a failed run. */ }
    const trustworthy = report && report.timezone === timezone && report.sourceSha256 === sourceSha256
      && report.vectorSet === vectorSet && report.vectorSetSha256 === vectorSetSha256 && report.fixtureSourceUnchanged === true
      && Array.isArray(report.checks) && report.checks.length === vectors.length && report.checks.every((check, index) =>
        JSON.stringify({ name: check.name, group: check.group, input: check.input, nowMs: check.nowMs, expected: check.expected }) === JSON.stringify(vectorManifest[index]));
    return { timezone, exitCode: child.status, signal: child.signal, timedOut: child.error?.code === 'ETIMEDOUT',
      status: trustworthy && child.status === 0 && report.status === 'PASS' && report.checks.every(check => check.status === 'PASS'
        && JSON.stringify(check.actual) === JSON.stringify(check.expected)) ? 'PASS' : 'FAIL', report,
      stdoutSha256: sha256(child.stdout || ''), stderrSha256: sha256(child.stderr || ''),
      ...(child.error ? { error: { name: child.error.name, code: child.error.code } } : {}) };
  });
  const fixtureSourceUnchanged = fs.readFileSync(file).equals(original), checks = runs.flatMap(run => run.report?.checks || []);
  return { schema: 1, status: fixtureSourceUnchanged && runs.every(run => run.status === 'PASS') ? 'PASS' : 'FAIL',
    checkedAt: new Date().toISOString(), oracleSha256: sha256(fs.readFileSync(__filename)), source: file, sourceSha256,
    vectorSet, vectorSetSha256, vectorCount: vectors.length, addedVectorCount: vectors.length - baseline.vectors.length,
    baselineOracle: { path: baselinePath, sha256: sha256(fs.readFileSync(baselinePath)), vectorCount: baseline.vectors.length,
      expectedChecks: timezones.length * baseline.vectors.length, nowMs: baselineNowMs },
    timezones, runs, passed: checks.filter(check => check.status === 'PASS').length,
    failed: checks.filter(check => check.status === 'FAIL').length, expectedChecks: timezones.length * vectors.length,
    fixtureSourceUnchanged, realProviderInputs: 0, editorLaunches: 0, networkRequests: 0,
    authority: [
      { url: 'https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.7', scope: 'Three GMT forms; asctime two-digit or space-padded day; RFC850 over-fifty-years-future correction.' },
      { url: 'https://www.rfc-editor.org/rfc/rfc5322.html#section-4.3', scope: '00–49 year interpretation anchors historical 1999/2000 and1994/2005 examples, which do not trigger the HTTP future correction.' },
    ],
    scope: 'Read-only calls against one owned PB-02 fixture in three fresh Node processes. Retains all original45 checks and adds90. Caller-supplied clocks, not wall-clock assumptions. No provider request or repair is performed.' };
}
module.exports = { run, worker, ownedFixture, timezones, vectors, vectorManifest, vectorSet, vectorSetSha256, encoded };
if (require.main === module) {
  try {
    const report = process.argv[2] === '--worker' ? worker(process.argv[3]) : run(process.argv[2]);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n'); process.exitCode = report.status === 'PASS' ? 0 : 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ status: 'FAIL', error: { name: error.name, message: error.message },
      realProviderInputs: 0, editorLaunches: 0, networkRequests: 0 }) + '\n'); process.exitCode = 1;
  }
}
