/* PC-08: transparent CLI receipts for conversation/title ownership. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function createHistoryCliFixture(directory, provider, executable, nodePath, hooksPath) {
  for (const value of [directory, executable, nodePath, hooksPath]) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('History fixture requires absolute owned paths');
  }
  if (!['claude-code', 'openai-codex'].includes(provider)) throw new Error('Unsupported history fixture provider');
  const launcher = path.join(directory, provider + '-history-fixture');
  const receiptsPaths = Object.fromEntries(['preflight-write', 'preflight-read', 'create', 'restart', 'title-probe'].map(stage => [stage, path.join(directory, provider + '-' + stage + '-receipts.jsonl')]));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(launcher, `#!${nodePath}
'use strict';
const fs=require('node:fs'),{spawn}=require('node:child_process'),{createHash}=require('node:crypto'),{StringDecoder}=require('node:string_decoder');
const provider=${JSON.stringify(provider)},args=process.argv.slice(2),flag=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
const persistent=provider==='claude-code'?flag('--input-format')==='stream-json'&&flag('--output-format')==='stream-json':args.includes('app-server');
const inference=provider==='claude-code'&&args.includes('--print');
const digest=value=>typeof value==='string'&&value?createHash('sha256').update(value).digest('hex'):undefined;
const receiptsPaths=${JSON.stringify(receiptsPaths)},receiptsPath=receiptsPaths[process.env.MYSTI_PC08_STAGE]||receiptsPaths.create;
const record=value=>{if(persistent||inference)fs.appendFileSync(receiptsPath,JSON.stringify({provider,at:Date.now(),wrapperPid:process.pid,...value})+'\\n',{mode:0o600});};
const child=spawn(${JSON.stringify(executable)},inference?[...args,'--settings',${JSON.stringify(hooksPath)}]:args,{env:process.env,stdio:['pipe','pipe','pipe']});
const markers=text=>[...new Set((text.match(/PC08_TASK_(?:0[1-9]|1[0-9]|20|INTERRUPTED)/g)||[]))];
const blocks=v=>typeof v==='string'?v:Array.isArray(v)?v.filter(x=>x&&x.type==='text'&&typeof x.text==='string').map(x=>x.text).join('\\n'):'';
let sessionHash=digest(flag('--resume')),auxInput='',auxOutput='',auxInputRecorded=false,auxKind='unknown';
const auxInputDecoder=new StringDecoder('utf8'),auxOutputDecoder=new StringDecoder('utf8');
function captureInput(line){
 if(!persistent)return;let value;try{value=JSON.parse(line);}catch{return;}
 if(provider==='openai-codex'&&value.method==='thread/resume')sessionHash=digest(value.params?.threadId);
 let prompt,method;if(provider==='claude-code'&&value.type==='user'&&value.message?.role==='user'){prompt=blocks(value.message.content);method='user';}
 if(provider==='openai-codex'&&value.method==='turn/start'){prompt=blocks(value.params?.input);method='turn/start';sessionHash=digest(value.params?.threadId)||sessionHash;}
 if(typeof prompt==='string')record({event:'request',method,markers:markers(prompt),sessionHash});
}
function captureOutput(line){
 if(!persistent)return;let value;try{value=JSON.parse(line);}catch{return;}
 const id=provider==='claude-code'?value.type==='system'&&value.subtype==='init'?value.session_id:undefined:value.result?.thread?.id||(value.method==='thread/started'?value.params?.thread?.id:undefined);
 if(typeof id==='string'){sessionHash=digest(id);record({event:'session',sessionHash});}
}
function inspect(stream,capture){const decoder=new StringDecoder('utf8');let pending='',discard=false;stream.on('data',chunk=>{
 const pieces=decoder.write(chunk).split('\\n');for(let i=0;i<pieces.length;i++){if(!discard){if(pending.length+pieces[i].length>1024*1024){pending='';discard=true;}else pending+=pieces[i];}
 if(i<pieces.length-1){if(!discard)capture(pending);pending='';discard=false;}}});}
inspect(process.stdin,captureInput);inspect(child.stdout,captureOutput);
process.stdin.on('data',chunk=>{if(inference&&!persistent&&auxInput.length<1024*1024)auxInput+=auxInputDecoder.write(chunk);});
process.stdin.on('end',()=>{if(!inference||persistent||!auxInput||auxInputRecorded)return;auxInputRecorded=true;
 auxKind=auxInput.startsWith('Generate a short, concise title')?'title':auxInput.includes('planOptions')?'classifier':'other';
 record({event:'auxiliary-input',kind:auxKind,markers:markers(auxInput)});auxInput='';});
child.stdout.on('data',chunk=>{if(inference&&!persistent){if(auxOutput.length<8192)auxOutput+=auxOutputDecoder.write(chunk);
 record({event:'auxiliary-output',kind:auxKind,titleCandidateHash:digest(auxOutput.trim().substring(0,50))});}});
process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);child.stdin.on('error',()=>{});
child.on('spawn',()=>record({event:persistent?'start':'auxiliary-start',childPid:child.pid,sessionHash}));
child.on('error',()=>{process.stderr.write('PC08 selected CLI failed to launch.\\n');process.exitCode=1;process.stdin.pause();});
child.on('close',(code,signal)=>{record({event:persistent?'exit':'auxiliary-exit',childPid:child.pid,exitCode:code});process.stdin.unpipe(child.stdin);process.stdin.pause();if(signal){process.removeAllListeners(signal);process.kill(process.pid,signal);}else process.exitCode=code??1;});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{if(!child.killed)child.kill(signal);});
`, { mode: 0o700 });
  return { path: launcher, receiptsPaths };
}

module.exports = { createHistoryCliFixture };
