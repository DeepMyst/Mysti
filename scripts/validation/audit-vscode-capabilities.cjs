/* PC-12 independent read-only audit of ordinary disk state and native receipts. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto'), { execFileSync } = require('node:child_process');
const { assertCopilotPromptHistoryRequest, matchesPublicModelSelection, assertUnavailableCopilotModelAttempt, assertClaudePeerHandoff } = require('./capabilities-request-oracle.cjs');
const repo = path.resolve(__dirname, '../..'), directory = path.resolve(process.env.MYSTI_PC12_ARTIFACT_DIR);
assert(directory.startsWith(path.join(repo, 'out-test/feature-tests/PC-12') + path.sep));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const manifest = read(path.join(directory, 'prepared.json')), owner = manifest.windows.A;
assert.equal(manifest.case, 'PC-12'); assert.equal(manifest.artifactDir, directory);
const marker = read(path.join(owner.profile, '.mysti-test-owned.json')); assert.equal(marker.case, 'PC-12'); assert.equal(marker.profile, fs.realpathSync(owner.profile));
assert.equal(read(path.join(directory, 'native-result.json')).status, 'PASS');
for (const extension of [manifest.sourcePackage, owner.installedExtension]) {
  assert.equal(hash(path.join(extension, 'dist/extension.js')), manifest.bundleSha256); assert.equal(hash(path.join(extension, 'media/chat/chat.js')), manifest.chatSha256);
}
for (const identity of [...Object.values(manifest.executableIdentities), ...manifest.wrapperIdentities, ...manifest.harnessDependencyIdentities, manifest.nodeIdentity]) assert.equal(hash(identity.path), identity.sha256);
for (const file of manifest.runtimeIdentity.files) assert.equal(hash(path.join(manifest.runtimeIdentity.root, file.relative)), file.sha256);
assert.equal(hash(manifest.explicitCopilotModel.sourceArtifact),manifest.explicitCopilotModel.sourceSha256);
assert.equal(manifest.explicitCopilotModel.sourceKind,'PUBLIC_PINNED_CLI_HELP_CONFIG_CATALOG');
assert(read(manifest.explicitCopilotModel.sourceArtifact).publicHelpConfigModelCatalog.includes(manifest.explicitCopilotModel.id));
const launch = read(path.join(owner.directory, 'launch.json')); assert.equal(launch.profile, owner.profile); assert.equal(launch.installedExtension, owner.installedExtension);
assert(launch.args.every(arg => !/extensionTestsPath/i.test(arg)));
const exit = read(path.join(owner.directory, 'editor-exit.json')); assert.equal(exit.code, 0); assert.equal(exit.helper.failures, 0); assert.equal(exit.timedOut, false);
const cleanup = read(path.join(owner.directory, 'editor-exit-process-check.json')); assert.equal(cleanup.status, 'PASS_OBSERVED_IDENTITIES_EXITED'); assert.equal(cleanup.unverifiedLiveReceiptPids.length, 0);
const ancestry = read(path.join(owner.directory, 'process-ancestry.json')); assert(ancestry.processIdentities.length > 0);
const live = new Map(execFileSync('ps', ['-axo', 'pid=,lstart='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(line => { const m = line.trim().match(/^(\d+)\s+(.+)$/); assert(m); return [+m[1], m[2]]; }));
for (const identity of ancestry.processIdentities) assert.notEqual(live.get(identity.pid), identity.startedAt, `Observed process still alive: ${identity.pid}`);
const receipts = owner.receiptPaths.flatMap(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
assert(!receipts.some(value => value.event === 'instrumentation-error' || value.event === 'wrapper-rejected-settings'));
for (const receipt of receipts) for (const pid of [receipt.wrapperPid, receipt.childPid].filter(Boolean)) {
  if (!live.has(pid)) continue;
  const captured = ancestry.processIdentities.filter(identity => identity.pid === pid), birth = Date.parse(live.get(pid));
  assert((captured.length && captured.every(identity => identity.startedAt !== live.get(pid))) || (Number.isFinite(birth) && birth > receipt.at), `Unverified live receipt PID: ${pid}`);
}
const acceptance = read(path.join(owner.directory, 'acceptance.json')), events = read(path.join(owner.directory, 'observations.json'));
assert.equal(acceptance.status, 'PASS_BOUNDED_ERROR_RECOVERY'); assert.equal(acceptance.manifest.schemaVersion, 1); assert.equal(new Set(acceptance.manifest.providers.map(value => value.id)).size, 16);
assert.equal(manifest.conversationalRequestsPlanned, 6); assert.equal(acceptance.conversationInputs, 6);
assert.equal(acceptance.successfulReplies, 5); assert.equal(acceptance.rejectedExplicitAttempts, 1);
assert.equal(acceptance.validExplicitInference, 'UNRUN_SERVICE_LIMITED');
assert.equal(acceptance.manifest.providers.find(value => value.id === 'github-copilot')?.capabilities.sessionKind, 'prompt-history');
assert(!acceptance.manifest.providers.some(value => ['mysti', 'brainstorm', 'manus'].includes(value.id)));
const requests = receipts.filter(value => value.event === 'request').sort((a, b) => a.at - b.at); assert.equal(requests.length, 6);
assert.deepEqual(acceptance.explicitCopilotModel,manifest.explicitCopilotModel);
const expected = [['CLAUDE_READ', 'claude-code', 'sonnet'], ['CODEX_REVIEW', 'openai-codex', 'gpt-5.6-sol'], ['COPILOT_AUTO', 'github-copilot', 'auto'], ['COPILOT_AUTO_READ', 'github-copilot', 'auto'], ['CLAUDE_RETURN', 'claude-code', 'sonnet']];
const successRequestIndices = [0, 1, 2, 4, 5];
for (const [,provider,model] of [...expected, ['COPILOT_EXPLICIT_UNAVAILABLE','github-copilot',acceptance.explicitCopilotModel.id]]) assert(events.some(value => value.event === 'model-selection-settled'
  && value.requestedProvider === provider && value.requestedModel === model
  && value.hostSelectionEvents.some(selection => matchesPublicModelSelection({expectedProvider:provider,expectedModel:model,selection,inlineValue:value.inlineValue,customInputValue:value.customInputValue}))), 'Provider-scoped effective model acknowledgement and exact public controls must agree');
assert.equal(acceptance.replies.length, expected.length);
for (let index = 0; index < expected.length; index++) {
  const [marker, provider, model] = expected[index], request = requests[successRequestIndices[index]], reply = acceptance.replies[index];
  assert.deepEqual(reply.request, request);
  assert(request.markerOrigins.outsideProjectMemoryMarkers.includes(marker)); assert.equal(request.provider, provider); assert.equal(request.model, model);
  assert.equal(reply.marker, marker); assert.equal(reply.provider, provider); assert.equal(reply.model, model); assert(reply.content.includes(manifest.token)); assert(reply.content.includes(`PC12_DONE:${marker}`));
  const truth = reply.content.match(/PC12_TRUTH:\s*(\[[^\]]+\])/); assert(truth); assert.deepEqual(JSON.parse(truth[1]), [true, false, false]);
  assert.equal(reply.toolCount > 0, [0, 3].includes(index));
  if (provider === 'github-copilot') {
    assertCopilotPromptHistoryRequest(request);
    assert.deepEqual(request.policy.denyTools.slice().sort(), ['shell', 'write']); assert.equal(request.policy.allowAllTools, false); assert.equal(request.policy.injectedNoAutoUpdate, true);
    assert.equal(request.policy.effort, model === 'auto' ? undefined : 'low'); assert.equal(reply.nativePermissionRequests, 0);
  }
}
const auto = acceptance.replies[2], recovered = acceptance.replies[3];
assert(recovered.content.includes(manifest.handoffToken));
for (const request of requests.slice(0, 4)) assert.equal(request.containsHandoffToken, false, 'Review tag is introduced only in the later Copilot turn');
assert.equal(requests[4].containsHandoffToken, true);
assertClaudePeerHandoff({ request: requests[5], content: acceptance.replies[4].content, handoffToken: manifest.handoffToken });
for (const [reply, actualModel] of [[auto, acceptance.actualCopilotAutoModel], [recovered, acceptance.actualCopilotRecoveryModel]]) {
  assert.equal(typeof actualModel, 'string'); assert(actualModel && actualModel !== 'auto');
  const wire = receipts.filter(value => value.provider === 'github-copilot' && value.at >= reply.started && value.at <= reply.completedAt);
  assert.deepEqual([...new Set(wire.filter(value => value.event === 'auto-model-resolved').map(value => value.chosenModel))], [actualModel]);
  assert.deepEqual(reply.actualModelCallReceipts, wire.filter(value => value.event === 'model-call').map(value => value.actualModel).filter(Boolean));
  assert(reply.actualModelCallReceipts.every(value => value === actualModel));
}
assert.equal(acceptance.rejectedAttempts.length, 1);
const rejectedAttempt = acceptance.rejectedAttempts[0], rejectedRequest = requests[3];
assert.equal(rejectedAttempt.marker, 'COPILOT_EXPLICIT_UNAVAILABLE');
assert.deepEqual(rejectedAttempt.request, rejectedRequest);
assert(rejectedRequest.markerOrigins.outsideProjectMemoryMarkers.includes(rejectedAttempt.marker));
assert(rejectedAttempt.started > auto.completedAt && rejectedAttempt.rejectedAt < recovered.started);
const rejectionReceipts = receipts.filter(value => value.provider === 'github-copilot' && value.at >= rejectedAttempt.started && value.at <= rejectedAttempt.rejectedAt);
assertUnavailableCopilotModelAttempt({request:rejectedRequest,expectedModel:acceptance.explicitCopilotModel.id,errorText:rejectedAttempt.errorText,nativeReceipts:rejectionReceipts});
assert.equal(rejectedAttempt.modelCallCount, 0); assert.equal(rejectedAttempt.toolReceiptCount, 0);
assert(events.some(value => value.event === 'model-selection-settled' && value.at > rejectedAttempt.rejectedAt && value.at < recovered.started
  && value.requestedProvider === 'github-copilot' && value.requestedModel === 'auto'
  && value.hostSelectionEvents.some(selection => matchesPublicModelSelection({expectedProvider:'github-copilot',expectedModel:'auto',selection,inlineValue:value.inlineValue,customInputValue:value.customInputValue}))));
assert(receipts.some(value => value.provider === 'github-copilot' && value.event === 'tool-start' && value.exactOwnedFile && value.at >= recovered.started && value.at <= recovered.completedAt));
assert(receipts.some(value => value.provider === 'github-copilot' && value.event === 'tool-result' && value.success === true && value.containsFixtureToken && value.at >= recovered.started && value.at <= recovered.completedAt));
const negative = events.filter(value => value.event === 'unsupported-ask-rejected'); assert.equal(negative.length, 1); assert.equal(negative[0].forwardedConversationInputs, 0);
assert(/cannot request approval|does not support.*approval|unsupported.*permission/i.test(JSON.stringify(negative[0].errors)));
assert(!requests.some(value => value.at > acceptance.replies[1].completedAt && value.at <= negative[0].at));
const controls = events.filter(value => value.event === 'rendered-controls' && value.provider === 'github-copilot');
assert(controls.some(value => !value.modelEffortVisible && !value.toolsEffortVisible && value.modes.some(mode => mode.mode === 'ask' && mode.disabled)));
assert(controls.some(value => value.modelEffortVisible && value.toolsEffortVisible));
assert(controls.some(value => value.at > rejectedAttempt.rejectedAt && value.at < recovered.started && !value.modelEffortVisible && !value.toolsEffortVisible));
assert(controls.some(value => value.usage.text === 'n/a' && value.usage.pie === ''));
for (const [relative, content] of Object.entries(manifest.files)) assert.equal(fs.readFileSync(path.join(owner.workspace, relative), 'utf8'), content, `Owned fixture changed: ${relative}`);
const actualFiles = [];
function visit(folder) {
  for (const entry of fs.readdirSync(folder, {withFileTypes:true})) {
    if (folder === owner.workspace && entry.name === '.git') continue;
    const file = path.join(folder, entry.name); assert(!entry.isSymbolicLink());
    if (entry.isDirectory()) visit(file); else { assert(entry.isFile()); actualFiles.push(path.relative(owner.workspace, file)); }
  }
}
visit(owner.workspace); assert.deepEqual(actualFiles.sort(), Object.keys(manifest.files).sort(), 'Exact developer workspace file tree');
assert.equal(execFileSync('git', ['ls-files', '--stage'], { cwd: owner.workspace, encoding: 'utf8' }), manifest.originalIndex, 'Staged entry semantics changed');
assert.equal(execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {cwd:owner.workspace,encoding:'utf8'}), manifest.originalStatus);
const database = path.join(owner.profile, 'User/globalStorage/state.vscdb'); assert(fs.existsSync(database));
const sqlite = `import sqlite3,json,sys\ndb=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)\nrows=list(db.execute("SELECT value FROM ItemTable WHERE lower(key)='deepmyst.mysti'"))\nassert len(rows)==1\nblob=json.loads(rows[0][0]).get('mysti.conversations',{})\nentries=blob.get('conversations',[])\nfor entry in entries: assert isinstance(entry,list) and len(entry)==2 and entry[0]==entry[1].get('id')\nprint(json.dumps([entry[1] for entry in entries]))`;
const stored = JSON.parse(execFileSync('python3', ['-c', sqlite, database], { encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 }));
const conversation = stored.find(value => value.id === acceptance.sourceId); assert(conversation); assert.deepEqual(conversation.messages.map(value => value.id), acceptance.finalMessageIds);
const assistants = conversation.messages.filter(value => value.role === 'assistant'); assert.equal(assistants.length, 5);
for (let index = 0; index < assistants.length; index++) {
  const actual = assistants[index], reply = acceptance.replies[index]; assert.equal(actual.id, reply.id); assert.equal(actual.content, reply.content); assert.equal(actual.provider, reply.provider); assert.equal(actual.model, reply.model);
  assert.equal((actual.toolCalls || []).length, reply.toolCount);
  for (const tool of actual.toolCalls || []) { assert.equal(tool.status, 'completed'); assert(tool.output.includes(manifest.token)); }
}
const audit = { status: 'PASS_BOUNDED_NATIVE_ERROR_RECOVERY', conversationInputs: requests.length, successfulReplies:5, rejectedExplicitAttempts:1, auxiliaryInputs: receipts.filter(value => value.event === 'auxiliary-input').length,
  blockedUnsupportedAskInputs: 0, copilotPromptHistoryOmitsNativeResume: true, actualCopilotAutoModel: acceptance.actualCopilotAutoModel,
  actualCopilotRecoveryModel:acceptance.actualCopilotRecoveryModel, sameConversationAutoRecovery:true, claudeNativeResumePeerHandoff:true,
  explicitModelAttribution: {requestedModel:acceptance.explicitCopilotModel.id,candidateSource:acceptance.explicitCopilotModel.sourceKind,outcome:'REJECTED_UNAVAILABLE',actualModelCallReceipts:[],independentActualIdentityConfirmed:false,validExplicitInference:'UNRUN_SERVICE_LIMITED'}, observedIdentitiesExited: ancestry.processIdentities.length,
  diskProfile: database, fixtureByteTreeStatusAndStagedEntryEquality: true, productWorkspaceArtifactsOutsideGit: [], gitMetadataExcluded: acceptance.gitMetadataExcluded, semanticTruthTablesPassed: 5, semanticPatchReview: 'ROOT_REVIEW_REQUIRED',
  scope: manifest.scope, limits: ['Only three providers inferred; the other13 have fresh readiness and public capability/menu evidence.', 'Successful explicit Copilot model inference remains unverified; two catalog/internal IDs were rejected, not every possible explicit model.', 'Copilot shell/write denial is observed; no universal external MCP policy claim.', 'No full capability matrix, account census, restart, upgrade-schema native test, or elapsed soak.'] };
fs.writeFileSync(path.join(directory, 'independent-audit.json'), JSON.stringify(audit, null, 2)); console.log(JSON.stringify(audit));
