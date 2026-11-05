// Source-derived Cursor protocol fixtures; no installed CLI, account or network.
import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { TestableCursorProvider } from '../../helpers/providerFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings, StreamChunk } from '../../../src/types';

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

// Deliberately models the pinned installed emitter, not Mysti's parser:
// A emits each text delta; D retains W summary records at four boundaries.
// The fixture gets the actual product flags, so old source selects partial
// plus summary while the proposed contract selects summary-only.
function fixtureSource(directory: string): string {
  return `
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(1),mode=args[args.lastIndexOf('-p')+1];
const A=args.includes('--stream-partial-output'),D=args[args.indexOf('--output-format')+1]==='stream-json',L=A||D;
if(!D||!args.includes('--print'))throw new Error('Expected actual stream-json print argv');
const session_id='owned-'+mode,records=[];let q='',Y='';
const emit=e=>{records.push(e);process.stdout.write(JSON.stringify(e)+'\\n')};
const delta=text=>{q+=text;Y+=text;if(A)emit({type:'assistant',message:{role:'assistant',content:[{type:'text',text}]},session_id,timestamp_ms:Date.now()})};
const W=({includeTimestamp,modelCallId}={})=>{if(!L||!q.length)return;const e={type:'assistant',message:{role:'assistant',content:[{type:'text',text:q}]},session_id};if(modelCallId)e.model_call_id=modelCallId;if(includeTimestamp)e.timestamp_ms=Date.now();emit(e);q=''};
const ownPath=path.join(${JSON.stringify(directory)},'source.txt');
const tool=()=>{W({includeTimestamp:true,modelCallId:'owned-model-call'});emit({type:'tool_call',subtype:'started',call_id:'owned-read',tool_call:{readToolCall:{args:{path:ownPath}}},session_id});emit({type:'tool_call',subtype:'completed',call_id:'owned-read',tool_call:{readToolCall:{result:{success:fs.readFileSync(ownPath,'utf8')}}},session_id})};
const retry=()=>{W({includeTimestamp:true});emit({type:'retry',subtype:'starting',attempt:1,is_resume:false,session_id});W({includeTimestamp:true});emit({type:'retry',subtype:'resuming',attempt:1,checkpoint_turn_count:0,session_id})};
const query=()=>{W({includeTimestamp:true});emit({type:'interaction_query',subtype:'request',query_type:'askQuestion',query:{},session_id});emit({type:'interaction_query',subtype:'response',query_type:'askQuestion',response:{},session_id})};
emit({type:'system',subtype:'init',session_id,model:'auto'});
if(mode==='repeated'){delta('ha');delta('ha')}
else if(mode==='equal-blocks'){delta('ha');tool();delta('ha')}
else if(mode==='boundaries'){delta('Before ');delta('read.');tool();delta('Retry ');delta('block.');retry();delta('Query ');delta('block.');query();delta('Final ');delta('block.')}
else if(mode==='failed-prefix'){delta('Visible ');delta('prefix.');tool();delta('Unflushed tail')}
else if(mode==='failed-before-flush'){delta('Unflushed tail')}
else if(mode==='fresh'){delta('Hello');delta(' world')}
else throw new Error('Unknown owned fixture mode');
if(mode.startsWith('failed-')){process.stderr.write('Owned fixture interruption\\n');process.exitCode=7}
else{if(D)W({includeTimestamp:false});emit({type:'result',subtype:'success',is_error:false,result:Y,session_id,request_id:'owned-request',duration_ms:1,duration_api_ms:1})}
fs.writeFileSync(path.join(${JSON.stringify(directory)},mode+'.json'),JSON.stringify({pid:process.pid,args,records}));
`;
}

const settings: Settings = { provider: 'cursor', model: 'auto', mode: 'quick-plan',
  accessLevel: 'read-only', contextMode: 'manual', thinkingLevel: 'none' };
