// Public sends use disposable Node ACP children, never installed Kimi or a service.
import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Settings, StreamChunk } from '../../../src/types';
import { TestableKimiProvider } from '../../helpers/providerFactory';
import { clearMockConfig, getMockConfigUpdates } from '../../helpers/mockVscode';

vi.mock('../../../src/utils/platform', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/utils/platform')>(),
  // Keep only fixture PATH and provider-generated overrides, never account env.
  getEnrichedEnv: (extra?: Record<string, string>) => ({ PATH: process.env.PATH || '', ...extra }),
}));

const settings = (model = ''): Settings => ({ provider: 'kimi-code', model,
  mode: 'edit-automatically', accessLevel: 'full-access', thinkingLevel: 'none', contextMode: 'manual' });
type Scenario = 'default' | 'ordered' | 'error' | 'malformed' | 'mismatch' | 'transitions' | 'stop';
type Terminal = { code: number | null; signal: string | null };
type Owned = { child: ChildProcess; exit?: Terminal; close?: Terminal; closed: Promise<void> };
type Turn = { chunks: StreamChunk[]; done: Promise<void>; settled: boolean; error?: unknown };
type Event = { event: string; pid: number; at: number; [key: string]: any };

// configOptions, set_config_option and pre-reply config notifications follow the
// pinned 2.1.1 source. owned/selection_barrier is an explicitly synthetic server
// request: its unsupported-method reply proves the reader processed the preceding
// notification before the child releases the real set ACK. It executes no tool.
const childSource = String.raw`
const fs=require('node:fs'), readline=require('node:readline');
const [receipt,scenario,indexText,...args]=process.argv.slice(2), index=Number(indexText);
const sid='owned-kimi-model-'+index, barrier='owned-selection-barrier';
const record=e=>fs.appendFileSync(receipt,JSON.stringify({at:Date.now(),pid:process.pid,...e})+'\n');
const emit=packet=>{record({event:'output',packet});process.stdout.write(JSON.stringify(packet)+'\n');};
const reply=(id,result)=>emit({jsonrpc:'2.0',id,result});
const config=model=>[{id:'model',name:'Model',category:'model',type:'select',currentValue:model,
 options:[{value:'native-default',name:'Native default'},{value:'selected-a',name:'A'},{value:'selected-b',name:'B'}]}];
const update=(model,sessionId=sid)=>emit({jsonrpc:'2.0',method:'session/update',params:{sessionId,
 update:{sessionUpdate:'config_option_update',configOptions:config(model)}}});
const content=(kind,text)=>emit({jsonrpc:'2.0',method:'session/update',params:{sessionId:sid,
 update:{sessionUpdate:kind,content:{type:'text',text}}}});
const input=readline.createInterface({input:process.stdin});
let current='native-default', pending, setAcked=false, ending=false, turns=0;
const timers=new Set();
const later=(fn,ms)=>{const t=setTimeout(()=>{timers.delete(t);fn();},ms);timers.add(t);};
const end=()=>{if(ending)return;ending=true;clearTimeout(deadline);for(const t of timers)clearTimeout(t);
 input.close();process.stdout.end(()=>process.exit(0));};
const deadline=setTimeout(()=>{record({event:'fixture-deadline'});process.exit(93);},10000);
record({event:'invocation',scenario,index,args,anthropicModel:process.env.ANTHROPIC_MODEL??null});
input.on('line',line=>{
 const m=JSON.parse(line);record({event:'input',packet:m,setAcked});
 if(m.id===barrier&&m.method===undefined){
  record({event:'barrier-consumed',response:m});
  if(pending){current=pending.params.value;setAcked=true;record({event:'set-ack'});
   reply(pending.id,{configOptions:config(current)});pending=undefined;}return;
 }
 if(m.method==='initialize'){reply(m.id,{protocolVersion:1});return;}
 if(m.method==='session/new'){reply(m.id,{sessionId:sid,configOptions:config(current),
  modes:{currentModeId:'default',availableModes:[]}});return;}
 if(m.method==='session/set_config_option'){
  if(m.params.sessionId!==sid||m.params.configId!=='model'||typeof m.params.value!=='string'){
   record({event:'invalid-set-request'});reply(m.id,{});return;
  }
  pending=m;
  if(index===1&&['error','malformed','mismatch'].includes(scenario)){
   record({event:'selection-failure-sent',scenario});
   if(scenario==='error')emit({jsonrpc:'2.0',id:m.id,error:{code:-32602,message:'Owned requested model is unavailable'}});
   else reply(m.id,{configOptions:scenario==='malformed'?[]:config('different-model')});
   return; // Deliberately live until product eviction; test cleanup is separate.
  }
  if(index===1&&scenario==='stop'){record({event:'selection-held'});return;}
  if(scenario==='ordered'){
   update(m.params.value);update('foreign-model','foreign-session');
   reply(m.id-1,{configOptions:config(m.params.value)});
   reply(999,{configOptions:config(m.params.value)});
   reply(String(m.id),{configOptions:config(m.params.value)});
   record({event:'pre-ack-notifications'});
   emit({jsonrpc:'2.0',id:barrier,method:'owned/selection_barrier',params:{}});return;
  }
  current=m.params.value;update(current);setAcked=true;record({event:'set-ack'});
  reply(m.id,{configOptions:config(current)});pending=undefined;return;
 }
 if(m.method==='session/prompt'){
  const prompt=m.params.prompt.map(p=>p.text??'').join('');turns++;
  record({event:'prompt-received',prompt,current,setAcked,sessionId:m.params.sessionId});
  if(scenario==='default'&&turns===2){current='native-changed';update(current);}
  update('foreign-model','foreign-session');
  content('agent_thought_chunk','Reasoning '+prompt+'.');
  content('agent_message_chunk','Answer '+prompt+'.');
  reply(m.id,{stopReason:'end_turn'});
  // On the unfixed baseline, failure scenarios wrongly send the prompt without
  // selecting a model. Finish naturally so the red assertion is not a timeout.
  if(index===1&&['error','malformed','mismatch'].includes(scenario))end();
 }
});
if(scenario==='stop'&&index===1)process.on('SIGTERM',()=>{
 record({event:'product-sigterm-observed'});
 later(()=>{if(pending){update('late-old-model');reply(pending.id,{configOptions:config(pending.params.value)});
  record({event:'late-old-ack'});}later(end,50);},20);
});
input.on('close',()=>{record({event:'stdin-closed'});if(!ending)end();});
process.on('exit',code=>record({event:'child-exit',code}));
`;

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<{ value: T } | { deadline: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise.then(value => ({ value })),
    new Promise<{ deadline: true }>(resolve => { timer=setTimeout(()=>resolve({ deadline:true }),milliseconds); })]);
  } finally { clearTimeout(timer); }
}

