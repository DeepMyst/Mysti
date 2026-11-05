import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { SetupManager } from '../../src/managers/SetupManager';
import { ProviderManager } from '../../src/managers/ProviderManager';
import { CliDiscoveryService } from '../../src/services/CliDiscoveryService';
import { clearConfigurationListeners } from '../helpers/mockVscode';
import type { AuthStatus, StreamChunk } from '../../src/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function provider(id: string) {
  return {
    id, displayName: id, capabilities: { supportsAutoInstall: false },
    discoverCli: vi.fn(async () => ({ found: true, path: `/fixture/${id}` })),
    checkAuthentication: vi.fn<() => Promise<AuthStatus>>(async () => ({ authenticated: true })),
    getAuthCommand: () => `${id} login`, getInstallCommand: () => '',
  };
}

const disposables: Array<{ dispose(): void }> = [];
function harness(providers = [provider('openai-codex'), provider('claude-code')], cached = false) {
  const byId = new Map(providers.map(item => [item.id, item]));
  const ready = new vscode.EventEmitter<string>(); disposables.push(ready);
  const source = {
    getAllProviders: () => providers, getProviderInstance: (id: string) => byId.get(id),
    whenReady: new Promise<void>(() => {}), onProviderReady: ready.event,
  };
  const discovery = cached ? new CliDiscoveryService(source as any) : undefined;
  if (discovery) { disposables.push(discovery); }
  const manager = new SetupManager({ subscriptions: [], globalState: { get: () => undefined } } as any,
    source as any, discovery);
  return { manager, providers, discovery };
}

