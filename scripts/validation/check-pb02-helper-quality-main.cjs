/* New helper main wrapper controls, synthetic Node backend only; no account/profile access. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{createHash}=require('node:crypto');
const {createPB02HelperQualityMainCli}=require('./pb02-helper-quality-main-fixture.cjs');
const root=path.resolve(__dirname,'../../out-test/feature-tests/PB-02');
const directory=fs.mkdtempSync(path.join(root,'helper-quality-main-controls-'));
const hash = value => createHash('sha256').update(value).digest('hex'), checks = [];
const backend = path.join(directory, 'fake-backend.cjs');
fs.writeFileSync(backend, `
const fs = require('fs');
const [capture, output, exitCode, stderrFile] = process.argv.slice(2);
fs.writeFileSync(capture + '.args', JSON.stringify(process.argv.slice(6)));
process.on('SIGTERM', () => process.exit(0));
let input = Buffer.alloc(0);
process.stdin.on('data', bytes => { input = Buffer.concat([input, bytes]); fs.writeFileSync(capture, input); });
process.stdin.on('end', () => {
 const bytes = fs.readFileSync(output); let offset = 0;
 function send() { if (offset < bytes.length) { process.stdout.write(bytes.subarray(offset, ++offset)); setImmediate(send); } else process.exitCode = Number(exitCode); }
 const errors = fs.readFileSync(stderrFile); let errorOffset = 0;
 function sendError() { if (errorOffset < errors.length) { process.stderr.write(errors.subarray(errorOffset, ++errorOffset)); setImmediate(sendError); } }
 send(); sendError();
});
`);
function fixture(name, exitCode = 0) {
  const folder = path.join(directory, name); fs.mkdirSync(folder);
  const capture = path.join(folder, 'input'), output = path.join(folder, 'output'); fs.writeFileSync(output, '');
  const counterFile = path.join(folder, 'counter.json'), stderr = path.join(folder, 'stderr'); fs.writeFileSync(stderr, '');
  return { ...createPB02HelperQualityMainCli({ directory: folder, executable: process.execPath, prefixArgs: [backend, capture, output, String(exitCode), stderr],
    node: process.execPath, workspace: folder, counterFile, token: 'OWNED', maxInputs: 3 }), capture, output, counterFile, stderr };
}
function runWrapper(f, args) {
  const child = spawn(f.launcher, args, { stdio: ['pipe', 'pipe', 'pipe'] }), output = [], errors = [];
  child.stdout.on('data', bytes => output.push(bytes)); child.stderr.on('data', bytes => errors.push(bytes)); child.stdin.on('error', () => {});
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Synthetic timeout')); }, 10000);
    child.once('error', reject); child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output: Buffer.concat(output), stderr: Buffer.concat(errors),
      receipts: fs.readFileSync(f.receipts, 'utf8').split('\n').filter(Boolean).map(JSON.parse) }); });
  });
  return { child, done };
}
async function check(name, fn) { await fn(); checks.push({ name, status: 'PASS' }); }
async function until(predicate) { const until = Date.now() + 3000; while (!predicate()) { assert(Date.now() < until); await new Promise(resolve => setTimeout(resolve, 10)); } }
(async()=>{
  await check('Exact native agentMessage and plan items preserve split Unicode bytes while recording only identities',async()=>{
    const f=fixture('items'),sent=[{id:1,method:'initialize',params:{}},{id:2,method:'config/read',params:{}},{id:3,method:'thread/start',params:{model:'gpt-5.6-sol',cwd:path.dirname(f.capture),approvalPolicy:'untrusted',sandbox:'read-only',config:{model_reasoning_effort:'low',apps:{_default:{enabled:false}}}}},{id:4,method:'turn/start',params:{threadId:'owned-thread',effort:'low',input:[{type:'text',text:'PB02_REQUEST:HELPER_NONE OWNED'}]}}];
    const text='OWNED_REPLY Café مرحبا € 😀',wire=[{id:1,result:{}},{id:2,result:{config:{model:'gpt-5.6-sol',model_reasoning_effort:'low',api_key:'UNRETAINED_SECRET'}}},{id:3,result:{thread:{id:'owned-thread'},model:'gpt-5.6-sol',modelProvider:'openai',approvalPolicy:'untrusted',sandbox:{type:'readOnly'},cwd:path.dirname(f.capture)}},{id:4,result:{turn:{id:'owned-turn'}}},
      ...['agentMessage','plan'].map((type,index)=>({method:'item/completed',params:{threadId:'owned-thread',turnId:'owned-turn',item:{id:'item-'+index,type,phase:'final_answer',text}}})),{method:'item/completed',params:{threadId:'owned-thread',turnId:'owned-turn',item:{id:'reasoning',type:'reasoning',text:'UNRETAINED_REASONING'}}},{method:'turn/completed',params:{threadId:'owned-thread',turn:{id:'owned-turn',status:'completed'}}}];
    const bytes=Buffer.from(wire.map(JSON.stringify).join('\n')+'\n');fs.writeFileSync(f.output,bytes);fs.writeFileSync(f.stderr,'owned stderr €');
    const run=runWrapper(f,['app-server']),input=Buffer.from(sent.map(JSON.stringify).join('\n')+'\n');
    for(const byte of input)run.child.stdin.write(Buffer.from([byte]));run.child.stdin.end();const result=await run.done;
    assert.equal(result.code,0);assert.deepEqual(result.output,bytes);assert.deepEqual(fs.readFileSync(f.capture),input);
    const items=result.receipts.filter(value=>value.event==='assistant-message');assert.equal(items.length,2);
    assert.deepEqual(items.map(value=>value.itemType),['agentMessage','plan']);
    for(const item of items){assert.equal(item.textSha256,hash(text));assert.equal(item.textBytes,Buffer.byteLength(text));assert.equal(item.sessionHash,hash('owned-thread'));assert.equal(item.turnHash,hash('owned-turn'));assert.equal(item.inputIndex,1);}
    const summary=result.receipts.find(value=>value.event==='stderr-summary');assert.equal(summary.sha256,hash(result.stderr));assert.equal(summary.bytes,result.stderr.length);
    const raw=JSON.stringify(result.receipts);for(const secret of ['UNRETAINED_SECRET','UNRETAINED_REASONING','OWNED_REPLY'])assert(!raw.includes(secret));
    assert.deepEqual(result.receipts.filter(value=>value.event==='request').map(value=>value.outsideMemoryMarkers),[['HELPER_NONE']]);
  });
  await check('Three actual main inputs are reserved; fourth refuses before backend forwarding',async()=>{
    const f=fixture('cap'),run=runWrapper(f,['app-server']);
    const turn=index=>JSON.stringify({id:index,method:'turn/start',params:{threadId:'owned',input:[{type:'text',text:'PB02_REQUEST:HELPER_'+index}]}})+'\n';
    const allowed=[1,2,3].map(turn).join('');run.child.stdin.write(allowed);await until(()=>fs.existsSync(f.capture)&&fs.readFileSync(f.capture,'utf8')===allowed);run.child.stdin.write(turn(4));const result=await run.done;
    assert.equal(result.code,1);assert.equal(fs.readFileSync(f.capture,'utf8'),allowed);assert.deepEqual(JSON.parse(fs.readFileSync(f.counterFile)),{forwardedInputs:3,maxInputs:3});assert.equal(result.receipts.filter(value=>value.event==='request').length,3);
  });
  await check('Profile, exec and injected arguments refuse before any backend process or input',async()=>{
    for(const [index,args]of [['--profile','owned','app-server'],['exec'],['app-server','--dangerously-bypass-approvals-and-sandbox']].entries()){
      const f=fixture('refuse-'+index),run=runWrapper(f,args);run.child.stdin.end();const result=await run.done;assert.equal(result.code,1);assert(!fs.existsSync(f.capture+'.args'));assert(!fs.existsSync(f.counterFile));assert.equal(result.receipts[0].event,'invocation-refusal');
    }
  });
  await check('Version probe is transparent and consumes no model input',async()=>{
    const f=fixture('probe');fs.writeFileSync(f.output,'synthetic-version\n');const run=runWrapper(f,['--version']);run.child.stdin.end();const result=await run.done;assert.equal(result.code,0);assert.equal(result.output.toString(),'synthetic-version\n');assert(!fs.existsSync(f.counterFile));assert(result.receipts.some(value=>value.event==='probe-exit'));
  });
  fs.writeFileSync(path.join(directory,'checks.json'),JSON.stringify({status:'PASS',checks,realProviderInputs:0,nativeEditorLaunches:0},null,2));console.log(JSON.stringify({directory,status:'PASS',checks:checks.length}));
})().catch(error=>{fs.writeFileSync(path.join(directory,'checks.json'),JSON.stringify({status:'FAIL',checks,error:{name:error.name,message:error.message}},null,2));console.error(error);process.exitCode=1;});
