import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings, StreamChunk } from '../../../src/types';
import { TestableHermesProvider } from '../../helpers/providerFactory';
import { clearMockConfig } from '../../helpers/mockVscode';

const settings: Settings = { provider: 'hermes', model: '', mode: 'quick-plan', accessLevel: 'read-only',
  thinkingLevel: 'none', contextMode: 'manual' };
type Terminal = { code: number | null; signal: string | null };
type OwnedChild = { child: ChildProcess; exit?: Terminal; close?: Terminal };
let provider: TestableHermesProvider;
let directory: string;
let eventsFile: string;
let responses: StreamChunk[][];
const children: OwnedChild[] = [];

beforeEach(() => {
  clearMockConfig();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-hermes-incomplete-'));
  eventsFile = path.join(directory, 'events.jsonl'); responses = [];
  provider = new TestableHermesProvider();
  for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(async () => {
  provider.dispose();
  const cleanupSignals: number[] = [];
  for (const row of children) if (!row.close && row.child.exitCode === null && row.child.signalCode === null) {
    cleanupSignals.push(row.child.pid!); row.child.kill('SIGKILL');
  }
  try {
    await vi.waitFor(() => expect(children.every(row => row.close !== undefined)).toBe(true), { timeout: 3000 });
  } finally {
    const allClosed = children.every(row => row.close !== undefined);
    const receipt = process.env.PB10_HERMES_INCOMPLETE_RECEIPT;
    if (receipt) fs.appendFileSync(receipt, JSON.stringify({ test: expect.getState().currentTestName,
      children: children.map(({ child, ...row }) => ({ pid: child.pid, ...row })), allClosed, cleanupSignals,
      events: readEvents(), responses }) + '\n');
    if (allClosed) fs.rmSync(directory, { recursive: true, force: true });
    children.length = 0; vi.restoreAllMocks(); clearMockConfig();
  }
});

function readEvents(): Array<Record<string, any>> {
  return fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}

function fixture(first: 'partial' | 'empty' | 'complete') {
  const script = path.join(directory, 'acp-fixture.cjs');
  fs.writeFileSync(script, `const fs=require('node:fs'),rl=require('node:readline');
const [events,behavior,...args]=process.argv.slice(2);
const record=e=>fs.appendFileSync(events,JSON.stringify({pid:process.pid,...e})+'\\n');
const send=e=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...e})+'\\n');
const end=()=>process.stdout.end(()=>process.exit(0));
record({event:'invocation',behavior,args});
if(args.includes('--check')){process.stdout.write('Owned ACP diagnostic fallback\\n');end();}
else rl.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);record({event:'request',method:m.method,id:m.id,prompt:m.params?.prompt});
 if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1}});
 else if(m.method==='session/new')send({id:m.id,result:{sessionId:'owned-'+process.pid}});
 else if(m.method==='session/prompt'){
  if(behavior!=='empty')send({method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:behavior==='partial'?'Preserved partial.':'Fresh completed response.'}}}});
  if(behavior==='complete')send({id:m.id,result:{stopReason:'end_turn'}});
  record({event:'clean-exit',promptTerminalSent:behavior==='complete'});end();
 }
});`);
  vi.spyOn(provider, 'getCliPath').mockReturnValue(process.execPath);
  vi.spyOn(provider as any, '_getWorkingDirectory').mockReturnValue(directory);
  vi.spyOn(provider as any, 'buildPromptAsync').mockImplementation(async (content: string) => content);
  let starts = 0;
  const originalPersistent = provider.buildPersistentCliArgs.bind(provider);
  const persistent = vi.spyOn(provider, 'buildPersistentCliArgs').mockImplementation((options, session) =>
    [script, eventsFile, starts++ === 0 ? first : 'complete', ...originalPersistent(options, session)!]);
  const originalFallback = provider.buildCliArgs.bind(provider);
  const fallback = vi.spyOn(provider, 'buildCliArgs').mockImplementation((options, session) =>
    [script, eventsFile, 'complete', ...originalFallback(options, session)]);
  const tracker = { registerProcess(_panel: string, child: ChildProcess) {
    if (children.some(row => row.child === child)) return;
    const row: OwnedChild = { child }; children.push(row);
    child.once('exit', (code, signal) => { row.exit = { code, signal }; });
    child.once('close', (code, signal) => { row.close = { code, signal }; });
  }, clearProcess() {} };
  const send = async (content: string) => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.sendMessage(content, [], settings, null, undefined, 'owned-panel', tracker)) chunks.push(chunk);
    responses.push(chunks);
    await vi.waitFor(() => expect(children.every(row => row.close !== undefined)).toBe(true), { timeout: 3000 });
    return chunks;
  };
  return { persistent, fallback, send };
}