async function fixture(scenario: Scenario, run: (f: {
  send: (content: string, model?: string) => Turn; finish: (turn: Turn) => Promise<void>;
  events: () => Event[]; children: Owned[]; provider: TestableKimiProvider;
  reap: (row: Owned) => Promise<void>; notes: Record<string, unknown>;
}) => Promise<void>): Promise<void> {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mysti-kimi-model-'));
  const script=path.join(directory,'acp.cjs'),receipt=path.join(directory,'events.jsonl');
  fs.writeFileSync(script,childSource);clearMockConfig();
  const provider=new TestableKimiProvider(),children:Owned[]=[],streams:AsyncGenerator<StreamChunk>[]=[];
  const turns:Turn[]=[],returns:Promise<unknown>[]=[],cleanupSignals:Array<{pid:number|undefined;signal:string}>=[];
  const notes:Record<string,unknown>={};
  const events=():Event[]=>fs.existsSync(receipt)?fs.readFileSync(receipt,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
  for(const method of ['log','warn','error'] as const)vi.spyOn(console,method).mockImplementation(()=>{});
  vi.spyOn(provider,'getCliPath').mockReturnValue(process.execPath);
  vi.spyOn(provider as any,'_getWorkingDirectory').mockReturnValue(directory);
  vi.spyOn(provider as any,'buildPromptAsync').mockImplementation(async(content:string)=>content);
  let starts=0;const original=provider.buildPersistentCliArgs.bind(provider);
  vi.spyOn(provider,'buildPersistentCliArgs').mockImplementation((s,session)=>
    [script,receipt,scenario,String(++starts),...original(s,session)!]);
  const fallback=vi.spyOn(provider as any,'_sendSingleShot').mockImplementation(async function*(){
    yield {type:'error',content:'UNEXPECTED OWNED FALLBACK'};
  });
  const tracker={registerProcess(_panel:string,child:ChildProcess){
    if(children.some(row=>row.child===child))return;
    const row:Owned={child,closed:Promise.resolve()};
    row.closed=new Promise(resolve=>child.once('close',(code,signal)=>{row.close={code,signal};resolve();}));
    child.once('exit',(code,signal)=>{row.exit={code,signal};});children.push(row);
  },clearProcess(){}};
  const send=(content:string,model=''):Turn=>{
    const chosen=settings(model),before=JSON.stringify(chosen);
    const stream=provider.sendMessage(content,[],chosen,null,undefined,'owned-model-panel',tracker);streams.push(stream);
    const row:Turn={chunks:[],settled:false,done:Promise.resolve()};
    row.done=(async()=>{try{for await(const chunk of stream)row.chunks.push(chunk);
      expect(JSON.stringify(chosen)).toBe(before);
    }catch(error){row.error=error;throw error;}finally{row.settled=true;}})();
    void row.done.catch(()=>{});turns.push(row);return row;
  };
  const finish=async(turn:Turn)=>{expect(await within(turn.done,2500),'Public owned ACP turn must settle').not.toHaveProperty('deadline');};
  const reap=async(row:Owned)=>{if(row.child.exitCode===null&&row.child.signalCode===null){
    cleanupSignals.push({pid:row.child.pid,signal:'SIGTERM'});row.child.kill('SIGTERM');
  }expect(await within(row.closed,2500),'Captured child must actually close').not.toHaveProperty('deadline');};
  let bodyError:unknown,drained=false,closed=false,disposed=false;
  try{
    await run({send,finish,events,children,provider,reap,notes});
    expect(fallback).not.toHaveBeenCalled();expect(getMockConfigUpdates()).toEqual({});
    expect(events().filter(e=>e.event==='invocation').map(e=>e.args)).toEqual(children.map(()=>['acp']));
    expect(events().filter(e=>e.event==='invocation').map(e=>e.anthropicModel)).toEqual(children.map(()=>null));
    expect(events().some(e=>e.event==='fixture-deadline'||e.event==='invalid-set-request')).toBe(false);
  }catch(error){bodyError=error;throw error;}finally{
    // First request ordinary EOF and iterator return. Keep the actual underlying
    // operations, not only deadline wrappers, until all handles/readers settle.
    for(const row of children)if(!row.close)row.child.stdin?.end();
    for(const stream of streams){const returned=stream.return(undefined as never);void returned.catch(()=>{});returns.push(returned);}
    const drain=Promise.allSettled([...turns.map(t=>t.done),...returns]).then(()=>{drained=true;});
    const close=Promise.all(children.map(row=>row.closed)).then(()=>{closed=true;});
    try{
      await within(Promise.all([drain,close]),3000);
      if(!drained||!closed){
        // Retain this as test cleanup, never product eviction evidence. Dispose
        // before the final await so even its cleanup cannot outlive the receipt.
        notes.emergencyProviderDispose={drained,closed};provider.dispose();disposed=true;
        for(const row of children)if(row.child.exitCode===null&&row.child.signalCode===null){
          cleanupSignals.push({pid:row.child.pid,signal:'SIGKILL'});row.child.kill('SIGKILL');
        }
        await within(Promise.all([drain,close]),3000);
      }
    }finally{
      if(!disposed){provider.dispose();disposed=true;}
      const evidence={scenario,directory,bodyError:bodyError instanceof Error?bodyError.message:bodyError,
        notes,drained,closed,cleanupSignals,fallbackCalls:fallback.mock.calls.length,
        configUpdates:{...getMockConfigUpdates()},events:events(),
        turns:turns.map(t=>({settled:t.settled,error:t.error instanceof Error?t.error.message:t.error,chunks:t.chunks})),
        children:children.map(row=>({pid:row.child.pid,exit:row.exit,close:row.close})),
        completeReceipt:!fs.existsSync(receipt)||fs.readFileSync(receipt,'utf8').endsWith('\n')};
      const sink=process.env.PB11_KIMI_MODEL_RECEIPT;if(sink)fs.appendFileSync(sink,JSON.stringify(evidence)+'\n');
      vi.restoreAllMocks();clearMockConfig();
      if(drained&&closed)fs.rmSync(directory,{recursive:true,force:true});
    }
    expect(drained).toBe(true);expect(closed).toBe(true);expect(cleanupSignals).toEqual([]);
    expect(notes.emergencyProviderDispose).toBeUndefined();
    for(const row of children){expect(row.exit).toBeDefined();expect(row.close).toEqual(row.exit);}
    // The last child is always the healthy current session. Earlier children
    // may be product-evicted after a model failure, selection change, or Stop.
    expect(children.at(-1)?.close).toEqual({code:0,signal:null});
  }
}

function requests(events:Event[],pid?:number){return events.filter(e=>e.event==='input'&&typeof e.packet?.method==='string'&&(pid===undefined||e.pid===pid)).map(e=>e.packet);}
function reports(chunks:StreamChunk[]){return chunks.flatMap(c=>c.reportedModel?[c.reportedModel]:[]);}
function expectAnswer(turn:Turn,prompt:string,model:string){
  expect(turn.chunks.filter(c=>c.type==='text').map(c=>c.content)).toEqual(['Answer '+prompt+'.']);
  expect(turn.chunks.filter(c=>c.type==='thinking').map(c=>c.content)).toEqual(['Reasoning '+prompt+'.']);
  expect(turn.chunks.some(c=>c.type==='error'||c.type==='auth_error')).toBe(false);
  expect(turn.chunks.filter(c=>c.type==='done')).toHaveLength(1);
  let observed:string|undefined;
  for(const c of turn.chunks){if(c.reportedModel)observed=c.reportedModel;
    if(c.type==='text'||c.type==='thinking')expect(observed,'Native model must reach the response before its content').toBe(model);}
  expect(reports(turn.chunks)).not.toContain('foreign-model');
}

describe('Kimi confirmed native session model',()=>{
  it('uses the account model and reports matching-session changes without a setter or setting write',async()=>{
    await fixture('default',async f=>{
      const a=f.send('default-A');await f.finish(a);const b=f.send('default-B');await f.finish(b);
      expectAnswer(a,'default-A','native-default');expectAnswer(b,'default-B','native-changed');
      expect(f.children).toHaveLength(1);
      expect(requests(f.events()).map(p=>p.method)).toEqual(['initialize','session/new','session/prompt','session/prompt']);
    });
  },20000);

  it('waits for the exact model ACK after notifications and stale replies, then reuses the confirmed session',async()=>{
    await fixture('ordered',async f=>{
      const a=f.send('selected-A','selected-a');await f.finish(a);const b=f.send('selected-B','selected-a');await f.finish(b);
      expectAnswer(a,'selected-A','selected-a');expectAnswer(b,'selected-B','selected-a');
      expect(f.children).toHaveLength(1);const events=f.events(),packets=requests(events);
      expect(packets.map(p=>p.method)).toEqual(['initialize','session/new','session/set_config_option','session/prompt','session/prompt']);
      expect(packets[2].params).toEqual({sessionId:'owned-kimi-model-1',configId:'model',value:'selected-a'});
      expect(packets.map(p=>p.id)).toEqual([1,2,3,4,5]);
      const barrier=events.findIndex(e=>e.event==='barrier-consumed'),ack=events.findIndex(e=>e.event==='set-ack');
      expect(barrier).toBeGreaterThan(events.findIndex(e=>e.event==='pre-ack-notifications'));expect(ack).toBeGreaterThan(barrier);
      expect(events.filter(e=>e.event==='prompt-received').every(e=>e.setAcked)).toBe(true);
      expect(events.findIndex(e=>e.event==='prompt-received')).toBeGreaterThan(ack);
    });
  },20000);

  it.each(['error','malformed','mismatch'] as const)('fails a %s model selection without submitting its prompt, then recovers on a fresh child',async scenario=>{
    await fixture(scenario,async f=>{
      const a=f.send('must-not-submit','selected-a');const outcome=await within(a.done,2500);
      const old=f.children[0];expect(old).toBeDefined();
      const closedBeforeCleanup=!('deadline' in await within(old.closed,1000));
      const before={outcome:'deadline' in outcome?'deadline':'settled',closedBeforeCleanup,
        chunks:[...a.chunks],exit:old.exit,close:old.close,
        refCleared:(f.provider as any)._getSession('owned-model-panel').persistentProcess!==old.child};
      f.notes.beforeRecovery=before;
      if(!closedBeforeCleanup)await f.reap(old);await f.finish(a);
      const b=f.send('recovered','selected-a');await f.finish(b);expectAnswer(b,'recovered','selected-a');
      expect(f.children).toHaveLength(2);expect(f.children[1].child.pid).not.toBe(old.child.pid);
      expect(requests(f.events(),old.child.pid).map(p=>p.method)).toEqual(['initialize','session/new','session/set_config_option']);
      expect(f.events().filter(e=>e.event==='prompt-received').map(e=>e.prompt)).toEqual(['recovered']);
      expect(before.outcome).toBe('settled');expect(before.closedBeforeCleanup).toBe(true);expect(before.refCleared).toBe(true);
      expect(before.exit).toBeDefined();expect(before.close).toEqual(before.exit);
      const errors=before.chunks.filter(c=>c.type==='error');expect(errors).toHaveLength(1);
      expect(errors[0].content).toMatch(/model/i);
      expect(before.chunks.some(c=>c.type==='auth_error'||c.type==='text'||c.type==='thinking')).toBe(false);
      expect(before.chunks.filter(c=>c.type==='done')).toHaveLength(1);
    });
  },20000);

  it('respawns for changed selection and return to default, while unchanged selection keeps its model',async()=>{
    await fixture('transitions',async f=>{
      const a=f.send('A','selected-a');await f.finish(a);const resumed=f.send('A-resumed','selected-a');await f.finish(resumed);
      const b=f.send('B','selected-b');await f.finish(b);const c=f.send('default');await f.finish(c);
      expectAnswer(a,'A','selected-a');expectAnswer(resumed,'A-resumed','selected-a');
      expectAnswer(b,'B','selected-b');expectAnswer(c,'default','native-default');expect(f.children).toHaveLength(3);
      const perChild=f.children.map(row=>requests(f.events(),row.child.pid));
      expect(perChild.map(p=>p.filter(m=>m.method==='session/set_config_option').map(m=>m.params.value))).toEqual([['selected-a'],['selected-b'],[]]);
      expect(perChild.map(p=>p.filter(m=>m.method==='session/prompt').length)).toEqual([2,1,1]);
      expect(await within(Promise.all(f.children.slice(0,2).map(row=>row.closed)),2500)).not.toHaveProperty('deadline');
    });
  },20000);

  it('does not let a stopped child release a late model ACK into its replacement',async()=>{
    await fixture('stop',async f=>{
      const a=f.send('cancelled-A','selected-a');
      await vi.waitFor(()=>expect(f.events().some(e=>e.event==='selection-held')||a.settled).toBe(true),{timeout:2500});
      const held=f.events().some(e=>e.event==='selection-held');f.notes.selectionHeldBeforeStop=held;
      f.provider.cancelCurrentRequest('owned-model-panel');
      const b=f.send('replacement-B','selected-b');await f.finish(a);await f.finish(b);
      expect(f.children).toHaveLength(2);
      expect(await within(f.children[0].closed,2500)).not.toHaveProperty('deadline');
      const c=f.send('replacement-resumed','selected-b');await f.finish(c);
      expectAnswer(b,'replacement-B','selected-b');expectAnswer(c,'replacement-resumed','selected-b');
      const events=f.events();expect(held).toBe(true);
      expect(events.some(e=>e.event==='product-sigterm-observed')).toBe(true);
      expect(events.some(e=>e.event==='late-old-ack')).toBe(true);
      expect(events.filter(e=>e.event==='prompt-received').map(e=>e.prompt)).toEqual(['replacement-B','replacement-resumed']);
      expect(reports(b.chunks).concat(reports(c.chunks))).not.toContain('late-old-model');
      expect(a.chunks.some(chunk=>chunk.type==='text'||chunk.type==='thinking')).toBe(false);
      expect(a.chunks.filter(chunk=>chunk.type==='done')).toHaveLength(1);
    });
  },20000);
});
