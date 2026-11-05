/* Fresh final-pair continuation; all previous attempts and evidence stay frozen. */
'use strict';
const assert = require('node:assert/strict');
const scoped = require('./codex-f2-scoped-campaign.cjs');
const TURN_COUNT = 12, FIRST_SEGMENT_COUNT = 6, BUILD_ORDINAL = 8;
const CASE_ORDER = Object.freeze(['F2-B10', 'F2-B11']);
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
const LIST = 'client/src/models/List.js';
function buildSteps(workspace) {
  const git = 'git --no-optional-locks -c diff.autoRefreshIndex=false -c core.fsmonitor=false -c core.hooksPath=/dev/null';
  const status = `${git} status --short`;
  const diff = `${git} --no-pager diff --no-ext-diff --no-textconv -- server/api/controllers/cards/update.js server/api/controllers/tasks/update.js server/api/helpers/cards/update-one.js server/api/controllers/labels/update.js server/api/controllers/cards/delete.js server/api/controllers/card-labels/create.js server/api/controllers/users/update.js server/api/helpers/utils/send-webhooks.js client/src/models/List.js client/src/components/Card/Tasks.jsx`;
  const policy = scoped.buildCommandPolicy(workspace);
  const prefix = Object.entries(policy.environment).map(([key, value]) => key + '=' + quote(value)).join(' ');
  const raw = [
    ['CHECKPOINT', 'Continue the verified ten-repair checkpoint in this separate copy. Reconcile the public inventory, protected note and actual diff with preserved B01/B03/B09/B12/B02/B04/B05/B06/B07/B08 repairs. Read both supplied checkpoint documents: the fresh twelve-case API/SQL and ORM/React baseline and the preserved prior failure and wording notes. State the actual ten passing and two failing results. The previous B10 proposal used an explicit true ordering argument and was denied by exact canonical-byte scope before application; do not describe it as an observed application failure. This fresh baseline is actual application/API validation; native model tests/build, browser behavior and application-restart persistence remain pending. Identify B10/B11 and all six features. Report actual Node/npm task-runtime versions.', ['cat .pb02/public-issues.json .pb02/developer-notes.txt package.json', diff, status, 'node --version', 'npm --version'], { evidence: 'checkpoint' }],
    ['TRACE_ORDERING', "Trace B10 initial card position ordering and a position update. The required canonical source is exactly return this.cards.orderBy('position'); with its second argument omitted. Explain the smallest correction while preserving B09 name search, seeded B11 filtering, and all ten prior repairs. Equivalent explicit true is outside this prequalified patch scope.", [`cat ${LIST}`]],
    ['FIX_ORDERING', "Repair only B10 with one minimal native file patch. Replace exactly return this.cards.orderBy('position', false); with exactly return this.cards.orderBy('position'); using existing indentation and line ending. Omit the second argument; do not substitute true, an options object, sorting expression or another equivalent implementation. Preserve B09 search, still-unfixed B11 member filtering and all ten prior repairs. No other byte changes.", [`cat ${LIST}`], { patch: 'F2-B10' }],
    ['ORDERING_GREEN_AND_TRACE_MEMBER_FILTER', 'Read actual B10 results showing eleven passing cases and only B11 still failing, including initial ordering and the position-update check. Then trace B11 any-selected-member filtering in List.js: one or multiple selected members, unassigned cards and no filter. Distinguish ORM assertions from browser behavior; preserve B09 search and repaired B10 ordering.', [`cat ${LIST}`], { evidence: 'B10' }],
    ['FIX_MEMBER_FILTER', 'Repair only B11 with one minimal native file patch. Replace exactly return users.every((user) => filterUserIds.includes(user.id)); with exactly return users.some((user) => filterUserIds.includes(user.id)); using existing indentation and line ending. Preserve B09 search, the exact repaired B10 ordering line, B08 webhook guard and all ten prior repairs. No other byte changes.', [`cat ${LIST}`], { patch: 'F2-B11' }],
    ['ALL_BUGS_GREEN_RESTART_CHECKPOINT', 'Review the actual independent B11 evidence: all twelve API/SQL and ORM/React cases must now pass. Reconcile the diff and status, distinguishing ten preserved repairs from B10/B11 newly repaired here. Write a precise editor-restart checkpoint in this conversation, with all six features pending. These checks do not establish native tests/build, browser behavior or application-restart persistence. Preserve the staged note and original index.', [diff, status], { evidence: 'B11' }],
    ['RESTART_RESUME', 'The editor was restarted and this saved conversation was selected. Reconcile its all-twelve checkpoint with actual files and the protected note. Distinguish editor history restoration from application restart, native thread resumption and unperformed browser checks. Preserve the distinction between the prior failed campaign and this separate continuation.', [diff, status, 'cat .pb02/developer-notes.txt']],
    ['BUILD_LINT', 'Run existing client tests, client lint, server lint and client production build exactly once each. All twelve seeded bugs are repaired, so no seeded-lint exception applies. Report each first actual result without retry, substitution or automatic fixes. Source and tests must remain unchanged.', [
      prefix + ' npm --prefix client test -- --watchAll=false --runInBand --cacheDirectory=' + quote(policy.cacheDirectories.jest),
      prefix + ' ESLINT_USE_FLAT_CONFIG=false npm run client:lint',
      prefix + ' ESLINT_USE_FLAT_CONFIG=false npm run server:lint',
      prefix + ' GENERATE_SOURCEMAP=true ESLINT_USE_FLAT_CONFIG=false DISABLE_ESLINT_PLUGIN=false CI=false npm run client:build',
    ], { nativeBuild: true }],
    ['BROWSER_REVIEW', 'Review independently captured real browser results for B01/B03/B09/B12/B10/B11. State actual UI and reload observations, disclosed SQL fixtures and B10 API position setup; do not claim a drag interaction. Distinguish the independent browser rebuild from the native model build and API-only checks. This browser phase has not yet established the following application-restart result.', [], { evidence: 'browser' }],
    ['PERSISTENCE_REVIEW', 'Review independently captured fresh application-runtime persistence evidence for the same six browser cases. Distinguish application restart, editor restart and PostgreSQL restart. Claim only observed cases and timestamps; do not credit future work to an earlier report.', [], { evidence: 'persistence' }],
    ['FINAL_SCOPE', 'Review the complete final diff, protected note and public inventory. Separate ten preserved repairs from B10/B11 repaired here. Identify all six pending features and untested behavior, while verifying the staged note and original index remain preserved.', [diff, status, 'cat .pb02/developer-notes.txt .pb02/public-issues.json']],
    ['HANDOFF', 'Use final independent evidence and prior observed results for a precise handoff. Report actual tests/lints/build, all-twelve API/ORM checks, six browser cases and application persistence with limits. Preserve the earlier rejected B10 attempt, distinguish it from this continuation, and identify all six pending features. Do not claim full elapsed-session acceptance, native thread resume, broad helper quality or unrestricted permissions.', [], { evidence: 'final' }],
  ];
  assert.equal(raw.length, TURN_COUNT);
  return raw.map(([name, task, commands, extra], index) => ({ ordinal: index + 1,
    marker: `F2P_${String(index + 1).padStart(2, '0')}_${name}`, segment: index < FIRST_SEGMENT_COUNT ? 1 : 2,
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
  assert.equal(result.status, 'completed', 'Every final-pair command must complete');
  assert.equal(result.exitCode, 0, 'No seeded-lint or deliberate-error allowance applies');
}
function sessionQualification({ startedAt, endedAt, replies, restart }) {
  assert(Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt >= startedAt);
  assert.equal(replies.length, TURN_COUNT); assert.equal(new Set(replies.map(row => row.messageId)).size, TURN_COUNT);
  const minutes = (endedAt - startedAt) / 60000, issues = ['FEWER_THAN_25_MEANINGFUL_OPERATIONS', 'ORDINARY_MISTAKE_RECOVERY_REQUIRES_INDEPENDENT_SEMANTIC_REVIEW'];
  if (minutes < 45) issues.push('SHORTER_THAN_45_REAL_MINUTES');
  if (minutes > 60) issues.push('OUTSIDE_60_MINUTE_TARGET');
  if (!restart?.editorExited || !restart?.historyRestored || !restart?.priorMessagesPreserved) issues.push('REAL_EDITOR_RESTART_NOT_VERIFIED');
  return { status: 'PARTIAL_S_SESSION', elapsedMinutes: minutes, completedUsefulTurns: replies.length, issues,
    recoveryScope: 'Prior rejected patch and wording notes remain preserved; reviewing them earns no new ordinary-mistake recovery credit. No deliberate fault is injected.', W: 'NOT_RUN', E: 'NOT_RUN', P: 'NOT_RUN' };
}
module.exports = { TURN_COUNT, FIRST_SEGMENT_COUNT, BUILD_ORDINAL, CASE_ORDER, buildSteps, promptFor, assertCommandResult, sessionQualification };
