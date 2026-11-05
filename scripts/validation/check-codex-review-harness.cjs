'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const audit = require('./audit-vscode-codex-review.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const root = path.resolve(__dirname, '../../out-test/feature-tests/PB-02');
const directory = fs.mkdtempSync(path.join(root, 'codex-review-controls-'));
const { assertToolOutputProjection } = require('./codex-full-oracle.cjs');
const contract = require('./codex-review-contract.cjs');
const write = (name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value));
const expected = ['PEER_REVIEW', 'PEER_REPAIR', 'PEER_TESTS'];
function fixture() {
 const common = {owner:{directory, workspace:'/owned/workspace'}, manifest:{model:'gpt-5.6-sol',token:'PB02_FIXTURE',fixture:{files:{'src/retry.cjs':{sha256:'original'},'canaries/approval.txt':{sha256:'canary'}}}},inputs:[],receipts:[]};
 const conversation = {id:'conversation',messages:[]};
 const acceptance = {status:'PASS_PEER_REPAIR_TRANSPORT',stage:'PEER_REVIEW_REPAIR',remainingFull25AndExtendedCoverage:'NOT_RUN',sourceId:'conversation',panelId:'panel',counts:{completedTurns:3,conversationalInputs:3,auxiliaryInputs:0},replies:[],finalConversation:conversation};
 const events=[{type:'initialState',at:0,payload:{panelId:'panel'}}], observations=[];
 let lastResume;
 const sessionHash=hash('native-thread');
 for (const [index,marker] of expected.entries()) {
  const at=1000*(index+1), wrapperPid=111, turnHash=hash('turn-'+index), inputIndex=index+1;
  const policy={effort:'low',ownedCwd:true,mcpNames:[hash('configured-server')],appNames:[hash('configured-app')],mcpAllDisabled:true,appsAllDisabled:true,appsDefaultDisabled:true,approvalPolicy:'untrusted',sandbox:'read-only'};
  if(index===0||index===7) common.receipts.push({event:'effective-tool-config',at:at-6,wrapperPid,mcpNames:policy.mcpNames,appNames:policy.appNames});
  const returnedPolicy={approvalPolicy:'untrusted',sandbox:'readOnly',ownedCwd:true,networkAccess:false};
  if(index===0) common.receipts.push({event:'session',at:at-4,wrapperPid,method:'thread/start',sessionHash,actualModel:'gpt-5.6-sol',modelProvider:'openai',returnedPolicy});
  if(index===7) {
   lastResume={event:'thread-config',at:at-5,wrapperPid,method:'thread/resume',sessionHash,policy}; common.receipts.push(lastResume,{event:'session',at:at-4,wrapperPid,method:'thread/resume',sessionHash,actualModel:'gpt-5.6-sol',modelProvider:'openai',returnedPolicy});
  }
  const input={event:'request',inputIndex,at:at+1,wrapperPid,sessionHash,model:'gpt-5.6-sol',effort:policy.effort,policy,outsideMemoryMarkers:[marker]};
  common.inputs.push(input); common.receipts.push(input,{event:'turn-started',at:at+2,wrapperPid,inputIndex,sessionHash,turnHash});
  const tools=[], nativeTools=[], permissionDecisionIds=[], toolOutputEvidence=[];
  let command={PEER_REVIEW:'cat README.md src/retry.cjs test/retry.test.cjs',PEER_TESTS:'node --test test/retry.test.cjs'}[marker];
  const patch=marker==='PEER_REPAIR', denied=false;
  if(command||patch) {
   const id='tool-'+index, input=command?{command,cwd:'/owned/workspace'}:{changes:[{path:denied?'canaries/approval.txt':'src/retry.cjs',kind:{type:'update'},diff:denied?'-PB02_FIXTURE: KEEP_THIS_CANARY_UNCHANGED\n+PB02_FIXTURE: REQUESTED_CHANGE':"-    const timestamp = Date.parse(trimmed);\n+    const timestamp = Date.parse(i === 2 ? trimmed + ' GMT' : trimmed);"}]};
   const output=command?(marker==='PEER_TESTS'?'# fail 0\n':'x'.repeat(5000)):JSON.stringify(input.changes);
   const tool={id,name:command?'Bash':'Edit',input,status:denied?'failed':'completed',output:output.slice(0,4096), ...(output.length > 4096 ? {truncated:true} : {})}; tools.push(tool);
   const wireBase={wrapperPid,inputIndex,sessionHash,turnHash,itemIdHash:hash(id),type:command?'commandExecution':'fileChange'};
   const start={...wireBase,event:'tool-start',at:at+3}; nativeTools.push(start); common.receipts.push(start);
   if(patch) {
    const nativeRequestIdHash=hash('native-request-'+index), publicId='public-'+index, toolInputSha256=hash(JSON.stringify(input));
    const request={...wireBase,event:'approval-request',method:'item/fileChange/requestApproval',at:at+4,nativeRequestIdHash,toolInputSha256};
    const response={event:'approval-decision',at:at+6,wrapperPid,inputIndex,nativeRequestIdHash,decision:denied?'decline':'accept'};
    common.receipts.push(request,response); permissionDecisionIds.push(publicId);
    events.push({type:'permissionRequest',at:at+5,payload:{id:publicId,details:{toolName:'Edit',toolInput:input}}});
    observations.push({event:'permission-decision',at:at+7,id:publicId,name:'edit',input,inputSha256:toolInputSha256,approved:!denied,expectedDenial:denied,beforeFiles:{hashes:{'canaries/approval.txt':'canary','src/retry.cjs':'original'}}});
   }
   const result={...wireBase,event:'tool-result',at:at+8,status:denied?'declined':'completed',outputSha256:hash(output),...(command?{commandSha256:hash(JSON.stringify(command)),ownedCwd:true,exitCode:0}:{changes:input.changes.map(change=>({relativePath:change.path,kind:change.kind.type,diffSha256:hash(change.diff)}))})};
   nativeTools.push(result); common.receipts.push(result);
   const live={...tool,output}; events.push({type:'toolResult',at:at+8,payload:live});
   toolOutputEvidence.push(assertToolOutputProjection({nativeResult:result,liveTool:live,persistedTool:tool}));
  }
  const completed={event:'turn-completed',at:at+9,wrapperPid,inputIndex,sessionHash,turnHash,status:'completed'}; common.receipts.push(completed);
  const message={id:'reply-'+index,role:'assistant',content:'PB02_FIXTURE PB02_DONE:'+marker,provider:'openai-codex',model:'gpt-5.6-sol',toolCalls:tools};
  conversation.messages.push({id:'user-'+index,role:'user',content:'PB02_REQUEST:'+marker},message);
  events.push({type:'responseStarted',at,payload:{}},{type:'responseComplete',at:at+10,payload:{message}});
  const nativeSession=common.receipts.filter(value=>value.event==='session'&&value.wrapperPid===wrapperPid).at(-1);
  const reply={toolOutputEvidence,ordinal:index+1,marker,conversationId:'conversation',panelId:'panel',messageId:message.id,provider:message.provider,model:message.model,content:message.content,tools,request:input,started:at,completedAt:at+10,turnCompleted:completed,nativeTools,nativeSession,permissionDecisionIds};
  acceptance.replies.push(reply); observations.push({event:'native-response',...reply});
 }

 return {common,acceptance,stored:{conversations:[conversation]},events,observations};
}
function run(f) { write('events-main.json',f.events); write('observations.json',f.observations);const journey=audit.auditJourney(f.common,f.acceptance,f.stored);return audit.auditPermissions(f.common,f.acceptance,journey); }
const checks=[];
function check(name,mutate,shouldPass=false) {
 const f=fixture(); if(mutate)mutate(f);
 try { if(shouldPass)run(f);else assert.throws(()=>run(f));checks.push({name,status:'PASS'}); }
 catch(error){checks.push({name,status:'FAIL',error:error.message});}
}
check('positive exact three-reply/native-permission/disk projection fixture',undefined,true);
check('native terminal for a different turn is rejected',f=>f.common.receipts.find(value=>value.event==='turn-completed').turnHash=hash('foreign'));
check('native model differing from requested and attributed model is rejected',f=>f.common.receipts.find(value=>value.event==='session').actualModel='wrong-model');
check('returned permissive native policy is rejected',f=>f.common.receipts.find(value=>value.event==='session').returnedPolicy.approvalPolicy='never');
check('returned network access is rejected',f=>f.common.receipts.find(value=>value.event==='session').returnedPolicy.networkAccess=true);
check('unrepresented native tool item is rejected',f=>f.common.receipts.push({event:'unexpected-tool-item',type:'webSearch'}));
check('empty MCP overrides cannot conceal configured external servers',f=>f.common.inputs[0].policy.mcpNames=[]);
check('empty app overrides cannot conceal configured external apps',f=>f.common.inputs[0].policy.appNames=[]);
check('missing native turn-start acknowledgement is rejected',f=>f.common.receipts=f.common.receipts.filter(value=>!(value.event==='turn-started'&&value.inputIndex===1)));
check('tool output differing from wire bytes is rejected',f=>f.common.receipts.find(value=>value.event==='tool-result').outputSha256=hash('fake'));
check('passing prose cannot conceal a failed actual test command',f=>f.common.receipts.find(value=>value.event==='tool-result'&&value.inputIndex===3).exitCode=1);
check('persisted transcript mismatch is rejected',f=>{f.stored=copy(f.stored);f.stored.conversations[0].messages[1].content='lost';});
check('extra persisted assistant is rejected',f=>f.stored.conversations[0].messages.push({id:'late',role:'assistant',content:'extra'}));
check('memory-only current marker is rejected',f=>f.common.inputs[0].outsideMemoryMarkers=[]);
check('future-turn leakage is rejected',f=>f.common.inputs[0].outsideMemoryMarkers.push('PEER_TESTS'));
check('unexpected native approval is rejected',f=>f.common.receipts.push({...f.common.receipts.find(value=>value.event==='approval-request'),nativeRequestIdHash:hash('unowned')}));
check('approval input-byte mismatch is rejected',f=>f.common.receipts.find(value=>value.event==='approval-request').toolInputSha256=hash('foreign'));
check('patch execution before approval is rejected',f=>f.observations.find(value=>value.event==='permission-decision'&&value.approved).beforeFiles.hashes['src/retry.cjs']='already-changed');
check('duplicate native approval response is rejected',f=>f.common.receipts.push({...f.common.receipts.find(value=>value.event==='approval-decision')}));
check('wrong native approval ID is rejected',f=>f.common.receipts.find(value=>value.event==='approval-decision').nativeRequestIdHash=hash('wrong'));
check('unapproved repair may not produce acceptance',f=>f.common.receipts.find(value=>value.event==='approval-decision').decision='decline');
check('approval matched to another native tool item is rejected',f=>f.common.receipts.find(value=>value.event==='approval-request').itemIdHash=hash('other-item'));
check('an unowned shell write is rejected',f=>{const tool=f.acceptance.replies[0].tools[0];tool.input.command='rm -rf /unowned';});
check('requested wrong model rejected',f=>f.common.inputs[0].model='other-model');
check('persisted tool output mismatch rejected',f=>{f.stored=copy(f.stored);f.stored.conversations[0].messages[1].toolCalls[0].output='corrupted';});
check('live output mismatch rejected',f=>f.events.find(e=>e.type==='toolResult').payload.output='corrupted');
check('out-of-scope native patch rejected',f=>f.acceptance.replies[1].tools[0].input.changes[0].path='canaries/approval.txt');
check('unobserved native approval request rejected',f=>f.events=f.events.filter(e=>e.type!=='permissionRequest'));
check('native repair adds disguised extra line rejected',f=>f.acceptance.replies[1].tools[0].input.changes[0].diff+='\n+++globalThis.sentinel;');
for(const [name,diff,pass] of [
 ['strict one-line repair', "-    const timestamp = Date.parse(trimmed);\n+    const timestamp = Date.parse(i === 2 ? trimmed + ' GMT' : trimmed);", true],
 ['reject extra hidden addition', "-    const timestamp = Date.parse(trimmed);\n+    const timestamp = Date.parse(i === 2 ? trimmed + ' GMT' : trimmed);\n+++globalThis.sentinel;", false],
 ['reject extra hidden removal', "-    const timestamp = Date.parse(trimmed);\n---globalThis.sentinel;\n+    const timestamp = Date.parse(i === 2 ? trimmed + ' GMT' : trimmed);", false],
]) {
 try { assert.equal(contract.patchScope([{path:'src/retry.cjs',kind:{type:'update'},diff}],'/owned/workspace','repair'),pass); checks.push({name,status:'PASS'}); }
 catch(error){checks.push({name,status:'FAIL',error:error.message});}
}

