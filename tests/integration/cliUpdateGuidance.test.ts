import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('vscode', async importOriginal => {
  const actual = await importOriginal<typeof import('vscode')>();
  return { ...actual, window: { ...actual.window, createTerminal: vi.fn() } };
});
import * as vscode from 'vscode';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { CLI_UPDATE_CACHE_KEY, CliUpdateService, type CliUpdateInfo } from '../../src/services/CliUpdateService';
import { createMockMemento } from '../helpers/mockVscode';

function harness(command: string | undefined, error?: string, update: Partial<CliUpdateInfo> = {}) {
  const host = Object.assign(Object.create(ChatViewProvider.prototype), {
    _cliUpdates: {
      getUpdates: () => [{ providerId: 'openai-codex', packageName: '@openai/codex', installed: '0.153.4', latest: '0.162.0', installable: '0.162.0', blockedByNodeEngine: false, checkedAt: 0, ...update }],
      getUpdateCommand: vi.fn(() => command),
      getUpdateError: vi.fn(() => error),
    },
  });
  const terminal = { show: vi.fn(), sendText: vi.fn() };
  const create = vi.spyOn(vscode.window, 'createTerminal').mockReturnValue(terminal as any);
  const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
  return { host, terminal, create, warn };
}

function refreshHarness(checkAll: ReturnType<typeof vi.fn>) {
  const { host } = harness(undefined);
  Object.assign(host, {
    _cliUpdates: { ...host._cliUpdates, getUpdates: () => [], checkAll },
    _panelStates: new Map([['a', {}], ['b', {}]]), _authPolls: new Map(),
    _postToPanel: vi.fn(), _broadcastToAll: vi.fn(),
    _setupManager: { refreshWizardStatus: vi.fn(async () => ({ providers: [], anyReady: false })) },
  });
  return host;
}

afterEach(() => { vi.restoreAllMocks(); vi.mocked(vscode.window.createTerminal).mockReset(); });

