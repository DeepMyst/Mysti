import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { SetupManager } from '../../src/managers/SetupManager';

vi.mock('vscode', async () => {
  const actual = await vi.importActual<typeof import('vscode')>('vscode');
  return { ...actual, window: { ...actual.window,
    createTerminal: vi.fn(() => ({ show: vi.fn(), sendText: vi.fn() })),
  } };
});

function harness(providerOwned = false) {
  const provider = {
    id: 'openai-codex', displayName: 'OpenAI Codex', getAuthCommand: () => 'codex login',
    discoverCli: vi.fn(async () => ({ found: true, path: '/fixture/codex' })),
    // This models the existing local-key path: unchanged, server-rejected
    // credentials remain present while the newly opened login is unfinished.
    checkAuthentication: vi.fn(async () => ({ authenticated: true, user: 'API Key' })),
    ...(providerOwned ? { configureAuthentication: vi.fn(async () => ({ authenticated: true, user: 'Validated account' })) } : {}),
    sendMessage: vi.fn(),
  };
  const providerManager = { getProviderInstance: () => provider, sendMessage: vi.fn() };
  const setup = new SetupManager({ subscriptions: [], globalState: { get: () => undefined } } as any, providerManager as any);
  const chat = Object.assign(Object.create(ChatViewProvider.prototype), {
    _providerManager: providerManager, _setupManager: setup,
    _panelStates: new Map([['a', {}], ['healthy-sibling', {}]]), _authPolls: new Map(),
    _postToPanel: vi.fn(), _sendInitialState: vi.fn(),
    _channelBridge: { drainQueuedMessages: vi.fn() }, _handleSendMessage: vi.fn(),
  });
  return { chat, provider, providerManager };
}

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers(); });

describe('PC-03 terminal login verification boundary', () => {
  it('labels unchanged local credentials as unverified after login launch and never sends pending work automatically', async () => {
    vi.useFakeTimers(); const h = harness();
    const terminal = vi.spyOn(vscode.window, 'createTerminal');
    await h.chat._handleAuthConfirm('openai-codex', 'a');
    expect(terminal).toHaveBeenCalledOnce();
    expect(terminal.mock.results[0].value.sendText).toHaveBeenCalledWith(expect.stringContaining('codex'));
    expect(h.chat._postToPanel.mock.calls.some(([, message]: any[]) => message.type === 'setupComplete')).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.chat._postToPanel).toHaveBeenCalledWith('a', {
      type: 'setupComplete', payload: { providerId: 'openai-codex', requiresVerification: true },
    });
    expect(h.chat._postToPanel).toHaveBeenCalledWith('a', {
      type: 'providerSetupStep', payload: { providerId: 'openai-codex', step: 'complete', progress: 100,
        message: 'Credentials detected. Retry your request to verify sign-in.' },
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.provider.checkAuthentication).toHaveBeenCalledOnce();
    expect(h.chat._handleSendMessage).not.toHaveBeenCalled();
    expect(h.providerManager.sendMessage).not.toHaveBeenCalled();
    expect(h.provider.sendMessage).not.toHaveBeenCalled();
    expect(h.chat._channelBridge.drainQueuedMessages).not.toHaveBeenCalled();
    expect(h.chat._postToPanel.mock.calls.every(([panel]: any[]) => panel === 'a')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains provider-owned completed authentication without opening a terminal or starting polling', async () => {
    vi.useFakeTimers(); const h = harness(true);
    const terminal = vi.spyOn(vscode.window, 'createTerminal');
    await h.chat._handleAuthConfirm('openai-codex', 'a');
    expect(h.chat._postToPanel).toHaveBeenCalledWith('a', {
      type: 'setupComplete', payload: { providerId: 'openai-codex' },
    });
    expect(h.chat._postToPanel).toHaveBeenCalledWith('a', expect.objectContaining({
      type: 'providerSetupStep', payload: expect.objectContaining({ message: 'Ready to use!', details: 'Validated account' }),
    }));
    expect(terminal).not.toHaveBeenCalled();
    expect(h.provider.checkAuthentication).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
