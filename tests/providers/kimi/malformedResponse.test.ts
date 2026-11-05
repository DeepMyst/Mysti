// Only disposable Node ACP children, never the installed Kimi runtime or service.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings, StreamChunk } from '../../../src/types';
import { TestableKimiProvider } from '../../helpers/providerFactory';
import { clearMockConfig } from '../../helpers/mockVscode';

const settings: Settings = { provider: 'kimi-code', model: '', mode: 'edit-automatically', accessLevel: 'full-access',
  thinkingLevel: 'none', contextMode: 'manual' };
type Terminal = { code: number | null; signal: string | null };
type Owned = { child: ChildProcess; exit?: Terminal; close?: Terminal; closed: Promise<void> };
const children: Owned[] = [];
const drains: Array<{ settled: boolean; promise: Promise<void> }> = [];
let provider: TestableKimiProvider;
let directory: string;
let eventsFile: string;
let observation: Record<string, unknown>;
let cleanupSignals: Array<{ pid: number | undefined; signal: string }>;

function readEvents(): Array<Record<string, any>> {
  return fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
async function within(promise: Promise<void>, milliseconds: number): Promise<'settled' | 'deadline'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise.then(() => 'settled' as const),
      new Promise<'deadline'>(resolve => { timer = setTimeout(() => resolve('deadline'), milliseconds); })]);
  } finally { clearTimeout(timer); }
}
function reap(row: Owned) {
  if (row.child.exitCode === null && row.child.signalCode === null) {
    cleanupSignals.push({ pid: row.child.pid, signal: 'SIGTERM' }); row.child.kill('SIGTERM');
  }
}

