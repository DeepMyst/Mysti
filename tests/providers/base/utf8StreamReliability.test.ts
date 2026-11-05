import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestableCodexProvider, TestableGeminiProvider } from '../../helpers/providerFactory';
import { clearConfigurationListeners, clearMockConfig } from '../../helpers/mockVscode';
import type { Settings, StreamChunk } from '../../../src/types';
import type { NativeApprovalRequest } from '../../../src/providers/base/IProvider';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn(async () => {}) }));
vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), spawn: mocks.spawn }));
vi.mock('../../../src/utils/processKill', async original => ({
  ...await original<typeof import('../../../src/utils/processKill')>(), killProcessTree: mocks.kill,
}));

const providers: Array<TestableCodexProvider | TestableGeminiProvider> = [];
beforeEach(() => {
  mocks.spawn.mockReset(); mocks.kill.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  providers.splice(0).forEach(provider => provider.dispose());
  vi.restoreAllMocks(); clearMockConfig(); clearConfigurationListeners();
});

// Every interior byte boundary of 2-, 3-, and 4-byte characters, including
// each letter of a real RTL string. Splits are in bytes, never JS code units.
const splitCases = ['é', '€', '😀', 'مرحبا'].flatMap(text => {
  let preceding = 0;
  return [...text].flatMap(character => {
    const size = Buffer.byteLength(character);
    const result = Array.from({ length: size - 1 }, (_, index) => ({ text, offset: preceding + index + 1 }));
    preceding += size;
    return result;
  });
});
const payload = 'Before é € 😀 مرحبا after';
const frame = (value: unknown, newline = true) => JSON.stringify(value) + (newline ? '\n' : '');
function splitFrame(value: unknown, text: string, offset: number): Buffer[] {
  const bytes = Buffer.from(frame(value));
  const start = bytes.indexOf(Buffer.from(text));
  expect(start).toBeGreaterThanOrEqual(0);
  return [bytes.subarray(0, start + offset), bytes.subarray(start + offset)];
}
async function collect(stream: AsyncGenerator<StreamChunk>) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) { chunks.push(chunk); }
  return chunks;
}
const textOf = (chunks: StreamChunk[]) => chunks.filter(chunk => chunk.type === 'text').map(chunk => chunk.content).join('');
function successful(chunks: StreamChunk[]) {
  expect(chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1);
  expect(chunks.filter(chunk => chunk.type === 'error' || chunk.type === 'auth_error')).toEqual([]);
}

type Rpc = { id: number | string; method?: string; params?: Record<string, any>; result?: unknown };
type Child = { process: ChildProcess; stdout: PassThrough; received: Rpc[]; emit(value: unknown): void; bytes(data: Buffer | string): void };

/** Only native I/O and environmental prompt helpers are controlled: public
 * send, actual stream decoding, Codex RPC ownership, and approvals stay real. */
function nativeHarness() {
  const provider = new TestableCodexProvider(); providers.push(provider);
  vi.spyOn(provider, 'getCliPath').mockReturnValue('/controlled/codex');
  vi.spyOn(provider as any, 'buildAgentInstructionsAsync').mockResolvedValue('');
  vi.spyOn(provider as any, 'prepareAttachments').mockResolvedValue(async () => {});
  const settings: Settings = { provider: 'openai-codex', model: provider.config.defaultModel,
    mode: 'ask-before-edit', accessLevel: 'ask-permission', thinkingLevel: 'none', contextMode: 'manual' };
  const children: Child[] = [];
  mocks.spawn.mockImplementation(() => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    const process = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: 84000 + children.length,
      exitCode: null, signalCode: null, killed: false, kill: vi.fn() }) as unknown as ChildProcess;
    const child: Child = { process, stdout, received: [], emit: value => { stdout.emit('data', Buffer.from(frame(value))); },
      bytes: data => { stdout.emit('data', data); } };
    children.push(child);
    let input = '';
    stdin.on('data', bytes => {
      input += bytes.toString(); let newline: number;
      while ((newline = input.indexOf('\n')) >= 0) {
        const rpc: Rpc = JSON.parse(input.slice(0, newline)); input = input.slice(newline + 1); child.received.push(rpc);
        if (['initialize', 'config/read', 'thread/start', 'thread/resume'].includes(rpc.method || '')) {
          setImmediate(() => child.emit({ id: rpc.id, result: rpc.method === 'initialize' ? {}
            : rpc.method === 'config/read' ? { config: {} } : { thread: { id: 'owned-thread' } } }));
        }
      }
    });
    return process;
  });
  let number = 0;
  const start = async (overrides: Partial<Settings> = {}) => {
    const previous = children.at(-1), previousCount = previous?.received.length || 0;
    const completion = collect(provider.sendMessage('Exercise exact Unicode transport.', [], { ...settings, ...overrides }, null, undefined, 'panel'));
    await vi.waitFor(() => expect(children.at(-1)?.received.slice(children.at(-1) === previous ? previousCount : 0)
      .some(value => value.method === 'turn/start')).toBe(true), { interval: 1 });
    const child = children.at(-1)!;
    const rpc = child.received.filter(value => value.method === 'turn/start').at(-1)!;
    const turnId = `turn-${++number}`;
    child.emit({ id: rpc.id, result: { turn: { id: turnId } } });
    const notice = (method: string, extra: Record<string, unknown>) => ({ method,
      params: { threadId: 'owned-thread', turnId, ...extra } });
    const terminal = notice('turn/completed', { turn: { id: turnId, status: 'completed' } });
    const finish = async () => { child.emit(terminal); return completion; };
    return { child, notice, terminal, completion, finish };
  };
  return { provider, children, start };
}

