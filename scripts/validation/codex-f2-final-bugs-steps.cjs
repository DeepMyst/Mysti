/* Fresh final-three continuation; no deliberate faults or historical evidence rewriting. */
'use strict';
const assert = require('node:assert/strict');
const scoped = require('./codex-f2-scoped-campaign.cjs');
const TURN_COUNT = 16, FIRST_SEGMENT_COUNT = 7, BUILD_ORDINAL = 12;
const CASE_ORDER = Object.freeze(['F2-B08', 'F2-B10', 'F2-B11']);
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
const WEBHOOK = 'server/api/helpers/utils/send-webhooks.js', LIST = 'client/src/models/List.js';
function buildSteps(workspace) {
  const git = 'git --no-optional-locks -c diff.autoRefreshIndex=false -c core.fsmonitor=false -c core.hooksPath=/dev/null';
  const status = `${git} status --short`;
  const diff = `${git} --no-pager diff --no-ext-diff --no-textconv -- server/api/controllers/cards/update.js server/api/controllers/tasks/update.js server/api/helpers/cards/update-one.js server/api/controllers/labels/update.js server/api/controllers/cards/delete.js server/api/controllers/card-labels/create.js server/api/controllers/users/update.js server/api/helpers/utils/send-webhooks.js client/src/models/List.js client/src/components/Card/Tasks.jsx`;
  const policy = scoped.buildCommandPolicy(workspace);
  const prefix = Object.entries(policy.environment).map(([key, value]) => key + '=' + quote(value)).join(' ');
  const raw = [
    ['CHECKPOINT', 'Continue the verified nine-repair checkpoint in this separate copy. Reconcile the public inventory, protected note and actual diff with prior B01/B03/B09/B12/B02/B04/B05/B06/B07 repairs. Review both supplied checkpoint documents: the fresh twelve-case API/SQL and ORM/React baseline, and the preserved prior failure and wording notes. Report the actual nine passing and three failing results, distinguish historical outcomes from this fresh baseline, and explain the denied optional-chain B08 proposal without claiming it was applied or failed the array-domain behavior check. The root baseline is actual application/API validation; it does not establish native model tests/build, browser behavior or application-restart persistence for this continuation. Identify pending B08/B10/B11 and all six features. Report actual Node/npm task-runtime versions.', ['cat .pb02/public-issues.json .pb02/developer-notes.txt package.json', diff, status, 'node --version', 'npm --version'], { evidence: 'checkpoint' }],
    ['TRACE_WEBHOOK_EXCLUSION', 'Trace B08 webhook exclusions and configuration parsing. Distinguish absent/null, matching and nonmatching event arrays, and the legacy false/0 values that the unvalidated JSON configuration can pass through. Explain why the canonical truthiness guard preserves false/0 tolerance while optional chaining can throw; do not describe those undocumented values as documented array configurations. Preserve the URL guard, events allowlist, request-body behavior and ordinary delivery.', [`cat ${WEBHOOK} server/config/custom.js`]],
    ['FIX_WEBHOOK_EXCLUSION', 'Repair only B08 with one minimal native file patch. Restore this exact canonical block before the events allowlist: if (webhook.excludedEvents && webhook.excludedEvents.includes(inputs.event)) { return; } with the existing multiline formatting. The && guard is required to preserve legacy false/0 tolerance as well as the documented optional-array behavior. Preserve every prior repair, the URL guard, events allowlist and request-body behavior. Do not use optional chaining for this guard.', [`cat ${WEBHOOK}`], { patch: 'F2-B08' }],
    ['WEBHOOK_GREEN', 'Review the actual independent API/SQL and ORM/React results after B08. Identify positive receipts at both owned loopback sinks and the bounded exclusion observation, distinguishing a bounded absence from an unlimited no-delivery guarantee. Report remaining failures and do not turn the earlier pure guard controls into HTTP receipt evidence.', [], { evidence: 'B08' }],
    ['TRACE_ORDERING', 'Trace B10 card position ordering, including a position update. Preserve the prior B09 case-insensitive name search and leave B11 any-selected-member filtering for its separate task. Explain the smallest ordering correction.', [`cat ${LIST}`]],
    ['FIX_ORDERING', 'Repair only B10 ascending card position ordering with one minimal native file patch. Preserve B09 name search, the still-unfixed B11 member-filter behavior, all nine prior repairs and the new B08 guard.', [`cat ${LIST}`], { patch: 'F2-B10' }],
    ['RESTART_CHECKPOINT', 'Review the actual B10 ORM initial-order and position-update evidence and the current diff. Write a precise editor-restart checkpoint: eleven verified bug repairs, remaining B11, all six pending features, and exact scope of the prior failure and wording notes. Distinguish these API/ORM checks from browser coverage and application persistence. Preserve the staged note and original index.', [diff, status], { evidence: 'B10' }],
    ['RESTART_RESUME', 'The editor was restarted and this saved conversation was selected. Reconcile its checkpoint with actual files and the protected note. Confirm B08 and B10 remain repaired and B11 is still pending. Distinguish editor history restoration from application restart, native thread resumption and unperformed browser checks.', [diff, status, 'cat .pb02/developer-notes.txt']],
    ['TRACE_MEMBER_FILTER', 'Trace B11 any-selected-member filtering. Explain one-member and multiple-member filters, unassigned cards and no filter, while preserving B09 name search and repaired B10 ascending ordering.', [`cat ${LIST}`]],
    ['FIX_MEMBER_FILTER', 'Repair only B11 any-selected-member filtering with one minimal native file patch. Preserve B09 name search, B10 ordering, B08 webhook exclusions and every prior source change.', [`cat ${LIST}`], { patch: 'F2-B11' }],
    ['ALL_BUGS_GREEN', 'Review the independent twelve-case results after B11. State the actual API/SQL and ORM/React outcomes, distinguish nine preserved repairs from three new repairs, and keep all six unimplemented features pending. Existing isLocalId tests alone do not cover these seeded bugs.', [], { evidence: 'B11' }],
    ['BUILD_LINT', 'Run the existing client tests, client lint, server lint and client production build exactly once each. All twelve seeded bugs are repaired, so no seeded-lint exception applies. Report each first actual result without retry, substitution or automatic fixes. Source and tests must remain unchanged.', [
      prefix + ' npm --prefix client test -- --watchAll=false --runInBand --cacheDirectory=' + quote(policy.cacheDirectories.jest),
      prefix + ' ESLINT_USE_FLAT_CONFIG=false npm run client:lint',
      prefix + ' ESLINT_USE_FLAT_CONFIG=false npm run server:lint',
      prefix + ' GENERATE_SOURCEMAP=true ESLINT_USE_FLAT_CONFIG=false DISABLE_ESLINT_PLUGIN=false CI=false npm run client:build',
    ], { nativeBuild: true }],
    ['BROWSER_REVIEW', 'Review the independently captured real browser results for B01/B03/B09/B12/B10/B11. State the actual UI and reload observations, disclosed SQL fixtures and B10 API position setup; do not claim a drag interaction. Distinguish the independent browser rebuild from the native model build and API-only checks. This browser phase has not yet established the following application-restart result.', [], { evidence: 'browser' }],
    ['PERSISTENCE_REVIEW', 'Review the independently captured fresh application-runtime persistence evidence for the same six browser cases. Distinguish application restart, editor restart and PostgreSQL restart. Claim only observed cases and timestamps; do not credit future work to an earlier report.', [], { evidence: 'persistence' }],
    ['FINAL_SCOPE', 'Review the complete final diff, protected note and public inventory. Separate nine preserved repairs from B08/B10/B11 repaired here. Identify all six pending features and any untested behavior, while verifying the staged note and original index remain preserved.', [diff, status, 'cat .pb02/developer-notes.txt .pb02/public-issues.json']],
    ['HANDOFF', 'Use the final independent evidence and prior observed results to write a precise handoff. Report actual tests/lints/build, API/ORM checks, six browser cases and application persistence with their limits. Preserve the distinction between the earlier rejected attempt and this continuation, identify all six pending features, and avoid claims of full elapsed-session acceptance, native thread resume, broad helper quality or unrestricted permissions.', [], { evidence: 'final' }],
  ];
  assert.equal(raw.length, TURN_COUNT);
  return raw.map(([name, task, commands, extra], index) => ({ ordinal: index + 1,
    marker: `F2F_${String(index + 1).padStart(2, '0')}_${name}`, segment: index < FIRST_SEGMENT_COUNT ? 1 : 2,
    task, commands, requiresEscalation: commands.filter(command => command.startsWith(prefix + ' ')), ...extra }));
}
function promptFor(step, commands) {
  assert.deepEqual(commands.slice(0, step.commands.length), step.commands);
  let text = `PB02_REQUEST:${step.marker}\n${step.task}\nRun each listed command and report its observed result. Only these exact shell command bodies in the owned workspace are authorized: ${commands.map(JSON.stringify).join(', ') || '(none)'}. `;
  text += step.patch ? 'Use only native file-change/apply_patch for the single scoped proposal, never shell writes. ' : 'Do not edit files. ';
  text += 'Preserve the Git index, protected notes, prior repairs, other seeded issues and external oracles. No package installation, network/external tools or alternate commands. Keep the final answer focused on observed facts. End PB02_DONE:' + step.marker + '.';
  if (step.requiresEscalation.length) {
    text = text.replace('Do not edit files. ', 'Preserve source and test files. Only the declared commands may write generated test/npm/temp caches; the build command may additionally write client/build and CRA caches in client/node_modules/.cache. No other shell writes are authorized. ');
    text += ' For each of these exact commands, explicitly request native sandbox_permissions="require_escalated" with a command-specific justification through the normal approval card: ' + step.requiresEscalation.map(JSON.stringify).join(', ') + '. Keep the conversation untrusted/read-only policy. Do not request persistent permissions or change settings. If a command is denied or fails, report its first actual result; do not retry or substitute another command.';
  }
  return text;
}
function assertCommandResult({ result }) {
  assert.equal(result.status, 'completed', 'Every final-bug campaign command must complete');
  assert.equal(result.exitCode, 0, 'No seeded-lint or deliberate-error allowance applies');
}
function sessionQualification({ startedAt, endedAt, replies, restart }) {
  assert(Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt >= startedAt);
  assert.equal(replies.length, TURN_COUNT); assert.equal(new Set(replies.map(row => row.messageId)).size, TURN_COUNT);
  const minutes = (endedAt - startedAt) / 60000, issues = ['ORDINARY_MISTAKE_RECOVERY_REQUIRES_INDEPENDENT_SEMANTIC_REVIEW'];
  if (minutes < 45) issues.push('SHORTER_THAN_45_REAL_MINUTES');
  if (minutes > 60) issues.push('OUTSIDE_60_MINUTE_TARGET');
  if (!restart?.editorExited || !restart?.historyRestored || !restart?.priorMessagesPreserved) issues.push('REAL_EDITOR_RESTART_NOT_VERIFIED');
  return { status: 'PARTIAL_S_SESSION', elapsedMinutes: minutes, completedUsefulTurns: replies.length, issues,
    recoveryScope: 'Checkpoint evidence preserves actual earlier failure and wording notes; reviewing them alone earns no new mistake-recovery credit. No deliberate fault is injected.', W: 'NOT_RUN', E: 'NOT_RUN', P: 'NOT_RUN' };
}
module.exports = { TURN_COUNT, FIRST_SEGMENT_COUNT, BUILD_ORDINAL, CASE_ORDER, buildSteps, promptFor, assertCommandResult, sessionQualification };