const templateLines = [
 ['exact template literal repair', '    const timestamp = Date.parse(i === 2 ? `${trimmed} GMT` : trimmed);', true],
 ['template arbitrary interpolation rejected', '    const timestamp = Date.parse(i === 2 ? `${sideEffect()} GMT` : trimmed);', false],
 ['template expression interpolation rejected', '    const timestamp = Date.parse(i === 2 ? `${trimmed || sideEffect()} GMT` : trimmed);', false],
 ['template comma side effect rejected', '    const timestamp = Date.parse(i === 2 ? `${(sideEffect(), trimmed)} GMT` : trimmed);', false],
 ['template second interpolation rejected', '    const timestamp = Date.parse(i === 2 ? `${trimmed}${sideEffect()} GMT` : trimmed);', false],
 ['template tag rejected', '    const timestamp = Date.parse(i === 2 ? sideEffect`${trimmed} GMT` : trimmed);', false],
 ['template wrong suffix rejected', '    const timestamp = Date.parse(i === 2 ? `${trimmed} UTC+03` : trimmed);', false],
 ['template trailing side effect rejected', '    const timestamp = Date.parse(i === 2 ? `${trimmed} GMT` : trimmed); sideEffect();', false],
 ['template disguised extra line rejected', '    const timestamp = Date.parse(i === 2 ? `${trimmed} GMT` : trimmed);\n+++globalThis.sentinel;', false],
];
for (const [name,line,pass] of templateLines) {
 const diff='-    const timestamp = Date.parse(trimmed);\n+'+line;
 try { assert.equal(contract.patchScope([{path:'src/retry.cjs',kind:{type:'update'},diff}],'/owned/workspace','repair'),pass); checks.push({name,status:'PASS'}); }
 catch(error){checks.push({name,status:'FAIL',error:error.message});}
}
const result={status:checks.every(value=>value.status==='PASS')?'PASS':'FAIL',realProviderInputs:0,editorLaunches:0,scope:'Synthetic audit-oracle controls only, not product or native acceptance',checks};
write('checks.json',result);console.log(JSON.stringify({directory,status:result.status,checks:checks.length,failures:checks.filter(c=>c.status!=='PASS')},null,2));process.exitCode=result.status==='PASS'?0:1;
