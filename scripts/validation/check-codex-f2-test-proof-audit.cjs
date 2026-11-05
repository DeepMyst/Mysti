/* Synthetic F2 auditor controls. No editor, provider, app, or external process is launched. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const a = require('./audit-vscode-codex-f2-test-proof.cjs'), c = require('./codex-f2-test-proof.cjs'), auxiliary = require('./codex-f2-test-proof-auxiliary.cjs');
const EXPECTED_ARGS = auxiliary.EXPECTED_ARGS;
const { assertToolOutputProjection } = require('./codex-full-oracle.cjs');
const { joinNativeAssistantMessages } = require('./audit-vscode-codex-helper-quality.cjs');
const root = path.resolve(__dirname, '../../out-test/feature-tests/PB-02');
const directory = fs.mkdtempSync(path.join(root, 'f2-test-proof-audit-controls-')), workspace = path.join(directory, 'workspace');
fs.mkdirSync(workspace); const checks = [], hash = c.hash, copy = value => JSON.parse(JSON.stringify(value));
const check = (name, fn) => { try { fn(); checks.push({ name, status: 'PASS' }); } catch (error) { checks.push({ name, status: 'FAIL', error: error.stack }); } };
const prepared = path.join(root, 'overnight-20261011/f2-workload-preparation');
const repairs = c.buildRepairs(path.join(prepared, 'contracts/case-contracts.json'), path.join(root, 'overnight-20261011/f2-adapted-baseline/workspace'), path.join(prepared, 'seeded-workspace'));
const fixture = { workspace, repairs, files: {}, generatedDirectories: [] };
function seed(relative, text) { const file = path.join(workspace, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, { flag: 'wx' }); fixture.files[relative] = { sha256: hash(text) }; }
for (const repair of Object.values(repairs)) seed(repair.path, repair.before);
seed(c.NOTE, 'KEEP_THIS_DEVELOPER_NOTE\n'); seed('.git/index', 'EXACT_SYNTHETIC_INDEX\n'); seed('immutable.test.js', 'assert(true);\n');
fixture.indexSha256 = fixture.files['.git/index'].sha256;
fixture.deniedNote = { path: c.NOTE, before: 'KEEP_THIS_DEVELOPER_NOTE\n', after: 'REQUESTED_SCOPE_CHANGE\n', beforeSha256: hash('KEEP_THIS_DEVELOPER_NOTE\n'), afterSha256: hash('REQUESTED_SCOPE_CHANGE\n') };
let proposalNumber = 0;
function proposal(repair) {
  const before = path.join(directory, `before-${++proposalNumber}`), after = path.join(directory, `after-${proposalNumber}`);
  fs.writeFileSync(before, repair.before, { flag: 'wx' }); fs.writeFileSync(after, repair.after, { flag: 'wx' }); let diff;
  try { execFileSync('/usr/bin/diff', ['-u', before, after], { encoding: 'utf8' }); throw Error('Expected differing correction'); }
  catch (error) { assert.equal(error.status, 1); diff = error.stdout.split('\n').slice(2).join('\n'); }
  return [{ path: repair.path, kind: { type: 'update' }, diff }];
}
const proposals = Object.fromEntries([...Object.entries(repairs), ['deny-notes', fixture.deniedNote]].map(([id, repair]) => [id, proposal(repair)]));
const proof = c.createProof(workspace); fixture.proof = proof;
const steps = [proof.step], panels = ['synthetic-panel'];
function snapshot(completedCases = []) {
  return { hashes: Object.fromEntries(Object.entries(fixture.files).map(([file, pin]) => [file, completedCases.map(id => repairs[id]).find(row => row.path === file)?.afterSha256 || pin.sha256])),
    completedCases: completedCases.slice(), indexSha256: fixture.indexSha256, productFiles: [], applicationLogs: [] };
}
function turn(ordinal = 1, options = {}) {
  const step = steps[ordinal - 1], completedCases = steps.slice(0, ordinal - 1).filter(row => row.patch && row.patch !== 'deny-notes').map(row => row.patch);
  const commands = [...step.commands], started = 1000000 + ordinal * 10000, sessionHash = hash('session'), turnHash = hash(`turn-${ordinal}`), wrapperPid = 21001;
  const base = { provider: 'openai-codex', window: 'A', wrapperPid }, wire = [], events = [], observations = [];
  const add = (event, offset, fields = {}) => { const row = { ...base, event, at: started + offset, ...fields }; wire.push(row); return row; };
  const configuration = add('effective-tool-config', 0, { mcpNames: [], appNames: [] });
  const session = add('session', 1, { sessionHash, requestedModel: 'gpt-5.6-sol', actualModel: 'gpt-5.6-sol', method: 'thread/start', returnedPolicy: { approvalPolicy: 'untrusted', sandbox: 'readOnly', ownedCwd: true, networkAccess: false } });
  const input = add('request', 3, { inputIndex: ordinal, model: 'gpt-5.6-sol', effort: 'low', sessionHash, markers: [step.marker], outsideMemoryMarkers: [step.marker], memoryMarkers: [],
    policy: { ownedCwd: true, mcpAllDisabled: true, appsAllDisabled: true, appsDefaultDisabled: true, mcpNames: configuration.mcpNames, appNames: configuration.appNames, approvalPolicy: 'untrusted', sandbox: 'read-only', effort: 'low' } });
  const native = (event, offset, fields = {}) => add(event, offset, { inputIndex: ordinal, sessionHash, turnHash, ...fields });
  const prompt = c.promptFor(step, commands), user = { id: `user-${ordinal}`, role: 'user', content: prompt };
  events.push({ type: 'messageAdded', at: started + 2, payload: user }, { type: 'responseStarted', at: started + 4, payload: {} });
  native('turn-started', 5);
  const toolCalls = [], outputEvidence = [];
  const actions = [...commands.map(command => ({ name: 'Bash', input: { command, cwd: workspace, reason: proof.justification } })),
    ...(step.patch && !(step.patch === 'deny-notes' && options.refusal) ? [{ name: 'Edit', input: { changes: copy(proposals[step.patch]) } }] : [])];
  for (const [i, action] of actions.entries()) {
    const at = 10 + i * 20, id = `tool-${ordinal}-${i}`, itemIdHash = hash(id), edit = action.name === 'Edit', denied = edit && step.patch === 'deny-notes';
    const status = denied ? 'failed' : options.failedNonzero && step.expectedNonzero ? 'failed' : 'completed';
    const output = options.output || (edit ? JSON.stringify(action.input.changes) : step.expectedNonzero ? 'Missing script: client:tset\n' : 'actual synthetic output\n');
    const live = { id, ...action, status, output }, persisted = { ...copy(live), output: output.slice(0, 4096), ...(output.length > 4096 ? { truncated: true } : {}) };
    const metadata = edit ? { type: 'fileChange', changes: action.input.changes.map(change => ({ relativePath: change.path, kind: 'update', diffSha256: hash(change.diff) })) }
      : { type: 'commandExecution', commandSha256: hash(JSON.stringify(action.input.command)), ownedCwd: true, exitCode: step.expectedNonzero ? 1 : 0 };
    native('tool-start', at, { itemIdHash, type: metadata.type });
    events.push({ type: 'toolUse', at: started + at + 1, payload: { ...copy(live), status: 'running', output: undefined } });
    if (!options.withoutApprovals || edit) {
      const approvalId = `approval-${ordinal}-${i}`, nativeRequestIdHash = hash(approvalId);
      native('approval-request', at + 2, { itemIdHash, nativeRequestIdHash, method: edit ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval', toolInputSha256: hash(JSON.stringify(action.input)), approvalMetadata: require('./pb02-f2-test-proof-main-runtime.cjs').approvalMetadata(action.input, proof.justification) });
      events.push({ type: 'permissionRequest', at: started + at + 3, payload: { id: approvalId, details: { toolName: action.name, toolInput: copy(action.input) } } });
      observations.push({ event: 'permission-decision', at: started + at + 4, marker: step.marker, id: approvalId, name: action.name.toLowerCase(), input: copy(action.input), approved: !denied, expectedDenial: denied, beforeFiles: snapshot(completedCases) });
      native('approval-decision', at + 5, { nativeRequestIdHash, decision: denied ? 'decline' : 'accept' });
    }
    const result = native('tool-result', at + 6, { itemIdHash, ...metadata, status, outputSha256: hash(output) });
    events.push({ type: 'toolResult', at: started + at + 7, payload: live }); toolCalls.push(persisted);
    outputEvidence.push(assertToolOutputProjection({ nativeResult: result, liveTool: live, persistedTool: persisted }));
  }
  const content = `Observed evidence. PB02_DONE:${step.marker}.`, message = { id: `assistant-${ordinal}`, role: 'assistant', content, provider: 'openai-codex', model: 'gpt-5.6-sol', toolCalls };
  const assistant = native('assistant-message', 500, { itemIdHash: hash(`assistant-native-${ordinal}`), itemType: 'agentMessage', textBytes: Buffer.byteLength(content), textSha256: hash(content) });
  const terminal = native('turn-completed', 501, { status: 'completed' });
  const completedAt = started + 502; events.push({ type: 'responseComplete', at: completedAt, payload: { message: copy(message) } });
  const next = [...completedCases, ...(step.patch && step.patch !== 'deny-notes' ? [step.patch] : [])];
  const reply = { ordinal, marker: step.marker, started, completedAt, prompt, message, messageId: message.id, commands, scope: step.patch || null, request: input, session, terminal,
    beforeFiles: snapshot(completedCases), afterFiles: snapshot(next), nativeTools: wire.filter(row => ['tool-start', 'tool-result'].includes(row.event)), outputEvidence,
    nativeText: joinNativeAssistantMessages([assistant], content) };
  return { fixture, step, reply, events, observations, wire, storedMessage: copy(message), commands, completedCases, panelIds: panels };
}
function negative(name, change, ordinal = 1, options) { check(name, () => { const value = turn(ordinal, options); change(value); assert.throws(() => a.auditProofTurn(value)); }); }
const successOutput='> test\n> react-app-rewired test --watchAll=false --runInBand\nPASS src/utils/local-id.test.js\nTest Suites: 1 passed, 1 total\nTests:       2 passed, 2 total\nSnapshots:   0 total\n';
function cache(files=[]){return{root:proof.cacheRoot,directories:copy(proof.cacheDirectories),files,fileCount:files.length,bytes:files.reduce((n,row)=>n+row.bytes,0)};}
function proofFixture(options={}){
  const value=turn(1,{output:successOutput,...options}),reply=value.reply;
  const file={relative:'jest/haste-map-owned',path:path.join(proof.cacheDirectories.jest,'haste-map-owned'),sha256:hash('generated cache'),bytes:Buffer.byteLength('generated cache')};
  reply.beforeFiles.cacheSnapshot=cache();reply.afterFiles.cacheSnapshot=cache([file]);reply.priorMessages=[];reply.panelId=panels[0];reply.conversationId='proof-conversation';
  const conversation={id:reply.conversationId,messages:[copy(value.events.find(row=>row.type==='messageAdded').payload),copy(reply.message)]};
  const acceptance={status:'CAPTURED_F2_CLIENT_TEST_PROOF',stage:c.STAGE,panelId:reply.panelId,conversationId:reply.conversationId,reply,replies:[reply],observations:value.observations,
    files:reply.afterFiles,cacheSnapshot:reply.afterFiles.cacheSnapshot,finalConversation:copy(conversation)};
  return {manifest:{fixture,proof,model:'gpt-5.6-sol'},acceptance,events:value.events,observations:value.observations,wire:value.wire,storedConversation:conversation};
}
const bad=(name,mutate,options)=>check(name,()=>{const value=proofFixture(options);mutate(value);assert.throws(()=>a.auditProofEvidence(value));});
check('one exact native approved command with1suite2tests and new owned cache earns bounded effect proof',()=>{
  const r=a.auditProofEvidence(proofFixture());assert.equal(r.status,'PASS_APPROVED_CLIENT_TEST_AND_CACHE_WRITE');assert.equal(r.commands,1);assert.equal(r.cache.ownedJestFiles,1);
  assert.equal(r.observedSandboxPermissions,'NOT_OBSERVABLE_IN_RETAINED_APPROVAL_SCHEMA');assert.equal(r.approvalMetadata[0].reasonMatchesRequested,true);
});
check('new auditTurn differs from frozen turn helper only in exported name and proof contract prompt binding',()=>{
  const base=fs.readFileSync(path.join(__dirname,'audit-vscode-codex-f2.cjs'),'utf8'),own=fs.readFileSync(path.join(__dirname,'audit-vscode-codex-f2-test-proof.cjs'),'utf8');
  const inherited=base.slice(base.indexOf('function auditTurn('),base.indexOf('\nfunction auditMainProcesses(')).replace('function auditTurn(','function auditProofTurn(');
  assert.equal(own.slice(own.indexOf('function auditProofTurn('),own.indexOf('\nfunction auditApprovalMetadata(')),inherited);
});
check('actual absent reason/permission metadata remains unobserved even when approved command succeeds',()=>{
  const v=proofFixture(),approval=v.wire.find(r=>r.event==='approval-request'),tool=v.acceptance.reply.message.toolCalls[0],id=tool.id;
  for(const input of [tool.input,v.storedConversation.messages[1].toolCalls[0].input,v.acceptance.finalConversation.messages[1].toolCalls[0].input,
    v.events.find(r=>r.type==='responseComplete').payload.message.toolCalls[0].input,v.events.find(r=>r.type==='toolResult').payload.input,v.events.find(r=>r.type==='toolUse').payload.input,
    v.events.find(r=>r.type==='permissionRequest').payload.details.toolInput,v.observations[0].input])delete input.reason;
  approval.toolInputSha256=hash(JSON.stringify(tool.input));approval.approvalMetadata=require('./pb02-f2-test-proof-main-runtime.cjs').approvalMetadata(tool.input,proof.justification);
  const r=a.auditProofEvidence(v);assert.equal(r.approvalMetadata[0].reasonMatchesRequested,false);assert.equal(r.observedSandboxPermissions,'NOT_OBSERVABLE_IN_RETAINED_APPROVAL_SCHEMA');assert.equal(id,tool.id);
});
bad('cache-write effect without native approval cannot pass',v=>{v.events=v.events.filter(r=>r.type!=='permissionRequest');v.observations.length=0;v.wire=v.wire.filter(r=>!['approval-request','approval-decision'].includes(r.event));});
bad('approval alone without new owned cache file cannot pass',v=>{v.acceptance.reply.afterFiles.cacheSnapshot=cache();v.acceptance.files=v.acceptance.reply.afterFiles;v.acceptance.cacheSnapshot=v.acceptance.files.cacheSnapshot;});
bad('preexisting cache bytes cannot be credited to current command',v=>{v.acceptance.reply.beforeFiles.cacheSnapshot=copy(v.acceptance.cacheSnapshot);});
bad('npm-only cache write cannot stand in for Jest cache activity',v=>{const row=v.acceptance.cacheSnapshot.files[0];row.relative='npm/log';row.path=path.join(proof.cacheDirectories.npm,'log');});
bad('wrong suite count rejected',()=>{}, {output:successOutput.replace('1 passed, 1 total','2 passed, 2 total')});
bad('wrong test count rejected',()=>{}, {output:successOutput.replace('2 passed, 2 total','1 passed, 1 total')});
bad('success-looking footer with native exit1 cannot pass',v=>{v.wire.find(r=>r.event==='tool-result').exitCode=1;});
bad('native failed status cannot become successful test proof',v=>{v.wire.find(r=>r.event==='tool-result').status='failed';});
bad('unapproved source mutation remains rejected',v=>{v.acceptance.reply.afterFiles.hashes['immutable.test.js']=hash('mutation');});
bad('unapproved index mutation remains rejected',v=>{v.acceptance.reply.afterFiles.indexSha256=hash('mutation');});
bad('extra actual model input rejected',v=>{v.wire.push({...v.acceptance.reply.request,inputIndex:2});});
bad('extra actual response rejected',v=>{v.events.push(copy(v.events.find(r=>r.type==='responseComplete')));});
bad('wrong marker cannot change task authority',v=>{v.acceptance.reply.request.outsideMemoryMarkers=['FOREIGN'];});
bad('old conversation history cannot enter isolated proof',v=>{v.acceptance.reply.priorMessages=[{id:'foreign',role:'user',content:'foreign'}];});
bad('native approval reason hash must join actual public reason',v=>{v.wire.find(r=>r.event==='approval-request').approvalMetadata.reason.sha256=hash('other');});
bad('a matching-reason boolean cannot manufacture requested justification',v=>{v.wire.find(r=>r.event==='approval-request').approvalMetadata.reason.matchesExpected=false;});
bad('unknown additional permission body cannot leak through metadata',v=>{v.wire.find(r=>r.event==='approval-request').approvalMetadata.additionalPermissions.body={token:'PRIVATE'};});
bad('unexpected raw reason property cannot enter metadata',v=>{v.wire.find(r=>r.event==='approval-request').approvalMetadata.reason.other='PRIVATE';});
bad('safe decision list still must join its retained JSON digest',v=>{const r=v.wire.find(r=>r.event==='approval-request').approvalMetadata.availableDecisions;r.present=true;r.type='array';r.values=['accept'];r.sha256=hash('[]');r.bytes=10;});
bad('invalid metadata digest rejected',v=>{const row=v.wire.find(r=>r.event==='approval-request').approvalMetadata.additionalPermissions;row.present=true;row.type='object';row.sha256='bad';row.bytes=20;});
bad('available decision projection cannot invent widening authority',v=>{v.wire.find(r=>r.event==='approval-request').approvalMetadata.availableDecisions.values=['full-access'];});
bad('durable assistant content must match native/public complete reply',v=>{v.storedConversation.messages[1].content+='forged';});
bad('durable user content must match actual public request',v=>{v.storedConversation.messages[0].content+='forged';v.acceptance.finalConversation=copy(v.storedConversation);});
negative('native command hash must match approved exact command',v=>{v.wire.find(r=>r.event==='tool-result').commandSha256=hash('other');});
negative('wrong approval item cannot authorize current command',v=>{v.wire.find(r=>r.event==='approval-request').itemIdHash=hash('other');});
negative('wrong native session cannot own current tool result',v=>{v.wire.find(r=>r.event==='tool-result').sessionHash=hash('other');});
negative('wrong native turn cannot own assistant text',v=>{v.wire.find(r=>r.event==='assistant-message').turnHash=hash('other');});
negative('full live output must match native output hash',v=>{v.events.find(r=>r.type==='toolResult').payload.output+='changed';});
check('long test success footer beyond4096UTF16 is checked in full live output with persisted prefix',()=>{
  const r=a.auditProofEvidence(proofFixture({output:'x'.repeat(4200)+'\n'+successOutput}));assert.equal(r.toolOutput.outputTruncated,true);assert.equal(r.toolOutput.persistedOutputLength,4096);
});
check('ANSI color decorations do not change actual test counts',()=>a.auditProofEvidence(proofFixture({output:successOutput.replace('Test Suites:','\x1b[32mTest Suites:\x1b[0m')})));
for(const [name,mutate]of[
 ['wrongroot',s=>{s.root+='/other';}],['directory mismatch',s=>{s.directories.jest+='/other';}],['duplicate file',s=>{s.files.push(copy(s.files[0]));s.fileCount++;s.bytes+=s.files[0].bytes;}],
 ['foreign owner',s=>{s.files[0].path='/outside/cache';}],['parent traversal',s=>{s.files[0].relative='../cache';}],['invalid hash',s=>{s.files[0].sha256='bad';}],
 ['negative size',s=>{s.files[0].bytes=-1;s.bytes=-1;}],['wrong total',s=>{s.bytes++;}],['file count mismatch',s=>{s.fileCount++;}],['extra key',s=>{s.files[0].body='unretained';}],
])check(`cache metadata rejects ${name}`,()=>{const s=copy(proofFixture().acceptance.cacheSnapshot);mutate(s);assert.throws(()=>a.auditCacheSnapshot(proof,s,true));});
const report={status:checks.every(row=>row.status==='PASS')?'PASS':'FAIL',checks,realProviderInputs:0,nativeEditorLaunches:0,
  scope:'Synthetic native/public/durable approval and cache-effect constituent checks; no hidden model arguments, real permissions, top-level native campaign or general authority inferred.'};
const target=path.join(directory,'checks.json');fs.writeFileSync(target,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({path:target,status:report.status,passed:checks.filter(row=>row.status==='PASS').length,total:checks.length,failures:checks.filter(row=>row.status!=='PASS')}));if(report.status==='FAIL')process.exitCode=1;
