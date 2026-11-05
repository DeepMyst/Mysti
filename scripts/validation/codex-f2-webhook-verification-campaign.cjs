/* Read-only successor of the actual, partially verified native F05 patch run. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const base = require('./codex-f2-scoped-campaign.cjs');
const signed = require('./codex-f2-signed-webhook-campaign.cjs');
const compact = require('./codex-f2-compact-store.cjs');
const steps = require('./codex-f2-webhook-verification-steps.cjs');
const root = path.resolve(__dirname, '../../out-test/feature-tests/PB-02');
const overnight = path.join(root, 'overnight-20261011');
const STAGE = 'F2_WEBHOOK_VERIFICATION', MAIN_CAP = 10, HELPER_CAP = 24;
const SELECTED = Object.freeze([]), PATCH_IDS = SELECTED;
const HISTORICAL_PATCH_IDS = signed.SELECTED, INITIAL_CASES = signed.INITIAL_CASES;
const { FEATURE_ID, PATCHES, CASE_CONTRACT, PLAN, QUALIFICATION } = signed;
const saved = (relative, sha256) => Object.freeze({ path: path.join(overnight, relative), sha256 });
const PRIOR_NATIVE_CHECKPOINT = saved('native-f2-signed-webhook-ready-session/root-continuation-checkpoint.json', 'f42cdb5ca077fecbfade1a33c34b7f5fafd67dc8d9d841e6c2c6f850f0597736');
const PRIOR_REVIEW = saved('f2-signed-webhook-ready-validation/partial-native-root-review.json', '677355e07f2051bd6d9299fe610c748120f503d0be354569258a58dc40b3fef0');
const PRIOR_CLEANUP = saved('f2-signed-webhook-ready-runtime-cleanup-review.json', '74b7d7c36553cd29104e7050b21dce65ae2f7a7cfba6eb4c3688fe76563867c7');
const PRIOR_PRESERVATION = saved('native-preservation-after-signed-webhook-ready-session-review.json', '1c33c03abab91bbfd565f0679b6e4c26f1f31419c03cad53d3cb9dc0300b9a6b');
const BOUNDED_QUALIFICATION = saved('f05-bounded-invocation-validation/qualification-review.json', '444f9794035d02ade98496c4e21910aab7364260bb4726c5033c96fe148a90cb');
function pinned(pin) {
  assert(pin && typeof pin.path === 'string' && /^[a-f0-9]{64}$/.test(pin.sha256));
  base.contained(root, pin.path); assert.equal(fs.realpathSync(pin.path), pin.path);
  const stat = fs.lstatSync(pin.path); assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid());
  assert.deepEqual(base.identity(pin.path), pin); return compact.readJson(pin.path);
}
function frozenCases() {
  const contract = pinned(CASE_CONTRACT); assert.equal(contract.status, 'FROZEN_ACCEPTANCE_CONTRACT');
  assert.deepEqual(contract.selectedFirstSessionCaseIds, base.SELECTED);
  const cases = contract.cases.filter(row => row.kind === 'seeded-bug');
  assert.deepEqual(cases.map(row => row.id).sort(), [...INITIAL_CASES].sort()); return cases;
}
function expectedSource(relative, original) { return PATCHES.find(row => row.path === relative)?.afterSha256 || original; }
function buildRepairs(contractFile, baseline, seeded, priorWorkspace) {
  assert.deepEqual(base.identity(contractFile), CASE_CONTRACT); const cases = frozenCases();
  for (const dir of [baseline, seeded, priorWorkspace]) { assert.equal(fs.realpathSync(dir), dir); assert(fs.lstatSync(dir).isDirectory()); }
  for (const relative of new Set(cases.map(row => row.mutation.path))) {
    const related = cases.filter(row => row.mutation.path === relative), original = fs.readFileSync(base.exactFile(baseline, relative), 'utf8');
    for (const row of related) assert.equal(base.hash(original), row.baselineFileSha256);
    let mutated = original;
    for (const row of related) { assert(row.mutation.before.length); assert.equal(row.mutation.matches, 1); assert.equal(mutated.split(row.mutation.before).length - 1, 1); mutated = mutated.replace(row.mutation.before, row.mutation.after); }
    assert.equal(base.identity(base.exactFile(seeded, relative)).sha256, base.hash(mutated), 'Frozen original seeded fixture');
    assert.equal(base.identity(base.exactFile(priorWorkspace, relative)).sha256, expectedSource(relative, base.hash(original)), 'All bug repairs and the historical F05 helper must already be present');
  }
  for (const patch of PATCHES) {
    assert.equal(base.identity(base.exactFile(baseline, patch.path)).sha256, patch.beforeSha256);
    assert.equal(base.identity(base.exactFile(priorWorkspace, patch.path)).sha256, patch.afterSha256, 'Copy actual native-approved F05 bytes; never apply a candidate during verification');
  }
  signed.candidateProvenance(); return {};
}
function checkedRepairs(fixture) {
  assert.deepEqual(fixture.repairs, {}, 'No source repairs are authorized');
  for (const row of frozenCases()) assert.equal(fixture.files[row.mutation.path]?.sha256, expectedSource(row.mutation.path, row.baselineFileSha256));
  for (const patch of PATCHES) assert.equal(fixture.files[patch.path]?.sha256, patch.afterSha256);
}
function completed(ids) { assert.deepEqual(ids, [], 'Historical patch IDs are not new native completions'); }
function expectedSnapshotHashes(fixture, ids = []) { checkedRepairs(fixture); completed(ids); return Object.fromEntries(Object.entries(fixture.files).map(([relative, pin]) => [relative, pin.sha256])); }
function verifySnapshot(fixture, ids = [], panels = []) { checkedRepairs(fixture); completed(ids); return base.verifySnapshot(fixture, [], panels); }
function verifyBoundary(fixture, ids = [], panels = []) { checkedRepairs(fixture); completed(ids); return base.verifyBoundary(fixture, [], panels); }
function patchScope() { return false; }
function recordedPatchScope() { return false; }
function assertNativePreparationReady(bindingIdentity = PRIOR_NATIVE_CHECKPOINT) {
  assert.deepEqual(bindingIdentity, PRIOR_NATIVE_CHECKPOINT, 'Bind only the reviewed actual native23 patch checkpoint');
  const binding = pinned(bindingIdentity), review = pinned(PRIOR_REVIEW), cleanup = pinned(PRIOR_CLEANUP), preservation = pinned(PRIOR_PRESERVATION);
  assert.equal(binding.schemaVersion, 1); assert.equal(binding.case, 'PB-02'); assert.equal(binding.stage, 'F2_SIGNED_WEBHOOKS');
  assert.equal(binding.status, 'PARTIAL_SIGNED_WEBHOOK_PATCH_CHECKPOINT_WITH_TIMED_OUT_ORACLE');
  assert.deepEqual(binding.rootReview, PRIOR_REVIEW); assert.deepEqual(binding.completedCases, INITIAL_CASES);
  assert.deepEqual(binding.implementedPatchIds, HISTORICAL_PATCH_IDS); assert.deepEqual(binding.completedFeatures, []);
  assert.deepEqual(binding.pendingFeatures, ['F2-F01', 'F2-F02', 'F2-F03', 'F2-F04', 'F2-F05', 'F2-F06']);
  assert.equal(binding.acceptedReplies, 3); assert.equal(binding.actualMainInputs, 3);
  const prior = signed.assertNativePreparationReady(binding.priorCheckpoint);
  const campaign = pinned(binding.campaign), acceptance = pinned(binding.segmentAcceptance), failed = pinned(binding.failedSegment);
  assert.equal(campaign.stage, 'F2_SIGNED_WEBHOOKS'); assert.equal(campaign.workspace, binding.workspace);
  assert.deepEqual(campaign.priorBinding, binding.priorCheckpoint); assert.deepEqual(campaign.sourceIdentity, binding.sourceIdentity); assert.deepEqual(campaign.packageIdentity, binding.packageIdentity);
  assert.equal(acceptance.status, 'CAPTURED_F2_SEGMENT'); assert.equal(acceptance.segment, 1); assert.equal(acceptance.stage, campaign.stage);
  assert.deepEqual(acceptance.replies.map(row => row.ordinal), [1, 2, 3]); assert.deepEqual(acceptance.completedCases, HISTORICAL_PATCH_IDS);
  assert.deepEqual(failed.replies, []); assert.deepEqual(failed.completedCases, HISTORICAL_PATCH_IDS);
  assert.equal(review.status, 'PARTIAL_NATIVE_SIGNED_WEBHOOK_PATCHES_WITH_ORACLE_TIMEOUT'); assert.deepEqual(review.campaign, binding.campaign);
  assert.equal(review.acceptedReplies, 3); assert.equal(review.actualMainInputs, 3); assert.equal(review.durableMessages, 6); assert.equal(review.segment2Inputs, 0);
  assert.deepEqual(review.implementedPatchIds, HISTORICAL_PATCH_IDS); assert.deepEqual(review.acceptedFeatures, []);
  for (const [i, turn] of review.turns.entries()) { assert.equal(turn.ordinal, i + 1); pinned(turn.reply); }
  assert.equal(review.turns.length, 3);
  const audit = pinned(binding.mechanicalAudit), invocation = pinned(binding.oracleInvocation);
  assert.equal(audit.status, 'FAIL'); assert.match(audit.error.message, /segment-2\/window-A\/acceptance\.json/);
  assert.equal(invocation.error.code, 'ETIMEDOUT'); assert.equal(invocation.exitCode, 0); assert.equal(invocation.signal, null);
  assert.equal(binding.editorExits.length, 2);
  for (const pin of binding.editorExits) { const exit = pinned(pin); assert.equal(exit.code, 0); assert.equal(exit.cleanup.status, 'PASS_OBSERVED_IDENTITIES_EXITED'); }
  const snapshot = signed.verifySnapshot(campaign.fixture, HISTORICAL_PATCH_IDS, binding.panelIds);
  assert.deepEqual(snapshot, binding.sourceSnapshot); assert.deepEqual(pinned(binding.finalBoundary).files, snapshot);
  const expected = { ...prior.files.hashes }; for (const patch of PATCHES) expected[patch.path] = patch.afterSha256;
  assert.deepEqual(snapshot.hashes, expected, 'Only the two historical native-approved files differ from accepted twelve-repair source');
  assert.equal(snapshot.indexSha256, prior.files.indexSha256);
  assert.equal(cleanup.status, 'PASS_OWNED_RUNTIME_AND_OBSERVED_EDITOR_IDENTITIES_STOPPED'); assert.equal(cleanup.postmasterPidFileAbsent, true); assert(cleanup.ports.every(row => row.listening === false));
  assert.equal(preservation.status, 'PRESERVED_TWENTY_THREE_RECORDED_NATIVE_TREES'); assert.equal(preservation.totalRuns, 23);
  assert.equal(preservation.newRun.path, path.dirname(bindingIdentity.path)); assert(preservation.frozenInputs.some(pin => pin.path === bindingIdentity.path && pin.sha256 === bindingIdentity.sha256));
  assert.equal(base.identity(preservation.manifest.path).sha256, preservation.manifest.sha256);
  return { status: 'VERIFIED_PARTIAL_NATIVE_PATCH_BINDING', identity: bindingIdentity, workspace: binding.workspace, files: snapshot,
    completedBugCases: [...INITIAL_CASES], historicalPatchIds: [...HISTORICAL_PATCH_IDS], completedFeatures: [],
    source: 'ACTUAL_THREE_REPLY_NATIVE_PATCH_CHECKPOINT', sessionCredit: 'Prior oracle timeout remains failed; fresh functional evidence, lint, restart and native causal review required' };
}
// Functional receipt checks retained from the frozen signed-webhook contract; lint and invocation admission remain explicit, separate requirements.
function assertPositiveEvidence({fixture,feature,bugRegressions}){
 checkedRepairs(fixture);const {qualification}=signed.candidateProvenance();
 const oraclePins=qualification.implementationPins.slice(0,8);assert.equal(oraclePins.length,8);assert.deepEqual(feature.sourceIdentities,oraclePins.slice().sort((a,b)=>a.path.localeCompare(b.path)));
 for(const pin of oraclePins)assert.equal(base.identity(pin.path).sha256,pin.sha256);
 assert.equal(feature.status,'PASS_F05_SIGNED_WEBHOOKS');assert.equal(feature.caseId,FEATURE_ID);assert.equal(feature.workspace,fixture.workspace);assert.deepEqual(feature.failures,[]);assert.deepEqual(feature.receiverErrors,[]);assert.deepEqual(feature.process.exit,{code:0,signal:null});assert.equal(feature.process.cleanup.status,'TERMINAL_OBSERVED');assert.equal(feature.receiver.cleanup.status,'DRAINED');
 const scope=pinned(feature.scope);assert.equal(scope.workspace,fixture.workspace);assert.equal(scope.runtime,feature.runtime);assert.equal(scope.purpose,'PB02_F05_SOURCE_RUNTIME_SCOPE');assert.equal(scope.schemaVersion,1);assert.equal(feature.contract.sha256,base.CONTRACT_SHA);assert.equal(feature.contract.path,CASE_CONTRACT.path);for(const boundary of [feature.sourceBoundaryBefore,feature.sourceBoundaryAfter]){assert.equal(boundary.sourceSha256,base.hash(JSON.stringify(scope.source)));assert.equal(boundary.sourceFiles,Object.keys(scope.source.files).length);assert.equal(boundary.indexSha256,fixture.indexSha256);assert.equal(boundary.documentationSha256,PATCHES[1].afterSha256);assert.deepEqual(boundary.panelIds,scope.panelIds);assert.equal(boundary.dependencyFiles,scope.dependencyTrees.reduce((n,r)=>n+r.files,0));}
 const expected=expectedSnapshotHashes(fixture,[]);for(const [relative,sha256]of Object.entries(expected))assert.deepEqual(scope.source.files[relative],{kind:'file',sha256},'Captured F05 scope joins exact candidate and preserved files');
 assert.equal(feature.sourceBoundaryAfter.documentationSha256,PATCHES[1].afterSha256);assert.deepEqual(feature.initialization,{code:0,signal:null});assert.equal(feature.process.cleanup.observedExitEvent,true);assert.deepEqual(feature.process.cleanup.exit,feature.process.exit);assert.equal(feature.receiver.cleanup.forcedConnections,false);assert.equal(feature.process.exitedAt,feature.observationWindow.appExitedAt);assert.equal(feature.updateStartedAt,feature.observationWindow.updateStartedAt);assert.equal(feature.receiver.closedAt,feature.observationWindow.endedAt);assert(feature.events.every(e=>e.at>=feature.observationWindow.startedAt&&e.at<=feature.observationWindow.endedAt));
 assert.deepEqual(feature.createdRow,{id:feature.fixture.id,...feature.fixture.created});assert.deepEqual(feature.updatedRow,{id:feature.fixture.id,...feature.fixture.updated});const api=feature.apiReceipts;assert.equal(api.length,6);assert(api.every(r=>r.status===200&&r.completedAt>=r.startedAt&&/^[a-f0-9]{64}$/.test(r.responseSha256)));assert.equal(api[4].method,'POST');assert.equal(api[4].url,`/api/lists/${feature.fixture.listId}/cards`);assert.deepEqual(api[4].item,feature.createdRow);assert.equal(api[5].method,'PATCH');assert.equal(api[5].url,`/api/cards/${feature.fixture.id}`);assert.deepEqual(api[5].item,feature.updatedRow);
 const receiptPin=oraclePins.find(p=>p.path.endsWith('/f05-receipts.cjs')),receipt=require(receiptPin.path);assert.equal(feature.events.length,6);
 const phases=['cardCreate','cardUpdate'].map(event=>receipt.verifyPhase(feature.events,feature.fixture,event));assert.deepEqual(feature.phaseChecks,phases);assert.deepEqual(feature.finalChecks.phases,phases);assert.equal(feature.finalChecks.status,'PASS_F05_EXACT_CREATE_UPDATE_RECEIPTS');
 assert.equal(feature.finalChecks.checkedLogs.length,3);const logNames=feature.finalChecks.checkedLogs.map(p=>path.basename(p.path)).sort();assert.deepEqual(logNames,['application.log','migrations.log','server.log']);
 const logs=feature.finalChecks.checkedLogs.map(p=>{base.contained(feature.artifact,p.path);const bytes=fs.readFileSync(base.exactFile(feature.artifact,path.relative(feature.artifact,p.path)));assert.equal(bytes.length,p.bytes);assert.equal(base.hash(bytes),p.sha256);return{path:p.path,bytes};});assert.deepEqual(receipt.verifyFinal(feature.events,feature.fixture,logs),feature.finalChecks);
 assert(feature.observationWindow.endedAt>=feature.observationWindow.appExitedAt&&feature.observationWindow.appExitedAt>=feature.observationWindow.updateStartedAt);assert.equal(feature.observationWindow.endedAt,feature.receiver.observationEndedAt);
 signed.assertAllBugResults(bugRegressions,fixture.workspace);for(const [relative,sha256]of Object.entries(bugRegressions.sourceHashes))assert.equal(expected[relative],sha256);
 return {status:'F05_POSITIVE_ASSERTIONS_MATCHED',verifiedFunctionalFeatureIds:[FEATURE_ID],featureIds:[],preservedBugIds:[...INITIAL_CASES],nativeCausalJoinsRequired:true,limits:'Raw positive assertions alone do not establish successful parent invocation, native lint or full feature acceptance.'};
}
function assertFeatureEvidence(input) {
 completed(input.completedPatchIds); const positive=assertPositiveEvidence(input);
 assert.deepEqual(input.lintStep, steps.buildSteps(input.fixture.workspace)[steps.LINT_ORDINAL-1]);
 steps.assertCommandResult({step:input.lintStep,result:input.lintResult});
 return {...positive,status:'F05_FUNCTIONAL_AND_LINT_EVIDENCE_MATCHED',featureIds:[FEATURE_ID],historicalPatchIds:[...HISTORICAL_PATCH_IDS],newPatchIds:[],limits:'Fresh invocation and historical native approval joins remain required by the campaign auditor.'};
}

module.exports = { ...base, ...steps, STAGE, MAIN_CAP, HELPER_CAP, SELECTED, PATCH_IDS, HISTORICAL_PATCH_IDS,
  FEATURE_ID, INITIAL_CASES, INITIAL_BUG_CASES: INITIAL_CASES, PATCHES, CASE_CONTRACT, PLAN, QUALIFICATION,
  PRIOR_NATIVE_CHECKPOINT, PRIOR_REVIEW, PRIOR_CLEANUP, PRIOR_PRESERVATION, BOUNDED_QUALIFICATION,
  candidateProvenance: signed.candidateProvenance, assertAllBugResults: signed.assertAllBugResults, assertLintBoundary: signed.assertLintBoundary,
  assertPositiveEvidence, assertFeatureEvidence, pinned, frozenCases, buildRepairs, checkedRepairs, expectedSnapshotHashes, verifySnapshot, verifyBoundary, patchScope, recordedPatchScope, assertNativePreparationReady };