beforeEach(() => {
  clearMockConfig(); directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-kimi-malformed-'));
  eventsFile = path.join(directory, 'events.jsonl'); observation = {}; cleanupSignals = [];
  provider = new TestableKimiProvider();
  for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(async () => {
  for (const row of children) reap(row);
  provider.dispose();
  try {
    await vi.waitFor(() => expect(children.every(row => row.close !== undefined) && drains.every(row => row.settled)).toBe(true), { timeout: 3000 });
  } finally {
    const allClosed = children.every(row => row.close !== undefined), allDrainsSettled = drains.every(row => row.settled);
    const receipt = process.env.PB11_KIMI_MALFORMED_RECEIPT;
    if (receipt) fs.appendFileSync(receipt, JSON.stringify({ test: expect.getState().currentTestName, ...observation,
      children: children.map(({ child, closed: _closed, ...row }) => ({ pid: child.pid, ...row })),
      events: readEvents(), cleanupSignals, allClosed, allDrainsSettled }) + '\n');
    if (allClosed && allDrainsSettled) fs.rmSync(directory, { recursive: true, force: true });
    children.length = 0; drains.length = 0; vi.restoreAllMocks(); clearMockConfig();
  }
});

function fixture(first: 'prompt' | 'session') {
  const script = path.join(directory, 'acp-fixture.cjs');
  fs.writeFileSync(script, `const fs=require('node:fs'),rl=require('node:readline');
const [events,behavior,...args]=process.argv.slice(2);
const record=e=>fs.appendFileSync(events,JSON.stringify({pid:process.pid,...e})+'\\n');
const send=e=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...e})+'\\n');
record({event:'invocation',behavior,args});
if(args.includes('--check')){process.stdout.end('Unexpected owned diagnostic fallback\\n',()=>process.exit(91));}
else rl.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);record({event:'request',method:m.method,id:m.id,prompt:m.params?.prompt});
 if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1}});
 else if(m.method==='session/new'){
  if(behavior==='session'){record({event:'malformed-sent',method:m.method,id:m.id});send({id:m.id,result:{}});}
  else send({id:m.id,result:{sessionId:'owned-'+process.pid}});
 }else if(m.method==='session/prompt'){
  if(behavior==='prompt')send({method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'Preserved reasoning.'}}}});
  send({method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:behavior==='prompt'?'Preserved partial.':'Fresh recovery.'}}}});
  if(behavior==='prompt'){record({event:'malformed-sent',method:m.method,id:m.id});send({id:m.id,result:{}});}
  else {send({id:m.id,result:{stopReason:'end_turn'}});process.stdout.end(()=>process.exit(0));}
 }
});`);
  vi.spyOn(provider, 'getCliPath').mockReturnValue(process.execPath);
  vi.spyOn(provider as any, '_getWorkingDirectory').mockReturnValue(directory);
  vi.spyOn(provider as any, 'buildPromptAsync').mockImplementation(async (content: string) => content);
  let starts = 0;
  const original = provider.buildPersistentCliArgs.bind(provider);
  vi.spyOn(provider, 'buildPersistentCliArgs').mockImplementation((options, session) =>
    [script, eventsFile, starts++ === 0 ? first : 'complete', ...original(options, session)!]);
  const buildFallback = provider.buildCliArgs.bind(provider);
  const fallback = vi.spyOn(provider, 'buildCliArgs').mockImplementation((options, session) =>
    [script, eventsFile, 'complete', ...buildFallback(options, session)]);
  const tracker = { registerProcess(_panel: string, child: ChildProcess) {
    if (children.some(row => row.child === child)) return;
    let resolveClose!: () => void;
    const row: Owned = { child, closed: new Promise(resolve => { resolveClose = resolve; }) }; children.push(row);
    child.once('exit', (code, signal) => { row.exit = { code, signal }; });
    child.once('close', (code, signal) => { row.close = { code, signal }; resolveClose(); });
  }, clearProcess() {} };
  const send = (content: string) => {
    const chunks: StreamChunk[] = [];
    const row = { settled: false, promise: Promise.resolve() };
    row.promise = (async () => {
      try { for await (const chunk of provider.sendMessage(content, [], settings, null, undefined, 'owned-panel', tracker)) chunks.push(chunk); }
      finally { row.settled = true; }
    })();
    drains.push(row);
    return { chunks, done: row.promise };
  };
  return { send, fallback };
}

describe('Kimi Code malformed correlated response', () => {
  it.each(['prompt', 'session'] as const)('settles a malformed %s response, evicts its live child, and recovers without replay', async first => {
    const h = fixture(first), a = h.send('request-A');
    await vi.waitFor(() => expect(readEvents().some(event => event.event === 'malformed-sent')).toBe(true), { timeout: 1000 });
    const firstChild = children[0];
    // This deadline observes public generator settlement; it never changes the
    // production inactivity or kill grace. The fixture intentionally stays alive.
    const outcome = await within(a.done, 1000);
    const closedBeforeTestCleanup = outcome === 'settled' && await within(firstChild.closed, 1000) === 'settled';
    const beforeCleanup = { outcome, closedBeforeTestCleanup, chunks: [...a.chunks],
      exit: firstChild.exit, close: firstChild.close,
      persistentReferenceCleared: (provider as any)._getSession('owned-panel').persistentProcess !== firstChild.child };
    observation = { beforeCleanup };
    // Reap only the captured malformed child after recording the failed oracle;
    // test cleanup must not be mistaken for product cancellation or eviction.
    if (!closedBeforeTestCleanup) reap(firstChild);
    await firstChild.closed; await a.done;
    const b = h.send('request-B'); await b.done;
    await Promise.all(children.map(row => row.closed));
    observation = { ...observation, failedChunksAfterCleanup: a.chunks, recoveryChunks: b.chunks };
    const events = readEvents();
    expect(events.filter(event => event.event === 'invocation').map(event => event.args)).toEqual([['acp'], ['acp']]);
    expect(children).toHaveLength(2); expect(children[1].child.pid).not.toBe(firstChild.child.pid);
    expect(events.filter(event => event.method === 'session/prompt' && event.event === 'request').map(event => event.prompt))
      .toEqual(first === 'prompt' ? [[{ type: 'text', text: 'request-A' }], [{ type: 'text', text: 'request-B' }]] : [[{ type: 'text', text: 'request-B' }]]);
    expect(h.fallback).not.toHaveBeenCalled();
    expect(b.chunks.filter(chunk => chunk.type === 'text').map(chunk => chunk.content)).toEqual(['Fresh recovery.']);
    expect(b.chunks.some(chunk => chunk.type === 'error' || chunk.type === 'auth_error')).toBe(false);
    expect(b.chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1);
    expect(children[1]).toMatchObject({ exit: { code: 0, signal: null }, close: { code: 0, signal: null } });
    expect(beforeCleanup.outcome, 'Malformed correlated responses must settle before the test deadline').toBe('settled');
    expect(beforeCleanup.closedBeforeTestCleanup, 'Product must evict the captured malformed child').toBe(true);
    expect(beforeCleanup.persistentReferenceCleared).toBe(true);
    expect(beforeCleanup.exit).toBeDefined();
    expect(beforeCleanup.close).toEqual(beforeCleanup.exit);
    expect(firstChild.exit).toEqual(beforeCleanup.exit);
    expect(firstChild.close).toEqual(beforeCleanup.close);
    expect(cleanupSignals).toEqual([]);
    expect(beforeCleanup.chunks.filter(chunk => chunk.type === 'text').map(chunk => chunk.content)).toEqual(first === 'prompt' ? ['Preserved partial.'] : []);
    expect(beforeCleanup.chunks.filter(chunk => chunk.type === 'thinking').map(chunk => chunk.content)).toEqual(first === 'prompt' ? ['Preserved reasoning.'] : []);
    const errors = beforeCleanup.chunks.filter(chunk => chunk.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].content).toMatch(first === 'prompt' ? /Kimi Code.*(missing|invalid|no|without|malformed).*stop.?reason/i : /Kimi Code.*(missing|invalid|no|without|malformed).*session.?id/i);
    expect(beforeCleanup.chunks.some(chunk => chunk.type === 'auth_error' || chunk.type === 'session_active')).toBe(false);
    expect(beforeCleanup.chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1);
    expect(beforeCleanup.chunks.findIndex(chunk => chunk.type === 'error')).toBeLessThan(beforeCleanup.chunks.findIndex(chunk => chunk.type === 'done'));
  });
});
