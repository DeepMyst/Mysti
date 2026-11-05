/* PC-11 preparation only. No editor launch or inference. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createTransferCli } = require('./transfer-cli-fixture.cjs');
const repo = path.resolve(__dirname, '../..');
const acknowledgementOnly = process.env.MYSTI_PC11_ACK_ONLY === '1';
const artifactDir = path.resolve(process.env.MYSTI_PC11_ARTIFACT_DIR || path.join(repo, 'out-test/feature-tests/PC-11/native'));
assert(artifactDir.startsWith(path.join(repo, 'out-test/feature-tests/PC-11') + path.sep));
fs.mkdirSync(artifactDir, { recursive: true });
const manifestFile = path.join(artifactDir, 'prepared.json');
assert(!fs.existsSync(manifestFile), 'Never overwrite an earlier attempt or reuse its owned profile');
const source = fs.realpathSync(process.env.MYSTI_TEST_EXTENSION_PATH);
const product = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
assert.equal(product.publisher.toLowerCase(), 'deepmyst'); assert.equal(product.name, 'mysti');
const executables = { 'claude-code': process.env.MYSTI_PC11_CLAUDE_PATH, 'openai-codex': process.env.MYSTI_PC11_CODEX_PATH };
const node = process.env.MYSTI_PC11_NODE_PATH || process.execPath;
for (const executable of [...Object.values(executables), node]) assert(executable && path.isAbsolute(executable) && fs.existsSync(executable));
const hash = value => createHash('sha256').update(value).digest('hex');
const directory = path.join(artifactDir, 'window-A'); fs.mkdirSync(directory);
const extensionsDir = path.join(directory, 'installed-extensions'); fs.mkdirSync(extensionsDir);
const installedExtension = path.join(extensionsDir, `deepmyst.mysti-${product.version}`);
fs.cpSync(source, installedExtension, { recursive: true, errorOnExist: true, force: false });
const profiles = path.join(repo, '.vscode-test/profiles'); fs.mkdirSync(profiles, { recursive: true });
const profile = fs.realpathSync(fs.mkdtempSync(path.join(profiles, 'pc11-A-')));
fs.writeFileSync(path.join(profile, '.mysti-test-owned.json'), JSON.stringify({ case: 'PC-11', profile, window: 'A' }), { mode: 0o600 });
const sharedDataDir = fs.mkdtempSync(path.join(repo, '.vscode-test/pc11-A-shared-'));
const workspace = path.join(directory, 'workspace'); fs.mkdirSync(workspace);
const token = `PC11_ISSUE_${randomBytes(10).toString('hex')}`;
const files = {
  'README.md': 'Owned, bounded PC-11 issue tracker fixture. Five files, not the planned full F2 application.\n',
  'package.json': JSON.stringify({ name: 'pc11-owned-issue-tracker', version: '1.0.0', private: true, scripts: { test: 'node --test' } }, null, 2) + '\n',
  'src/issues.cjs': `// Fixture token: ${token}\n'use strict';\nfunction listOpen(issues) { return issues.filter(issue => issue.status === 'open'); }\nmodule.exports = { listOpen };\n`,
  'src/unused.cjs': "module.exports = 'read-only transfer canary';\n",
  'test/issues.test.cjs': "const {test}=require('node:test');const assert=require('node:assert/strict');const {listOpen}=require('../src/issues.cjs');\ntest('open issues only',()=>assert.deepEqual(listOpen([{id:1,status:'open'},{id:2,status:'closed'}]),[{id:1,status:'open'}]));\n",
};
for (const [relative, content] of Object.entries(files)) {
  const file = path.join(workspace, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
}
const git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: workspace, encoding: 'utf8' });
git(['init', '--quiet']); git(['config', 'user.name', 'Mysti validation']); git(['config', 'user.email', 'validation@example.invalid']);
git(['add', '.']); git(['commit', '--quiet', '-m', 'Owned PC11 fixture baseline']);
// Real pre-existing developer edits: one staged README change and one
// unstaged source comment. Export/import must leave staged entries untouched.
files['README.md'] += 'Staged developer note: retain original open-only requirement.\n';
fs.writeFileSync(path.join(workspace, 'README.md'), files['README.md']); git(['add', 'README.md']);
files['src/issues.cjs'] += '// Unstaged developer note: preserve this comment during transfer.\n';
fs.writeFileSync(path.join(workspace, 'src/issues.cjs'), files['src/issues.cjs']);
const originalIndex = git(['ls-files', '--stage']);
const originalStatus = git(['status', '--porcelain=v1', '--untracked-files=all']);
const cliDirectory = path.join(directory, 'cli'); fs.mkdirSync(cliDirectory);
const hooks = path.join(cliDirectory, 'claude-settings.json'); fs.writeFileSync(hooks, JSON.stringify({ disableAllHooks: true }), { mode: 0o600 });
const wrappers = {}, receiptPaths = [];
for (const [provider, executable] of Object.entries(executables)) {
  const fixture = createTransferCli({ directory: cliDirectory, provider, executable, node, hooks, window: 'A', tokens: { issue: token }, forbidInference: acknowledgementOnly });
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
const helper = path.join(artifactDir, 'transfer-runner-extension'); fs.mkdirSync(helper);
fs.writeFileSync(path.join(helper, 'package.json'), JSON.stringify({ name: 'pc11-transfer-runner', publisher: 'MystiValidation', version: '1.0.0',
  engines: { vscode: '^1.100.0' }, activationEvents: ['onStartupFinished'], main: './extension.cjs', capabilities: { untrustedWorkspaces: { supported: true } },
  contributes: { commands: [{ command: 'mystiValidation.pc11.retryClipboardRestore', title: 'Mysti Validation: Retry PC11 Clipboard Restore' }] } }, null, 2));
const manifest = { case: 'PC-11', mode: acknowledgementOnly ? 'ack-smoke' : 'full-transfer', preparedBeforeActivation: true, artifactDir, helper, sourcePackage: source,
  bundleSha256: hash(fs.readFileSync(path.join(source, 'dist/extension.js'))), chatSha256: hash(fs.readFileSync(path.join(source, 'media/chat/chat.js'))),
  windows: { A: { id: 'A', directory, workspace, profile, sharedDataDir, extensionsDir, installedExtension, cliDirectory, wrappers, receiptPaths } },
  token, files, originalIndex, originalStatus, fixtureFileCount: Object.keys(files).length,
  conversationalRequestsPlanned: acknowledgementOnly ? 0 : 7, accountMutation: false, extensionTestsPathUsed: false,
  scope: acknowledgementOnly ? 'One ordinary owned profile; JSON, framed Markdown, JSONL import acknowledgements and cancellation. Zero inference, no clipboard/URI operation; supplements the earlier seven-request run.' : 'Bounded owned issue-tracker fixture; two ordinary isolated profiles, seven native input cap, file/clipboard/URI transfer and import during concurrent turns. Not full F2 or elapsed W/P.',
};

const exchange = path.join(artifactDir, 'exchange'); fs.mkdirSync(exchange);
manifest.exchange = exchange;
manifest.uriPreflightNonce = randomBytes(16).toString('hex');
manifest.clipboardRecoveryKey = randomBytes(32).toString('hex');
manifest.siblingToken = 'PC11_SIBLING_' + randomBytes(10).toString('hex');
if (!acknowledgementOnly) {
const directoryB = path.join(artifactDir, 'window-B'); fs.mkdirSync(directoryB);
const profileB = fs.realpathSync(fs.mkdtempSync(path.join(profiles, 'pc11-B-')));
fs.writeFileSync(path.join(profileB, '.mysti-test-owned.json'), JSON.stringify({ case: 'PC-11', profile: profileB, window: 'B' }), { mode: 0o600 });
const sharedDataDirB = fs.mkdtempSync(path.join(repo, '.vscode-test/pc11-B-shared-'));
const extensionsDirB = path.join(directoryB, 'installed-extensions'); fs.mkdirSync(extensionsDirB);
const installedExtensionB = path.join(extensionsDirB, `deepmyst.mysti-${product.version}`);
fs.cpSync(source, installedExtensionB, { recursive: true, errorOnExist: true, force: false });
const workspaceB = path.join(directoryB, 'workspace'); fs.mkdirSync(workspaceB);
fs.writeFileSync(path.join(workspaceB, 'README.md'), 'Owned PC11 receiving workspace. Native agents may not change files.\n');
const cliDirectoryB = path.join(directoryB, 'cli'); fs.mkdirSync(cliDirectoryB);
const hooksB = path.join(cliDirectoryB, 'claude-settings.json'); fs.writeFileSync(hooksB, JSON.stringify({ disableAllHooks: true }), { mode: 0o600 });
const wrappersB = {}, receiptPathsB = [];
for (const [provider, executable] of Object.entries(executables)) {
  const fixture = createTransferCli({ directory: cliDirectoryB, provider, executable, node, hooks: hooksB, window: 'B', tokens: { issue: token, sibling: manifest.siblingToken } });
  wrappersB[provider] = fixture.launcher; receiptPathsB.push(fixture.receipts);
}
fs.mkdirSync(path.join(profileB, 'User'));
fs.writeFileSync(path.join(profileB, 'User/settings.json'), JSON.stringify({ ...settings, 'mysti.claudeCodePath': wrappersB['claude-code'], 'mysti.codexPath': wrappersB['openai-codex'] }, null, 2));
manifest.windows.B = { id: 'B', directory: directoryB, workspace: workspaceB, profile: profileB, sharedDataDir: sharedDataDirB, extensionsDir: extensionsDirB, installedExtension: installedExtensionB, cliDirectory: cliDirectoryB, wrappers: wrappersB, receiptPaths: receiptPathsB };
}
manifest.exports = { json: path.join(exchange, 'source.mysti.json'), markdown: path.join(exchange, 'source.md'), longInput: path.join(exchange, 'long-input.mysti.json') };
const longConversation = { id: 'owned-long-input', title: 'Owned long transfer fixture', createdAt: 1, updatedAt: 1, mode: 'ask-before-edit', provider: 'claude-code', model: 'unknown',
  messages: Array.from({length: 14}, (_, index) => ({id: 'owned-long-' + index, role: index % 2 ? 'assistant' : 'user', content: 'PC11_LONG_' + index + ': ' + 'compressible synthetic conversation content. '.repeat(index === 13 ? 100 : 10), timestamp: index + 1})) };
fs.writeFileSync(manifest.exports.longInput, JSON.stringify({ format: 'mysti', version: 1, exportedAt: 1, conversation: longConversation }, null, 2));
manifest.longConversation = longConversation;
if (acknowledgementOnly) {
  const original = path.join(repo, 'out-test/feature-tests/PC-11/native-retry1/exchange');
  const sourceReady = JSON.parse(fs.readFileSync(path.join(original, 'source-ready.json')));
  for (const format of ['json', 'markdown']) {
    const originalFile = path.join(original, format === 'json' ? 'source.mysti.json' : 'source.md');
    assert.equal(hash(fs.readFileSync(originalFile)), sourceReady[format === 'json' ? 'jsonSha256' : 'markdownSha256']);
    fs.copyFileSync(originalFile, manifest.exports[format], fs.constants.COPYFILE_EXCL);
  }
  const jsonlMessages = [{ role: 'user', content: 'PC11_ACK_JSONL_USER: Which statuses belong in listOpen?' },
    { role: 'assistant', content: 'PC11_ACK_JSONL_ASSISTANT: Include open and exclude closed.\n\n```js\nissue => issue.status === \'open\'\n```' }];
  const jsonl = path.join(exchange, 'acknowledgement.jsonl');
  fs.writeFileSync(jsonl, jsonlMessages.map(message => JSON.stringify({ message })).join('\n') + '\n');
  manifest.acknowledgementFixtures = [
    { format: 'json', file: manifest.exports.json, sha256: sourceReady.jsonSha256, messages: sourceReady.source.messages.map(({ role, content }) => ({ role, content })) },
    { format: 'markdown', file: manifest.exports.markdown, sha256: sourceReady.markdownSha256, messages: sourceReady.source.messages.map(({ role, content }) => ({ role, content })) },
    { format: 'jsonl', file: jsonl, sha256: hash(fs.readFileSync(jsonl)), messages: jsonlMessages },
  ];
}
fs.writeFileSync(path.join(helper, 'extension.cjs'), `
'use strict';
const vscode=require('vscode'),fs=require('fs'),path=require('path'),{createHash,createHmac}=require('crypto');
const manifestPath=${JSON.stringify(manifestFile)},repo=${JSON.stringify(repo)};
exports.activate=context=>{context.subscriptions.push(vscode.window.registerUriHandler({handleUri(uri){const m=JSON.parse(fs.readFileSync(manifestPath)),w=m.windows[process.env.MYSTI_PC11_WINDOW];if(uri.path==='/preflight'&&new URLSearchParams(uri.query).get('nonce')===m.uriPreflightNonce)fs.writeFileSync(path.join(w.directory,'uri-routing-preflight.json'),JSON.stringify({profile:w.profile,extensionHostPid:process.pid,nonce:m.uriPreflightNonce,workspace:vscode.workspace.workspaceFolders?.[0]?.uri.fsPath}));}}));setTimeout(run,500);};
async function run(){
 const m=JSON.parse(fs.readFileSync(manifestPath)),w=m.windows[process.env.MYSTI_PC11_WINDOW],directory=w.directory;
 let failures=0,error;const testFailures=[],started=Date.now();
 try{
  if(vscode.workspace.workspaceFolders?.length!==1||fs.realpathSync(vscode.workspace.workspaceFolders[0].uri.fsPath)!==fs.realpathSync(w.workspace))throw new Error('Runner must trust only its exact sole owned workspace');
  if(!vscode.workspace.isTrusted)await vscode.commands.executeCommand('workbench.trust.manage');
  const trustDeadline=Date.now()+60000;while(!vscode.workspace.isTrusted&&Date.now()<trustDeadline)await new Promise(r=>setTimeout(r,100));
  if(!vscode.workspace.isTrusted)throw new Error('Owned PC11 workspace trust precondition was not completed');
  const registryStarted=Date.now(),registryDeadline=registryStarted+15000;let product=vscode.extensions.getExtension('DeepMyst.mysti');
  while(!product&&Date.now()<registryDeadline){await new Promise(r=>setTimeout(r,100));product=vscode.extensions.getExtension('DeepMyst.mysti');}
  const actualPath=product?fs.realpathSync(product.extensionPath):null,expectedPath=fs.realpathSync(w.installedExtension);
  fs.writeFileSync(path.join(directory,'registry-readiness.json'),JSON.stringify({waitMs:Date.now()-registryStarted,actualPath,expectedPath,pathMatches:actualPath===expectedPath}));
  if(actualPath!==expectedPath)throw new Error('Mysti registry did not resolve the prepared installed payload');
  const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if(hash(path.join(actualPath,'dist/extension.js'))!==m.bundleSha256||hash(path.join(actualPath,'media/chat/chat.js'))!==m.chatSha256)throw new Error('Installed Mysti payload differs from prepared release');
  fs.writeFileSync(path.join(directory,'helper-ready.json'),JSON.stringify({extensionHostPid:process.pid,profile:w.profile,extensionTestsPathUsed:false}));
  const Mocha=require(path.join(repo,'node_modules/mocha'));const mocha=new Mocha({ui:'bdd',timeout:1050000,color:false});
  mocha.grep('PC-11 real editor');mocha.addFile(path.join(repo,'out-vscode-test/transfer.test.js'));
  failures=await new Promise(resolve=>mocha.run(resolve).on('fail',(test,reason)=>testFailures.push({title:test.fullTitle(),name:reason?.name,message:reason?.message})));
 }catch(reason){failures=1;error={name:reason?.name,message:reason?.message};}
 let retainForClipboard=false;const recoveryFile=path.join(directory,'clipboard-restore-failed.json');
 if(fs.existsSync(recoveryFile)){const recovery=JSON.parse(fs.readFileSync(recoveryFile)),signature=recovery.signature;delete recovery.signature;retainForClipboard=recovery.extensionHostPid===process.pid&&recovery.profile===w.profile&&recovery.window===w.id&&signature===createHmac('sha256',m.clipboardRecoveryKey).update(JSON.stringify(recovery)).digest('hex');}
 fs.writeFileSync(path.join(directory,'runner-result.json'),JSON.stringify({failures,error,testFailures,durationMs:Date.now()-started,extensionHostPid:process.pid,normalQuitRequested:!retainForClipboard,retainForClipboard},null,2));
 if(failures)fs.writeFileSync(path.join(m.artifactDir,'failure-'+w.id+'.json'),JSON.stringify({failures,error,testFailures}));
 if(!retainForClipboard)await vscode.commands.executeCommand('workbench.action.quit');
}
exports.deactivate=()=>{};
`);
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ prepared: manifestFile, profile, mode: manifest.mode, conversationalRequestsPlanned: manifest.conversationalRequestsPlanned, launchesPerformed: 0, fixtureFileCount: manifest.fixtureFileCount }));
