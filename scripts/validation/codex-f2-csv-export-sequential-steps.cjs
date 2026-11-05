/* Qualification-guided editing tasks, with no implied unaided design or endurance credit. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const scoped = require('./codex-f2-scoped-campaign.cjs');
const TURN_COUNT = 18, FIRST_SEGMENT_COUNT = 16, BUILD_ORDINAL = 15, LINT_ORDINAL = 14;
const BOUNDARY_ORDINALS = Object.freeze([12, 13, 14, 15]);
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
function buildSteps(workspace) {
  const contract = require('./codex-f2-csv-export-sequential-campaign.cjs');
  const git = 'git --no-optional-locks -c diff.autoRefreshIndex=false -c core.fsmonitor=false -c core.hooksPath=/dev/null';
  const status = `${git} status --short`, diff = `${git} --no-pager diff --no-ext-diff --no-textconv`;
  const policy = scoped.buildCommandPolicy(workspace), prefix = Object.entries(policy.environment).map(([k, v]) => k + '=' + quote(v)).join(' ');
  const raw = [['BASELINE', 'Review the actual native25 checkpoint and fresh baseline reports. Its original strict audit remains FAIL; the qualified postrun supplemental review establishes the stated F04 functionality. Separate twelve preserved bug repairs and F05/F04 from the missing F06 CSV feature and known narrow390 description overflow. Review the supplied locally qualified CSV and responsive-description patch plan. This is qualification-guided native editing, not unaided design. Report actual Node/npm versions and remaining feature scope. The fresh baseline intentionally runs the positive F06 API oracle against the feature-absent source: raw status FAIL, HTTP404 and oracle command exit1 are the expected absence result. The root checkpoint review may PASS because it verifies that absence and preserved regressions; this is not an F06 feature pass. Feature acceptance requires the later positive API/UI and regression evidence.', ['cat .pb02/public-issues.json .pb02/developer-notes.txt package.json', status, 'node --version', prefix + ' npm --version'], { evidence: 'checkpoint' }]];
  for (const patch of contract.PATCHES) {
    const delta = fs.readFileSync(patch.patch.path, 'utf8'); assert.equal(scoped.hash(delta), patch.patch.sha256);
    raw.push([`APPLY_${patch.id.split('_').at(-1)}`, `Apply only the supplied locally qualified F06 or disclosed responsive-description change to ${patch.path} using one native single-file proposal of kind ${patch.kind}. Preserve every other byte and all prior repairs. The required unified change is:\n${delta}\nThis internal patch alone is not feature acceptance.`,
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
  raw.push(['CHECKPOINT', 'Review fresh CSV API/raw-byte/full-business-SQL and viewer download results, F04 long-description wrapping at390/1440, and all12/F05/F04 regressions alongside actual native tests/lints/build. Review all three new files because git diff excludes untracked content. Prepare an accurate editor-restart checkpoint: ten internal patch approvals implement CSV plus the disclosed responsive-description correction. State failures and limits, preserving the Git index and protected note. Priorities, due dates and archive/restore remain pending. Separate mocked browser401/404 from real API permission checks and do not claim data persistence across a PostgreSQL restart.', [diff, status, `cat ${newFiles}`, 'cat .pb02/developer-notes.txt'], { evidence: 'validation' }]);
  raw.push(['RESTORE', 'The actual editor restarted and this saved conversation was selected. Reconcile its checkpoint with current files and fresh post-restoration CSV API/browser, responsive-description and all12/F05/F04 results. Distinguish root application/browser actions from your native actions, saved-history restoration from native thread resume, and new application launches from database-restart persistence. Retain original native25 strict FAIL and explicit postrun supplemental audit limitations.', [diff, status, `cat ${newFiles}`, 'cat .pb02/developer-notes.txt'], { evidence: 'restored' }]);
  raw.push(['HANDOFF', 'Review final evidence and report precisely the CSV fields/escaping/permissions/no-business-mutation, viewer download and measured narrow/wide wrapping coverage, first native test/lint/build results, and saved-history restoration. Preserve twelve bug repairs and F05/F04; priorities, due dates and archive/restore remain pending. Retain original native25 strict FAIL and the postrun supplemental basis. Distinguish root application/browser actions, browser-mocked errors, actual API checks and native editing. Eighteen guided tasks do not establish full S/W/E/P, ordinary-mistake recovery, mobile/accessibility completeness or native thread resume.', [diff, status, 'cat .pb02/developer-notes.txt .pb02/public-issues.json'], { evidence: 'final' }]);
  assert.equal(raw.length, TURN_COUNT);
  return raw.map(([name, task, commands, extra], index) => ({ ordinal: index + 1, marker: `F2F06_${String(index + 1).padStart(2, '0')}_${name}`,
    segment: index < FIRST_SEGMENT_COUNT ? 1 : 2, task, commands, requiresEscalation: extra?.nativeTests || extra?.nativeLint || extra?.nativeBuild ? commands.filter(command => command.startsWith(prefix + ' ')) : [], ...extra }));
}
function promptFor(step, commands) {
  assert.deepEqual(commands.slice(0, step.commands.length), step.commands);
  let text = `PB02_REQUEST:${step.marker}\n${step.task}\nFor this task, execute the listed exact command bodies in the listed order, one command at a time. Await that command's final result before starting the next command; do not batch or launch commands in parallel. Invoke each listed command exactly once in this task, including appended evidence-report reads. Never repeat or substitute a command, even if its output is truncated, combined, missing or unclear, or an approval is denied or canceled. Preserve the first result and report any unobserved detail as a coverage gap; do not reconstruct or claim unseen output. A native permission card may appear even for a read-only command; handle that one request through the normal approval flow, without assuming reads are approval-free or changing permission settings. Only these exact shell command bodies in the owned workspace are authorized: ${commands.map(JSON.stringify).join(', ')}. `;
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
  const issues = ['EIGHTEEN_GUIDED_FEATURE_TASKS_DO_NOT_ESTABLISH_FULL_SESSION_ACCEPTANCE'];
  if (!restart?.editorExited || !restart?.historyRestored || !restart?.priorMessagesPreserved) issues.push('REAL_EDITOR_RESTART_NOT_VERIFIED');
  return { status: 'PARTIAL_S_SESSION', elapsedMinutes: (endedAt - startedAt) / 60000, completedUsefulTurns: replies.length, issues, W: 'NOT_RUN', E: 'NOT_RUN', P: 'NOT_RUN' };
}
module.exports = { TURN_COUNT, FIRST_SEGMENT_COUNT, BUILD_ORDINAL, LINT_ORDINAL, BOUNDARY_ORDINALS, buildSteps, promptFor, sessionQualification };
