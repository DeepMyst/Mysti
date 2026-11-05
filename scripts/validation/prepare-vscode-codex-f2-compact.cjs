/* Prepare one of two fresh ordinary-editor F2 segments. Never launches inference. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const c = require('./codex-f2-compact-campaign.cjs');
const compact = require('./codex-f2-compact-store.cjs');
const { createPB02HelperQualityMainCli } = require('./pb02-helper-quality-main-fixture.cjs');
const { createPB02AuxiliaryCli } = require('./pb02-auxiliary-cli-fixture.cjs');
const { EXPECTED_ARGS } = require('./pb02-auxiliary-cli-runtime.cjs');
const repo = path.resolve(__dirname, '../..'), root = fs.realpathSync(path.join(repo, 'out-test/feature-tests/PB-02'));
const read = file => file.startsWith(root + path.sep) ? compact.readJson(file) : JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => file.startsWith(root + path.sep) ? compact.writeJson(file, value) : fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const directory = path.resolve(process.env.MYSTI_PB02_F2_COMPACT_CAMPAIGN_DIR || ''), segment = Number(process.env.MYSTI_PB02_F2_COMPACT_SEGMENT);
assert([1, 2].includes(segment)); c.contained(root, directory);
function noPreparedAncestor(target) {
  for (let parent = target; parent !== root; parent = path.dirname(parent)) {
    c.contained(root, parent); assert(!fs.existsSync(path.join(parent, 'prepared.json')) && !fs.existsSync(path.join(parent, 'campaign.json')), 'Never prepare inside earlier native evidence');
  }
}
noPreparedAncestor(path.dirname(directory)); assert.equal(fs.realpathSync(path.dirname(directory)), path.dirname(directory));
if (segment === 1) assert(!fs.existsSync(directory), 'A new campaign requires an exclusive new directory');
else { assert.equal(fs.realpathSync(directory), directory); assert(fs.existsSync(path.join(directory, 'campaign.json')), 'Pinned campaign required for segment two'); }
const compiledDirectory = fs.realpathSync(process.env.MYSTI_PB02_F2_COMPACT_COMPILED_DIR); c.contained(root, compiledDirectory); noPreparedAncestor(compiledDirectory);
const sourceIdentity = c.identity(path.resolve(process.env.MYSTI_PB02_F2_COMPACT_SOURCE_IDENTITY));
const packageIdentity = c.identity(path.resolve(process.env.MYSTI_PB02_F2_COMPACT_PACKAGE_IDENTITY));
for (const pin of [sourceIdentity, packageIdentity]) c.contained(root, pin.path);
const source = read(sourceIdentity.path), pack = read(packageIdentity.path);
for (const [relative, sha] of Object.entries({ ...source.files, ...source.testFiles })) assert.equal(c.identity(path.join(repo, relative)).sha256, sha, 'Frozen source/test bytes required');
assert.equal(c.identity(path.resolve(repo, pack.archive)).sha256, pack.sha256); assert.equal(pack.sourceSnapshotUnchanged, true); assert.equal(pack.testSnapshotUnchanged, true);
const extension = fs.realpathSync(pack.extension); assert.equal(c.identity(path.join(extension, 'dist/extension.js')).sha256, pack.bundleSha256);
assert.equal(c.identity(path.join(extension, 'media/chat/chat.js')).sha256, pack.chatSha256);
const readinessPath = path.join(root, 'readiness.json'), readiness = read(readinessPath);
for (const [file, sha] of [[readiness.entry, readiness.entrySha256], [readiness.node, readiness.nodeSha256], [readiness.binary.path, readiness.binary.sha256]]) assert.equal(c.identity(file).sha256, sha);
assert.equal(readiness.probes.version.version, 'codex-cli 0.162.0');
const auxiliaryEvidence = path.join(root, 'auxiliary-isolation/claude-flag-evidence.json');
const auxiliaryExecutable = read(auxiliaryEvidence).executables.find(value => value.path.includes('anthropic.claude-code-2.1.296-')); assert(auxiliaryExecutable);
assert.equal(c.identity(auxiliaryExecutable.path).sha256, auxiliaryExecutable.sha256);
const seedRoot = path.join(root, 'overnight-20261011/f2-workload-preparation'), seed = path.join(seedRoot, 'seeded-workspace');
const browserOracle = c.identity(path.resolve(process.env.MYSTI_PB02_F2_COMPACT_BROWSER_ORACLE)); c.contained(root, browserOracle.path);
assert(/^[a-f0-9]{64}$/.test(process.env.MYSTI_PB02_F2_COMPACT_BROWSER_ORACLE_SHA || '')); assert.equal(browserOracle.sha256, process.env.MYSTI_PB02_F2_COMPACT_BROWSER_ORACLE_SHA);
const python = fs.realpathSync(process.env.MYSTI_PB02_F2_COMPACT_PYTHON); const pythonIdentity = c.identity(python);
const seedReport = path.join(seedRoot, 'preparation-report.json'); assert.equal(c.identity(seedReport).sha256, 'e22f40030a21fce21266d22ef626e38a9c5370079f9ddd2dd74cde31f3a6aace');
const seedManifestFile = path.join(seedRoot, 'evidence/frozen-workspace-manifest.json');
const oracleManifestFile = path.join(seedRoot, 'evidence/frozen-validation-manifest.json');
assert.equal(c.identity(seedManifestFile).sha256, '56f6acaa21e053dc5ed545fd2a4dba0bf919aecb62fe637b6191ad1009f2dd84');
assert.equal(c.identity(oracleManifestFile).sha256, '2f8ffd418f0cd54089b6a839533734d25b7077774f81c164da44e1292936d5f0');
const seedFiles = read(seedManifestFile).workspaces['seeded-workspace']; assert.equal(seedFiles.path, seed);
for (const [relative, sha] of Object.entries(seedFiles.files)) assert.equal(c.identity(c.exactFile(seed, relative)).sha256, sha, 'Exact frozen seed required');
for (const [relative, sha] of Object.entries(read(oracleManifestFile).files)) assert.equal(c.identity(path.join(seedRoot, relative)).sha256, sha, 'External oracle/evidence pin changed');
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' };
const git = (cwd, args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: gitEnv, encoding: 'utf8', timeout: 30000 });
const campaignFile = path.join(directory, 'campaign.json'); let campaign;
if (segment === 1) {
  assert(!fs.existsSync(directory), 'A new campaign requires an exclusive new directory'); fs.mkdirSync(directory);
  const workspace = path.join(directory, 'workspace'); fs.mkdirSync(workspace);
  const names = git(seed, ['ls-files', '-z']).split('\0').filter(Boolean);
  assert.deepEqual(names.slice().sort(), Object.keys(seedFiles.files).sort()); assert.equal(git(seed, ['rev-parse', 'HEAD']).trim(), '21775e5444fdcc996994ac174f10884d516956b2');
  for (const relative of names) {
    const original = c.exactFile(seed, relative), target = path.join(workspace, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(original, target, fs.constants.COPYFILE_EXCL);
  }
  fs.cpSync(path.join(seed, '.git'), path.join(workspace, '.git'), { recursive: true, force: false, errorOnExist: true });
  // Dependencies are private copies, never writable links into the frozen seed.
  const cloneReports = path.join(directory, 'dependency-clones'); fs.mkdirSync(cloneReports);
  const dependencyCopies = ['node_modules', 'client/node_modules', 'server/node_modules'].map(relative =>
    c.copyPrivateDependencies(fs.realpathSync(path.join(seed, relative)), path.join(workspace, relative), { python, report: path.join(cloneReports, relative.replaceAll('/', '-') + '.json') }));
  const commandPolicy = c.buildCommandPolicy(workspace); assert(!fs.existsSync(commandPolicy.cacheRoot));
  for (const cache of [...Object.values(commandPolicy.cacheDirectories), commandPolicy.npmLogs]) fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(path.join(workspace, '.pb02'));
  const publicIssues = path.join(seedRoot, 'contracts/public-issues.json'); assert.equal(c.identity(publicIssues).sha256, c.PUBLIC_ISSUES_SHA);
  fs.copyFileSync(publicIssues, path.join(workspace, '.pb02/public-issues.json'), fs.constants.COPYFILE_EXCL);
  const note = 'KEEP_THIS_DEVELOPER_NOTE\nOwned staged note: preserve this file and the original index during all model work.\n';
  fs.writeFileSync(path.join(workspace, c.NOTE), note, { flag: 'wx' }); git(workspace, ['add', '--', c.NOTE]);
  const repairs = c.buildRepairs(path.join(seedRoot, 'contracts/case-contracts.json'), path.join(root, 'overnight-20261011/f2-adapted-baseline/workspace'), seed);
  const fixture = { workspace, files: {}, repairs, commandPolicy, indexSha256: c.identity(path.join(workspace, '.git/index')).sha256,
    generatedDirectories: ['client/build', 'client/node_modules', 'node_modules', 'server/.tmp', 'server/node_modules'], dependencyCopies,
    deniedNote: { path: c.NOTE, before: note, after: note.replace('KEEP_THIS_DEVELOPER_NOTE', 'REQUESTED_SCOPE_CHANGE'), beforeSha256: c.hash(note), afterSha256: c.hash(note.replace('KEEP_THIS_DEVELOPER_NOTE', 'REQUESTED_SCOPE_CHANGE')) },
    seedReport: c.identity(seedReport), contract: c.identity(path.join(seedRoot, 'contracts/case-contracts.json')), publicIssues: c.identity(publicIssues),
    copyScope: 'Exact tracked seed bytes and copied Git; private dependency copies. Only a new synthetic staged note and public issue inventory are added before the initial snapshot. No repairs are applied.' };
  function snapshot(current, prefix = '') {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = prefix + entry.name; if (fixture.generatedDirectories.includes(relative)) continue;
      assert(!entry.isSymbolicLink()); const file = path.join(current, entry.name);
      if (entry.isDirectory()) snapshot(file, relative + '/'); else { assert(entry.isFile()); fixture.files[relative] = { sha256: c.identity(file).sha256 }; }
    }
  }
  snapshot(workspace); const boundaryStarted = Date.now(), initialBoundary = c.verifyBoundary(fixture); c.assertBoundary(initialBoundary);
  write(path.join(directory, 'initial-boundary.json'), initialBoundary); fixture.initialBoundaryIdentity = c.identity(path.join(directory, 'initial-boundary.json')); fixture.initialBoundaryMs = Date.now() - boundaryStarted;
  const profiles = path.join(repo, '.vscode-test/profiles'); fs.mkdirSync(profiles, { recursive: true });
  const profile = fs.realpathSync(fs.mkdtempSync(path.join(profiles, 'pb02-f2c-')));
  if (process.platform === 'darwin') assert(Buffer.byteLength(path.join(profile, '1.14-main.sock')) <= 103);
  write(path.join(profile, '.mysti-test-owned.json'), { case: 'PB-02', profile, window: 'A' }); fs.mkdirSync(path.join(profile, 'User'));
  const sharedDataDir = fs.mkdtempSync(path.join(repo, '.vscode-test/pb02-f2-shared-'));
  const evidenceDirectory = path.join(directory, 'evidence'); fs.mkdirSync(evidenceDirectory); fs.mkdirSync(path.join(directory, 'gates'));
  const kinds = [...new Set(c.buildSteps(workspace).map(step => step.evidence).filter(Boolean))];
  const evidenceFiles = Object.fromEntries(kinds.map(kind => { fs.mkdirSync(path.join(evidenceDirectory, kind)); return [kind, [path.join(evidenceDirectory, kind, 'review.json')]]; }));
  campaign = { schemaVersion: 1, stage: c.STAGE, createdAt: Date.now(), directory, workspace, profile, sharedDataDir, fixture,
    model: 'gpt-5.6-sol', maxForwardedInputs: c.MAIN_CAP, maxAuxiliaryInputs: c.HELPER_CAP,
    counterFile: path.join(directory, 'main-input-count.json'), auxiliaryCounterFile: path.join(directory, 'auxiliary-input-count.json'),
    evidenceDirectory, evidenceFiles, sourceIdentity, packageIdentity, pythonIdentity, commandPolicy, readiness: c.identity(readinessPath), seedReport: c.identity(seedReport),
    seedManifest: c.identity(seedManifestFile), oracleManifest: c.identity(oracleManifestFile), browserOracle,
    scope: 'Two separately reserved editor launches,25 useful turns. Deliberate error/denial probes are not ordinary model mistakes. No elapsed padding or automated retries.' };
  write(campaignFile, campaign);
} else {
  campaign = read(campaignFile); assert.equal(fs.realpathSync(directory), directory); assert.equal(campaign.directory, directory);
  assert.deepEqual(campaign.sourceIdentity, sourceIdentity); assert.deepEqual(campaign.packageIdentity, packageIdentity);
  assert.deepEqual(campaign.browserOracle, browserOracle); assert.deepEqual(campaign.pythonIdentity, pythonIdentity);
  const previous = path.join(directory, 'segment-1'), previousManifest = read(path.join(previous, 'prepared.json'));
  assert.equal(c.identity(campaignFile).sha256, previousManifest.campaign.identity.sha256, 'Segment two cannot change the pinned campaign/profile/workspace');
  const acceptance = read(path.join(previousManifest.windows.A.directory, 'acceptance.json')), exit = read(path.join(previousManifest.windows.A.directory, 'editor-exit.json'));
  assert.equal(read(path.join(previous, 'native-result.json')).status, 'PASS'); assert.equal(exit.code, 0); assert.equal(exit.cleanup.status, 'PASS_OBSERVED_IDENTITIES_EXITED');
  assert.equal(acceptance.replies.length, 13); assert.deepEqual(acceptance.completedCases, ['F2-B01', 'F2-B03']);
  const boundary = c.verifyBoundary(campaign.fixture, acceptance.completedCases, acceptance.panelIds); c.assertBoundary(boundary); assert.deepEqual(boundary, acceptance.finalBoundary);
}
const artifactDir = path.join(directory, `segment-${segment}`); assert(!fs.existsSync(artifactDir)); fs.mkdirSync(artifactDir);
const ownerDir = path.join(artifactDir, 'window-A'); fs.mkdirSync(ownerDir);
const extensionsDir = path.join(ownerDir, 'installed-extensions'); fs.mkdirSync(extensionsDir);
const product = read(path.join(extension, 'package.json')), installedExtension = path.join(extensionsDir, `deepmyst.mysti-${product.version}`);
fs.cpSync(extension, installedExtension, { recursive: true, force: false, errorOnExist: true });
const cliDirectory = path.join(ownerDir, 'cli'); fs.mkdirSync(cliDirectory);
const main = createPB02HelperQualityMainCli({ directory: cliDirectory, node: readiness.node, executable: readiness.node, prefixArgs: [readiness.entry],
  workspace: campaign.workspace, counterFile: campaign.counterFile, token: 'F2', maxInputs: c.MAIN_CAP });
const auxiliary = createPB02AuxiliaryCli({ directory: cliDirectory, node: readiness.node, executable: auxiliaryExecutable.path, counterFile: campaign.auxiliaryCounterFile,
  maxInputs: c.HELPER_CAP, probeDirectories: [repo, campaign.workspace] });
const settings = { 'files.simpleDialog.enable': true, 'window.dialogStyle': 'custom', 'git.enabled': false,
  'mysti.codexPath': main.launcher, 'mysti.claudeCodePath': auxiliary.launcher,
  'mysti.defaultAgent': 'openai-codex', 'mysti.defaultProvider': 'openai-codex', 'mysti.defaultModel': campaign.model, 'mysti.codexModel': campaign.model,
  'mysti.codexProfile': '', 'mysti.defaultEffortLevel': 'low', 'mysti.defaultThinkingLevel': 'none', 'mysti.defaultMode': 'ask-before-edit', 'mysti.accessLevel': 'ask-permission',
  'mysti.autoContext': false, 'mysti.showSuggestions': true, 'mysti.planDetection.enabled': true, 'mysti.agents.autoSuggest': false };
// Only this campaign's marked ordinary profile is reused between its two segments.
assert.deepEqual(read(path.join(campaign.profile, '.mysti-test-owned.json')), { case: 'PB-02', profile: campaign.profile, window: 'A' });
fs.writeFileSync(path.join(campaign.profile, 'User/settings.json'), JSON.stringify(settings, null, 2));
const helper = path.join(artifactDir, 'f2-compact-runner-extension'); fs.mkdirSync(helper);
write(path.join(helper, 'package.json'), { name: 'pb02-f2-compact-runner', publisher: 'MystiValidation', version: '1.0.0', engines: { vscode: '^1.100.0' }, activationEvents: ['onStartupFinished'], main: './extension.cjs', capabilities: { untrustedWorkspaces: { supported: true } } });
const priorOwner = segment === 2 ? path.join(directory, 'segment-1/window-A') : null;
const manifest = { case: 'PB-02', stage: c.STAGE, preparedBeforeActivation: true, artifactDir, helper, compiledDirectory, sourcePackage: extension,
  bundleSha256: pack.bundleSha256, chatSha256: pack.chatSha256, sourceIdentity, packageIdentity, pythonIdentity, nodeIdentity: c.identity(readiness.node), readiness: c.identity(readinessPath),
  executableIdentities: { 'openai-codex': c.identity(readiness.entry), 'codex-native': c.identity(readiness.binary.path), 'claude-auxiliary-native': c.identity(auxiliaryExecutable.path) },
  campaign: { ...campaign, identity: c.identity(campaignFile) }, fixture: campaign.fixture, model: campaign.model, token: 'F2', maxForwardedInputs: c.MAIN_CAP, counterFile: campaign.counterFile,
  segment: { index: segment, ...(priorOwner ? { priorAcceptance: c.identity(path.join(priorOwner, 'acceptance.json')), priorEditorExit: c.identity(path.join(priorOwner, 'editor-exit.json')) } : {}) },
  windows: { A: { id: 'A', directory: ownerDir, workspace: campaign.workspace, profile: campaign.profile, sharedDataDir: campaign.sharedDataDir, extensionsDir, installedExtension,
    cliDirectory, wrappers: { 'openai-codex': main.launcher, 'claude-code': auxiliary.launcher }, receiptPaths: [main.receipts], auxiliaryReceiptPaths: [auxiliary.receipts] } },
  auxiliary: { provider: 'claude-code', counterFile: campaign.auxiliaryCounterFile, maxInputs: c.HELPER_CAP, expectedArgs: EXPECTED_ARGS,
    executableIdentity: c.identity(auxiliaryExecutable.path), flagEvidenceIdentity: c.identity(auxiliaryEvidence), launcher: auxiliary.launcher, runtime: auxiliary.runtime,
    helperIdentity: c.identity(path.join(repo, 'src/utils/textOnlyClaudeWorker.ts')), scope: 'Transparent bounded helper accounting; unknown terminal is not success.' },
  wrapperIdentities: [main.launcher, main.runtime, auxiliary.launcher, auxiliary.runtime].map(c.identity),
  harnessDependencyIdentities: ['codex-f2-seeded-lint.cjs', 'check-codex-f2-seeded-lint.cjs', 'codex-f2-compact-store.cjs', 'check-codex-f2-compact-store.cjs', 'codex-f2-scoped-campaign.cjs', 'prepare-vscode-codex-f2-scoped.cjs', 'run-vscode-codex-f2-scoped.cjs', 'audit-vscode-codex-f2-scoped.cjs', 'codex-f2-compact-campaign.cjs', 'check-codex-f2-compact-campaign.cjs', 'check-codex-f2-compact-preparation.cjs', 'prepare-vscode-codex-f2-compact.cjs', 'run-vscode-codex-f2-compact.cjs',
    'audit-vscode-codex-f2-compact.cjs', 'check-codex-f2-compact-audit.cjs', 'codex-f2-campaign.cjs', 'prepare-vscode-codex-f2.cjs', 'run-vscode-codex-f2.cjs', 'audit-vscode-codex-f2.cjs', 'codex-f2-test-proof.cjs', 'pb02-private-clone.py', 'check-pb02-private-clone.py', 'codex-f2-auxiliary.cjs', 'codex-continuation-contract.cjs', 'codex-stage-oracle.cjs', 'codex-full-oracle.cjs',
    'codex-full-readonly-probe.cjs', 'codex-full-readonly-oracle.cjs', 'codex-helper-quality-contract.cjs', 'codex-semantic-followup-contract.cjs',
    'audit-vscode-codex-helper-quality.cjs', 'codex-helper-quality-auxiliary.cjs', 'audit-vscode-claude.cjs', 'pb02-helper-quality-main-runtime.cjs',
    'pb02-helper-quality-main-fixture.cjs', 'pb02-auxiliary-cli-runtime.cjs', 'pb02-auxiliary-cli-fixture.cjs', 'ordinary-profile-runner.cjs']
    .map(file => c.identity(path.join(__dirname, file))).concat([browserOracle, pythonIdentity, c.identity(auxiliaryEvidence), c.identity(path.join(repo, 'src/utils/textOnlyClaudeWorker.ts'))],
      ['codex-f2-compact.test', 'codex-f2-compact-observer', 'codex-f2-scoped-observer', 'codex-f2-observer', 'codex-full-followup-observer', 'codex-profile-compatibility-explicit-effort'].flatMap(stem => [
        c.identity(path.join(repo, 'tests-vscode', stem + '.ts')), c.identity(path.join(compiledDirectory, stem + '.js')), c.identity(path.join(compiledDirectory, stem + '.js.map'))])),
};
const manifestFile = path.join(artifactDir, 'prepared.json');
fs.writeFileSync(path.join(helper, 'extension.cjs'), `'use strict';
const vscode=require('vscode'),fs=require('fs'),path=require('path');const repo=${JSON.stringify(repo)},file=${JSON.stringify(manifestFile)};
exports.activate=()=>setTimeout(run,500);exports.deactivate=()=>{};
async function run(){const m=JSON.parse(fs.readFileSync(file)),o=m.windows.A,started=Date.now(),testFailures=[];let failures=0,error;
try{if(vscode.workspace.workspaceFolders?.length!==1||fs.realpathSync(vscode.workspace.workspaceFolders[0].uri.fsPath)!==o.workspace)throw Error('Exact owned workspace required');
if(!vscode.workspace.isTrusted)await vscode.commands.executeCommand('workbench.trust.manage');const end=Date.now()+60000;while(!vscode.workspace.isTrusted&&Date.now()<end)await new Promise(r=>setTimeout(r,100));if(!vscode.workspace.isTrusted)throw Error('Trust incomplete');
const deadline=Date.now()+15000;let ext;while(!(ext=vscode.extensions.getExtension('DeepMyst.mysti'))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));if(!ext||ext.isUnderDevelopment||fs.realpathSync(ext.extensionPath)!==o.installedExtension)throw Error('Ordinary package identity mismatch');
fs.writeFileSync(path.join(o.directory,'helper-ready.json'),JSON.stringify({extensionHostPid:process.pid,profile:o.profile,extensionTestsPathUsed:false,productUnderDevelopment:ext.isUnderDevelopment??'NOT_EXPOSED'}));
const Mocha=require(path.join(repo,'node_modules/mocha')),mocha=new Mocha({ui:'bdd',timeout:3900000,color:false});mocha.addFile(path.join(m.compiledDirectory,'codex-f2-compact.test.js'));failures=await new Promise(r=>mocha.run(r).on('fail',(t,e)=>testFailures.push({title:t.fullTitle(),name:e?.name,message:e?.message})));
}catch(e){failures=1;error={name:e?.name,message:e?.message};}fs.writeFileSync(path.join(o.directory,'runner-result.json'),JSON.stringify({failures,error,testFailures,durationMs:Date.now()-started,extensionHostPid:process.pid,normalQuitRequested:true},null,2));await vscode.commands.executeCommand('workbench.action.quit');}
`, { flag: 'wx', mode: 0o600 });
manifest.harnessDependencyIdentities.push(c.identity(path.join(helper, 'extension.cjs')), c.identity(path.join(helper, 'package.json')));
write(manifestFile, manifest); console.log(JSON.stringify({ prepared: manifestFile, campaign: campaignFile, segment, profile: campaign.profile, launchesPerformed: 0 }));
