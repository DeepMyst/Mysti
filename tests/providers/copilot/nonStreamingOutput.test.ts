import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { TestableCopilotProvider } from '../../helpers/providerFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { Settings, StreamChunk } from '../../../src/types';
import type { PanelSessionState } from '../../../src/providers/base/BaseCliProvider';

type Packet = { type: string; data?: Record<string, unknown>; agentId?: string; stats?: Record<string, number> };
type Scenario = { initial: Packet[]; remaining?: Packet[] };
const settings: Settings = { provider: 'github-copilot', model: 'auto', mode: 'quick-plan',
  accessLevel: 'read-only', thinkingLevel: 'none', contextMode: 'manual' };
const delta = (messageId: string, deltaContent: string): Packet => ({ type: 'assistant.message_delta', data: { messageId, deltaContent } });
const message = (messageId: string, content: string): Packet => ({ type: 'assistant.message', data: { messageId, content } });
const text = (chunks: StreamChunk[]) => chunks.filter(c => c.type === 'text').map(c => c.content).join('');
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) { await cleanup(); }
  vi.restoreAllMocks();
  clearMockConfig();
});

function fixture(scenarios: Record<string, Scenario>) {
  clearMockConfig();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mysti-copilot-nonstream-'));
  const oldFolders = vscode.workspace.workspaceFolders;
  (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(directory), name: 'owned', index: 0 }];
  const children: ChildProcess[] = [], closures: Promise<void>[] = [];
  const provider = new TestableCopilotProvider();
  const readers = new Map<string, PanelSessionState>();
  const parse = provider.parseStreamLine.bind(provider);
  vi.spyOn(provider, 'parseStreamLine').mockImplementation((line, session) => {
    const packet = JSON.parse(line) as Packet;
    if (typeof packet.data?.messageId === 'string') { readers.set(packet.data.messageId, session); }
    return parse(line, session);
  });
  cleanups.push(async () => {
    for (const child of children) { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); } }
    await Promise.all(closures);
    provider.dispose();
    (vscode.workspace as any).workspaceFolders = oldFolders;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  (provider as any)._cachedCliVersion = '1.0.94';
  vi.spyOn(provider, 'getCliPath').mockReturnValue(process.execPath);
  // Exact 1.0.94 assistant packet data fields, emitted by an owned Node child.
  // No Copilot binary, configuration, account or service is accessed.
  const source = `const {randomUUID}=require('node:crypto');const scenarios=${JSON.stringify(scenarios)};
const scenario=scenarios[process.argv.at(-1)];if(!scenario)throw Error('Unexpected request');
let parentId=null;
const emit=events=>events.forEach(event=>{const id=randomUUID();
process.stdout.write(JSON.stringify({id,timestamp:new Date().toISOString(),parentId,
...(event.type==='assistant.message_delta'?{ephemeral:true}:{}),...event})+'\\n');parentId=id;});
emit(scenario.initial);
if(scenario.remaining)process.stdin.once('data',()=>{emit(scenario.remaining);process.stdin.destroy();});`;
  const build = provider.buildCliArgs.bind(provider);
  vi.spyOn(provider, 'buildCliArgs').mockImplementation((configuration, session) => ['-e', source, '--', ...build(configuration, session)]);
  vi.spyOn(provider as any, 'buildPromptAsync').mockImplementation(async (content: string) => content);
  function start(name: string, panel = 'owned-panel', retired = false) {
    let child: ChildProcess | undefined;
    let firstTextResolve!: () => void;
    const firstText = new Promise<void>(resolve => { firstTextResolve = resolve; });
    let close: Promise<void> | undefined;
    const chunks: StreamChunk[] = [];
    const tracker = {
      registerProcess: (_panel: string, proc: ChildProcess) => {
        child = proc; children.push(proc);
        close = new Promise<void>(resolve => proc.once('close', () => resolve())); closures.push(close);
      },
      clearProcess: () => {},
    };
    const result = (async () => {
      for await (const chunk of provider.sendMessage(name, [], settings, null, undefined, panel, tracker)) {
        chunks.push(chunk); if (chunk.type === 'text') { firstTextResolve(); }
      }
      await close;
      if (retired) {
        expect(child?.exitCode).toBeNull();
        expect(child?.signalCode).toBe('SIGTERM');
      } else {
        expect(child?.exitCode).toBe(0);
        expect(child?.signalCode).toBeNull();
      }
      expect(chunks.some(c => c.type === 'error' || c.type === 'auth_error')).toBe(false);
      expect(chunks.filter(c => c.type === 'done')).toHaveLength(retired ? 0 : 1);
      return chunks;
    })();
    // Parallel request assertions may fail before their peer is awaited.
    // Keep cleanup failures handled while preserving rejection for the caller.
    void result.catch(() => {});
    return { result, firstText, chunks, release: () => child!.stdin!.end('continue'),
      closure: () => ({ pid: child?.pid, exitCode: child?.exitCode, signalCode: child?.signalCode }) };
  }
  return { start, readers, parse };
}

