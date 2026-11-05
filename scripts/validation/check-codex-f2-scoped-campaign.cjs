'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const c = require('./codex-f2-scoped-campaign.cjs');
const repo = path.resolve(__dirname, '../..'), root = path.join(repo, 'out-test/feature-tests/PB-02');
const prepared = path.join(root, 'overnight-20261011/f2-workload-preparation');
const directory = fs.mkdtempSync(path.join(root, 'f2-scoped-campaign-controls-')), workspace = path.join(directory, 'workspace');
fs.mkdirSync(workspace); const checks = [];
const check = (name, fn) => { fn(); checks.push({ name, status: 'PASS' }); };
const repairs = c.buildRepairs(path.join(prepared, 'contracts/case-contracts.json'), path.join(root, 'overnight-20261011/f2-adapted-baseline/workspace'), path.join(prepared, 'seeded-workspace'));
const fixture = { workspace, repairs, commandPolicy: c.buildCommandPolicy(workspace), files: {}, generatedDirectories: ['client/build', 'client/node_modules', 'node_modules', 'server/.tmp', 'server/node_modules'] };
function seed(relative, text) { const file = path.join(workspace, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); fixture.files[relative] = { sha256: c.hash(text) }; }
for (const repair of Object.values(repairs)) seed(repair.path, repair.before);
seed(c.NOTE, 'KEEP_THIS_DEVELOPER_NOTE\n'); seed('.git/index', 'CONTROL_INDEX_BYTES\n'); seed('immutable-test.js', 'assert(true);\n');
fixture.indexSha256 = fixture.files['.git/index'].sha256;
fixture.deniedNote = { path: c.NOTE, before: 'KEEP_THIS_DEVELOPER_NOTE\n', after: 'REQUESTED_SCOPE_CHANGE\n', beforeSha256: c.hash('KEEP_THIS_DEVELOPER_NOTE\n'), afterSha256: c.hash('REQUESTED_SCOPE_CHANGE\n') };
function proposal(repair) {
  const before = path.join(directory, 'before'), after = path.join(directory, 'after'); fs.writeFileSync(before, repair.before); fs.writeFileSync(after, repair.after);
  let diff; try { execFileSync('/usr/bin/diff', ['-u', before, after], { encoding: 'utf8' }); throw Error('Expected differing correction'); }
  catch (error) { assert.equal(error.status, 1); diff = error.stdout.split('\n').slice(2).join('\n'); }
  return [{ path: repair.path, kind: { type: 'update' }, diff }];
}
for (const id of c.SELECTED) {
  const repair = repairs[id], changes = proposal(repair);
  check(`${id}: real frozen seeded proposal is scoped before approval`, () => assert(c.patchScope(changes, fixture, id)));
  check(`${id}: same immutable proposal is scoped after exact applied bytes`, () => { fs.writeFileSync(path.join(workspace, repair.path), repair.after); assert(c.patchScope(changes, fixture, id)); c.verifySnapshot(fixture, [id]); fs.writeFileSync(path.join(workspace, repair.path), repair.before); });
  check(`${id}: second changed file rejected`, () => assert(!c.patchScope([...changes, { ...changes[0], path: 'immutable-test.js' }], fixture, id)));
  check(`${id}: wrong target rejected`, () => assert(!c.patchScope([{ ...changes[0], path: c.NOTE }], fixture, id)));
  check(`${id}: rename rejected`, () => assert(!c.patchScope([{ ...changes[0], kind: { type: 'update', movePath: 'other.js' } }], fixture, id)));
  check(`${id}: extra executable code rejected`, () => assert(!c.patchScope(proposal({ ...repair, after: repair.after + 'process.exit(0);\n' }), fixture, id)));
  check(`${id}: corrupt context rejected`, () => assert(!c.patchScope([{ ...changes[0], diff: changes[0].diff.replace(/^ /m, ' BAD_CONTEXT') }], fixture, id)));
}
check('B09 leaves B10 descending order and B11 every-member seed intact', () => {
  assert.deepEqual(repairs['F2-B09'].preservedOtherSeeds, ['F2-B10', 'F2-B11']);
  assert(repairs['F2-B09'].after.includes("return this.cards.orderBy('position', false);"));
  assert(repairs['F2-B09'].after.includes('return users.every((user) => filterUserIds.includes(user.id));'));
  const extra = { ...repairs['F2-B09'], after: repairs['F2-B09'].after.replace("return this.cards.orderBy('position', false);", "return this.cards.orderBy('position');") };
  assert(!c.patchScope(proposal(extra), fixture, 'F2-B09'));
});
check('denied note proposal is identifiable but cannot qualify as an approved source repair', () => {
  const changes = proposal(fixture.deniedNote); assert(c.patchScope(changes, fixture, 'deny-notes'));
  for (const id of c.SELECTED) assert(!c.patchScope(changes, fixture, id));
});
check('clean fixture snapshot passes', () => c.verifySnapshot(fixture));
const appLog = path.join(workspace, c.APPLICATION_LOG), appLogDirectory = path.dirname(appLog);
fs.mkdirSync(appLogDirectory, { recursive: true });
check('archived original snapshot rejects the actual generated-log shape and revised snapshot records it separately', () => {
  const archiveManifest = path.join(root, 'overnight-20261011/native-f2-short-session/segment-1/original-harness-manifest.json');
  const archived = JSON.parse(fs.readFileSync(archiveManifest)).files.find(row => row.original === require.resolve('./codex-f2-campaign.cjs'));
  assert(archived); assert.equal(c.identity(archived.archive).sha256, archived.sha256);
  const Module = require('node:module'), old = new Module(archived.original, module); old.filename = archived.original; old.paths = module.paths;
  old._compile(fs.readFileSync(archived.archive, 'utf8'), archived.original);
  fs.writeFileSync(appLog, 'Actual root application startup log shape\n');
  assert.throws(() => old.exports.verifySnapshot(fixture), /No unapproved added or removed files/);
  const snapshot = c.verifySnapshot(fixture); assert.equal(snapshot.applicationLogs.length, 1);
  assert.deepEqual(snapshot.applicationLogs[0], { relative: c.APPLICATION_LOG, path: appLog, sha256: c.hash(fs.readFileSync(appLog)), bytes: fs.statSync(appLog).size });
  assert(!Object.hasOwn(snapshot.hashes, c.APPLICATION_LOG)); assert(!snapshot.productFiles.some(row => row.relative === c.APPLICATION_LOG));
});
check('normal application log append changes recorded bytes without widening source/index authority', () => {
  const before = c.verifySnapshot(fixture).applicationLogs[0]; fs.appendFileSync(appLog, 'next real application start\n');
  const after = c.verifySnapshot(fixture).applicationLogs[0]; assert(after.bytes > before.bytes); assert.notEqual(after.sha256, before.sha256);
  for (const relative of ['.git/index', c.NOTE, repairs['F2-B01'].path]) {
    const file = path.join(workspace, relative), bytes = fs.readFileSync(file); fs.appendFileSync(file, 'unapproved');
    try { assert.throws(() => c.verifySnapshot(fixture)); } finally { fs.writeFileSync(file, bytes); }
  }
});
for (const name of ['planka.log.1', 'other.log', 'unapproved.cjs']) check(`application log exception rejects sibling ${name}`, () => {
  const file = path.join(appLogDirectory, name); fs.writeFileSync(file, 'unapproved');
  try { assert.throws(() => c.verifySnapshot(fixture)); } finally { fs.unlinkSync(file); }
});
fs.unlinkSync(appLog);
check('application log cannot be a symbolic link', () => {
  fs.symlinkSync(path.join(workspace, c.NOTE), appLog);
  try { assert.throws(() => c.verifySnapshot(fixture)); } finally { fs.unlinkSync(appLog); }
});
check('application log cannot be a hard link to another owned source', () => {
  fs.linkSync(path.join(workspace, c.NOTE), appLog);
  try { assert.throws(() => c.verifySnapshot(fixture)); } finally { fs.unlinkSync(appLog); }
});
check('application log cannot be a directory', () => {
  fs.mkdirSync(appLog);
  try { assert.throws(() => c.verifySnapshot(fixture)); } finally { fs.rmdirSync(appLog); }
});
check('application log parent cannot be a symbolic link', () => {
  fs.rmdirSync(appLogDirectory); const other = path.join(directory, 'outside-logs'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'planka.log'), 'outside'); fs.symlinkSync(other, appLogDirectory, 'dir');
  try { assert.throws(() => c.verifySnapshot(fixture)); } finally { fs.unlinkSync(appLogDirectory); fs.mkdirSync(appLogDirectory); }
});
check('unapproved source correction fails snapshot even if correct', () => { const repair = repairs['F2-B01']; fs.writeFileSync(path.join(workspace, repair.path), repair.after); assert.throws(() => c.verifySnapshot(fixture)); fs.writeFileSync(path.join(workspace, repair.path), repair.before); });
for (const relative of [c.NOTE, '.git/index', 'immutable-test.js']) check(`${relative} mutation rejected`, () => {
  const file = path.join(workspace, relative), bytes = fs.readFileSync(file); fs.appendFileSync(file, 'UNAPPROVED'); assert.throws(() => c.verifySnapshot(fixture, [])); fs.writeFileSync(file, bytes);
});
check('new untracked file cannot hide behind gitignore', () => { const file = path.join(workspace, 'unknown.log'); fs.writeFileSync(file, 'x'); assert.throws(() => c.verifySnapshot(fixture)); fs.unlinkSync(file); });
check('only exact actual panel history paths are permitted', () => {
  const owned = path.join(workspace, '.mysti/compaction/panel_owned/history.jsonl'); fs.mkdirSync(path.dirname(owned), { recursive: true }); fs.writeFileSync(owned, '{}\n');
  assert.throws(() => c.verifySnapshot(fixture)); c.verifySnapshot(fixture, [], ['panel_owned']);
  assert.throws(() => c.verifySnapshot(fixture, [], ['panel_foreign'])); fs.rmSync(path.join(workspace, '.mysti'), { recursive: true });
});
check('browser assets resolve only into current owned build and record real hashes', () => {
  const asset = path.join(workspace, 'client/build/index.html'), view = path.join(workspace, 'server/views/index.ejs');
  fs.mkdirSync(path.dirname(asset), { recursive: true }); fs.mkdirSync(path.dirname(view), { recursive: true }); fs.writeFileSync(asset, '<h1>owned current build</h1>');
  fs.symlinkSync('../../client/build/index.html', view);
  const snapshot = c.verifySnapshot(fixture); assert.deepEqual(snapshot.assetLinks, [{ relative: 'server/views/index.ejs', target: 'client/build/index.html', generatedFiles: [{ relative: 'client/build/index.html', sha256: c.hash('<h1>owned current build</h1>') }] }]);
  fs.unlinkSync(view); fs.symlinkSync(path.join(directory, 'outside.html'), view); assert.throws(() => c.verifySnapshot(fixture)); fs.unlinkSync(view);
});
check('symlink source cannot escape approval realpath ownership', () => {
  const repair = repairs['F2-B03'], file = path.join(workspace, repair.path), outside = path.join(directory, 'outside.js'); fs.writeFileSync(outside, repair.before); fs.unlinkSync(file); fs.symlinkSync(outside, file);
  assert(!c.patchScope(proposal(repair), fixture, 'F2-B03')); assert.throws(() => c.verifySnapshot(fixture)); fs.unlinkSync(file); fs.writeFileSync(file, repair.before);
});
const steps = c.buildSteps(workspace);
check('25 useful tasks,13/12 actual restart segments and four edits only', () => {
  assert.equal(steps.length, 25); assert.equal(new Set(steps.map(step => step.marker)).size, 25);
  assert.equal(steps.filter(step => step.segment === 1).length, 13); assert.equal(steps.filter(step => step.segment === 2).length, 12);
  assert.deepEqual(steps.filter(step => step.patch && step.patch !== 'deny-notes').map(step => step.patch), c.SELECTED);
});
check('task-runtime versions are observed inside the existing inventory turn', () => {
  assert.equal(steps[0].commands.filter(value => value === 'node --version').length, 1);
  assert.equal(steps[0].commands.filter(value => value.endsWith(' npm --version')).length, 1);
  assert.equal(steps.length, 25);
});
check('shell suffix cannot widen an exact authorized command', () => { const command = steps[0].commands[0]; assert(c.exactCommand(command, command)); assert(!c.exactCommand(command + '; touch other', command)); });
const replies = steps.map((step, index) => ({ marker: step.marker, messageId: `actual-${index}` }));
const evidence = { startedAt: 1000, endedAt: 1000 + 50 * 60000, replies, restart: { editorExited: true, historyRestored: true, priorMessagesPreserved: true }, mistakes: { wrongScriptNonzero: true, correctedScriptSucceeded: true, nativePatchDenied: true, protectedNoteUnchanged: true } };
check('50minutes and injected recovery cannot establish ordinary model mistakes', () => {
  const result = c.sessionQualification(evidence); assert.equal(result.status, 'PARTIAL_S_SESSION');
  assert.deepEqual(result.issues, ['ORDINARY_MISTAKE_COVERAGE_NOT_ESTABLISHED_BY_DELIBERATE_INJECTIONS']);
});
check('accelerated25 does not earn elapsed S', () => assert(c.sessionQualification({ ...evidence, endedAt: 1000 + 8 * 60000 }).issues.includes('SHORTER_THAN_45_REAL_MINUTES')));
check('model-only refusal does not earn native denial coverage', () => assert(c.sessionQualification({ ...evidence, mistakes: { ...evidence.mistakes, nativePatchDenied: false } }).issues.includes('NATIVE_DENIED_SCOPE_RECOVERY_NOT_VERIFIED')));
check('reload without editor exit does not earn restart', () => assert(c.sessionQualification({ ...evidence, restart: { ...evidence.restart, editorExited: false } }).issues.includes('REAL_EDITOR_RESTART_NOT_VERIFIED')));
check('replayed message identity rejected', () => assert.throws(() => c.sessionQualification({ ...evidence, replies: replies.map((reply, i) => i === 24 ? { ...reply, messageId: replies[0].messageId } : reply) })));
const evidenceDirectory = path.join(directory, 'evidence'); fs.mkdirSync(evidenceDirectory);
const reportFile = path.join(evidenceDirectory, 'external-evidence.json'); fs.writeFileSync(reportFile, '{"actual":"controlled"}\n');
const gate = { kind: 'baseline', status: 'REVIEWED_REAL_EVIDENCE', review: 'Controlled test only; no real application outcome claimed.', files: [c.identity(reportFile)] };
check('evidence gate consumes exact pinned outside-workspace report', () => assert.equal(c.evidenceForStep(steps[3], gate, evidenceDirectory, workspace, [reportFile]).length, 1));
check('wrong report hash rejected', () => assert.throws(() => c.evidenceForStep(steps[3], { ...gate, files: [{ ...gate.files[0], sha256: '0'.repeat(64) }] }, evidenceDirectory, workspace, [reportFile])));
check('evidence gate cannot read outside exact artifact root', () => assert.throws(() => c.evidenceForStep(steps[3], gate, workspace, workspace, [reportFile])));
check('unreviewed report does not unlock a turn', () => assert.throws(() => c.evidenceForStep(steps[3], { ...gate, status: 'PENDING' }, evidenceDirectory, workspace, [reportFile])));
check('a pinned workspace source cannot masquerade as external evidence', () => {
  const file = path.join(workspace, 'immutable-test.js'); assert.throws(() => c.evidenceForStep(steps[3], { ...gate, files: [c.identity(file)] }, directory, workspace, [file]));
});
check('a different pinned external report is not an allowed manifest path', () => assert.throws(() => c.evidenceForStep(steps[3], gate, evidenceDirectory, workspace, [path.join(evidenceDirectory, 'other.json')])));
check('actual permitted Git status/diff preserve copied index bytes with staged notes and unstaged source', () => {
  const copy = path.join(directory, 'git-copy'), gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' };
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--local', '--no-hardlinks', '--', path.join(prepared, 'seeded-workspace'), copy], { env: gitEnv, stdio: 'pipe' });
  fs.mkdirSync(path.join(copy, '.pb02')); fs.writeFileSync(path.join(copy, c.NOTE), 'KEEP_THIS_DEVELOPER_NOTE\n');
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'add', '--', c.NOTE], { cwd: copy, env: gitEnv, stdio: 'pipe' });
  fs.writeFileSync(path.join(copy, repairs['F2-B01'].path), repairs['F2-B01'].after);
  const before = fs.readFileSync(path.join(copy, '.git/index'));
  for (const command of [...new Set(steps.flatMap(step => step.commands).filter(value => value.startsWith('git ')))]) {
    execFileSync('/bin/zsh', ['-c', command], { cwd: copy, env: gitEnv, stdio: 'pipe' });
    assert(fs.readFileSync(path.join(copy, '.git/index')).equals(before));
  }
});

