import * as path from 'node:path';
/** Provider ownership at the managed runtime boundary; no model or external gateway is contacted. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { clearMockConfig, setMockConfig } from '../../helpers/mockVscode';
import type { OpenClawSessionState } from '../../../src/providers/openclaw/OpenClawProvider';
import { OpenClawGateway, type GatewayAgentOptions } from '../../../src/providers/openclaw/OpenClawGateway';
import { OpenClawManagedRuntime } from '../../../src/providers/openclaw/OpenClawManagedRuntime';
import { OpenClawPolicyBroker, type OpenClawBrokerLease } from '../../../src/providers/openclaw/OpenClawPolicyBroker';
import { OpenClawPolicyRun, type OpenClawPolicyRunOptions } from '../../../src/providers/openclaw/OpenClawPolicyRun';
import type { NativeApprovalHandler } from '../../../src/providers/base/IProvider';
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

describe('OpenClaw provider managed turn ownership', () => {
  let provider: TestableOpenClawProvider;
  let internal: {
    _gateway: OpenClawGateway;
    _getSession(panelId: string): OpenClawSessionState;
    _readOwnedRuntimeConfig(signal: AbortSignal): Promise<{
      cliPath: string; installedRoot: string; workspaceDir: string; fingerprint: string;
      baseConfig: Record<string, unknown>;
    }>;
    buildPromptAsync: (...args: unknown[]) => Promise<string>;
    _ownedRuntimes: Map<string, unknown>;
    _transportTurns: Map<string, AbortController>;
  };
  const handles: { gatewayUrl: string; token: string; dispose: ReturnType<typeof vi.fn> }[] = [];
  const policies = new Map<string, OpenClawPolicyRun>();
  const leases = new Map<string, OpenClawBrokerLease>();
  let connect: ReturnType<typeof vi.spyOn<OpenClawGateway, 'connect'>>;
  let send: ReturnType<typeof vi.spyOn<OpenClawGateway, 'sendAgentMessage'>>;
  let openRun: ReturnType<typeof vi.spyOn<OpenClawPolicyBroker, 'openRun'>>;
  let start: ReturnType<typeof vi.spyOn<typeof OpenClawManagedRuntime, 'start'>>;

  beforeEach(() => {
    clearMockConfig(); handles.length = 0; policies.clear(); leases.clear();
    connect = vi.spyOn(OpenClawGateway.prototype, 'connect').mockResolvedValue(true);
    vi.spyOn(OpenClawGateway.prototype, 'isConnected').mockReturnValue(true);
    vi.spyOn(OpenClawGateway.prototype, 'disconnect').mockImplementation(() => {});
    send = vi.spyOn(OpenClawGateway.prototype, 'sendAgentMessage').mockImplementation(async function* (message) {
      yield { type: 'text', content: message };
    });
    start = vi.spyOn(OpenClawManagedRuntime, 'start').mockImplementation(async () => {
      const handle = { gatewayUrl: `ws://127.0.0.1:${19000 + handles.length}`, token: 'owned-token', dispose: vi.fn(async () => {}) };
      handles.push(handle); return handle;
    });
    vi.spyOn(OpenClawPolicyBroker.prototype, 'listen').mockResolvedValue({ url: 'ws://127.0.0.1:19090', token: 'broker-token', runtimeId: 'runtime' });
    vi.spyOn(OpenClawPolicyBroker.prototype, 'waitUntilReady').mockResolvedValue();
    openRun = vi.spyOn(OpenClawPolicyBroker.prototype, 'openRun').mockImplementation(async (options: OpenClawPolicyRunOptions) => {
      const controller = new AbortController();
      const policy = new OpenClawPolicyRun({ ...options, signal: controller.signal });
      const abort = () => { controller.abort(); policy.dispose(); };
      options.signal.addEventListener('abort', abort, { once: true });
      if (options.signal.aborted) { abort(); }
      const lease: OpenClawBrokerLease = {
        runId: options.runId, sessionKey: options.sessionKey, signal: controller.signal,
        get hasPending() { return policy.hasPending; },
        onPendingChanged: listener => policy.onPendingChanged(listener),
        dispose: () => { options.signal.removeEventListener('abort', abort); abort(); },
      };
      policies.set(options.runId, policy); leases.set(options.runId, lease);
      return lease;
    });
    provider = new TestableOpenClawProvider(); internal = provider as unknown as typeof internal;
    vi.spyOn(internal, '_readOwnedRuntimeConfig').mockResolvedValue({ cliPath: '/fixture/openclaw/openclaw.mjs',
      installedRoot: '/fixture/openclaw', workspaceDir: '/fixture/workspace', fingerprint: 'first',
      baseConfig: { agents: { defaults: { model: 'anthropic/fixture-model' } } },
    });
    vi.spyOn(internal, 'buildPromptAsync').mockImplementation(async content => String(content));
  });
  afterEach(() => { provider.dispose(); vi.restoreAllMocks(); clearMockConfig(); });

  const message = (text = 'hello', panel = 'a', authority = settings, history: Conversation | null = null, attachments?: Attachment[]) =>
    provider.sendMessage(text, [], authority, history, undefined, panel, undefined, undefined, attachments);

  it.each([false, true])('creates the native lease before submission with openclawUseGateway=%s', async useGateway => {
    setMockConfig('openclawUseGateway', useGateway);
    await provider.initialize();
    expect(connect.mock.contexts.includes(internal._gateway)).toBe(useGateway);
    const chunks = await collect(message());
    const options = send.mock.calls[0][1]!;
    expect(send.mock.contexts[0]).not.toBe(internal._gateway);
    expect(options.runId).toMatch(/^mysti-/);
    expect(options.sessionKey).toMatch(/^agent:main:mysti-/);
    expect(openRun.mock.calls[0][0]).toMatchObject({ runId: options.runId, sessionKey: options.sessionKey, panelId: 'a', settings });
    expect(openRun.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
    expect(start.mock.calls[0][0]).toMatchObject({
      baseConfig: { agents: { defaults: { model: 'anthropic/fixture-model' } } },
      pluginPath: path.resolve('/mock/extension/resources/openclaw-policy'),
      preloadPath: path.resolve('/mock/extension/resources/openclaw-policy/runtime-preload.mjs'),
    });
    expect(chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1);
  });

  it('publishes terminal done only after its lease and turn ownership are released', async () => {
    for await (const chunk of message()) {
      if (chunk.type !== 'done') { continue; }
      expect([...leases.values()][0].signal.aborted).toBe(true);
      expect(internal._transportTurns.size).toBe(0);
    }
  });

  it('Stop wakes pending startup and cleans a handle that arrives after cancellation', async () => {
    const ready = deferred<Awaited<ReturnType<typeof OpenClawManagedRuntime.start>>>();
    start.mockReturnValue(ready.promise);
    const pending = collect(message());
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    provider.cancelCurrentRequest('a');
    expect(await pending).toEqual([]);
    expect(start.mock.calls[0][0].signal?.aborted).toBe(true);
    const dispose = vi.fn(async () => {});
    ready.resolve({ gatewayUrl: 'ws://127.0.0.1:1', token: 'late', dispose });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(send).not.toHaveBeenCalled();
  });

  it('iterator return wakes setup even when next is still pending', async () => {
    const config = deferred<Awaited<ReturnType<typeof internal._readOwnedRuntimeConfig>>>();
    vi.mocked(internal._readOwnedRuntimeConfig).mockReturnValue(config.promise);
    const stream = message(); const pending = stream.next();
    const returned = stream.return(undefined);
    expect((await pending).done).toBe(true);
    expect((await returned).done).toBe(true);
    config.resolve({ cliPath: '/late', installedRoot: '/', workspaceDir: '/', baseConfig: {}, fingerprint: 'late' });
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();
  });

  it('a late failed startup cannot retire its replacement runtime', async () => {
    const ready = deferred<Awaited<ReturnType<typeof OpenClawManagedRuntime.start>>>();
    start.mockReturnValueOnce(ready.promise);
    const old = collect(message('old'));
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    const next = await collect(message('new'));
    expect(await old).toEqual([]);
    expect(next).toContainEqual({ type: 'text', content: 'new' });
    const dispose = vi.fn(async () => {});
    ready.resolve({ gatewayUrl: 'ws://127.0.0.1:1', token: 'late', dispose });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(handles[0].dispose).not.toHaveBeenCalled();
    expect(internal._ownedRuntimes.size).toBe(1);
  });

  it('Stop during prompt preparation prevents a late lease and submission', async () => {
    const prompt = deferred<string>();
    vi.mocked(internal.buildPromptAsync).mockReturnValue(prompt.promise);
    const pending = collect(message());
    await vi.waitFor(() => expect(internal.buildPromptAsync).toHaveBeenCalledOnce());
    provider.cancelCurrentRequest('a');
    expect(await pending).toEqual([]);
    prompt.resolve('late'); await Promise.resolve();
    expect(openRun).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });

  it('Stop after the session indicator revokes the lease before submission', async () => {
    const stream = message();
    expect((await stream.next()).value?.type).toBe('session_active');
    provider.cancelCurrentRequest('a');
    expect(await collect(stream)).toEqual([]);
    expect([...leases.values()][0].signal.aborted).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('stopping one panel leaves another runtime and signal untouched', async () => {
    const options = new Map<string, GatewayAgentOptions>();
    send.mockImplementation(async function* (text, supplied = {}) {
      options.set(text, supplied); yield { type: 'text', content: text };
      await untilAbort(supplied.signal!); yield { type: 'text', content: 'late output' };
    });
    const a = collect(message('a', 'a')); const b = collect(message('b', 'b'));
    await vi.waitFor(() => expect(options.size).toBe(2));
    expect(options.get('a')?.sessionKey).not.toBe(options.get('b')?.sessionKey);
    expect(send.mock.contexts[0]).not.toBe(send.mock.contexts[1]);
    provider.cancelCurrentRequest('a');
    expect((await a).some(chunk => chunk.content === 'late output')).toBe(false);
    expect(options.get('b')?.signal?.aborted).toBe(false);
    expect(handles[1].dispose).not.toHaveBeenCalled();
    provider.cancelCurrentRequest('b'); await b;
  });

  it('late stream cleanup errors cannot abort a replacement on the cached runtime', async () => {
    const options = new Map<string, GatewayAgentOptions>();
    send.mockImplementation(async function* (text, supplied = {}) {
      options.set(text, supplied); await untilAbort(supplied.signal!);
      if (text === 'old') { throw new Error('late transport cleanup'); }
      yield { type: 'text', content: 'cancelled late output' };
    });
    const old = collect(message('old'));
    await vi.waitFor(() => expect(options.has('old')).toBe(true));
    const next = collect(message('new'));
    await vi.waitFor(() => expect(options.has('new')).toBe(true));
    await old;
    expect(options.get('new')?.signal?.aborted).toBe(false);
    expect(handles[0].dispose).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledOnce();
    provider.cancelCurrentRequest('a'); await next;
  });

  it('forwards detached attachments as RPC content and emits one terminal done', async () => {
    const attachments: Attachment[] = [{ id: 'a', type: 'file', fileName: 'example.txt', mimeType: 'text/plain', size: 5, base64Data: 'aGVsbG8=' }];
    const stream = message('read it', 'a', settings, null, attachments);
    attachments[0].base64Data = 'changed';
    const chunks = await collect(stream);
    expect(send.mock.calls[0][1]?.attachments).toEqual([{ type: 'file', mimeType: 'text/plain', fileName: 'example.txt', content: 'aGVsbG8=' }]);
    expect(chunks.filter(chunk => chunk.type === 'done')).toHaveLength(1);
  });

  it.each(['runtime', 'connection', 'policy'] as const)('fails closed on %s setup errors', async failure => {
    if (failure === 'runtime') { start.mockRejectedValue(new Error('Unsupported OpenClaw version')); }
    if (failure === 'connection') { connect.mockResolvedValue(false); }
    if (failure === 'policy') { openRun.mockRejectedValue(new Error('Native policy unavailable')); }
    const cli = vi.spyOn(provider, 'buildCliArgs');
    const chunks = await collect(message());
    expect(chunks.map(chunk => chunk.type)).toEqual(['error', 'done']);
    expect(send).not.toHaveBeenCalled(); expect(cli).not.toHaveBeenCalled();
    expect(internal._ownedRuntimes.size).toBe(0);
  });

  it('reinjects history until acceptance and preserves accepted native continuity', async () => {
    const history = { messages: [{ role: 'user', content: 'earlier' }] } as Conversation;
    const stream = message('cancelled', 'a', settings, history);
    expect((await stream.next()).value?.type).toBe('session_active');
    await stream.return(undefined);
    expect(provider.getSessionId('a')).toBeNull();
    send.mockImplementation(async function* (_text, options = {}) {
      options.onAccepted?.(options.sessionKey!); yield { type: 'text', content: 'answer' };
    });
    await collect(message('first', 'a', settings, history));
    await collect(message('second', 'a', settings, history));
    const prompts = vi.mocked(internal.buildPromptAsync).mock.calls;
    expect(prompts[0][2]).toBe(history); expect(prompts[1][2]).toBe(history); expect(prompts[2][2]).toBeNull();
    expect(send.mock.calls[0][1]?.sessionKey).toBe(send.mock.calls[1][1]?.sessionKey);
    expect(send.mock.calls[0][1]?.runId).not.toBe(send.mock.calls[1][1]?.runId);
    expect(start).toHaveBeenCalledOnce();
  });

  it('config changes recreate owned state and reinject host history', async () => {
    const history = { messages: [{ role: 'user', content: 'earlier' }] } as Conversation;
    send.mockImplementation(async function* (_text, options = {}) { options.onAccepted?.(options.sessionKey!); yield { type: 'text', content: 'answer' }; });
    await collect(message('first', 'a', settings, history));
    const config = await internal._readOwnedRuntimeConfig(new AbortController().signal);
    vi.mocked(internal._readOwnedRuntimeConfig).mockResolvedValue({ ...config, fingerprint: 'changed-model' });
    await collect(message('second', 'a', settings, history));
    expect(start).toHaveBeenCalledTimes(2); expect(handles[0].dispose).toHaveBeenCalledOnce();
    expect(vi.mocked(internal.buildPromptAsync).mock.calls[1][2]).toBe(history);
    expect(send.mock.calls[0][1]?.sessionKey).not.toBe(send.mock.calls[1][1]?.sessionKey);
  });

  it('clearing a panel rotates only its private session and disposes its runtime', async () => {
    await collect(message('a', 'a')); await collect(message('b', 'b'));
    const oldA = send.mock.calls[0][1]?.sessionKey; const oldB = send.mock.calls[1][1]?.sessionKey;
    provider.clearSession('a');
    expect(handles[0].dispose).toHaveBeenCalledOnce(); expect(handles[1].dispose).not.toHaveBeenCalled();
    await collect(message('a2', 'a')); await collect(message('b2', 'b'));
    expect(send.mock.calls[2][1]?.sessionKey).not.toBe(oldA); expect(send.mock.calls[3][1]?.sessionKey).toBe(oldB);
  });

  it('rejects empty attachments before opening a lease', async () => {
    const chunks = await collect(message('read', 'a', settings, null, [{ id: 'empty', type: 'file', fileName: 'empty.txt', mimeType: 'text/plain', size: 0, base64Data: '' }]));
    expect(chunks.map(chunk => chunk.type)).toEqual(['error', 'done']);
    expect(chunks[0].content).toContain('does not accept empty attachments');
    expect(openRun).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });

  it('Stop wakes native lease registration and cannot submit after a late acknowledgement', async () => {
    const acknowledgement = deferred<void>();
    const register = openRun.getMockImplementation()!;
    openRun.mockImplementationOnce(async options => {
      const lease = await register(options);
      await acknowledgement.promise;
      return lease;
    });
    const pending = collect(message());
    await vi.waitFor(() => expect(leases.size).toBe(1));
    provider.cancelCurrentRequest('a');
    expect(await pending).toEqual([]);
    expect([...leases.values()][0].signal.aborted).toBe(true);
    acknowledgement.resolve(); await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
  });

  it('broker revocation wakes the stream, reports failure and retires the private runtime', async () => {
    send.mockImplementation(async function* (_text, options = {}) {
      yield { type: 'text', content: 'started' }; await untilAbort(options.signal!);
    });
    const pending = collect(message());
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    [...leases.values()][0].dispose();
    const chunks = await pending;
    expect(chunks.map(chunk => chunk.type)).toEqual(['session_active', 'text', 'error', 'done']);
    expect(chunks[2].content).toContain('connection was revoked');
    expect(handles[0].dispose).toHaveBeenCalledOnce();
    expect(internal._ownedRuntimes.size).toBe(0);
  });

  it('an old acceptance callback cannot mark the replacement conversation resumed', async () => {
    const options = new Map<string, GatewayAgentOptions>();
    send.mockImplementation(async function* (text, supplied = {}) {
      options.set(text, supplied); yield { type: 'text', content: text }; await untilAbort(supplied.signal!);
    });
    const old = collect(message('old'));
    await vi.waitFor(() => expect(options.has('old')).toBe(true));
    const next = collect(message('next'));
    await vi.waitFor(() => expect(options.has('next')).toBe(true));
    options.get('old')!.onAccepted?.(options.get('old')!.sessionKey!);
    expect(provider.getSessionId('a')).toBeNull();
    options.get('next')!.onAccepted?.('wrong-session');
    expect(provider.getSessionId('a')).toBeNull();
    options.get('next')!.onAccepted?.(options.get('next')!.sessionKey!);
    expect(provider.getSessionId('a')).toBe(options.get('next')!.sessionKey);
    provider.cancelCurrentRequest('a'); await old; await next;
  });

  it('captures the original handler once and freezes authority across asynchronous setup', async () => {
    const configured = { ...settings }; const handler: NativeApprovalHandler = vi.fn(async () => false);
    const replacement: NativeApprovalHandler = vi.fn(async () => true);
    const host = { handlerForPanel: vi.fn(() => handler) }; provider.setNativeApprovalHost(host);
    const setup = deferred<Awaited<ReturnType<typeof internal._readOwnedRuntimeConfig>>>();
    const config = await internal._readOwnedRuntimeConfig(new AbortController().signal);
    vi.mocked(internal._readOwnedRuntimeConfig).mockReturnValue(setup.promise);
    const pending = collect(message('hello', 'a', configured));
    await vi.waitFor(() => expect(host.handlerForPanel).toHaveBeenCalledOnce());
    provider.setNativeApprovalHost({ handlerForPanel: () => replacement }); configured.accessLevel = 'full-access';
    setup.resolve(config); await pending;
    expect(openRun.mock.calls[0][0].handler).toBe(handler);
    expect(openRun.mock.calls[0][0].settings.accessLevel).toBe('ask-permission');
    expect(host.handlerForPanel).toHaveBeenCalledOnce();
  });

  it('passes approval pending state into the gateway and cancels late decisions on Stop', async () => {
    const decision = deferred<boolean>();
    const handler: NativeApprovalHandler = vi.fn(() => decision.promise);
    provider.setNativeApprovalHost({ handlerForPanel: () => handler });
    let outcome: { decision: string } | undefined;
    let pendingChanges = 0;
    send.mockImplementation(async function* (_text, options = {}) {
      const unsubscribe = options.onPendingChanged!(() => { pendingChanges++; });
      const pending = policies.get(options.runId!)!.request({ requestId: 'approval', runId: options.runId,
        sessionKey: options.sessionKey, toolCallId: 'tool', toolName: 'write', params: { path: 'file', content: 'text' } });
      expect(options.hasPending!()).toBe(true);
      outcome = await pending; unsubscribe();
      yield { type: 'text', content: outcome.decision };
    });
    const pending = collect(message());
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    provider.cancelCurrentRequest('a'); decision.resolve(true);
    const chunks = await pending;
    expect(outcome?.decision).toBe('cancelled'); expect(pendingChanges).toBe(2);
    expect(chunks.some(chunk => chunk.type === 'text')).toBe(false);
  });

  it('prompt enhancement uses an ephemeral read-only lease and retires its runtime', async () => {
    send.mockImplementation(async function* () { yield { type: 'text', content: ' enhanced ' }; });
    expect(await provider.enhancePrompt('original')).toBe('enhanced');
    expect(openRun.mock.calls[0][0]).toMatchObject({ settings: { mode: 'quick-plan', accessLevel: 'read-only' } });
    expect(send.mock.contexts[0]).not.toBe(internal._gateway);
    expect(handles[0].dispose).toHaveBeenCalledOnce(); expect(internal._ownedRuntimes.size).toBe(0);
  });

  it('prompt enhancement reports incompatible runtime without a fallback agent', async () => {
    start.mockRejectedValue(new Error('Unsupported OpenClaw version'));
    await expect(provider.enhancePrompt('original')).rejects.toThrow('Unsupported OpenClaw version');
    expect(send).not.toHaveBeenCalled();
  });
});
