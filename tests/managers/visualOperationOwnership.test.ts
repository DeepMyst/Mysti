/** Deferred actual visual manager boundaries; no browser, shell, model or network calls. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VisualSessionManager, type LookOptions } from '../../src/managers/VisualSessionManager';
import { VisualOperationCancelled, type VisualOperationContext } from '../../src/services/VisualOperation';
import type { VisualResolution } from '../../src/services/visualTestPolicy';
function deferred<T=void>() { let resolve!:(value:T)=>void; return {promise:new Promise<T>(r=>{resolve=r;}),resolve:(v:T)=>resolve(v)}; }
function deferredPort<T>(value:T) { const entered=deferred();const release=deferred<T>();return {entered,release,value,call:vi.fn(()=>{entered.resolve();return release.promise;})}; }
const managers:VisualSessionManager[]=[];
afterEach(async()=>{await Promise.all(managers.splice(0).map(m=>m.dispose()));vi.restoreAllMocks();});
function resolution(extra:Partial<VisualResolution>={}):VisualResolution {return {config:{url:'http://localhost:3000',requirements:'',maxIterations:1,screenshotMode:'viewport',browser:'chromium',headless:true,viewportWidth:100,viewportHeight:100,interactionsEnabled:true},allowedOrigins:['http://localhost'],devCommandSource:'none',interactionPolicy:'safe',denials:[],...extra};}
function fixture(){
 const manager=new VisualSessionManager({storageDir:()=>'/inert',readyPattern:()=>undefined});managers.push(manager);
 const page={url:()=> 'http://localhost:3000',on:vi.fn(),evaluate:async()=>[],accessibility:{snapshot:async()=>null},waitForSelector:vi.fn(async()=>{})};
 const browser={dispose:vi.fn(async()=>{}),probe:vi.fn(async()=>({module:true,browser:true})),isOpen:()=>true,getPage:()=>page,launch:vi.fn(async()=>page),reload:vi.fn(async()=>{}),navigate:vi.fn(async()=>{}),close:vi.fn(async()=>{})};
 const server={dispose:vi.fn(async()=>{}),isRunning:()=>true,start:vi.fn(async()=>({url:'http://localhost:3000',pid:123})),stop:vi.fn(async()=>{})};
 const screenshot={getDomSnapshot:vi.fn(async()=>''),capture:vi.fn(async()=>({filePath:'/inert/shot.png',base64Data:'inert'}))};
 const interaction={execute:vi.fn(async()=>{})};Object.assign(manager,{_browser:browser,_devServer:server,_screenshot:screenshot,_interaction:interaction});
 const run=(owner='run-a',panel='panel',key=`mysti:${panel}`,extra:Partial<VisualOperationContext>={})=>{
  const abort=new AbortController();let current=true;
  const operation:VisualOperationContext={id:owner,panelId:panel,ownerKey:owner,workspaceRoot:'/inert',workspaceIdentity:'policy-a',signal:abort.signal,isCurrent:()=>current,...extra};
  const options:LookOptions={operation,approveDevServer:vi.fn(async()=>true),approveInteractions:vi.fn(async()=>true),reload:false};
  const target={cacheKey:key,panelId:panel,ownerKey:owner};
  return {abort,operation,options,target,invalidate:()=>{current=false;},look:(resolved=resolution())=>manager.look(target,resolved,options)};
 };
 return {manager,page,browser,server,screenshot,interaction,run};
}

describe('visual operation ownership',()=>{
 it.each(['panelId','ownerKey'] as const)('refuses target/context %s mismatch before any effect',async key=>{
  const h=fixture();const a=h.run();a.target[key]='wrong';await expect(a.look()).rejects.toThrow(/does not match/);expect(h.browser.probe).not.toHaveBeenCalled();expect((h.manager as any)._operations.size).toBe(0);
 });
 it('refuses pre-abort without probe or retained reservation',async()=>{
  const h=fixture();const a=h.run();a.abort.abort();await expect(a.look()).rejects.toBeInstanceOf(VisualOperationCancelled);expect(h.browser.probe).not.toHaveBeenCalled();expect((h.manager as any)._operations.size).toBe(0);
 });
 it('reserves a cold key before probe; sibling panel remains independent',async()=>{
  const h=fixture();const probe=deferredPort({module:true,browser:true});h.browser.probe.mockImplementationOnce(probe.call);
  const a=h.run();const pending=a.look();await probe.entered.promise;
  await expect(h.run('run-b').look()).rejects.toThrow(/already in progress/);expect(h.browser.launch).not.toHaveBeenCalled();
  await expect(h.run('sibling','other').look()).resolves.toMatchObject({sequence:1});
  probe.release.resolve(probe.value);await pending;expect(h.browser.launch).toHaveBeenCalledTimes(2);
 });
 it.each(['probe','approval','server','browser','reload','selector','actions-approval','action','dom','capture'] as const)('Stop during %s prevents subsequent effects and releases the caller',async boundary=>{
  const h=fixture();const a=h.run();let resolved=resolution();let held:any;
  if(boundary==='probe'){held=deferredPort({module:true,browser:true});h.browser.probe.mockImplementationOnce(held.call);}
  if(boundary==='approval'){held=deferredPort(true);a.options.approveDevServer=held.call;resolved=resolution({devCommand:'inert',devCommandSource:'settings'});}
  if(boundary==='server'){held=deferredPort({url:'http://localhost:3000',pid:1});h.server.start.mockImplementationOnce(held.call);resolved=resolution({devCommand:'inert',devCommandSource:'settings'});}
  if(boundary==='browser'){held=deferredPort(h.page);h.browser.launch.mockImplementationOnce(held.call);}
  if(boundary==='reload'){held=deferredPort(undefined);h.browser.reload.mockImplementationOnce(held.call);a.options.reload=true;}
  if(boundary==='selector'){held=deferredPort(undefined);h.page.waitForSelector.mockImplementationOnce(held.call);a.options.waitFor='#ready';}
  if(boundary==='actions-approval'){held=deferredPort(true);a.options.approveInteractions=held.call;a.options.actions=[{action:'click',target:'#one'}];}
  if(boundary==='action'){held=deferredPort(undefined);h.interaction.execute.mockImplementationOnce(held.call);a.options.actions=[{action:'click',target:'#one'},{action:'click',target:'#two'}];}
  if(boundary==='dom'){held=deferredPort('');h.screenshot.getDomSnapshot.mockImplementationOnce(held.call);}
  if(boundary==='capture'){held=deferredPort({filePath:'/inert/late',base64Data:''});h.screenshot.capture.mockImplementationOnce(held.call);}
  const result=a.look(resolved);const rejection=expect(result).rejects.toBeInstanceOf(VisualOperationCancelled);await held.entered.promise;a.abort.abort();await rejection;
  const before={actions:h.interaction.execute.mock.calls.length,captures:h.screenshot.capture.mock.calls.length};
  held.release.resolve(held.value);await new Promise(r=>setImmediate(r));
  expect(h.interaction.execute).toHaveBeenCalledTimes(before.actions);expect(h.screenshot.capture).toHaveBeenCalledTimes(before.captures);
  expect(h.manager.hasSession(a.target.cacheKey)).toBe(false);expect((h.manager as any)._operations.size).toBe(0);
  if(boundary==='approval'){expect(h.server.start).not.toHaveBeenCalled();}
  if(boundary==='action'){expect(h.interaction.execute).toHaveBeenCalledTimes(1);}
 });
 it('surfaces incomplete resource cleanup on cancellation rather than returning success',async()=>{
  const h=fixture();const a=h.run();const shot=deferredPort({filePath:'/inert/x',base64Data:''});h.screenshot.capture.mockImplementationOnce(shot.call);
  h.browser.close.mockRejectedValueOnce(new Error('inert cleanup failure'));
  const pending=a.look();const rejected=expect(pending).rejects.toMatchObject({name:'VisualOperationCancelled',cleanupIncomplete:true});
  await shot.entered.promise;a.abort.abort();await rejected;shot.release.resolve(shot.value);
 });
 it('retries the failed old resource epoch without closing a successor warm session',async()=>{
  const h=fixture();await h.run('old').look();const old=(h.manager as any)._sessions.get('mysti:panel');
  h.browser.close.mockRejectedValueOnce(new Error('old close failed'));
  await expect(h.manager.cancelOwner('old')).rejects.toThrow('old close failed');
  expect(h.manager.hasSession('mysti:panel')).toBe(false);expect((h.manager as any)._pendingCleanup.size).toBe(1);
  await h.run('new').look();const next=(h.manager as any)._sessions.get('mysti:panel');
  await h.manager.cancelOwner('old');
  expect(h.browser.close.mock.calls.map(([key])=>key)).toEqual([old.resourceKey,old.resourceKey]);
  expect(h.manager.hasSession('mysti:panel')).toBe(true);expect(next.resourceKey).not.toBe(old.resourceKey);
  expect((h.manager as any)._pendingCleanup.size).toBe(0);
 });
 it('disposal drains lower late-resource owners even with no remaining session or lease',async()=>{
  const h=fixture();h.browser.dispose.mockRejectedValueOnce(new Error('late runtime resource still open'));
  await expect(h.manager.dispose()).rejects.toThrow('late runtime resource still open');
  expect(h.server.dispose).toHaveBeenCalledOnce();await h.manager.dispose();expect(h.browser.dispose).toHaveBeenCalledTimes(2);
 });
 it('predicate invalidation after an allowed gate denies the next effect',async()=>{
  const h=fixture();const a=h.run();a.options.approveDevServer=async()=>{a.invalidate();return true;};
  await expect(a.look(resolution({devCommand:'inert',devCommandSource:'settings'}))).rejects.toBeInstanceOf(VisualOperationCancelled);expect(h.server.start).not.toHaveBeenCalled();
 });
 it('snapshots actions and cwd before a held approval; no caller mutation upgrades the plan',async()=>{
  const h=fixture();const a=h.run();const gate=deferredPort(true);a.options.approveDevServer=gate.call;
  const resolved=resolution({devCommand:'original',devCommandSource:'settings'});const pending=a.look(resolved);await gate.entered.promise;
  resolved.devCommand='replaced';(a.operation as any).workspaceRoot='/different';gate.release.resolve(true);await pending;
  expect(h.server.start).toHaveBeenCalledWith(expect.any(String),'original','/inert',undefined,'http://localhost:3000',expect.anything());
 });
 it('captures the target key before a caller mutates it during probe',async()=>{
  const h=fixture();const a=h.run();const probe=deferredPort({module:true,browser:true});h.browser.probe.mockImplementationOnce(probe.call);
  const pending=a.look();await probe.entered.promise;a.target.cacheKey='different';a.target.panelId='other';probe.release.resolve(probe.value);await pending;
  expect(h.manager.hasSession('mysti:panel')).toBe(true);expect(h.manager.hasSession('different')).toBe(false);expect((h.manager as any)._operations.size).toBe(0);
 });
 it('old parent abort cannot close a later operation reusing the same warm browser',async()=>{
  const h=fixture();const a=h.run();await a.look();const b=h.run('run-b');const shot=deferredPort({filePath:'/inert/b',base64Data:''});h.screenshot.capture.mockImplementationOnce(shot.call);
  const pending=b.look();await shot.entered.promise;a.abort.abort();expect(h.browser.close).not.toHaveBeenCalled();shot.release.resolve(shot.value);await pending;expect(h.browser.launch).toHaveBeenCalledTimes(1);
 });
 it('completed owner can close its warm session, but cannot close a newer reservation or lease',async()=>{
  const h=fixture();await h.run('old').look();const probe=deferredPort({module:true,browser:true});h.browser.probe.mockImplementationOnce(probe.call);
  const b=h.run('new');const pending=b.look();await probe.entered.promise;await h.manager.cancelOwner('old');expect(h.browser.close).not.toHaveBeenCalled();
  probe.release.resolve(probe.value);await pending;await h.manager.cancelOwner('old');expect(h.browser.close).not.toHaveBeenCalled();
  await h.manager.cancelOwner('new');expect(h.browser.close).toHaveBeenCalledOnce();expect(h.manager.hasSession('mysti:panel')).toBe(false);
 });
 it('late old browser cleanup targets its epoch and leaves successor session intact',async()=>{
  const h=fixture();const a=h.run();const launch=deferredPort(h.page);h.browser.launch.mockImplementationOnce(launch.call);
  const pending=a.look();const rejection=expect(pending).rejects.toBeInstanceOf(VisualOperationCancelled);await launch.entered.promise;const oldKey=h.browser.launch.mock.calls[0][0];a.abort.abort();await rejection;
  const b=h.run('run-b');await b.look();const newKey=h.browser.launch.mock.calls[1][0];expect(newKey).not.toBe(oldKey);
  launch.release.resolve(h.page);await new Promise(r=>setImmediate(r));expect(h.browser.close.mock.calls.every(([key])=>key!==newKey)).toBe(true);expect(h.manager.hasSession(b.target.cacheKey)).toBe(true);
 });
 it('cancelOwner isolates background job from foreground on the same panel',async()=>{
  const h=fixture();const foreground=h.run('foreground');await foreground.look();const job=h.run('job','panel','job:job');const shot=deferredPort({filePath:'/inert/job',base64Data:''});h.screenshot.capture.mockImplementationOnce(shot.call);
  const pending=job.look();const rejection=expect(pending).rejects.toBeInstanceOf(VisualOperationCancelled);await shot.entered.promise;await h.manager.cancelOwner('job');await rejection;shot.release.resolve(shot.value);
  expect(h.manager.hasSession('mysti:panel')).toBe(true);expect(h.manager.hasSession('job:job')).toBe(false);expect(h.browser.close).not.toHaveBeenCalledWith(h.browser.launch.mock.calls[0][0]);
 });
 it('closeForPanel retires real namespaced pending and warm targets without matching a sibling prefix',async()=>{
  const h=fixture();await h.run('a').look();await h.run('b','panel-child').look();const pendingOwner=h.run('dash','panel','dash:view');const gate=deferredPort(true);pendingOwner.options.approveDevServer=gate.call;
  const pending=pendingOwner.look(resolution({devCommand:'inert',devCommandSource:'settings'}));const rejection=expect(pending).rejects.toBeInstanceOf(VisualOperationCancelled);await gate.entered.promise;await h.manager.closeForPanel('panel');await rejection;gate.release.resolve(true);
  expect(h.manager.hasSession('mysti:panel')).toBe(false);expect(h.manager.hasSession('mysti:panel-child')).toBe(true);expect(h.server.start).not.toHaveBeenCalled();
 });
 it('warm policy narrowing uses fresh limits and metadata rejects a changed authority fingerprint',async()=>{
  const h=fixture();await h.run().look();expect(h.manager.getBaseUrl('mysti:panel','policy-b')).toBeUndefined();expect(h.manager.isDevServerRunning('mysti:panel','policy-b')).toBe(false);
  const b=h.run('b','panel','mysti:panel',{workspaceIdentity:'policy-b'});b.options.actions=[{action:'click',target:'#save'}];
  const result=await b.look(resolution({interactionPolicy:'off'}));expect(result.denials?.join()).toContain('disabled');expect(h.interaction.execute).not.toHaveBeenCalled();expect(h.browser.launch).toHaveBeenCalledTimes(2);
 });
 it('new workspace command retains positive capability after incompatible warm-state refusal',async()=>{
  const h=fixture();await h.run().look(resolution({devCommand:'old',devCommandSource:'settings'}));const b=h.run('b','panel','mysti:panel',{workspaceIdentity:'new-policy',workspaceRoot:'/new-root'});
  await b.look(resolution({devCommand:'new',devCommandSource:'settings'}));expect(h.server.stop).toHaveBeenCalledWith(h.server.start.mock.calls[0][0]);expect(h.server.start.mock.calls[1].slice(1,3)).toEqual(['new','/new-root']);
 });
});
