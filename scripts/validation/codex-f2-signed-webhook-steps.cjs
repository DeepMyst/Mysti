/* Six useful F05 tasks; two file approvals implement one server-side feature. */
'use strict';
const assert = require('node:assert/strict');
const scoped = require('./codex-f2-scoped-campaign.cjs');
const TURN_COUNT = 6, FIRST_SEGMENT_COUNT = 3, BUILD_ORDINAL = null, LINT_ORDINAL = 5;
const BOUNDARY_ORDINALS = Object.freeze([LINT_ORDINAL]);
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
const HELPER = 'server/api/helpers/utils/send-webhooks.js', DOCS = 'server/.env.sample';
function buildSteps(workspace) {
  const git = 'git --no-optional-locks -c diff.autoRefreshIndex=false -c core.fsmonitor=false -c core.hooksPath=/dev/null';
  const status = `${git} status --short`;
  const diff = `${git} --no-pager diff --no-ext-diff --no-textconv -- ${HELPER} ${DOCS}`;
  const policy = scoped.buildCommandPolicy(workspace);
  const prefix = Object.entries(policy.environment).map(([key, value]) => key + '=' + quote(value)).join(' ');
  const raw = [
    ['CHECKPOINT_TRACE', 'Review the supplied accepted twelve-repair checkpoint, fresh all-twelve API/SQL and ORM/React baseline, and fresh feature-absent F05 result. The root checks include real application launches; distinguish their results from this model turn. The absent baseline must fail specifically because the signed route has no exact-body HMAC, with normal app cleanup. Read the public issues and protected note, and trace the existing serialized body, prevData, bearer header, URL guard, canonical B08 && exclusions and allowlist. Explain the two file approvals for one F05 feature. All twelve existing bug repairs must remain intact. Report actual Node/npm versions.', ['cat .pb02/public-issues.json .pb02/developer-notes.txt package.json', `cat ${HELPER} ${DOCS} server/config/custom.js`, diff, status, 'node --version', 'npm --version'], { evidence: 'checkpoint' }],
    ['IMPLEMENT_SIGNING', 'Implement only the F05 helper change with one native single-file proposal. Add const crypto = require(\'crypto\'); at the top of the helper, followed by one blank line before const EVENT_TYPES. After the existing const body = JSON.stringify(...) block and before try, if (webhook.secret), set X-Planka-Signature to sha256= plus lowercase HMAC-SHA256 of the exact existing body string using the configured secret and UTF8. Use four leading spaces on the assignment line and six on its continuation, with this two-line assignment: headers[\'X-Planka-Signature\'] = followed on the next indented line by `sha256=${crypto.createHmac(\'sha256\', webhook.secret).update(body, \'utf8\').digest(\'hex\')}`;. Preserve the serialized body, inputs.prevData, bearer authorization, fetch options, canonical webhook.excludedEvents && guard and every prior bug repair. Omitted-secret descriptors remain unsigned. No other byte changes. This helper-only state is not complete F05 acceptance.', [`cat ${HELPER}`], { patch: 'F2-F05_HELPER' }],
    ['DOCUMENT_AND_CHECKPOINT', 'Implement only the F05 documentation change with one native single-file proposal to server/.env.sample. Use these exact comment lines: # Optional fields: accessToken, events, excludedEvents, secret and then # secret optionally signs the exact UTF8 JSON body with X-Planka-Signature: sha256=<HMAC-SHA256 hex>. Immediately after the accessToken example, add #   "secret": "synthetic-example-only",. These are commented documentation lines, with the final comma belonging to the example. Preserve all other examples and configuration. Review the resulting two-file diff and status after applying the proposal. Write an editor-restart checkpoint: twelve preserved bug repairs, two internal patch approvals for one feature, positive F05/all-twelve regression review and native server lint still pending, five other features pending. Keep the original Git index and staged note.', [`cat ${DOCS}`, diff, status], { patch: 'F2-F05_DOCS' }],
    ['RESTORE_AND_VALIDATE', 'The editor was restarted and this saved conversation selected. Reconcile its checkpoint with actual files, protected note, diff and status. Review the supplied fresh positive F05 and all-twelve API/SQL plus ORM/React regression reports. Describe exact raw create/update HMAC, wrong-key/changed-body rejection, unsigned routes, retained bearer header, current and previous values, secret absence in the three captured logs, and the bounded exclusion window through normal app exit and sink drain. Distinguish these root application checks from model actions and editor history restoration. Do not claim browser, application-restart persistence, database restart, or native thread resume. Server lint is still pending.', [diff, status, 'cat .pb02/developer-notes.txt'], { evidence: 'validation' }],
    ['SERVER_LINT', 'Run server lint exactly once using this exact offline command and owned generated-cache environment. Require its first actual completed exit zero; preserve a failure without retry, substitute commands or automatic fixes. Source and tests must remain unchanged. This server-only feature requires no fresh client build, client lint or browser test.', [prefix + ' ESLINT_USE_FLAT_CONFIG=false npm run server:lint'], { nativeLint: true }],
    ['FINAL_HANDOFF', 'Review the final exact two-file diff, protected note, original index and supplied final evidence. Report F05 complete only if both internal patches, the actual positive F05 oracle, all twelve regression cases, native server lint exit zero and preservation checks passed. Distinguish one new feature from twelve preserved bug repairs; keep the other five features pending. State the observed HMAC and bounded exclusion scope, actual editor restart and any unresolved failures. No fresh frontend build/browser, broad persistence, endurance, unrestricted-permission or full S/W/E/P credit is earned here.', [diff, status, 'cat .pb02/developer-notes.txt .pb02/public-issues.json'], { evidence: 'final' }],
  ];
  assert.equal(raw.length, TURN_COUNT);
  return raw.map(([name, task, commands, extra], index) => ({ ordinal: index + 1,
    marker: `F2F05_${String(index + 1).padStart(2, '0')}_${name}`, segment: index < FIRST_SEGMENT_COUNT ? 1 : 2,
    task, commands, requiresEscalation: commands.filter(command => command.startsWith(prefix + ' ')), ...extra }));
}
function promptFor(step, commands) {
  assert.deepEqual(commands.slice(0, step.commands.length), step.commands);
  let text = `PB02_REQUEST:${step.marker}\n${step.task}\nRun each listed command and report its observed result. Only these exact shell command bodies in the owned workspace are authorized: ${commands.map(JSON.stringify).join(', ') || '(none)'}. `;
  text += step.patch ? 'Use only native file-change/apply_patch for the single scoped proposal, never shell writes. ' : 'Do not edit files. ';
  text += 'Preserve the Git index, protected notes, twelve prior bug repairs, other features and external oracles. No package installation, network/external tools or alternate commands. Keep the final answer focused on observed facts. End PB02_DONE:' + step.marker + '.';
  if (step.requiresEscalation.length) {
    assert(step.requiresEscalation.every(command => commands.includes(command)));
    text = text.replace('Do not edit files. ', 'Preserve source, tests, client/build and dependency files. Only the declared server lint command may write its owned generated npm/temp/lint caches. No other shell writes are authorized. ');
    text += ' For this exact command, explicitly request native sandbox_permissions="require_escalated" with a command-specific justification through the normal approval card: ' + step.requiresEscalation.map(JSON.stringify).join(', ') + '. Keep the conversation untrusted/read-only policy. Do not request persistent permissions or change settings. If denied or failed, report the first actual result; do not retry or substitute another command.';
  }
  return text;
}
function assertCommandResult({ step, result }) { assert.equal(step.expectedNonzero, undefined); assert.equal(result.status, 'completed'); assert.equal(result.exitCode, 0); }
function sessionQualification({ startedAt, endedAt, replies, restart }) {
  assert(Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt >= startedAt);
  assert.equal(replies.length, TURN_COUNT); assert.equal(new Set(replies.map(row => row.messageId)).size, TURN_COUNT);
  const issues = ['SIX_FEATURE_TASKS_DO_NOT_ESTABLISH_FULL_SESSION_ACCEPTANCE'];
  if (!restart?.editorExited || !restart?.historyRestored || !restart?.priorMessagesPreserved) issues.push('REAL_EDITOR_RESTART_NOT_VERIFIED');
  return { status: 'PARTIAL_S_SESSION', elapsedMinutes: (endedAt - startedAt) / 60000, completedUsefulTurns: replies.length, issues,
    featureScope: 'One server-side feature with two file approvals. No deliberate faults, artificial waiting or automatic mistake-recovery credit.', W: 'NOT_RUN', E: 'NOT_RUN', P: 'NOT_RUN' };
}
module.exports = { TURN_COUNT, FIRST_SEGMENT_COUNT, BUILD_ORDINAL, LINT_ORDINAL, BOUNDARY_ORDINALS, buildSteps, promptFor, assertCommandResult, sessionQualification };
