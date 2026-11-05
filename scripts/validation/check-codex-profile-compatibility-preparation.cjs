/* Owned preparation controls only. No editor or provider launch. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process'), { createHash } = require('node:crypto');
const { verifyPreservedBase, verifyCopiedFixture, createOwnedProfiles, verifyOwnedProfiles, cleanupOwnedProfiles } = require('./codex-profile-validation-contract.cjs');
const repo = path.resolve(__dirname, '../..'), root = path.join(repo, 'out-test/feature-tests/PB-02');
const directory = fs.mkdtempSync(path.join(root, 'codex-profile-compatibility-preparation-controls-'));
const compiledDirectory = fs.realpathSync(process.argv[2]); assert(compiledDirectory.startsWith(fs.realpathSync(root) + path.sep));
const read = file => JSON.parse(fs.readFileSync(file)), hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const packageIdentity = path.resolve(process.env.MYSTI_PB02_PROFILE_COMPATIBILITY_PACKAGE_IDENTITY || path.join(root, 'resume-20261011/profile-appserver/package-identity.json'));
const sourceIdentity = path.resolve(process.env.MYSTI_PB02_PROFILE_COMPATIBILITY_SOURCE_IDENTITY || path.join(root, 'resume-20261011/profile-appserver/source-identity.json'));
const attempt = path.join(directory, 'prepared-only'), script = path.join(__dirname, 'prepare-vscode-codex-profile-compatibility.cjs');
const controlHome = path.join(directory, 'synthetic-code-home'); fs.mkdirSync(controlHome);
const profileArtifacts = path.join(directory, 'synthetic-profile-files'); fs.mkdirSync(profileArtifacts);
const ownedProfiles = createOwnedProfiles({ artifactDir: profileArtifacts, controlHome });
const env = { ...process.env, MYSTI_PB02_PROFILE_COMPATIBILITY_PROFILES: path.join(profileArtifacts, 'profile-files.json'), MYSTI_TEST_EXTENSION_PATH: read(packageIdentity).extension,
  MYSTI_PB02_PROFILE_COMPATIBILITY_PACKAGE_IDENTITY: packageIdentity, MYSTI_PB02_PROFILE_COMPATIBILITY_SOURCE_IDENTITY: sourceIdentity,
  MYSTI_PB02_PROFILE_COMPATIBILITY_COMPILED_DIR: compiledDirectory, MYSTI_PB02_PROFILE_COMPATIBILITY_ARTIFACT_DIR: attempt };
const checks = [], check = (name, fn) => { fn(); checks.push({ name, status: 'PASS' }); };
const prepare = (extra = {}) => spawnSync(process.execPath, [script], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 45000, maxBuffer: 10e6 });
const first = prepare();
fs.writeFileSync(path.join(directory, 'preparation-process.json'), JSON.stringify({ status: first.status, signal: first.signal, stdout: first.stdout, stderr: first.stderr }, null, 2));
assert.equal(first.status, 0, first.stderr);
const manifest = read(path.join(attempt, 'prepared.json')), owner = manifest.windows.A;
check('Fresh ordinary profile fits the macOS socket bound and pins the bounded two-reply release', () => {
  assert.match(path.basename(owner.profile), /^pb02-c2-A-[A-Za-z0-9]{6}$/);
  if (process.platform === 'darwin') assert(Buffer.byteLength(path.join(owner.profile, '1.14-main.sock')) <= 103);
  assert.equal(manifest.stage, 'PROFILE_COMPATIBILITY_2'); assert.equal(manifest.compiledDirectory, compiledDirectory);
  assert.equal(manifest.model, 'gpt-5.6-sol'); assert.equal(manifest.plannedSuccessfulTurns, 2);
  assert.equal(manifest.maxForwardedInputs, 3); assert.equal(manifest.auxiliary.maxInputs, 5);
  assert.equal(manifest.preparedBeforeActivation, true); assert.equal(JSON.parse(first.stdout).launchesPerformed, 0);
  const pins = [...Object.values(manifest.executableIdentities), ...manifest.wrapperIdentities,
    ...manifest.harnessDependencyIdentities, manifest.nodeIdentity, manifest.readiness, manifest.sourceIdentity, manifest.packageIdentity];
  for (const pin of pins) assert.equal(hash(pin.path), pin.sha256);
});
check('Every final fixture and Git byte is copied exactly; original evidence and old profiles remain unchanged', () => {
  assert.deepEqual(manifest.fixture.editableFiles, []); verifyCopiedFixture(manifest.fixture); verifyPreservedBase(manifest.fixture);
  assert.equal(fs.readFileSync(path.join(owner.workspace, 'test/read-only-policy.cjs'), 'utf8'), manifest.fixture.files['test/read-only-policy.cjs'].text);
  assert(manifest.fixture.files['test/read-only-policy.cjs'].text.includes(manifest.fixture.base.originalWorkspace));
});
check('Preparation starts no main/helper input or editor and routes both lanes', () => {
  const settings = read(path.join(owner.profile, 'User/settings.json'));
  assert.equal(settings['mysti.codexPath'], owner.wrappers['openai-codex']);
  assert.equal(settings['mysti.claudeCodePath'], owner.wrappers['claude-code']);
  assert.equal(settings['mysti.codexProfile'], ownedProfiles.profiles.A.name); assert.notEqual(settings['mysti.planDetection.enabled'], false);
  for (const file of owner.auxiliaryReceiptPaths) assert.equal(fs.readFileSync(file, 'utf8'), '');
  for (const file of [manifest.counterFile, manifest.auxiliary.counterFile, ...owner.receiptPaths,
    path.join(attempt, 'launch-reservation.json'), path.join(owner.directory, 'helper-ready.json')]) assert(!fs.existsSync(file));
});
check('Existing attempts, aliased parents and any prepared ancestor are rejected before new creation', () => {
  const before = hash(path.join(attempt, 'prepared.json')); assert.notEqual(prepare().status, 0);
  const alias = path.join(directory, 'alias'); fs.symlinkSync(directory, alias, 'dir');
  for (const target of [path.join(alias, 'forbidden'), path.join(attempt, 'forbidden'), path.join(owner.workspace, 'forbidden')]) {
    assert(!fs.existsSync(target)); const result = prepare({ MYSTI_PB02_PROFILE_COMPATIBILITY_ARTIFACT_DIR: target });
    assert.notEqual(result.status, 0); assert(!fs.existsSync(target));
  }
  assert.equal(hash(path.join(attempt, 'prepared.json')), before);
});
check('A copied source, test or canary mutation is rejected even with the original baseline unstaged diff', () => {
  for (const relative of ['src/retry.cjs', 'test/retry.test.cjs', 'canaries/approval.txt']) {
    const file = path.join(owner.workspace, relative), before = fs.readFileSync(file);
    try { fs.appendFileSync(file, '\nunauthorized\n'); assert.throws(() => verifyCopiedFixture(manifest.fixture)); }
    finally { fs.writeFileSync(file, before); }
  }
  verifyCopiedFixture(manifest.fixture);
});
check('A changed copied Git index or added arbitrary file is rejected', () => {
  const index = path.join(owner.workspace, '.git/index'), before = fs.readFileSync(index);
  try { fs.appendFileSync(index, 'changed'); assert.throws(() => verifyCopiedFixture(manifest.fixture)); }
  finally { fs.writeFileSync(index, before); }
  const extra = path.join(owner.workspace, 'unapproved.txt');
  try { fs.writeFileSync(extra, 'no', { flag: 'wx' }); assert.throws(() => verifyCopiedFixture(manifest.fixture)); }
  finally { fs.unlinkSync(extra); }
  verifyCopiedFixture(manifest.fixture);
});
check('Only the new actual panel history is admitted as a product artifact', () => {
  const panelId = 'synthetic-owned-panel', history = path.join(owner.workspace, `.mysti/compaction/${panelId}/history.jsonl`);
  fs.mkdirSync(path.dirname(history), { recursive: true });
  try {
    fs.writeFileSync(history, '{}\n', { flag: 'wx' }); assert.equal(verifyCopiedFixture(manifest.fixture, panelId).productArtifacts.length, 1);
    assert.throws(() => verifyCopiedFixture(manifest.fixture, 'other-panel'));
  } finally { fs.unlinkSync(history); fs.rmdirSync(path.dirname(history)); }
  verifyCopiedFixture(manifest.fixture); verifyPreservedBase(manifest.fixture);
});
check('Two profiles are exact exclusive-owned files and synthetic preparation cannot launch a native editor', () => {
  assert.deepEqual(manifest.profileValidation, ownedProfiles); assert.equal(ownedProfiles.controlOnly, true); verifyOwnedProfiles(ownedProfiles);
  const runtime = fs.readFileSync(path.join(owner.cliDirectory, 'codex-pb02-profile-compatibility-fixture'), 'utf8');
  assert(runtime.includes(JSON.stringify(ownedProfiles)));
  const attempted = spawnSync(process.execPath, [path.join(__dirname, 'run-vscode-codex-profile-compatibility.cjs')], { env, encoding: 'utf8', timeout: 10000 });
  assert.notEqual(attempted.status, 0); assert(attempted.stderr.includes('Synthetic profile preparation can never launch native inference'));
  assert(!fs.existsSync(path.join(attempt, 'launch-reservation.json')));
});
check('Cleanup rejects changed bytes, inode, mode, path and symlink before deleting either owned file', () => {
  const file = ownedProfiles.profiles.B.path, before = fs.readFileSync(file);
  try { fs.appendFileSync(file, '# changed\n'); assert.throws(() => cleanupOwnedProfiles(ownedProfiles)); }
  finally { fs.writeFileSync(file, before); }
  assert(fs.existsSync(ownedProfiles.profiles.A.path));
  try { fs.chmodSync(file, 0o644); assert.throws(() => cleanupOwnedProfiles(ownedProfiles)); }
  finally { fs.chmodSync(file, 0o600); }
  for (const key of ['ino', 'dev']) { const bad = structuredClone(ownedProfiles); bad.profiles.B[key]++; assert.throws(() => cleanupOwnedProfiles(bad)); }
  const bad = structuredClone(ownedProfiles); bad.profiles.B.path = ownedProfiles.profiles.A.path; assert.throws(() => cleanupOwnedProfiles(bad));
  const backup = file + '.owned-control-backup'; fs.renameSync(file, backup);
  try { fs.symlinkSync(backup, file); assert.throws(() => cleanupOwnedProfiles(ownedProfiles)); }
  finally { fs.unlinkSync(file); fs.renameSync(backup, file); }
  verifyOwnedProfiles(ownedProfiles); assert(fs.existsSync(ownedProfiles.profiles.A.path));
});
check('Guarded cleanup removes exactly both unchanged control files and no base or unrelated file', () => {
  const extra = path.join(controlHome, 'unrelated.toml'); fs.writeFileSync(extra, 'preserve', { flag: 'wx' });
  const result = cleanupOwnedProfiles(ownedProfiles); assert.equal(result.status, 'PASS_OWNED_PROFILES_REMOVED'); assert.equal(result.removed.length, 2);
  assert.equal(fs.readFileSync(extra, 'utf8'), 'preserve'); assert(result.removed.every(value => value.absent));
});
const report = { status: 'PASS', directory, compiledDirectory, prepared: path.join(attempt, 'prepared.json'), checks,
  realProviderInputs: 0, editorLaunches: 0, scope: 'New owned preparation only. Control profile is never launched; original tree and profiles stay unchanged.' };
fs.writeFileSync(path.join(directory, 'checks.json'), JSON.stringify(report, null, 2), { flag: 'wx' }); console.log(JSON.stringify(report));