describe('PB02-D09 native UTF-8 stream integrity', () => {
  for (const kind of ['text', 'tool output', 'approval input'] as const) {
    it.each(splitCases)(`${kind}: preserves $text split at byte $offset`, async ({ text, offset }) => {
      const h = nativeHarness();
      const requests: NativeApprovalRequest[] = [];
      h.provider.setNativeApprovalHost({ handlerForPanel: () => async request => { requests.push(request); return false; } });
      const sent = await h.start();
      const expected = `Before ${text} after`;
      const value = kind === 'text' ? sent.notice('item/agentMessage/delta', { itemId: 'answer', delta: expected })
        : kind === 'tool output' ? sent.notice('item/completed', { item: { id: 'tool', type: 'commandExecution',
          command: 'controlled-read', status: 'completed', aggregatedOutput: expected } })
        : { id: 'approval', ...sent.notice('item/commandExecution/requestApproval', { itemId: 'tool', command: `printf '${expected}'` }) };
      for (const bytes of splitFrame(value, text, offset)) { sent.child.bytes(bytes); }
      if (kind === 'approval input') {
        await vi.waitFor(() => expect(sent.child.received.some(rpc => rpc.id === 'approval')).toBe(true), { interval: 1 });
        expect(requests).toHaveLength(1);
        expect(requests[0].toolCall.input).toMatchObject({ command: `printf '${expected}'` });
        expect(sent.child.received.filter(rpc => rpc.id === 'approval')).toEqual([{ id: 'approval', result: { decision: 'decline' } }]);
      }
      const chunks = await sent.finish(); successful(chunks);
      if (kind === 'text') { expect(textOf(chunks)).toBe(expected); }
      if (kind === 'tool output') { expect(chunks.find(chunk => chunk.type === 'tool_result')?.toolCall?.output).toBe(expected); }
    });
  }

  it.each(['whole buffer', 'decoded string', 'one byte at a time'])('preserves mixed Unicode and coalesced lines with %s', async mode => {
    const h = nativeHarness(), sent = await h.start();
    const combined = frame(sent.notice('item/agentMessage/delta', { itemId: 'answer', delta: payload })) + frame(sent.terminal);
    const bytes = Buffer.from(combined);
    if (mode === 'one byte at a time') { for (const byte of bytes) { sent.child.bytes(Buffer.from([byte])); } }
    else { sent.child.bytes(mode === 'decoded string' ? combined : bytes); }
    const chunks = await sent.completion; successful(chunks); expect(textOf(chunks)).toBe(payload);
    expect(sent.child.stdout.listenerCount('data')).toBe(0);
    expect(sent.child.stdout.listenerCount('end')).toBe(0);
  });

  it('preserves sequential replies on one process and a new model process', async () => {
    const h = nativeHarness();
    for (let index = 0; index < 3; index++) {
      const sent = await h.start(index === 2 ? { effortLevel: 'high' } : {});
      for (const bytes of splitFrame(sent.notice('item/agentMessage/delta', { itemId: 'answer', delta: payload }), '😀', 2)) {
        sent.child.bytes(bytes);
      }
      const chunks = await sent.finish(); successful(chunks); expect(textOf(chunks)).toBe(payload);
    }
    expect(h.children).toHaveLength(2);
    expect(h.children[1].received.find(rpc => rpc.method === 'thread/resume')?.params).toMatchObject({ threadId: 'owned-thread' });
  });

  it('discards incomplete bytes on Stop without contaminating a replacement or a late old event', async () => {
    const h = nativeHarness(), old = await h.start();
    const parts = splitFrame(old.notice('item/agentMessage/delta', { itemId: 'answer', delta: 'obsolete 😀' }), '😀', 2);
    old.child.bytes(parts[0]); h.provider.cancelCurrentRequest('panel');
    expect(textOf(await old.completion)).toBe('');
    const replacement = await h.start();
    old.child.bytes(parts[1]); old.child.emit(old.terminal); old.child.process.emit('close', 0, null);
    for (const bytes of splitFrame(replacement.notice('item/agentMessage/delta', { itemId: 'answer', delta: payload }), 'é', 1)) {
      replacement.child.bytes(bytes);
    }
    const chunks = await replacement.finish(); successful(chunks); expect(textOf(chunks)).toBe(payload);
    expect(h.children).toHaveLength(2);
    expect(old.child.stdout.listenerCount('data')).toBe(0);
    expect(old.child.stdout.listenerCount('end')).toBe(0);
  });

  it('retains a final unterminated Unicode frame at EOF while reporting a missing native terminal', async () => {
    const h = nativeHarness(), sent = await h.start();
    const parts = splitFrame(sent.notice('item/agentMessage/delta', { itemId: 'answer', delta: payload }), '€', 1);
    sent.child.bytes(parts[0]); sent.child.bytes(parts[1].subarray(0, -1));
    sent.child.stdout.emit('end');
    Object.assign(sent.child.process, { exitCode: 0 }); sent.child.process.emit('close', 0, null);
    const chunks = await sent.completion;
    expect(textOf(chunks)).toBe(payload);
    expect(chunks.filter(chunk => chunk.type === 'error')).toEqual([expect.objectContaining({ content: expect.stringMatching(/incomplete/) })]);
    expect(chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1);
  });

  it('accepts a final unterminated terminal only at true EOF', async () => {
    const h = nativeHarness(), sent = await h.start();
    sent.child.emit(sent.notice('item/agentMessage/delta', { itemId: 'answer', delta: payload }));
    sent.child.bytes(frame(sent.terminal, false));
    sent.child.stdout.emit('end');
    Object.assign(sent.child.process, { exitCode: 0 }); sent.child.process.emit('close', 0, null);
    const chunks = await sent.completion; successful(chunks); expect(textOf(chunks)).toBe(payload);
  });
});

