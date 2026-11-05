/* F05 source/evidence contract only. Native preparation requires an explicit future binding. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const base=require('./codex-f2-scoped-campaign.cjs');
const repo=path.resolve(__dirname,'../..'),pb02=path.join(repo,'out-test/feature-tests/PB-02');
const STAGE='F2_SIGNED_WEBHOOKS',MAIN_CAP=10,HELPER_CAP=24,FEATURE_ID='F2-F05';
const INITIAL_CASES=Object.freeze(['F2-B01','F2-B03','F2-B09','F2-B12','F2-B02','F2-B04','F2-B05','F2-B06','F2-B07','F2-B08','F2-B10','F2-B11']);
// These are approval/completion purposes, never two bug repairs or two feature credits.
const SELECTED=Object.freeze(['F2-F05_HELPER','F2-F05_DOCS']),PATCH_IDS=SELECTED;
const PRIOR_NATIVE_CHECKPOINT=null;
const PRIOR_PROFILE=Object.freeze({stage:'F2_VERIFICATION',turns:6,segmentReplies:Object.freeze([3,3]),contract:Object.freeze({path:path.join(__dirname,'codex-f2-verification-campaign.cjs'),sha256:'dc2f3eab2868864e4596722bb50d2236ba848a6d5dfc0c63a572d5ca735c9ae5'}),steps:Object.freeze({path:path.join(__dirname,'codex-f2-verification-steps.cjs'),sha256:'d8723998e70d8c9c8f4f9bc5522c3403dee45bdc086639db967786c774784069'})});
const CASE_CONTRACT=Object.freeze({path:path.join(pb02,'overnight-20261011/f2-workload-preparation/contracts/case-contracts.json'),sha256:base.CONTRACT_SHA});
const PLAN=Object.freeze({path:path.join(pb02,'f05-native-plan-draft-4aVKlo/plan.json'),sha256:'ccaa6df70d4db3ea64a06c85214b8348e3fff310adba3a2f9877b1612c078ef8'});
const QUALIFICATION=Object.freeze({path:path.join(pb02,'overnight-20261011/f05-signed-webhook-validation/qualification-review.json'),sha256:'38edadb8f58bdf02c5485d782ce1487d207dadfa89aa07ae235bfcc1d0ca56ed'});
const PATCHES=Object.freeze([
 Object.freeze({id:SELECTED[0],path:'server/api/helpers/utils/send-webhooks.js',beforeSha256:'2305c06cedc9ccc51ee0badedf77ee3aae6a2f6df6bba623061474645a83d846',afterSha256:'55e65439577e7625991f939c050e82895073878a6f459e863e7a4655a7399a19'}),
 Object.freeze({id:SELECTED[1],path:'server/.env.sample',beforeSha256:'f7933a0da88be88596d8b92fab43ba8aed4b6d638dc534f0dff6c6b76385e15d',afterSha256:'92fdacc0602cf73dc75d56236844b48eed57520a69c3b1b635512884e0920c27'}),
]);
const compact=require('./codex-f2-compact-store.cjs');
function pinned(pin){assert(pin&&typeof pin.path==='string'&&/^[a-f0-9]{64}$/.test(pin.sha256));base.contained(pb02,pin.path);assert.equal(fs.realpathSync(pin.path),pin.path);const s=fs.lstatSync(pin.path);assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid());assert.deepEqual(base.identity(pin.path),pin);return compact.readJson(pin.path);}
function candidateProvenance(){const plan=pinned(PLAN),qualification=pinned(QUALIFICATION);assert.deepEqual(plan.qualification,QUALIFICATION);assert.equal(plan.status,'DRAFT_F05_NATIVE_PLAN_NOT_EXECUTED');assert.equal(qualification.status,'PASS_F05_LOCAL_APPLICATION_ORACLE_QUALIFICATION');assert.equal(plan.candidate.formatting.astWithoutPositionsEqual,true);for(const [i,p]of PATCHES.entries()){const row=plan.candidate.changes[i];assert.equal(row.path,p.path);assert.equal(row.requiredFutureBeforeSha256,p.beforeSha256);assert.equal(row.draftAfter.sha256,p.afterSha256);assert.equal(base.identity(base.exactFile(path.join(path.dirname(PLAN.path),'candidate'),p.path)).sha256,p.afterSha256);assert.equal(base.identity(row.qualifiedArchivedAfter.path).sha256,row.qualifiedArchivedAfter.sha256);}return{plan,qualification};}
function buildRepairs(contractFile,baseline,seeded,priorWorkspace){
 assert.equal(base.identity(contractFile).sha256,base.CONTRACT_SHA);const contract=JSON.parse(fs.readFileSync(contractFile));assert.equal(contract.status,'FROZEN_ACCEPTANCE_CONTRACT');assert.deepEqual(contract.selectedFirstSessionCaseIds,base.SELECTED);
 const cases=contract.cases.filter(c=>c.kind==='seeded-bug');assert.deepEqual(cases.map(c=>c.id).sort(),[...INITIAL_CASES].sort());
 const feature=contract.cases.find(c=>c.id===FEATURE_ID);assert.equal(feature.kind,'feature-request');assert.deepEqual(feature.expectedChangedFiles,PATCHES.map(p=>p.path));
 for(const dir of [baseline,seeded,priorWorkspace]){assert.equal(fs.realpathSync(dir),dir);assert(fs.lstatSync(dir).isDirectory());}
 for(const relative of new Set(cases.map(c=>c.mutation.path))){const related=cases.filter(c=>c.mutation.path===relative),original=fs.readFileSync(base.exactFile(baseline,relative),'utf8');for(const item of related)assert.equal(base.hash(original),item.baselineFileSha256);let allSeeded=original;for(const item of related){assert.equal(allSeeded.split(item.mutation.before).length-1,item.mutation.matches);allSeeded=allSeeded.replace(item.mutation.before,item.mutation.after);}assert.equal(base.identity(base.exactFile(seeded,relative)).sha256,base.hash(allSeeded));assert.equal(base.identity(base.exactFile(priorWorkspace,relative)).sha256,base.hash(original),'Every existing bug repair must be present before F05');}
 candidateProvenance();
 return Object.fromEntries(PATCHES.map((pin,index)=>{const before=fs.readFileSync(base.exactFile(priorWorkspace,pin.path),'utf8'),after=fs.readFileSync(base.exactFile(path.join(path.dirname(PLAN.path),'candidate'),pin.path),'utf8');assert.equal(base.hash(before),pin.beforeSha256);assert.equal(base.identity(base.exactFile(baseline,pin.path)).sha256,pin.beforeSha256);assert.equal(base.hash(after),pin.afterSha256);return[pin.id,{path:pin.path,before,beforeSha256:pin.beforeSha256,after,afterSha256:pin.afterSha256,initialSha256:pin.beforeSha256,requiredCases:SELECTED.slice(0,index),preservedInitialCases:cases.filter(c=>c.mutation.path===pin.path).map(c=>c.id),preservedOtherSeeds:[],featureId:FEATURE_ID,completionKind:'INTERNAL_PATCH_ONLY'}];}));
}
function checkedRepairs(fixture){assert.deepEqual(Object.keys(fixture.repairs).sort(),[...SELECTED].sort());for(const [index,pin]of PATCHES.entries()){const r=fixture.repairs[pin.id];assert.equal(r.path,pin.path);for(const k of ['beforeSha256','afterSha256'])assert.equal(r[k],pin[k]);assert.equal(base.hash(r.before),pin.beforeSha256);assert.equal(base.hash(r.after),pin.afterSha256);assert.equal(r.initialSha256,pin.beforeSha256);assert.equal(fixture.files[pin.path]?.sha256,pin.beforeSha256);assert.deepEqual(r.requiredCases,SELECTED.slice(0,index));assert.equal(r.featureId,FEATURE_ID);assert.equal(r.completionKind,'INTERNAL_PATCH_ONLY');}}
function projectedFixture(fixture, completedCases) {
  checkedRepairs(fixture);
  assert(Array.isArray(completedCases)); assert.equal(new Set(completedCases).size, completedCases.length);
  assert(completedCases.every(id => SELECTED.includes(id)), 'Only internal F05 patch IDs may complete');
  assert.deepEqual(completedCases, SELECTED.slice(0, completedCases.length), 'Exact F05 internal patch prefix required');
  const files = { ...fixture.files };
  for (const id of completedCases) {
    const repair = fixture.repairs[id];
    assert(repair.requiredCases.every(prior => completedCases.includes(prior)), `Missing preceding F05 patch: ${id}`);
    // Later repairs replace earlier expected bytes for the same path.
    files[repair.path] = { ...files[repair.path], sha256: repair.afterSha256 };
  }
  return { ...fixture, files };
}
function expectedSnapshotHashes(fixture, completedCases = []) {
  return Object.fromEntries(Object.entries(projectedFixture(fixture, completedCases).files).map(([relative, pin]) => [relative, pin.sha256]));
}
function verifySnapshot(fixture, completedCases = [], panelIds = []) {
  const projected = projectedFixture(fixture, completedCases);
  const snapshot = base.verifySnapshot(projected, [], panelIds);
  snapshot.completedCases = completedCases.slice();
  return snapshot;
}
function verifyBoundary(fixture, completedCases = [], panelIds = []) {
  const projected = projectedFixture(fixture, completedCases);
  // Preserve the scoped dependency, npm HTTP, cache, source-map, generated
  // asset, application-log and temporary-directory checks exactly.
  const snapshot = base.verifyBoundary(projected, [], panelIds);
  snapshot.files.completedCases = completedCases.slice();
  return snapshot;
}
function recordedPatchScope(changes, fixture, purpose) {
  try {
    checkedRepairs(fixture);
    assert(SELECTED.includes(purpose)); const repair = fixture.repairs[purpose];
    assert(repair); const file = base.exactFile(fixture.workspace, repair.path);
    assert.equal(fs.lstatSync(file).nlink, 1, 'No source patch through a hard link');
    // Historical receipt replay uses frozen before/after bytes. Current source
    // may include a later approved repair to the same path; the auditor must
    // separately join its retained before/after snapshots and final boundary.
    return base.patchScope(changes, fixture, purpose);
  } catch { return false; }
}
function patchScope(changes, fixture, purpose) {
  try {
    assert(SELECTED.includes(purpose)); const repair = fixture.repairs[purpose];
    assert(repair); const file = base.exactFile(fixture.workspace, repair.path);
    for (const prior of repair.requiredCases) assert.equal(base.identity(base.exactFile(fixture.workspace, fixture.repairs[prior].path)).sha256, fixture.repairs[prior].afterSha256, 'Earlier F05 patch must be applied');
    const actual = base.identity(file).sha256;
    assert([repair.beforeSha256, repair.afterSha256].includes(actual), 'Repair is scoped to its actual cumulative source state');
    return recordedPatchScope(changes, fixture, purpose);
  } catch { return false; }
}

function assertLintBoundary(before,after){base.assertBoundary(before);base.assertBoundary(after);const source=s=>({...s.files,productFiles:s.files.productFiles.map(p=>({relative:p.relative,path:p.path}))});assert.deepEqual(source(after),source(before),'Source/index/build links and exact allowed product paths preserved');for(const key of ['dependencySnapshots','buildSnapshot','applicationTemporarySnapshot'])assert.deepEqual(after[key],before[key],'Server lint preserves '+key);return 'PASS_SERVER_LINT_BOUNDARY';}
function assertCommandResult({step,result}){assert.equal(step.expectedNonzero,undefined);assert.equal(result.status,'completed');assert.equal(result.exitCode,0);return'SUCCESS';}
function bugSourcePaths(){return [...new Set(pinned(CASE_CONTRACT).cases.filter(c=>c.kind==='seeded-bug').map(c=>c.mutation.path))].sort();}
function assertAllBugResults(report,workspace){assert.equal(report.status,'VERIFIED_EXPECTED_CASE_RESULTS');assert.equal(report.workspace,workspace);assert.deepEqual(report.completedCaseIds,INITIAL_CASES);assert.deepEqual(report.remainingSeededCaseIds,[]);assert.deepEqual(report.cases.map(c=>c.id).sort(),[...INITIAL_CASES].sort());assert(report.cases.every(c=>c.status==='PASS'));assert.equal(report.commands.length,2);assert(report.commands.every(c=>c.exitCode===0));assert.deepEqual(Object.keys(report.sourceHashes).sort(),bugSourcePaths());for(const sha of Object.values(report.sourceHashes))assert(/^[a-f0-9]{64}$/.test(sha));}
// The caller supplies this identity from root's independently frozen review, never from the candidate itself.
function assertNativePreparationReady(bindingIdentity=PRIOR_NATIVE_CHECKPOINT){
 assert(bindingIdentity,'Actual accepted twelve-repair native checkpoint binding is unresolved');for(const pin of [PRIOR_PROFILE.contract,PRIOR_PROFILE.steps])assert.deepEqual(base.identity(pin.path),pin);const binding=pinned(bindingIdentity);
 assert.equal(binding.schemaVersion,1);assert.equal(binding.case,'PB-02');assert.equal(binding.stage,'F2_VERIFICATION');assert.equal(binding.status,'VERIFIED_TWELVE_REPAIR_NATIVE_CHECKPOINT');assert.deepEqual(binding.completedCases,INITIAL_CASES);
 const campaign=pinned(binding.campaign),audit=pinned(binding.mechanicalAudit),oracle=pinned(binding.finalOracleReview);
 assert.equal(campaign.stage,'F2_VERIFICATION');assert.equal(campaign.workspace,binding.workspace);assert.equal(campaign.fixture.workspace,binding.workspace);
 assert.equal(binding.segmentAcceptances.length,2);assert.equal(binding.editorExits.length,2);
 const accepts=binding.segmentAcceptances.map(pinned);for(const [i,a]of accepts.entries()){assert.equal(a.status,'CAPTURED_F2_SEGMENT');assert.equal(a.stage,'F2_VERIFICATION');assert.equal(a.segment,i+1);assert.equal(a.replies.length,3);assert.deepEqual(a.completedCases,[]);}
 for(const exit of binding.editorExits.map(pinned)){assert.equal(exit.code,0);assert.equal(exit.cleanup.status,'PASS_OBSERVED_IDENTITIES_EXITED');}
 assert.equal(audit.stage,'F2_VERIFICATION');assert.equal(audit.status,'PARTIAL_F2_VERIFICATION_EVIDENCE');assert.equal(audit.mechanical,'PASS_MECHANICAL_6');assert.deepEqual(audit.campaign,binding.campaign);for(const k of ['publicAttempts','completedReplies','mainInputs'])assert.equal(audit.counts[k],6);
 for(const key of ['editorExited','historyRestored','priorMessagesPreserved'])assert.equal(audit.restart[key],true);
 assert.deepEqual(binding.sourceSnapshot,accepts[1].files);assert.deepEqual(audit.workspace,binding.sourceSnapshot);
 const prior=require('./codex-f2-verification-campaign.cjs');assert.deepEqual(prior.verifySnapshot(campaign.fixture,prior.SELECTED,accepts[1].panelIds),binding.sourceSnapshot);
 assertAllBugResults(oracle,binding.workspace);for(const [relative,sha]of Object.entries(oracle.sourceHashes))assert.equal(binding.sourceSnapshot.hashes[relative],sha);
 for(const p of PATCHES)assert.equal(binding.sourceSnapshot.hashes[p.path],p.beforeSha256,'F05 must still be absent from accepted native baseline');
 return{status:'ACCEPTED_EXPLICIT_PRIOR_BINDING',identity:bindingIdentity,workspace:binding.workspace,files:binding.sourceSnapshot,completedBugCases:[...INITIAL_CASES],source:'ROOT_SUPPLIED_PINNED_NATIVE_CHECKPOINT',sessionCredit:'No full S/W/E/P credit inferred from twelve repaired bugs'};
}
function assertFeatureAbsentEvidence({fixture,feature,bugRegressions}) {
 checkedRepairs(fixture);const {qualification}=candidateProvenance(),pins=qualification.implementationPins.slice(0,8);
 assert.deepEqual(feature.sourceIdentities,pins.slice().sort((a,b)=>a.path.localeCompare(b.path)));for(const pin of pins)assert.deepEqual(base.identity(pin.path),pin);
 assert.equal(feature.status,'FAIL');assert.equal(feature.caseId,FEATURE_ID);assert.equal(feature.workspace,fixture.workspace);assert.deepEqual(feature.contract,CASE_CONTRACT);
 assert.equal(feature.failures.length,2);const [first,final]=feature.failures;
 assert.equal(first.phase,'create-authentication');assert.equal(first.errorType,'ASSERTION_FAILURE');assert(first.message.startsWith('Observed exact-body HMAC\n'));assert(first.message.includes('+ undefined'));
 assert.equal(final.phase,'final-receipt-log-verification');assert.equal(final.errorType,'ASSERTION_FAILURE');assert.equal(final.message,'Both create and update phases completed');
 assert.deepEqual(feature.phaseChecks,[]);assert.equal(feature.finalChecks,undefined);assert.deepEqual(feature.receiverErrors,[]);assert.deepEqual(feature.initialization,{code:0,signal:null});
 assert.deepEqual(feature.process.exit,{code:0,signal:null});assert.equal(feature.process.cleanup.status,'TERMINAL_OBSERVED');assert.deepEqual(feature.process.cleanup.exit,feature.process.exit);assert.equal(feature.process.cleanup.observedExitEvent,true);
 assert.equal(feature.receiver.cleanup.status,'DRAINED');assert.equal(feature.receiver.cleanup.forcedConnections,false);assert.equal(feature.receiver.closedAt,feature.receiver.observationEndedAt);assert(feature.receiver.closedAt>=feature.process.exitedAt);
 const scope=pinned(feature.scope),expected=expectedSnapshotHashes(fixture,[]);assert.equal(scope.schemaVersion,1);assert.equal(scope.workspace,fixture.workspace);assert.equal(scope.runtime,feature.runtime);assert.equal(scope.purpose,'PB02_F05_SOURCE_RUNTIME_SCOPE');
 for(const [relative,sha256]of Object.entries(expected))assert.deepEqual(scope.source.files[relative],{kind:'file',sha256});
 for(const boundary of [feature.sourceBoundaryBefore,feature.sourceBoundaryAfter]){assert.equal(boundary.sourceSha256,base.hash(JSON.stringify(scope.source)));assert.equal(boundary.sourceFiles,Object.keys(scope.source.files).length);assert.equal(boundary.indexSha256,fixture.indexSha256);assert.equal(boundary.documentationSha256,PATCHES[1].beforeSha256);assert.deepEqual(boundary.panelIds,scope.panelIds);assert.equal(boundary.dependencyFiles,scope.dependencyTrees.reduce((n,r)=>n+r.files,0));}
 const receipt=require(pins.find(p=>p.path.endsWith('/f05-receipts.cjs')).path);assert.equal(feature.events.length,4);assert.deepEqual(feature.events.map(e=>e.route).sort(),[...receipt.routes].sort());
 for(const e of feature.events){receipt.decode(e);assert.equal(e.body.event,'cardCreate');assert.deepEqual({id:e.body.data.item.id,name:e.body.data.item.name,description:e.body.data.item.description},{id:feature.fixture.id,...feature.fixture.created});assert.equal(e.headers['x-planka-signature'],undefined);if(e.route==='/signed-allowed')assert.equal(e.headers.authorization,'Bearer '+receipt.bearer);assert(e.at>=feature.receiver.startedAt&&e.at<=feature.receiver.closedAt);}
 assert.throws(()=>receipt.verifyPhase(feature.events,feature.fixture,'cardCreate'),/Observed exact-body HMAC/);
 assert.deepEqual(feature.createdRow,{id:feature.fixture.id,...feature.fixture.created});assert.equal(feature.updatedRow,undefined);assert.equal(feature.apiReceipts.length,5);assert(feature.apiReceipts.every(r=>r.status===200));const created=feature.apiReceipts[4];assert.equal(created.method,'POST');assert.equal(created.url,`/api/lists/${feature.fixture.listId}/cards`);assert.deepEqual(created.item,feature.createdRow);
 assertAllBugResults(bugRegressions,fixture.workspace);for(const [relative,sha]of Object.entries(bugRegressions.sourceHashes))assert.equal(expected[relative],sha);
 return{status:'F05_ABSENCE_EVIDENCE_MATCHED',featureIds:[],preservedBugIds:[...INITIAL_CASES],nativeCausalJoinsRequired:true,limitation:'Expected missing-HMAC failure on actual create receipts, not a feature pass. Independent root command/result/source joins remain required.'};
}
function assertFeatureEvidence({fixture,completedPatchIds,feature,bugRegressions,lintStep,lintResult}){
 assert.deepEqual(completedPatchIds,SELECTED);checkedRepairs(fixture);const {qualification}=candidateProvenance();
 const oraclePins=qualification.implementationPins.slice(0,8);assert.equal(oraclePins.length,8);assert.deepEqual(feature.sourceIdentities,oraclePins.slice().sort((a,b)=>a.path.localeCompare(b.path)));
 for(const pin of oraclePins)assert.equal(base.identity(pin.path).sha256,pin.sha256);
 assert.equal(feature.status,'PASS_F05_SIGNED_WEBHOOKS');assert.equal(feature.caseId,FEATURE_ID);assert.equal(feature.workspace,fixture.workspace);assert.deepEqual(feature.failures,[]);assert.deepEqual(feature.receiverErrors,[]);assert.deepEqual(feature.process.exit,{code:0,signal:null});assert.equal(feature.process.cleanup.status,'TERMINAL_OBSERVED');assert.equal(feature.receiver.cleanup.status,'DRAINED');
 const scope=pinned(feature.scope);assert.equal(scope.workspace,fixture.workspace);assert.equal(scope.runtime,feature.runtime);assert.equal(scope.purpose,'PB02_F05_SOURCE_RUNTIME_SCOPE');assert.equal(scope.schemaVersion,1);assert.equal(feature.contract.sha256,base.CONTRACT_SHA);assert.equal(feature.contract.path,CASE_CONTRACT.path);for(const boundary of [feature.sourceBoundaryBefore,feature.sourceBoundaryAfter]){assert.equal(boundary.sourceSha256,base.hash(JSON.stringify(scope.source)));assert.equal(boundary.sourceFiles,Object.keys(scope.source.files).length);assert.equal(boundary.indexSha256,fixture.indexSha256);assert.equal(boundary.documentationSha256,PATCHES[1].afterSha256);assert.deepEqual(boundary.panelIds,scope.panelIds);assert.equal(boundary.dependencyFiles,scope.dependencyTrees.reduce((n,r)=>n+r.files,0));}
 const expected=expectedSnapshotHashes(fixture,SELECTED);for(const [relative,sha256]of Object.entries(expected))assert.deepEqual(scope.source.files[relative],{kind:'file',sha256},'Captured F05 scope joins exact candidate and preserved files');
 assert.equal(feature.sourceBoundaryAfter.documentationSha256,PATCHES[1].afterSha256);assert.deepEqual(feature.initialization,{code:0,signal:null});assert.equal(feature.process.cleanup.observedExitEvent,true);assert.deepEqual(feature.process.cleanup.exit,feature.process.exit);assert.equal(feature.receiver.cleanup.forcedConnections,false);assert.equal(feature.process.exitedAt,feature.observationWindow.appExitedAt);assert.equal(feature.updateStartedAt,feature.observationWindow.updateStartedAt);assert.equal(feature.receiver.closedAt,feature.observationWindow.endedAt);assert(feature.events.every(e=>e.at>=feature.observationWindow.startedAt&&e.at<=feature.observationWindow.endedAt));
 assert.deepEqual(feature.createdRow,{id:feature.fixture.id,...feature.fixture.created});assert.deepEqual(feature.updatedRow,{id:feature.fixture.id,...feature.fixture.updated});const api=feature.apiReceipts;assert.equal(api.length,6);assert(api.every(r=>r.status===200&&r.completedAt>=r.startedAt&&/^[a-f0-9]{64}$/.test(r.responseSha256)));assert.equal(api[4].method,'POST');assert.equal(api[4].url,`/api/lists/${feature.fixture.listId}/cards`);assert.deepEqual(api[4].item,feature.createdRow);assert.equal(api[5].method,'PATCH');assert.equal(api[5].url,`/api/cards/${feature.fixture.id}`);assert.deepEqual(api[5].item,feature.updatedRow);
 const receiptPin=oraclePins.find(p=>p.path.endsWith('/f05-receipts.cjs')),receipt=require(receiptPin.path);assert.equal(feature.events.length,6);
 const phases=['cardCreate','cardUpdate'].map(event=>receipt.verifyPhase(feature.events,feature.fixture,event));assert.deepEqual(feature.phaseChecks,phases);assert.deepEqual(feature.finalChecks.phases,phases);assert.equal(feature.finalChecks.status,'PASS_F05_EXACT_CREATE_UPDATE_RECEIPTS');
 assert.equal(feature.finalChecks.checkedLogs.length,3);const logNames=feature.finalChecks.checkedLogs.map(p=>path.basename(p.path)).sort();assert.deepEqual(logNames,['application.log','migrations.log','server.log']);
 const logs=feature.finalChecks.checkedLogs.map(p=>{base.contained(feature.artifact,p.path);const bytes=fs.readFileSync(base.exactFile(feature.artifact,path.relative(feature.artifact,p.path)));assert.equal(bytes.length,p.bytes);assert.equal(base.hash(bytes),p.sha256);return{path:p.path,bytes};});assert.deepEqual(receipt.verifyFinal(feature.events,feature.fixture,logs),feature.finalChecks);
 assert(feature.observationWindow.endedAt>=feature.observationWindow.appExitedAt&&feature.observationWindow.appExitedAt>=feature.observationWindow.updateStartedAt);assert.equal(feature.observationWindow.endedAt,feature.receiver.observationEndedAt);
 assertAllBugResults(bugRegressions,fixture.workspace);for(const [relative,sha256]of Object.entries(bugRegressions.sourceHashes))assert.equal(expected[relative],sha256);
 const steps=require('./codex-f2-signed-webhook-steps.cjs'),expectedLint=steps.buildSteps(fixture.workspace)[steps.LINT_ORDINAL-1];assert.deepEqual(lintStep,expectedLint);assertCommandResult({step:lintStep,result:lintResult});
 return{status:'F05_FUNCTIONAL_EVIDENCE_MATCHED',featureIds:[FEATURE_ID],internalPatchIds:[...SELECTED],preservedBugIds:[...INITIAL_CASES],nativeCausalJoinsRequired:true,limits:'One feature, not two repairs. Future independent auditor must join actual native approvals/results, root gate pins, lint boundaries and prior binding before native acceptance.'};
}
module.exports={...base,...require('./codex-f2-signed-webhook-steps.cjs'),STAGE,MAIN_CAP,HELPER_CAP,FEATURE_ID,INITIAL_CASES,INITIAL_BUG_CASES:INITIAL_CASES,SELECTED,PATCH_IDS,PATCHES,PLAN,QUALIFICATION,CASE_CONTRACT,PRIOR_PROFILE,PRIOR_NATIVE_CHECKPOINT,candidateProvenance,buildRepairs,checkedRepairs,expectedSnapshotHashes,verifySnapshot,verifyBoundary,recordedPatchScope,patchScope,assertLintBoundary,assertCommandResult,assertAllBugResults,assertNativePreparationReady,assertFeatureAbsentEvidence,assertFeatureEvidence};
