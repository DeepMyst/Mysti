/* PB-02 bounded semantic correction preparation. Never launches an editor/model. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { copyPreservedFixture, verifyPreservedBase } = require('./codex-semantic-followup-contract.cjs');
const { createPB02Cli } = require('./pb02-cli-fixture.cjs');
const { createPB02AuxiliaryCli } = require('./pb02-auxiliary-cli-fixture.cjs');
const { EXPECTED_ARGS } = require('./pb02-auxiliary-cli-runtime.cjs');
const repo = path.resolve(__dirname, '../..');
const root = path.join(repo, 'out-test/feature-tests/PB-02');
const artifactDir = path.resolve(process.env.MYSTI_PB02_SEMANTIC_FOLLOWUP_ARTIFACT_DIR || path.join(root, 'resume-20261011/native-semantic-correction'));
assert(artifactDir.startsWith(root + path.sep));
function assertNoPreparedAncestor(directory) {
  for (let current = directory; ; current = path.dirname(current)) {
    assert(!fs.existsSync(path.join(current, 'prepared.json')), 'New semantic artifacts must not be inside prepared prior evidence');
    if (current === root) break;
    assert(current.startsWith(root + path.sep));
  }
}
assertNoPreparedAncestor(path.dirname(artifactDir));
assert(!artifactDir.startsWith(path.join(root, 'native-full') + path.sep) && artifactDir !== path.join(root, 'native-full'), 'Never add files inside preserved evidence');
const actualParent = fs.realpathSync(path.dirname(artifactDir));
assert(actualParent === fs.realpathSync(root) || actualParent.startsWith(fs.realpathSync(root) + path.sep));
assert(actualParent !== path.join(root, 'native-full') && !actualParent.startsWith(path.join(root, 'native-full') + path.sep));
assert.equal(path.join(actualParent, path.basename(artifactDir)), artifactDir, 'Artifact parent must not be an alias');
assert(!fs.existsSync(artifactDir), 'A semantic followup requires a new artifact directory');
fs.mkdirSync(artifactDir, { recursive: true });
assert(fs.realpathSync(artifactDir).startsWith(fs.realpathSync(root) + path.sep));
const compiledDirectory = fs.realpathSync(process.env.MYSTI_PB02_SEMANTIC_FOLLOWUP_COMPILED_DIR);
assert(compiledDirectory.startsWith(fs.realpathSync(root) + path.sep), 'Compiled supplement must be in owned PB-02 artifacts');
assert(!compiledDirectory.startsWith(path.join(root, 'native-full') + path.sep) && compiledDirectory !== path.join(root, 'native-full'));
assertNoPreparedAncestor(compiledDirectory);
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
const packageIdentityPath = path.resolve(process.env.MYSTI_PB02_SEMANTIC_FOLLOWUP_PACKAGE_IDENTITY || path.join(root, 'utf8-20261010/validation-retry/package-identity.json'));
const sourceIdentityPath = path.resolve(process.env.MYSTI_PB02_SEMANTIC_FOLLOWUP_SOURCE_IDENTITY || path.join(root, 'utf8-20261010/validation-retry/source-identity.json'));
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
const profile = fs.realpathSync(fs.mkdtempSync(path.join(profiles, 'pb02-s2-A-')));
if (process.platform === 'darwin') assert(Buffer.byteLength(path.join(profile, '1.14-main.sock'), 'utf8') <= 103, 'Owned IPC socket path must fit103bytes');
fs.writeFileSync(path.join(profile, '.mysti-test-owned.json'), JSON.stringify({ case: 'PB-02', profile, window: 'A' }), { mode: 0o600 });
const sharedDataDir = fs.mkdtempSync(path.join(repo, '.vscode-test/pb02-s2-A-shared-'));
const fixture = copyPreservedFixture(path.join(directory, 'workspace'));
const token = fixture.token;
const cliDirectory = path.join(directory, 'cli'); fs.mkdirSync(cliDirectory);
const counterFile = path.join(directory, 'forwarded-input-count.json');
const cli = createPB02Cli({ directory: cliDirectory, executable: readiness.node, prefixArgs: [readiness.entry], node: readiness.node,
  workspace: fixture.workspace, counterFile, token, maxInputs: 3 });
const auxiliaryCounterFile = path.join(directory, 'forwarded-auxiliary-input-count.json');
const auxiliaryCli = createPB02AuxiliaryCli({ directory: cliDirectory, executable: fs.realpathSync(auxiliaryExecutable.path), node: readiness.node,
  counterFile: auxiliaryCounterFile, maxInputs: 4, probeDirectories: [repo, fixture.workspace] });
const model = 'gpt-5.6-sol';
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
const helper = path.join(artifactDir, 'codex-semantic-followup-runner-extension'); fs.mkdirSync(helper);
fs.writeFileSync(path.join(helper, 'package.json'), JSON.stringify({
  name: 'pb02-codex-semantic-followup-runner', publisher: 'MystiValidation', version: '1.0.0', engines: { vscode: '^1.100.0' },
  activationEvents: ['onStartupFinished'], main: './extension.cjs', capabilities: { untrustedWorkspaces: { supported: true } },
}, null, 2));
const manifest = {
  case: 'PB-02', stage: 'SEMANTIC_FOLLOWUP_2', preparedBeforeActivation: true, artifactDir, helper, compiledDirectory, sourcePackage: source,
  bundleSha256: hash(path.join(source, 'dist/extension.js')), chatSha256: hash(path.join(source, 'media/chat/chat.js')),
  windows: { A: { id: 'A', directory, workspace: fixture.workspace, profile, sharedDataDir, extensionsDir, installedExtension,
    cliDirectory, wrappers: { 'openai-codex': cli.launcher, 'claude-code': auxiliaryCli.launcher }, receiptPaths: [cli.receipts],
    auxiliaryReceiptPaths: [auxiliaryCli.receipts] } },
  fixture, token, model, counterFile, maxForwardedInputs: 3, plannedSuccessfulTurns: 2,
  executableIdentities: { 'openai-codex': identity(readiness.entry), 'codex-native': identity(readiness.binary.path), 'claude-auxiliary-native': identity(auxiliaryExecutable.path) },
  nodeIdentity: identity(readiness.node), readiness: identity(readinessPath),
  sourceIdentity: identity(sourceIdentityPath), packageIdentity: identity(packageIdentityPath),
  wrapperIdentities: [cli.launcher, cli.runtime, auxiliaryCli.launcher, auxiliaryCli.runtime].map(identity),
  harnessDependencyIdentities: ['codex-stage-oracle.cjs', 'codex-full-oracle.cjs', 'codex-semantic-followup-contract.cjs', 'audit-vscode-claude.cjs', 'pb02-cli-fixture.cjs', 'pb02-cli-runtime.cjs', 'pb02-auxiliary-cli-fixture.cjs', 'pb02-auxiliary-cli-runtime.cjs', 'codex-semantic-followup-auxiliary.cjs', 'audit-vscode-codex-semantic-followup.cjs', 'ordinary-profile-runner.cjs', 'run-vscode-codex-semantic-followup.cjs', 'prepare-vscode-codex-semantic-followup.cjs']
    .map(file => identity(path.join(__dirname, file))).concat([identity(auxiliaryEvidencePath), identity(path.join(repo, 'src/utils/textOnlyClaudeWorker.ts')),
      ...['codex-semantic-followup.test.ts', 'codex-semantic-followup-observer.ts'].map(file => identity(path.join(repo, 'tests-vscode', file))),
      ...['codex-semantic-followup.test.js', 'codex-semantic-followup-observer.js', 'codex-semantic-followup.test.js.map', 'codex-semantic-followup-observer.js.map'].map(file => identity(path.join(compiledDirectory, file)))]),
  auxiliary: { provider: 'claude-code', counterFile: auxiliaryCounterFile, maxInputs: 4, expectedArgs: EXPECTED_ARGS,
    executableIdentity: identity(auxiliaryExecutable.path), flagEvidenceIdentity: identity(auxiliaryEvidencePath),
    routingSetting: 'mysti.claudeCodePath', launcher: auxiliaryCli.launcher, runtime: auxiliaryCli.runtime,
    helperIdentity: identity(path.join(repo, 'src/utils/textOnlyClaudeWorker.ts')),
    scope: 'Transparent accounting of actual product text-only workers, including no-input warm workers. No feature disabling or argument injection. Text output is not semantic success; missing terminal observations remain unknown.' },
  wrapperInjections: 'None. Exact original app-server and auxiliary text bytes, native approval responses and CLI configuration remain product-owned. Separate fail-closed caps reserve at most3 Codex turn/start frames and4 Claude auxiliary inputs before forwarding. Combined upper7 applies only to the instrumented lanes.',
  scope: 'Two real gpt-5.6-sol replies in a fresh thread over an exact immutable final fixture copy: correct the prior budget/cap explanation, then transfer the distinction to default/explicit-cap scenarios and qualify uncaptured Stop terminal wording. Exactly one approved native cat command; zero patches or fixture writes. Original mechanicalPASS and semanticPARTIAL evidence remains unchanged. Maincap3/helpercap4; no additional full25, profile, F2 or endurance claims.',
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
    mocha.grep('PB-02 real editor'); mocha.addFile(path.join(manifest.compiledDirectory, 'codex-semantic-followup.test.js'));
    failures = await new Promise(resolve => mocha.run(resolve).on('fail', (test, reason) => testFailures.push({title: test.fullTitle(), name: reason?.name, message: reason?.message})));
  } catch (reason) { failures = 1; error = {name: reason?.name, message: reason?.message}; }
  fs.writeFileSync(path.join(owner.directory, 'runner-result.json'), JSON.stringify({failures, error, testFailures, durationMs: Date.now() - started, extensionHostPid: process.pid, normalQuitRequested: true}, null, 2));
  await vscode.commands.executeCommand('workbench.action.quit');
}
`);
manifest.harnessDependencyIdentities.push(identity(path.join(helper, 'extension.cjs')), identity(path.join(helper, 'package.json')));
verifyPreservedBase(fixture);
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ prepared: manifestFile, profile, plannedSuccessfulTurns: 2, maxForwardedInputs: 3, launchesPerformed: 0 }));
