/* PC-09 transparent forwarding; receipts retain only synthetic identifiers. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
exports.createIsolationCli = ({ directory, provider, executable, node, hooks, window, tokens }) => {
  const launcher = path.join(directory, `${provider}-isolation-fixture`), receipts = path.join(directory, `${provider}-receipts.jsonl`);
  fs.writeFileSync(launcher, `#!${node}
'use strict';
const fs=require('fs'),{spawn}=require('child_process'),{createHash}=require('crypto'),{StringDecoder}=require('string_decoder');
const provider=${JSON.stringify(provider)},window=${JSON.stringify(window)},tokens=${JSON.stringify(tokens)},args=process.argv.slice(2);
const flag=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
const persistent=provider==='claude-code'?flag('--input-format')==='stream-json'&&flag('--output-format')==='stream-json':args.includes('app-server');
const inference=provider==='claude-code'&&args.includes('--print');
const hash=value=>typeof value==='string'&&value?createHash('sha256').update(value).digest('hex'):undefined;
const record=value=>{if(persistent||inference)fs.appendFileSync(${JSON.stringify(receipts)},JSON.stringify({window,provider,at:Date.now(),wrapperPid:process.pid,...value})+'\\n',{mode:0o600});};
const child=spawn(${JSON.stringify(executable)},inference?[...args,'--settings',${JSON.stringify(hooks)}]:args,{env:process.env,stdio:['pipe','pipe','pipe']});
const blocks=value=>typeof value==='string'?value:Array.isArray(value)?value.filter(v=>v&&v.type==='text'&&typeof v.text==='string').map(v=>v.text).join('\\n'):'';
let sessionHash=hash(flag('--resume')),model=flag('--model'),auxInput=false;
const safeModel=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,127}$/.test(value)?value:undefined;
function captureInput(line){
 if(!persistent)return;let v;try{v=JSON.parse(line);}catch{return;}
 if(provider==='openai-codex'&&['thread/start','thread/resume'].includes(v.method)){model=safeModel(v.params?.model)||model;if(v.params?.threadId)sessionHash=hash(v.params.threadId);}
 let prompt,method;if(provider==='claude-code'&&v.type==='user'&&v.message?.role==='user'){prompt=blocks(v.message.content);method='user';}
 if(provider==='openai-codex'&&v.method==='turn/start'){prompt=blocks(v.params?.input);method='turn/start';sessionHash=hash(v.params?.threadId)||sessionHash;}
 if(typeof prompt==='string')record({event:'request',method,markers:[...new Set((prompt.match(/PC09_REQUEST:[A-Z0-9_]+/g)||[]).map(x=>x.substring(13)))],contextScopes:Object.entries(tokens).filter(([,token])=>prompt.includes(token)).map(([scope])=>scope),promptSha256:hash(prompt),sessionHash,model:safeModel(model)});
}
function captureOutput(line){
 if(!persistent)return;let v;try{v=JSON.parse(line);}catch{return;}
 const id=provider==='claude-code'?v.type==='system'&&v.subtype==='init'?v.session_id:undefined:v.result?.thread?.id||(v.method==='thread/started'?v.params?.thread?.id:undefined);
 if(typeof id==='string'){sessionHash=hash(id);record({event:'session',sessionHash,model:safeModel(v.model||v.result?.model)});}
}
function inspect(stream,callback){const decoder=new StringDecoder('utf8');let pending='',discard=false;stream.on('data',chunk=>{const pieces=decoder.write(chunk).split('\\n');for(let i=0;i<pieces.length;i++){if(!discard){if(pending.length+pieces[i].length>1024*1024){pending='';discard=true;}else pending+=pieces[i];}if(i<pieces.length-1){if(!discard)callback(pending);pending='';discard=false;}}});}
inspect(process.stdin,captureInput);inspect(child.stdout,captureOutput);
process.stdin.on('data',chunk=>{if(inference&&!persistent&&!auxInput&&chunk.length){auxInput=true;record({event:'auxiliary-input'});}});
process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);child.stdin.on('error',()=>{});
child.on('spawn',()=>record({event:persistent?'start':'auxiliary-start',childPid:child.pid}));
child.on('error',()=>{process.stderr.write('PC09 selected CLI launch failed.\\n');process.exitCode=1;process.stdin.pause();});
child.on('close',(code,signal)=>{record({event:persistent?'exit':'auxiliary-exit',childPid:child.pid,exitCode:code});process.stdin.unpipe(child.stdin);process.stdin.pause();if(signal){process.removeAllListeners(signal);process.kill(process.pid,signal);}else process.exitCode=code??1;});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{if(!child.killed)child.kill(signal);});
`, { mode: 0o700 });
  return { launcher, receipts };
};
