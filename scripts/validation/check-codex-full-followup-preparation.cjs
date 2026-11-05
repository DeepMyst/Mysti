/* Preparation integration controls only. No editor, CLI wrapper or model launch. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const repo = path.resolve(__dirname, '../..'), root = path.join(repo, 'out-test/feature-tests/PB-02');
const directory = fs.mkdtempSync(path.join(root, 'codex-full-followup-preparation-controls-'));
const compiledDirectory = fs.realpathSync(process.argv[2]);
assert(compiledDirectory.startsWith(fs.realpathSync(root) + path.sep));
const read = file => JSON.parse(fs.readFileSync(file)), hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const packageIdentity = path.join(root, 'resume-20261010/package-identity.json');
const sourceIdentity = path.join(root, 'resume-20261010/source-identity.json');
const attempt = path.join(directory, 'prepared-only'), script = path.join(__dirname, 'prepare-vscode-codex-full-followup.cjs');
const env = { ...process.env, MYSTI_TEST_EXTENSION_PATH: read(packageIdentity).extension,
  MYSTI_PB02_FULL_FOLLOWUP_PACKAGE_IDENTITY: packageIdentity, MYSTI_PB02_FULL_FOLLOWUP_SOURCE_IDENTITY: sourceIdentity,
  MYSTI_PB02_FULL_FOLLOWUP_COMPILED_DIR: compiledDirectory, MYSTI_PB02_FULL_FOLLOWUP_ARTIFACT_DIR: attempt };
const checks = [];
function check(name, fn) { fn(); checks.push({ name, status: 'PASS' }); }
function prepare(extra = {}) { return spawnSync(process.execPath, [script], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000 }); }
const first = prepare();
fs.writeFileSync(path.join(directory, 'preparation-process.json'), JSON.stringify({ status: first.status, signal: first.signal, stdout: first.stdout, stderr: first.stderr }, null, 2));
assert.equal(first.status, 0, first.stderr);
const manifest = read(path.join(attempt, 'prepared.json')), owner = manifest.windows.A;
check('Fresh profile uses the short prefix and fits the observed macOS IPC socket byte limit', () => {
  assert.match(path.basename(owner.profile), /^pb02-f25-A-[A-Za-z0-9]{6}$/);
  const socket = path.join(owner.profile, '1.14-main.sock');
  if (process.platform === 'darwin') assert(Buffer.byteLength(socket, 'utf8') <= 103, socket);
  const rejected = path.join(path.dirname(owner.profile), 'pb02-full-followup-A-Yqht1K', '1.14-main.sock');
  assert(Buffer.byteLength(socket, 'utf8') < Buffer.byteLength(rejected, 'utf8'));
});
check('Fresh isolated preparation pins current release, new compiled files and every runtime dependency', () => {
  assert.equal(manifest.stage, 'FULL_25_FOLLOWUP'); assert.equal(manifest.compiledDirectory, compiledDirectory);
  assert.equal(manifest.preparedBeforeActivation, true); assert.equal(JSON.parse(first.stdout).launchesPerformed, 0);
  assert.equal(manifest.plannedSuccessfulTurns, 25); assert.equal(manifest.maxForwardedInputs, 29);
  assert.equal(manifest.model, 'gpt-6.1-sol'); assert.equal(manifest.auxiliary.maxInputs, 32);
  const pins = [...Object.values(manifest.executableIdentities), ...manifest.wrapperIdentities,
    ...manifest.harnessDependencyIdentities, manifest.nodeIdentity, manifest.readiness, manifest.sourceIdentity, manifest.packageIdentity];
  for (const pin of pins) assert.equal(hash(pin.path), pin.sha256);
  for (const name of ['codex-full-followup-oracle.cjs', 'codex-full-readonly-probe.cjs', 'codex-full-readonly-oracle.cjs',
    'http-date-portability-oracle.cjs', 'audit-vscode-codex-full-followup.cjs', 'codex-full-followup-auxiliary.cjs']) {
    assert(manifest.harnessDependencyIdentities.some(pin => pin.path === path.join(__dirname, name)));
  }
  for (const name of ['codex-full-followup.test.js', 'codex-full-followup-observer.js']) {
    assert(manifest.harnessDependencyIdentities.some(pin => pin.path === path.join(compiledDirectory, name)));
  }
});
check('Owned immutable canary probe is exact generated source and preserves the staged baseline', () => {
  const expected = require('./codex-full-readonly-probe.cjs').createReadOnlyProbe({ workspace: owner.workspace,
    canaryContent: manifest.fixture.files['canaries/approval.txt'].text });
  assert.deepEqual(manifest.readonlyProbe, expected.manifest);
  assert.equal(fs.readFileSync(path.join(owner.workspace, expected.manifest.relativePath), 'utf8'), expected.source);
  assert.equal(manifest.fixture.files[expected.manifest.relativePath].sha256, expected.manifest.sha256);
  assert(!manifest.fixture.editableFiles.includes(expected.manifest.relativePath));
  assert.equal(execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'ls-files', '--stage'], { cwd: owner.workspace, encoding: 'utf8' }), manifest.fixture.originalIndex);
  assert.equal(hash(path.join(owner.workspace, 'canaries/approval.txt')), expected.manifest.expectedCanarySha256);
});
check('Preparation starts no main or auxiliary input and no editor; fresh profile routes both observed lanes', () => {
  const settings = read(path.join(owner.profile, 'User/settings.json'));
  assert.equal(settings['mysti.codexPath'], owner.wrappers['openai-codex']);
  assert.equal(settings['mysti.claudeCodePath'], owner.wrappers['claude-code']);
  assert.equal(settings['mysti.codexProfile'], ''); assert.notEqual(settings['mysti.planDetection.enabled'], false);
  for (const file of owner.auxiliaryReceiptPaths) assert.equal(fs.readFileSync(file, 'utf8'), '');
  for (const file of [manifest.counterFile, manifest.auxiliary.counterFile, ...owner.receiptPaths,
    path.join(attempt, 'launch-reservation.json'), path.join(owner.directory, 'helper-ready.json')]) assert(!fs.existsSync(file));
});
check('An existing attempt is rejected without changing its prepared manifest', () => {
  const before = hash(path.join(attempt, 'prepared.json')); const next = prepare();
  assert.notEqual(next.status, 0); assert.match(next.stderr, /requires a new artifact directory/);
  assert.equal(hash(path.join(attempt, 'prepared.json')), before);
});
check('An aliased parent cannot create a new attempt', () => {
  const alias = path.join(directory, 'alias'); fs.symlinkSync(directory, alias, 'dir');
  const next = prepare({ MYSTI_PB02_FULL_FOLLOWUP_ARTIFACT_DIR: path.join(alias, 'should-not-exist') });
  assert.notEqual(next.status, 0); assert.match(next.stderr, /parent must not be an alias/);
  assert(!fs.existsSync(path.join(directory, 'should-not-exist')));
});
const report = { status: 'PASS', directory, compiledDirectory, prepared: path.join(attempt, 'prepared.json'), checks,
  realProviderInputs: 0, editorLaunches: 0, scope: 'Fresh fixture and immutable package preparation only. Prepared control profile is never launched.' };
fs.writeFileSync(path.join(directory, 'checks.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify(report));
