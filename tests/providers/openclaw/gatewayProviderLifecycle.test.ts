/** Provider ownership at the gateway/CLI boundary; no gateway or model is contacted. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { clearMockConfig } from '../../helpers/mockVscode';
import type { OpenClawSessionState } from '../../../src/providers/openclaw/OpenClawProvider';
import type { GatewayAgentOptions, OpenClawGateway } from '../../../src/providers/openclaw/OpenClawGateway';
import type { Attachment, Conversation, Settings, StreamChunk } from '../../../src/types';

const settings: Settings = {
  mode: 'default', thinkingLevel: 'medium', accessLevel: 'ask-permission',
  contextMode: 'auto', model: '', provider: 'openclaw',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function collect(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) { chunks.push(chunk); }
  return chunks;
}
function untilAbort(signal: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal.aborted) { resolve(); }
    else { signal.addEventListener('abort', () => resolve(), { once: true }); }
  });
}

describe('OpenClaw provider turn ownership', () => {
  let provider: TestableOpenClawProvider;
  let gateway: {
    connect: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
    isConnected: ReturnType<typeof vi.fn<() => boolean>>;
    disconnect: ReturnType<typeof vi.fn>;
    sendAgentMessage: ReturnType<typeof vi.fn<OpenClawGateway['sendAgentMessage']>>;
  };
  let internal: {
    _gateway: unknown;
    _getSession(panelId: string): OpenClawSessionState;
    buildPromptAsync: (...args: unknown[]) => Promise<string>;
    _sendViaCli: (...args: unknown[]) => AsyncGenerator<StreamChunk>;
  };

  beforeEach(() => {
    clearMockConfig();
    provider = new TestableOpenClawProvider();
    internal = provider as unknown as typeof internal;
    gateway = {
      connect: vi.fn(async () => true),
      isConnected: vi.fn(() => true),
      disconnect: vi.fn(),
      sendAgentMessage: vi.fn(async function* (message: string) {
        yield { type: 'text', content: message };
      }),
    };
    internal._gateway = gateway;
    vi.spyOn(internal, 'buildPromptAsync').mockImplementation(async content => String(content));
  });
  afterEach(() => { provider.dispose(); clearMockConfig(); });

  it('Stop wakes a pending connection and prevents late gateway or CLI submission', async () => {
    const connection = deferred<boolean>();
    gateway.isConnected.mockReturnValue(false);
    gateway.connect.mockReturnValue(connection.promise);
    const cli = vi.spyOn(internal, '_sendViaCli');
    const pending = collect(provider.sendMessage('old', [], settings, null, undefined, 'a'));
    await vi.waitFor(() => expect(gateway.connect).toHaveBeenCalledOnce());
    provider.cancelCurrentRequest('a');
    expect(await pending).toEqual([]);
    connection.resolve(true);
    await Promise.resolve();
    expect(gateway.sendAgentMessage).not.toHaveBeenCalled();
    expect(cli).not.toHaveBeenCalled();
  });

  it('a replacement can use the connection whose earlier waiter was cancelled', async () => {
    const connection = deferred<boolean>();
    gateway.isConnected.mockReturnValue(false);
    gateway.connect.mockReturnValue(connection.promise);
    const old = collect(provider.sendMessage('old', [], settings, null, undefined, 'a'));
    const next = collect(provider.sendMessage('new', [], settings, null, undefined, 'a'));
    expect(await old).toEqual([]);
    connection.resolve(true);
    expect((await next).filter(chunk => chunk.type === 'text')).toEqual([{ type: 'text', content: 'new' }]);
    expect(gateway.sendAgentMessage).toHaveBeenCalledOnce();
  });

  it('Stop during prompt preparation prevents a late send', async () => {
    const prompt = deferred<string>();
    vi.mocked(internal.buildPromptAsync).mockReturnValue(prompt.promise);
    const pending = collect(provider.sendMessage('old', [], settings, null, undefined, 'a'));
    await vi.waitFor(() => expect(internal.buildPromptAsync).toHaveBeenCalledOnce());
    provider.cancelCurrentRequest('a');
    expect(await pending).toEqual([]);
    prompt.resolve('late');
    await Promise.resolve();
    expect(gateway.sendAgentMessage).not.toHaveBeenCalled();
  });

  it('Stop after the session indicator still prevents submission', async () => {
    const stream = provider.sendMessage('old', [], settings, null, undefined, 'a');
    expect((await stream.next()).value?.type).toBe('session_active');
    provider.cancelCurrentRequest('a');
    expect(await collect(stream)).toEqual([]);
    expect(gateway.sendAgentMessage).not.toHaveBeenCalled();
  });

  it('stopping one panel leaves another signal and session untouched', async () => {
    const options = new Map<string, GatewayAgentOptions>();
    gateway.sendAgentMessage.mockImplementation(async function* (message, supplied = {}) {
      options.set(message, supplied);
      yield { type: 'text', content: message };
      await untilAbort(supplied.signal!);
      yield { type: 'text', content: 'late output' };
    });
    const a = collect(provider.sendMessage('a', [], settings, null, undefined, 'a'));
    const b = collect(provider.sendMessage('b', [], settings, null, undefined, 'b'));
    await vi.waitFor(() => expect(options.size).toBe(2));
    expect(options.get('a')?.sessionKey).not.toBe(options.get('b')?.sessionKey);
    provider.cancelCurrentRequest('a');
    expect((await a).some(chunk => chunk.content === 'late output')).toBe(false);
    expect(options.get('b')?.signal?.aborted).toBe(false);
    provider.cancelCurrentRequest('b');
    await b;
  });

  it('old cleanup cannot abort a replacement in the same panel', async () => {
    const options = new Map<string, GatewayAgentOptions>();
    gateway.sendAgentMessage.mockImplementation(async function* (message, supplied = {}) {
      options.set(message, supplied);
      await untilAbort(supplied.signal!);
    });
    const old = collect(provider.sendMessage('old', [], settings, null, undefined, 'a'));
    await vi.waitFor(() => expect(options.has('old')).toBe(true));
    const next = collect(provider.sendMessage('new', [], settings, null, undefined, 'a'));
    await vi.waitFor(() => expect(options.has('new')).toBe(true));
    await old;
    expect(options.get('old')?.signal?.aborted).toBe(true);
    expect(options.get('new')?.signal?.aborted).toBe(false);
    provider.cancelCurrentRequest('a');
    await next;
  });

  it('forwards attachments as RPC content and emits exactly one done', async () => {
    const attachments: Attachment[] = [{
      id: 'a', type: 'file', fileName: 'example.txt', mimeType: 'text/plain', size: 5,
      base64Data: Buffer.from('hello').toString('base64'),
    }];
    const chunks = await collect(provider.sendMessage('read it', [], settings, null, undefined, 'a', undefined, undefined, attachments));
    expect(gateway.sendAgentMessage.mock.calls[0][1]?.attachments).toEqual([{
      type: 'file', fileName: 'example.txt', mimeType: 'text/plain', content: 'aGVsbG8=',
    }]);
    expect(attachments[0].filePath).toBeUndefined();
    expect(chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1);
  });

  it('forwards history and owned attachments to the CLI fallback', async () => {
    gateway.isConnected.mockReturnValue(false);
    gateway.connect.mockResolvedValue(false);
    const cli = vi.spyOn(internal, '_sendViaCli').mockImplementation(async function* () {
      yield { type: 'done' };
    });
    const history = { messages: [{ role: 'user', content: 'earlier' }] } as Conversation;
    const attachments: Attachment[] = [{ id: 'a', type: 'file', fileName: 'a.txt', mimeType: 'text/plain', size: 0 }];
    const chunks = await collect(provider.sendMessage('next', [], settings, history, undefined, 'a', undefined, undefined, attachments));
    expect(cli.mock.calls[0][7]).toBe(history);
    expect(cli.mock.calls[0][8]).toEqual(attachments);
    expect((cli.mock.calls[0][8] as Attachment[])[0]).not.toBe(attachments[0]);
    expect(chunks).toEqual([{ type: 'done' }]);
  });
  it('keeps done terminal when CLI cleanup fails after supplying usage', async () => {
    gateway.isConnected.mockReturnValue(false);
    gateway.connect.mockResolvedValue(false);
    const done: StreamChunk = { type: 'done', usage: { input_tokens: 3, output_tokens: 2 } };
    vi.spyOn(internal, '_sendViaCli').mockImplementation(async function* () {
      yield { type: 'text', content: 'answer' };
      yield done;
      throw new Error('prompt cleanup EACCES');
    });
    const chunks = await collect(provider.sendMessage('next', [], settings, null, undefined, 'a'));
    expect(chunks.map(chunk => chunk.type)).toEqual(['text', 'error', 'done']);
    expect(chunks.at(-1)).toEqual(done);
  });

  it('preserves history after Stop between session indicator and submission', async () => {
    const history = { messages: [{ role: 'user', content: 'earlier' }] } as Conversation;
    const stream = provider.sendMessage('first', [], settings, history, undefined, 'a');
    expect((await stream.next()).value?.type).toBe('session_active');
    provider.cancelCurrentRequest('a');
    await collect(stream);
    expect(provider.getSessionId('a')).toBeNull();
    await collect(provider.sendMessage('second', [], settings, history, undefined, 'a'));
    expect(vi.mocked(internal.buildPromptAsync).mock.calls[1][2]).toBe(history);
  });

  it('marks history as resumed only after gateway acceptance', async () => {
    const history = { messages: [{ role: 'user', content: 'earlier' }] } as Conversation;
    gateway.sendAgentMessage.mockImplementation(async function* (_message, options = {}) {
      options.onAccepted?.(options.sessionKey!);
      yield { type: 'text', content: 'answer' };
    });
    await collect(provider.sendMessage('first', [], settings, history, undefined, 'a'));
    expect(provider.getSessionId('a')).toBeTruthy();
    await collect(provider.sendMessage('second', [], settings, history, undefined, 'a'));
    expect(vi.mocked(internal.buildPromptAsync).mock.calls[0][2]).toBe(history);
    expect(vi.mocked(internal.buildPromptAsync).mock.calls[1][2]).toBeNull();
  });

  it('shares a routing key across transports without treating the transcript ID as a key', async () => {
    const session = internal._getSession('a');
    const cliArgs = provider.buildCliArgs(settings, session);
    const key = cliArgs[cliArgs.indexOf('--session-key') + 1];
    session.sessionId = 'native-transcript-uuid';
    await collect(provider.sendMessage('continue', [], settings, null, undefined, 'a'));
    expect(gateway.sendAgentMessage.mock.calls[0][1]?.sessionKey).toBe(key);
    expect(gateway.sendAgentMessage.mock.calls[0][1]?.sessionKey).not.toBe(session.sessionId);
  });

  it('rotates only the cleared panel routing key in both transports', async () => {
    const a = internal._getSession('a');
    const b = internal._getSession('b');
    const key = (session: OpenClawSessionState) => {
      const args = provider.buildCliArgs(settings, session);
      return args[args.indexOf('--session-key') + 1];
    };
    const oldA = key(a);
    const oldB = key(b);
    provider.clearSession('a');
    expect(key(a)).not.toBe(oldA);
    expect(key(b)).toBe(oldB);
    await collect(provider.sendMessage('fresh', [], settings, null, undefined, 'a'));
    expect(gateway.sendAgentMessage.mock.calls[0][1]?.sessionKey).toBe(key(a));
  });

  it('reports the gateway empty-attachment limitation before submitting', async () => {
    const attachments: Attachment[] = [{
      id: 'empty', type: 'file', fileName: 'empty.txt', mimeType: 'text/plain', size: 0, base64Data: '',
    }];
    const chunks = await collect(provider.sendMessage('read', [], settings, null, undefined, 'a', undefined, undefined, attachments));
    expect(chunks.map(chunk => chunk.type)).toEqual(['error', 'done']);
    expect(chunks[0].content).toContain('does not accept empty attachments');
    expect(gateway.sendAgentMessage).not.toHaveBeenCalled();
  });

});