type Receipt = { child: ChildProcess; mode: string; exit?: unknown; close?: unknown; closed: Promise<void>; signals: string[] };
async function withFixture(run: (send: (mode: string) => Promise<StreamChunk[]>, directory: string) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-cursor-block-'));
  fs.writeFileSync(path.join(directory, 'source.txt'), 'OWNED_READ_NONCE');
  const folders = vscode.workspace.workspaceFolders;
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(directory), name: 'owned', index: 0 }];
  clearMockConfig();
  const provider = new TestableCursorProvider(), children: Receipt[] = [];
  const observations: unknown[] = [];
  let currentMode = '';
  const realArgs = provider.buildCliArgs.bind(provider);
  vi.spyOn(provider, 'getCliPath').mockReturnValue(process.execPath);
  vi.spyOn(provider, 'buildCliArgs').mockImplementation((settings, session) => ['-e', fixtureSource(directory), '--', ...realArgs(settings, session)]);
  vi.spyOn(provider as any, 'buildPromptAsync').mockImplementation(async (...args: unknown[]) => String(args[0]));
  const tracker = {
    registerProcess: (_panel: string, child: ChildProcess) => {
      const receipt: Receipt = { child, mode: currentMode, signals: [], closed: Promise.resolve() };
      receipt.closed = new Promise<void>(resolve => child.once('close', (code, signal) => {
        receipt.close = { code, signal }; resolve();
      }));
      child.once('exit', (code, signal) => { receipt.exit = { code, signal }; }); children.push(receipt);
    }, clearProcess: () => {},
  };
  const send = async (mode: string) => {
    const chunks: StreamChunk[] = [];
    currentMode = mode;
    await bounded((async () => {
      for await (const chunk of provider.sendMessage(mode, [], settings, null, undefined, 'same-owned-panel', tracker)) chunks.push(chunk);
    })(), 'owned public request');
    const receipt = children.at(-1)!; await bounded(receipt.closed, 'owned close');
    expect(receipt.exit).toEqual({ code: mode.startsWith('failed-') ? 7 : 0, signal: null });
    expect(receipt.close).toEqual(receipt.exit);
    expect(chunks.filter(c => c.type === 'done')).toHaveLength(1);
    observations.push({ mode, text: chunks.filter(c => c.type === 'text').map(c => c.content),
      errors: chunks.filter(c => c.type === 'error' || c.type === 'auth_error'),
      actual: JSON.parse(fs.readFileSync(path.join(directory, mode + '.json'), 'utf8')) });
    return chunks;
  };
  try { await run(send, directory); }
  finally {
    for (const receipt of children) {
      if (receipt.child.exitCode === null && receipt.child.signalCode === null) {
        receipt.signals.push('finally-owned-SIGKILL'); receipt.child.kill('SIGKILL');
      }
      await bounded(receipt.closed, 'finally owned close');
    }
    const evidenceFile = process.env.PB06_CURSOR_BLOCKS_RECEIPT;
    if (evidenceFile) fs.appendFileSync(evidenceFile, JSON.stringify({
      children: children.map(({ child, mode, exit, close, signals }) => ({ pid: child.pid, mode, exit, close, signals })),
      observations, nativeCursorInvocations: 0,
    }) + '\n');
    provider.dispose(); vi.restoreAllMocks(); clearMockConfig();
    (vscode.workspace as any).workspaceFolders = folders;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
const texts = (chunks: StreamChunk[]) => chunks.filter(c => c.type === 'text').map(c => c.content);
describe('Cursor completed stream-json blocks through public sends', () => {
  it('preserves repeated native tokens in a final block', async () => withFixture(async send => {
    const chunks = await send('repeated'); expect(texts(chunks)).toEqual(['haha']);
    expect(chunks.filter(c => c.type === 'error' || c.type === 'auth_error')).toEqual([]);
  }), 15000);
  it('preserves equal blocks separated by a tool boundary', async () => withFixture(async send => {
    const chunks = await send('equal-blocks'); expect(texts(chunks)).toEqual(['ha', 'ha']);
    expect(chunks.filter(c => c.type === 'tool_result').map(c => c.toolCall?.output)).toEqual(['OWNED_READ_NONCE']);
  }), 15000);
  it('joins tool, retry, interaction and final blocks without replaying result text', async () => withFixture(async (send, directory) => {
    const chunks = await send('boundaries');
    expect(texts(chunks)).toEqual(['Before read.', 'Retry block.', 'Query block.', 'Final block.']);
    expect(chunks.filter(c => c.type === 'tool_result').map(c => c.toolCall)).toEqual([
      { id: 'owned-read', name: 'Read', input: { path: path.join(directory, 'source.txt') }, output: 'OWNED_READ_NONCE', status: 'completed' },
    ]);
  }), 15000);
  it('retains the delivered prefix on error, then completes a fresh request on the same panel', async () => withFixture(async send => {
    const failed = await send('failed-prefix'); expect(texts(failed)).toEqual(['Visible prefix.']);
    expect(failed.filter(c => c.type === 'error').map(c => c.content)).toEqual(['Owned fixture interruption']);
    const fresh = await send('fresh'); expect(texts(fresh)).toEqual(['Hello world']);
    expect(fresh.filter(c => c.type === 'error' || c.type === 'auth_error')).toEqual([]);
  }), 15000);
  it('reports interruption before a boundary without inventing unflushed native text', async () => withFixture(async send => {
    const chunks = await send('failed-before-flush'); expect(texts(chunks)).toEqual([]);
    expect(chunks.filter(c => c.type === 'error').map(c => c.content)).toEqual(['Owned fixture interruption']);
  }), 15000);
  it('uses actual Plan flags and completes one final-only text block', async () => withFixture(async (send, directory) => {
    const chunks = await send('fresh'); expect(texts(chunks)).toEqual(['Hello world']);
    const actual = JSON.parse(fs.readFileSync(path.join(directory, 'fresh.json'), 'utf8'));
    expect(actual.args).toEqual(['--output-format', 'stream-json', '--print', '--model', 'auto', '--mode', 'plan', '-p', 'fresh']);
  }), 15000);
});
