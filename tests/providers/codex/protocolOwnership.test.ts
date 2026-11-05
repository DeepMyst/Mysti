import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestableCodexProvider } from '../../helpers/providerFactory';
import { clearConfigurationListeners, clearMockConfig } from '../../helpers/mockVscode';
import type { Settings, StreamChunk } from '../../../src/types';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn(async () => {}) }));
vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), spawn: mocks.spawn }));
vi.mock('../../../src/utils/processKill', async original => ({ ...await original<typeof import('../../../src/utils/processKill')>(), killProcessTree: mocks.kill }));
const providers: TestableCodexProvider[] = [];
afterEach(() => { for (const provider of providers.splice(0)) provider.dispose(); vi.restoreAllMocks(); clearMockConfig(); clearConfigurationListeners(); });
type Frame = Record<string, any>;
const settings = { provider: 'openai-codex', model: 'controlled-model', mode: 'ask-before-edit', accessLevel: 'ask-permission',
  thinkingLevel: 'none', contextMode: 'manual' } as Settings;
const notice = (method: string, turnId: string, extra: Frame = {}): Frame => ({ method, params: { threadId: 'owned-thread', turnId, ...extra } });
const terminal = (id: string, status = 'completed'): Frame => notice('turn/completed', id, { turn: { id, status } });

/** Actual public provider send, native RPC parser and request lifecycle; only
 * the child transport and environmental prompt helpers are controlled. */
function harness(handshake?: (method: string) => unknown) {
  mocks.spawn.mockReset(); mocks.kill.mockClear();
  const provider = new TestableCodexProvider(); providers.push(provider);
  vi.spyOn(provider, 'getCliPath').mockReturnValue('/controlled/codex');
  vi.spyOn(provider as any, 'buildAgentInstructionsAsync').mockResolvedValue('');
  vi.spyOn(provider as any, 'prepareAttachments').mockResolvedValue(async () => {});
  const children: Array<{ frames: Frame[]; emit: (...frames: Frame[]) => void }> = [];
  mocks.spawn.mockImplementation(() => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough(), frames: Frame[] = [];
    const child = { frames, emit: (...values: Frame[]) => { stdout.write(values.map(value => JSON.stringify(value) + '\n').join('')); } };
    children.push(child); let buffer = '';
    stdin.on('data', bytes => {
      buffer += bytes.toString(); let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); frames.push(frame);
        if (['initialize', 'config/read', 'thread/start', 'thread/resume'].includes(frame.method)) {
          setImmediate(() => child.emit({ id: frame.id, result: handshake ? handshake(frame.method)
            : frame.method === 'initialize' ? {} : frame.method === 'config/read' ? { config: {} } : { thread: { id: 'owned-thread' } } }));
        }
      }
    });
    return Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: 97000 + children.length, exitCode: null, signalCode: null, killed: false, kill: vi.fn() });
  });
  const begin = (content: string) => {
    const previous = children.at(-1), offset = previous?.frames.length || 0, chunks: StreamChunk[] = []; let settled = false;
    const completion = (async () => { try { for await (const chunk of provider.sendMessage(content, [], settings, null, undefined, 'panel')) chunks.push(chunk); } finally { settled = true; } })();
    return { chunks, completion, settled: () => settled, previous, offset };
  };
  const start = async (content: string) => {
    const run = begin(content);
    await vi.waitFor(() => expect(children.at(-1)?.frames.slice(children.at(-1) === run.previous ? run.offset : 0).some(frame => frame.method === 'turn/start')).toBe(true), { interval: 1 });
    const child = children.at(-1)!, rpc = child.frames.filter(frame => frame.method === 'turn/start').at(-1)!;
    return { ...run, child, rpc,
      accept: (id: string) => child.emit({ id: rpc.id, result: { turn: { id, status: 'inProgress' } } }),
      finish: async (id: string) => { child.emit(terminal(id)); await run.completion; },
    };
  };
  const stop = async (run: { completion: Promise<void> }) => { provider.cancelCurrentRequest('panel'); await run.completion; };
  return { provider, children, begin, start, stop };
}

