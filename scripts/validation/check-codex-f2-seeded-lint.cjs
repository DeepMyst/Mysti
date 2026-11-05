/* Retained native reproduction and narrow negative controls. No process/model launch. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const c = require('./codex-f2-compact-campaign.cjs');
const root = path.resolve(__dirname, '../../out-test/feature-tests/PB-02');
const directory = fs.mkdtempSync(path.join(root, 'f2-seeded-lint-controls-'));
const native = path.join(root, 'overnight-20261011/native-f2-scoped-session');
const eventsFile = path.join(native, 'segment-2/window-A/events.json');
const events = JSON.parse(fs.readFileSync(eventsFile, 'utf8'));
const actual = events.filter(row => row.type === 'toolResult' && String(row.payload?.input?.command).includes('npm run server:lint'));
assert.equal(actual.length, 1);
const live = actual[0].payload, workspace = live.input.cwd, steps = c.buildSteps(workspace);
const checks = [], check = (name, fn) => { fn(); checks.push({ name, status: 'PASS' }); };
const candidate = () => ({ step: { ...steps[20] }, command: live.input.command, workspace, output: live.output, result: { status: live.status, exitCode: 1 } });
check('exact retained native server lint output matches the characterized seeded diagnostics', () => {
  assert.equal(live.output, c.expectedSeededLintOutput(workspace));
  assert.equal(c.assertCommandResult(candidate()), 'EXPECTED_SEEDED_LINT_FAILURE');
});
for (const [name, mutate] of [
  ['extra diagnostic', v => { v.output += 'new error\n'; }],
  ['missing diagnostic', v => { v.output = v.output.replace('  47:1  error  Delete `⏎`  prettier/prettier\n', ''); }],
  ['different file', v => { v.output = v.output.replace('cards/delete.js', 'cards/update.js'); }],
  ['different line', v => { v.output = v.output.replace('47:1', '48:1'); }],
  ['different rule', v => { v.output = v.output.replace('prettier/prettier', 'no-undef'); }],
  ['warning', v => { v.output = v.output.replace('0 warnings)', '1 warning)'); }],
  ['exit zero', v => { v.result.exitCode = 0; }],
  ['exit two', v => { v.result.exitCode = 2; }],
  ['unknown exit', v => { v.result.exitCode = null; }],
  ['successful native status', v => { v.result.status = 'completed'; }],
  ['another task ordinal', v => { v.step.ordinal = 20; }],
  ['another task marker', v => { v.step.marker = 'OTHER'; }],
  ['step-wide nonzero override', v => { v.step.expectedNonzero = true; }],
  ['substituted server command', v => { v.command += ' && true'; }],
  ['client lint failure', v => { v.command = steps[20].commands[0]; }],
  ['build failure', v => { v.command = steps[20].commands[2]; }],
  ['other workspace output', v => { v.output = v.output.replace(workspace, directory); }],
  ['changed step cannot authorize alternate command', v => { v.command = 'false'; v.step.commands = ['false']; }],
]) check(`rejects ${name}`, () => { const value = candidate(); mutate(value); assert.throws(() => c.assertCommandResult(value)); });
for (const index of [0, 2]) check(`build/lint command${index} still requires normal success`, () => {
  assert.equal(c.assertCommandResult({ ...candidate(), command: steps[20].commands[index], result: { status: 'completed', exitCode: 0 }, output: 'successful output' }), 'SUCCESS');
});
check('injected missing script stays a distinct exact command failure', () => {
  const value = { ...candidate(), step: steps[5], command: steps[5].commands[0], output: 'npm error Missing script: "client:tset"\n' };
  assert.equal(c.assertCommandResult(value), 'EXPECTED_INJECTED_MISSING_SCRIPT');
  assert.throws(() => c.assertCommandResult({ ...value, output: 'network failure' }));
});
const characterization = path.join(root, 'overnight-20261011/f2-seeded-lint-characterization-5e6ao5jz/review.json');
const report = { status: 'PASS_RETAINED_NATIVE_AND_NARROW_CONTROLS', at: new Date().toISOString(), checks,
  identities: [__filename, require.resolve('./codex-f2-seeded-lint.cjs'), require.resolve('./codex-f2-compact-campaign.cjs'), eventsFile, characterization].map(c.identity),
  scope: 'One retained native command plus synthetic negative controls. No new lint execution, native launch, generated repair, or full workflow credit.' };
const file = path.join(directory, 'checks.json'); fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ path: file, sha256: c.identity(file).sha256, status: report.status, passed: checks.length }));
