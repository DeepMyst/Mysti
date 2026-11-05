import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { SetupManager } from '../../src/managers/SetupManager';
import { MiniMaxProvider } from '../../src/providers/minimax/MiniMaxProvider';
import { createMockSecretStorage, window } from '../helpers/mockVscode';

/** PC-01 only: first-run setup must not outlive the interaction that owns it.
 * No real CLI, installer, network request, credential, or authentication runs.
 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}

function harness() {
  const providers = new Map(['first', 'second'].map(id => [id, {
    id,
    displayName: id,
    discoverCli: vi.fn(async () => ({ found: true, path: `/fixture/${id}` })),
    checkAuthentication: vi.fn(async () => ({ authenticated: false })),
    getInstallCommand: () => `fixture-install ${id}`,
  }]));
  const setup = {
    autoInstallCli: vi.fn(async () => ({ success: false, error: 'Fixture installation refused' })),
    authenticateProvider: vi.fn(async () => ({ authenticated: false })),
    authenticateWithMethod: vi.fn(async () => ({ authenticated: false })),
    invalidateProviderStatus: vi.fn(),
    getAuthOptions: () => [],
    getWizardStatus: vi.fn(async () => ({ providers: [], anyReady: false })),
    getWizardStatusCached: vi.fn(() => ({ providers: [], anyReady: false, complete: false })),
    refreshWizardStatus: vi.fn(async () => ({ providers: [], anyReady: false })),
    getSetupStatus: vi.fn(async () => []),
  };
  const chat = Object.assign(Object.create(ChatViewProvider.prototype), {
    _providerManager: { getProviderInstance: (id: string) => providers.get(id) },
    _setupManager: setup,
    _panelStates: new Map([['a', {}], ['b', {}]]),
    _authPolls: new Map(),
    _postToPanel: vi.fn(),
    _sendInitialState: vi.fn(async () => {}),
    _handleUpdateSettings: vi.fn(async () => {}),
    _extensionContext: { globalState: { update: vi.fn(async () => {}) } },
  });
  return { chat, providers, setup };
}

beforeEach(() => { vi.useFakeTimers(); });
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) { cleanups.pop()!(); }
  vi.clearAllTimers(); vi.useRealTimers();
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});

/** Real host -> SetupManager -> MiniMax authentication, with only the native
 * prompt and SecretStorage replaced. No actual credentials or requests. */
function miniMaxHarness() {
  vi.stubEnv('MINIMAX_API_KEY', '');
  const secrets = createMockSecretStorage();
  const subscriptions: Array<{ dispose(): unknown }> = [];
  const context = { subscriptions, secrets } as unknown as vscode.ExtensionContext;
  const provider = new MiniMaxProvider(context);
  const manager = { getProviderInstance: (id: string) => id === 'minimax' ? provider : undefined };
  const setup = new SetupManager(context, manager as never);
  const h = harness();
  h.chat._providerManager = manager;
  h.chat._setupManager = setup;
  const auth = vi.spyOn(setup, 'authenticateProvider');
  const configure = vi.spyOn(provider, 'configureAuthentication');
  const install = vi.spyOn(setup, 'autoInstallCli').mockRejectedValue(new Error('Unexpected installation'));
  const fetch = vi.fn(async () => { throw new Error('Unexpected network request'); });
  vi.stubGlobal('fetch', fetch);
  const terminal = vi.fn(() => ({ show: vi.fn(), sendText: vi.fn() }));
  const originalTerminal = Object.getOwnPropertyDescriptor(window, 'createTerminal');
  Object.defineProperty(window, 'createTerminal', { configurable: true, value: terminal });
  cleanups.push(() => {
    h.chat._cancelPanelSetup('a');
    provider.dispose();
    subscriptions.forEach(subscription => subscription.dispose());
    if (originalTerminal) { Object.defineProperty(window, 'createTerminal', originalTerminal); }
    else { delete (window as unknown as Record<string, unknown>).createTerminal; }
  });
  return { ...h, setup, provider, secrets, auth, configure, install, fetch, terminal };
}

