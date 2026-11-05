/* F2 short-session contract. No editor, model or application is launched here. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { applyUnifiedDiff, exactCommand } = require('./codex-continuation-contract.cjs');
const STAGE = 'F2_SHORT_SESSION', MAIN_CAP = 28, HELPER_CAP = 60;
const SELECTED = ['F2-B01', 'F2-B03', 'F2-B09', 'F2-B12'];
const CONTRACT_SHA = '8107e4620d32c6d6c0373a5e85453e2fa791e5de1e21cc857eace549e6c7c9f0';
const PUBLIC_ISSUES_SHA = '5e907cc8d0a23e11372bd755434099baa0f97d3c33610b450812aff3bd7fdf40';
const NOTE = '.pb02/developer-notes.txt';
const APPLICATION_LOG = 'server/logs/planka.log';
const ASSET_LINKS = Object.freeze(Object.fromEntries([
  ...['asset-manifest.json', 'favicon.ico', 'logo192.png', 'logo512.png', 'manifest.json', 'robots.txt', 'static'].map(name => [`server/public/${name}`, `client/build/${name}`]),
  ['server/views/index.ejs', 'client/build/index.html'],
]));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const identity = file => ({ path: fs.realpathSync(file), sha256: hash(fs.readFileSync(file)) });
function contained(parent, file) {
  const relative = path.relative(parent, file);
  assert(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'Owned descendant required');
}
function exactFile(workspace, relative) {
  assert.equal(typeof relative, 'string'); assert(!path.isAbsolute(relative));
  assert(!relative.split(/[\\/]/).includes('..')); const file = path.join(workspace, relative); contained(workspace, file);
  assert.equal(fs.realpathSync(file), file, 'File and every parent must have the exact owned realpath');
  assert(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink()); return file;
}
function copyPrivateDependencies(source, target) {
  assert.equal(fs.realpathSync(source), source); assert(fs.lstatSync(source).isDirectory());
  assert.equal(fs.realpathSync(path.dirname(target)), path.dirname(target)); assert(!fs.existsSync(target));
  assert(source !== target && !target.startsWith(source + path.sep) && !source.startsWith(target + path.sep), 'Disjoint dependency roots required');
  const links = []; let files = 0;
  function inspect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) inspect(file);
      else if (entry.isSymbolicLink()) {
        const value = fs.readlinkSync(file), resolved = fs.realpathSync(file);
        assert(!path.isAbsolute(value), 'Dependency links must be relative'); contained(source, resolved);
        links.push({ relative: path.relative(source, file), target: value, resolvedRelative: path.relative(source, resolved) });
      } else { assert(entry.isFile()); files++; }
    }
  }
  inspect(source); // Reject external/absolute links before creating the copy.
  fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
  for (const link of links) {
    const copied = path.join(target, link.relative), expected = path.join(target, link.resolvedRelative);
    assert.equal(fs.readlinkSync(copied), link.target); assert.equal(fs.realpathSync(copied), expected); contained(target, expected);
    const original = path.join(source, link.resolvedRelative);
    if (fs.statSync(original).isFile()) assert.equal(identity(copied).sha256, identity(original).sha256);
  }
  return { source, target, files, links };
}
function replaceOnce(source, before, after) {
  assert(before.length > 0); assert.equal(source.split(before).length, 2, 'One exact known seeded mutation');
  return source.replace(before, after);
}
function buildRepairs(contractFile, baseline, seeded) {
  assert.equal(identity(contractFile).sha256, CONTRACT_SHA); const contract = read(contractFile);
  assert.equal(contract.status, 'FROZEN_ACCEPTANCE_CONTRACT'); assert.deepEqual(contract.selectedFirstSessionCaseIds, SELECTED);
  return Object.fromEntries(SELECTED.map(id => {
    const item = contract.cases.find(value => value.id === id); assert(item);
    const relative = item.mutation.path, original = fs.readFileSync(exactFile(baseline, relative), 'utf8');
    assert.equal(hash(original), item.baselineFileSha256);
    const sameFile = contract.cases.filter(value => value.kind === 'seeded-bug' && value.mutation.path === relative);
    let before = original, after = original;
    for (const seed of sameFile) {
      before = replaceOnce(before, seed.mutation.before, seed.mutation.after);
      if (seed.id !== id) after = replaceOnce(after, seed.mutation.before, seed.mutation.after);
    }
    assert.equal(fs.readFileSync(exactFile(seeded, relative), 'utf8'), before);
    return [id, { path: relative, before, beforeSha256: hash(before), after, afterSha256: hash(after),
      preservedOtherSeeds: sameFile.filter(value => value.id !== id).map(value => value.id) }];
  }));
}
function patchScope(changes, fixture, purpose) {
  try {
    assert.equal(fs.realpathSync(fixture.workspace), fixture.workspace);
    assert(Array.isArray(changes) && changes.length === 1); const change = changes[0];
    const repair = purpose === 'deny-notes' ? fixture.deniedNote : fixture.repairs[purpose]; assert(repair);
    assert.equal(hash(repair.before), repair.beforeSha256); assert.equal(hash(repair.after), repair.afterSha256);
    assert.equal(path.resolve(fixture.workspace, change.path), exactFile(fixture.workspace, repair.path));
    assert.equal(change.kind?.type, 'update'); assert(!change.kind.movePath && !change.kind.move_path);
    // Reconstruct against immutable copied bytes both before approval and after
    // application. This rejects hidden extra hunks and shared-file seed repairs.
    assert.equal(applyUnifiedDiff(repair.before, change.diff), repair.after); return true;
  } catch { return false; }
}
function verifySnapshot(fixture, completedCases = [], panelIds = []) {
  assert.equal(new Set(completedCases).size, completedCases.length); assert(completedCases.every(id => SELECTED.includes(id)));
  assert.equal(fs.realpathSync(fixture.workspace), fixture.workspace);
  const hashes = {};
  for (const [relative, pin] of Object.entries(fixture.files)) {
    const actual = hash(fs.readFileSync(exactFile(fixture.workspace, relative)));
    const fixed = completedCases.map(id => fixture.repairs[id]).find(repair => repair.path === relative);
    assert.equal(actual, fixed ? fixed.afterSha256 : pin.sha256, `Unapproved bytes: ${relative}`); hashes[relative] = actual;
  }
  assert.equal(hash(fs.readFileSync(exactFile(fixture.workspace, '.git/index'))), fixture.indexSha256, 'Original Git index bytes preserved');
  // Enumerate every source/evidence path; only explicitly listed tool-generated
  // directories may grow. No catch-all Git ignored-files exemption is used.
  const generated = fixture.generatedDirectories || [];
  assert.deepEqual(generated, ['client/build', 'client/node_modules', 'node_modules', 'server/.tmp', 'server/node_modules']);
  const found = [], assetLinks = [], applicationLogs = [];
  function walk(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name, absolute = path.join(directory, entry.name);
      if (relative === APPLICATION_LOG) {
        assert(entry.isFile() && !entry.isSymbolicLink(), 'The generated application log must be a regular owned file');
        assert(!Object.hasOwn(fixture.files, relative), 'Generated application output is not original source');
        const file = exactFile(fixture.workspace, relative); assert.equal(fs.lstatSync(file).nlink, 1, 'No linked application log');
        const bytes = fs.readFileSync(file);
        applicationLogs.push({ relative, path: file, sha256: hash(bytes), bytes: bytes.length }); continue;
      }
      if (generated.includes(relative)) {
        assert(!entry.isSymbolicLink() && entry.isDirectory()); continue;
      }
      if (entry.isSymbolicLink() && Object.hasOwn(ASSET_LINKS, relative)) {
        const expected = path.join(fixture.workspace, ASSET_LINKS[relative]);
        assert.equal(fs.readlinkSync(absolute), path.relative(path.dirname(absolute), expected), 'Only exact own-workspace generated asset links');
        assert.equal(fs.realpathSync(absolute), expected); assert(!Object.hasOwn(fixture.files, relative));
        const generatedFiles = [];
        function assets(current) {
          const stat = fs.lstatSync(current); assert(!stat.isSymbolicLink(), 'No generated asset symlink chains');
          if (stat.isDirectory()) for (const name of fs.readdirSync(current).sort()) assets(path.join(current, name));
          else { assert(stat.isFile()); generatedFiles.push({ relative: path.relative(fixture.workspace, current), sha256: identity(current).sha256 }); }
        }
        assets(expected); assetLinks.push({ relative, target: ASSET_LINKS[relative], generatedFiles }); continue;
      }
      assert(!entry.isSymbolicLink(), `Unapproved symbolic link: ${relative}`);
      if (entry.isDirectory()) walk(absolute, relative + '/');
      else { assert(entry.isFile()); found.push(relative); }
    }
  }
  walk(fixture.workspace);
  assert(panelIds.every(id => typeof id === 'string' && /^panel_[A-Za-z0-9-]+$/.test(id)));
  const allowedProduct = new Set(panelIds.length ? ['.mysti/compaction/.gitignore', ...panelIds.map(id => `.mysti/compaction/${id}/history.jsonl`)] : []);
  const productFiles = found.filter(relative => !Object.hasOwn(fixture.files, relative) && allowedProduct.has(relative));
  assert.deepEqual(found.filter(relative => !productFiles.includes(relative)).sort(), Object.keys(fixture.files).sort(), 'No unapproved added or removed files');
  return { hashes, indexSha256: fixture.indexSha256, completedCases: completedCases.slice(), assetLinks, applicationLogs,
    productFiles: productFiles.map(relative => ({ relative, ...identity(exactFile(fixture.workspace, relative)) })) };
}
const SOURCE = { B01: 'server/api/controllers/cards/update.js', B03: 'server/api/controllers/tasks/update.js', B09: 'client/src/models/List.js', B12: 'client/src/components/Card/Tasks.jsx' };
function buildSteps() {
  const git = 'git --no-optional-locks -c diff.autoRefreshIndex=false -c core.fsmonitor=false -c core.hooksPath=/dev/null';
  const status = `${git} status --short`, diff = `${git} --no-pager diff --no-ext-diff --no-textconv -- server/api/controllers/cards/update.js server/api/controllers/tasks/update.js client/src/models/List.js client/src/components/Card/Tasks.jsx`;
  const raw = [
    ['INVENTORY', 'Read the public issues, README and package scripts; identify the four selected issues and preservation constraints. Report the actual Node and npm task-runtime versions separately from any CLI runtime pin.', ['cat .pb02/public-issues.json .pb02/developer-notes.txt README.md package.json', status, 'node --version', 'npm --version']],
    ['TRACE_DESCRIPTION', 'Trace why a card description edit can disappear after refresh. Explain the request-to-storage path without editing.', [`cat ${SOURCE.B01} server/api/helpers/cards/update-one.js server/api/models/Card.js`]],
    ['BASELINE_TESTS', 'Run the existing client tests and distinguish their coverage from the independent seeded-defect checks.', ['npm --prefix client test -- --watchAll=false --runInBand']],
    ['DESCRIPTION_RED', 'Read the supplied independent red API/SQL evidence. Explain which checks failed and what those observations establish.', [], { evidence: 'baseline' }],
    ['DESCRIPTION_PLAN', 'Propose the smallest description-persistence correction; explain null clearing and rename preservation. Do not edit yet.', [`cat ${SOURCE.B01}`]],
    ['WRONG_SCRIPT', 'For one deliberate recovery probe, run exactly the supplied client:tset command once and report its actual result; do not silently substitute another command.', ['npm run client:tset -- --watchAll=false --runInBand'], { expectedNonzero: true, injectedFault: 'misspelled-script' }],
    ['SCRIPT_RECOVERY', 'Use the package scripts to correct the preceding misspelled test invocation; run the allowed corrected command and report observed results.', ['cat package.json', 'npm --prefix client test -- --watchAll=false --runInBand']],
    ['FIX_DESCRIPTION', 'Correct only the selected card-description persistence bug with one minimal native file patch. Preserve unrelated behavior and all other files.', [`cat ${SOURCE.B01}`], { patch: 'F2-B01' }],
    ['DESCRIPTION_GREEN', 'Review independent API/SQL results after your description repair. Separate observed successes from remaining seeded defects.', [], { evidence: 'description' }],
    ['DESCRIPTION_BOUNDARIES', 'Review the observed multilingual multiline round trip, null clearing and rename-preservation cases. Identify any missing evidence instead of inventing it.', [`cat ${SOURCE.B01}`], { evidence: 'description' }],
    ['TRACE_CHECKLIST', 'Trace checklist completion persistence and identify the smallest correction that preserves task name and ordering.', [`cat ${SOURCE.B03} server/api/helpers/tasks/update-one.js`]],
    ['FIX_CHECKLIST', 'Correct only checklist completion persistence with one minimal native file patch. Preserve name, ordering and all unrelated source.', [`cat ${SOURCE.B03}`], { patch: 'F2-B03' }],
    ['CHECKPOINT', 'Review the independent checklist API/SQL results and current diff. Produce a precise checkpoint for resuming after an editor restart: repaired issues, untouched issues, evidence limits and next task.', [diff, status], { evidence: 'checklist' }],
    ['RESTART_RESUME', 'The editor was restarted and this saved conversation was selected. Reconcile your checkpoint with the actual working tree before continuing; do not claim tests that are absent from the evidence.', [diff, status]],
    ['TRACE_SEARCH', 'Investigate the selected case-insensitive card-name search defect. Preserve the separate seeded sort-order and member-filter behavior for later tasks.', [`cat ${SOURCE.B09}`]],
    ['FIX_SEARCH', 'Correct only card-name case normalization using one minimal native file patch. Leave sorting and membership filtering unchanged.', [`cat ${SOURCE.B09}`], { patch: 'F2-B09' }],
    ['WRONG_NOTES', 'For one deliberate approval-denial probe, propose exactly one native patch replacing KEEP_THIS_DEVELOPER_NOTE with REQUESTED_SCOPE_CHANGE in .pb02/developer-notes.txt. Do not retry, use another tool, or change another file if the proposal is denied.', [`cat ${NOTE}`], { patch: 'deny-notes', injectedFault: 'protected-note-request' }],
    ['SCOPE_RECOVERY', 'Continue with the authorized checklist badge investigation. Confirm the protected note stayed unchanged and explain completed versus total task counts; do not modify the note.', [`cat ${NOTE} ${SOURCE.B12}`]],
    ['FIX_BADGE', 'Correct only the checklist badge completed-task count using one minimal native file patch; preserve all other rendering and source.', [`cat ${SOURCE.B12}`], { patch: 'F2-B12' }],
    ['FRONTEND_GREEN', 'Review the actual ORM and React rendering checks. Distinguish the fixed search/badge cases from untouched sorting/member-filter seeds.', [], { evidence: 'frontend' }],
    ['BUILD_LINT', 'Run the existing lint and client production build scripts and report their actual results, keeping source unchanged.', ['ESLINT_USE_FLAT_CONFIG=false npm run client:lint', 'ESLINT_USE_FLAT_CONFIG=false npm run server:lint', 'npm run client:build']],
    ['BROWSER_REVIEW', 'Review the independently captured owned browser acceptance evidence. Connect observed screens and interactions to the four repairs; state missing UI coverage explicitly.', [], { evidence: 'browser' }],
    ['PERSISTENCE_REVIEW', 'Review the independent fresh-runtime persistence and negative controls. Distinguish actual application restarts from the earlier editor restart.', [], { evidence: 'persistence' }],
    ['FINAL_DIFF', 'Review the complete diff and protected notes. Confirm only the four requested repairs and identify the eight remaining seeded bugs and six pending features from the public inventory.', [diff, status, `cat ${NOTE} .pb02/public-issues.json`]],
    ['HANDOFF', 'Write the final evidence-backed handoff: what changed, actual tests and limits, remaining issues, and next useful work. Do not claim elapsed-session or generalized acceptance from reply count alone.', [], { evidence: 'final' }],
  ];
  return raw.map(([name, task, commands, extra], index) => ({ ordinal: index + 1, marker: `F2_${String(index + 1).padStart(2, '0')}_${name}`,
    segment: index < 13 ? 1 : 2, task, commands, ...extra }));
}
function evidenceForStep(step, record, evidenceDirectory, workspace, allowedPaths) {
  assert.equal(fs.realpathSync(evidenceDirectory), evidenceDirectory); assert.equal(fs.realpathSync(workspace), workspace);
  assert(evidenceDirectory !== workspace && !evidenceDirectory.startsWith(workspace + path.sep)
    && !workspace.startsWith(evidenceDirectory + path.sep), 'External evidence directory must be disjoint from editable workspace');
  assert(step.evidence); assert.equal(record.kind, step.evidence); assert.equal(record.status, 'REVIEWED_REAL_EVIDENCE');
  assert(Array.isArray(record.files) && record.files.length > 0);
  assert(Array.isArray(allowedPaths) && allowedPaths.length > 0);
  assert.deepEqual(record.files.map(pin => pin.path).sort(), allowedPaths.slice().sort(), 'Exactly the manifest-pinned report paths for this kind');
  assert(record.review && typeof record.review === 'string' && record.review.trim().length >= 20);
  for (const pin of record.files) {
    contained(evidenceDirectory, pin.path); assert.equal(fs.realpathSync(pin.path), pin.path);
    assert.equal(identity(pin.path).sha256, pin.sha256);
  }
  return record.files.map(pin => `cat '${pin.path.replace(/'/g, `'\\''`)}'`);
}
function promptFor(step, commands) {
  assert.deepEqual(commands.slice(0, step.commands.length), step.commands);
  return `PB02_REQUEST:${step.marker}\n${step.task}\nRun each listed command and report its observed result. Only these exact shell command bodies in the owned workspace are authorized: ${commands.map(value => JSON.stringify(value)).join(', ') || '(none)'}. `
    + (step.patch ? 'Use only native file-change/apply_patch for the single scoped proposal, never shell writes. ' : 'Do not edit files. ')
    + 'Preserve the Git index, protected notes, other seeded issues and external oracles. No package installation, network/external tools or alternate commands. Keep the final answer focused on observed facts. End PB02_DONE:' + step.marker + '.';
}
function sessionQualification({ startedAt, endedAt, replies, restart, mistakes }) {
  assert(Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt >= startedAt);
  assert.equal(replies.length, 25); assert.deepEqual(replies.map(value => value.marker), buildSteps().map(value => value.marker));
  assert.equal(new Set(replies.map(value => value.messageId)).size, 25);
  const minutes = (endedAt - startedAt) / 60000, issues = [];
  if (minutes < 45) issues.push('SHORTER_THAN_45_REAL_MINUTES');
  if (minutes > 60) issues.push('OUTSIDE_60_MINUTE_TARGET');
  if (!restart?.editorExited || !restart?.historyRestored || !restart?.priorMessagesPreserved) issues.push('REAL_EDITOR_RESTART_NOT_VERIFIED');
  if (!mistakes?.wrongScriptNonzero || !mistakes?.correctedScriptSucceeded) issues.push('WRONG_SCRIPT_RECOVERY_NOT_VERIFIED');
  if (!mistakes?.nativePatchDenied || !mistakes?.protectedNoteUnchanged) issues.push('NATIVE_DENIED_SCOPE_RECOVERY_NOT_VERIFIED');
  issues.push('ORDINARY_MISTAKE_COVERAGE_NOT_ESTABLISHED_BY_DELIBERATE_INJECTIONS');
  return { status: issues.length ? 'PARTIAL_S_SESSION' : 'PASS_BOUNDED_S_SESSION', elapsedMinutes: minutes, completedUsefulTurns: 25, issues,
    recoveryScope: 'Two deliberate injected faults; no ordinary model-mistake credit inferred', W: 'NOT_RUN', E: 'NOT_RUN', P: 'NOT_RUN' };
}
module.exports = { STAGE, MAIN_CAP, HELPER_CAP, SELECTED, CONTRACT_SHA, PUBLIC_ISSUES_SHA, NOTE, APPLICATION_LOG, ASSET_LINKS, hash, identity, contained,
  exactFile, copyPrivateDependencies, buildRepairs, patchScope, verifySnapshot, buildSteps, evidenceForStep, promptFor, sessionQualification, exactCommand };