describe('Copilot completed-message output through public sends', () => {
  it('renders a successful non-streaming reply and ignores empty/repeated completions', async () => {
    const h = fixture({ first: { initial: [message('empty', ''), message('answer', 'Complete non-streaming reply.'),
      message('answer', 'Complete non-streaming reply.')] } });
    expect(text(await h.start('first').result)).toBe('Complete non-streaming reply.');
  });

  it('keeps streamed text once while rendering another message that has no nonempty delta', async () => {
    const h = fixture({ mixed: { initial: [delta('streamed', 'Streamed '), delta('streamed', 'reply.'),
      message('streamed', 'Streamed reply.'), delta('completed', ''), message('completed', ' Complete reply.'),
      message('completed', ' Complete reply.')] } });
    expect(text(await h.start('mixed').result)).toBe('Streamed reply. Complete reply.');
  });

  it('ignores a late delta after rendering the full message without suppressing another stream', async () => {
    const h = fixture({ first: { initial: [message('full', 'Complete.'), delta('full', 'Complete.'),
      message('full', 'Complete.'), delta('streamed', ' Fresh'), delta('streamed', ' stream.'),
      message('streamed', ' Fresh stream.')] } });
    expect(text(await h.start('first').result)).toBe('Complete. Fresh stream.');
  });

  it('does not reuse streamed-message suppression on the next request in the same panel', async () => {
    const h = fixture({ first: { initial: [delta('answer', 'First.'), message('answer', 'First.')] },
      second: { initial: [message('answer', 'Second.')] } });
    expect(text(await h.start('first').result)).toBe('First.');
    expect(text(await h.start('second').result)).toBe('Second.');
  });

  it('isolates the same message id in concurrent panels', async () => {
    const h = fixture({ first: { initial: [delta('answer', 'Panel A.')], remaining: [message('answer', 'Panel A.')] },
      second: { initial: [message('answer', 'Panel B.')] } });
    const first = h.start('first', 'panel-a'); await first.firstText;
    const second = h.start('second', 'panel-b'); first.release();
    const completed = await Promise.all([first.result, second.result]);
    expect(completed.map(text)).toEqual(['Panel A.', 'Panel B.']);
  });

  it('keeps delayed old parser events from suppressing a replacement reply in the same panel', async () => {
    const h = fixture({ first: { initial: [delta('old-intro', 'Old intro.')],
      remaining: [delta('answer', 'Old late.'), message('answer', 'Old late.')] },
    second: { initial: [delta('new-intro', 'New intro.')], remaining: [message('answer', 'New complete.')] } });
    const first = h.start('first', 'owned-panel', true); await first.firstText;
    const second = h.start('second'); await second.firstText;
    // Replacement retires the actual old child and suppresses its public tail.
    // Still exercise a delayed parser callback with the exact reader identity
    // captured by real stdout parsing, before releasing the new same-ID packet.
    await first.result;
    const oldReader = h.readers.get('old-intro');
    expect(oldReader).toBeDefined();
    expect(oldReader).not.toBe(h.readers.get('new-intro'));
    const lateDelta = h.parse(JSON.stringify(delta('answer', 'Old late.')), oldReader!);
    expect(lateDelta).toEqual({ type: 'text', content: 'Old late.' });
    expect(h.parse(JSON.stringify(message('answer', 'Old late.')), oldReader!)).toBeNull();
    second.release();
    const completed = await Promise.all([first.result, second.result]);
    expect(completed.map(text)).toEqual(['Old intro.', 'New intro.New complete.']);
    if (process.env.MYSTI_COPILOT_RETIRED_RECEIPT) {
      fs.appendFileSync(process.env.MYSTI_COPILOT_RETIRED_RECEIPT, JSON.stringify({
        lateDelta, distinctReaders: oldReader !== h.readers.get('new-intro'),
        turns: completed, closures: [first.closure(), second.closure()],
      }) + '\n');
    }
  });

  it('keeps native agent scopes distinct and normalizes equivalent agent attribution', async () => {
    const childDelta = delta('answer', 'Child.'); childDelta.agentId = 'child-agent';
    // Preserve the adapter's compatibility with older payload-level attribution.
    const childMessage = message('answer', 'Child.'); childMessage.data!.agentId = 'child-agent';
    const h = fixture({ first: { initial: [childDelta, childMessage, message('answer', 'Root.')] } });
    expect(text(await h.start('first').result)).toBe('Child.Root.');
  });

  it('forwards existing tool and context-window fields through the request parser view', async () => {
    const h = fixture({ first: { initial: [
      { type: 'tool.execution_start', data: { toolCallId: 'read', toolName: 'view', arguments: { path: '/owned.txt' } } },
      { type: 'tool.execution_complete', data: { toolCallId: 'read', success: true, result: { content: 'Owned file.' } } },
      { type: 'session.usage_info', data: { tokenLimit: 200000 } }, message('answer', 'Read complete.'),
      { type: 'result', stats: { input_tokens: 3, output_tokens: 4 } },
    ] } });
    const chunks = await h.start('first').result;
    expect(chunks.find(c => c.type === 'tool_result')?.toolCall).toEqual({ id: 'read', name: 'view',
      input: { path: '/owned.txt' }, output: 'Owned file.', status: 'completed' });
    expect(chunks.find(c => c.type === 'done')).toEqual({ type: 'done', contextWindow: 200000,
      usage: { input_tokens: 3, output_tokens: 4 } });
    expect(text(chunks)).toBe('Read complete.');
  });
});
