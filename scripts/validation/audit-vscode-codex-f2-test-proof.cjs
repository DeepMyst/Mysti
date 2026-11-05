/* Read-only one-command F2 client-test authority evidence; no inferred hidden tool arguments. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const c=require('./codex-f2-test-proof.cjs'),auxiliary=require('./codex-f2-test-proof-auxiliary.cjs');
const {messageProjection,readStoredConversations}=require('./audit-vscode-claude.cjs');
const {assertToolOutputProjection}=require('./codex-full-oracle.cjs');
const {joinNativeAssistantMessages}=require('./audit-vscode-codex-helper-quality.cjs');
const {auditSnapshotEvidence,auditMainProcesses}=require('./audit-vscode-codex-f2.cjs');
const repo=path.resolve(__dirname,'../..'),root=path.join(repo,'out-test/feature-tests/PB-02'),hash=c.hash;
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const one=(rows,why)=>{assert.equal(rows.length,1,why);return rows[0];};
const pin=value=>{assert(value&&/^[a-f0-9]{64}$/.test(value.sha256));assert.equal(c.identity(value.path).sha256,value.sha256);return value;};
function ownedFile(directory,file){c.contained(directory,file);assert.equal(fs.realpathSync(file),file);assert(fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink());return file;}
function permittedTool(tool,step,commands,fixture){return String(tool.name).toLowerCase()==='bash'&&tool.input?.cwd===fixture.workspace&&commands.length===1&&c.exactCommand(tool.input.command,commands[0]);}
function auditProofTurn({ fixture, step, reply, events, observations, wire, storedMessage, commands, completedCases, panelIds, model = 'gpt-5.6-sol' }) {
  assert.equal(reply.ordinal, step.ordinal); assert.equal(reply.marker, step.marker); assert.equal(reply.prompt, c.promptFor(step, commands)); assert.deepEqual(reply.commands, commands); assert.equal(reply.scope, step.patch || null);
  assert(Number.isFinite(reply.started) && Number.isFinite(reply.completedAt) && reply.started <= reply.completedAt);
  const interval = events.filter(row => row.at >= reply.started && row.at <= reply.completedAt);
  assert(!interval.some(row => ['error', 'authError', 'requestCancelled', 'autonomousDecision', 'semiAutonomousPlanTimer', 'semiAutonomousQuestionTimer'].includes(row.type)));
  const user = one(interval.filter(row => row.type === 'messageAdded' && row.payload?.role === 'user'), 'One actual user action for the declared task'); assert.equal(user.payload.content, reply.prompt);
  const terminal = one(interval.filter(row => row.type === 'responseComplete'), 'One actual completed response'); assert.equal(terminal.at, reply.completedAt);
  assert.deepEqual(messageProjection(terminal.payload.message), messageProjection(reply.message)); assert.deepEqual(messageProjection(storedMessage), messageProjection(reply.message));
  assert.equal(reply.messageId, reply.message.id); assert.equal(reply.message.role, 'assistant'); assert.equal(reply.message.model, model); assert.equal(reply.message.provider, 'openai-codex');
  assert(reply.message.content.includes(`PB02_DONE:${step.marker}`)); assert(interval.some(row => row.type === 'responseStarted'));
  const input = one(wire.filter(row => row.event === 'request' && row.inputIndex === step.ordinal), 'One bounded actual model request'); assert.deepEqual(reply.request, input);
  assert.equal(input.model, model); assert.equal(input.effort, 'low'); assert(input.outsideMemoryMarkers.includes(step.marker)); assert(user.at <= input.at && input.at <= reply.completedAt);
  for (const flag of ['ownedCwd', 'mcpAllDisabled', 'appsAllDisabled', 'appsDefaultDisabled']) assert.equal(input.policy[flag], true);
  assert.equal(input.policy.approvalPolicy, 'untrusted'); assert.equal(input.policy.sandbox, 'read-only'); assert.equal(input.policy.effort, 'low');
  const configuration = wire.filter(row => row.wrapperPid === input.wrapperPid && row.event === 'effective-tool-config' && row.at <= input.at).at(-1); assert(configuration);
  assert.deepEqual(input.policy.mcpNames, configuration.mcpNames); assert.deepEqual(input.policy.appNames, configuration.appNames);
  const session = wire.filter(row => row.wrapperPid === input.wrapperPid && row.event === 'session' && row.at <= input.at).at(-1); assert(session); assert.deepEqual(reply.session, session);
  assert.equal(session.sessionHash, input.sessionHash); assert.equal(session.actualModel, model); assert.equal(session.requestedModel, model);
  assert.equal(session.returnedPolicy.approvalPolicy, 'untrusted'); assert.equal(session.returnedPolicy.sandbox, 'readOnly'); assert.equal(session.returnedPolicy.ownedCwd, true); assert.notEqual(session.returnedPolicy.networkAccess, true);
  const own = wire.filter(row => row.wrapperPid === input.wrapperPid && row.inputIndex === input.inputIndex);
  const begun = one(own.filter(row => row.event === 'turn-started'), 'One real native turn start'), done = one(own.filter(row => row.event === 'turn-completed'), 'One real native turn result');
  assert.equal(done.status, 'completed'); assert.deepEqual(reply.terminal, done); assert.equal(begun.turnHash, done.turnHash); assert(/^[a-f0-9]{64}$/.test(done.turnHash));
  assert.equal(begun.sessionHash, input.sessionHash); assert.equal(done.sessionHash, input.sessionHash); assert(input.at <= begun.at && begun.at <= done.at && done.at <= terminal.at);
  const nativeMessages = own.filter(row => row.event === 'assistant-message');
  for (const row of nativeMessages) { assert.equal(row.sessionHash, input.sessionHash); assert.equal(row.turnHash, begun.turnHash); assert(row.at >= begun.at && row.at <= done.at); }
  const nativeText = joinNativeAssistantMessages(nativeMessages, reply.message.content); assert.deepEqual(reply.nativeText, nativeText);
  const tools = reply.message.toolCalls || [], ids = tools.map(row => row.id); assert.equal(new Set(ids).size, ids.length);
  const nativeTools = own.filter(row => ['tool-start', 'tool-result'].includes(row.event)); assert.deepEqual(reply.nativeTools, nativeTools);
  const verified = tools.map(tool => {
    assert(permittedTool(tool, step, commands, fixture), 'Native action exceeds exact task authority'); assert.notEqual(tool.proposalOnly, true); assert.notEqual(tool.historicalOnly, true);
    const itemIdHash = hash(tool.id), starts = nativeTools.filter(row => row.event === 'tool-start' && row.itemIdHash === itemIdHash);
    assert(starts.length > 0); const result = one(nativeTools.filter(row => row.event === 'tool-result' && row.itemIdHash === itemIdHash), 'One native tool result');
    for (const row of [...starts, result]) { assert.equal(row.sessionHash, input.sessionHash); assert.equal(row.turnHash, begun.turnHash); assert(row.at >= begun.at && row.at <= done.at); }
    assert(starts.every(row => row.at <= result.at && row.type === result.type));
    const live = one(interval.filter(row => row.type === 'toolResult' && row.payload?.id === tool.id), 'One full live tool output').payload;
    for (const field of ['name', 'status', 'input']) assert.deepEqual(live[field], tool[field]);
    const projection = assertToolOutputProjection({ nativeResult: result, liveTool: live, persistedTool: tool });
    const command = String(tool.name).toLowerCase() === 'bash';
    if (command) {
      assert.equal(result.type, 'commandExecution'); assert.equal(result.commandSha256, hash(JSON.stringify(tool.input.command))); assert.equal(result.ownedCwd, true);
      assert(step.expectedNonzero ? ['completed', 'failed'].includes(result.status) : result.status === 'completed');
      assert.equal(tool.status, result.status === 'completed' ? 'completed' : 'failed', 'Public app-server status preserves native item status independently of exit code');
      assert(step.expectedNonzero ? Number.isInteger(result.exitCode) && result.exitCode !== 0 : result.exitCode === 0);
    } else {
      assert.equal(result.type, 'fileChange'); assert.deepEqual(result.changes, tool.input.changes.map(change => ({ relativePath: path.relative(fixture.workspace, path.resolve(fixture.workspace, change.path)), kind: change.kind.type, diffSha256: hash(change.diff) })));
      if (step.patch === 'deny-notes') { assert(['failed', 'declined'].includes(result.status)); assert.notEqual(tool.status, 'completed'); }
      else { assert.equal(result.status, 'completed'); assert.equal(tool.status, 'completed'); }
    }
    return { tool, result, projection, command };
  });
  assert.deepEqual(reply.outputEvidence, verified.map(row => row.projection));
  for (const row of nativeTools) assert(ids.some(id => hash(id) === row.itemIdHash), 'No hidden native start or result');
  for (const event of interval.filter(row => ['toolUse', 'toolResult'].includes(row.type))) assert(ids.includes(event.payload?.id), 'No omitted live tool');
  for (const command of commands) assert.equal(verified.filter(row => row.command && c.exactCommand(row.tool.input.command, command)).length, 1, 'Each required command executes exactly once');
  const cards = interval.filter(row => row.type === 'permissionRequest'), choices = observations.filter(row => row.event === 'permission-decision' && row.marker === step.marker);
  const requests = own.filter(row => row.event === 'approval-request'), responses = own.filter(row => row.event === 'approval-decision');
  assert.equal(new Set(cards.map(row => row.payload.id)).size, cards.length); assert.equal(new Set(choices.map(row => row.id)).size, choices.length);
  const paired = new Set(), pairedResponses = new Set(); let nativePatchDenied = false;
  const approvals = cards.map(card => {
    const details = card.payload.details; assert(permittedTool({ name: details.toolName, input: details.toolInput }, step, commands, fixture));
    const request = one(requests.filter(row => !paired.has(row) && row.toolInputSha256 === hash(JSON.stringify(details.toolInput)) && row.at <= card.at), 'Public card joins exact native approval bytes'); paired.add(request);
    assert.equal(request.sessionHash, input.sessionHash); assert.equal(request.turnHash, begun.turnHash);
    const edit = String(details.toolName).toLowerCase() === 'edit', denied = edit && step.patch === 'deny-notes';
    assert.equal(request.method, edit ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval');
    const choice = one(choices.filter(row => row.id === card.payload.id), 'Exactly one actual public decision'); assert.deepEqual(choice.input, details.toolInput); assert.equal(choice.name, String(details.toolName).toLowerCase());
    assert.equal(choice.approved, !denied); assert.equal(choice.expectedDenial, denied); assert(choice.at >= card.at && choice.at <= reply.completedAt);
    const response = one(responses.filter(row => row.nativeRequestIdHash === request.nativeRequestIdHash), 'One exact native response to the approval'); pairedResponses.add(response);
    assert.equal(response.decision, denied ? 'decline' : 'accept'); assert(response.at >= card.at && response.at <= reply.completedAt);
    const item = one(verified.filter(row => row.result.itemIdHash === request.itemIdHash), 'Approval belongs to its actual item');
    if (edit) assert.deepEqual(item.tool.input.changes, details.toolInput.changes);
    else { assert.equal(item.tool.input.command, details.toolInput.command); assert.equal(item.tool.input.cwd, details.toolInput.cwd); }
    assert(own.indexOf(request) < own.indexOf(response) && own.indexOf(response) < own.indexOf(item.result));
    if (denied) { assert(['failed', 'declined'].includes(item.result.status)); nativePatchDenied = true; }
    const afterThisPatch = !!step.patch && step.patch !== 'deny-notes' && verified.some(row => !row.command && row.result.at <= choice.at && own.indexOf(row.result) < own.indexOf(request));
    auditSnapshotEvidence(fixture, choice.beforeFiles, [...completedCases, ...(afterThisPatch ? [step.patch] : [])], panelIds);
    return { id: card.payload.id, nativeRequestIdHash: request.nativeRequestIdHash, itemIdHash: request.itemIdHash, decision: response.decision };
  });
  assert.equal(paired.size, requests.length); assert.equal(pairedResponses.size, responses.length); assert.equal(choices.length, cards.length);
  for (const item of verified.filter(row => !row.command)) assert(approvals.some(row => row.itemIdHash === item.result.itemIdHash), 'Every patch requires actual native approval ownership');
  const nextCompleted = completedCases.slice();
  if (step.patch && step.patch !== 'deny-notes') { assert.equal(verified.filter(row => !row.command).length, 1); nextCompleted.push(step.patch); }
  if (step.patch === 'deny-notes') assert(verified.filter(row => !row.command).length <= 1, 'Never retry a deliberate denied proposal');
  auditSnapshotEvidence(fixture, reply.beforeFiles, completedCases, panelIds); auditSnapshotEvidence(fixture, reply.afterFiles, nextCompleted, panelIds);
  return { ordinal: step.ordinal, marker: step.marker, input, user: user.payload, userAt: user.at, message: reply.message, completedAt: reply.completedAt,
    turnHash: begun.turnHash, session, nativeText, approvals, verifiedTools: verified, nextCompleted, nativePatchDenied,
    deliberateFault: step.injectedFault || null };
}
function auditApprovalMetadata(value, publicInput, expectedReason) {
  assert(value && typeof value === 'object'); assert.deepEqual(Object.keys(value).sort(), ['additionalPermissions','availableDecisions','reason']);
  for(const key of ['reason','availableDecisions','additionalPermissions']) {
    const item=value[key];assert.equal(typeof item.present,'boolean');assert(['absent','null','string','array','object','number','boolean'].includes(item.type));
    assert(Number.isSafeInteger(item.bytes)&&item.bytes>=0);
    if(!item.present){assert.equal(item.type,'absent');assert.equal(item.sha256,null);assert.equal(item.bytes,0);}
    else {assert.notEqual(item.type,'absent');assert(/^[a-f0-9]{64}$/.test(item.sha256));assert(item.bytes>0);}
    if(item.type==='null'){assert.equal(item.sha256,hash('null'));assert.equal(item.bytes,4);}
  }
  const reason=value.reason,present=Object.hasOwn(publicInput,'reason'),encoded=present?JSON.stringify(publicInput.reason):undefined;
  assert.equal(reason.present,present);assert.equal(reason.sha256,encoded===undefined?null:hash(encoded));assert.equal(reason.bytes,encoded===undefined?0:Buffer.byteLength(encoded));
  assert.equal(reason.matchesExpected,publicInput.reason===expectedReason);
  if(reason.matchesExpected)assert.equal(reason.text,expectedReason);else assert(!Object.hasOwn(reason,'text'));
  assert.deepEqual(Object.keys(reason).sort(),['bytes','matchesExpected','present','sha256',...(reason.matchesExpected?['text']:[]),'type'].sort());
  const choices=value.availableDecisions;assert(Array.isArray(choices.values));assert(choices.values.every(v=>['accept','acceptForSession','decline','cancel','UNRETAINED_DECISION'].includes(v)));
  assert.equal(choices.unrecognized,choices.values.filter(v=>v==='UNRETAINED_DECISION').length);
  if(choices.type!=='array')assert.equal(choices.values.length,0);
  if(choices.type==='array'&&!choices.unrecognized){const encoded=JSON.stringify(choices.values);assert.equal(choices.sha256,hash(encoded));assert.equal(choices.bytes,Buffer.byteLength(encoded));}
  assert.deepEqual(Object.keys(choices).sort(),['bytes','present','sha256','type','unrecognized','values']);
  assert.deepEqual(Object.keys(value.additionalPermissions).sort(),['bytes','present','sha256','type']);
  return {reasonMatchesRequested:reason.matchesExpected,reasonSha256:reason.sha256,availableDecisions:choices,
    additionalPermissions:value.additionalPermissions,nativeSandboxPermissionsArgument:'NOT_OBSERVABLE_IN_RETAINED_APPROVAL_SCHEMA'};
}
function auditCacheSnapshot(proof,snapshot,requireWrites=false) {
  assert.equal(snapshot.root,proof.cacheRoot);assert.deepEqual(Object.keys(proof.cacheDirectories).sort(),['jest','npm','tmp']);
  for(const name of ['jest','npm','tmp'])assert.equal(proof.cacheDirectories[name],path.join(proof.cacheRoot,name));
  assert.deepEqual(snapshot.directories,proof.cacheDirectories);assert(Array.isArray(snapshot.files));assert.equal(snapshot.fileCount,snapshot.files.length);
  assert.equal(new Set(snapshot.files.map(row=>row.relative)).size,snapshot.files.length);
  const owned=absolute=>Object.values(proof.cacheDirectories).some(directory=>absolute===directory||absolute.startsWith(directory+path.sep));
  for(const directory of Object.values(snapshot.directories)){assert(path.isAbsolute(directory)&&owned(directory));assert.equal(path.normalize(directory),directory);}
  let bytes=0;
  for(const row of snapshot.files){assert.deepEqual(Object.keys(row).sort(),['bytes','path','relative','sha256']);assert.equal(typeof row.relative,'string');assert(!path.isAbsolute(row.relative)&&!row.relative.split(/[\\/]/).includes('..'));
    assert.equal(row.path,path.join(proof.cacheRoot,row.relative));assert(owned(row.path));assert(/^[a-f0-9]{64}$/.test(row.sha256));assert(Number.isSafeInteger(row.bytes)&&row.bytes>=0);bytes+=row.bytes;assert(Number.isSafeInteger(bytes));if(!row.bytes)assert.equal(row.sha256,hash(''));}
  assert.equal(snapshot.bytes,bytes);
  const jest=snapshot.files.filter(row=>row.path.startsWith(proof.cacheDirectories.jest+path.sep));
  if(requireWrites)assert(jest.some(row=>row.bytes>0),'A returned test summary alone does not prove an owned Jest cache write');
  return {fileCount:snapshot.fileCount,bytes,ownedJestFiles:jest.length};
}
function auditProofEvidence({manifest,acceptance,events,observations,wire,storedConversation}) {
  const proof=manifest.proof,fixture=manifest.fixture,reply=acceptance.reply;
  assert.deepEqual(proof,c.createProof(fixture.workspace));assert.deepEqual(fixture.proof,proof);assert.equal(manifest.model,'gpt-5.6-sol');
  assert.equal(acceptance.status,'CAPTURED_F2_CLIENT_TEST_PROOF');assert.deepEqual(acceptance.replies,[reply]);assert.deepEqual(acceptance.observations,observations);
  assert.equal(reply.marker,'F2_TEST_CACHE_PROOF');assert.equal(reply.ordinal,1);assert.equal(reply.prompt,proof.prompt);assert.deepEqual(reply.priorMessages,[]);
  assert.deepEqual(wire.filter(row=>row.event==='request').map(row=>row.inputIndex),[1]);assert.deepEqual(reply.request.markers,[reply.marker]);assert.deepEqual(reply.request.outsideMemoryMarkers,[reply.marker]);assert.deepEqual(reply.request.memoryMarkers,[]);
  assert.equal(reply.session.method,'thread/start');assert.equal(storedConversation.id,acceptance.conversationId);assert.equal(storedConversation.messages.length,2);
  assert.deepEqual(storedConversation.messages.map(messageProjection),acceptance.finalConversation.messages.map(messageProjection));
  assert.equal(acceptance.panelId,reply.panelId);assert.equal(acceptance.conversationId,reply.conversationId);
  const result=auditProofTurn({fixture,step:proof.step,reply,events,observations,wire,storedMessage:storedConversation.messages[1],commands:[proof.command],completedCases:[],panelIds:[acceptance.panelId]});
  assert.deepEqual(messageProjection(result.user),messageProjection(storedConversation.messages[0]));
  assert.equal(events.filter(row=>row.type==='messageAdded'&&row.payload?.role==='user').length,1);assert.equal(events.filter(row=>row.type==='responseComplete').length,1);
  const tool=one(result.verifiedTools,'One exact completed native command, no alternate tool or rerun');assert.equal(tool.command,true);assert(result.approvals.length>0);
  const approvalMetadata=wire.filter(row=>row.event==='approval-request').map(row=>{
    const card=one(events.filter(event=>event.type==='permissionRequest'&&hash(JSON.stringify(event.payload.details.toolInput))===row.toolInputSha256),'Native approval metadata joins actual public command input');
    return auditApprovalMetadata(row.approvalMetadata,card.payload.details.toolInput,proof.justification);
  });
  const live=one(events.filter(row=>row.type==='toolResult'&&row.payload.id===tool.tool.id),'Full native/public test output').payload.output;
  const output=live.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');assert.equal(proof.expectedSuites,1);assert.equal(proof.expectedTests,2);
  assert(/^Test Suites:\s+1 passed,\s+1 total\s*$/m.test(output));assert(/^Tests:\s+2 passed,\s+2 total\s*$/m.test(output));
  const before=auditCacheSnapshot(proof,reply.beforeFiles.cacheSnapshot);assert.equal(before.fileCount,0);assert.equal(before.bytes,0);
  const after=auditCacheSnapshot(proof,reply.afterFiles.cacheSnapshot,true);assert.deepEqual(acceptance.files,reply.afterFiles);assert.deepEqual(acceptance.cacheSnapshot,reply.afterFiles.cacheSnapshot);
  return {status:'PASS_APPROVED_CLIENT_TEST_AND_CACHE_WRITE',model:manifest.model,mainInputs:1,commands:1,expectedSuites:1,expectedTests:2,
    nativeTurnHash:result.turnHash,approvalMetadata,toolOutput:tool.projection,cache:after,
    requestedSandboxPermissions:'require_escalated',observedSandboxPermissions:'NOT_OBSERVABLE_IN_RETAINED_APPROVAL_SCHEMA',
    scope:'Observed approval, exact command success and new owned Jest cache bytes; no claim about hidden model tool arguments or general filesystem authority.'};
}
function audit(directory) {
  c.contained(root,directory);assert.equal(fs.realpathSync(directory),directory);const manifest=read(ownedFile(directory,path.join(directory,'prepared.json'))),owner=manifest.windows.A;
  assert.equal(manifest.stage,'F2_CLIENT_TEST_AUTHORITY_PROOF');assert.equal(manifest.artifactDir,directory);assert.equal(manifest.preparedBeforeActivation,true);assert.deepEqual(Object.keys(manifest.windows),['A']);
  assert.equal(manifest.maxForwardedInputs,1);assert.equal(manifest.auxiliary.maxInputs,3);assert.equal(manifest.fixture.workspace,owner.workspace);c.contained(directory,owner.directory);c.contained(directory,owner.workspace);
  const {identity:setupIdentity,...setup}=manifest.campaign;pin(setupIdentity);assert.equal(setupIdentity.path,ownedFile(directory,path.join(directory,'proof-setup.json')));assert.deepEqual(read(setupIdentity.path),setup);
  assert.equal(setup.directory,directory);assert.equal(setup.stage,manifest.stage);assert.deepEqual(setup.fixture,manifest.fixture);assert.deepEqual(setup.proof,manifest.proof);assert.equal(setup.maxForwardedInputs,1);assert.equal(setup.maxAuxiliaryInputs,3);
  assert.equal(setup.profile,owner.profile);assert.equal(setup.workspace,owner.workspace);assert.equal(setup.counterFile,manifest.counterFile);assert.equal(setup.auxiliaryCounterFile,manifest.auxiliary.counterFile);
  for(const identity of [setup.seedReport,setup.seedManifest,setup.oracleManifest])pin(identity);
  const seed=read(setup.seedManifest.path).workspaces['seeded-workspace'];for(const[relative,sha256]of Object.entries(seed.files))assert.equal(c.identity(c.exactFile(seed.path,relative)).sha256,sha256);
  for(const[relative,sha256]of Object.entries(read(setup.oracleManifest.path).files))assert.equal(c.identity(path.join(path.dirname(setup.seedReport.path),relative)).sha256,sha256);
  for(const copy of manifest.fixture.dependencyCopies)assert.equal(c.dependencyTree(copy.source).treeSha256,copy.treeSha256,'Original dependency source remains unchanged');
  assert.deepEqual(read(path.join(owner.profile,'.mysti-test-owned.json')),{case:'PB-02',profile:fs.realpathSync(owner.profile),window:'A'});
  const pins=[...manifest.harnessDependencyIdentities,...manifest.wrapperIdentities,...Object.values(manifest.executableIdentities),manifest.nodeIdentity,manifest.sourceIdentity,manifest.packageIdentity,manifest.readiness,manifest.auxiliary.flagEvidenceIdentity];pins.forEach(pin);
  for(const file of [__filename,require.resolve('./codex-f2-test-proof.cjs'),require.resolve('./codex-f2-test-proof-auxiliary.cjs'),require.resolve('./audit-vscode-codex-f2.cjs'),require.resolve('./pb02-f2-test-proof-main-runtime.cjs')])assert(pins.some(row=>row.path===file));
  const source=read(manifest.sourceIdentity.path),pack=read(manifest.packageIdentity.path);
  for(const [relative,expected]of Object.entries({...source.files,...source.testFiles})){const file=path.resolve(repo,relative);c.contained(repo,file);assert.equal(c.identity(file).sha256,expected);}
  assert.equal(pack.sourceSnapshotUnchanged,true);assert.equal(pack.testSnapshotUnchanged,true);assert.equal(c.identity(path.resolve(repo,pack.archive)).sha256,pack.sha256);
  for(const extension of [manifest.sourcePackage,owner.installedExtension]){assert.equal(c.identity(path.join(extension,'dist/extension.js')).sha256,manifest.bundleSha256);assert.equal(c.identity(path.join(extension,'media/chat/chat.js')).sha256,manifest.chatSha256);}
  assert.equal(manifest.bundleSha256,pack.bundleSha256);assert.equal(manifest.chatSha256,pack.chatSha256);
  const file=name=>ownedFile(owner.directory,path.join(owner.directory,name)),rows=paths=>paths.flatMap(value=>fs.readFileSync(ownedFile(owner.directory,value),'utf8').split('\n').filter(Boolean).map(JSON.parse));
  const acceptance=read(file('acceptance.json')),events=read(file('events.json')),observations=read(file('observations.json')),wire=rows(owner.receiptPaths);
  assert.deepEqual(read(file('reply-01.json')),acceptance.reply);assert.equal(read(ownedFile(directory,path.join(directory,'native-result.json'))).status,'PASS');
  const exit=read(file('editor-exit.json')),cleanup=read(file('editor-exit-process-check.json')),ancestry=read(file('process-ancestry.json'));
  assert.equal(exit.code,0);assert.equal(exit.signal,null);assert.equal(exit.timedOut,false);assert.equal(exit.helper.failures,0);assert.equal(exit.helper.normalQuitRequested,true);assert.deepEqual(exit.cleanup,cleanup);assert.equal(cleanup.conversationalInputs,1);assert.equal(cleanup.auxiliaryInputs,0);
  for(const name of ['watchdog-failure.json','driver-fatal.json','window-A/forced-cleanup.json','window-A/driver-error.json','window-A/partial.json'])assert(!fs.existsSync(path.join(directory,name)));
  const launch=read(file('launch.json')),reservation=read(ownedFile(directory,path.join(directory,'launch-reservation.json')));
  assert.equal(launch.extensionTestsPathUsed,false);assert.equal(launch.profile,owner.profile);assert.equal(launch.installedExtension,owner.installedExtension);
  for(const arg of [owner.workspace,`--user-data-dir=${owner.profile}`,`--extensions-dir=${owner.extensionsDir}`])assert(launch.args.includes(arg));assert(!launch.args.some(arg=>/extensionTestsPath/i.test(arg)));
  assert.equal(reservation.plannedConversationRequests,1);assert.equal(reservation.maxTextAuxiliaryInputs,3);
  for(const [name,key]of [['codex-f2-test-proof.test.js','harnessSha256'],['codex-f2-test-proof-observer.js','observerSha256']])assert.equal(c.identity(path.join(manifest.compiledDirectory,name)).sha256,reservation[key]);
  assert.equal(c.identity(path.join(manifest.helper,'extension.cjs')).sha256,reservation.helperSha256);
  const live=execFileSync('/bin/ps',['-axo','pid=,lstart='],{encoding:'utf8',timeout:5000}).trim().split('\n').map(line=>{const match=line.trim().match(/^(\d+)\s+(.+)$/);assert(match);return{pid:+match[1],startedAt:match[2]};});
  const mainTransport=auditMainProcesses(wire,cleanup,ancestry,live),stored=readStoredConversations(owner);
  const conversation=one(stored.conversations.filter(row=>row.id===acceptance.conversationId),'One owned proof conversation');assert(stored.conversations.filter(row=>row.id!==conversation.id).every(row=>!row.messages.length));
  const proof=auditProofEvidence({manifest,acceptance,events,observations,wire,storedConversation:conversation});
  const files=c.verifySnapshot(manifest.fixture,[],[acceptance.panelId]);assert.deepEqual(files,acceptance.files);
  assert.deepEqual(read(manifest.counterFile),{forwardedInputs:1,maxInputs:1});assert(!fs.existsSync(manifest.counterFile+'.lock'));assert(!fs.existsSync(manifest.auxiliary.counterFile+'.lock'));
  const helpers=auxiliary.auditEvidence({auxiliary:manifest.auxiliary,receipts:rows(owner.auxiliaryReceiptPaths),ancestry,cleanup,counter:fs.existsSync(manifest.auxiliary.counterFile)?read(manifest.auxiliary.counterFile):{forwardedInputs:0,maxInputs:3},live,primaryAuxiliaryInputs:0,temporaryRoot:fs.realpathSync(os.tmpdir())});
  const settings=read(path.join(owner.profile,'User/settings.json'));assert.equal(settings['mysti.codexProfile'],'');assert.equal(settings['mysti.codexPath'],owner.wrappers['openai-codex']);assert.equal(settings['mysti.claudeCodePath'],manifest.auxiliary.launcher);assert.equal(settings['mysti.defaultEffortLevel'],'low');
  return {status:mainTransport.status==='PASS_MAIN_TRANSPORT'?'PASS_BOUNDED_AUTHORITY_PROOF':'PARTIAL_MAIN_SHUTDOWN',proof,mainTransport,auxiliary:helpers,
    accounting:{mainInputs:1,mainCap:1,mainLaneAuxiliaryInputs:0,helperInputs:helpers.counts.submitted,helperCap:3},files,pins,checkedAt:new Date().toISOString(),auditor:c.identity(__filename)};
}
module.exports={audit,auditProofTurn,auditProofEvidence,auditApprovalMetadata,auditCacheSnapshot};
if(require.main===module){const directory=path.resolve(process.argv[2]||''),file=path.join(directory,`independent-test-proof-audit-${Date.now()}.json`);try{const result=audit(directory);fs.writeFileSync(file,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({file,status:result.status,proof:result.proof.status}));}catch(error){fs.writeFileSync(file,JSON.stringify({status:'FAIL',error:{name:error.name,message:error.message,stack:error.stack}},null,2)+'\n',{flag:'wx'});console.error(JSON.stringify({file,status:'FAIL',error:error.message}));process.exitCode=1;}}
