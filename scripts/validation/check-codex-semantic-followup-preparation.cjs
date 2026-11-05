/* Owned preparation controls only. No editor or provider launch. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process'), { createHash } = require('node:crypto');
const { verifyPreservedBase, verifyCopiedFixture } = require('./codex-semantic-followup-contract.cjs');
const repo = path.resolve(__dirname, '../..'), root = path.join(repo, 'out-test/feature-tests/PB-02');
const directory = fs.mkdtempSync(path.join(root, 'codex-semantic-followup-preparation-controls-'));
const compiledDirectory = fs.realpathSync(process.argv[2]); assert(compiledDirectory.startsWith(fs.realpathSync(root) + path.sep));
const read = file => JSON.parse(fs.readFileSync(file)), hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const packageIdentity = path.resolve(process.env.MYSTI_PB02_SEMANTIC_FOLLOWUP_PACKAGE_IDENTITY || path.join(root, 'utf8-20261010/validation-retry/package-identity.json'));
const sourceIdentity = path.resolve(process.env.MYSTI_PB02_SEMANTIC_FOLLOWUP_SOURCE_IDENTITY || path.join(root, 'utf8-20261010/validation-retry/source-identity.json'));
const attempt = path.join(directory, 'prepared-only'), script = path.join(__dirname, 'prepare-vscode-codex-semantic-followup.cjs');
const env = { ...process.env, MYSTI_TEST_EXTENSION_PATH: read(packageIdentity).extension,
  MYSTI_PB02_SEMANTIC_FOLLOWUP_PACKAGE_IDENTITY: packageIdentity, MYSTI_PB02_SEMANTIC_FOLLOWUP_SOURCE_IDENTITY: sourceIdentity,
  MYSTI_PB02_SEMANTIC_FOLLOWUP_COMPILED_DIR: compiledDirectory, MYSTI_PB02_SEMANTIC_FOLLOWUP_ARTIFACT_DIR: attempt };
const checks = [], check = (name, fn) => { fn(); checks.push({ name, status: 'PASS' }); };
const prepare = (extra = {}) => spawnSync(process.execPath, [script], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 45000, maxBuffer: 10e6 });
const first = prepare();
fs.writeFileSync(path.join(directory, 'preparation-process.json'), JSON.stringify({ status: first.status, signal: first.signal, stdout: first.stdout, stderr: first.stderr }, null, 2));
assert.equal(first.status, 0, first.stderr);
const manifest = read(path.join(attempt, 'prepared.json')), owner = manifest.windows.A;
check('Fresh ordinary profile fits the macOS socket bound and pins the bounded two-reply release', () => {
  assert.match(path.basename(owner.profile), /^pb02-s2-A-[A-Za-z0-9]{6}$/);
  if (process.platform === 'darwin') assert(Buffer.byteLength(path.join(owner.profile, '1.14-main.sock')) <= 103);
  assert.equal(manifest.stage, 'SEMANTIC_FOLLOWUP_2'); assert.equal(manifest.compiledDirectory, compiledDirectory);
  assert.equal(manifest.model, 'gpt-5.6-sol'); assert.equal(manifest.plannedSuccessfulTurns, 2);
  assert.equal(manifest.maxForwardedInputs, 3); assert.equal(manifest.auxiliary.maxInputs, 4);
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
  assert.equal(settings['mysti.codexProfile'], ''); assert.notEqual(settings['mysti.planDetection.enabled'], false);
  for (const file of owner.auxiliaryReceiptPaths) assert.equal(fs.readFileSync(file, 'utf8'), '');
  for (const file of [manifest.counterFile, manifest.auxiliary.counterFile, ...owner.receiptPaths,
    path.join(attempt, 'launch-reservation.json'), path.join(owner.directory, 'helper-ready.json')]) assert(!fs.existsSync(file));
});
check('Existing attempts, aliased parents and any prepared ancestor are rejected before new creation', () => {
  const before = hash(path.join(attempt, 'prepared.json')); assert.notEqual(prepare().status, 0);
  const alias = path.join(directory, 'alias'); fs.symlinkSync(directory, alias, 'dir');
  for (const target of [path.join(alias, 'forbidden'), path.join(attempt, 'forbidden'), path.join(owner.workspace, 'forbidden')]) {
    assert(!fs.existsSync(target)); const result = prepare({ MYSTI_PB02_SEMANTIC_FOLLOWUP_ARTIFACT_DIR: target });
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
const report = { status: 'PASS', directory, compiledDirectory, prepared: path.join(attempt, 'prepared.json'), checks,
  realProviderInputs: 0, editorLaunches: 0, scope: 'New owned preparation only. Control profile is never launched; original tree and profiles stay unchanged.' };
fs.writeFileSync(path.join(directory, 'checks.json'), JSON.stringify(report, null, 2), { flag: 'wx' }); console.log(JSON.stringify(report));
