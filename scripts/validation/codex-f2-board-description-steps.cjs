/* Qualification-guided editing tasks, with no implied unaided design or endurance credit. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const scoped = require('./codex-f2-scoped-campaign.cjs');
const TURN_COUNT = 20, FIRST_SEGMENT_COUNT = 18, BUILD_ORDINAL = 17, LINT_ORDINAL = 16;
const BOUNDARY_ORDINALS = Object.freeze([14, 15, 16, 17]);
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
function buildSteps(workspace) {
  const contract = require('./codex-f2-board-description-campaign.cjs');
  const git = 'git --no-optional-locks -c diff.autoRefreshIndex=false -c core.fsmonitor=false -c core.hooksPath=/dev/null';
  const status = `${git} status --short`, diff = `${git} --no-pager diff --no-ext-diff --no-textconv`;
  const policy = scoped.buildCommandPolicy(workspace), prefix = Object.entries(policy.environment).map(([k, v]) => k + '=' + quote(v)).join(' ');
  const raw = [['BASELINE', 'Review the actual native24 checkpoint and fresh baseline reports. Its original strict audit remains FAIL; the qualified supplemental review establishes the stated F05 functionality. Separate twelve preserved bug repairs and F05 from the missing F04 feature. Review the supplied locally qualified board-description patch plan. This is qualification-guided native editing, not unaided design. Report actual Node/npm versions and remaining feature scope.', ['cat .pb02/public-issues.json .pb02/developer-notes.txt package.json', status, 'node --version', 'npm --version'], { evidence: 'checkpoint' }]];
  for (const patch of contract.PATCHES) {
    const delta = fs.readFileSync(patch.patch.path, 'utf8'); assert.equal(scoped.hash(delta), patch.patch.sha256);
    raw.push([`APPLY_${patch.id.split('_').at(-1)}`, `Apply only the supplied locally qualified F04 change to ${patch.path} using one native single-file proposal of kind ${patch.kind}. Preserve every other byte and all prior repairs. The required unified change is:\n${delta}\nThis internal patch alone is not feature acceptance.`,
      [patch.kind === 'add' ? `ls ${path.posix.dirname(patch.path)}` : `cat ${patch.path}`], { patch: patch.id }]);
  }
  const commands = [
    ['CLIENT_TESTS', prefix + ' npm --prefix client test -- --watchAll=false --runInBand --cacheDirectory=' + quote(policy.cacheDirectories.jest), { nativeTests: true }],
    ['CLIENT_LINT', prefix + ' ESLINT_USE_FLAT_CONFIG=false npm run client:lint', { nativeLint: true }],
    ['SERVER_LINT', prefix + ' ESLINT_USE_FLAT_CONFIG=false npm run server:lint', { nativeLint: true }],
    ['CLIENT_BUILD', prefix + ' GENERATE_SOURCEMAP=true ESLINT_USE_FLAT_CONFIG=false DISABLE_ESLINT_PLUGIN=false CI=false npm run client:build', { nativeBuild: true }],
  ];
  for (const [name, command, flags] of commands) raw.push([name, 'Run this exact offline command once. Preserve the first actual result; no retry, automatic fix, package installation or substitute command. Report exit status and what its checks actually establish.', [command], flags]);
  const newFiles = contract.PATCHES.filter(row => row.kind === 'add').map(row => row.path).join(' ');
  raw.push(['CHECKPOINT', 'Review fresh F04 API/SQL, permission, browser layout and all12/F05 regressions alongside actual native tests/lints/build. Review both newly created files because git diff does not include untracked content. Prepare an accurate editor-restart checkpoint: twelve internal patch approvals implement one feature. State failures and limits, preserving the original Git index and note. Four other features remain pending only if F04 passes its actual native gates.', [diff, status, `cat ${newFiles}`, 'cat .pb02/developer-notes.txt'], { evidence: 'validation' }]);
  raw.push(['RESTORE', 'The actual editor restarted and this saved conversation was selected. Reconcile its checkpoint with current files and fresh post-restoration F04 API/browser plus all12/F05 results. Distinguish root application/browser actions from your native actions, saved-history restoration from native thread resume, and new application launches from database-restart persistence. Retain original native24 audit limitations.', [diff, status, `cat ${newFiles}`, 'cat .pb02/developer-notes.txt'], { evidence: 'restored' }]);
  raw.push(['HANDOFF', 'Review the supplied final evidence and report exactly which F04 behavior is verified, the first native test/lint/build results, editor restoration, twelve preserved bugs, preserved F05, and remaining priority/due-date/archiving/CSV features. Include material failures and limits. Do not equate twenty tasks with full S/W/E/P, ordinary-mistake recovery, mobile/accessibility completeness or native thread resume.', [diff, status, 'cat .pb02/developer-notes.txt .pb02/public-issues.json'], { evidence: 'final' }]);
  assert.equal(raw.length, TURN_COUNT);
  return raw.map(([name, task, commands, extra], index) => ({ ordinal: index + 1, marker: `F2F04_${String(index + 1).padStart(2, '0')}_${name}`,
    segment: index < FIRST_SEGMENT_COUNT ? 1 : 2, task, commands, requiresEscalation: commands.filter(command => command.startsWith(prefix + ' ')), ...extra }));
}
function promptFor(step, commands) {
  assert.deepEqual(commands.slice(0, step.commands.length), step.commands);
  let text = `PB02_REQUEST:${step.marker}\n${step.task}\nRun each listed command and report its observed result. Only these exact shell command bodies in the owned workspace are authorized: ${commands.map(JSON.stringify).join(', ')}. `;
  text += step.patch ? 'Use only native file-change/apply_patch for the single scoped proposal, never shell writes. ' : 'Do not edit files. ';
  text += 'Preserve the Git index, protected note, prior fixes and external oracles. No package installation, external tools, alternate commands or permission-setting changes. End PB02_DONE:' + step.marker + '.';
  if (step.requiresEscalation.length) {
    text = text.replace('Do not edit files. ', 'Preserve source, tests and dependency files. Only declared generated caches may change; the build may additionally write client/build. ');
    text += ' Request native sandbox_permissions="require_escalated" for this exact command through the normal approval card with a command-specific justification. Keep the untrusted/read-only conversation policy and do not request persistent permissions. Preserve a denial or failure without retry.';
  }
  return text;
}
function sessionQualification({ startedAt, endedAt, replies, restart }) {
  assert(Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt >= startedAt);
  assert.equal(replies.length, TURN_COUNT); assert.equal(new Set(replies.map(row => row.messageId)).size, TURN_COUNT);
  const issues = ['TWENTY_GUIDED_FEATURE_TASKS_DO_NOT_ESTABLISH_FULL_SESSION_ACCEPTANCE'];
  if (!restart?.editorExited || !restart?.historyRestored || !restart?.priorMessagesPreserved) issues.push('REAL_EDITOR_RESTART_NOT_VERIFIED');
  return { status: 'PARTIAL_S_SESSION', elapsedMinutes: (endedAt - startedAt) / 60000, completedUsefulTurns: replies.length, issues, W: 'NOT_RUN', E: 'NOT_RUN', P: 'NOT_RUN' };
}
module.exports = { TURN_COUNT, FIRST_SEGMENT_COUNT, BUILD_ORDINAL, LINT_ORDINAL, BOUNDARY_ORDINALS, buildSteps, promptFor, sessionQualification };
