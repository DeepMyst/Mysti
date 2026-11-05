/* PB-01 ordinary profile preparation. No editor, actual clipboard or inference. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createHash,randomBytes}=require('node:crypto');
const {createF1}=require('./pb01-fixture.cjs'),{createPB01Cli}=require('./pb01-cli-fixture.cjs');
const repo=path.resolve(__dirname,'../..'),root=path.join(repo,'out-test/feature-tests/PB-01');
const artifactDir=path.resolve(process.env.MYSTI_PB01_ARTIFACT_DIR||path.join(root,'native'));
assert(artifactDir.startsWith(root+path.sep));fs.mkdirSync(artifactDir,{recursive:true});
const manifestFile=path.join(artifactDir,'prepared.json');assert(!fs.existsSync(manifestFile),'Never reuse a prepared attempt');
const source=fs.realpathSync(process.env.MYSTI_TEST_EXTENSION_PATH),product=JSON.parse(fs.readFileSync(path.join(source,'package.json')));
assert.equal(product.name,'mysti');assert.equal(product.publisher.toLowerCase(),'deepmyst');
const readinessPath=path.resolve(process.env.MYSTI_PB01_READINESS||path.join(root,'readiness.json')),readiness=JSON.parse(fs.readFileSync(readinessPath));
const executable=fs.realpathSync(process.env.MYSTI_PB01_CLAUDE_PATH||readiness.executable),node=fs.realpathSync(process.env.MYSTI_PB01_NODE_PATH||process.execPath);
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
assert.equal(executable,readiness.executable);assert.equal(hash(executable),readiness.sha256);assert.match(readiness.checks.version.version,/^2\.1\.288\b/);
const directory=path.join(artifactDir,'window-A');fs.mkdirSync(directory);
const extensionsDir=path.join(directory,'installed-extensions');fs.mkdirSync(extensionsDir);
const installedExtension=path.join(extensionsDir,`deepmyst.mysti-${product.version}`);fs.cpSync(source,installedExtension,{recursive:true,errorOnExist:true,force:false});
const profiles=path.join(repo,'.vscode-test/profiles');fs.mkdirSync(profiles,{recursive:true});
const profile=fs.realpathSync(fs.mkdtempSync(path.join(profiles,'pb01-A-')));
fs.writeFileSync(path.join(profile,'.mysti-test-owned.json'),JSON.stringify({case:'PB-01',profile,window:'A'}),{mode:0o600});
const sharedDataDir=fs.mkdtempSync(path.join(repo,'.vscode-test/pb01-A-shared-'));
const token=`PB01_SERVICE_${randomBytes(10).toString('hex')}`,attachmentToken=`PB01_ATTACHMENT_${randomBytes(10).toString('hex')}`;
const fixture=createF1({directory:path.join(directory,'workspace'),token,attachmentToken});
const cliDirectory=path.join(directory,'cli');fs.mkdirSync(cliDirectory);
const hooks=path.join(cliDirectory,'claude-settings.json');fs.writeFileSync(hooks,JSON.stringify({disableAllHooks:true}),{mode:0o600});
const counterFile=path.join(directory,'forwarded-input-count.json');
const cli=createPB01Cli({directory:cliDirectory,executable,node,hooks,counterFile,token,attachmentToken,workspace:fixture.workspace,maxInputs:30});
const settings={'files.simpleDialog.enable':true,'window.dialogStyle':'custom','git.enabled':false,
  'mysti.claudeCodePath':cli.launcher,'mysti.defaultAgent':'claude-code','mysti.defaultProvider':'claude-code','mysti.defaultModel':'sonnet','mysti.claudeCodeModel':'sonnet',
  'mysti.defaultEffortLevel':'low','mysti.defaultThinkingLevel':'none','mysti.defaultMode':'ask-before-edit','mysti.accessLevel':'ask-permission',
  'mysti.autoContext':false,'mysti.showSuggestions':false,'mysti.agents.autoSuggest':false};
fs.mkdirSync(path.join(profile,'User'));fs.writeFileSync(path.join(profile,'User/settings.json'),JSON.stringify(settings,null,2));
const helper=path.join(artifactDir,'claude-runner-extension');fs.mkdirSync(helper);
fs.writeFileSync(path.join(helper,'package.json'),JSON.stringify({name:'pb01-claude-runner',publisher:'MystiValidation',version:'1.0.0',engines:{vscode:'^1.100.0'},activationEvents:['onStartupFinished'],main:'./extension.cjs',capabilities:{untrustedWorkspaces:{supported:true}}},null,2));
const manifest={case:'PB-01',preparedBeforeActivation:true,artifactDir,helper,sourcePackage:source,bundleSha256:hash(path.join(source,'dist/extension.js')),chatSha256:hash(path.join(source,'media/chat/chat.js')),
  windows:{A:{id:'A',directory,workspace:fixture.workspace,profile,sharedDataDir,extensionsDir,installedExtension,cliDirectory,wrappers:{'claude-code':cli.launcher},receiptPaths:[cli.receipts]}},
  fixture,token,attachmentToken,counterFile,maxForwardedInputs:30,plannedSuccessfulTurns:25,plannedStoppedTurns:2,plannedRejectedModelAttempts:1,plannedForwardedRejectedInputs:[0,1],plannedNativeCommands:1,
  invalidModel:`mysti-pb01-invalid-${randomBytes(8).toString('hex')}`,otherPanelToken:`PB01_SECOND_PANEL_${randomBytes(10).toString('hex')}`,
  executableIdentities:{'claude-code':{path:executable,sha256:hash(executable),version:readiness.checks.version.version}},nodeIdentity:{path:node,sha256:hash(node)},
  wrapperIdentities:[cli.launcher,cli.runtime,hooks].map(file=>({path:file,sha256:hash(file)})),
  harnessDependencyIdentities:['claude-fixture-oracle.cjs','claude-interaction-oracle.cjs','pb01-fixture.cjs'].map(file=>({path:path.join(__dirname,file),sha256:hash(path.join(__dirname,file))})),
  readiness:{path:readinessPath,sha256:hash(readinessPath),liveInferenceEntitlement:'Unverified until actual requests'},
  wrapperInjections:{claude:'Preserve exact Mysti ultracode JSON and merge disableAllHooks=true in a separate owned file; no native approval reply injection; hard30-input gate before forwarding user frames'},
  scope:'F1 small Node service; target25 completed developer turns plus2 stopped inputs,1 invalid-model rejection attempt (0 or1 forwarded user frames depending on native initialization failure) and1 native command, planned28–29frames with hardcap30 including UI-generated follow-ups. Actual Read/Edit/Bash cards and receipts, denial canary, queued-work prevention, native question/plan follow-ups when emitted, two actual editor tabs with one-directional private-token isolation, text/blue PNG attachments and compact recall. A missing native interaction remains PARTIAL even if a separately identified manual follow-up completes. Only .mysti/plans/pb01-native.md may be written as native plan metadata. No F2 full-stack, over-context-budget, auth/quota/network fault campaign or elapsed S/W/E/P claim. Editor restart deferred to a separately reviewed phase.'};
fs.writeFileSync(path.join(helper,'extension.cjs'),`
'use strict';
const vscode=require('vscode'),fs=require('fs'),path=require('path'),{createHash}=require('crypto');
const manifestPath=${JSON.stringify(manifestFile)},repo=${JSON.stringify(repo)};
exports.activate=()=>setTimeout(run,500);
async function run(){const m=JSON.parse(fs.readFileSync(manifestPath)),w=m.windows.A;let failures=0,error;const testFailures=[],started=Date.now();
 try{
  if(vscode.workspace.workspaceFolders?.length!==1||fs.realpathSync(vscode.workspace.workspaceFolders[0].uri.fsPath)!==fs.realpathSync(w.workspace))throw new Error('Only exact owned F1 workspace is permitted');
  if(!vscode.workspace.isTrusted)await vscode.commands.executeCommand('workbench.trust.manage');
  const trustDeadline=Date.now()+60000;while(!vscode.workspace.isTrusted&&Date.now()<trustDeadline)await new Promise(r=>setTimeout(r,100));if(!vscode.workspace.isTrusted)throw new Error('Owned workspace trust was not completed');
  const deadline=Date.now()+15000;let product=vscode.extensions.getExtension('DeepMyst.mysti');while(!product&&Date.now()<deadline){await new Promise(r=>setTimeout(r,100));product=vscode.extensions.getExtension('DeepMyst.mysti');}
  const actualPath=product?fs.realpathSync(product.extensionPath):null,expectedPath=fs.realpathSync(w.installedExtension);
  fs.writeFileSync(path.join(w.directory,'registry-readiness.json'),JSON.stringify({actualPath,expectedPath,pathMatches:actualPath===expectedPath}));
  if(product?.isUnderDevelopment||actualPath!==expectedPath)throw new Error('Mysti must be the exact ordinary installed payload');
  const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');if(hash(path.join(actualPath,'dist/extension.js'))!==m.bundleSha256||hash(path.join(actualPath,'media/chat/chat.js'))!==m.chatSha256)throw new Error('Installed package mismatch');
  fs.writeFileSync(path.join(w.directory,'helper-ready.json'),JSON.stringify({extensionHostPid:process.pid,profile:w.profile,extensionTestsPathUsed:false,productUnderDevelopment:product.isUnderDevelopment??'NOT_EXPOSED_BY_PUBLIC_API'}));
  const Mocha=require(path.join(repo,'node_modules/mocha')),mocha=new Mocha({ui:'bdd',timeout:3000000,color:false});mocha.grep('PB-01 real editor');mocha.addFile(path.join(repo,'out-vscode-test/claude.test.js'));
  failures=await new Promise(resolve=>mocha.run(resolve).on('fail',(test,reason)=>testFailures.push({title:test.fullTitle(),name:reason?.name,message:reason?.message})));
 }catch(reason){failures=1;error={name:reason?.name,message:reason?.message};}
 fs.writeFileSync(path.join(w.directory,'runner-result.json'),JSON.stringify({failures,error,testFailures,durationMs:Date.now()-started,extensionHostPid:process.pid,normalQuitRequested:true},null,2));await vscode.commands.executeCommand('workbench.action.quit');
}
exports.deactivate=()=>{};
`);
fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2),{mode:0o600,flag:'wx'});
console.log(JSON.stringify({prepared:manifestFile,profile,plannedSuccessfulTurns:25,maxForwardedInputs:30,launchesPerformed:0,fixtureFiles:Object.keys(fixture.files).length}));