check('inventory names all four selected IDs without adding a turn',()=>{for(const id of c.SELECTED)assert(steps[0].task.includes(id));assert.equal(steps.length,25);});
check('each npm body pins notifier offline caches logs and requires actual per-command approval',()=>{for(const step of steps)for(const command of step.commands.filter(v=>/(^| )npm /.test(v))){for(const value of ["npm_config_update_notifier='false'","npm_config_offline='true'","npm_config_logs_max='50'",'npm_config_logs_dir=', 'TMPDIR='])assert(command.includes(value));assert(step.requiresEscalation.includes(command));}assert(steps.filter(step=>step.requiresEscalation.length).every(step=>[1,3,6,7,21].includes(step.ordinal)));});
check('read prompts stay restrictive while exact generated command prompts permit cache output',()=>{for(const step of steps){const prompt=c.promptFor(step,step.commands);if(step.requiresEscalation.length){assert(prompt.includes('sandbox_permissions="require_escalated"'));assert(!prompt.includes('Do not edit files.'));assert(prompt.includes('Keep the conversation untrusted/read-only policy'));}else assert(!prompt.includes('sandbox_permissions='));}});
check('both actual test stages use fixed direct npm flag forwarding and exact owned Jest cache',()=>{for(const ordinal of [3,7]){const command=steps[ordinal-1].commands.find(v=>v.includes('npm --prefix client test'));assert(command.includes('-- --watchAll=false --runInBand --cacheDirectory='));assert(command.includes(fixture.commandPolicy.cacheDirectories.jest));}});
check('production build retains lint and sourcemaps at owned original output',()=>{const command=steps[20].commands.find(v=>v.endsWith('npm run client:build'));assert(command.includes('GENERATE_SOURCEMAP=true'));assert(command.includes('DISABLE_ESLINT_PLUGIN=false'));assert(!command.includes('BUILD_PATH='));assert.equal(fixture.commandPolicy.buildRoot,path.join(workspace,'client/build'));});
check('actual missing script diagnostic accepted, generic permission failure rejected',()=>{c.assertMissingScript('npm error Missing script: "client:tset"\n');assert.throws(()=>c.assertMissingScript('Error: EPERM operation not permitted'));assert.throws(()=>c.assertMissingScript('npm error Missing script: "client:test"'));});
const cacheRoot=fixture.commandPolicy.craCacheRoot;for(const dir of [...Object.values(fixture.commandPolicy.cacheDirectories),fixture.commandPolicy.npmLogs])fs.mkdirSync(dir,{recursive:true});
const log=path.join(fixture.commandPolicy.npmLogs,'owned-debug-0.log');fs.writeFileSync(log,'12 verbose title npm test\n');
check('normal owned npm diagnostics do not imply a network request',()=>{const snapshot=c.cacheSnapshot(fixture.commandPolicy);assert.equal(snapshot.httpActivity.length,0);c.assertBoundary({cacheSnapshot:snapshot});});
check('actual first-proof HTTP fetch shape is retained and rejects scope',()=>{fs.appendFileSync(log,'13 http fetch GET 200 https://registry.npmjs.org/npm 105ms\n');const snapshot=c.cacheSnapshot(fixture.commandPolicy);assert.equal(snapshot.httpActivity.length,1);assert.equal(snapshot.httpActivity[0].lineNumber,2);assert.throws(()=>c.assertBoundary({cacheSnapshot:snapshot}));fs.writeFileSync(log,'12 verbose title npm test\n');});
check('a URL mentioned in non-network diagnostics earns no false fetch attribution',()=>{fs.appendFileSync(log,'13 verbose help https://registry.npmjs.org/npm\n');assert.equal(c.cacheSnapshot(fixture.commandPolicy).httpActivity.length,0);});
check('unrecognized CRA cache child rejected',()=>{const file=path.join(cacheRoot,'unapproved');fs.writeFileSync(file,'x');assert.throws(()=>c.cacheSnapshot(fixture.commandPolicy));fs.unlinkSync(file);});
check('generated cache symlink rejected',()=>{const file=path.join(fixture.commandPolicy.cacheDirectories.tmp,'escape');fs.symlinkSync(path.join(workspace,c.NOTE),file);assert.throws(()=>c.cacheSnapshot(fixture.commandPolicy));fs.unlinkSync(file);});
check('generated cache hardlink rejected',()=>{const file=path.join(fixture.commandPolicy.cacheDirectories.tmp,'linked');fs.linkSync(log,file);assert.throws(()=>c.cacheSnapshot(fixture.commandPolicy));fs.unlinkSync(file);});
const proof=require('./codex-f2-test-proof.cjs'),deps=path.join(workspace,'node_modules');fs.mkdirSync(deps);fs.writeFileSync(path.join(deps,'immutable.cjs'),'exact dependency');
fixture.dependencyCopies=[{target:deps,...proof.dependencyTree(deps)}];
check('unchanged dependency and scoped generated output pass heavy boundary',()=>c.assertBoundary(c.verifyBoundary(fixture)));
check('dependency mutation is caught by heavy boundary',()=>{fs.appendFileSync(path.join(deps,'immutable.cjs'),'mutation');assert.throws(()=>c.verifyBoundary(fixture));fs.writeFileSync(path.join(deps,'immutable.cjs'),'exact dependency');});
check('empty dependency sibling directory is not an ignored growth exception',()=>{fs.mkdirSync(path.join(deps,'unexpected'));assert.throws(()=>c.verifyBoundary(fixture));fs.rmdirSync(path.join(deps,'unexpected'));});
check('build map identity joins actual selected source and rejects stale content',()=>{const map=path.join(fixture.commandPolicy.buildRoot,'main.js.map'),sources=['models/List.js','components/Card/Tasks.jsx'];const sourcesContent=sources.map(relative=>fs.readFileSync(path.join(workspace,'client/src',relative),'utf8'));fs.writeFileSync(map,JSON.stringify({sources,sourcesContent}));const snapshot=c.buildSnapshot(fixture);assert.deepEqual(Object.keys(snapshot.sourceMapMatches).sort(),['client/src/components/Card/Tasks.jsx','client/src/models/List.js']);fs.writeFileSync(map,JSON.stringify({sources,sourcesContent:['stale',sourcesContent[1]]}));assert.throws(()=>c.buildSnapshot(fixture));fs.unlinkSync(map);});

const report = { status: 'PASS_CONTROLS_NO_NATIVE_INFERENCE', checkedAt: new Date().toISOString(), contract: c.identity(require.resolve('./codex-f2-scoped-campaign.cjs')), checks,
  limitations: ['Pure approval/snapshot/session controls only. Real native journey and independent aggregate audit still require preparation and review.', 'The terminal fixtures in these controls are synthetic; no real S elapsed or inference credit.'] };
const target = path.join(directory, 'checks.json'); fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ path: target, sha256: c.identity(target).sha256, passed: checks.length }));
