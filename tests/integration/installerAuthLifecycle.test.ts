import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
function harness() {
  const provider = { displayName: 'Provider', discoverCli: vi.fn(async () => ({ found: true })), checkAuthentication: vi.fn(async () => ({ authenticated: false })) };
  const setup = { authenticateProvider: vi.fn(async () => ({ authenticated: false })), authenticateWithMethod: vi.fn(async () => ({ authenticated: false, error: 'Cancelled' })), invalidateProviderStatus: vi.fn(), getAuthOptions: () => [] };
  const chat = Object.assign(Object.create(ChatViewProvider.prototype), {
    _providerManager: { getProviderInstance: () => provider }, _setupManager: setup,
    _panelStates: new Map([['a', {}], ['b', {}]]), _authPolls: new Map(), _postToPanel: vi.fn(), _sendInitialState: vi.fn(),
  });
  return { chat, provider, setup };
}
afterEach(() => { vi.useRealTimers(); });
describe('installer authentication lifecycle', () => {
  it('reports authentication completion to both setup surfaces and invalidates cached status', async () => {
    vi.useFakeTimers(); const h = harness();
    h.provider.checkAuthentication.mockResolvedValue({ authenticated: true });
    h.chat._pollAuthStatus('provider', 'a');
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.chat._postToPanel).toHaveBeenCalledWith('a', expect.objectContaining({ type: 'setupComplete' }));
    expect(h.chat._postToPanel).toHaveBeenCalledWith('a', expect.objectContaining({ type: 'providerSetupStep', payload: expect.objectContaining({ step: 'complete' }) }));
    expect(h.setup.invalidateProviderStatus).toHaveBeenCalledWith('provider');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('auth probe failures become recoverable errors, not unhandled rejections', async () => {
    vi.useFakeTimers(); const h = harness();
    h.provider.checkAuthentication.mockRejectedValue(new Error('Probe failed'));
    h.chat._pollAuthStatus('provider', 'a');
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.chat._postToPanel).toHaveBeenCalledWith('a', expect.objectContaining({ type: 'setupFailed', payload: expect.objectContaining({ error: 'Probe failed' }) }));
    expect(vi.getTimerCount()).toBe(0);
  });
  it('skipping setup stops the poll and suppresses a late result', async () => {
    vi.useFakeTimers(); const h = harness(); let resolve!: (value: any) => void;
    h.provider.checkAuthentication.mockImplementation(() => new Promise(r => { resolve = r; }));
    h.chat._pollAuthStatus('provider', 'a'); await vi.advanceTimersByTimeAsync(2000);
    h.chat._handleSkipSetup('a'); resolve({ authenticated: true }); await vi.advanceTimersByTimeAsync(10000);
    expect(h.chat._postToPanel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('starting another poll in the same panel does not leave an older timer running', async () => {
    vi.useFakeTimers(); const h = harness();
    h.chat._pollAuthStatus('old', 'a'); h.chat._pollAuthStatus('new', 'a'); h.chat._pollAuthStatus('other', 'b');
    expect(vi.getTimerCount()).toBe(2);
    h.chat._stopAuthPolling('a'); expect(vi.getTimerCount()).toBe(1);
    h.chat._panelStates.delete('b'); await vi.advanceTimersByTimeAsync(2000);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('times out authentication with actions rather than waiting indefinitely', async () => {
    vi.useFakeTimers(); const h = harness(); h.chat._pollAuthStatus('provider', 'a');
    await vi.advanceTimersByTimeAsync(120000);
    expect(h.chat._postToPanel).toHaveBeenCalledWith('a', expect.objectContaining({ type: 'setupFailed', payload: expect.objectContaining({ error: expect.stringContaining('timed out'), canRetry: true }) }));
    expect(vi.getTimerCount()).toBe(0);
  });
  it('setup discovery failures leave a recoverable screen', async () => {
    const h = harness(); h.provider.discoverCli.mockRejectedValue(new Error('Discovery failed'));
    await h.chat._handleStartProviderSetup({ providerId: 'provider' }, 'a');
    expect(h.chat._postToPanel).toHaveBeenCalledWith('a', expect.objectContaining({ type: 'providerSetupStep', payload: expect.objectContaining({ step: 'failed', retryable: true }) }));
    expect(h.chat._postToPanel).toHaveBeenCalledWith('a', expect.objectContaining({ type: 'setupFailed', payload: expect.objectContaining({ error: 'Discovery failed' }) }));
  });
  it('terminal/auth launch failures and cancelled API-key prompts reach a visible error surface', async () => {
    const h = harness(); h.setup.authenticateProvider.mockRejectedValue(new Error('Terminal unavailable'));
    await h.chat._handleAuthConfirm('provider', 'a');
    expect(h.chat._postToPanel).toHaveBeenCalledWith('a', expect.objectContaining({ type: 'setupFailed' }));
    h.chat._postToPanel.mockClear();
    await h.chat._handleSelectAuthMethod({ providerId: 'provider', method: 'api-key' }, 'a');
    expect(h.chat._postToPanel).toHaveBeenCalledWith('a', expect.objectContaining({ type: 'setupFailed', payload: expect.objectContaining({ error: 'Cancelled' }) }));
  });
});
