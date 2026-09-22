/** Actual runtime adapters with deferred inert browser and filesystem boundaries. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BrowserManager } from '../../src/services/BrowserManager';
import { ScreenshotService } from '../../src/services/ScreenshotService';
import { awaitVisualOperation, VisualOperationCancelled } from '../../src/services/VisualOperation';
function deferred<T=void>(){let resolve!:(v:T)=>void;return {promise:new Promise<T>(r=>{resolve=r;}),resolve:(v:T)=>resolve(v)};}
const config:any={url:'http://localhost:3000',browser:'chromium',headless:true,viewportWidth:100,viewportHeight:100};
function control(){const abort=new AbortController();return {abort,signal:abort.signal,isCurrent:()=>true};}
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
function browserFixture(){
 const manager=new BrowserManager();
 const page={on:vi.fn(),goto:vi.fn(async()=>{}),waitForLoadState:vi.fn(async()=>{}),waitForSelector:vi.fn(async()=>{})};
 const context={route:vi.fn(async()=>{}),newPage:vi.fn(async()=>page)};
 const browser={newContext:vi.fn(async()=>context),close:vi.fn(async()=>{})};
 const type={launch:vi.fn(async()=>browser)};const playwright={chromium:type};
 vi.spyOn(manager,'ensurePlaywright').mockResolvedValue(playwright);
 return {manager,page,context,browser,type,playwright};
}
describe('owned browser startup',()=>{
 it.each(['module','launch','context','route','page','navigation','selector'] as const)('cancels at %s and closes only the returned owned browser',async boundary=>{
  const h=browserFixture();const c=control();const entered=deferred();const held=deferred<any>();let value:any;
  const wait=()=>{entered.resolve();return held.promise;};
  if(boundary==='module'){value=h.playwright;vi.mocked(h.manager.ensurePlaywright).mockImplementationOnce(wait);}
  if(boundary==='launch'){value=h.browser;h.type.launch.mockImplementationOnce(wait);}
  if(boundary==='context'){value=h.context;h.browser.newContext.mockImplementationOnce(wait);}
  if(boundary==='route'){value=undefined;h.context.route.mockImplementationOnce(wait);}
  if(boundary==='page'){value=h.page;h.context.newPage.mockImplementationOnce(wait);}
  if(boundary==='navigation'){value=undefined;h.page.goto.mockImplementationOnce(wait);}
  if(boundary==='selector'){value=undefined;h.page.waitForSelector.mockImplementationOnce(wait);}
  const pending=h.manager.launch('owned',{...config,...(boundary==='selector'?{waitForSelector:'#ready'}:{})},['http://localhost'],c);
  const rejected=expect(pending).rejects.toBeInstanceOf(VisualOperationCancelled);await entered.promise;c.abort.abort();await rejected;
  held.resolve(value);await new Promise(r=>setImmediate(r));
  expect(h.manager.getPage('owned')).toBeNull();
  expect(h.browser.close).toHaveBeenCalledTimes(boundary==='module'?0:1);
  if(boundary==='module'){expect(h.type.launch).not.toHaveBeenCalled();}
 });
 it('old launch rejection/close cannot remove a new browser under the same key',async()=>{
  const h=browserFixture();const old=control();const entered=deferred();const held=deferred<any>();
  h.browser.newContext.mockImplementationOnce(()=>{entered.resolve();return held.promise;});
  const pending=h.manager.launch('same',config,['http://localhost'],old);const rejected=expect(pending).rejects.toBeInstanceOf(VisualOperationCancelled);await entered.promise;old.abort.abort();await rejected;
  const newPage={...h.page};const newBrowser={newContext:async()=>({route:async()=>{},newPage:async()=>newPage}),close:vi.fn(async()=>{})};h.type.launch.mockResolvedValueOnce(newBrowser as any);
  await h.manager.launch('same',config,['http://localhost'],control());held.resolve(h.context);await new Promise(r=>setImmediate(r));
  expect(h.manager.getPage('same')).toBe(newPage);expect(newBrowser.close).not.toHaveBeenCalled();await h.manager.close('same');
 });
 it('rechecks Stop between reserving pending creation and invoking the native launch',async()=>{
  const h=browserFixture();const c=control();const pending=(h.manager as any)._pendingLaunches as Set<unknown>;
  const add=pending.add.bind(pending);vi.spyOn(pending,'add').mockImplementation(value=>{const result=add(value);queueMicrotask(()=>c.abort.abort());return result;});
  await expect(h.manager.launch('owned',config,['http://localhost'],c)).rejects.toBeInstanceOf(VisualOperationCancelled);
  await new Promise(r=>setImmediate(r));expect(h.type.launch).not.toHaveBeenCalled();expect(pending.size).toBe(0);await h.manager.dispose();
 });
 it('retains a failed old browser close and retries its exact handle without touching the successor',async()=>{
  const h=browserFixture();await h.manager.launch('same',config,['http://localhost'],control());
  h.browser.close.mockRejectedValueOnce(new Error('held browser close'));
  const old=(h.manager as any)._sessions.get('same');
  await expect(h.manager.close('same')).rejects.toThrow('held browser close');
  expect(h.manager.isOpen('same')).toBe(false);expect((h.manager as any)._pendingCleanup.size).toBe(1);
  const nextPage={...h.page};const next={newContext:async()=>({route:async()=>{},newPage:async()=>nextPage}),close:vi.fn(async()=>{})};h.type.launch.mockResolvedValueOnce(next as any);
  await h.manager.launch('same',config,['http://localhost'],control());
  await (h.manager as any)._closeCaptured('same',old);
  expect(h.browser.close).toHaveBeenCalledTimes(2);expect(next.close).not.toHaveBeenCalled();expect(h.manager.getPage('same')).toBe(nextPage);
  await h.manager.dispose();expect(next.close).toHaveBeenCalledOnce();expect((h.manager as any)._pendingCleanup.size).toBe(0);
 });
 it('keeps a timed-out browser handle retryable while observing its late close rejection',async()=>{
  const h=browserFixture();await h.manager.launch('owned',config,['http://localhost'],control());vi.useFakeTimers();
  let reject!:(error:Error)=>void;h.browser.close.mockImplementationOnce(()=>new Promise<void>((_resolve,no)=>{reject=no;}));
  const pending=h.manager.close('owned');const refused=expect(pending).rejects.toThrow(/not confirmed within 5000ms/);
  await vi.advanceTimersByTimeAsync(5000);await refused;expect((h.manager as any)._pendingCleanup.size).toBe(1);
  await h.manager.dispose();expect(h.browser.close).toHaveBeenCalledTimes(2);expect((h.manager as any)._pendingCleanup.size).toBe(0);
  reject(new Error('late timed-out close'));await Promise.resolve();
 });
 it('reports an unreturned launch as incomplete and retains its failed late handle for disposal',async()=>{
  const h=browserFixture();const c=control();const entered=deferred();const held=deferred<any>();
  h.type.launch.mockImplementationOnce(()=>{entered.resolve();return held.promise;});
  h.browser.close.mockRejectedValueOnce(new Error('late close failed'));
  const warning=vi.spyOn(console,'warn').mockImplementation(()=>{});
  const pending=h.manager.launch('owned',config,['http://localhost'],c);
  const rejected=expect(pending).rejects.toMatchObject({name:'VisualOperationCancelled',cleanupIncomplete:true});await entered.promise;c.abort.abort();await rejected;
  await expect(h.manager.close('owned')).rejects.toThrow(/launch has not returned/);
  await expect(h.manager.dispose()).rejects.toThrow(/launch has not returned/);
  held.resolve(h.browser);await new Promise(r=>setImmediate(r));
  expect(warning).toHaveBeenCalled();expect((h.manager as any)._pendingLaunches.size).toBe(0);expect((h.manager as any)._pendingCleanup.size).toBe(1);
  await h.manager.dispose();expect(h.browser.close).toHaveBeenCalledTimes(2);expect((h.manager as any)._pendingCleanup.size).toBe(0);
 });
 it('retains allowed routing and rejects unapproved origins on a valid owned browser',async()=>{
  const h=browserFixture();let handler!:(route:any)=>Promise<void>;
  h.context.route.mockImplementation(async(_pattern:any,fn:any)=>{handler=fn;});
  await h.manager.launch('owned',config,['http://localhost'],control());
  for(const [url,allowed] of [['http://localhost:3000/test',true],['http://localhost.evil.invalid/',false]] as const){
   const route={request:()=>({url:()=>url}),continue:vi.fn(async()=>{}),abort:vi.fn(async()=>{})};await handler(route);expect(allowed?route.continue:route.abort).toHaveBeenCalledOnce();
  }
  await h.manager.close('owned');expect(h.browser.close).toHaveBeenCalledOnce();
 });
});

describe('owned screenshot commit',()=>{
 it.each(['settle','element','bytes'] as const)('writes no directory/file after cancellation during %s',async boundary=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mysti-owned-shot-'));const dir=path.join(root,'capture');const c=control();const entered=deferred();const held=deferred<any>();
  const element={screenshot:vi.fn(async()=>Buffer.from('inert'))};const page={waitForTimeout:vi.fn(async()=>{}),$:vi.fn(async()=>element),screenshot:vi.fn(async()=>Buffer.from('inert')),url:()=> 'http://localhost'};
  let value:any;if(boundary==='settle'){page.waitForTimeout.mockImplementationOnce(()=>{entered.resolve();return held.promise;});}
  if(boundary==='element'){value=element;page.$.mockImplementationOnce(()=>{entered.resolve();return held.promise;});}
  if(boundary==='bytes'){value=Buffer.from('inert');page.screenshot.mockImplementationOnce(()=>{entered.resolve();return held.promise;});}
  try{
   const pending=new ScreenshotService().capture(page,{control:c,mode:boundary==='element'?'element':'viewport',elementSelector:'#x',iteration:1,label:'test',outputDir:dir});
   const rejected=expect(pending).rejects.toBeInstanceOf(VisualOperationCancelled);await entered.promise;c.abort.abort();await rejected;held.resolve(value);await new Promise(r=>setImmediate(r));expect(fs.existsSync(dir)).toBe(false);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
 });
 it('commits one actual file for a current owner',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mysti-owned-shot-'));try{
   const page={waitForTimeout:async()=>{},screenshot:async()=>Buffer.from('inert bytes'),url:()=> 'http://localhost'};
   const result=await new ScreenshotService().capture(page,{control:control(),mode:'viewport',iteration:1,label:'test',outputDir:dir});expect(fs.readFileSync(result.filePath,'utf8')).toBe('inert bytes');expect(fs.readdirSync(dir)).toHaveLength(1);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
 });
});
it('an abort-raced promise observes late rejection without starting pre-aborted work',async()=>{
 const c=control();c.abort.abort();const work=vi.fn(async()=>true);expect(()=>awaitVisualOperation(c,work)).toThrow(VisualOperationCancelled);expect(work).not.toHaveBeenCalled();
 const live=control();let reject!:(error:Error)=>void;const entered=deferred();const pending=awaitVisualOperation(live,()=>{entered.resolve();return new Promise((_resolve,no)=>{reject=no;});});
 const rejected=expect(pending).rejects.toBeInstanceOf(VisualOperationCancelled);await entered.promise;live.abort.abort();await rejected;reject(new Error('late'));await new Promise(r=>setImmediate(r));
});
