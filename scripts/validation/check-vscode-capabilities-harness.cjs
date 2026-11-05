/* Synthetic harness controls only. No real editor, account, clipboard, or backend. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict'), vm = require('node:vm');
const { spawn } = require('node:child_process'), { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const ts = require('typescript');
const { createCapabilitiesCli } = require('./capabilities-cli-fixture.cjs');
const { assertCopilotPromptHistoryRequest, matchesPublicModelSelection, assertUnavailableCopilotModelAttempt, assertClaudePeerHandoff } = require('./capabilities-request-oracle.cjs');
const repo = path.resolve(__dirname, '../..'), root = path.join(repo, 'out-test/feature-tests/PC-12'); fs.mkdirSync(root, {recursive:true});
const directory = fs.mkdtempSync(path.join(root, 'harness-controls-')), token = 'PC12_CONTROL_TOKEN', handoffToken = 'PC12_REVIEW_0123456789abcdef0123', checks = [];
const hash = value => createHash('sha256').update(value).digest('hex');
const fake = path.join(directory, 'fake-backend.cjs');
fs.writeFileSync(fake, `const fs=require('fs');const args=process.argv.slice(2);const destination=args.shift();fs.writeFileSync(destination,JSON.stringify({args}));
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{fs.writeFileSync(destination,JSON.stringify({args,input}));});
const events=[null,{message:{content:{unexpected:'shape'}}},'ordinary unstructured output',
{type:'session.auto_mode_resolved',data:{chosenModel:'real-resolved-model'}},{type:'model.call_start',data:{model:'real-resolved-model'}},
{type:'tool.execution_start',data:{toolCallId:'tool-control',toolName:'view',arguments:{path:'src/issues.cjs'}}},
{type:'tool.execution_complete',data:{toolCallId:'tool-control',success:true,result:{content:'${token}'}}},
{type:'assistant',message:{content:[null,{type:'tool_use',id:'read-control',name:'Read',input:{file_path:'src/issues.cjs'}}]}},
{type:'user',message:{content:[{type:'tool_result',tool_use_id:'read-control',content:'${token}'}]}}];
const output=events.map(x=>typeof x==='string'?x:JSON.stringify(x)).join('\\n')+'\\nUTF8: \\u2603 \\ud83d\\udc69\\u200d\\ud83d\\udcbb\\n';
const bytes=Buffer.from(output);let i=0;function emit(){if(i>=bytes.length)return;process.stdout.write(bytes.subarray(i,i+1));i++;setImmediate(emit);}emit();
`);
const expectedOutput = [null,{message:{content:{unexpected:'shape'}}},'ordinary unstructured output',
  {type:'session.auto_mode_resolved',data:{chosenModel:'real-resolved-model'}},{type:'model.call_start',data:{model:'real-resolved-model'}},
  {type:'tool.execution_start',data:{toolCallId:'tool-control',toolName:'view',arguments:{path:'src/issues.cjs'}}},
  {type:'tool.execution_complete',data:{toolCallId:'tool-control',success:true,result:{content:token}}},
  {type:'assistant',message:{content:[null,{type:'tool_use',id:'read-control',name:'Read',input:{file_path:'src/issues.cjs'}}]}},
  {type:'user',message:{content:[{type:'tool_result',tool_use_id:'read-control',content:token}]}}].map(value=>typeof value==='string'?value:JSON.stringify(value)).join('\n')+'\nUTF8: ☃ 👩‍💻\n';
async function invoke(name, provider, args, input = '', prefix = []) {
  const folder = path.join(directory, name); fs.mkdirSync(folder); const capture = path.join(folder, 'backend.json');
  const fixture = createCapabilitiesCli({directory:folder,provider,executable:process.execPath,prefixArgs:[fake,capture,...prefix],node:process.execPath,hooks:path.join(folder,'hooks.json'),token,handoffToken,workspace:folder,window:'CONTROL'});
  const child = spawn(fixture.launcher,args,{stdio:['pipe','pipe','pipe']}); const stdout=[],stderr=[];
  child.stdout.on('data',chunk=>stdout.push(chunk)); child.stderr.on('data',chunk=>stderr.push(chunk)); child.stdin.end(input);
  const result = await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Synthetic wrapper control timeout'));},10000);child.on('error',reject);child.on('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});});
  const receipts=fs.existsSync(fixture.receipts)?fs.readFileSync(fixture.receipts,'utf8').split('\n').filter(Boolean).map(JSON.parse):[];
  assert(!receipts.some(value=>value.event==='instrumentation-error'));
  return {result,receipts,stdout:Buffer.concat(stdout),stderr:Buffer.concat(stderr),backend:fs.existsSync(capture)?JSON.parse(fs.readFileSync(capture)):undefined};
}
async function check(name, test) { await test(); checks.push({name,status:'PASS'}); }
(async()=>{
  await check('Claude native return requires peer history outside memory and peer-only tag recall',async()=>{
    const handoffToken='PC12_REVIEW_0123456789abcdef0123';
    const evidence={request:{provider:'claude-code',policy:{nativeResumeSupplied:true},containsHandoffToken:true,markerOrigins:{outsideProjectMemoryMarkers:['COPILOT_AUTO_READ','CLAUDE_RETURN'],outsideProjectMemoryContainsHandoffToken:true}},content:`Reviewed proposal ${handoffToken}`,handoffToken};
    assertClaudePeerHandoff(evidence);
    const bad=[
      {...evidence,content:'Correct diagnosis, but I cannot see the other proposal'},
      {...evidence,request:{...evidence.request,containsHandoffToken:false}},
      {...evidence,request:{...evidence.request,policy:{nativeResumeSupplied:false}}},
      {...evidence,request:{...evidence.request,provider:'github-copilot'}},
      {...evidence,request:{...evidence.request,markerOrigins:{...evidence.request.markerOrigins,outsideProjectMemoryContainsHandoffToken:false}}},
      {...evidence,request:{...evidence.request,markerOrigins:{outsideProjectMemoryMarkers:['CLAUDE_RETURN'],projectMemoryMarkers:['COPILOT_AUTO_READ']}}},
    ];
    for(const invalid of bad) assert.throws(()=>assertClaudePeerHandoff(invalid),assert.AssertionError);
  });
  await check('Custom model authority uses provider-scoped custom override and exact DOM input',async()=>{
    const evidence={expectedProvider:'github-copilot',expectedModel:'gpt-5.4',selection:{provider:'github-copilot',model:'auto',customModel:'gpt-5.4'},inlineValue:'__custom__',customInputValue:'gpt-5.4'};
    assert.equal(matchesPublicModelSelection(evidence),true);
    assert.equal(matchesPublicModelSelection({...evidence,selection:{...evidence.selection,customModel:'wrong-model'}}),false);
    assert.equal(matchesPublicModelSelection({...evidence,customInputValue:'wrong-model'}),false);
    assert.equal(matchesPublicModelSelection({...evidence,selection:{...evidence.selection,provider:'openai-codex'}}),false);
    assert.equal(matchesPublicModelSelection({...evidence,selection:{...evidence.selection,customModel:''}}),false);
    assert.equal(matchesPublicModelSelection({...evidence,selection:{provider:'github-copilot',model:'gpt-5.4',customModel:''},inlineValue:'gpt-5.4'}),true);
  });
  await check('Copilot Auto exact forwarding, safe chosenModel and real tool receipts',async()=>{
    const prompt='PC12_REQUEST:COPILOT_AUTO\nReview source';const value=await invoke('auto','github-copilot',['-p',prompt,'--model','auto','--deny-tool','shell','--deny-tool','write','--output-format','json'],'',['--no-auto-update']);
    assert.equal(value.result.code,0);assert.equal(value.stdout.toString(),expectedOutput);assert.equal(value.backend.args[value.backend.args.indexOf('-p')+1],prompt);
    const request=value.receipts.find(v=>v.event==='request');assert.equal(request.model,'auto');assert.equal(request.policy.effort,undefined);assert.deepEqual(request.policy.denyTools,['shell','write']);assert.equal(request.policy.injectedNoAutoUpdate,true);
    assertCopilotPromptHistoryRequest(request);
    assert(value.receipts.some(v=>v.event==='auto-model-resolved'&&v.chosenModel==='real-resolved-model'));assert(value.receipts.some(v=>v.event==='tool-start'&&v.exactOwnedFile));assert(value.receipts.some(v=>v.event==='tool-result'&&v.containsFixtureToken));
  });
  await check('Explicit Copilot model/effort retained independently from actual-model receipt',async()=>{
    const value=await invoke('explicit','github-copilot',['-p','PC12_REQUEST:COPILOT_EXPLICIT_READ','--model','real-resolved-model','--effort','low','--deny-tool','shell','--deny-tool','write']);
    assert.equal(value.result.code,0);const request=value.receipts.find(v=>v.event==='request');assert.equal(request.model,'real-resolved-model');assert.equal(request.policy.effort,'low');assert(value.receipts.some(v=>v.event==='model-call'&&v.actualModel==='real-resolved-model'));
    assertCopilotPromptHistoryRequest(request);
  });
  await check('Copilot prompt-history rejects synthetic sessionHash and every native resume flag form',async()=>{
    const baseline={provider:'github-copilot',policy:{nativeResumeSupplied:false}};assertCopilotPromptHistoryRequest(baseline);
    assert.throws(()=>assertCopilotPromptHistoryRequest({...baseline,sessionHash:hash('copilot-panel-synthetic-session')}),/must not forward a native resume session/);
    const value=await invoke('synthetic-resume','github-copilot',['-p','PC12_REQUEST:COPILOT_EXPLICIT_READ','--model','real-resolved-model','--resume','copilot-panel-synthetic-session']);
    const request=value.receipts.find(v=>v.event==='request');assert.equal(request.sessionHash,hash('copilot-panel-synthetic-session'));assert.equal(request.policy.nativeResumeSupplied,true);assert.throws(()=>assertCopilotPromptHistoryRequest(request),/must not forward a native resume session/);
    const equals=await invoke('equals-resume','github-copilot',['-p','PC12_REQUEST:COPILOT_EXPLICIT_READ','--resume=copilot-panel-synthetic-session']);
    const eqRequest=equals.receipts.find(v=>v.event==='request');assert.equal(eqRequest.policy.nativeResumeSupplied,true);assert.throws(()=>assertCopilotPromptHistoryRequest(eqRequest),/must omit every --resume form/);
  });
  await check('Unavailable explicit model requires exact policy, error, failed exit and zero inference/tool receipts',async()=>{
    const evidence={
      request:{provider:'github-copilot',model:'gpt-5.4',policy:{effort:'low',denyTools:['shell','write'],allowAllTools:false,nativeResumeSupplied:false}},
      expectedModel:'gpt-5.4',errorText:'Error: Model "gpt-5.4" from --model flag is not available.',
      nativeReceipts:[{event:'exit',exitCode:1}],
    };
    assertUnavailableCopilotModelAttempt(evidence);
    const rejectedEvidence=[
      {...evidence,errorText:'Authentication failed'},
      {...evidence,errorText:'Error: Model "wrong-model" from --model flag is not available.'},
      {...evidence,nativeReceipts:[]},
      {...evidence,nativeReceipts:[{event:'exit',exitCode:0}]},
      ...['model-call','auto-model-resolved','tool-start','tool-result'].map(event=>({...evidence,nativeReceipts:[...evidence.nativeReceipts,{event}]})),
      {...evidence,request:{...evidence.request,sessionHash:hash('copilot-panel-synthetic-session')}},
      {...evidence,request:{...evidence.request,model:'wrong-model'}},
      ...[{effort:'high'},{denyTools:['shell']},{allowAllTools:true},{nativeResumeSupplied:true}].map(policy=>({...evidence,request:{...evidence.request,policy:{...evidence.request.policy,...policy}}})),
    ];
    for(const invalid of rejectedEvidence) assert.throws(()=>assertUnavailableCopilotModelAttempt(invalid),assert.AssertionError);
  });
  await check('Claude persistent null/nonarray output and split UTF8 remain transparent',async()=>{
    const input='null\n'+JSON.stringify({type:'user',message:{role:'user',content:[{type:'text',text:'PC12_REQUEST:CLAUDE_READ'}]}})+'\n';
    const value=await invoke('claude','claude-code',['--print','--input-format','stream-json','--output-format','stream-json','--model','sonnet'],input);
    assert.equal(value.result.code,0);assert.equal(value.stdout.toString(),expectedOutput);assert.equal(value.backend.input,input);assert.equal(value.backend.args.filter(v=>v==='--settings').length,1);assert.equal(value.receipts.filter(v=>v.event==='request').length,1);
    assert.equal(value.receipts.find(v=>v.event==='request').containsHandoffToken,false);
  });
  await check('Claude wrapper observes peer handoff without injecting it into forwarded stdin',async()=>{
    const prompt=`User: PC12_REQUEST:COPILOT_AUTO_READ\nAssistant: corrected proposal ${handoffToken}\nPC12_REQUEST:CLAUDE_RETURN`;
    const input=JSON.stringify({type:'user',message:{role:'user',content:[{type:'text',text:prompt}]}})+'\n';
    const value=await invoke('claude-handoff','claude-code',['--print','--input-format','stream-json','--output-format','stream-json','--model','sonnet','--resume','synthetic-owned-session'],input);
    assert.equal(value.result.code,0);assert.equal(value.backend.input,input);assert.equal(value.stdout.toString(),expectedOutput);
    assertClaudePeerHandoff({request:value.receipts.find(v=>v.event==='request'),content:`Reviewed ${handoffToken}`,handoffToken});
    const splitPrompt=`PC12_REQUEST:COPILOT_AUTO_READ\nPC12_REQUEST:CLAUDE_RETURN\n## Project memory (untrusted)\n<<<UNTRUSTED abcd\n${handoffToken}\nabcd UNTRUSTED>>>`;
    const splitInput=JSON.stringify({type:'user',message:{role:'user',content:[{type:'text',text:splitPrompt}]}})+'\n';
    const split=await invoke('claude-memory-only-handoff','claude-code',['--print','--input-format','stream-json','--output-format','stream-json','--model','sonnet','--resume','synthetic-owned-session'],splitInput);
    assert.equal(split.backend.input,splitInput);const splitRequest=split.receipts.find(v=>v.event==='request');
    assert.equal(splitRequest.containsHandoffToken,true);assert.equal(splitRequest.markerOrigins.outsideProjectMemoryContainsHandoffToken,false);
    assert.throws(()=>assertClaudePeerHandoff({request:splitRequest,content:`Reviewed ${handoffToken}`,handoffToken}),/outside project memory/);
  });
  await check('Claude product settings merged without overriding ultracode or source file',async()=>{
    const folder=fs.mkdtempSync(path.join(os.tmpdir(),'mysti-claude-settings-')),source=path.join(folder,'ultracode-off.json'),bytes=JSON.stringify({ultracode:false});fs.writeFileSync(source,bytes);
    try {const value=await invoke('merge','claude-code',['--print','--settings',source],'synthetic auxiliary');assert.equal(value.result.code,0);
      assert.equal(value.backend.args.filter(v=>v==='--settings').length,1);const merged=value.backend.args[value.backend.args.indexOf('--settings')+1];assert.notEqual(merged,source);assert.deepEqual(JSON.parse(fs.readFileSync(merged)),{ultracode:false,disableAllHooks:true});assert.equal(fs.readFileSync(source,'utf8'),bytes);assert(value.receipts.some(v=>v.event==='claude-settings-merge'&&v.ultracode===false));
    }finally{fs.rmSync(folder,{recursive:true});}
  });
  await check('Claude unknown --settings rejected before fake backend launch',async()=>{
    const value=await invoke('settings','claude-code',['--print','--settings','existing.json'],'synthetic auxiliary');
    assert.equal(value.result.code,1);assert.equal(value.backend,undefined);assert(value.receipts.some(v=>v.event==='wrapper-rejected-settings'));
  });
  await check('Codex model and project-memory marker origins preserved',async()=>{
    const prompt='PC12_REQUEST:CODEX_REVIEW\n## Project memory (untrusted)\n<<<UNTRUSTED abcd\nPC12_REQUEST:OLD_MEMORY\nabcd UNTRUSTED>>>';
    const input=JSON.stringify({method:'thread/start',params:{model:'gpt-5.6-sol',approvalPolicy:'on-request',sandbox:'read-only'}})+'\n'+JSON.stringify({method:'turn/start',params:{threadId:'secret-session-id',input:[{type:'text',text:prompt}]}})+'\n';
    const value=await invoke('codex','openai-codex',['app-server'],input);assert.equal(value.result.code,0);assert.equal(value.backend.input,input);
    const request=value.receipts.find(v=>v.event==='request');assert.equal(request.model,'gpt-5.6-sol');assert.deepEqual(request.markerOrigins.outsideProjectMemoryMarkers,['CODEX_REVIEW']);assert.deepEqual(request.markerOrigins.projectMemoryMarkers,['OLD_MEMORY']);assert.equal(request.sessionHash,hash('secret-session-id'));assert(!JSON.stringify(value.receipts).includes('secret-session-id'));
  });
  await check('Auxiliary input and discovery launches counted separately',async()=>{
    const aux=await invoke('aux','claude-code',['--print'],'title prompt');assert.equal(aux.receipts.filter(v=>v.event==='auxiliary-input').length,1);assert.equal(aux.receipts.filter(v=>v.event==='request').length,0);
    const probe=await invoke('probe','github-copilot',['--version']);assert.equal(probe.receipts.filter(v=>v.event==='probe-start').length,1);assert.equal(probe.receipts.filter(v=>v.event==='request'||v.event==='auxiliary-input').length,0);
  });
  await check('Passive observer retains actual manifest event across document.open',async()=>{
    const source=fs.readFileSync(path.join(repo,'tests-vscode/capabilities-observer.ts'),'utf8');const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const module={exports:{}};vm.runInNewContext(compiled,{module,exports:module.exports});const browser=await chromium.launch({headless:true});
    try {const page=await browser.newPage();await page.addInitScript(module.exports.installCapabilitiesObserver);await page.goto('about:blank');
      const result=await page.evaluate(()=>{window.dispatchEvent(new MessageEvent('message',{data:{type:'initialState',payload:{providerManifest:{schemaVersion:1,providers:[{id:'synthetic-one'}]}}}}));document.open();document.write('<html><body>owned synthetic control</body></html>');document.close();window.dispatchEvent(new MessageEvent('message',{data:{type:'manifestUpdated',payload:{schemaVersion:1,providers:[{id:'synthetic-two'}]}}}));return globalThis.__pc12Events;});
      assert.deepEqual(result.map(v=>v.source),['initialState','manifestUpdated']);assert.deepEqual(result.map(v=>v.payload.providers[0].id),['synthetic-one','synthetic-two']);
    } finally {await browser.close();}
  });
  fs.writeFileSync(path.join(directory,'checks.json'),JSON.stringify({status:'PASS',checks,realBackendLaunches:0,inferenceInputs:0,editorLaunches:0,clipboardAccesses:0},null,2));console.log(JSON.stringify({directory,status:'PASS',checks:checks.length}));
})().catch(error=>{fs.writeFileSync(path.join(directory,'checks.json'),JSON.stringify({status:'FAIL',checks,error:{name:error.name,message:error.message}},null,2));console.error(error);process.exitCode=1;});
