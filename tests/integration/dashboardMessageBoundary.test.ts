import { describe, expect, it, vi } from 'vitest';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import type { Settings, VisualTestConfig } from '../../src/types';

function harness() {
  const settings: Settings = {
    provider: 'claude-code', model: '', mode: 'default', thinkingLevel: 'none',
    accessLevel: 'read-only', contextMode: 'auto',
  };
  const look = vi.fn(async () => undefined);
  const cancel = vi.fn();
  const stop = vi.fn(async () => undefined);
  const post = vi.fn();
  const provider = Object.assign(Object.create(ChatViewProvider.prototype), {
    _sidebarId: 'sidebar',
    _vtDashboardChatOrigin: 'origin',
    _getSettingsForPanel: vi.fn(() => settings),
    _runDashboardLook: look,
    _dashboardVisualOwners: new Map([['dashboard', 'dashboard-operation']]),
    _panelStates: new Map([['dashboard', {}]]),
    _cancelVisualOperation: cancel,
    _visualSessions: { cancelOwner: stop },
    _postToPanel: post,
  }) as { _handleDashboardMessage(message: unknown, panelId: string): Promise<void>; _dashboardVisualOwners: Map<string, string> };
  return { owners: provider._dashboardVisualOwners, receive: (message: unknown) => provider._handleDashboardMessage(message, 'dashboard'), look, cancel, stop, post, settings };
}

describe('dashboard webview message boundary', () => {
  it.each([null, undefined, 42, 'start', [], {}, { type: 'unknown' }])(
    'ignores a malformed or unrelated message: %j', async message => {
      const h = harness();
      await h.receive(message);
      expect(h.look).not.toHaveBeenCalled();
      expect(h.cancel).not.toHaveBeenCalled();
      expect(h.stop).not.toHaveBeenCalled();
    },
  );

  it('passes the typed user configuration and origin settings to the policy-backed look', async () => {
    const h = harness();
    const config: Partial<VisualTestConfig> & { path: string } = {
      url: 'http://localhost:3000', path: '/settings', devServerCommand: 'npm run dev',
      elementSelector: '#app', screenshotMode: 'element', waitForSelector: '.ready',
      requirements: 'Check the settings form', interactionsEnabled: false,
    };
    await h.receive({ type: 'dashboardStartVisualTest', payload: { config, operationId: 'dashboard-operation' } });
    expect(h.look).toHaveBeenCalledWith('dashboard', 'origin', h.settings, config, 'dashboard-operation');
  });

  it('keeps malformed configuration fields out of the visual policy request', async () => {
    const h = harness();
    await h.receive({ type: 'dashboardStartVisualTest', payload: { operationId: 'dashboard-operation', config: {
      url: { value: 'http://example.com' }, path: ['../'], devServerCommand: true,
      screenshotMode: 'invalid', requirements: 42, interactionsEnabled: 'false',
    } } });
    expect(h.look).toHaveBeenCalledWith('dashboard', 'origin', h.settings, {
      url: undefined, path: undefined, devServerCommand: undefined, elementSelector: undefined,
      screenshotMode: undefined, waitForSelector: undefined, requirements: undefined,
      interactionsEnabled: undefined,
    }, 'dashboard-operation');
  });

  it('routes cancel and stop only to the dashboard that sent the message', async () => {
    const h = harness();
    await h.receive({ type: 'dashboardCancelVisualTest', payload: { operationId: 'stale-operation' } });
    expect(h.cancel).not.toHaveBeenCalled(); expect(h.stop).not.toHaveBeenCalled();
    await h.receive({ type: 'dashboardCancelVisualTest', payload: { operationId: 'dashboard-operation' } });
    h.owners.set('dashboard', 'next-operation');
    await h.receive({ type: 'dashboardStopServer', payload: { operationId: 'next-operation' } });
    expect(h.cancel.mock.calls).toEqual([['dashboard-operation'], ['next-operation']]);
    expect(h.stop.mock.calls).toEqual([['dashboard-operation'], ['next-operation']]);
    expect(h.post.mock.calls).toEqual([
      ['dashboard', { type: 'visualTestDashboardCancelled', payload: { operationId: 'dashboard-operation' } }],
      ['dashboard', { type: 'visualTestDashboardCancelled', payload: { operationId: 'next-operation' } }],
    ]);
    expect(h.look).not.toHaveBeenCalled();
  });
});
