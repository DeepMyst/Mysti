/* PC-10 preparation only. No editor launch or inference. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createForksCli } = require('./forks-cli-fixture.cjs');
const repo = path.resolve(__dirname, '../..');
const artifactDir = path.resolve(process.env.MYSTI_PC10_ARTIFACT_DIR || path.join(repo, 'out-test/feature-tests/PC-10/native'));
assert(artifactDir.startsWith(path.join(repo, 'out-test/feature-tests/PC-10') + path.sep));
fs.mkdirSync(artifactDir, { recursive: true });
const manifestFile = path.join(artifactDir, 'prepared.json');
assert(!fs.existsSync(manifestFile), 'Never overwrite an earlier attempt or reuse its owned profile');
const source = fs.realpathSync(process.env.MYSTI_TEST_EXTENSION_PATH);
const product = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
assert.equal(product.publisher.toLowerCase(), 'deepmyst'); assert.equal(product.name, 'mysti');
const executables = { 'claude-code': process.env.MYSTI_PC10_CLAUDE_PATH, 'openai-codex': process.env.MYSTI_PC10_CODEX_PATH };
const node = process.env.MYSTI_PC10_NODE_PATH || process.execPath;
for (const executable of [...Object.values(executables), node]) assert(executable && path.isAbsolute(executable) && fs.existsSync(executable));
const hash = value => createHash('sha256').update(value).digest('hex');
const directory = path.join(artifactDir, 'window-A'); fs.mkdirSync(directory);
const extensionsDir = path.join(directory, 'installed-extensions'); fs.mkdirSync(extensionsDir);
const installedExtension = path.join(extensionsDir, `deepmyst.mysti-${product.version}`);
fs.cpSync(source, installedExtension, { recursive: true, errorOnExist: true, force: false });
const profiles = path.join(repo, '.vscode-test/profiles'); fs.mkdirSync(profiles, { recursive: true });
const profile = fs.realpathSync(fs.mkdtempSync(path.join(profiles, 'pc10-A-')));
fs.writeFileSync(path.join(profile, '.mysti-test-owned.json'), JSON.stringify({ case: 'PC-10', profile, window: 'A' }), { mode: 0o600 });
const sharedDataDir = fs.mkdtempSync(path.join(repo, '.vscode-test/pc10-A-shared-'));
const workspace = path.join(directory, 'workspace'); fs.mkdirSync(workspace);
const token = `PC10_ISSUE_${randomBytes(10).toString('hex')}`;
const files = {
  'README.md': 'Owned, bounded PC-10 issue tracker fixture. Five files, not the planned full F2 application.\n',
  'package.json': JSON.stringify({ name: 'pc10-owned-issue-tracker', version: '1.0.0', private: true, scripts: { test: 'node --test' } }, null, 2) + '\n',
  'src/issues.cjs': `// Fixture token: ${token}\n'use strict';\nfunction listOpen(issues) { return issues.filter(issue => issue.status === 'open'); }\nmodule.exports = { listOpen };\n`,
  'src/unused.cjs': "module.exports = 'checkpoint deletion canary';\n",
  'test/issues.test.cjs': "const {test}=require('node:test');const assert=require('node:assert/strict');const {listOpen}=require('../src/issues.cjs');\ntest('open issues only',()=>assert.deepEqual(listOpen([{id:1,status:'open'},{id:2,status:'closed'}]),[{id:1,status:'open'}]));\n",
};
for (const [relative, content] of Object.entries(files)) {
  const file = path.join(workspace, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
}
const git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: workspace, encoding: 'utf8' });
git(['init', '--quiet']); git(['config', 'user.name', 'Mysti validation']); git(['config', 'user.email', 'validation@example.invalid']);
git(['add', '.']); git(['commit', '--quiet', '-m', 'Owned PC10 fixture baseline']);
// Real pre-existing developer edits: one staged README change and one
// unstaged source comment. Checkpoint/Undo must leave the real index alone.
files['README.md'] += 'Staged developer note: retain original open-only requirement.\n';
fs.writeFileSync(path.join(workspace, 'README.md'), files['README.md']); git(['add', 'README.md']);
files['src/issues.cjs'] += '// Unstaged developer note: preserve this comment across rewind.\n';
fs.writeFileSync(path.join(workspace, 'src/issues.cjs'), files['src/issues.cjs']);
const originalIndex = git(['ls-files', '--stage']);
const originalStatus = git(['status', '--porcelain=v1', '--untracked-files=all']);
const cliDirectory = path.join(directory, 'cli'); fs.mkdirSync(cliDirectory);
const hooks = path.join(cliDirectory, 'claude-settings.json'); fs.writeFileSync(hooks, JSON.stringify({ disableAllHooks: true }), { mode: 0o600 });
const wrappers = {}, receiptPaths = [];
for (const [provider, executable] of Object.entries(executables)) {
  const fixture = createForksCli({ directory: cliDirectory, provider, executable, node, hooks, window: 'A', tokens: { issue: token } });
  wrappers[provider] = fixture.launcher; receiptPaths.push(fixture.receipts);
}
const settings = { 'files.simpleDialog.enable': true, 'window.dialogStyle': 'custom', 'git.enabled': false,
  'mysti.claudeCodePath': wrappers['claude-code'], 'mysti.codexPath': wrappers['openai-codex'],
  'mysti.defaultAgent': 'claude-code', 'mysti.defaultProvider': 'claude-code', 'mysti.defaultModel': 'sonnet',
  'mysti.claudeCodeModel': 'sonnet', 'mysti.codexModel': 'gpt-5.6-sol', 'mysti.codexProfile': '',
  'mysti.defaultEffortLevel': 'low', 'mysti.defaultThinkingLevel': 'none', 'mysti.defaultMode': 'ask-before-edit',
  'mysti.accessLevel': 'ask-permission', 'mysti.autoContext': false, 'mysti.showSuggestions': false, 'mysti.agents.autoSuggest': false,
};
fs.mkdirSync(path.join(profile, 'User')); fs.writeFileSync(path.join(profile, 'User/settings.json'), JSON.stringify(settings, null, 2));
const helper = path.join(artifactDir, 'forks-runner-extension'); fs.mkdirSync(helper);
fs.writeFileSync(path.join(helper, 'package.json'), JSON.stringify({ name: 'pc10-forks-runner', publisher: 'MystiValidation', version: '1.0.0',
  engines: { vscode: '^1.100.0' }, activationEvents: ['onStartupFinished'], main: './extension.cjs', capabilities: { untrustedWorkspaces: { supported: true } } }, null, 2));
const manifest = { case: 'PC-10', preparedBeforeActivation: true, artifactDir, helper, sourcePackage: source,
  bundleSha256: hash(fs.readFileSync(path.join(source, 'dist/extension.js'))), chatSha256: hash(fs.readFileSync(path.join(source, 'media/chat/chat.js'))),
  windows: { A: { id: 'A', directory, workspace, profile, sharedDataDir, extensionsDir, installedExtension, cliDirectory, wrappers, receiptPaths } },
  token, files, originalIndex, originalStatus, fixtureFileCount: Object.keys(files).length,
  conversationalRequestsPlanned: 5, accountMutation: false, extensionTestsPathUsed: false,
  scope: 'Bounded five-file issue tracker, not full F2. Three native Q+A turns then fork from public user-message5 affordance; message6 is assistant-only and has no fork button. One Codex alternate follow-up, one Claude original follow-up. Real user edits, code rewind and Undo; no native restart or elapsed soak claim.',
};
fs.writeFileSync(path.join(helper, 'extension.cjs'), `
'use strict';
const vscode=require('vscode'),fs=require('fs'),path=require('path'),{createHash}=require('crypto');
const manifestPath=${JSON.stringify(manifestFile)},repo=${JSON.stringify(repo)};
exports.activate=()=>{setTimeout(run,500);};
async function run(){
 const m=JSON.parse(fs.readFileSync(manifestPath)),w=m.windows.A,directory=w.directory;
 let failures=0,error;const testFailures=[],started=Date.now();
 try{
  if(vscode.workspace.workspaceFolders?.length!==1||fs.realpathSync(vscode.workspace.workspaceFolders[0].uri.fsPath)!==fs.realpathSync(w.workspace))throw new Error('Runner must trust only its exact sole owned workspace');
  if(!vscode.workspace.isTrusted)await vscode.commands.executeCommand('workbench.trust.manage');
  const trustDeadline=Date.now()+60000;while(!vscode.workspace.isTrusted&&Date.now()<trustDeadline)await new Promise(r=>setTimeout(r,100));
  if(!vscode.workspace.isTrusted)throw new Error('Owned PC10 workspace trust precondition was not completed');
  const registryStarted=Date.now(),registryDeadline=registryStarted+15000;let product=vscode.extensions.getExtension('DeepMyst.mysti');
  while(!product&&Date.now()<registryDeadline){await new Promise(r=>setTimeout(r,100));product=vscode.extensions.getExtension('DeepMyst.mysti');}
  const actualPath=product?fs.realpathSync(product.extensionPath):null,expectedPath=fs.realpathSync(w.installedExtension);
  fs.writeFileSync(path.join(directory,'registry-readiness.json'),JSON.stringify({waitMs:Date.now()-registryStarted,actualPath,expectedPath,pathMatches:actualPath===expectedPath}));
  if(actualPath!==expectedPath)throw new Error('Mysti registry did not resolve the prepared installed payload');
  const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if(hash(path.join(actualPath,'dist/extension.js'))!==m.bundleSha256||hash(path.join(actualPath,'media/chat/chat.js'))!==m.chatSha256)throw new Error('Installed Mysti payload differs from prepared release');
  fs.writeFileSync(path.join(directory,'helper-ready.json'),JSON.stringify({extensionHostPid:process.pid,profile:w.profile,extensionTestsPathUsed:false}));
  const Mocha=require(path.join(repo,'node_modules/mocha'));const mocha=new Mocha({ui:'bdd',timeout:780000,color:false});
  mocha.grep('PC-10 real editor');mocha.addFile(path.join(repo,'out-vscode-test/forks.test.js'));
  failures=await new Promise(resolve=>mocha.run(resolve).on('fail',(test,reason)=>testFailures.push({title:test.fullTitle(),name:reason?.name,message:reason?.message})));
 }catch(reason){failures=1;error={name:reason?.name,message:reason?.message};}
 fs.writeFileSync(path.join(directory,'runner-result.json'),JSON.stringify({failures,error,testFailures,durationMs:Date.now()-started,extensionHostPid:process.pid,normalQuitRequested:true},null,2));
 await vscode.commands.executeCommand('workbench.action.quit');
}
exports.deactivate=()=>{};
`);
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ prepared: manifestFile, profile, conversationalRequestsPlanned: 5, launchesPerformed: 0, fixtureFileCount: manifest.fixtureFileCount }));