describe('Codex native turn ownership through public provider sends', () => {
  it('ignores old same-thread text, tool results, usage and failures while the current turn completes', async () => {
    const h = harness(), first = await h.start('First turn'); first.accept('old'); await first.finish('old');
    const current = await h.start('Current turn'); current.accept('current');
    current.child.emit(
      notice('item/agentMessage/delta', 'old', { itemId: 'reused', delta: 'STALE_TEXT' }),
      notice('item/completed', 'old', { item: { id: 'old-tool', type: 'commandExecution', command: 'old command', status: 'completed', aggregatedOutput: 'STALE_TOOL' } }),
      notice('thread/tokenUsage/updated', 'old', { tokenUsage: { last: { inputTokens: 9000, outputTokens: 4000 } } }),
      notice('error', 'old', { willRetry: false, error: { message: 'STALE_FAILURE' } }),
      terminal('old', 'failed'),
      notice('item/completed', 'current', { item: { id: 'reused', type: 'agentMessage', text: 'CURRENT_ONLY' } }), terminal('current'),
    );
    await current.completion;
    expect(current.chunks.filter(value => value.type !== 'done')).toEqual([{ type: 'text', content: 'CURRENT_ONLY' }]);
    expect(current.chunks.find(value => value.type === 'done')?.usage).toBeUndefined();
  });

  it('does not let a delayed turn/started replace an already acknowledged current turn', async () => {
    const h = harness(), first = await h.start('First turn'); first.accept('old'); await first.finish('old');
    const current = await h.start('Current turn'); current.accept('current');
    current.child.emit(notice('turn/started', 'old', { turn: { id: 'old' } }),
      notice('item/agentMessage/delta', 'current', { itemId: 'current', delta: 'CURRENT' }), terminal('current'));
    try {
      await vi.waitFor(() => expect(current.settled()).toBe(true), { timeout: 150, interval: 1 });
      expect(current.chunks.filter(value => value.type === 'text').map(value => value.content)).toEqual(['CURRENT']);
    } finally { await h.stop(current); }
  });

  it('cannot complete a replacement turn from an old terminal while its turn/start response is pending', async () => {
    const h = harness(), first = await h.start('First turn'); first.accept('old'); await first.finish('old');
    const current = await h.start('Current turn');
    current.child.emit(terminal('old'));
    await new Promise(resolve => setImmediate(resolve));
    try {
      expect(current.settled()).toBe(false);
      current.accept('current'); current.child.emit(notice('item/agentMessage/delta', 'current', { itemId: 'text', delta: 'CURRENT' }), terminal('current'));
      await current.completion;
      expect(current.chunks.filter(value => value.type === 'text').map(value => value.content)).toEqual(['CURRENT']);
    } finally { await h.stop(current); }
  });

  it('preserves valid notification order when output and completion arrive before turn/start acknowledgement', async () => {
    const h = harness(), current = await h.start('Early native output');
    current.child.emit(notice('turn/started', 'current', { turn: { id: 'current' } }),
      notice('item/agentMessage/delta', 'current', { itemId: 'text', delta: 'BEFORE_ACK' }),
      notice('item/completed', 'current', { item: { id: 'command', type: 'commandExecution', command: 'fixture', status: 'completed', aggregatedOutput: 'TOOL_OUTPUT' } }),
      terminal('current'));
    await new Promise(resolve => setImmediate(resolve));
    try {
      expect(current.chunks.filter(value => value.type !== 'session_active')).toEqual([]); expect(current.settled()).toBe(false);
      current.accept('current');
      await vi.waitFor(() => expect(current.settled()).toBe(true), { timeout: 150, interval: 1 });
      expect(current.chunks.filter(value => value.type !== 'session_active').map(value => value.type === 'tool_result' ? value.toolCall?.output : value.type === 'text' ? value.content : value.type)).toEqual(['BEFORE_ACK', 'TOOL_OUTPUT', 'done']);
    } finally { await h.stop(current); }
  });

  it('rejects stale questions and patch approvals before they can affect the current owner', async () => {
    const h = harness(), approval = vi.fn(async () => true); h.provider.setNativeApprovalHost({ handlerForPanel: () => approval });
    const current = await h.start('Current turn'); current.accept('current');
    current.child.emit({ id: 'old-question', ...notice('item/tool/requestUserInput', 'old', { questions: [{ id: 'q', header: 'Old', question: 'STALE QUESTION?', options: [] }] }) },
      { id: 'other-question', ...notice('item/tool/requestUserInput', 'current', { threadId: 'other-thread', questions: [{ id: 'q', header: 'Other', question: 'FOREIGN QUESTION?' }] }) },
      { id: 'old-patch', ...notice('item/fileChange/requestApproval', 'old', { itemId: 'missing-old-item' }) }, terminal('current'));
    await current.completion;
    expect(current.chunks.filter(value => value.type !== 'done' && value.type !== 'session_active')).toEqual([]); expect(approval).not.toHaveBeenCalled();
    expect(current.child.frames.find(value => value.id === 'old-question')).toMatchObject({ result: { answers: {} } });
    expect(current.child.frames.find(value => value.id === 'old-patch')).toMatchObject({ result: { decision: 'cancel' } });
  });

  it('fails and evicts a transport overflowing pre-acknowledgement output, even when the next frame is completion', async () => {
    const h = harness(), current = await h.start('Broken backend never acknowledges this turn');
    current.child.emit(...Array.from({ length: 1024 }, (_, index) => notice('item/agentMessage/delta', 'unacknowledged', {
      itemId: `early-${index}`, delta: 'Buffered text must never be presented as an acknowledged turn.',
    })), terminal('unacknowledged'));
    try {
      await vi.waitFor(() => expect(current.settled()).toBe(true), { timeout: 150, interval: 1 });
      expect(current.chunks.filter(value => value.type === 'error')).toEqual([
        expect.objectContaining({ content: expect.stringContaining('before acknowledging the turn') }),
      ]);
      expect(current.chunks.some(value => value.type === 'text')).toBe(false);
      expect(mocks.kill).toHaveBeenCalled();
      const recovered = await h.start('Explicit recovery after malformed transport');
      expect(h.children).toHaveLength(2);
      recovered.accept('recovered'); recovered.child.emit(notice('item/agentMessage/delta', 'recovered', { itemId: 'text', delta: 'RECOVERED' }), terminal('recovered'));
      await recovered.completion;
      expect(recovered.chunks.filter(value => value.type === 'text').map(value => value.content)).toEqual(['RECOVERED']);
    } finally { await h.stop(current); }
  });

  it.each([['initialize', null], ['config/read', {}], ['thread/start', { thread: { id: '' } }], ['turn/start', {}]])('settles malformed %s without submitting or silently retrying abandoned work', async (method, malformed) => {
    const h = harness(name => name === method ? malformed : name === 'initialize' ? {} : name === 'config/read' ? { config: {} } : { thread: { id: 'owned-thread' } });
    const run = h.begin('Must fail explicitly');
    try {
      if (method === 'turn/start') {
        await vi.waitFor(() => expect(h.children.at(-1)?.frames.some(value => value.method === 'turn/start')).toBe(true), { interval: 1 });
        const child = h.children.at(-1)!, rpc = child.frames.find(value => value.method === 'turn/start'); child.emit({ id: rpc.id, result: malformed });
      }
      await vi.waitFor(() => expect(run.settled()).toBe(true), { timeout: 150, interval: 1 });
      expect(run.chunks.filter(value => value.type === 'error')).toHaveLength(1);
      expect(run.chunks.find(value => value.type === 'error')?.content).toMatch(/Codex.*(?:invalid|no .*ID|malformed)/i);
      expect(h.children).toHaveLength(1);
      expect(h.children[0].frames.filter(value => value.method === 'turn/start')).toHaveLength(method === 'turn/start' ? 1 : 0);
    } finally { await h.stop(run); }
  });
});
