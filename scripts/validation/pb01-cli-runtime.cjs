/* Transparent Claude transport receipts for one explicitly owned PB-01 profile. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{createHash}=require('node:crypto'),{StringDecoder}=require('node:string_decoder');
module.exports=function run(config){
  const {executable,receiptFile,workspace,hooks,counterFile,token,attachmentToken,maxInputs=30}=config;
  const args=process.argv.slice(2),hash=value=>value===undefined?undefined:createHash('sha256').update(String(value)).digest('hex');
  const flag=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined;};
  const safe=value=>typeof value==='string'&&/^[A-Za-z0-9_./:\[\]-]{1,160}$/.test(value)?value:undefined;
  const record=value=>fs.appendFileSync(receiptFile,JSON.stringify({window:'A',provider:'claude-code',at:Date.now(),wrapperPid:process.pid,...value})+'\n',{mode:0o600});
  const persistent=flag('--input-format')==='stream-json'&&flag('--output-format')==='stream-json';
  const inference=persistent||args.includes('--print')||args.includes('-p');
  let forwarded=args.slice(),sessionHash=hash(flag('--resume')),auxiliaryInput=false;
  const policy={model:safe(flag('--model')),effort:safe(flag('--effort')),permissionMode:safe(flag('--permission-mode')),
    nativeResumeSupplied:args.some(value=>value==='--resume'||value.startsWith('--resume=')),outputFormat:safe(flag('--output-format'))};
  if(inference){
    const indices=args.flatMap((value,index)=>value==='--settings'||value.startsWith('--settings=')?[index]:[]);
    if(!indices.length)forwarded.push('--settings',hooks);
    else try{
      if(indices.length!==1||args[indices[0]]!=='--settings')throw new Error('ambiguous-settings');
      const source=args[indices[0]+1],parent=path.dirname(source);
      if(!/^mysti-claude-settings-[A-Za-z0-9]+$/.test(path.basename(parent))||!/^ultracode-(on|off)\.json$/.test(path.basename(source)))throw new Error('unknown-settings');
      if(fs.realpathSync(path.dirname(parent))!==fs.realpathSync(os.tmpdir())||fs.lstatSync(source).isSymbolicLink()||fs.lstatSync(parent).isSymbolicLink()||fs.statSync(source).size>1024)throw new Error('unowned-settings');
      const original=fs.readFileSync(source,'utf8'),value=JSON.parse(original);
      if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).join(',')!=='ultracode'||typeof value.ultracode!=='boolean')throw new Error('unexpected-settings-fields');
      const merged=JSON.stringify({...value,disableAllHooks:true}),destination=path.join(path.dirname(hooks),`claude-merged-settings-${process.pid}.json`);
      fs.writeFileSync(destination,merged,{mode:0o600,flag:'wx'});forwarded[indices[0]+1]=destination;
      record({event:'claude-settings-merge',originalSha256:hash(original),mergedSha256:hash(merged),ultracode:value.ultracode,disableAllHooks:true,settingsArguments:1});
    }catch{record({event:'wrapper-rejected-settings'});process.stderr.write('PB01 refuses unrecognized Claude settings.\n');process.exitCode=1;return;}
  }
  const text=value=>typeof value==='string'?value:Array.isArray(value)?value.filter(part=>part&&part.type==='text'&&typeof part.text==='string').map(part=>part.text).join('\n'):'';
  const markers=value=>[...new Set([...value.matchAll(/PB01_REQUEST:([A-Z0-9_]+)/g)].map(match=>match[1]))];
  function claimInput(){
    const lock=counterFile+'.lock';let fd;
    try{
      fd=fs.openSync(lock,'wx',0o600);
      const previous=fs.existsSync(counterFile)?JSON.parse(fs.readFileSync(counterFile,'utf8')):{forwardedInputs:0};
      if(!Number.isInteger(previous.forwardedInputs)||previous.forwardedInputs>=maxInputs)throw new Error('input-cap');
      const count=previous.forwardedInputs+1;fs.writeFileSync(counterFile,JSON.stringify({forwardedInputs:count,maxInputs}),{mode:0o600});return count;
    }finally{if(fd!==undefined){fs.closeSync(fd);fs.unlinkSync(lock);}}
  }
  function promptInput(value){
    const prompt=text(value.message?.content),index=claimInput();
    const memory=[...prompt.matchAll(/<<<UNTRUSTED ([a-z0-9]+)\n([\s\S]*?)\n\1 UNTRUSTED>>>/g)];
    let outside=prompt;for(const block of memory)outside=outside.replace(block[0],'');
    const command=prompt.trim().startsWith('/');
    record({event:command?'native-command':'request',inputIndex:index,method:'user',model:policy.model,policy,sessionHash,
      markers:markers(prompt),outsideMemoryMarkers:markers(outside),memoryMarkers:markers(memory.map(value=>value[2]).join('\n')),
      containsFixtureToken:prompt.includes(token),containsAttachmentToken:prompt.includes(attachmentToken),promptSha256:hash(prompt),promptBytes:Buffer.byteLength(prompt),
      command:command?safe(prompt.trim().split(/\s/)[0]):undefined});
  }
  function tool(value,event){
    const input=value.input||{},supplied=input.file_path||input.path;
    const absolute=typeof supplied==='string'?path.resolve(workspace,supplied):undefined;
    const relative=absolute&&absolute.startsWith(workspace+path.sep)?path.relative(workspace,absolute):undefined;
    const output=value.content;
    record({event,toolIdHash:hash(value.id||value.tool_use_id),name:safe(value.name),relativePath:relative,
      pathSha256:hash(supplied),inputSha256:hash(JSON.stringify(input)),commandSha256:hash(input.command),
      exactVisibleTestCommand:input.command==='node --test test/retry.test.cjs',
      oldStringSha256:hash(input.old_string),newStringSha256:hash(input.new_string),replaceAll:input.replace_all,
      outputSha256:hash(typeof output==='string'?output:JSON.stringify(output)),success:event==='tool-result'&&(value.is_error===undefined||typeof value.is_error==='boolean')?value.is_error!==true:undefined,
      containsFixtureToken:JSON.stringify(output||'').includes(token),containsAttachmentToken:JSON.stringify(output||'').includes(attachmentToken)});
  }
  function output(line){
    let value;try{value=JSON.parse(line);}catch{return;}if(!value||typeof value!=='object'||Array.isArray(value))return;
    if(value.type==='system'&&value.subtype==='init'){
      if(typeof value.session_id==='string')sessionHash=hash(value.session_id);
      record({event:'session',sessionHash,actualModel:safe(value.model),nativeCommands:Array.isArray(value.slash_commands)?value.slash_commands.filter(value=>typeof value==='string').map(safe).filter(Boolean):undefined});
    }
    if(value.type==='control_request'){
      const request=value.request||{},input=request.input||{};
      record({event:'native-control-request',nativeRequestIdHash:hash(value.request_id),subtype:safe(request.subtype),toolName:safe(request.tool_name||input.tool_name),toolIdHash:hash(request.tool_use_id),inputSha256:hash(JSON.stringify(request.input||{}))});
    }
    for(const block of Array.isArray(value.message?.content)?value.message.content:[]){if(!block||typeof block!=='object')continue;if(block.type==='tool_use')tool(block,'tool-start');if(block.type==='tool_result')tool(block,'tool-result');}
    if(value.type==='result')record({event:'native-result',isError:value.is_error===true,subtype:safe(value.subtype),resultSha256:hash(value.result),usage:value.usage&&typeof value.usage==='object'?Object.fromEntries(['input_tokens','output_tokens','cache_creation_input_tokens','cache_read_input_tokens'].filter(key=>typeof value.usage[key]==='number').map(key=>[key,value.usage[key]])):undefined,totalCostUsd:typeof value.total_cost_usd==='number'?value.total_cost_usd:undefined});
  }
  const child=spawn(executable,[...(config.prefixArgs||[]),...forwarded],{env:process.env,stdio:['pipe','pipe','pipe']});
  let inputBuffer=Buffer.alloc(0),closed=false;
  function forward(line){
    if(closed)return;
    if(persistent){
      let value;try{value=JSON.parse(line.toString('utf8'));}catch{}
      if(value&&typeof value==='object'&&!Array.isArray(value)){
        if(value.type==='user'&&value.message?.role==='user')try{promptInput(value);}catch{record({event:'input-cap-refusal',maxInputs});closed=true;child.kill('SIGTERM');process.stdin.pause();return;}
        if(value.type==='control_response')record({event:'native-control-response',nativeRequestIdHash:hash(value.response?.request_id),subtype:safe(value.response?.subtype),behavior:safe(value.response?.response?.behavior),hookDecision:safe(value.response?.response?.hookSpecificOutput?.permissionDecision)});
      }
    }
    child.stdin.write(line);
  }
  process.stdin.on('data',chunk=>{
    if(!persistent){if(inference&&!auxiliaryInput&&chunk.length){auxiliaryInput=true;record({event:'auxiliary-input'});}child.stdin.write(chunk);return;}
    inputBuffer=Buffer.concat([inputBuffer,chunk]);
    let index;while((index=inputBuffer.indexOf(10))>=0){const line=inputBuffer.subarray(0,index+1);inputBuffer=inputBuffer.subarray(index+1);forward(line);}
    if(inputBuffer.length>8*1024*1024){record({event:'oversized-input-refusal'});closed=true;child.kill('SIGTERM');process.stdin.pause();}
  });
  process.stdin.on('end',()=>{if(inputBuffer.length)forward(inputBuffer);child.stdin.end();});
  const decoder=new StringDecoder('utf8');let buffer='',discard=false;
  child.stdout.on('data',chunk=>{
    for(const [index,part] of decoder.write(chunk).split('\n').entries()){
      if(index){if(!discard)try{output(buffer);}catch{record({event:'instrumentation-error'});}buffer='';discard=false;}
      if(!discard){if(buffer.length+part.length>2*1024*1024){buffer='';discard=true;}else buffer+=part;}
    }
  });
  child.stdout.on('end',()=>{if(!discard&&buffer)try{output(buffer+decoder.end());}catch{record({event:'instrumentation-error'});}});
  child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);child.stdin.on('error',()=>{});
  child.on('spawn',()=>record({event:inference?persistent?'start':'auxiliary-start':'probe-start',childPid:child.pid,policy}));
  child.on('error',()=>{record({event:'launch-error'});process.exitCode=1;process.stdin.pause();});
  child.on('close',(code,signal)=>{record({event:inference?'exit':'probe-exit',childPid:child.pid,exitCode:code,signal});process.stdin.pause();if(signal){process.removeAllListeners(signal);process.kill(process.pid,signal);}else process.exitCode=code??1;});
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{if(!child.killed)child.kill(signal);});
};
