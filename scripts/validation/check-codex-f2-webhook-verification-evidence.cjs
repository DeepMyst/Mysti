/* Synthetic root-wrapper/auditor integration. No runtime, editor or model starts. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const c = require('./codex-f2-webhook-verification-campaign.cjs');
const audit = require('./audit-vscode-codex-f2-webhook-verification.cjs');
const bounded = require('./codex-f2-webhook-verification-invocation.cjs');
const root = path.resolve(__dirname, '../../out-test/feature-tests/PB-02'), base = path.join(root, 'overnight-20261011');
const helper = require(path.join(base, 'root-webhook-verification-oracle-checks.cjs'));
const directory = fs.mkdtempSync(path.join(root, 'f2-webhook-verification-evidence-controls-'));
const checks = [], copy = value => JSON.parse(JSON.stringify(value)); let serial = 0;
const test = (name, run) => { try { run(); checks.push({ name, status: 'PASS' }); } catch (error) { checks.push({ name, status: 'FAIL', error: error.stack }); } };
const checkpoint = c.pinned(c.PRIOR_NATIVE_CHECKPOINT), qualified = bounded.qualifiedRunner(), positive = qualified.qualification.cases.find(row => row.label === 'positive');
const originalFeature = c.pinned(positive.functionalReport), originalExecution = c.pinned(positive.execution), originalBugs = c.pinned(checkpoint.regressions);
const originalTiming = fs.readFileSync(positive.timing.path, 'utf8');
const write = (file, data) => { fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); return c.identity(file); };
function fixture(kind = 'checkpoint') {
  const campaignDirectory = path.join(directory, 'case-' + (++serial)); fs.mkdirSync(campaignDirectory);
  const workspace = path.join(campaignDirectory, 'workspace'); fs.mkdirSync(workspace);
  const evidenceDirectory = path.join(campaignDirectory, 'evidence'); fs.mkdirSync(evidenceDirectory);
  for (const name of ['checkpoint', 'validation', 'final']) fs.mkdirSync(path.join(evidenceDirectory, name));
  const evidenceRoot = path.join(evidenceDirectory, kind === 'final' ? 'validation' : kind);
  const artifact = path.join(evidenceRoot, 'feature'); fs.mkdirSync(artifact);
  const campaign = { directory: campaignDirectory, workspace, evidenceDirectory, priorBinding: c.PRIOR_NATIVE_CHECKPOINT,
    nodeIdentity: qualified.node, fixture: { workspace, repairs: {}, indexSha256: checkpoint.sourceSnapshot.indexSha256,
      files: Object.fromEntries(Object.entries(checkpoint.sourceSnapshot.hashes).map(([relative, sha256]) => [relative, { sha256 }])) } };
  const feature = copy(originalFeature); feature.workspace = workspace; feature.artifact = artifact; feature.runtime = path.join(campaignDirectory, 'runtime');
  const scope = c.pinned(feature.scope); scope.workspace = workspace; scope.runtime = feature.runtime;
  feature.scope = write(path.join(evidenceRoot, 'scope.json'), scope);
  for (const row of feature.finalChecks.checkedLogs) { const target = path.join(artifact, path.basename(row.path)); fs.copyFileSync(row.path, target, fs.constants.COPYFILE_EXCL); row.path = target; }
  const bugs = copy(originalBugs); bugs.workspace = workspace;
  const bugRegressionReport = write(path.join(evidenceRoot, 'regressions.json'), bugs), featureReport = write(path.join(artifact, 'result.json'), feature);
  const timingFile = path.join(evidenceRoot, 'timing.jsonl'); fs.writeFileSync(timingFile, originalTiming, { flag: 'wx' }); const phaseTiming = c.identity(timingFile);
  const execution = copy(originalExecution); execution.command = [qualified.node.path, qualified.entry.path, workspace, artifact, feature.runtime, feature.scope.path, timingFile];
  execution.functionalReport = featureReport; execution.timing = phaseTiming;
  const oracleInvocation = write(path.join(evidenceRoot, 'execution.json'), execution);
  const report = helper.wrapper({ campaign }, kind, featureReport, bugRegressionReport, oracleInvocation, phaseTiming);
  const reportPin = write(path.join(evidenceDirectory, kind, 'review.json'), report);
  const lintStep = c.buildSteps(workspace)[c.LINT_ORDINAL - 1];
  return { campaign, report, reportPin, execution, feature, bugs, kind, lintStep, lintResult: { status: 'completed', exitCode: 0 }, evidenceWindow: { notBefore: 0, notAfter: Date.now() } };
}
function updateReport(value) { fs.writeFileSync(value.reportPin.path, JSON.stringify(value.report)); value.reportPin = c.identity(value.reportPin.path); }
for (const kind of ['checkpoint', 'validation', 'final']) test(kind + ' positive evidence joins the qualified invocation', () => {
  const value = fixture(kind), result = audit.auditFeatureReport(value); assert.equal(result.invocation.status, 'PASS_BOUNDED_F05_INVOCATION');
  assert.deepEqual(result.result.featureIds, kind === 'checkpoint' ? [] : [c.FEATURE_ID]);
});
for (const [name, change] of [
  ['old absent-baseline wrapper', value => { value.report.status = 'VERIFIED_F05_ABSENT_BASELINE'; }],
  ['missing invocation', value => { delete value.report.oracleInvocation; }],
  ['missing phase journal', value => { delete value.report.phaseTiming; }],
  ['changed invocation digest', value => { value.report.oracleInvocation.sha256 = '0'.repeat(64); }],
  ['changed journal digest', value => { value.report.phaseTiming.sha256 = '0'.repeat(64); }],
  ['wrong prior binding', value => { value.report.priorBinding = { ...c.PRIOR_NATIVE_CHECKPOINT, sha256: '0'.repeat(64) }; }],
  ['premature lint credit', value => { value.report.nativeLint = 'JOINED_SEPARATELY_BY_NATIVE_AUDIT'; }],
]) test('Evidence wrapper rejects ' + name, () => { const value = fixture(); change(value); updateReport(value); assert.throws(() => audit.auditFeatureReport(value)); });
test('Historical parent timeout stays rejected even after positive receipts are supplied', () => {
  const value = fixture(), failed = c.pinned(checkpoint.oracleInvocation); fs.writeFileSync(value.report.oracleInvocation.path, JSON.stringify(failed));
  value.report.oracleInvocation = c.identity(value.report.oracleInvocation.path); updateReport(value); assert.throws(() => audit.auditFeatureReport(value));
});
test('Invocation from a different evidence root rejects', () => { const value = fixture(); value.report.oracleInvocation = positive.execution; updateReport(value); assert.throws(() => audit.auditFeatureReport(value)); });
test('Final reference helper carries all four exact validation pins', () => {
  const value = fixture('validation'), refs = helper.finalReferences(value.report, value.campaign);
  assert.deepEqual(refs, Object.fromEntries(['featureReport', 'bugRegressionReport', 'oracleInvocation', 'phaseTiming'].map(key => [key, value.report[key]])));
});
test('Final reference helper refuses to use checkpoint evidence', () => { const value = fixture(); assert.throws(() => helper.finalReferences(value.report, value.campaign)); });
test('Final feature acceptance requires successful native lint', () => { const value = fixture('final'); value.lintResult.exitCode = 1; assert.throws(() => audit.auditFeatureReport(value)); });
test('Prior context reports partial historical acceptance and no new patches', () => {
  const value = fixture(), context = helper.contextDocument(value.campaign, value.reportPin), contextPin = write(path.join(value.campaign.evidenceDirectory, 'checkpoint/prior-context.json'), context);
  assert.deepEqual(context.priorAcceptedFeatures, []); assert.deepEqual(context.newPatchIds, []); assert.deepEqual(context.historicalPatchIds, c.HISTORICAL_PATCH_IDS);
  audit.auditPriorContext(value.campaign, contextPin, value.reportPin);
});
const report = { status: checks.every(row => row.status === 'PASS') ? 'PASS_SYNTHETIC_EVIDENCE_INTEGRATION' : 'FAIL', checks,
  sources: [__filename, require.resolve('./audit-vscode-codex-f2-webhook-verification.cjs'), require.resolve('./codex-f2-webhook-verification-invocation.cjs'), path.join(base, 'root-webhook-verification-oracle-checks.cjs')].map(c.identity),
  nativeInputs: 0, applicationLaunches: 0, editorLaunches: 0,
  scope: 'Synthetic rebasing of preserved actual positive receipts and timing to owned control documents. This tests admission interfaces, not fresh application or native acceptance.' };
const target = path.join(directory, 'checks.json'); write(target, report);
console.log(JSON.stringify({ report: c.identity(target), checks: checks.length, failures: checks.filter(row => row.status !== 'PASS') }));
if (report.status === 'FAIL') process.exitCode = 1;