describe('Hermes incomplete ACP response', () => {
  it.each(['partial', 'empty'] as const)('reports clean EOF with %s output as incomplete and recovers through one fresh child', async first => {
    const h = fixture(first);
    const interrupted = await h.send('request-A');
    const recovered = await h.send('request-B');
    const events = readEvents(), invocations = events.filter(event => event.event === 'invocation');
    expect(invocations.map(event => event.args)).toEqual([['acp'], ['acp']]);
    expect(new Set(invocations.map(event => event.pid)).size).toBe(2);
    expect(events.filter(event => event.method === 'session/prompt').map(event => event.prompt)).toEqual([
      [{ type: 'text', text: 'request-A' }], [{ type: 'text', text: 'request-B' }],
    ]);
    expect(events.filter(event => event.event === 'clean-exit').map(event => event.promptTerminalSent)).toEqual([false, true]);
    expect(children).toHaveLength(2);
    for (const child of children) expect(child).toMatchObject({ exit: { code: 0, signal: null }, close: { code: 0, signal: null } });
    expect(h.persistent).toHaveBeenCalledTimes(2); expect(h.fallback).not.toHaveBeenCalled();
    expect(recovered.filter(chunk => chunk.type === 'text').map(chunk => chunk.content)).toEqual(['Fresh completed response.']);
    expect(recovered.some(chunk => chunk.type === 'error' || chunk.type === 'auth_error')).toBe(false);
    expect(recovered.filter(chunk => chunk.type === 'done')).toHaveLength(1);
    expect(interrupted.filter(chunk => chunk.type === 'text').map(chunk => chunk.content)).toEqual(first === 'partial' ? ['Preserved partial.'] : []);
    const errors = interrupted.filter(chunk => chunk.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].content).toMatch(/Hermes.*exited with code 0.*incomplete.*fresh process/i);
    expect(interrupted.findIndex(chunk => chunk.type === 'error')).toBeLessThan(interrupted.findIndex(chunk => chunk.type === 'done'));
  });

  it('preserves an initial setup error without launching acp --check and allows one explicit recovery request', async () => {
    const h = fixture('complete');
    h.persistent.mockImplementationOnce(() => { throw new Error('Owned ACP setup failure'); });
    const failed = await h.send('request-A');
    const recovered = await h.send('request-B');
    const events = readEvents();
    expect(recovered.filter(chunk => chunk.type === 'text').map(chunk => chunk.content)).toEqual(['Fresh completed response.']);
    expect(recovered.some(chunk => chunk.type === 'error' || chunk.type === 'auth_error')).toBe(false);
    expect(events.filter(event => event.method === 'session/prompt').map(event => event.prompt)).toEqual([[{ type: 'text', text: 'request-B' }]]);
    expect(events.filter(event => event.event === 'invocation').map(event => event.args)).toEqual([['acp']]);
    expect(children).toHaveLength(1); expect(children[0]).toMatchObject({ exit: { code: 0, signal: null }, close: { code: 0, signal: null } });
    expect(h.fallback).not.toHaveBeenCalled();
    expect(failed.filter(chunk => chunk.type === 'error').map(chunk => chunk.content)).toEqual(['Owned ACP setup failure']);
    expect(failed.some(chunk => chunk.type === 'text' || chunk.type === 'auth_error')).toBe(false);
  });
});
