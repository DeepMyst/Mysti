#!/usr/bin/env node
/*
 * Opt-in macOS native OpenCode cancellation acceptance. No external inference.
 * Usage: node scripts/validation/opencode-tool-stop.cjs [--cli /path/to/opencode]
 * Requires npm ci, an installed native OpenCode binary, and /usr/bin/sandbox-exec.
 * Rebuilds the production provider from source; VS Code uses its test API boundary.
 * A disposable HOME/workspace and kernel sandbox block user-home reads, outside
 * writes and all network except the scripted loopback model. Raw receipts remain
 * in a fresh out-test directory; summary.json omits paths, PIDs and session IDs.
 */
'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),cp=require('node:child_process'),vm=require('node:vm'),os=require('node:os'),assert=require('node:assert/strict'),crypto=require('node:crypto'),ts=require('typescript'),{Transform}=require('node:stream');
const repo=path.resolve(__dirname,'../..');
if(process.argv.includes('--help')){console.log('Usage: node scripts/validation/opencode-tool-stop.cjs [--cli /absolute/native/opencode]');process.exit(0);}
assert.equal(process.platform,'darwin','This fixture requires the macOS kernel sandbox; do not run without it.');
assert(process.argv.length===2||(process.argv.length===4&&process.argv[2]==='--cli'),'Unexpected arguments');
let selected=process.argv[3];
if(!selected){const found=cp.spawnSync('/usr/bin/which',['opencode'],{encoding:'utf8',timeout:2000});assert.equal(found.status,0,'Install OpenCode or pass --cli');selected=found.stdout.trim();}
const native=fs.realpathSync(selected);fs.accessSync(native,fs.constants.X_OK);fs.accessSync('/usr/bin/sandbox-exec',fs.constants.X_OK);
const header=Buffer.alloc(4),handle=fs.openSync(native,'r');try{fs.readSync(handle,header,0,4,0);}finally{fs.closeSync(handle);}
assert(['cffaedfe','cefaedfe','feedfacf','feedface','cafebabe','bebafeca'].includes(header.toString('hex')),'Pass a native Mach-O OpenCode executable, not a shell/npm wrapper');
fs.mkdirSync(path.join(repo,'out-test'),{recursive:true});
const unit=fs.mkdtempSync(path.join(repo,'out-test','opencode-tool-stop-'));
const root=fs.mkdtempSync('/private/var/tmp/mysti-opencode-tool-stop-');
fs.mkdirSync(path.join(unit,'bundle'));
require('esbuild').buildSync({entryPoints:[path.join(repo,'src/providers/opencode/OpenCodeProvider.ts')],bundle:true,platform:'node',format:'cjs',target:'node18',external:['vscode'],outfile:path.join(unit,'bundle/provider.cjs')});
const bundled=fs.readFileSync(path.join(unit,'bundle/provider.cjs'));
const bundleHash=crypto.createHash('sha256').update(bundled).digest('hex');
fs.writeFileSync(path.join(unit,'bundle-pin.json'),JSON.stringify({bytes:bundled.length,sha256:bundleHash},null,2));
console.log('Owned evidence directory: '+unit);
for(const n of ['home','config','data','cache','state','tmp','workspace'])fs.mkdirSync(path.join(root,n));
const write=(n,v)=>fs.writeFileSync(path.join(root,n),typeof v==='string'?v:JSON.stringify(v,null,2));
const append=(n,v)=>fs.appendFileSync(path.join(root,n),JSON.stringify(v)+'\n');
const cancellations=[],toolProcesses=[],processSamples=[];
const cases=[],requests=[],children=[],operations=[],errors=[],boundaryCalls=[],sockets=new Set();
const canary=path.join(root,'workspace','canary.txt'),key='owned-cli-model-key';
fs.writeFileSync(canary,'unchanged\n');let server,provider,activeCase,modelPort;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function bounded(p,label,ms=180000){let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned deadline: '+label)),ms);})]);}finally{clearTimeout(timer);}}
function inspectProcess(pid){
 assert(Number.isSafeInteger(pid)&&pid>1);
 const result=cp.spawnSync('/bin/ps',['-p',String(pid),'-o','pid=,ppid=,pgid=,stat=,lstart=,command='],{encoding:'utf8',timeout:2000,maxBuffer:65536});
 if(result.status===1&&!result.stdout.trim())return null;
 assert.equal(result.status,0,result.stderr);
 const match=result.stdout.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+((?:\S+\s+){4}\S+)\s+(.*)$/);assert(match,result.stdout);
 return {pid:+match[1],ppid:+match[2],pgid:+match[3],state:match[4],started:match[5],command:match[6]};
}
const sameProcess=(now,before)=>now&&now.pid===before.pid&&now.pgid===before.pgid&&now.started===before.started&&now.command===before.command;
const descendantCleanup=[];
(async()=>{
 server=http.createServer((req,res)=>{const chunks=[];req.on('data',b=>chunks.push(b));req.on('end',()=>{try{
  const body=JSON.parse(Buffer.concat(chunks));assert.equal(req.url,'/v1/chat/completions');assert.equal(req.headers.authorization,'Bearer '+key);assert(requests.length<12);assert.equal(body.model,'fixture');
  const primary=body.tools?.some(t=>t.function?.name==='bash');const lastUser=JSON.stringify(body.messages.filter(m=>m.role==='user').at(-1));const current=cases.findLast(c=>lastUser.includes(c.nonce))||activeCase;assert(current);
  const row={at:Date.now(),case:current.label,primary:!!primary,body,closed:false};requests.push(row);append('model-requests.jsonl',row);res.once('close',()=>{row.closed=true;row.closedAt=Date.now();});res.on('error',e=>row.responseError=String(e));
  const id='owned-'+current.label,tool=primary&&current.command&&!body.messages.some(m=>m.role==='tool'&&m.tool_call_id===id);
  const message=tool?{role:'assistant',tool_calls:[{id,type:'function',function:{name:'bash',arguments:JSON.stringify({command:current.command,description:'Owned delayed-write cancellation fixture'})}}]}:{role:'assistant',content:primary?'Owned recovered '+current.nonce:'Owned session title'};
  const usage={prompt_tokens:10,completion_tokens:5,total_tokens:15,prompt_tokens_details:{cached_tokens:2}};
  if(!body.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'owned-completion',object:'chat.completion',created:1,model:'fixture',choices:[{index:0,message,finish_reason:tool?'tool_calls':'stop'}],usage}));return;}
  const event=(delta,finish_reason=null,stats)=>({id:'owned-completion',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}],...(stats?{usage:stats}:{})});
  const send=value=>res.write('data: '+JSON.stringify(value)+'\n\n');res.writeHead(200,{'content-type':'text/event-stream'});
  send(event(tool?{...message,tool_calls:message.tool_calls.map((t,index)=>({...t,index}))}:message));send(event({},tool?'tool_calls':'stop',usage));res.end('data: [DONE]\n\n');
 }catch(e){errors.push(String(e));if(!res.headersSent)res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Owned running-tool fixture assertion failed'}}));}});});
 server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});await new Promise(r=>server.listen(0,'127.0.0.1',r));modelPort=server.address().port;assert.notEqual(modelPort,18789);
 const config={model:'owned/fixture',small_model:'owned/fixture',share:'disabled',autoupdate:false,provider:{owned:{npm:'@ai-sdk/openai-compatible',name:'Owned',options:{baseURL:'http://127.0.0.1:'+modelPort+'/v1',apiKey:key},models:{fixture:{name:'Fixture',limit:{context:32768,output:1024}}}}}};
 const configFile=path.join(root,'config','opencode.json');fs.writeFileSync(configFile,JSON.stringify(config,null,2));
 const sandbox=path.join(root,'native.sb');fs.writeFileSync(sandbox,`(version 1)\n(allow default)\n(deny file-read-data (subpath ${JSON.stringify(os.homedir())}))\n(allow file-read-data (literal ${JSON.stringify(native)}))\n(deny file-write*)\n(deny network*)\n(allow file-write* (subpath "${root}") (literal "/dev/null"))\n(allow network-outbound (remote tcp "localhost:${modelPort}"))\n`);
 const env={HOME:path.join(root,'home'),XDG_CONFIG_HOME:path.join(root,'config'),XDG_DATA_HOME:path.join(root,'data'),XDG_CACHE_HOME:path.join(root,'cache'),XDG_STATE_HOME:path.join(root,'state'),TMPDIR:path.join(root,'tmp'),PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'en_US.UTF-8',CI:'1',NO_COLOR:'1',OPENCODE_CONFIG:configFile,OPENCODE_DISABLE_AUTOUPDATE:'true',OPENCODE_DISABLE_MODELS_FETCH:'true',OPENCODE_DISABLE_LSP_DOWNLOAD:'true',OPENCODE_DISABLE_SHARE:'true',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
 write('env.json',env);fs.writeFileSync(path.join(unit,'run-root.json'),JSON.stringify({root,modelPort},null,2));
 const vmProcess=Object.create(process);Object.defineProperty(vmProcess,'env',{value:env});Object.defineProperty(vmProcess,'cwd',{value:()=>path.join(root,'workspace')});
 Object.defineProperty(vmProcess,'kill',{value:(pid,signal)=>{assert(children.some(r=>Math.abs(pid)===r.pid)||(pid>0&&toolProcesses.some(r=>r.pid===pid&&sameProcess(inspectProcess(pid),r.chain[0]))),'Unexpected or changed signal target');return process.kill(pid,signal);}});
 const childModule={...cp,spawn(file,args,options){
  boundaryCalls.push({file,args,cwd:options?.cwd});assert.equal(file,native);assert.equal(options.cwd,path.join(root,'workspace'));assert(!options.shell);assert(children.length<3);assert(args[0]==='run'||(args.length===1&&args[0]==='--version'));
  const row={case:activeCase?.label,args,pid:null,startedAt:Date.now(),closed:false,stdout:'',stderr:'',stdin:'',code:null,signal:null};children.push(row);
  const child=cp.spawn('/usr/bin/sandbox-exec',['-f',sandbox,native,...args],{...options,env,cwd:path.join(root,'workspace'),detached:true});row.pid=child.pid;row.handle=child;
  const original=child.stdout,raw=[];const capture=new Transform({transform(chunk,encoding,callback){raw.push(Buffer.from(chunk));append('stdout-chunks.jsonl',{case:row.case,pid:row.pid,data:chunk.toString('base64')});callback(null,chunk);}});original.pipe(capture);child.stdout=capture;
  child.stderr?.on('data',b=>{row.stderr+=b;fs.appendFileSync(path.join(root,'stderr-'+row.case+'.log'),b);});
  if(child.stdin){const originalWrite=child.stdin.write;child.stdin.write=function(chunk,...rest){row.stdin+=Buffer.isBuffer(chunk)?chunk.toString():String(chunk);return originalWrite.call(this,chunk,...rest);};}
  row.close=new Promise(resolve=>{child.once('error',e=>{row.spawnError=String(e);});child.once('close',(code,signal)=>{row.closed=true;row.code=code;row.signal=signal;row.finishedAt=Date.now();row.stdout=Buffer.concat(raw).toString('utf8');write('native-'+row.case+'.json',{...row,handle:undefined,close:undefined});resolve();});});
  return child;
 }};
 childModule.execFile=(file,args,options,callback)=>{assert.equal(file,'/bin/ps');assert.equal(JSON.stringify(args.slice(-2)),JSON.stringify(['-o','pid=,ppid=,pgid=,stat=,lstart=']));assert(args[0]==='-A'||(args[0]==='-p'&&/^\d+(,\d+)*$/.test(args[1])));assert.equal(options.timeout,1500);boundaryCalls.push({method:'execFile',file,args});return cp.execFile(file,args,options,callback);};
 for(const name of ['exec','execSync','execFileSync','spawnSync','fork'])childModule[name]=(...args)=>{boundaryCalls.push({method:name,args:args.slice(0,2)});throw new Error('Unexpected fixture child process method: '+name);};
 const mocked={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(repo,'tests/helpers/mockVscode.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:mocked,exports:mocked.exports,require,process:vmProcess,Buffer,URL,console,setTimeout,clearTimeout});
 const vscode=mocked.exports;vscode.setMockConfig('opencodePath',native);vscode.setMockConfig('opencodeEndpoint','');vscode.workspace.workspaceFolders=[{uri:vscode.Uri.file(path.join(root,'workspace')),name:'Owned CLI',index:0}];
 const mod={exports:{}},source=fs.readFileSync(path.join(unit,'bundle/provider.cjs'));assert.equal(crypto.createHash('sha256').update(source).digest('hex'),JSON.parse(fs.readFileSync(path.join(unit,'bundle-pin.json'))).sha256);
 vm.runInNewContext(source.toString(),{module:mod,exports:mod.exports,process:vmProcess,Buffer,AbortController,AbortSignal,DOMException,ReadableStream,TextDecoder,TextEncoder,URL,URLSearchParams,queueMicrotask,fetch:()=>{throw new Error('Parent provider fetch is outside this CLI fixture');},console,setTimeout,clearTimeout,setInterval,clearInterval,require:id=>id==='vscode'?vscode:['child_process','node:child_process'].includes(id)?childModule:['os','node:os'].includes(id)?{...os,homedir:()=>env.HOME,tmpdir:()=>env.TMPDIR}:id==='process'||id==='node:process'?vmProcess:require(id)});
 provider=new mod.exports.OpenCodeProvider({subscriptions:[],secrets:{get:async()=>undefined,store:async()=>{},delete:async()=>{}}});
 const sample=inspectProcess;
 function ownedDescendant(pid,nativePid){const chain=[];let current=pid;for(let i=0;i<12;i++){const row=sample(current);assert(row,'Tool process must be live before Stop');chain.push(row);if(current===nativePid)return chain;assert(row.ppid>1,'Tool is not descended from the owned native process');current=row.ppid;}throw new Error('Owned ancestry depth exceeded');}
 async function until(predicate,label,ms){const deadline=Date.now()+ms;while(!predicate()){if(Date.now()>deadline)throw new Error('Owned observation deadline: '+label);await delay(50);}}
 function start(label,panel,command,nonce){const row={label,panel,command,nonce,startedAt:Date.now(),chunks:[],settled:false};cases.push(row);activeCase=row;append('case-starts.jsonl',row);
  const operation=(async()=>{try{for await(const chunk of provider.sendMessage('OWNED_'+label+': '+(command?'Run the requested owned bash command.':'Reply briefly.')+' nonce='+nonce,[],{provider:'opencode',model:'owned/fixture',mode:'edit-automatically',accessLevel:'full-access',thinkingLevel:'none',contextMode:'manual'},null,undefined,panel))row.chunks.push({...chunk,observedAt:Date.now()});}finally{row.settled=true;}})();operations.push(operation.catch(e=>String(e)));
  const settled=bounded(operation,label).then(async()=>{await bounded(Promise.all(children.filter(c=>c.case===label).map(c=>c.close)),label+' child close',15000);row.finishedAt=Date.now();append('cases.jsonl',row);console.log(JSON.stringify({label,chunks:row.chunks.map(c=>c.type)}));});return {row,settled};
 }
 const control=start('CONTROL','owned-panel-a',`/bin/sleep 2; printf 'CONTROL_FINISHED\\n' >> '${canary}'`,'CONTROL_519');await control.settled;
 assert.equal(fs.readFileSync(canary,'utf8'),'unchanged\nCONTROL_FINISHED\n');assert(control.row.chunks.some(c=>c.type==='tool_result'&&c.toolCall.name==='Bash'&&c.toolCall.status==='completed'));
 const shellFile=path.join(root,'workspace','tool.pid'),sleepFile=path.join(root,'workspace','sleep.pid');
 const command=`printf '%s\\n' "$$" > '${shellFile}'; /bin/sleep 12 & mysti_wait_pid=$!; printf '%s\\n' "$mysti_wait_pid" > '${sleepFile}'; wait "$mysti_wait_pid"; printf 'SHOULD_NOT_WRITE\\n' >> '${canary}'`;
 const stopped=start('TOOL_STOP','owned-panel-a',command,'STOP_627');await until(()=>fs.existsSync(shellFile)&&fs.existsSync(sleepFile)&&fs.readFileSync(sleepFile,'utf8').trim(),'actual tool PID files',90000);
 const nativeChild=children.find(c=>c.case==='TOOL_STOP');assert(nativeChild&&!nativeChild.closed);
 for(const [role,file] of [['shell',shellFile],['sleep',sleepFile]]){const pid=Number(fs.readFileSync(file,'utf8').trim());const chain=ownedDescendant(pid,nativeChild.pid);toolProcesses.push({role,pid,nativePid:nativeChild.pid,verifiedAt:Date.now(),chain});}
 const cancellation={label:'TOOL_STOP',at:Date.now(),chunksBefore:stopped.row.chunks.length,canaryBefore:fs.readFileSync(canary,'utf8')};cancellations.push(cancellation);provider.cancelCurrentRequest('owned-panel-a');await stopped.settled;
 await until(()=>{const sampleRow={at:Date.now(),processes:toolProcesses.map(p=>({role:p.role,pid:p.pid,process:sample(p.pid)}))};processSamples.push(sampleRow);return sampleRow.processes.every(p=>p.process===null);},'owned tool and sleep exit',10000);
 cancellation.allToolProcessesGoneAt=Date.now();assert(cancellation.allToolProcessesGoneAt-cancellation.at<10000);assert.equal(stopped.row.chunks.length,cancellation.chunksBefore);assert(!stopped.row.chunks.some(c=>c.type==='done'));assert.equal(fs.readFileSync(canary,'utf8'),'unchanged\nCONTROL_FINISHED\n');
 const recovery=start('RECOVERY','owned-panel-a',null,'RECOVERY_738');await recovery.settled;assert(recovery.row.chunks.some(c=>c.type==='text'&&c.content.includes('RECOVERY_738')));assert.equal(recovery.row.chunks.filter(c=>c.type==='done').length,1);assert(!recovery.row.chunks.some(c=>['error','auth_error','tool_use','tool_result'].includes(c.type)));
 const observationEnd=cancellation.at+12500;while(Date.now()<observationEnd)await delay(Math.min(100,observationEnd-Date.now()));cancellation.finalObservationAt=Date.now();
 assert.equal(fs.readFileSync(canary,'utf8'),'unchanged\nCONTROL_FINISHED\n');assert(toolProcesses.every(p=>sample(p.pid)===null));
 const done=recovery.row.chunks.find(c=>c.type==='done');assert.deepEqual(JSON.parse(JSON.stringify(done.usage)),{input_tokens:8,output_tokens:5,cache_read_input_tokens:2});assert.deepEqual(JSON.parse(JSON.stringify(done.contextUsage)),{input_tokens:8,output_tokens:5,cache_read_input_tokens:2});
 assert(children.find(c=>c.case==='RECOVERY').args.includes('--session'));assert.equal(children.find(c=>c.case==='CONTROL').code,0);assert.equal(children.find(c=>c.case==='RECOVERY').code,0);

})().catch(e=>{errors.push(String(e));console.error(String(e));process.exitCode=1;}).finally(async()=>{
 provider?.dispose();for(const row of children)if(!row.closed){try{process.kill(-row.pid,'SIGTERM');}catch{}try{await bounded(row.close,'native cleanup',10000);}catch{try{process.kill(-row.pid,'SIGKILL');}catch{}await row.close;}}
 for(const row of toolProcesses){const now=inspectProcess(row.pid);if(sameProcess(now,row.chain[0])){errors.push('Owned tool descendant survived primary cleanup: '+row.role);descendantCleanup.push({role:row.role,pid:row.pid,before:now,signal:'SIGKILL',at:Date.now()});try{process.kill(row.pid,'SIGKILL');}catch{}}}
 const descendantDeadline=Date.now()+3000;while(toolProcesses.some(p=>sameProcess(inspectProcess(p.pid),p.chain[0]))&&Date.now()<descendantDeadline)await delay(50);
 const allToolProcessesClosed=toolProcesses.every(p=>!sameProcess(inspectProcess(p.pid),p.chain[0]));if(!allToolProcessesClosed)errors.push('Verified owned tool descendant did not settle after cleanup');
 await bounded(Promise.allSettled(operations),'operations cleanup',10000).catch(e=>errors.push(String(e)));for(const socket of sockets)socket.destroy();if(server)await new Promise(r=>server.close(r));await delay(20);
 const result={classification:errors.length?'FAIL':'PASS_WITH_SCOPE_LIMITS',root,modelPort,cases,cancellations,toolProcesses,processSamples,descendantCleanup,allToolProcessesClosed,modelRequests:requests,children:children.map(({handle,close,...row})=>row),boundaryCalls,errors,nativeInvocations:children.length,externalProviderRequests:0,allNativeClosed:children.every(c=>c.closed),allOperationsSettled:cases.every(c=>c.settled),allSocketsClosed:sockets.size===0,canary:fs.readFileSync(canary,'utf8'),endurance:'DEFERRED_BY_USER',scope:'Native CLI Stop during a running shell tool with verified descendant PIDs, a delayed-write positive control and recovery using the unchanged production provider bundle; scripted local model, no real inference. Parent child-process boundary preserves arguments and forces owned environment/cwd/sandbox; stdout is captured with a byte-preserving Transform. Native cannot read actual user-home data, write outside owned root or reach external network.'};write('result.json',result);fs.writeFileSync(path.join(unit,'native-results.json'),JSON.stringify(result,null,2));
 const stopped=cancellations.find(c=>c.label==='TOOL_STOP');
 const summary={schemaVersion:1,classification:result.classification,recordedAt:new Date().toISOString(),platform:process.platform,architecture:process.arch,bundleSha256:bundleHash,
   command:'node scripts/validation/opencode-tool-stop.cjs --cli /path/to/native/opencode',
   cases:cases.map(c=>({label:c.label,settled:c.settled,chunkTypes:c.chunks.map(x=>x.type)})),
   nativeInvocations:children.length,scriptedModelRequests:requests.length,externalProviderRequests:0,
   verifiedSeparateToolGroup:toolProcesses.length===2&&toolProcesses.every(p=>p.chain[0].pgid!==p.nativePid),
   toolProcessesGoneAfterStopMs:stopped?.allToolProcessesGoneAt-stopped?.at,postStopObservationMs:stopped?.finalObservationAt-stopped?.at,
   delayedWriteAbsent:fs.readFileSync(canary,'utf8')==='unchanged\nCONTROL_FINISHED\n',emergencyDescendantCleanupCount:descendantCleanup.length,
   allNativeClosed:result.allNativeClosed,allToolProcessesClosed,allOperationsSettled:result.allOperationsSettled,allSocketsClosed:result.allSocketsClosed,
   errorCount:errors.length,scope:'Installed native CLI on macOS; production provider bundled from source, scripted loopback model and isolated disposable workspace. No paid inference, packaged VS Code UI, Windows/Linux qualification or elapsed endurance.'};
 fs.writeFileSync(path.join(unit,'summary.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify({classification:result.classification,cases:cases.length,nativeInvocations:children.length,modelRequests:requests.length,errors,allNativeClosed:result.allNativeClosed}));if(errors.length)process.exitCode=1;
});
