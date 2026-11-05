/* Qualification-guided editing tasks, with no implied unaided design or endurance credit. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const scoped = require('./codex-f2-scoped-campaign.cjs');
const TURN_COUNT = 19, FIRST_SEGMENT_COUNT = 17, BUILD_ORDINAL = 16, LINT_ORDINAL = 15;
const BOUNDARY_ORDINALS = Object.freeze([13, 14, 15, 16]);
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
function buildSteps(workspace) {
  const contract = require('./codex-f2-task-due-date-durable-campaign.cjs');
  const git = 'git --no-optional-locks -c diff.autoRefreshIndex=false -c core.fsmonitor=false -c core.hooksPath=/dev/null';
  const status = `${git} status --short`, diff = `${git} --no-pager diff --no-ext-diff --no-textconv`;
  const policy = scoped.buildCommandPolicy(workspace), prefix = Object.entries(policy.environment).map(([k, v]) => k + '=' + quote(v)).join(' ');
  const raw = [['BASELINE', 'Review the actual accepted native28 checkpoint and fresh baseline reports. Its prelaunch-pinned eighteen-task mechanical audit passed, while its aggregate remains PARTIAL; historical native25 strict FAIL and the separate postrun supplemental basis remain preserved. Separate twelve bug repairs and F05 signed webhooks, F04 descriptions and F06 CSV/responsive description from the missing F02 task dueDate feature. Review the supplied locally qualified eleven-file task dueDate plan. This is qualification-guided editing, not unaided design. Report actual Node/npm versions. Fresh baseline absence is expected, not a feature pass: root initializes the old schema, runs retained regressions and then seeds explicitly owned pre-migration tasks before native edits. Root alone runs migration/API/SQL/UI oracles; do not run database commands. Preserve parent-card dueDate, existing unrelated task fields and permissions. Final acceptance requires later actual migration, API, UI, regression and restored-history evidence.', ['cat .pb02/public-issues.json .pb02/developer-notes.txt package.json', status, 'node --version', prefix + ' npm --version'], { evidence: 'checkpoint' }]];
  for (const patch of contract.PATCHES) {
    const delta = fs.readFileSync(patch.patch.path, 'utf8'); assert.equal(scoped.hash(delta), patch.patch.sha256);
    raw.push([`APPLY_${patch.id.split('_').at(-1)}`, `Apply only the supplied locally qualified F02 task dueDate change to ${patch.path} using one native single-file proposal of kind ${patch.kind}. Preserve every other byte and all prior repairs. The required unified change is:\n${delta}\nThis internal patch alone is not feature acceptance.`,
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
  raw.push(['CHECKPOINT', 'Review fresh task dueDate migration/up/down/up evidence, declared UTC profile and raw-type API checks, full fifteen-table business SQL joins, actual set/clear/reload and failure-to-real-retry UI results, and all12/F05/F04/F06 regressions alongside the first native tests/lints/build. Read the new migration because git diff excludes untracked content. Prepare an accurate editor-restart checkpoint: eleven internal single-file approvals do not independently establish feature acceptance. State API/UI mocks, live server checks and any missing coverage separately. Preserve Git index, protected note, parent-card dueDate and prior fixes. Priorities and archive/restore remain pending. Claim PostgreSQL restart persistence only if the retained root migration report demonstrates it.', [diff, status, `cat ${newFiles}`, 'cat .pb02/developer-notes.txt'], { evidence: 'validation' }]);
  raw.push(['RESTORE', 'The actual editor restarted and this saved conversation was selected. Reconcile its checkpoint with current files and fresh post-restoration task dueDate API/UI/regression reports. Distinguish root migration/application/browser actions from your native actions, saved-history restoration from native thread resume, and application restart from an explicitly verified PostgreSQL restart. Preserve all12/F05/F04/F06, original native25 strict FAIL and postrun supplemental limitations. Report only observed evidence.', [diff, status, `cat ${newFiles}`, 'cat .pb02/developer-notes.txt'], { evidence: 'restored' }]);
  raw.push(['HANDOFF', 'Review final evidence and report precisely task dueDate nullable persistence, accepted ISO/UTC profile and invalid input handling, original-row migration behavior, task/card isolation, permissions, visible set/clear/reload and bounded failure/retry recovery. Separate native tests/lints/build from root API/SQL/UI/regression checks and retained lifecycle controls. Preserve twelve repairs and F05/F04/F06; priorities and archive/restore remain pending. Retain historical native25 strict FAIL, supplemental basis and failed prior native attempts. Nineteen guided tasks do not establish full S/W/E/P, generalized concurrency or accessibility completeness, ordinary-mistake recovery or native thread resume.', [diff, status, 'cat .pb02/developer-notes.txt .pb02/public-issues.json'], { evidence: 'final' }]);
  assert.equal(raw.length, TURN_COUNT);
  return raw.map(([name, task, commands, extra], index) => ({ ordinal: index + 1, marker: `F2F02_${String(index + 1).padStart(2, '0')}_${name}`,
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
  const issues = ['NINETEEN_GUIDED_FEATURE_TASKS_DO_NOT_ESTABLISH_FULL_SESSION_ACCEPTANCE'];
  if (!restart?.editorExited || !restart?.historyRestored || !restart?.priorMessagesPreserved) issues.push('REAL_EDITOR_RESTART_NOT_VERIFIED');
  return { status: 'PARTIAL_S_SESSION', elapsedMinutes: (endedAt - startedAt) / 60000, completedUsefulTurns: replies.length, issues, W: 'NOT_RUN', E: 'NOT_RUN', P: 'NOT_RUN' };
}
module.exports = { TURN_COUNT, FIRST_SEGMENT_COUNT, BUILD_ORDINAL, LINT_ORDINAL, BOUNDARY_ORDINALS, buildSteps, promptFor, sessionQualification };
