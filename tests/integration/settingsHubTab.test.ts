/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan 31 — the Mysti tab: one editor tab, bound to the chat that opened it,
 * acting for that chat through an allowlist.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import type { WebviewMessage } from '../../src/types';
import { getWebviewContent } from '../../src/webview/webviewContent';

vi.mock('../../src/webview/webviewContent', () => ({ getWebviewContent: vi.fn(() => '<html></html>') }));

type Listener = (value: unknown) => unknown;

function fakePanel() {
  const on: { message?: Listener; dispose?: () => void } = {};
  const webview = {
    html: '',
    postMessage: vi.fn(async (_m: unknown) => true),
    onDidReceiveMessage: (cb: Listener) => { on.message = cb; return { dispose() { /* noop */ } }; },
  };
  const panel = {
    webview,
    iconPath: undefined as unknown,
    reveal: vi.fn(),
    dispose: vi.fn(),
    onDidDispose: (cb: () => void) => { on.dispose = cb; return { dispose() { /* noop */ } }; },
  };
  return { panel, webview, on };
}

interface HubProvider {
  _hub: { panel: unknown; originPanelId: string | null } | null;
  openSettingsHub(section: string, originPanelId: string): Promise<void>;
  _unbindHubFrom(panelId: string): void;
  _handleMessage(message: WebviewMessage): Promise<void>;
  _receiveHubMessage(message: unknown, sender: unknown): Promise<void>;
  _receivePanelMessage(message: unknown, panelId: string, sender: unknown): Promise<void>;
  _postToPanel(panelId: string, message: WebviewMessage): Promise<unknown>;
  _broadcastToAll(message: WebviewMessage): void;
}

const win = vscode.window as unknown as Record<string, unknown>;
const originalCreate = win.createWebviewPanel;
afterEach(() => { win.createWebviewPanel = originalCreate; });

const typesOf = (fn: { mock: { calls: unknown[][] } }) => fn.mock.calls.map(c => (c[0] as WebviewMessage).type);

function harness(overrides: Record<string, unknown> = {}) {
  const created: Array<ReturnType<typeof fakePanel>> = [];
  win.createWebviewPanel = vi.fn(() => {
    const p = fakePanel();
    created.push(p);
    return p.panel;
  });
  const chat = (id: string, conversation: string) => ({
    id, currentConversationId: conversation as string | null, isSidebar: id === 'sidebar',
    webview: { postMessage: vi.fn(async (_m: unknown) => true) },
  });
  const panels = new Map([['sidebar', chat('sidebar', 'c-side')], ['tab', chat('tab', 'c-tab')]]);
  const titles: Record<string, string> = { 'c-side': 'Fix login', 'c-tab': 'Refactor', 'c-new': 'New chat' };
  const sendInitialState = vi.fn(async (_panelId: string, _forHub?: boolean) => undefined);
  const provider = Object.assign(Object.create(ChatViewProvider.prototype), {
    _hub: null,
    _sidebarId: 'sidebar',
    _extensionUri: vscode.Uri.file('/mock'),
    _extensionContext: { extension: { packageJSON: { version: '0.0.0' } } },
    _panelStates: panels,
    _conversationManager: { getConversation: (id: string) => (titles[id] ? { id, title: titles[id] } : null) },
    _sendInitialState: sendInitialState,
    ...overrides,
  }) as unknown as HubProvider;
  const hubPosts = () => created[created.length - 1].webview.postMessage.mock.calls.map(c => c[0] as WebviewMessage);
  return { provider, created, panels, sendInitialState, hubPosts };
}