/** Gemini really uses the shared single-shot parser. An async source preserves
 * chosen byte boundaries instead of letting a Readable coalesce test writes. */
async function singleShot(parts: Array<Buffer | string>) {
  const provider = new TestableGeminiProvider(); providers.push(provider);
  const internal = provider as any, session = internal._getSession('single');
  session.process = { exitCode: 0, signalCode: null, stdout: { async *[Symbol.asyncIterator]() { yield* parts; } } };
  try { return await collect(internal.processStream({ output: '' }, session)); }
  finally { session.process = null; }
}

describe('PB02-D09 shared single-shot UTF-8 stream integrity', () => {
  it.each(splitCases)('preserves $text split at byte $offset', async ({ text, offset }) => {
    const expected = `Before ${text} after`;
    const chunks = await singleShot(splitFrame({ type: 'message', role: 'assistant', content: expected }, text, offset));
    expect(chunks).toEqual([{ type: 'text', content: expected }]);
  });

  it('accepts already decoded string chunks and an unterminated final JSON frame', async () => {
    const line = frame({ type: 'message', role: 'assistant', content: payload }, false);
    expect(await singleShot([line.slice(0, 8), line.slice(8)])).toEqual([{ type: 'text', content: payload }]);
  });

  it('flushes one replacement character for an incomplete sequence only at EOF', async () => {
    // Non-JSON CLI text is supported by Gemini. A true truncation produces one
    // replacement character for this incomplete UTF-8 sequence, not one/byte.
    expect(await singleShot([Buffer.from('partial '), Buffer.from([0xf0]), Buffer.from([0x9f])]))
      .toEqual([{ type: 'text', content: 'partial �' }]);
    expect(await singleShot([Buffer.from('next é')])).toEqual([{ type: 'text', content: 'next é' }]);
  });
});
