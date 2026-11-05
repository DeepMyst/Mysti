/* Read-only admission of the qualified asynchronous oracle and its phase journal. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const c = require('./codex-f2-webhook-verification-campaign.cjs');
const repo = path.resolve(__dirname, '../..');
const PHASES = Object.freeze(['preflight_scope_verification', 'implementation_identity_verification', 'postflight_scope_verification']);
function qualifiedRunner() {
  const qualification = c.pinned(c.BOUNDED_QUALIFICATION);
  assert.equal(qualification.status, 'PASS_BOUNDED_PHASE_TIMED_F05_INVOCATION_QUALIFICATION');
  assert.deepEqual(qualification.priorNativeCheckpoint, c.PRIOR_NATIVE_CHECKPOINT);
  assert.deepEqual(qualification.originalFeatureQualification, c.QUALIFICATION);
  const validation = c.pinned(qualification.validation), controls = c.pinned(qualification.controls);
  assert.equal(validation.status, 'FROZEN_OBSERVED_DEADLINE_F05_LOCAL_QUALIFICATION_INPUTS');
  assert.equal(qualification.controlsPassed, 20); assert.equal(validation.controlsPassed, 20);
  assert.deepEqual(validation.controls, qualification.controls);
  assert.equal(controls.checks.length, 20); assert(controls.checks.every(row => row.status === 'PASS'));
  assert.equal(validation.deadlineMs, 420000);
  const original = c.candidateProvenance().qualification;
  assert.deepEqual(qualification.coreImplementationPins, original.implementationPins.slice(0, 8));
  for (const pin of [...qualification.coreImplementationPins, ...qualification.runnerPins, validation.node]) assert.deepEqual(c.identity(pin.path), pin);
  const controller = qualification.runnerPins.find(pin => path.basename(pin.path) === 'bounded-child-deadline.cjs');
  const entry = qualification.runnerPins.find(pin => path.basename(pin.path) === 'timed-f05-entry.cjs');
  assert.equal(qualification.runnerPins.length, 2); assert(controller && entry); assert.deepEqual(validation.runner, controller);
  return { qualification, validation, controller, entry, node: validation.node,
    core: qualification.coreImplementationPins.find(pin => path.basename(pin.path) === 'f05-oracle.cjs'), runner: require(controller.path) };
}
// Pure record validation permits negative controls without changing real evidence.
function assertInvocationRecords({ execution, timing, feature, node, entry, core, runner, notBefore, notAfter }) {
  assert(Number.isFinite(notBefore) && Number.isFinite(notAfter) && notBefore <= notAfter);
  runner.requireSuccessfulInvocation(execution, 0);
  assert.equal(execution.expectedExit, 0); assert.equal(execution.expectedOutcomeVerified, true);
  assert.equal(execution.cwd, repo); assert.equal(execution.deadlineMs, 420000);
  assert.equal(execution.pollMs, 250); assert.equal(execution.graceMs, 5000); assert.deepEqual(execution.signals, []);
  const start = Date.parse(execution.startedAt), end = Date.parse(execution.finishedAt);
  assert(Number.isFinite(start) && Number.isFinite(end) && notBefore <= start && start <= end && end <= notAfter);
  assert.deepEqual(execution.command, [node.path, entry.path, feature.workspace, feature.artifact, feature.runtime, feature.scope.path, execution.timing.path]);
  assert.equal(path.dirname(execution.timing.path), path.dirname(feature.artifact));
  assert.equal(feature.status, 'PASS_F05_SIGNED_WEBHOOKS');
  assert(Number.isSafeInteger(execution.pid) && execution.pid > 1);
  assert.equal(execution.rootIdentity.pid, execution.pid); assert.equal(execution.rootIdentity.uid, process.getuid());
  assert.equal(feature.receiver.pid, execution.pid, 'The raw receiver and timing journal belong to this actual oracle child');
  assert(execution.observed.length > 0 && execution.observed.length <= 16);
  assert.equal(new Set(execution.observed.map(row => runner.key(row))).size, execution.observed.length);
  assert(execution.observed.some(row => runner.sameBirth(row, execution.rootIdentity)));
  for (const row of execution.observed) assert.equal(row.uid, execution.rootIdentity.uid);
  assert.equal(timing.length, 8); assert.deepEqual(timing.map(row => row.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(timing.map(row => row.event), ['entry-start', 'phase-start', 'phase-end', 'phase-start', 'phase-end', 'phase-start', 'phase-end', 'entry-result']);
  for (const [index, row] of timing.entries()) {
    assert(Number.isFinite(row.at) && start <= row.at && row.at <= execution.closed.at);
    assert(Number.isFinite(row.entryElapsedMs) && row.entryElapsedMs >= 0 && row.entryElapsedMs < execution.closed.elapsedMs);
    if (index) { assert(row.at >= timing[index - 1].at); assert(row.entryElapsedMs >= timing[index - 1].entryElapsedMs); }
  }
  assert.deepEqual(timing[0].wrapper, entry); assert.deepEqual(timing[0].core, core); assert.equal(timing[0].pid, execution.pid);
  for (const [index, phase] of PHASES.entries()) {
    const began = timing[index * 2 + 1], ended = timing[index * 2 + 2];
    assert.equal(began.phase, phase); assert.equal(ended.phase, phase); assert.equal(ended.outcome, 'returned');
    assert.equal(ended.error, undefined); assert(Number.isFinite(ended.elapsedMs) && ended.elapsedMs >= 0 && ended.elapsedMs <= ended.entryElapsedMs);
  }
  assert.equal(timing[7].status, feature.status); assert(Array.isArray(timing[7].activeResourceTypes));
  assert.deepEqual(execution.phaseTimings, timing.filter(row => row.event === 'phase-end'));
  const featureStart = Date.parse(feature.startedAt), featureEnd = Date.parse(feature.finishedAt);
  assert(timing[4].at <= featureStart && featureStart <= featureEnd && featureEnd <= timing[7].at);
  assert(feature.receiver.closedAt <= timing[5].at && timing[6].at <= featureEnd);
  assert(start <= execution.terminal.at && execution.terminal.at <= execution.closed.at && execution.closed.at <= end);
  assert(execution.terminal.elapsedMs <= execution.closed.elapsedMs && execution.closed.elapsedMs <= execution.elapsedMs);
  return { status: 'PASS_BOUNDED_F05_INVOCATION', exitCode: 0, deadlineMs: execution.deadlineMs,
    closedElapsedMs: execution.closed.elapsedMs, phases: execution.phaseTimings, observedIdentities: execution.observed.length,
    scope: 'Actual direct-child exit and close before the monotonic deadline. Sampled identities only; no exhaustive descendant or native-model credit.' };
}
function assertBoundedInvocation({ featurePin, executionPin, timingPin, nodeIdentity, evidenceDirectory, notBefore, notAfter }) {
  const qualified = qualifiedRunner(); assert.deepEqual(nodeIdentity, qualified.node);
  for (const pin of [featurePin, executionPin, timingPin]) {
    c.contained(evidenceDirectory, pin.path); assert.equal(fs.realpathSync(pin.path), pin.path);
    const stat = fs.lstatSync(pin.path); assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid());
    assert.deepEqual(c.identity(pin.path), pin);
  }
  const feature = c.pinned(featurePin), execution = c.pinned(executionPin);
  assert.deepEqual(execution.functionalReport, featurePin); assert.deepEqual(execution.timing, timingPin);
  const timing = fs.readFileSync(timingPin.path, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const result = assertInvocationRecords({ ...qualified, execution, timing, feature, node: nodeIdentity, notBefore, notAfter });
  return { ...result, qualification: c.BOUNDED_QUALIFICATION, controller: qualified.controller, entry: qualified.entry,
    feature: featurePin, execution: executionPin, timing: timingPin };
}
module.exports = { PHASES, qualifiedRunner, assertInvocationRecords, assertBoundedInvocation };
