/* Preparation boundary controls only; no editor, provider or application starts. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const c = require('./codex-f2-verification-campaign.cjs');
const repo = path.resolve(__dirname, '../..'), root = fs.realpathSync(path.join(repo, 'out-test/feature-tests/PB-02'));
const directory = fs.mkdtempSync(path.join(root, 'f2-verification-preparation-controls-'));
const read = file => JSON.parse(fs.readFileSync(file));
const compiled = fs.realpathSync(process.argv[2]); c.contained(root, compiled);
const release = path.join(root, 'overnight-20261011/suggestion-ownership-release');
const sourceFile = process.env.MYSTI_PB02_F2_VERIFICATION_SOURCE_IDENTITY || path.join(release, 'source-identity.json');
const packageFile = process.env.MYSTI_PB02_F2_VERIFICATION_PACKAGE_IDENTITY || path.join(release, 'package-identity.json');
const script = path.join(__dirname, 'prepare-vscode-codex-f2-verification.cjs');
const env = { ...process.env, MYSTI_PB02_F2_VERIFICATION_SEGMENT: '1', MYSTI_PB02_F2_VERIFICATION_COMPILED_DIR: compiled,
  MYSTI_PB02_F2_VERIFICATION_SOURCE_IDENTITY: sourceFile, MYSTI_PB02_F2_VERIFICATION_PACKAGE_IDENTITY: packageFile };
const python=fs.realpathSync('/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3.9');
env.MYSTI_PB02_F2_VERIFICATION_PYTHON=python;
const browser=process.env.MYSTI_PB02_F2_VERIFICATION_BROWSER_ORACLE || path.join(root,'overnight-20261011/f2-remaining-browser-validation/selected-browser-remaining.cjs');
env.MYSTI_PB02_F2_VERIFICATION_BROWSER_ORACLE=browser;env.MYSTI_PB02_F2_VERIFICATION_BROWSER_ORACLE_SHA=c.identity(browser).sha256;
const cloneOptions=name=>({python,report:path.join(directory,name+'.clone.json')});
const checks = [], check = (name, fn) => { try { fn(); checks.push({ name, status: 'PASS' }); } catch(error) { checks.push({name,status:'FAIL',error:error.stack}); } };
function rejected(name, target, extra, pattern) {
  assert(!fs.existsSync(target));
  const before = fs.readdirSync(path.join(repo, '.vscode-test/profiles')).sort();
  const result = spawnSync(process.execPath, [script], { env: { ...env, MYSTI_PB02_F2_VERIFICATION_CAMPAIGN_DIR: target, ...extra }, encoding: 'utf8', timeout: 30000 });
  assert.notEqual(result.status, 0, name); assert.equal(result.signal, null); assert.match(result.stderr, pattern); assert(!fs.existsSync(target));
  assert.deepEqual(fs.readdirSync(path.join(repo, '.vscode-test/profiles')).sort(), before, 'Rejected prep creates no profile');
  fs.writeFileSync(path.join(directory, `${name}.process.json`), JSON.stringify({ status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }, null, 2), { flag: 'wx' });
}
check('invalid segment rejects before creation', () => rejected('invalid-segment', path.join(directory, 'invalid-segment-attempt'), { MYSTI_PB02_F2_VERIFICATION_SEGMENT: '3' }, /includes\(segment\)/));
check('out-of-root target rejects before creation', () => rejected('outside-root', path.join(repo, '.vscode-test/f2-forbidden-attempt'), {}, /Owned descendant required/));
check('missing parent rejects before creation', () => rejected('missing-parent', path.join(directory, 'missing/attempt'), {}, /ENOENT/));
check('aliased parent rejects before creation', () => {
  const alias = path.join(directory, 'alias'); fs.symlinkSync(directory, alias, 'dir');
  rejected('aliased-parent', path.join(alias, 'forbidden'), {}, /AssertionError/);
});
for (const marker of ['prepared.json', 'campaign.json']) check(`${marker} ancestor rejects before creation`, () => {
  const parent = path.join(directory, marker + '-parent'); fs.mkdirSync(parent); fs.writeFileSync(path.join(parent, marker), '{}');
  rejected(marker + '-ancestor', path.join(parent, 'forbidden'), {}, /Never prepare inside earlier native evidence/);
});
check('existing campaign cannot be overwritten', () => {
  const target = path.join(directory, 'existing'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'keep.txt'), 'exact preserved bytes');
  const result = spawnSync(process.execPath, [script], { env: { ...env, MYSTI_PB02_F2_VERIFICATION_CAMPAIGN_DIR: target }, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /exclusive new directory/); assert.deepEqual(fs.readdirSync(target), ['keep.txt']); assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'exact preserved bytes');
});
check('segment two requires an actual pinned prior campaign', () => rejected('missing-campaign', path.join(directory, 'missing-campaign-attempt'), { MYSTI_PB02_F2_VERIFICATION_SEGMENT: '2' }, /ENOENT/));
check('compiled code cannot be borrowed from a prepared evidence tree', () => {
  const parent = path.join(directory, 'compiled-parent'); fs.mkdirSync(parent); fs.writeFileSync(path.join(parent, 'prepared.json'), '{}');
  const child = path.join(parent, 'compiled'); fs.mkdirSync(child);
  rejected('compiled-ancestor', path.join(directory, 'compiled-forbidden'), { MYSTI_PB02_F2_VERIFICATION_COMPILED_DIR: child }, /Never prepare inside earlier native evidence/);
});
check('source freeze mismatch rejects before any campaign copy', () => {
  const changed = read(sourceFile); changed.files[Object.keys(changed.files)[0]] = '0'.repeat(64);
  const file = path.join(directory, 'wrong-source.json'); fs.writeFileSync(file, JSON.stringify(changed));
  rejected('wrong-source', path.join(directory, 'wrong-source-attempt'), { MYSTI_PB02_F2_VERIFICATION_SOURCE_IDENTITY: file }, /Frozen source\/test bytes required/);
});
check('package archive mismatch rejects before any campaign copy', () => {
  const changed = { ...read(packageFile), sha256: '0'.repeat(64) }, file = path.join(directory, 'wrong-package.json'); fs.writeFileSync(file, JSON.stringify(changed));
  rejected('wrong-package', path.join(directory, 'wrong-package-attempt'), { MYSTI_PB02_F2_VERIFICATION_PACKAGE_IDENTITY: file }, /AssertionError/);
});
const deps = path.join(directory, 'dependency-source'); fs.mkdirSync(path.join(deps, '.bin'), { recursive: true }); fs.mkdirSync(path.join(deps, 'tool'));
const executable = path.join(deps, 'tool/index.cjs'); fs.writeFileSync(executable, 'process.stdout.write(__dirname);\n');
fs.symlinkSync('../tool/index.cjs', path.join(deps, '.bin/tool'));
check('old default copy redirects a relative executable into source and is detected', () => {
  const target = path.join(directory, 'old-copy'); fs.cpSync(deps, target, { recursive: true });
  assert.equal(fs.realpathSync(path.join(target, '.bin/tool')), executable);
  assert.notEqual(fs.realpathSync(path.join(target, '.bin/tool')), path.join(target, 'tool/index.cjs'));
});
check('private copied executable resolves and runs solely inside owned copied dependency root', () => {
  const target = path.join(directory, 'private-copy'), receipt = c.copyPrivateDependencies(deps, target, cloneOptions(path.basename(target)));
  assert.equal(receipt.files, 1); assert.equal(fs.readlinkSync(path.join(target, '.bin/tool')), '../tool/index.cjs');
  assert.equal(execFileSync(process.execPath, [path.join(target, '.bin/tool')], { encoding: 'utf8' }), path.join(target, 'tool'));
  fs.writeFileSync(path.join(target, 'tool/index.cjs'), 'owned changed bytes'); assert.equal(fs.readFileSync(executable, 'utf8'), 'process.stdout.write(__dirname);\n');
});
for (const absolute of [false, true]) check(`${absolute ? 'absolute' : 'external relative'} dependency link rejects before copy`, () => {
  const file = path.join(deps, '.bin/rejected'); fs.symlinkSync(absolute ? executable : '../../../outside.cjs', file);
  if (!absolute) fs.writeFileSync(path.join(directory, 'outside.cjs'), 'outside');
  const target = path.join(directory, absolute ? 'absolute-copy' : 'external-copy');
  try { assert.throws(() => c.copyPrivateDependencies(deps, target, cloneOptions(path.basename(target)))); assert(!fs.existsSync(target)); } finally { fs.unlinkSync(file); }
});
check('nested dependency copy cannot recursively consume its own output', () => assert.throws(() => c.copyPrivateDependencies(deps, path.join(deps, 'copy'), cloneOptions('nested'))));
// Execute only the actual source-copy and note/index portions of this preparer
// in a new owned directory. Dependency copies, profiles and native launch are
// outside this constituent control; no reimplementation of the copy logic.
const compact=require('./codex-f2-compact-store.cjs'), vm=require('node:vm');
const priorDirectory=path.join(root,'overnight-20261011/native-f2-final-pair-session');
const priorCampaign=compact.readJson(path.join(priorDirectory,'campaign.json'));
const priorAcceptance=compact.readJson(path.join(priorDirectory,'root-continuation-checkpoint.json'));
const priorWorkspace=priorCampaign.workspace;
const seedRoot=path.join(root,'overnight-20261011/f2-workload-preparation'), seed=path.join(seedRoot,'seeded-workspace');
const seedFiles=read(path.join(seedRoot,'evidence/frozen-workspace-manifest.json')).workspaces['seeded-workspace'];
const baseline=path.join(root,'overnight-20261011/f2-adapted-baseline/workspace');
const contractRecord=read(path.join(seedRoot,'contracts/case-contracts.json'));
const initialSourcePaths=[...new Set(c.INITIAL_CASES.map(id=>contractRecord.cases.find(x=>x.id===id).mutation.path))];
const repairs=c.buildRepairs(path.join(seedRoot,'contracts/case-contracts.json'),baseline,seed,priorWorkspace);
const originalPins=Object.entries(priorAcceptance.files.hashes).map(([relative,sha256])=>({path:path.join(priorWorkspace,relative),sha256}));
const preparerText=fs.readFileSync(script,'utf8');
const copyStart=preparerText.indexOf("  const workspace = path.join(directory, 'workspace');");
const copyEnd=preparerText.indexOf('  // Dependencies are private copies',copyStart);
const noteStart=preparerText.indexOf("  fs.mkdirSync(path.join(workspace, '.pb02'));",copyEnd);
const noteEnd=preparerText.indexOf('  const fixture = ',noteStart);
assert(copyStart>0&&copyEnd>copyStart&&noteStart>copyEnd&&noteEnd>noteStart);
const copyFragment=preparerText.slice(copyStart,copyEnd), noteFragment=preparerText.slice(noteStart,noteEnd);
const copyDirectory=path.join(directory,'actual-source-copy');fs.mkdirSync(copyDirectory);
const gitEnv={...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_OPTIONAL_LOCKS:'0'};
const git=(cwd,args)=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd,env:gitEnv,encoding:'utf8',timeout:30000});
let copiedWorkspace;
check('actual preparer source fragments preserve prior12 plus original index without native/profile/dependency actions',()=>{
 copiedWorkspace=vm.runInNewContext(`(()=>{${copyFragment}\n${noteFragment}\nreturn workspace;})()`,{fs,path,assert,c,git,seed,seedFiles,priorCampaign,priorAcceptance,initialSourcePaths,priorWorkspace,seedRoot,directory:copyDirectory});
 assert.equal(c.identity(path.join(copiedWorkspace,'.git/index')).sha256,priorCampaign.fixture.indexSha256);
 for(const [relative,expected] of Object.entries(priorAcceptance.files.hashes))assert.equal(c.identity(c.exactFile(copiedWorkspace,relative)).sha256,expected,relative);
 for(const relative of initialSourcePaths)assert.equal(c.identity(path.join(copiedWorkspace,relative)).sha256,priorAcceptance.files.hashes[relative]);
});
const copiedFixture={workspace:copiedWorkspace,repairs,files:Object.fromEntries(Object.entries(priorAcceptance.files.hashes).map(([relative,sha256])=>[relative,{sha256}])),
 indexSha256:priorCampaign.fixture.indexSha256,commandPolicy:c.buildCommandPolicy(copiedWorkspace),generatedDirectories:priorCampaign.fixture.generatedDirectories.slice(),dependencyCopies:[]};
check('copied baseline starts with no new completed cases and all prior bytes',()=>assert.deepEqual(c.verifySnapshot(copiedFixture).hashes,priorAcceptance.files.hashes));
for(const relative of [c.NOTE,'.git/index'])check(`copied baseline rejects changed ${relative}`,()=>{
 const file=path.join(copiedWorkspace,relative),before=fs.readFileSync(file);fs.appendFileSync(file,'unauthorized');
 try{assert.throws(()=>c.verifySnapshot(copiedFixture));}finally{fs.writeFileSync(file,before);}
});
check('verification rejects a source regression without authorizing another repair',()=>{
 const relative='client/src/models/List.js',file=path.join(copiedWorkspace,relative),before=fs.readFileSync(file);
 fs.copyFileSync(path.join(seed,relative),file);
 try{assert.throws(()=>c.verifySnapshot(copiedFixture));}finally{fs.writeFileSync(file,before);}
});
const completed=[];
check('all twelve applied repairs start and end at their canonical baseline',()=>{
 for(const relative of initialSourcePaths)assert.equal(c.identity(path.join(copiedWorkspace,relative)).sha256,c.identity(path.join(baseline,relative)).sha256);
 assert.equal(c.identity(path.join(copiedWorkspace,'.git/index')).sha256,priorCampaign.fixture.indexSha256);
 assert.deepEqual(repairs,{});assert.deepEqual(c.SELECTED,[]);
});
check('all pinned original checkpoint source/index bytes remain unchanged',()=>{for(const pin of originalPins)assert.equal(c.identity(pin.path).sha256,pin.sha256);});
const provenance=require('./audit-vscode-codex-f2-verification.cjs');
check('actual frozen partial provenance accepts only root checkpoint and preserved independent evidence',()=>{
 const records=provenance.readPriorEvidence();const initialFixture={...copiedFixture,priorWorkspace,priorCheckpoint:provenance.PRIOR_EVIDENCE.checkpoint};
 const result=provenance.auditPriorCheckpointRecord({fixture:initialFixture,priorEvidence:provenance.PRIOR_EVIDENCE,sourceIdentity:records.priorCampaign.sourceIdentity,packageIdentity:records.priorCampaign.packageIdentity},records);
 assert.equal(result.preservedCases.length,12);assert.equal(result.newRepairCases.length,0);
});
check('actual initial source inventory is ten distinct prior source paths',()=>{assert.equal(initialSourcePaths.length,10);assert(initialSourcePaths.includes('client/src/models/List.js'));assert(initialSourcePaths.includes('server/api/helpers/utils/send-webhooks.js'));});
check('source copy omitted prior B07 is detected against frozen checkpoint',()=>{
 const relative='server/api/controllers/users/update.js',file=path.join(copiedWorkspace,relative),before=fs.readFileSync(file);
 fs.copyFileSync(path.join(seed,relative),file);try{assert.throws(()=>c.verifySnapshot(copiedFixture,completed));}finally{fs.writeFileSync(file,before);}
});
check('source copy regressing prior B09 while B10+B11 repaired is rejected',()=>{
 const relative='client/src/models/List.js',file=path.join(copiedWorkspace,relative),before=fs.readFileSync(file);fs.copyFileSync(path.join(seed,relative),file);
 try{assert.throws(()=>c.verifySnapshot(copiedFixture,completed));}finally{fs.writeFileSync(file,before);}
});
check('current preparer validates checkpoint before its first campaign creation',()=>{
 const validation=preparerText.indexOf('provenance.auditPriorCheckpointRecord(priorProjection,priorRecords);');
 const creation=preparerText.indexOf("fs.mkdirSync(directory);");assert(validation>0&&creation>validation);
 assert(preparerText.includes("assert.deepEqual(acceptance.completedCases, [])"));
 assert(preparerText.includes("kind==='checkpoint'?[path.join(evidenceDirectory,kind,'prior-context.json')]:[]"));
});
check('bounded API oracle is qualified and manifest-pinned before campaign creation',()=>{assert(preparerText.indexOf('provenance.auditApiEvidence({apiEvidence:provenance.API_EVIDENCE});')<preparerText.indexOf('fs.mkdirSync(directory);'));assert(preparerText.includes('...Object.values(provenance.API_EVIDENCE)'));provenance.auditApiEvidence({apiEvidence:provenance.API_EVIDENCE});});
const report = { status: checks.every(row=>row.status==='PASS') ? 'PASS_PREPARATION_BOUNDARIES_NO_NATIVE_INFERENCE' : 'FAIL', checkedAt: new Date().toISOString(),
  preparer: c.identity(script), contract: c.identity(require.resolve('./codex-f2-verification-campaign.cjs')), sourceIdentity: c.identity(sourceFile), packageIdentity: c.identity(packageFile), copyFragments: {sourceSha256:c.hash(copyFragment),noteSha256:c.hash(noteFragment)}, checks,
  limitations: ['Only the actual preparer source-copy/note fragments executed in a fresh owned copy; no complete campaign, real profile, application or native provider was launched.', 'The dependency executable is a tiny owned synthetic control. Actual campaign preparation separately verifies all source dependency links before copying them.'] };
const target = path.join(directory, 'checks.json'); fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ path: target, sha256: c.identity(target).sha256, passed: checks.filter(row=>row.status==='PASS').length,total:checks.length,failures:checks.filter(row=>row.status!=='PASS') }));
if(report.status==='FAIL')process.exitCode=1;
