/* PC-09 preparation only: two owned ordinary-editor profiles; no inference. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { createIsolationCli } = require('./isolation-cli-fixture.cjs');
const repo = path.resolve(__dirname, '../..');
const artifactDir = path.resolve(process.env.MYSTI_PC09_ARTIFACT_DIR || path.join(repo, 'out-test/feature-tests/PC-09/native'));
assert(artifactDir.startsWith(path.join(repo, 'out-test/feature-tests/PC-09') + path.sep));
fs.mkdirSync(artifactDir, { recursive: true });
const manifestFile = path.join(artifactDir, 'prepared.json');
assert(!fs.existsSync(manifestFile), 'Never overwrite a previous paid attempt or its owned profile');
const source = fs.realpathSync(process.env.MYSTI_TEST_EXTENSION_PATH);
const product = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
assert.equal(product.publisher.toLowerCase(), 'deepmyst'); assert.equal(product.name, 'mysti');
const cli = { 'claude-code': process.env.MYSTI_PC09_CLAUDE_PATH, 'openai-codex': process.env.MYSTI_PC09_CODEX_PATH };
const node = process.env.MYSTI_PC09_NODE_PATH || process.execPath;
for (const executable of [...Object.values(cli), node]) assert(executable && path.isAbsolute(executable) && fs.existsSync(executable));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const helper = path.join(artifactDir, 'isolation-runner-extension'); fs.mkdirSync(helper);
fs.writeFileSync(path.join(helper, 'package.json'), JSON.stringify({ name: 'pc09-isolation-runner', publisher: 'MystiValidation', version: '1.0.0',
  engines: { vscode: '^1.100.0' }, activationEvents: ['onStartupFinished'], main: './extension.cjs', capabilities: { untrustedWorkspaces: { supported: true } } }, null, 2));
const profiles = path.join(repo, '.vscode-test/profiles'); fs.mkdirSync(profiles, { recursive: true });
const tokens = Object.fromEntries(['A0', 'A1', 'A2', 'B0'].map(scope => [scope, `PC09_CONTEXT_${scope}_${randomBytes(10).toString('hex')}`]));
const windows = {};
for (const id of ['A', 'B']) {
  const directory = path.join(artifactDir, `window-${id}`); fs.mkdirSync(directory);
  // Independent editor processes must not race first creation of the same
  // extensions.json.vsctmp catalog. Each gets an identical immutable payload.
  const extensionsDir = path.join(directory, 'installed-extensions');
  const installedExtension = path.join(extensionsDir, `deepmyst.mysti-${product.version}`);
  fs.mkdirSync(extensionsDir); fs.cpSync(source, installedExtension, { recursive: true, errorOnExist: true, force: false });
  const workspace = path.join(directory, 'workspace'); fs.mkdirSync(workspace);
  const profile = fs.realpathSync(fs.mkdtempSync(path.join(profiles, `pc09-${id}-`)));
  fs.writeFileSync(path.join(profile, '.mysti-test-owned.json'), JSON.stringify({ case: 'PC-09', profile, window: id }), { mode: 0o600 });
  const sharedDataDir = fs.mkdtempSync(path.join(repo, `.vscode-test/pc09-${id}-shared-`));
  const cliDirectory = path.join(directory, 'cli'); fs.mkdirSync(cliDirectory);
  const hooks = path.join(cliDirectory, 'claude-settings.json'); fs.writeFileSync(hooks, JSON.stringify({ disableAllHooks: true }), { mode: 0o600 });
  const wrappers = {}, receiptPaths = [];
  for (const [provider, executable] of Object.entries(cli)) {
    const fixture = createIsolationCli({ directory: cliDirectory, provider, executable, node, hooks, window: id, tokens });
    wrappers[provider] = fixture.launcher; receiptPaths.push(fixture.receipts);
  }
  const scopes = {};
  for (const label of Object.keys(tokens).filter(label => label.startsWith(id))) {
    const contextFile = path.join(workspace, `context-${label}.ts`);
    const content = `// Synthetic context owned only by chat ${label}.\nexport const PC09_CONTEXT_TOKEN = '${tokens[label]}';\nexport const retryBaseMs = 73;\n`;
    fs.writeFileSync(contextFile, content); scopes[label] = { contextFile, content, contentSha256: createHash('sha256').update(content).digest('hex') };
  }
  // An actual synthetic 10k-file monorepo-shaped workspace, without reading
  // developer projects or requiring the model to inspect these unrelated files.
  if (id === 'B') for (let group = 0; group < 100; group++) {
    const folder = path.join(workspace, `package-${group}`); fs.mkdirSync(folder);
    for (let file = 0; file < 100; file++) fs.writeFileSync(path.join(folder, `module-${file}.ts`), `export const fixture = ${group * 100 + file};\n`);
  }
  fs.writeFileSync(path.join(workspace, 'README.md'), `Owned PC-09 ${id} fixture. No real account data.\n`);
  const settings = { 'files.simpleDialog.enable': true,
    'mysti.claudeCodePath': wrappers['claude-code'], 'mysti.codexPath': wrappers['openai-codex'],
    'mysti.defaultAgent': id === 'A' ? 'claude-code' : 'openai-codex', 'mysti.defaultProvider': id === 'A' ? 'claude-code' : 'openai-codex',
    'mysti.defaultModel': id === 'A' ? 'sonnet' : 'gpt-5.6-sol', 'mysti.claudeCodeModel': 'sonnet', 'mysti.codexModel': 'gpt-5.6-sol',
    'mysti.codexProfile': '', 'mysti.defaultEffortLevel': 'low', 'mysti.defaultThinkingLevel': 'none', 'mysti.defaultMode': 'ask-before-edit',
    'mysti.accessLevel': 'ask-permission', 'mysti.autoContext': false, 'mysti.showSuggestions': false, 'mysti.agents.autoSuggest': false };
  fs.mkdirSync(path.join(profile, 'User')); fs.writeFileSync(path.join(profile, 'User/settings.json'), JSON.stringify(settings, null, 2));
  windows[id] = { id, directory, workspace, profile, sharedDataDir, extensionsDir, installedExtension, cliDirectory, wrappers, receiptPaths, scopes, syntheticUnrelatedFileCount: id === 'B' ? 10000 : 0 };
}
const manifest = { case: 'PC-09', preparedBeforeActivation: true, artifactDir, windows, tokens, helper,
  sourcePackage: source, bundleSha256: hash(path.join(source, 'dist/extension.js')), chatSha256: hash(path.join(source, 'media/chat/chat.js')),
  conversationalRequestsPlanned: 5, accountMutation: false, extensionTestsPathUsed: false };
fs.writeFileSync(path.join(helper, 'extension.cjs'), `
'use strict';
const vscode=require('vscode'),fs=require('fs'),path=require('path'),{createHash}=require('crypto');
const manifestPath=${JSON.stringify(manifestFile)},repo=${JSON.stringify(repo)};
exports.activate=()=>{setTimeout(run,500);};
async function run(){
 const m=JSON.parse(fs.readFileSync(manifestPath)),id=process.env.MYSTI_PC09_WINDOW,w=m.windows[id];
 const directory=w.directory;let failures=0,error;const testFailures=[],started=Date.now();
 try{
  if(vscode.workspace.workspaceFolders?.length!==1||fs.realpathSync(vscode.workspace.workspaceFolders[0].uri.fsPath)!==fs.realpathSync(w.workspace))throw new Error('Runner must trust only its exact sole owned workspace');
  if(!vscode.workspace.isTrusted)await vscode.commands.executeCommand('workbench.trust.manage');
  const deadline=Date.now()+60000;while(!vscode.workspace.isTrusted&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
  if(!vscode.workspace.isTrusted)throw new Error('Owned PC09 workspace trust precondition was not completed');
  const registryStarted=Date.now(),registryDeadline=registryStarted+15000;
  let product=vscode.extensions.getExtension('DeepMyst.mysti');
  while(!product&&Date.now()<registryDeadline){await new Promise(r=>setTimeout(r,100));product=vscode.extensions.getExtension('DeepMyst.mysti');}
  const actualPath=product?fs.realpathSync(product.extensionPath):null;
  const expectedPath=fs.realpathSync(w.installedExtension);
  fs.writeFileSync(path.join(directory,'registry-readiness.json'),JSON.stringify({window:id,waitMs:Date.now()-registryStarted,extensionPresent:!!product,actualPath,expectedPath,pathMatches:actualPath===expectedPath}));
  if(!product)throw new Error('Mysti extension missing from registry after 15000ms readiness deadline');
  if(actualPath!==expectedPath)throw new Error('Mysti registry resolved a different installed payload');
  const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if(hash(path.join(actualPath,'dist/extension.js'))!==m.bundleSha256||hash(path.join(actualPath,'media/chat/chat.js'))!==m.chatSha256)throw new Error('Installed Mysti payload hash differs from prepared release');
  fs.writeFileSync(path.join(directory,'helper-ready.json'),JSON.stringify({window:id,extensionHostPid:process.pid,profile:w.profile,extensionTestsPathUsed:false}));
  const Mocha=require(path.join(repo,'node_modules/mocha'));const mocha=new Mocha({ui:'bdd',timeout:600000,color:false});
  mocha.grep('PC-09 real editor');mocha.addFile(path.join(repo,'out-vscode-test/isolation.test.js'));
  failures=await new Promise(resolve=>mocha.run(resolve).on('fail',(test,reason)=>testFailures.push({title:test.fullTitle(),name:reason?.name,message:reason?.message})));
 }catch(reason){failures=1;error={name:reason?.name,message:reason?.message};}
 fs.writeFileSync(path.join(directory,'runner-result.json'),JSON.stringify({window:id,failures,error,testFailures,durationMs:Date.now()-started,extensionHostPid:process.pid,normalQuitRequested:true},null,2));
 if(failures)fs.writeFileSync(path.join(m.artifactDir,'failure-'+id+'.json'),JSON.stringify({window:id,failures,error,testFailures}));
 await vscode.commands.executeCommand('workbench.action.quit');
}
exports.deactivate=()=>{};
`);
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ prepared: manifestFile, profiles: Object.values(windows).map(window => window.profile), conversationalRequestsPlanned: 5, launchesPerformed: 0 }));