describe('Plan 31 — the Mysti tab lifecycle', () => {
  it('opens one tab beside the chat, on the requested section, bound to the opener', async () => {
    const h = harness();
    await h.provider.openSettingsHub('settings', 'sidebar');
    expect(h.created).toHaveLength(1);
    expect(win.createWebviewPanel).toHaveBeenCalledWith(
      'mysti.settingsHub', 'Mysti', vscode.ViewColumn.Beside,
      expect.objectContaining({ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [expect.anything()] }),
    );
    expect(getWebviewContent).toHaveBeenCalledWith(expect.anything(), expect.anything(), '0.0.0', { view: 'hub' });
    expect(h.sendInitialState).toHaveBeenCalledWith('sidebar', true);
    expect(h.hubPosts()).toContainEqual({ type: 'hubShow', payload: { section: 'settings', chatTitle: 'Fix login' } });
  });

  it('reuses the tab from the same chat without re-sending state', async () => {
    const h = harness();
    await h.provider.openSettingsHub('settings', 'sidebar');
    await h.provider.openSettingsHub('badges', 'sidebar');
    expect(h.created).toHaveLength(1);
    expect(h.created[0].panel.reveal).toHaveBeenCalled();
    expect(h.sendInitialState).toHaveBeenCalledTimes(1);
    expect(h.hubPosts().at(-1)).toEqual({ type: 'hubShow', payload: { section: 'badges', chatTitle: 'Fix login' } });
  });

  it('rebinds to another chat that opens it', async () => {
    const h = harness();
    await h.provider.openSettingsHub('settings', 'sidebar');
    await h.provider.openSettingsHub('agents', 'tab');
    expect(h.created).toHaveLength(1);
    expect(h.provider._hub!.originPanelId).toBe('tab');
    expect(h.sendInitialState).toHaveBeenLastCalledWith('tab', true);
    expect(h.hubPosts().at(-1)).toEqual({ type: 'hubShow', payload: { section: 'agents', chatTitle: 'Refactor' } });
  });

  it('opens exactly one tab when two clicks land before the first finishes loading', async () => {
    const h = harness();
    await Promise.all([h.provider.openSettingsHub('settings', 'sidebar'), h.provider.openSettingsHub('about', 'sidebar')]);
    expect(h.created).toHaveLength(1);
  });

  it('ignores an opener that is not a live chat', async () => {
    const h = harness();
    await h.provider.openSettingsHub('settings', 'gone');
    expect(h.created).toHaveLength(0);
  });

  it('names an untitled chat rather than showing it as unbound', async () => {
    const h = harness();
    h.panels.get('tab')!.currentConversationId = 'missing';
    await h.provider.openSettingsHub('settings', 'tab');
    expect(h.hubPosts().at(-1)).toEqual({ type: 'hubShow', payload: { section: 'settings', chatTitle: 'Untitled chat' } });
  });

  it('unbinds when its own chat closes, and only then', async () => {
    const h = harness();
    await h.provider.openSettingsHub('settings', 'sidebar');
    h.provider._unbindHubFrom('tab');
    expect(h.provider._hub!.originPanelId).toBe('sidebar');
    h.provider._unbindHubFrom('sidebar');
    expect(h.provider._hub!.originPanelId).toBeNull();
    expect(h.hubPosts().at(-1)).toEqual({ type: 'hubShow', payload: { section: null, chatTitle: null } });
  });

  it('forgets the tab when the user closes it, and opens a fresh one next time', async () => {
    const h = harness();
    await h.provider.openSettingsHub('settings', 'sidebar');
    h.created[0].on.dispose!();
    expect(h.provider._hub).toBeNull();
    await h.provider.openSettingsHub('settings', 'sidebar');
    expect(h.created).toHaveLength(2);
  });

  it('opens from a chat message only for the four known sections', async () => {
    const h = harness();
    await h.provider._handleMessage({ type: 'openSettingsHub', payload: { section: 'badges' }, panelId: 'tab' } as WebviewMessage);
    expect(h.created).toHaveLength(1);
    await h.provider._handleMessage({ type: 'openSettingsHub', payload: { section: 'connections' }, panelId: 'tab' } as WebviewMessage);
    await h.provider._handleMessage({ type: 'openSettingsHub', payload: {}, panelId: 'tab' } as WebviewMessage);
    expect(h.hubPosts().filter(m => m.type === 'hubShow')).toHaveLength(1);
  });

  it('closes with the provider, and its chats closing then post nothing to it', async () => {
    const stub = { dispose() { /* noop */ }, clear() { /* noop */ } };
    const h = harness({
      _nativeApprovalRegistration: stub, _nativeApprovalCards: stub, _subAgentQuestions: stub,
      _delayedChannelTurns: stub, _pendingPlans: stub, _providerManager: stub,
      _backgroundJobManager: stub, _channelBridge: stub,
      _lastUserMessage: new Map(), _lastMentionContext: new Map(), _cancelledPanels: new Set(),
      _pendingPlanSelections: new Map(),
    });
    await h.provider.openSettingsHub('settings', 'sidebar');
    // A chat tab's own onDidDispose unbinds the hub, as the product's does.
    Object.assign(h.panels.get('sidebar')!, { panel: { dispose: () => h.provider._unbindHubFrom('sidebar') } });
    const posted = h.hubPosts().length;
    (h.provider as unknown as { dispose(): void }).dispose();
    expect(h.created[0].panel.dispose).toHaveBeenCalled();
    expect(h.provider._hub).toBeNull();
    expect(h.hubPosts()).toHaveLength(posted);
  });
});

