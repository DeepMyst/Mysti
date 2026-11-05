/* PB-01 synthetic transport controls. Never invokes Claude, editor or clipboard. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {createPB01Cli}=require('./pb01-cli-fixture.cjs');
const root=path.resolve(__dirname,'../../out-test/feature-tests/PB-01');fs.mkdirSync(root,{recursive:true});
const directory=fs.mkdtempSync(path.join(root,'harness-controls-')),checks=[];
const output=Buffer.from('null\n{"message":{"content":{"unexpected":"shape"}}}\nordinary text ☃ 👩‍💻\n'+JSON.stringify({type:'control_request',request_id:'owned-request',request:{subtype:'can_use_tool',tool_name:'Edit',input:{file_path:'src/retry.cjs'}}})+'\n'+JSON.stringify({type:'result',is_error:true,errors:['fixture-only error']})+'\n');
const backend=path.join(directory,'fake-backend.cjs');
fs.writeFileSync(backend,`const fs=require('fs');const capture=process.argv[2],destination=process.argv[3];fs.writeFileSync(capture+'.args',JSON.stringify(process.argv.slice(4)));let bytes=Buffer.alloc(0);process.stdin.on('data',chunk=>{bytes=Buffer.concat([bytes,chunk]);fs.writeFileSync(capture,bytes);});process.stdin.on('end',()=>{const output=fs.readFileSync(destination);let i=0;function emit(){if(i===output.length)return;process.stdout.write(output.subarray(i,i+1));i++;setImmediate(emit);}emit();});`);
const outputFile=path.join(directory,'expected-output');fs.writeFileSync(outputFile,output);
const user=marker=>JSON.stringify({type:'user',message:{role:'user',content:[{type:'text',text:`PB01_REQUEST:${marker}\nFixture text ☃ 👩‍💻`}]}});
function fixture(name,counterFile=path.join(directory,`${name}-counter.json`),maxInputs=30){
  const folder=path.join(directory,name);fs.mkdirSync(folder);const hooks=path.join(folder,'hooks.json');fs.writeFileSync(hooks,JSON.stringify({disableAllHooks:true}));
  const capture=path.join(folder,'backend-input');const cli=createPB01Cli({directory:folder,node:process.execPath,executable:process.execPath,prefixArgs:[backend,capture,outputFile],workspace:folder,hooks,counterFile,maxInputs,token:'PB01_CONTROL',attachmentToken:'PB01_ATTACHMENT_CONTROL'});
  return {...cli,capture,counterFile,folder};
}
function start(f,args=['--print','--input-format','stream-json','--output-format','stream-json','--model','sonnet']){
  const child=spawn(f.launcher,args,{stdio:['pipe','pipe','pipe']});const stdout=[],stderr=[];
  child.stdout.on('data',chunk=>stdout.push(chunk));child.stderr.on('data',chunk=>stderr.push(chunk));child.stdin.on('error',()=>{});
  const completion=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Controlled wrapper timed out'));},10000);child.once('error',reject);child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout:Buffer.concat(stdout),stderr:Buffer.concat(stderr),receipts:fs.existsSync(f.receipts)?fs.readFileSync(f.receipts,'utf8').split('\n').filter(Boolean).map(JSON.parse):[]});});});
  return {child,completion};
}
async function check(name,fn){await fn();checks.push({name,status:'PASS'});}
async function waitFor(fn){const deadline=Date.now()+3000;while(Date.now()<deadline){if(fn())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Controlled backend receipt timeout');}
(async()=>{
  await check('split UTF8 and initialized native control replies retain exact bytes in both directions',async()=>{
    const f=fixture('utf8'),run=start(f);
    const input=Buffer.from(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:'owned-request',response:{behavior:'deny',message:'No changes'}}})+'\n'+user('UNICODE')+'\n');
    for(const byte of input)run.child.stdin.write(Buffer.from([byte]));run.child.stdin.end();const result=await run.completion;
    assert.equal(result.code,0);assert.deepEqual(fs.readFileSync(f.capture),input);assert.deepEqual(result.stdout,output);
    assert.equal(result.receipts.filter(value=>value.event==='request').length,1);assert(result.receipts.some(value=>value.event==='native-control-response'&&value.behavior==='deny'));assert(result.receipts.some(value=>value.event==='native-control-request'&&value.subtype==='can_use_tool'));assert(!result.receipts.some(value=>value.event==='instrumentation-error'));
  });
  await check('malformed JSON, null and final unterminated frame remain byte-transparent',async()=>{
    const f=fixture('unterminated'),run=start(f),input=Buffer.from('malformed {json}\nnull\n'+user('FINAL_FRAME'));
    run.child.stdin.end(input);const result=await run.completion;assert.equal(result.code,0);assert.deepEqual(fs.readFileSync(f.capture),input);assert.equal(result.receipts.filter(value=>value.event==='request').length,1);
  });
  await check('the first user frame beyond the cap is never forwarded and cannot exit as a normal success',async()=>{
    const f=fixture('cap',undefined,2),run=start(f);const first=user('FIRST')+'\n',second=user('SECOND')+'\n',blocked=user('BLOCKED')+'\n';
    run.child.stdin.write(first);await waitFor(()=>fs.existsSync(f.capture)&&fs.readFileSync(f.capture,'utf8')===first);
    run.child.stdin.write(second);await waitFor(()=>fs.readFileSync(f.capture,'utf8')===first+second);
    run.child.stdin.write(blocked);const result=await run.completion;
    assert.deepEqual(fs.readFileSync(f.capture),Buffer.from(first+second));assert(result.code!==0||result.signal!==null);assert.equal(result.receipts.filter(value=>value.event==='input-cap-refusal').length,1);assert.equal(JSON.parse(fs.readFileSync(f.counterFile)).forwardedInputs,2);
  });
  await check('concurrent wrappers share a fail-closed cap without oversubscription',async()=>{
    const counter=path.join(directory,'concurrent-counter.json');
    const results=await Promise.all(Array.from({length:6},async(_,index)=>{const f=fixture(`concurrent-${index}`,counter,2),run=start(f);run.child.stdin.end(user(`CONCURRENT_${index}`)+'\n');return {f,result:await run.completion};}));
    const captured=results.filter(({f})=>fs.existsSync(f.capture)&&fs.readFileSync(f.capture).length>0);
    assert(captured.length>0&&captured.length<=2);assert.equal(JSON.parse(fs.readFileSync(counter)).forwardedInputs,captured.length);
    for(const {f,result} of results)if(!captured.some(value=>value.f===f)){assert(result.code!==0||result.signal!==null);assert(result.receipts.some(value=>value.event==='input-cap-refusal'));}
  });
  await check('native compact counts toward the hard cap but remains distinct from conversational input',async()=>{
    const f=fixture('compact'),run=start(f);run.child.stdin.end(JSON.stringify({type:'user',message:{role:'user',content:[{type:'text',text:'/compact'}]}})+'\n');const result=await run.completion;
    assert.equal(result.code,0);assert.equal(result.receipts.filter(value=>value.event==='native-command').length,1);assert.equal(result.receipts.filter(value=>value.event==='request').length,0);assert.equal(JSON.parse(fs.readFileSync(f.counterFile)).forwardedInputs,1);
  });
  await check('known Mysti settings merge preserves ultracode and original bytes with one settings argument',async()=>{
    const sourceDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'mysti-claude-settings-')),source=path.join(sourceDirectory,'ultracode-on.json'),bytes=JSON.stringify({ultracode:true});fs.writeFileSync(source,bytes);
    try{const f=fixture('settings'),run=start(f,['--print','--input-format','stream-json','--output-format','stream-json','--settings',source]);run.child.stdin.end(user('SETTINGS')+'\n');const result=await run.completion;assert.equal(result.code,0);const args=JSON.parse(fs.readFileSync(f.capture+'.args'));assert.equal(args.filter(value=>value==='--settings').length,1);assert.deepEqual(JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1])),{ultracode:true,disableAllHooks:true});assert.equal(fs.readFileSync(source,'utf8'),bytes);}finally{fs.rmSync(sourceDirectory,{recursive:true});}
  });
  await check('unknown settings cannot start the fake backend',async()=>{
    const f=fixture('unknown-settings'),run=start(f,['--print','--settings','unowned.json']);run.child.stdin.end();const result=await run.completion;assert.equal(result.code,1);assert(!fs.existsSync(f.capture+'.args'));assert(result.receipts.some(value=>value.event==='wrapper-rejected-settings'));
  });
  await check('auxiliary input and version probes do not consume conversational budget',async()=>{
    const f=fixture('aux'),run=start(f,['--print']);run.child.stdin.end('synthetic title');const result=await run.completion;assert.equal(result.code,0);assert.equal(result.receipts.filter(value=>value.event==='auxiliary-input').length,1);assert(!fs.existsSync(f.counterFile));
    const p=fixture('probe'),probe=start(p,['--version']);probe.child.stdin.end();const observed=await probe.completion;assert.equal(observed.code,0);assert(observed.receipts.some(value=>value.event==='probe-start'));assert(!fs.existsSync(p.counterFile));
  });
  await check('tool-result success distinguishes omitted false true and malformed is_error without changing bytes',async()=>{
    const expected=Buffer.from([{}, {is_error:false}, {is_error:true}, {is_error:'false'}].map((extra,index)=>JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:`tool-${index}`,content:'synthetic output',...extra}]}})).join('\n')+'\n');
    fs.writeFileSync(outputFile,expected);const f=fixture('result-success'),run=start(f);run.child.stdin.end(user('RESULT_STATUS')+'\n');const result=await run.completion;
    assert.equal(result.code,0);assert.deepEqual(result.stdout,expected);assert.deepEqual(result.receipts.filter(value=>value.event==='tool-result').map(value=>value.success),[true,true,false,undefined]);fs.writeFileSync(outputFile,output);
  });
  await check('passive observer sanitizes every message history and reattaches once after document.open',async()=>{
    const vm=require('node:vm'),listeners=new Set();
    const context={exports:{},Document:class Document{open(){listeners.clear();return this;}},addEventListener:(_type,fn)=>listeners.add(fn),removeEventListener:(_type,fn)=>listeners.delete(fn)};
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../../out-vscode-test/claude-observer.js'),'utf8'),context);
    context.exports.installClaudeObserver();context.exports.installClaudeObserver();assert.equal(listeners.size,1);
    const emit=data=>[...listeners].forEach(fn=>fn({data}));
    emit({type:'conversationHistory',payload:{conversations:[{messages:[{id:'message',content:'owned prose',thinking:'DO_NOT_RETAIN',segments:[{type:'thinking',content:'DO_NOT_RETAIN'},{type:'text',content:'owned prose'}],toolCalls:[{input:{command:'owned command'},output:'owned tool output'}]}]}]}});
    emit({type:'fileAttachmentSelected',payload:{attachments:[{id:'file',fileName:'owned.txt',base64Data:'DO_NOT_RETAIN',size:12}]}});
    const document=new context.Document();document.open();assert.equal(listeners.size,1);emit({type:'responseChunk',payload:{type:'thinking',content:'DO_NOT_RETAIN'}});emit({type:'responseChunk',payload:{type:'text',content:'owned delta'}});
    const captured=JSON.stringify(context.__pb01Events);assert(!captured.includes('DO_NOT_RETAIN'));assert(captured.includes('owned prose')&&captured.includes('owned tool output')&&captured.includes('owned.txt')&&captured.includes('owned delta'));assert.equal(context.__pb01Events.length,3);
  });
  await check('native question delivery accepts absent source only with matching native tool identity and public question body',async()=>{
    const {matchingNativeQuestionDeliveries}=require('./claude-interaction-oracle.cjs'),{createHash}=require('node:crypto');
    const questions=[{question:'Floor or round?',header:'Jitter',options:[{label:'Floor'},{label:'Round'}]}],id='owned-tool-id';
    const tool={type:'toolUse',at:1,payload:{id,name:'AskUserQuestion',input:{questions}}},delivery={type:'askUserQuestion',at:2,payload:{toolCallId:'owned-public-delivery',questions}};
    const native=[{event:'tool-start',name:'AskUserQuestion',toolIdHash:createHash('sha256').update(id).digest('hex')}];
    assert.equal(matchingNativeQuestionDeliveries([tool,delivery],native).length,1);
    assert.equal(matchingNativeQuestionDeliveries([tool,{...delivery,payload:{...delivery.payload,source:'tool'}}],native).length,1);
    assert.equal(matchingNativeQuestionDeliveries([tool,{...delivery,payload:{...delivery.payload,source:'detected'}}],native).length,0);
    assert.equal(matchingNativeQuestionDeliveries([tool,delivery],[]).length,0);
    assert.equal(matchingNativeQuestionDeliveries([{...tool,payload:{...tool.payload,id:'other-native-tool'}},delivery],native).length,0);
    assert.equal(matchingNativeQuestionDeliveries([tool,{...delivery,payload:{...delivery.payload,questions:[{question:'Unrelated question'}]}}],native).length,0);
  });
  await check('read-only refusal remains partial and cannot masquerade as an executed native policy denial',async()=>{
    const {classifyReadonlyCanary}=require('./claude-interaction-oracle.cjs');
    const base={canary:'canaries/approval.txt',permissionRequests:[],nativeReceipts:[],content:'I did not attempt the Edit because planning mode forbids any edit.'};
    assert.equal(classifyReadonlyCanary(base),'PARTIAL_MODEL_REFUSAL_NO_NATIVE_WRITE_ATTEMPT');
    assert.throws(()=>classifyReadonlyCanary({...base,content:'The task is complete.'}));
    assert.throws(()=>classifyReadonlyCanary({...base,content:'I cannot continue because authentication failed.'}));
    assert.throws(()=>classifyReadonlyCanary({...base,permissionRequests:[{type:'permissionRequest'}]}));
    const edit={event:'tool-start',name:'Edit',relativePath:base.canary,toolIdHash:'owned-edit'},result={event:'tool-result',toolIdHash:'owned-edit',success:false};
    assert.equal(classifyReadonlyCanary({...base,nativeReceipts:[edit,result]}),'PASS_NATIVE_TOOL_DENIAL');
    assert.throws(()=>classifyReadonlyCanary({...base,nativeReceipts:[edit]}));
    assert.throws(()=>classifyReadonlyCanary({...base,nativeReceipts:[edit,{...result,success:true}]}));
    assert.throws(()=>classifyReadonlyCanary({...base,nativeReceipts:[{...edit,relativePath:'other.txt'},result]}));
    assert.throws(()=>classifyReadonlyCanary({...base,nativeReceipts:[{event:'tool-start',name:'Write'}]}));
  });
  fs.writeFileSync(path.join(directory,'checks.json'),JSON.stringify({status:'PASS',checks,realBackendLaunches:0,inferenceInputs:0,editorLaunches:0,clipboardAccesses:0},null,2));console.log(JSON.stringify({directory,status:'PASS',checks:checks.length}));
})().catch(error=>{fs.writeFileSync(path.join(directory,'checks.json'),JSON.stringify({status:'FAIL',checks,error:{name:error.name,message:error.message}},null,2));console.error(error);process.exitCode=1;});
