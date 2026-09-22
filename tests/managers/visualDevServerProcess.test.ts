/** Controlled owned processes only: no model, network, provider or profile access. */
import { it, expect } from 'vitest';
import { DevServerManager } from '../../src/managers/DevServerManager';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, execFile, type ChildProcess } from 'child_process';
function command(){return process.platform==='win32'?`"${process.execPath}" parent.cjs`:`'${process.execPath.replace(/'/g,"'\\''")}' parent.cjs`;}
function gone(pid:number){try{process.kill(pid,0);return false;}catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH';}}
async function noExecutingProcess(pid:number):Promise<boolean>{
 if(gone(pid)){return true;}
 // An adopted zombie has already stopped executing and can persist until PID1
 // reaps it in Linux containers. Query only this fixture's captured child PID.
 const state=await new Promise<string>(resolve=>execFile('ps',['-o','stat=','-p',String(pid)],{timeout:1000},(_error,stdout)=>resolve(stdout.trim())));
 return gone(pid)||state.startsWith('Z');
}
async function awaitNotExecuting(pid:number):Promise<void>{
 for(let attempt=0;attempt<20;attempt++){if(await noExecutingProcess(pid)){return;}await new Promise(resolve=>setTimeout(resolve,25));}
 throw new Error('Owned fixture child still executes after cleanup');
}
async function bounded(work:Promise<void>,ms:number){let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([work,new Promise<void>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned fixture did not close')),ms);})]);}finally{clearTimeout(timer);}}
it('Stop closes the owned tree even when its leader exits before a TERM-ignoring child; sibling survives',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mysti-visual-owned-process-'));const manager=new DevServerManager();
 // Readiness is event-driven; suppress fallback probes so this process fixture performs no network calls.
 (manager as any)._httpCheck=async()=>false;
 const child="process.on('SIGTERM',()=>{});require('fs').writeFileSync('child.pid',String(process.pid));console.log('ready in 1ms');setInterval(()=>{},1000);";
 fs.writeFileSync(path.join(root,'parent.cjs'),"require('child_process').spawn(process.execPath,['-e',"+JSON.stringify(child)+"],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000);");
 const siblingRoot=fs.mkdtempSync(path.join(os.tmpdir(),'mysti-visual-owned-sibling-'));
 fs.writeFileSync(path.join(siblingRoot,'parent.cjs'),"require('fs').writeFileSync('sibling.pid',String(process.pid));console.log('ready in 1ms');setInterval(()=>{},1000);");
 let target:ChildProcess|undefined;let sibling:ChildProcess|undefined;let childPid=0;let siblingPid=0;let closed=false;
 try{
  await manager.start('target',command(),root,undefined,'http://127.0.0.1:9');
  target=(manager as any)._processes.get('target').process;target!.once('close',()=>{closed=true;});
  childPid=Number(fs.readFileSync(path.join(root,'child.pid'),'utf8'));
  await manager.start('sibling',command(),siblingRoot,undefined,'http://127.0.0.1:9');sibling=(manager as any)._processes.get('sibling').process;siblingPid=Number(fs.readFileSync(path.join(siblingRoot,'sibling.pid'),'utf8'));
  expect(gone(childPid)).toBe(false);await bounded(manager.stop('target'),7500);
  // Pipe closure proves the TERM-ignoring descendant no longer retains the owned output.
  expect(closed).toBe(true);expect(manager.isRunning('target')).toBe(false);expect(manager.isRunning('sibling')).toBe(true);
  if(process.platform!=='win32'){await awaitNotExecuting(childPid);}
 }finally{
  try {
   const disposed=await Promise.allSettled([manager.dispose()]);
   const killWindows=async(pid:number)=>{
    if(!pid||gone(pid)){return;}
    const helper=spawn('taskkill',['/PID',String(pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
    try{await bounded(new Promise<void>(resolve=>{helper.once('exit',()=>resolve());helper.once('error',()=>resolve());}),2000);}
    finally{helper.kill();helper.unref();}
   };
   const cleanup=async(proc:ChildProcess|undefined)=>{
    if(!proc?.pid){return;}
    if(process.platform!=='win32'){try{process.kill(-proc.pid,'SIGKILL');}catch{}return;}
    await killWindows(proc.pid);
   };
   await Promise.allSettled([cleanup(target),cleanup(sibling)]);
   // The fixture records its exact child PIDs: if a Windows root exited, a
   // root-only taskkill cannot discover its orphan. Do not enumerate processes.
   if(process.platform==='win32'){await Promise.allSettled([killWindows(childPid),killWindows(siblingPid)]);}
   const failed=disposed.find(result=>result.status==='rejected');
   if(failed?.status==='rejected'){throw failed.reason;}
  }finally{
   for(const proc of [target,sibling]){proc?.stdout?.destroy();proc?.stderr?.destroy();proc?.unref();}
   fs.rmSync(root,{recursive:true,force:true});fs.rmSync(siblingRoot,{recursive:true,force:true});
  }

 }
},12000);
