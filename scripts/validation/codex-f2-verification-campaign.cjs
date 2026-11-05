/* Verification-only successor: preserve twelve applied repairs, authorize no source patch. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const base=require('./codex-f2-scoped-campaign.cjs');
const STAGE='F2_VERIFICATION',MAIN_CAP=10,HELPER_CAP=24;
const INITIAL_CASES=Object.freeze(['F2-B01','F2-B03','F2-B09','F2-B12','F2-B02','F2-B04','F2-B05','F2-B06','F2-B07','F2-B08','F2-B10','F2-B11']);
const SELECTED=Object.freeze([]);
const PRIOR_CHECKPOINT_SHA='d8c8e9704d24f6ab2cd05d5453f7d5d3483cd9f2feac2ec51e1556db93862be8';
const root=path.resolve(__dirname,'../../out-test/feature-tests/PB-02');
const PRIOR_ROOT_CHECKPOINT=Object.freeze({path:path.join(root,'overnight-20261011/native-f2-final-pair-session/root-continuation-checkpoint.json'),sha256:PRIOR_CHECKPOINT_SHA});
const CASE_CONTRACT=Object.freeze({path:path.join(root,'overnight-20261011/f2-workload-preparation/contracts/case-contracts.json'),sha256:base.CONTRACT_SHA});
const INDEPENDENT_CHECKPOINT=Object.freeze({path:path.join(root,'overnight-20261011/f2-final-pair-independent-review-CexjLk/verified-twelve-repair-checkpoint.json'),sha256:'dff766359597974a45eb949c2023bd5cc833323ae5da109452ef66852a95b9e4'});
function frozenCases(){assert.deepEqual(base.identity(CASE_CONTRACT.path),CASE_CONTRACT);const contract=JSON.parse(fs.readFileSync(CASE_CONTRACT.path));assert.equal(contract.status,'FROZEN_ACCEPTANCE_CONTRACT');assert.deepEqual(contract.selectedFirstSessionCaseIds,base.SELECTED);const cases=contract.cases.filter(c=>c.kind==='seeded-bug');assert.deepEqual(cases.map(c=>c.id).sort(),[...INITIAL_CASES].sort());return cases;}
function buildRepairs(contractFile,baseline,seeded,priorWorkspace){assert.deepEqual(base.identity(contractFile),CASE_CONTRACT);const cases=frozenCases();for(const dir of [baseline,seeded,priorWorkspace]){assert.equal(fs.realpathSync(dir),dir);assert(fs.lstatSync(dir).isDirectory());}for(const relative of new Set(cases.map(c=>c.mutation.path))){const related=cases.filter(c=>c.mutation.path===relative),original=fs.readFileSync(base.exactFile(baseline,relative),'utf8');for(const c of related)assert.equal(base.hash(original),c.baselineFileSha256);let allSeeded=original;for(const c of related){assert(c.mutation.before.length);assert.equal(allSeeded.split(c.mutation.before).length-1,c.mutation.matches);assert.equal(c.mutation.matches,1);allSeeded=allSeeded.replace(c.mutation.before,c.mutation.after);}assert.equal(base.identity(base.exactFile(seeded,relative)).sha256,base.hash(allSeeded),'Exact original seeded fixture required');assert.equal(base.identity(base.exactFile(priorWorkspace,relative)).sha256,base.hash(original),'Every prior repair must already be applied; verification never repairs source');}return{};}
function checkedRepairs(fixture){assert.deepEqual(fixture.repairs,{},'No source repairs are authorized in verification');for(const c of frozenCases())assert.equal(fixture.files[c.mutation.path]?.sha256,c.baselineFileSha256,'Twelve applied repairs must remain the original source baseline');}
function completed(completedCases){assert.deepEqual(completedCases,[],'No new repair completion ID exists in verification');}
function expectedSnapshotHashes(fixture,completedCases=[]){checkedRepairs(fixture);completed(completedCases);return Object.fromEntries(Object.entries(fixture.files).map(([p,pin])=>[p,pin.sha256]));}
function verifySnapshot(fixture,completedCases=[],panelIds=[]){checkedRepairs(fixture);completed(completedCases);return base.verifySnapshot(fixture,[],panelIds);}
function verifyBoundary(fixture,completedCases=[],panelIds=[]){checkedRepairs(fixture);completed(completedCases);return base.verifyBoundary(fixture,[],panelIds);}
function patchScope(){return false;}
function recordedPatchScope(){return false;}
function assertCommandResult({step,result}){assert.equal(step.expectedNonzero,undefined);assert.equal(result.status,'completed');assert.equal(result.exitCode,0,'All four native verification commands must pass without seeded-lint exception');return'SUCCESS';}
module.exports={...base,...require('./codex-f2-verification-steps.cjs'),STAGE,MAIN_CAP,HELPER_CAP,INITIAL_CASES,SELECTED,PRIOR_CHECKPOINT_SHA,PRIOR_ROOT_CHECKPOINT,CASE_CONTRACT,INDEPENDENT_CHECKPOINT,frozenCases,buildRepairs,checkedRepairs,expectedSnapshotHashes,verifySnapshot,verifyBoundary,patchScope,recordedPatchScope,assertCommandResult};