describe('PC-02 selected CLI update guidance', () => {
  it('coalesces fifty refreshes while a registry scan waits, then checks the changed discovery once', async () => {
    let finish!: () => void;
    let found = ['claude-code'];
    const snapshots: string[][] = [];
    const checkAll = vi.fn(() => {
      snapshots.push([...found]);
      return snapshots.length === 1 ? new Promise<void>(resolve => { finish = resolve; }) : Promise.resolve();
    });
    const host = refreshHarness(checkAll);
    await host._handleRefreshProviderDetection('a');
    expect(checkAll).toHaveBeenCalledOnce();
    found = ['claude-code', 'openai-codex'];
    for (let i = 1; i < 50; i++) { await host._handleRefreshProviderDetection(i % 2 ? 'b' : 'a'); }
    expect(checkAll).toHaveBeenCalledOnce();
    expect(host._postToPanel.mock.calls.filter(([, message]: any[]) => message.type === 'providerDetectionComplete')).toHaveLength(50);
    finish();
    await host._cliUpdateRefreshTask;
    expect(snapshots).toEqual([['claude-code'], ['claude-code', 'openai-codex']]);
    expect(host._cliUpdateRefreshTask).toBeUndefined();
    host._cancelPanelSetup('a'); host._cancelPanelSetup('b');
  });

  it('respects disabled automatic update checks while still completing discovery', async () => {
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({ get: () => false } as any);
    const checkAll = vi.fn(async () => []);
    const host = refreshHarness(checkAll);
    await host._handleRefreshProviderDetection('a');
    expect(checkAll).not.toHaveBeenCalled();
    expect(host._postToPanel).toHaveBeenCalledWith('a', { type: 'providerDetectionComplete', payload: {} });
    host._cancelPanelSetup('a');
  });

  it('observes a background registry failure and permits the next refresh to retry', async () => {
    const checkAll = vi.fn().mockRejectedValueOnce(new Error('Registry unavailable')).mockResolvedValue([]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const host = refreshHarness(checkAll);
    await host._handleRefreshProviderDetection('a');
    await host._cliUpdateRefreshTask;
    expect(checkAll).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalled();
    await host._handleRefreshProviderDetection('a');
    await host._cliUpdateRefreshTask;
    expect(checkAll).toHaveBeenCalledTimes(2);
    expect(host._postToPanel).toHaveBeenCalledWith('a', { type: 'providerDetectionComplete', payload: {} });
    host._cancelPanelSetup('a');
  });

  it('checks a CLI discovered after startup and publishes its real update offer without a restart', async () => {
    const globalState = createMockMemento();
    const detected = { providerId: 'claude-code', found: false, path: '/fixture/claude', version: '2.1.278' };
    const updates = new CliUpdateService({ globalState } as unknown as vscode.ExtensionContext, {
      getAllStatuses: async () => [detected], peekStatus: () => detected,
    }, { getNpmPath: () => '/fixture/npm' });
    // Only the registry boundary is controlled: all cache, version comparison,
    // update planning, host refresh, and update events use production code.
    const registry = vi.spyOn(updates as any, '_execNpmView').mockResolvedValue(JSON.stringify({ version: '2.1.286', 'engines.node': '>=18' }));
    const { host } = harness(undefined);
    const panel = vi.fn();
    Object.assign(host, {
      _cliUpdates: updates,
      _panelStates: new Map([['a', { webview: { postMessage: panel } }]]),
      _authPolls: new Map(), _postToPanel: vi.fn(), _mirrorToHub: vi.fn(),
      _setupManager: { refreshWizardStatus: vi.fn(async () => {
        detected.found = true;
        return { providers: [{ providerId: 'claude-code', installed: true, authenticated: true }], anyReady: true };
      }) },
    });
    const listener = updates.onDidFindUpdates(() => host._broadcastCliUpdates());
    try {
      expect(await updates.checkAll()).toEqual([]);
      expect(registry).not.toHaveBeenCalled();
      await host._handleRefreshProviderDetection('a');
      await vi.waitFor(() => expect(panel).toHaveBeenCalledWith({
        type: 'cliUpdatesAvailable', payload: { updates: [expect.objectContaining({
          providerId: 'claude-code', installed: '2.1.278', installable: '2.1.286', command: '/fixture/claude install latest',
        })] },
      }));
      expect(registry).toHaveBeenCalledOnce();
      // Repeated refreshes retain the normal registry TTL rather than forcing
      // another network lookup on every menu click.
      await host._handleRefreshProviderDetection('a');
      await Promise.resolve();
      expect(registry).toHaveBeenCalledOnce();
    } finally { listener.dispose(); updates.dispose(); host._cancelPanelSetup('a'); }
  });

  it.each(['2.1.286', '2.1.280'])('refreshes all open update cards after detection observes CLI %s', async versionAfterUpdate => {
    const globalState = createMockMemento();
    await globalState.update(CLI_UPDATE_CACHE_KEY, {
      'claude-code': { latest: '2.1.286', checkedAt: Date.now() },
    });
    const detected = { providerId: 'claude-code', found: true, path: '/fixture/claude', version: '2.1.278' };
    const updates = new CliUpdateService({ globalState } as unknown as vscode.ExtensionContext, {
      getAllStatuses: async () => [detected], peekStatus: () => detected,
    }, { getNpmPath: () => '/fixture/npm' });
    const { host } = harness(undefined);
    const a = vi.fn(), b = vi.fn();
    Object.assign(host, {
      _cliUpdates: updates,
      _panelStates: new Map([['a', { webview: { postMessage: a } }], ['b', { webview: { postMessage: b } }]]),
      _authPolls: new Map(),
      _postToPanel: vi.fn(), _mirrorToHub: vi.fn(),
      _setupManager: { refreshWizardStatus: vi.fn(async () => {
        // The real update service observes the newly discovered version. Found
        // and authenticated remain unchanged, so no availability-change event
        // can be relied upon to invalidate the card.
        detected.version = versionAfterUpdate;
        return { providers: [{ providerId: 'claude-code', installed: true, authenticated: true }], anyReady: true };
      }) },
    });
    try {
      host._broadcastCliUpdates();
      expect(a).toHaveBeenCalledWith(expect.objectContaining({
        type: 'cliUpdatesAvailable', payload: { updates: [expect.objectContaining({ installed: '2.1.278', installable: '2.1.286' })] },
      }));
      a.mockClear(); b.mockClear();
      await host._handleRefreshProviderDetection('a');
      const expected = versionAfterUpdate === '2.1.286' ? [] : [expect.objectContaining({ installed: '2.1.280', installable: '2.1.286' })];
      for (const panel of [a, b]) {
        expect(panel).toHaveBeenCalledWith({ type: 'cliUpdatesAvailable', payload: { updates: expected } });
      }
      expect(host._postToPanel).toHaveBeenCalledWith('a', { type: 'providerDetectionComplete', payload: {} });
    } finally { updates.dispose(); host._cancelPanelSetup('a'); }
  });

  it('announces the installable target and its Node limit instead of implying the latest release will install', async () => {
    const command = "'/fixture npm/npm' install -g --prefix '/fixture selected prefix' @openai/codex@0.159.3";
    const { host, terminal } = harness(command, undefined, {
      installable: '0.159.3', blockedByNodeEngine: true, requiredNode: '>=24.15.0',
    });
    expect(host._buildCliUpdatesPayload()).toEqual([expect.objectContaining({
      installed: '0.153.4', latest: '0.162.0', installable: '0.159.3',
      blockedByNodeEngine: true, requiredNode: '>=24.15.0', command,
    })]);
    await host._handleMessage({ type: 'runCliUpdate', panelId: 'a', payload: { provider: 'openai-codex' } });
    expect(terminal.sendText).toHaveBeenCalledExactlyOnceWith(command);
  });

  it('keeps an outdated custom installation visible with manual instructions', () => {
    const { host } = harness(undefined, 'Update the selected binary /custom prefix/codex manually.');
    expect(host._buildCliUpdatesPayload()).toEqual([expect.objectContaining({
      providerId: 'openai-codex', installed: '0.153.4', command: '',
      manualUpdateReason: 'Update the selected binary /custom prefix/codex manually.',
    })]);
  });

  it('explains an unsafe automatic update without launching a global installer', async () => {
    const { host, create, warn } = harness(undefined, 'Selected executable is not a recognized npm installation; update it manually.');
    await host._handleMessage({ type: 'runCliUpdate', panelId: 'a', payload: { provider: 'openai-codex', command: 'ignored-injected-command' } });
    expect(create).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('update it manually'));
  });

  it('uses the planned selected-prefix command in its supported shell, never a webview command', async () => {
    const command = "'/fixture npm/npm' install -g --prefix '/fixture selected prefix' @openai/codex@0.162.0";
    const { host, create, terminal, warn } = harness(command);
    expect(host._buildCliUpdatesPayload()).toEqual([expect.objectContaining({
      latest: '0.162.0', installable: '0.162.0', blockedByNodeEngine: false,
    })]);
    host._cliUpdates.getUpdateCommand.mockClear();
    await host._handleMessage({ type: 'runCliUpdate', panelId: 'a', payload: { provider: 'openai-codex', command: 'ignored-injected-command' } });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ shellPath: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash' }));
    expect(create).toHaveBeenCalledOnce();
    expect(host._cliUpdates.getUpdateCommand).toHaveBeenCalledExactlyOnceWith('openai-codex');
    expect(terminal.show).toHaveBeenCalledOnce();
    expect(terminal.sendText).toHaveBeenCalledExactlyOnceWith(command);
    expect(warn).not.toHaveBeenCalled();
  });
});