describe('PC-01 native API authentication completion', () => {
  it('routes MiniMax Sign In to its native key prompt and finishes Escape without polling', async () => {
    const h = miniMaxHarness();
    const prompt = vi.spyOn(window, 'showInputBox').mockImplementation(async () => {
      const signal = h.auth.mock.calls[0][1];
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal!.aborted).toBe(false);
      return undefined; // Native password input Escape.
    });
    const store = vi.spyOn(h.secrets, 'store');
    await h.chat._handleStartProviderSetup({ providerId: 'minimax', autoInstall: false }, 'a');
    expect(h.chat._postToPanel).toHaveBeenCalledWith('a', expect.objectContaining({
      type: 'authPrompt', payload: expect.objectContaining({ providerId: 'minimax' }),
    }));
    expect(h.chat._postToPanel).not.toHaveBeenCalledWith('a', expect.objectContaining({ type: 'authOptions' }));

    await h.chat._handleAuthConfirm('minimax', 'a');

    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ title: 'MiniMax API key', password: true }), expect.anything());
    expect(h.configure).toHaveBeenCalledWith(h.auth.mock.calls[0][1]);
    expect(h.install).not.toHaveBeenCalled();
    expect(h.terminal).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    expect(h.chat._postToPanel).toHaveBeenCalledWith('a', expect.objectContaining({
      type: 'setupFailed', payload: { providerId: 'minimax', error: 'Authentication cancelled.', canRetry: true },
    }));
    expect(h.chat._postToPanel).toHaveBeenCalledWith('a', expect.objectContaining({
      type: 'providerSetupStep', payload: expect.objectContaining({ providerId: 'minimax', step: 'failed', retryable: true }),
    }));
    expect(h.chat._authPolls.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('finishes successful native key configuration immediately without claiming remote validation', async () => {
    const h = miniMaxHarness();
    const syntheticKey = 'pc01-synthetic-key-never-sent';
    vi.spyOn(window, 'showInputBox').mockResolvedValue(syntheticKey);
    await h.chat._handleAuthConfirm('minimax', 'a');

    expect(await h.secrets.get('mysti.minimax.apiKey')).toBe(syntheticKey);
    expect(h.chat._postToPanel).toHaveBeenCalledWith('a', { type: 'setupComplete', payload: { providerId: 'minimax' } });
    expect(h.chat._postToPanel).toHaveBeenCalledWith('a', expect.objectContaining({
      type: 'providerSetupStep', payload: expect.objectContaining({
        providerId: 'minimax', step: 'complete', details: 'API key configured (validated when used)',
      }),
    }));
    expect(JSON.stringify(h.chat._postToPanel.mock.calls)).not.toContain(syntheticKey);
    expect(h.chat._authPolls.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.terminal).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('reports a completed provider-owned authentication failure without starting a login poll', async () => {
    const h = harness();
    Object.assign(h.providers.get('first')!, { configureAuthentication: vi.fn() });
    h.setup.authenticateProvider.mockResolvedValue({ authenticated: false, error: 'Server rejected authentication.' } as never);
    await h.chat._handleAuthConfirm('first', 'a');

    expect(h.chat._postToPanel).toHaveBeenCalledWith('a', expect.objectContaining({
      type: 'setupFailed', payload: { providerId: 'first', error: 'Server rejected authentication.', canRetry: true },
    }));
    expect(h.providers.get('first')!.checkAuthentication).not.toHaveBeenCalled();
    expect(h.chat._authPolls.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('continues polling an external CLI login until out-of-band authentication completes', async () => {
    const h = harness();
    h.setup.authenticateProvider.mockResolvedValue({ authenticated: false, error: 'Please complete authentication in the terminal window' } as never);
    await h.chat._handleAuthConfirm('first', 'a');
    expect(h.chat._authPolls.get('a')?.providerId).toBe('first');
    expect(h.chat._postToPanel).not.toHaveBeenCalledWith('a', expect.objectContaining({ type: 'setupFailed' }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.providers.get('first')!.checkAuthentication).toHaveBeenCalledTimes(1);
    h.providers.get('first')!.checkAuthentication.mockResolvedValue({ authenticated: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.chat._postToPanel).toHaveBeenCalledWith('a', { type: 'setupComplete', payload: { providerId: 'first', requiresVerification: true } });
    expect(h.chat._authPolls.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('PC-01 first-run setup fault ownership', () => {
  it('does not start an installation when the originating panel closed during discovery', async () => {
    const h = harness();
    const discovery = deferred<{ found: boolean; path: string }>();
    h.providers.get('first')!.discoverCli.mockReturnValue(discovery.promise);
    const pending = h.chat._handleStartProviderSetup({ providerId: 'first' }, 'a');

    // Reproduce the actual panel-dispose setup cleanup without unrelated UI.
    h.chat._panelStates.delete('a');
    h.chat._cancelPanelSetup('a');
    discovery.resolve({ found: false, path: '' });
    await pending;

    expect(h.setup.autoInstallCli).not.toHaveBeenCalled();
    expect(h.providers.get('first')!.checkAuthentication).not.toHaveBeenCalled();
  });

  it('does not start an installation after Skip while discovery was pending', async () => {
    const h = harness();
    const discovery = deferred<{ found: boolean; path: string }>();
    h.providers.get('first')!.discoverCli.mockReturnValue(discovery.promise);
    const pending = h.chat._handleStartProviderSetup({ providerId: 'first' }, 'a');

    h.chat._handleSkipSetup('a');
    discovery.resolve({ found: false, path: '' });
    await pending;

    expect(h.chat._sendInitialState).toHaveBeenCalledWith('a');
    expect(h.setup.autoInstallCli).not.toHaveBeenCalled();
  });

  it('a newer setup choice prevents the previous discovery from launching an installer', async () => {
    const h = harness();
    const discovery = deferred<{ found: boolean; path: string }>();
    h.providers.get('first')!.discoverCli.mockReturnValue(discovery.promise);
    const first = h.chat._handleStartProviderSetup({ providerId: 'first' }, 'a');
    await h.chat._handleStartProviderSetup({ providerId: 'second' }, 'a');
    h.chat._postToPanel.mockClear();

    discovery.resolve({ found: false, path: '' });
    await first;

    expect(h.setup.autoInstallCli).not.toHaveBeenCalled();
    expect(h.chat._postToPanel).not.toHaveBeenCalled();
  });

  it('Skip during an auth launch prevents its late result from restarting polling', async () => {
    const h = harness();
    const launch = deferred<{ authenticated: boolean }>();
    h.setup.authenticateWithMethod.mockReturnValue(launch.promise);
    const pending = h.chat._handleSelectAuthMethod({ providerId: 'first', method: 'oauth' }, 'a');

    h.chat._handleSkipSetup('a');
    launch.resolve({ authenticated: false });
    await pending;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(h.providers.get('first')!.checkAuthentication).not.toHaveBeenCalled();
    expect(h.chat._authPolls.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closing the originating panel during auth launch leaves no new polling worker', async () => {
    const h = harness();
    const launch = deferred<{ authenticated: boolean }>();
    h.setup.authenticateWithMethod.mockReturnValue(launch.promise);
    const pending = h.chat._handleSelectAuthMethod({ providerId: 'first', method: 'cli-login' }, 'a');

    h.chat._panelStates.delete('a');
    h.chat._cancelPanelSetup('a');
    launch.resolve({ authenticated: false });
    await pending;

    expect(h.chat._authPolls.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an old auth launch cannot replace polling for the newly selected provider', async () => {
    const h = harness();
    const launch = deferred<{ authenticated: boolean }>();
    h.setup.authenticateWithMethod.mockReturnValueOnce(launch.promise);
    const first = h.chat._handleSelectAuthMethod({ providerId: 'first', method: 'oauth' }, 'a');
    await h.chat._handleSelectAuthMethod({ providerId: 'second', method: 'oauth' }, 'a');

    launch.resolve({ authenticated: false });
    await first;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(h.providers.get('first')!.checkAuthentication).not.toHaveBeenCalled();
    expect(h.providers.get('second')!.checkAuthentication).toHaveBeenCalledTimes(1);
    expect(h.chat._authPolls.get('a')?.providerId).toBe('second');
  });

  it('bounds the whole authentication wait even when a single probe never resolves', async () => {
    const h = harness();
    const probe = deferred<{ authenticated: boolean }>();
    h.providers.get('first')!.checkAuthentication.mockReturnValue(probe.promise);
    h.chat._pollAuthStatus('first', 'a');
    try {
      // Existing sign-in policy is 60 x 2-second attempts. A hung probe must
      // not escape that wall-clock budget by preventing the attempt counter.
      await vi.advanceTimersByTimeAsync(125_000);
      expect(h.chat._postToPanel).toHaveBeenCalledWith('a', expect.objectContaining({
        type: 'setupFailed',
        payload: expect.objectContaining({ providerId: 'first', canRetry: true, error: expect.stringMatching(/timed out|timeout/i) }),
      }));
      expect(h.chat._authPolls.size).toBe(0);
    } finally {
      h.chat._stopAuthPolling('a');
      probe.resolve({ authenticated: false });
      await Promise.resolve();
    }
  });

  it('a stalled first-run discovery leaves checking with a recoverable result', async () => {
    const h = harness();
    const discovery = deferred<{ found: boolean; path: string }>();
    h.providers.get('first')!.discoverCli.mockReturnValue(discovery.promise);
    let settled = false;
    const pending = h.chat._handleStartProviderSetup({ providerId: 'first', autoInstall: false }, 'a')
      .then(() => { settled = true; });
    try {
      // A generous upper bound: the user must not stay in Checking forever.
      // Any bounded product deadline below this limit satisfies the contract.
      await vi.advanceTimersByTimeAsync(125_000);
      expect(h.chat._postToPanel).toHaveBeenCalledWith('a', expect.objectContaining({
        type: 'setupFailed',
        payload: expect.objectContaining({ providerId: 'first', canRetry: true }),
      }));
      expect(settled).toBe(true);
      expect(h.setup.autoInstallCli).not.toHaveBeenCalled();
    } finally {
      discovery.resolve({ found: false, path: '' });
      await pending;
    }
  });

  it('skipping one panel does not cancel the other panel sign-in', async () => {
    const h = harness();
    h.providers.get('second')!.checkAuthentication.mockResolvedValue({ authenticated: true });
    h.chat._pollAuthStatus('first', 'a');
    h.chat._pollAuthStatus('second', 'b');
    h.chat._handleSkipSetup('a');
    await vi.advanceTimersByTimeAsync(2_000);

    expect(h.providers.get('first')!.checkAuthentication).not.toHaveBeenCalled();
    expect(h.chat._postToPanel).toHaveBeenCalledWith('b', expect.objectContaining({ type: 'setupComplete', payload: { providerId: 'second', requiresVerification: true } }));
    expect(h.chat._authPolls.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Skip during authentication discovery prevents a later browser or terminal launch', async () => {
    const h = harness();
    const discovery = deferred<{ found: boolean; path: string }>();
    h.providers.get('first')!.discoverCli.mockReturnValue(discovery.promise);
    const pending = h.chat._handleAuthConfirm('first', 'a');
    h.chat._handleSkipSetup('a');
    discovery.resolve({ found: true, path: '/fixture/first' });
    await pending;

    expect(h.setup.authenticateProvider).not.toHaveBeenCalled();
    expect(h.chat._authPolls.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('wizard dismissal aborts the pending auth method and suppresses its late success', async () => {
    const h = harness();
    const launch = deferred<{ authenticated: boolean }>();
    h.setup.authenticateWithMethod.mockReturnValue(launch.promise);
    const pending = h.chat._handleSelectAuthMethod({ providerId: 'first', method: 'api-key' }, 'a');
    const signal = (h.setup.authenticateWithMethod.mock.calls[0] as unknown as unknown[])[3] as AbortSignal;
    await h.chat._handleDismissWizard('a');
    h.chat._postToPanel.mockClear();
    launch.resolve({ authenticated: true });
    await pending;

    expect(signal.aborted).toBe(true);
    expect(h.setup.invalidateProviderStatus).not.toHaveBeenCalled();
    expect(h.chat._postToPanel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('late rejected authentication cannot fail the replacement provider choice', async () => {
    const h = harness();
    const launch = deferred<{ authenticated: boolean }>();
    h.setup.authenticateWithMethod.mockReturnValueOnce(launch.promise);
    const first = h.chat._handleSelectAuthMethod({ providerId: 'first', method: 'oauth' }, 'a');
    await h.chat._handleSelectAuthMethod({ providerId: 'second', method: 'oauth' }, 'a');
    h.chat._postToPanel.mockClear();
    launch.reject(new Error('The old terminal failed late'));
    await first;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(h.chat._postToPanel).not.toHaveBeenCalled();
    expect(h.providers.get('second')!.checkAuthentication).toHaveBeenCalledTimes(1);
    expect(h.chat._authPolls.get('a')?.providerId).toBe('second');
  });

  it('Get Started opens with cached status when discovery remains stalled', async () => {
    const h = harness();
    const status = deferred<{ providers: never[]; anyReady: boolean }>();
    h.setup.getWizardStatus.mockReturnValue(status.promise);
    const pending = h.chat._postOnboarding('a', 'connect');
    await vi.advanceTimersByTimeAsync(6_000);
    await pending;

    expect(h.setup.getWizardStatusCached).toHaveBeenCalledTimes(1);
    expect(h.chat._postToPanel).toHaveBeenCalledWith('a', expect.objectContaining({
      type: 'showWizard', payload: expect.objectContaining({ step: 'connect', complete: false }),
    }));
    expect(vi.getTimerCount()).toBe(0);
    status.resolve({ providers: [], anyReady: false });
  });

  it('late Get Started discovery cannot reopen a wizard after Skip', async () => {
    const h = harness();
    const status = deferred<{ providers: never[]; anyReady: boolean }>();
    h.setup.getWizardStatus.mockReturnValue(status.promise);
    const pending = h.chat._postOnboarding('a', 'connect');
    h.chat._handleSkipSetup('a');
    status.resolve({ providers: [], anyReady: false });
    await pending;

    expect(h.chat._postToPanel).not.toHaveBeenCalled();
    expect(h.setup.getWizardStatusCached).not.toHaveBeenCalled();
  });

  it('reading wizard status preserves the current sign-in polling worker', async () => {
    const h = harness();
    h.chat._pollAuthStatus('first', 'a');
    await h.chat._handleRequestWizardStatus('a');
    await vi.advanceTimersByTimeAsync(2_000);

    expect(h.providers.get('first')!.checkAuthentication).toHaveBeenCalledTimes(1);
    expect(h.chat._authPolls.get('a')?.providerId).toBe('first');
    expect(h.chat._postToPanel).toHaveBeenCalledWith('a', expect.objectContaining({ type: 'wizardStatus' }));
  });

  it('a stalled wizard refresh re-enables recovery with a timeout result', async () => {
    const h = harness();
    const status = deferred<{ providers: never[]; anyReady: boolean }>();
    h.setup.refreshWizardStatus.mockReturnValue(status.promise);
    const pending = h.chat._handleRefreshProviderDetection('a');
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;

    expect(h.chat._postToPanel).toHaveBeenCalledWith('a', expect.objectContaining({
      type: 'providerDetectionComplete', payload: { error: expect.stringMatching(/timed out/i) },
    }));
    expect(vi.getTimerCount()).toBe(0);
    status.resolve({ providers: [], anyReady: false });
  });
});
