/* PC-08 ordinary-editor runner: no extensionTestsPath / in-memory storage. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const repo = path.resolve(__dirname, '../..');
const artifactDir = path.resolve(process.env.MYSTI_PC08_ARTIFACT_DIR);
assert(artifactDir.startsWith(path.join(repo, 'out-test/feature-tests/PC-08') + path.sep));
const manifestPath = path.join(artifactDir, 'prepared.json');
const prepared = JSON.parse(fs.readFileSync(manifestPath));
assert.equal(prepared.case, 'PC-08'); assert(!prepared.diskRunner);
const source = fs.realpathSync(process.env.MYSTI_TEST_EXTENSION_PATH);
const product = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
assert.equal(product.publisher.toLowerCase(), 'deepmyst'); assert.equal(product.name, 'mysti');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const extensionsDir = path.join(artifactDir, 'installed-extensions');
const installed = path.join(extensionsDir, `deepmyst.mysti-${product.version}`);
fs.mkdirSync(extensionsDir, { recursive: true }); fs.cpSync(source, installed, { recursive: true, errorOnExist: true, force: false });
const helper = path.join(artifactDir, 'disk-runner-extension'); fs.mkdirSync(helper);
fs.writeFileSync(path.join(helper, 'package.json'), JSON.stringify({ name: 'pc08-disk-runner', publisher: 'MystiValidation', version: '1.0.0',
  engines: { vscode: '^1.100.0' }, activationEvents: ['onStartupFinished'], main: './extension.cjs',
  capabilities: { untrustedWorkspaces: { supported: true } } }, null, 2));
const sharedDataDir = fs.mkdtempSync(path.join(repo, '.vscode-test/pc08-shared-'));
prepared.diskRunner = { helper, installedExtension: installed, extensionsDir, sharedDataDir,
  originalPackagePath: source, bundleSha256: hash(path.join(source, 'dist/extension.js')), chatSha256: hash(path.join(source, 'media/chat/chat.js')),
  sentinel: 'PC08_STORAGE_' + randomBytes(12).toString('hex') };
fs.writeFileSync(path.join(helper, 'extension.cjs'), `
'use strict';
const vscode=require('vscode'),fs=require('fs'),path=require('path');
const manifestPath=${JSON.stringify(manifestPath)},repo=${JSON.stringify(repo)};
exports.activate=context=>{setTimeout(()=>run(context),500);};
async function run(context){
 const manifest=JSON.parse(fs.readFileSync(manifestPath)),stage=process.env.MYSTI_PC08_STAGE;
 const evidence=path.join(path.dirname(manifestPath),stage);fs.mkdirSync(evidence,{recursive:true});
 const resultFile=path.join(evidence,'runner-result.json');
 const started=Date.now();let failures=0,error;
 try{
  if(vscode.workspace.workspaceFolders?.length!==1||fs.realpathSync(vscode.workspace.workspaceFolders[0].uri.fsPath)!==fs.realpathSync(path.join(repo,'out-vscode-test/fixture-workspace')))throw new Error('Trust scope must be the one owned fixture workspace');
  if(!vscode.workspace.isTrusted)await vscode.commands.executeCommand('workbench.trust.manage');
  // The isolated runner trusts only its own fixture through the real VS Code
  // trust dialog. The external driver handles that dialog before this wait.
  const deadline=Date.now()+30000;while(!vscode.workspace.isTrusted&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
  if(!vscode.workspace.isTrusted)throw new Error('Owned fixture workspace was not trusted through the editor UI');
  const product=vscode.extensions.getExtension('DeepMyst.mysti');
  if(!product||product.isUnderDevelopment||fs.realpathSync(product.extensionPath)!==fs.realpathSync(manifest.diskRunner.installedExtension))throw new Error('Expected installed immutable Mysti extension');
  fs.writeFileSync(path.join(evidence,'helper-ready.json'),JSON.stringify({workspaceTrusted:true,installedPayload:true,developmentFlag:product.isUnderDevelopment??'NOT_EXPOSED_BY_PUBLIC_API',extensionHostPid:process.pid}));
  if(stage==='preflight-write'||stage==='preflight-read'){
   if(stage==='preflight-write')await context.globalState.update('pc08.diskSentinel',manifest.diskRunner.sentinel);
   else if(context.globalState.get('pc08.diskSentinel')!==manifest.diskRunner.sentinel)throw new Error('The actual editor did not restore the disk-backed sentinel');
   await product.activate();await vscode.commands.executeCommand('mysti.newConversation');
   await new Promise(r=>setTimeout(r,750));
   fs.writeFileSync(path.join(evidence,'storage-preflight.json'),JSON.stringify({stage,ownSentinelRestored:stage==='preflight-read',productIsUnderDevelopment:product.isUnderDevelopment??'NOT_EXPOSED_BY_PUBLIC_API',
    productPath:product.extensionPath,extensionHostPid:process.pid,extensionTestsPathUsed:false,publicEmptyChatCreated:true},null,2));
  }else if(stage==='title-probe'){
   const probe=await require(path.join(repo,'scripts/validation/history-title-probe.cjs')).runTitleProbe({manifest,artifactDir:evidence,executable:process.env.MYSTI_PC08_CLAUDE_PATH});
   if(probe.stdinInputWriteCount!==1||probe.cleanup.groupAliveAfterCleanup)throw new Error('Title diagnostic input/cleanup invariant failed');
  }else{
   const Mocha=require(path.join(repo,'node_modules/mocha'));const mocha=new Mocha({ui:'bdd',timeout:1500000,color:false});
   mocha.grep('PC-08 real editor');mocha.addFile(path.join(repo,'out-vscode-test/history.test.js'));
   failures=await new Promise(resolve=>mocha.run(resolve));
  }
 }catch(reason){failures=1;error={name:reason?.name,message:reason?.message};}
 fs.writeFileSync(resultFile,JSON.stringify({stage,failures,error,durationMs:Date.now()-started,extensionHostPid:process.pid,normalQuitRequested:true},null,2));
 await vscode.commands.executeCommand('workbench.action.quit');
}
exports.deactivate=()=>{};
`);
fs.writeFileSync(manifestPath, JSON.stringify(prepared, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ prepared: manifestPath, installedExtension: installed, helper, profile: prepared.profile, backend: 'ordinary VS Code, no extensionTestsPath' }));
