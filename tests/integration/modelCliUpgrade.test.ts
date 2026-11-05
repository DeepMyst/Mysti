import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/services/CliModelUpgrade', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/services/CliModelUpgrade')>(),
  runCliUpgradeTask: vi.fn().mockResolvedValue(undefined),
}));
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { runCliUpgradeTask } from '../../src/services/CliModelUpgrade';

const requirement = 'API Error: 400 Claude Code 2.1.278 does not support this model; version 2.1.280 or newer is required.';
const installed = (version: string) => ({ providerId: 'claude-code', found: true, version, path: '/custom/claude' });

describe('model CLI upgrade host action', () => {
  let host: any;
  let provider: { disposePersistentProcess: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    vi.mocked(runCliUpgradeTask).mockReset().mockResolvedValue(undefined);
    provider = { disposePersistentProcess: vi.fn() };
    host = Object.create(ChatViewProvider.prototype);
    Object.assign(host, {
      _modelCliUpgrades: new Map(), _upgradingClis: new Set(), _postToPanel: vi.fn(),
      _cliUpdates: { getModelUpgradePlan: vi.fn().mockReturnValue({ executable: '/custom/claude', args: ['install', 'latest'] }) },
      _setupManager: { refreshProviderStatus: vi.fn().mockResolvedValue(installed('2.1.286')) },
      _providerManager: { getProviderInstance: vi.fn().mockReturnValue(provider) },
      _lifecycleManager: { getSession: vi.fn().mockReturnValue({ status: 'idle' }) },
      _panelStates: new Map([['panel-a', { currentConversationId: 'conversation-a', settingsOverrides: { provider: 'claude-code', model: 'model-a' } }], ['panel-b', { currentConversationId: 'conversation-b' }]]),
      _broadcastCliUpdates: vi.fn(),
    });
  });
  const offer = (panel = 'panel-a') => {
    expect(host._postProviderFailure(panel, 'claude-code', requirement)).toBe(true);
    return host._postToPanel.mock.calls.at(-1)[1].payload.id;
  };
  const last = () => host._postToPanel.mock.calls.at(-1)[1].payload;

  it('shows the minimum version beside a compatibility error', () => {
    offer();
    expect(last()).toMatchObject({ minimum: '2.1.280', providerId: 'claude-code', state: 'available' });
    expect(runCliUpgradeTask).not.toHaveBeenCalled();
  });
  it('runs the detected installation updater and verifies before marking ready', async () => {
    const id = offer();
    host._setupManager.refreshProviderStatus.mockResolvedValueOnce(installed('2.1.278'));
    await host._upgradeModelCli('panel-a', id);
    expect(host._cliUpdates.getModelUpgradePlan).toHaveBeenCalledWith('claude-code', '2.1.280', '/custom/claude');
    expect(runCliUpgradeTask).toHaveBeenCalledWith(expect.any(String), { executable: '/custom/claude', args: ['install', 'latest'] });
    expect(host._setupManager.refreshProviderStatus).toHaveBeenCalledTimes(2);
    expect(last()).toMatchObject({ state: 'ready' });
    expect(last().message).toContain('2.1.286');
    expect(provider.disposePersistentProcess).toHaveBeenCalledWith('panel-a');
  });
  it('does not reinstall or downgrade an already compatible CLI', async () => {
    await host._upgradeModelCli('panel-a', offer());
    expect(runCliUpgradeTask).not.toHaveBeenCalled();
    expect(last().state).toBe('ready');
    expect(provider.disposePersistentProcess).toHaveBeenCalledWith('panel-a');
  });
  it('keeps a retry action when the installer succeeds but the detected version is old', async () => {
    host._setupManager.refreshProviderStatus.mockResolvedValue(installed('2.1.278'));
    await host._upgradeModelCli('panel-a', offer());
    expect(last().state).toBe('failed');
    expect(last().message).toContain('/custom/claude');
    expect(provider.disposePersistentProcess).not.toHaveBeenCalled();
  });
  it('shows installer errors and allows a later retry', async () => {
    const id = offer();
    host._setupManager.refreshProviderStatus.mockResolvedValue(installed('2.1.278'));
    vi.mocked(runCliUpgradeTask).mockRejectedValueOnce(new Error('Permission denied'));
    await host._upgradeModelCli('panel-a', id);
    expect(last()).toMatchObject({ state: 'failed', message: 'Permission denied' });
    host._setupManager.refreshProviderStatus.mockResolvedValue(installed('2.1.286'));
    await host._upgradeModelCli('panel-a', id);
    expect(last().state).toBe('ready');
  });
  it('ignores invented, obsolete and cross-panel IDs', async () => {
    const old = offer();
    const id = offer();
    await host._upgradeModelCli('panel-a', 'invented; curl bad');
    await host._upgradeModelCli('panel-a', old);
    await host._upgradeModelCli('panel-b', id);
    expect(host._setupManager.refreshProviderStatus).not.toHaveBeenCalled();
    expect(runCliUpgradeTask).not.toHaveBeenCalled();
  });
  it('deduplicates concurrent clicks and gives another panel a retryable status', async () => {
    const id = offer();
    const second = offer('panel-b');
    let release!: (value: unknown) => void;
    host._setupManager.refreshProviderStatus.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = host._upgradeModelCli('panel-a', id);
    await host._upgradeModelCli('panel-a', id);
    await host._upgradeModelCli('panel-b', second);
    expect(last()).toMatchObject({ state: 'failed' });
    expect(last().message).toContain('already running');
    release(installed('2.1.286'));
    await pending;
    expect(host._setupManager.refreshProviderStatus).toHaveBeenCalledTimes(1);
  });
  it('does not stop a running response to upgrade', async () => {
    host._lifecycleManager.getSession.mockReturnValue({ status: 'busy' });
    await host._upgradeModelCli('panel-a', offer());
    expect(last().state).toBe('failed');
    expect(runCliUpgradeTask).not.toHaveBeenCalled();
    expect(provider.disposePersistentProcess).not.toHaveBeenCalled();
  });
  it('does not launch an installer after its panel offer was removed during discovery', async () => {
    const id = offer();
    let release!: (value: unknown) => void;
    host._setupManager.refreshProviderStatus.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = host._upgradeModelCli('panel-a', id);
    // Actual panel cleanup removes offers owned by that panel.
    host._modelCliUpgrades.delete(id);
    host._postToPanel.mockClear();
    release(installed('2.1.278'));
    await pending;
    expect(runCliUpgradeTask).not.toHaveBeenCalled();
    expect(host._postToPanel).not.toHaveBeenCalled();
    expect(provider.disposePersistentProcess).not.toHaveBeenCalled();
    expect(host._upgradingClis.size).toBe(0);
  });
  it('a removed offer does not report a late task result or stop a replacement conversation', async () => {
    const id = offer();
    host._setupManager.refreshProviderStatus.mockResolvedValueOnce(installed('2.1.278'));
    let release!: () => void;
    vi.mocked(runCliUpgradeTask).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = host._upgradeModelCli('panel-a', id);
    await vi.waitFor(() => expect(runCliUpgradeTask).toHaveBeenCalledOnce());
    host._modelCliUpgrades.delete(id);
    host._postToPanel.mockClear();
    release();
    await pending;
    expect(host._setupManager.refreshProviderStatus).toHaveBeenCalledTimes(1);
    expect(host._postToPanel).not.toHaveBeenCalled();
    expect(provider.disposePersistentProcess).not.toHaveBeenCalled();
    expect(host._upgradingClis.size).toBe(0);
  });
  it('requires the response that became busy during discovery to finish before installing', async () => {
    const id = offer();
    let release!: (value: unknown) => void;
    host._setupManager.refreshProviderStatus.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = host._upgradeModelCli('panel-a', id);
    host._lifecycleManager.getSession.mockReturnValue({ status: 'busy' });
    release(installed('2.1.278'));
    await pending;
    expect(runCliUpgradeTask).not.toHaveBeenCalled();
    expect(last()).toMatchObject({ state: 'failed' });
    expect(last().message).toContain('current response');
    expect(provider.disposePersistentProcess).not.toHaveBeenCalled();
  });
  it.each(['conversation', 'provider', 'model', 'panel'])('does not launch a stale upgrade after the owning %s changes', async changed => {
    const id = offer();
    let release!: (value: unknown) => void;
    host._setupManager.refreshProviderStatus.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = host._upgradeModelCli('panel-a', id);
    const state = host._panelStates.get('panel-a');
    if (changed === 'conversation') { state.currentConversationId = 'replacement'; }
    else if (changed === 'provider') { state.settingsOverrides.provider = 'openai-codex'; }
    else if (changed === 'model') { state.settingsOverrides.model = 'model-b'; }
    else { host._panelStates.set('panel-a', { ...state }); }
    host._postToPanel.mockClear();
    release(installed('2.1.278'));
    await pending;
    expect(runCliUpgradeTask).not.toHaveBeenCalled();
    expect(host._postToPanel).not.toHaveBeenCalled();
    expect(provider.disposePersistentProcess).not.toHaveBeenCalled();
    expect(host._upgradingClis.size).toBe(0);
  });
});
