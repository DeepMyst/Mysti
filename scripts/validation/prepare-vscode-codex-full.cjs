/* PB-02 stage-one preparation only: no editor, backend or clipboard launch. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { createF1 } = require('./pb02-fixture.cjs');
const { createPB02FullCli } = require('./pb02-full-cli-fixture.cjs');
const repo = path.resolve(__dirname, '../..');
const root = path.join(repo, 'out-test/feature-tests/PB-02');
const artifactDir = path.resolve(process.env.MYSTI_PB02_FULL_ARTIFACT_DIR || path.join(root, 'native-full'));
assert(artifactDir.startsWith(root + path.sep));
fs.mkdirSync(artifactDir, { recursive: true });
const manifestFile = path.join(artifactDir, 'prepared.json');
assert(!fs.existsSync(manifestFile), 'A prepared attempt is never reused');
const readinessPath = path.join(root, 'readiness.json');
const readiness = JSON.parse(fs.readFileSync(readinessPath));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const identity = file => ({ path: fs.realpathSync(file), sha256: hash(file) });
assert.equal(hash(readiness.entry), readiness.entrySha256);
assert.equal(hash(readiness.node), readiness.nodeSha256);
assert.equal(hash(readiness.binary.path), readiness.binary.sha256);
assert.equal(readiness.probes.version.version, 'codex-cli 0.162.0');
const source = fs.realpathSync(process.env.MYSTI_TEST_EXTENSION_PATH);
const packageIdentityPath = path.resolve(process.env.MYSTI_PB02_FULL_PACKAGE_IDENTITY || path.join(root, 'model-package-identity.json'));
const sourceIdentityPath = path.resolve(process.env.MYSTI_PB02_FULL_SOURCE_IDENTITY || path.join(root, 'model-source-identity.json'));
for (const identityPath of [packageIdentityPath, sourceIdentityPath]) { assert(fs.realpathSync(identityPath).startsWith(fs.realpathSync(root) + path.sep), 'Release identities must remain inside owned PB-02 artifacts'); }
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
const profile = fs.realpathSync(fs.mkdtempSync(path.join(profiles, 'pb02-full-A-')));
fs.writeFileSync(path.join(profile, '.mysti-test-owned.json'), JSON.stringify({ case: 'PB-02', profile, window: 'A' }), { mode: 0o600 });
const sharedDataDir = fs.mkdtempSync(path.join(repo, '.vscode-test/pb02-full-A-shared-'));
const token = `PB02_SERVICE_${randomBytes(10).toString('hex')}`;
const attachmentToken = `PB02_ATTACHMENT_${randomBytes(10).toString('hex')}`;
const otherPanelToken = `PB02_OTHER_${randomBytes(10).toString('hex')}`;
const invalidModel = `mysti-pb02-invalid-${randomBytes(6).toString('hex')}`;
const fixture = createF1({ directory: path.join(directory, 'workspace'), token, attachmentToken });
const cliDirectory = path.join(directory, 'cli'); fs.mkdirSync(cliDirectory);
const counterFile = path.join(directory, 'forwarded-input-count.json');
const cli = createPB02FullCli({ directory: cliDirectory, executable: readiness.node, prefixArgs: [readiness.entry], node: readiness.node,
  workspace: fixture.workspace, counterFile, token, otherPanelToken, attachmentToken, maxInputs: 29 });
const model = 'gpt-6.1-sol';
const settings = {
  'files.simpleDialog.enable': true, 'window.dialogStyle': 'custom', 'git.enabled': false,
  'mysti.codexPath': cli.launcher, 'mysti.defaultAgent': 'openai-codex', 'mysti.defaultProvider': 'openai-codex',
  'mysti.defaultModel': model, 'mysti.codexModel': model, 'mysti.codexProfile': '',
  'mysti.defaultEffortLevel': 'low', 'mysti.defaultThinkingLevel': 'none',
  'mysti.defaultMode': 'ask-before-edit', 'mysti.accessLevel': 'ask-permission',
  'mysti.autoContext': false, 'mysti.showSuggestions': false, 'mysti.agents.autoSuggest': false,
};
fs.mkdirSync(path.join(profile, 'User'));
fs.writeFileSync(path.join(profile, 'User/settings.json'), JSON.stringify(settings, null, 2));
const helper = path.join(artifactDir, 'codex-full-runner-extension'); fs.mkdirSync(helper);
fs.writeFileSync(path.join(helper, 'package.json'), JSON.stringify({
  name: 'pb02-codex-full-runner', publisher: 'MystiValidation', version: '1.0.0', engines: { vscode: '^1.100.0' },
  activationEvents: ['onStartupFinished'], main: './extension.cjs', capabilities: { untrustedWorkspaces: { supported: true } },
}, null, 2));
const manifest = {
  case: 'PB-02', stage: 'FULL_25', preparedBeforeActivation: true, artifactDir, helper, sourcePackage: source,
  bundleSha256: hash(path.join(source, 'dist/extension.js')), chatSha256: hash(path.join(source, 'media/chat/chat.js')),
  windows: { A: { id: 'A', directory, workspace: fixture.workspace, profile, sharedDataDir, extensionsDir, installedExtension,
    cliDirectory, wrappers: { 'openai-codex': cli.launcher }, receiptPaths: [cli.receipts] } },
  fixture, token, attachmentToken, otherPanelToken, invalidModel, model, counterFile, maxForwardedInputs: 29, plannedSuccessfulTurns: 25,
  executableIdentities: { 'openai-codex': identity(readiness.entry), 'codex-native': identity(readiness.binary.path) },
  nodeIdentity: identity(readiness.node), readiness: identity(readinessPath),
  sourceIdentity: identity(sourceIdentityPath), packageIdentity: identity(packageIdentityPath),
  wrapperIdentities: [cli.launcher, cli.runtime].map(identity),
  harnessDependencyIdentities: ['codex-full-oracle.cjs', 'codex-stage-oracle.cjs', 'codex-fixture-oracle.cjs', 'pb02-fixture.cjs', 'audit-vscode-claude.cjs'].map(file => identity(path.join(__dirname, file))),
  wrapperInjections: 'None. Exact original app-server bytes, native approval responses and CLI configuration remain product-owned. A fail-closed 29 turn/start cap is checked before forwarding.',
  scope: '25 real completed F1 developer turns, two actual tabs, requirement revision with independent oracle, actual native approvals, Read Only attempt or explicitly partial model refusal, attachments, two Stops and invalid-model recovery. 27–28 forwarded inputs (25 replies+2Stops+0–1 invalid), hardcap29. Named profile, F2, compaction and elapsed W/E/P remain NOT_RUN.',
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
    const mocha = new Mocha({ui: 'bdd', timeout: 3300000, color: false});
    mocha.grep('PB-02 real editor'); mocha.addFile(path.join(repo, 'out-vscode-test/codex-full.test.js'));
    failures = await new Promise(resolve => mocha.run(resolve).on('fail', (test, reason) => testFailures.push({title: test.fullTitle(), name: reason?.name, message: reason?.message})));
  } catch (reason) { failures = 1; error = {name: reason?.name, message: reason?.message}; }
  fs.writeFileSync(path.join(owner.directory, 'runner-result.json'), JSON.stringify({failures, error, testFailures, durationMs: Date.now() - started, extensionHostPid: process.pid, normalQuitRequested: true}, null, 2));
  await vscode.commands.executeCommand('workbench.action.quit');
}
`);
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ prepared: manifestFile, profile, plannedSuccessfulTurns: 25, maxForwardedInputs: 29, launchesPerformed: 0 }));
