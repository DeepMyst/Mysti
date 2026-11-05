/* PB-02 stage-one preparation only: no editor, backend or clipboard launch. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { createF1 } = require('./pb02-fixture.cjs');
const { createPB02Cli } = require('./pb02-cli-fixture.cjs');
const { createPB02AuxiliaryCli } = require('./pb02-auxiliary-cli-fixture.cjs');
const { EXPECTED_ARGS } = require('./pb02-auxiliary-cli-runtime.cjs');
const repo = path.resolve(__dirname, '../..');
const root = path.join(repo, 'out-test/feature-tests/PB-02');
const artifactDir = path.resolve(process.env.MYSTI_PB02_ARTIFACT_DIR || path.join(root, 'native-stage1'));
assert(artifactDir.startsWith(root + path.sep));
fs.mkdirSync(artifactDir, { recursive: true });
const manifestFile = path.join(artifactDir, 'prepared.json');
assert(!fs.existsSync(manifestFile), 'A prepared attempt is never reused');
const readinessPath = path.join(root, 'readiness.json');
const readiness = JSON.parse(fs.readFileSync(readinessPath));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const identity = file => ({ path: fs.realpathSync(file), sha256: hash(file) });
const auxiliaryEvidencePath = path.join(root, 'auxiliary-isolation/claude-flag-evidence.json');
const auxiliaryEvidence = JSON.parse(fs.readFileSync(auxiliaryEvidencePath));
const auxiliaryExecutable = auxiliaryEvidence.executables.find(value => value.path.includes('anthropic.claude-code-2.1.296-'));
assert(auxiliaryExecutable, 'Pinned native Claude2.1.296 evidence is required');
assert.equal(hash(auxiliaryExecutable.path), auxiliaryExecutable.sha256);
assert.equal(hash(readiness.entry), readiness.entrySha256);
assert.equal(hash(readiness.node), readiness.nodeSha256);
assert.equal(hash(readiness.binary.path), readiness.binary.sha256);
assert.equal(readiness.probes.version.version, 'codex-cli 0.162.0');
const source = fs.realpathSync(process.env.MYSTI_TEST_EXTENSION_PATH);
const packageIdentityPath = path.resolve(process.env.MYSTI_PB02_PACKAGE_IDENTITY || path.join(root, 'package-identity.json'));
const sourceIdentityPath = path.resolve(process.env.MYSTI_PB02_SOURCE_IDENTITY || path.join(root, 'source-identity.json'));
for (const identityPath of [packageIdentityPath, sourceIdentityPath]) {
  assert(fs.realpathSync(identityPath).startsWith(fs.realpathSync(root) + path.sep), 'Release identities must remain inside owned PB-02 artifacts');
}
const packageIdentity = JSON.parse(fs.readFileSync(packageIdentityPath));
assert.equal(fs.realpathSync(packageIdentity.extension), source);
assert.equal(packageIdentity.bundleSha256, hash(path.join(source, 'dist/extension.js')));
assert.equal(packageIdentity.chatSha256, hash(path.join(source, 'media/chat/chat.js')));
assert.equal(packageIdentity.sourceSnapshotUnchanged, true);
assert.equal(hash(packageIdentity.archive), packageIdentity.sha256);
const product = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
assert.equal(product.name, 'mysti'); assert.equal(product.publisher.toLowerCase(), 'deepmyst');
const directory = path.join(artifactDir, 'window-A'); fs.mkdirSync(directory);
const extensionsDir = path.join(directory, 'installed-extensions'); fs.mkdirSync(extensionsDir);
const installedExtension = path.join(extensionsDir, `deepmyst.mysti-${product.version}`);
fs.cpSync(source, installedExtension, { recursive: true, force: false, errorOnExist: true });
const profiles = path.join(repo, '.vscode-test/profiles'); fs.mkdirSync(profiles, { recursive: true });
const profile = fs.realpathSync(fs.mkdtempSync(path.join(profiles, 'pb02-A-')));
fs.writeFileSync(path.join(profile, '.mysti-test-owned.json'), JSON.stringify({ case: 'PB-02', profile, window: 'A' }), { mode: 0o600 });
const sharedDataDir = fs.mkdtempSync(path.join(repo, '.vscode-test/pb02-A-shared-'));
const token = `PB02_SERVICE_${randomBytes(10).toString('hex')}`;
const fixture = createF1({ directory: path.join(directory, 'workspace'), token, attachmentToken: `PB02_ATTACHMENT_${randomBytes(10).toString('hex')}` });
const cliDirectory = path.join(directory, 'cli'); fs.mkdirSync(cliDirectory);
const counterFile = path.join(directory, 'forwarded-input-count.json');
const cli = createPB02Cli({ directory: cliDirectory, executable: readiness.node, prefixArgs: [readiness.entry], node: readiness.node,
  workspace: fixture.workspace, counterFile, token, maxInputs: 10 });
const auxiliaryCounterFile = path.join(directory, 'forwarded-auxiliary-input-count.json');
const auxiliaryCli = createPB02AuxiliaryCli({ directory: cliDirectory, executable: fs.realpathSync(auxiliaryExecutable.path), node: readiness.node,
  counterFile: auxiliaryCounterFile, maxInputs: 12, probeDirectories: [repo, fixture.workspace] });
const model = 'gpt-6.1-sol';
const settings = {
  'files.simpleDialog.enable': true, 'window.dialogStyle': 'custom', 'git.enabled': false,
  'mysti.codexPath': cli.launcher, 'mysti.defaultAgent': 'openai-codex', 'mysti.defaultProvider': 'openai-codex',
  'mysti.claudeCodePath': auxiliaryCli.launcher,
  'mysti.defaultModel': model, 'mysti.codexModel': model, 'mysti.codexProfile': '',
  'mysti.defaultEffortLevel': 'low', 'mysti.defaultThinkingLevel': 'none',
  'mysti.defaultMode': 'ask-before-edit', 'mysti.accessLevel': 'ask-permission',
  'mysti.autoContext': false, 'mysti.showSuggestions': false, 'mysti.agents.autoSuggest': false,
};
fs.mkdirSync(path.join(profile, 'User'));
fs.writeFileSync(path.join(profile, 'User/settings.json'), JSON.stringify(settings, null, 2));
const helper = path.join(artifactDir, 'codex-runner-extension'); fs.mkdirSync(helper);
fs.writeFileSync(path.join(helper, 'package.json'), JSON.stringify({
  name: 'pb02-codex-runner', publisher: 'MystiValidation', version: '1.0.0', engines: { vscode: '^1.100.0' },
  activationEvents: ['onStartupFinished'], main: './extension.cjs', capabilities: { untrustedWorkspaces: { supported: true } },
}, null, 2));
const manifest = {
  case: 'PB-02', stage: 'FIRST_EIGHT', preparedBeforeActivation: true, artifactDir, helper, sourcePackage: source,
  bundleSha256: hash(path.join(source, 'dist/extension.js')), chatSha256: hash(path.join(source, 'media/chat/chat.js')),
  windows: { A: { id: 'A', directory, workspace: fixture.workspace, profile, sharedDataDir, extensionsDir, installedExtension,
    cliDirectory, wrappers: { 'openai-codex': cli.launcher, 'claude-code': auxiliaryCli.launcher }, receiptPaths: [cli.receipts],
    auxiliaryReceiptPaths: [auxiliaryCli.receipts] } },
  fixture, token, model, counterFile, maxForwardedInputs: 10, plannedSuccessfulTurns: 8,
  executableIdentities: { 'openai-codex': identity(readiness.entry), 'codex-native': identity(readiness.binary.path), 'claude-auxiliary-native': identity(auxiliaryExecutable.path) },
  nodeIdentity: identity(readiness.node), readiness: identity(readinessPath),
  sourceIdentity: identity(sourceIdentityPath), packageIdentity: identity(packageIdentityPath),
  wrapperIdentities: [cli.launcher, cli.runtime, auxiliaryCli.launcher, auxiliaryCli.runtime].map(identity),
  harnessDependencyIdentities: ['codex-stage-oracle.cjs', 'codex-fixture-oracle.cjs', 'pb02-fixture.cjs', 'audit-vscode-claude.cjs', 'pb02-auxiliary-cli-fixture.cjs', 'audit-vscode-codex-auxiliary.cjs', 'ordinary-profile-runner.cjs']
    .map(file => identity(path.join(__dirname, file))).concat([identity(auxiliaryEvidencePath), identity(path.join(repo, 'src/utils/textOnlyClaudeWorker.ts'))]),
  auxiliary: { provider: 'claude-code', counterFile: auxiliaryCounterFile, maxInputs: 12, expectedArgs: EXPECTED_ARGS,
    executableIdentity: identity(auxiliaryExecutable.path), flagEvidenceIdentity: identity(auxiliaryEvidencePath),
    routingSetting: 'mysti.claudeCodePath', launcher: auxiliaryCli.launcher, runtime: auxiliaryCli.runtime,
    helperIdentity: identity(path.join(repo, 'src/utils/textOnlyClaudeWorker.ts')),
    scope: 'Transparent accounting of actual product text-only workers, including no-input warm workers. No feature disabling or argument injection. Text output is not semantic success; missing terminal observations remain unknown.' },
  wrapperInjections: 'None. Exact original app-server and auxiliary text bytes, native approval responses and CLI configuration remain product-owned. Separate fail-closed caps reserve at most10 Codex turn/start frames and12 Claude auxiliary inputs before forwarding. Combined upper22 applies only to the instrumented lanes.',
  scope: 'First eight real F1 developer replies: diagnose, regression, proposed correction, approved native patch, actual tests, denied canary, unrelated question, task return with actual native thread resume after public effort change. One real editor tab. Remaining full25 baseline, requirement revision, two tabs, invalid-model recovery, Read Only, Stops, attachments, named profile, F2 and elapsed S/W/E/P are NOT_RUN in this stage.',
};
fs.writeFileSync(path.join(helper, 'extension.cjs'), `
'use strict';
const vscode = require('vscode'), fs = require('fs'), path = require('path'), {createHash} = require('crypto');
const repo = ${JSON.stringify(repo)}, manifestPath = ${JSON.stringify(manifestFile)};
exports.activate = () => setTimeout(run, 500);
exports.deactivate = () => {};
async function run() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath)), owner = manifest.windows.A;
  const started = Date.now(), testFailures = [];
  let failures = 0, error;
  try {
    if (vscode.workspace.workspaceFolders?.length !== 1 || fs.realpathSync(vscode.workspace.workspaceFolders[0].uri.fsPath) !== fs.realpathSync(owner.workspace)) throw new Error('Exact owned F1 workspace required');
    if (!vscode.workspace.isTrusted) await vscode.commands.executeCommand('workbench.trust.manage');
    const trustDeadline = Date.now() + 60000;
    while (!vscode.workspace.isTrusted && Date.now() < trustDeadline) await new Promise(resolve => setTimeout(resolve, 100));
    if (!vscode.workspace.isTrusted) throw new Error('Owned workspace trust incomplete');
    const registryDeadline = Date.now() + 15000;
    let product = vscode.extensions.getExtension('DeepMyst.mysti');
    while (!product && Date.now() < registryDeadline) {
      await new Promise(resolve => setTimeout(resolve, 100)); product = vscode.extensions.getExtension('DeepMyst.mysti');
    }
    const actualPath = product ? fs.realpathSync(product.extensionPath) : null;
    const expectedPath = fs.realpathSync(owner.installedExtension);
    fs.writeFileSync(path.join(owner.directory, 'registry-readiness.json'), JSON.stringify({actualPath, expectedPath, pathMatches: actualPath === expectedPath}));
    if (product?.isUnderDevelopment || actualPath !== expectedPath) throw new Error('Product must be the exact ordinary installed payload');
    const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (hash(path.join(actualPath, 'dist/extension.js')) !== manifest.bundleSha256 || hash(path.join(actualPath, 'media/chat/chat.js')) !== manifest.chatSha256) throw new Error('Installed payload mismatch');
    fs.writeFileSync(path.join(owner.directory, 'helper-ready.json'), JSON.stringify({extensionHostPid: process.pid, profile: owner.profile, extensionTestsPathUsed: false, productUnderDevelopment: product.isUnderDevelopment ?? 'NOT_EXPOSED_BY_PUBLIC_API'}));
    const Mocha = require(path.join(repo, 'node_modules/mocha'));
    const mocha = new Mocha({ui: 'bdd', timeout: 1500000, color: false});
    mocha.grep('PB-02 real editor'); mocha.addFile(path.join(repo, 'out-vscode-test/codex.test.js'));
    failures = await new Promise(resolve => mocha.run(resolve).on('fail', (test, reason) => testFailures.push({title: test.fullTitle(), name: reason?.name, message: reason?.message})));
  } catch (reason) { failures = 1; error = {name: reason?.name, message: reason?.message}; }
  fs.writeFileSync(path.join(owner.directory, 'runner-result.json'), JSON.stringify({failures, error, testFailures, durationMs: Date.now() - started, extensionHostPid: process.pid, normalQuitRequested: true}, null, 2));
  await vscode.commands.executeCommand('workbench.action.quit');
}
`);
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ prepared: manifestFile, profile, plannedSuccessfulTurns: 8, maxForwardedInputs: 10, launchesPerformed: 0 }));