describe('Plan 31 — clicks that land while the tab is still loading', () => {
  /**
   * The REAL `_sendInitialState`, held at its first wait (the provider probe,
   * up to 4s in the product) until the test lets a given chat's load finish.
   */
  function loading(overrides: Record<string, unknown> = {}) {
    const release: Record<string, () => void> = {};
    const h = harness({
      _panelAutonomyLevel: new Map<string, string>(),
      _sendInitialState: (ChatViewProvider.prototype as unknown as Record<string, unknown>)._sendInitialState,
      _getPanelProvider: (panelId: string) => panelId,
      _getPanelAgent: () => 'claude-code',
      _getPanelModel: () => '',
      _withTimeout: (p: Promise<unknown>) => p,
      _setupManager: {
        ensureProviderStatusFresh: (panelId: string) => new Promise<void>((r) => { release[panelId] = r; }),
        getWizardStatusCached: () => ({ anyReady: true, providers: [] }),
      },
      _extensionContext: { extension: { packageJSON: { version: '0.0.0' } }, globalState: { get: () => undefined } },
      _providerManager: { getProviders: () => [] },
      _contextManager: { getContext: () => [{ path: '/w/attached.ts' }] },
      _engagementManager: { getUsageStats: () => ({}), getAllBadges: () => [], getUnlockedCount: () => 0 },
      _buildManifestPayload: () => ({}),
      ...overrides,
    });
    const settle = () => new Promise((r) => setTimeout(r, 0));
    return { ...h, release, settle };
  }

  it('shows the LAST section clicked, and never before the state it belongs to', async () => {
    const h = loading();
    const first = h.provider.openSettingsHub('settings', 'sidebar');
    const second = h.provider.openSettingsHub('about', 'sidebar');
    await h.settle();
    expect(h.hubPosts()).toEqual([]);
    h.release.sidebar();
    await Promise.all([first, second]);
    const posts = h.hubPosts();
    expect(posts[0].type).toBe('initialState');
    const sections = posts.filter(m => m.type === 'hubShow').map(m => (m.payload as { section: string }).section);
    expect([...new Set(sections)]).toEqual(['about']);
  });

  it("never shows one chat's state under another chat's title when a rebind overtakes a load", async () => {
    const h = loading();
    const first = h.provider.openSettingsHub('settings', 'sidebar');
    const second = h.provider.openSettingsHub('agents', 'tab');
    await h.settle();
    h.release.tab();
    await second;
    h.release.sidebar();
    await first;
    const posts = h.hubPosts();
    expect(h.provider._hub!.originPanelId).toBe('tab');
    expect(posts.filter(m => m.type === 'initialState').map(m => (m.payload as { panelId: string }).panelId)).toEqual(['tab']);
    expect(posts.at(-1)).toEqual({ type: 'hubShow', payload: { section: 'agents', chatTitle: 'Refactor' } });
  });

  it("carries the chat's settings, not its transcript or attached context, and posts nothing to the chat", async () => {
    const h = loading();
    const open = h.provider.openSettingsHub('settings', 'sidebar');
    await h.settle();
    h.release.sidebar();
    await open;
    const state = h.hubPosts().find(m => m.type === 'initialState')!.payload as { conversation?: unknown; context: unknown[] };
    expect(state.conversation).toBeUndefined();
    expect(state.context).toEqual([]);
    expect(h.panels.get('sidebar')!.webview.postMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['semi-autonomous', 'semi-autonomous'],
    ['manual', 'manual'],
    [undefined, 'manual'],
    // Not reported on every path (Ctrl+Shift+A, deactivation), so never trusted.
    ['autonomous', 'manual'],
  ])("carries its chat's own autonomy level (%s), not the global config's", async (level, shown) => {
    const h = loading({ _panelAutonomyLevel: new Map(level ? [['sidebar', level]] : []) });
    const open = h.provider.openSettingsHub('settings', 'sidebar');
    await h.settle();
    h.release.sidebar();
    await open;
    const state = h.hubPosts().find(m => m.type === 'initialState')!.payload as { autonomyLevel?: string };
    expect(state.autonomyLevel).toBe(shown);
  });

  it('drops a load whose chat closed before it finished', async () => {
    const h = loading();
    const open = h.provider.openSettingsHub('settings', 'sidebar');
    await h.settle();
    h.provider._unbindHubFrom('sidebar');
    h.release.sidebar();
    await open;
    expect(h.hubPosts()).toEqual([{ type: 'hubShow', payload: { section: null, chatTitle: null } }]);
  });
});

describe('Plan 31 — what crosses between the tab and its chat', () => {
  async function bound(overrides: Record<string, unknown> = {}) {
    const handleMessage = vi.fn(async (_m: unknown) => undefined);
    const h = harness({ _handleMessage: handleMessage, ...overrides });
    await h.provider.openSettingsHub('settings', 'sidebar');
    const hub = h.created[0];
    const fromHub = (m: unknown) => h.provider._receiveHubMessage(m, hub.webview);
    return { ...h, hub, fromHub, handleMessage };
  }

  it('applies a settings change from the tab as its chat, and tells only that chat', async () => {
    const t = await bound();
    await t.fromHub({ type: 'updateSettings', payload: { thinkingLevel: 'high' }, panelId: 'forged' });
    expect(t.handleMessage).toHaveBeenCalledWith({ type: 'updateSettings', payload: { thinkingLevel: 'high' }, panelId: 'sidebar' });
    expect(t.panels.get('sidebar')!.webview.postMessage).toHaveBeenCalledWith({ type: 'settingsSync', payload: { thinkingLevel: 'high' } });
    expect(t.panels.get('tab')!.webview.postMessage).not.toHaveBeenCalled();
    expect(typesOf(t.hub.webview.postMessage)).not.toContain('settingsSync');
  });

  it('still tells its chat about an edit it applied when the tab is rebound meanwhile', async () => {
    const t = await bound();
    let finish!: () => void;
    t.handleMessage.mockImplementationOnce(() => new Promise<undefined>((r) => { finish = () => r(undefined); }));
    const edit = t.fromHub({ type: 'updateSettings', payload: { thinkingLevel: 'high' } });
    await t.provider.openSettingsHub('agents', 'tab');
    finish();
    await edit;
    expect(t.panels.get('sidebar')!.webview.postMessage).toHaveBeenCalledWith({ type: 'settingsSync', payload: { thinkingLevel: 'high' } });
    expect(typesOf(t.panels.get('tab')!.webview.postMessage)).not.toContain('settingsSync');
  });

  it('re-binds persona and skill edits to its chat', async () => {
    const t = await bound();
    await t.fromHub({ type: 'updateAgentConfig', payload: { personaId: 'p', enabledSkills: [] } });
    expect(t.handleMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'updateAgentConfig', panelId: 'sidebar' }));
  });

  it.each([
    'sendMessage', 'permissionResponse', 'cancelRequest', 'newConversation',
    'autonomyLevelChanged', 'uiReady', 'openSettingsHub', 'toggleAutonomous',
  ])('never lets the tab send %s', async (type) => {
    const t = await bound();
    await t.fromHub({ type, payload: {} });
    expect(t.handleMessage).not.toHaveBeenCalled();
  });

  it.each([null, undefined, 42, 'updateSettings', [], {}, { type: 7 }])('drops a malformed message: %j', async (m) => {
    const t = await bound();
    await t.fromHub(m);
    expect(t.handleMessage).not.toHaveBeenCalled();
  });

  it('drops a message from any webview that is not the tab', async () => {
    const t = await bound();
    await t.provider._receiveHubMessage({ type: 'updateSettings', payload: {} }, t.panels.get('tab')!.webview);
    expect(t.handleMessage).not.toHaveBeenCalled();
  });

  it('after its chat closes, applies no edit anywhere but still opens links', async () => {
    const t = await bound();
    t.provider._unbindHubFrom('sidebar');
    await t.fromHub({ type: 'updateSettings', payload: { thinkingLevel: 'high' } });
    await t.fromHub({ type: 'updateAgentConfig', payload: {} });
    expect(t.handleMessage).not.toHaveBeenCalled();
    await t.fromHub({ type: 'openExternal', payload: { url: 'https://example.com' } });
    expect(t.handleMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'openExternal' }));
  });

  it('treats a chat that vanished without a dispose event as closed', async () => {
    const t = await bound();
    t.panels.delete('sidebar');
    await t.fromHub({ type: 'updateSettings', payload: {} });
    expect(t.handleMessage).not.toHaveBeenCalled();
  });

  it('copies a settings change made in its chat to the tab', async () => {
    const t = await bound();
    await t.provider._receivePanelMessage({ type: 'updateSettings', payload: { model: 'm2' } }, 'sidebar', t.panels.get('sidebar')!.webview);
    expect(t.hub.webview.postMessage).toHaveBeenCalledWith({ type: 'settingsSync', payload: { model: 'm2' } });
  });

  it('tells the other side only what the host applied, never a value it refused', async () => {
    const t = await bound({
      _providerManager: { getAllProviderIds: () => ['claude-code', 'openai-codex'] },
      _permissionManager: { refreshConfig: vi.fn() },
      postMessage: vi.fn(),
    });
    const real = (ChatViewProvider.prototype as unknown as {
      _handleUpdateSettings(s: unknown, p?: string): Promise<void>;
    })._handleUpdateSettings;
    t.handleMessage.mockImplementation((m) => {
      const msg = m as { payload: unknown; panelId: string };
      return real.call(t.provider, msg.payload, msg.panelId);
    });
    const refused = {
      customModel: 'bad model!', codexProfile: 'bad profile!', 'brainstorm.strategy': 'chaos',
      'permission.timeoutBehavior': 'yolo', 'semiAutonomous.timeout': 5,
    };
    await t.fromHub({ type: 'updateSettings', payload: {
      ...refused, showSuggestions: false, 'brainstorm.agents': ['claude-code', 'bogus', 'openai-codex'],
    } });
    expect(t.panels.get('sidebar')!.webview.postMessage).toHaveBeenCalledWith({ type: 'settingsSync', payload: {
      showSuggestions: false, 'brainstorm.agents': ['claude-code', 'openai-codex'],
    } });
    // Same rule from the chat's side: a lone refused key is not relayed as applied.
    await t.provider._receivePanelMessage({ type: 'updateSettings', payload: { 'brainstorm.agents': ['claude-code'] } },
      'sidebar', t.panels.get('sidebar')!.webview);
    expect(t.hub.webview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ 'brainstorm.agents': expect.anything() }),
    }));
  });

  it('ignores settings changes in a chat it is not bound to', async () => {
    const t = await bound();
    await t.provider._receivePanelMessage({ type: 'updateSettings', payload: { model: 'm2' } }, 'tab', t.panels.get('tab')!.webview);
    expect(typesOf(t.hub.webview.postMessage)).not.toContain('settingsSync');
  });

  it('follows its chat to a new conversation', async () => {
    const t = await bound();
    t.handleMessage.mockImplementation(async () => { t.panels.get('sidebar')!.currentConversationId = 'c-new'; });
    t.sendInitialState.mockClear();
    await t.provider._receivePanelMessage({ type: 'newConversation' }, 'sidebar', t.panels.get('sidebar')!.webview);
    expect(t.sendInitialState).toHaveBeenCalledWith('sidebar', true);
    expect(t.hub.webview.postMessage).toHaveBeenLastCalledWith({ type: 'hubShow', payload: { section: null, chatTitle: 'New chat' } });
  });

  it('lets a rebind that overtakes the follow refresh own the tab', async () => {
    const t = await bound();
    t.handleMessage.mockImplementation(async () => { t.panels.get('sidebar')!.currentConversationId = 'c-new'; });
    let finish!: () => void;
    t.sendInitialState.mockImplementationOnce(() => new Promise<undefined>((r) => { finish = () => r(undefined); }));
    const follow = t.provider._receivePanelMessage({ type: 'newConversation' }, 'sidebar', t.panels.get('sidebar')!.webview);
    await new Promise((r) => setTimeout(r, 0));
    await t.provider.openSettingsHub('agents', 'tab');
    finish();
    await follow;
    expect(t.hub.webview.postMessage).toHaveBeenLastCalledWith({ type: 'hubShow', payload: { section: 'agents', chatTitle: 'Refactor' } });
  });

  it('does not refresh when the conversation did not change', async () => {
    const t = await bound();
    t.sendInitialState.mockClear();
    await t.provider._receivePanelMessage({ type: 'requestBadges' }, 'sidebar', t.panels.get('sidebar')!.webview);
    expect(t.sendInitialState).not.toHaveBeenCalled();
  });

  it("mirrors panel data for its chat, never chat output or another chat's data", async () => {
    const t = await bound();
    t.hub.webview.postMessage.mockClear();
    await t.provider._postToPanel('sidebar', { type: 'agentConfigUpdated', payload: {} });
    await t.provider._postToPanel('sidebar', { type: 'responseChunk', payload: {} });
    await t.provider._postToPanel('tab', { type: 'modelsUpdated', payload: {} });
    expect(typesOf(t.hub.webview.postMessage)).toEqual(['agentConfigUpdated']);
    expect(t.panels.get('sidebar')!.webview.postMessage).toHaveBeenCalledTimes(2);
  });

  it('never blocks delivery to its chat when the tab throws', async () => {
    const t = await bound();
    t.hub.webview.postMessage.mockImplementation(() => { throw new Error('disposed'); });
    await t.provider._postToPanel('sidebar', { type: 'agentConfigUpdated', payload: {} });
    t.provider._broadcastToAll({ type: 'agentsUpdated', payload: {} });
    expect(typesOf(t.panels.get('sidebar')!.webview.postMessage)).toEqual(['agentConfigUpdated', 'agentsUpdated']);
  });

  it('hears broadcast panel data but is never treated as a chat', async () => {
    const t = await bound();
    t.hub.webview.postMessage.mockClear();
    t.provider._broadcastToAll({ type: 'agentsUpdated', payload: {} });
    t.provider._broadcastToAll({ type: 'activeModeActivity', payload: {} });
    expect(typesOf(t.hub.webview.postMessage)).toEqual(['agentsUpdated']);
    expect([...t.panels.keys()]).toEqual(['sidebar', 'tab']);
  });
});