afterEach(() => {
  disposables.splice(0).forEach(item => item.dispose());
  clearConfigurationListeners(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
});

describe('PC-03 setup authentication recovery', () => {
  it.each(['discovery', 'authentication'] as const)('retains healthy siblings when one %s probe throws', async stage => {
    const h = harness();
    const broken = stage === 'discovery' ? h.providers[0].discoverCli : h.providers[0].checkAuthentication;
    broken.mockRejectedValue(new Error('Authentication service unavailable. Sign in again.'));
    const statuses = await h.manager.getSetupStatus();
    expect(statuses).toEqual([
      expect.objectContaining({ providerId: 'openai-codex', installed: stage === 'authentication', authenticated: false, error: expect.stringContaining('Sign in again') }),
      expect.objectContaining({ providerId: 'claude-code', installed: true, authenticated: true }),
    ]);
    expect(await h.manager.checkReady()).toBe(true);
  });

  it('bounds a stalled auth probe and ignores its late rejection while a healthy sibling remains ready', async () => {
    vi.useFakeTimers(); const h = harness(); const stale = deferred<AuthStatus>();
    h.providers[0].checkAuthentication.mockReturnValueOnce(stale.promise);
    let result: Awaited<ReturnType<SetupManager['getSetupStatus']>> | undefined;
    const pending = h.manager.getSetupStatus().then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(15_001);
    const bounded = result;
    // Always settle the old fixture, including on the red run; rejection must stay observed.
    stale.reject(new Error('Late authentication transport failure'));
    await pending.catch(() => undefined);
    expect(bounded).toEqual([
      expect.objectContaining({ providerId: 'openai-codex', installed: true, authenticated: false, error: expect.stringMatching(/timed out/i) }),
      expect.objectContaining({ providerId: 'claude-code', authenticated: true }),
    ]);
    expect(await h.manager.checkReady()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains an expired provider as installed with actionable login guidance', async () => {
    const h = harness();
    h.providers[0].checkAuthentication.mockResolvedValue({ authenticated: false, error: 'Session expired. Run codex login to sign in again.' });
    expect(await h.manager.getSetupStatus()).toContainEqual(expect.objectContaining({
      providerId: 'openai-codex', installed: true, authenticated: false,
      error: 'Session expired. Run codex login to sign in again.',
    }));
  });

  it.each([
    ['openai-codex', 'OPENAI_API_KEY'], ['google-gemini', 'GEMINI_API_KEY'], ['cursor', 'CURSOR_API_KEY'],
  ])('closes the %s key prompt on Skip and rejects late input without changing credentials', async (id, envKey) => {
    const h = harness([provider(id)]); const controller = new AbortController();
    vi.stubEnv(envKey, 'synthetic-existing');
    const input = deferred<string | undefined>();
    let token: vscode.CancellationToken | undefined;
    vi.spyOn(vscode.window, 'showInputBox').mockImplementation((_options, cancellation) => {
      token = cancellation;
      cancellation?.onCancellationRequested(() => input.resolve(undefined));
      return input.promise;
    });
    let settled = false;
    const run = h.manager.authenticateWithMethod(id, 'api-key', undefined, controller.signal)
      .then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    controller.abort();
    await new Promise<void>(resolve => setImmediate(resolve));
    const settledOnAbort = settled;
    input.resolve('synthetic-late-must-not-be-saved');
    const result = await run;
    expect(token?.isCancellationRequested).toBe(true);
    expect(settledOnAbort).toBe(true);
    expect(result).toMatchObject({ error: { name: 'AbortError' } });
    expect(process.env[envKey]).toBe('synthetic-existing');
    expect(h.providers[0].checkAuthentication).not.toHaveBeenCalled();
  });

  it.each(['success', 'failure', 'rejection', 'cancelled-after-write'] as const)('invalidates provider-owned auth status after %s and keeps sibling cache intact', async outcome => {
    const selected = provider('minimax'); const sibling = provider('claude-code');
    let signedIn = outcome !== 'success';
    selected.checkAuthentication.mockImplementation(async () => ({ authenticated: signedIn }));
    const h = harness([selected, sibling], true);
    await h.discovery!.getAllStatuses();
    const siblingProbes = sibling.checkAuthentication.mock.calls.length;
    const controller = new AbortController();
    Object.assign(selected, { configureAuthentication: vi.fn(async () => {
      // Simulate the adapter committing a replacement credential before validating it.
      signedIn = outcome === 'success';
      if (outcome === 'rejection') { throw new Error('Credential verification unavailable. Retry sign-in.'); }
      if (outcome === 'cancelled-after-write') { controller.abort(); }
      return { authenticated: signedIn, error: signedIn ? undefined : 'Sign in again.' };
    }) });
    await h.manager.authenticateProvider(selected.id, controller.signal).catch(() => undefined);
    expect(await h.discovery!.getStatus(selected.id)).toMatchObject({ authenticated: signedIn });
    expect(await h.discovery!.getStatus(sibling.id)).toMatchObject({ authenticated: true });
    expect(sibling.checkAuthentication).toHaveBeenCalledTimes(siblingProbes);
  });

  it('retries rejected API credentials once per explicit attempt without touching another backend credential', async () => {
    const h = harness([provider('openai-codex')]);
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-rejected'); vi.stubEnv('GEMINI_API_KEY', 'synthetic-sibling');
    h.providers[0].checkAuthentication.mockImplementation(async () => process.env.OPENAI_API_KEY === 'synthetic-accepted'
      ? { authenticated: true } : { authenticated: false, error: 'Authentication rejected. Enter a replacement API key.' });
    for (let attempt = 0; attempt < 20; attempt++) {
      expect(await h.manager.authenticateWithMethod('openai-codex', 'api-key', `synthetic-rejected-${attempt}`))
        .toMatchObject({ authenticated: false, error: expect.stringContaining('replacement') });
    }
    expect(await h.manager.authenticateWithMethod('openai-codex', 'api-key', 'synthetic-accepted')).toEqual({ authenticated: true });
    expect(h.providers[0].checkAuthentication).toHaveBeenCalledTimes(21);
    expect(process.env.GEMINI_API_KEY).toBe('synthetic-sibling');
  });
});

describe('PC-03 provider manager authentication isolation', () => {
  it('preserves healthy sibling and partial output across 20 expired-credential turns, then resumes the requested provider', async () => {
    let authenticated = false;
    const requests: Array<{ id: string; content: string; panel: string; conversation: unknown }> = [];
    const peers = ['openai-codex', 'claude-code'].map(id => ({
      id, cancelCurrentRequest: vi.fn(),
      async *sendMessage(content: string, _context: unknown, _settings: unknown, conversation: unknown, _persona: unknown, panel: string) {
        requests.push({ id, content, panel, conversation });
        yield { type: 'text', content: `${id}:partial` } as StreamChunk;
        if (id === 'openai-codex' && !authenticated) { throw new Error('401: sign in again'); }
        yield { type: 'text', content: `${id}:complete` } as StreamChunk;
        yield { type: 'done' } as StreamChunk;
      },
    }));
    const manager = Object.assign(Object.create(ProviderManager.prototype), {
      _registry: { get: (id: string) => peers.find(item => item.id === id) }, _panelProviders: new Map(),
    }) as ProviderManager;
    const conversation = { id: 'original-task', messages: [{ role: 'user', content: 'Preserve this task constraint' }] };
    async function run(id: string, turn: number) {
      const chunks: StreamChunk[] = [];
      try {
        for await (const chunk of manager.sendMessageToProvider(id, `turn-${turn}`, [], { provider: id } as any, conversation as any, undefined, id)) { chunks.push(chunk); }
        return { chunks };
      } catch (error) { return { chunks, error }; }
    }
    for (let turn = 0; turn < 20; turn++) {
      const [expired, healthy] = await Promise.all([run('openai-codex', turn), run('claude-code', turn)]);
      expect(expired.error).toMatchObject({ message: '401: sign in again' });
      expect(expired.chunks).toEqual([{ type: 'text', content: 'openai-codex:partial' }]);
      expect(healthy.error).toBeUndefined(); expect(healthy.chunks.at(-1)?.type).toBe('done');
    }
    authenticated = true;
    expect((await run('openai-codex', 20)).chunks.at(-1)?.type).toBe('done');
    expect(requests.filter(item => item.id === 'openai-codex')).toHaveLength(21);
    expect(requests.filter(item => item.id === 'claude-code')).toHaveLength(20);
    expect(requests.every(item => item.panel === item.id && item.conversation === conversation)).toBe(true);
    expect(peers.every(item => item.cancelCurrentRequest.mock.calls.length === 0)).toBe(true);
  });
});
