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
  _hub: { panel: unknown; originPanelId: string | null; loadedFor?: unknown } | null;
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
  // As the real one: a tab load records which chat and conversation the tab now holds.
  const sendInitialState = vi.fn(async (panelId: string, forHub?: boolean) => {
    const hub = provider._hub;
    if (forHub && hub?.originPanelId === panelId) {
      hub.loadedFor = { panelId, conversationId: panels.get(panelId)?.currentConversationId ?? null };
    }
  });
  const provider = Object.assign(Object.create(ChatViewProvider.prototype), {
    _modelCliUpgrades: new Map(),
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
  return { provider, created, panels, titles, sendInitialState, hubPosts };
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
    expect(h.provider._hub!.originPanelId).toBe('tab');
    expect(h.hubPosts().at(-1)).toEqual({ type: 'hubShow', payload: { section: 'badges', chatTitle: 'Refactor' } });
    await h.provider._handleMessage({ type: 'openSettingsHub', payload: { section: 'connections' }, panelId: 'tab' } as WebviewMessage);
    await h.provider._handleMessage({ type: 'openSettingsHub', payload: {}, panelId: 'tab' } as WebviewMessage);
    expect(h.hubPosts().filter(m => m.type === 'hubShow')).toHaveLength(1);
  });

  it('binds to the chat whose webview asked, whatever panel id the message claims', async () => {
    const h = harness();
    await h.provider._receivePanelMessage({ type: 'openSettingsHub', payload: { section: 'badges' }, panelId: 'sidebar' },
      'tab', h.panels.get('tab')!.webview);
    expect(h.provider._hub!.originPanelId).toBe('tab');
    expect(h.hubPosts().at(-1)).toEqual({ type: 'hubShow', payload: { section: 'badges', chatTitle: 'Refactor' } });
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

describe('Plan 31 — the chat it acts for closing', () => {
  /** Every manager the chats' dispose paths touch: any method is a no-op returning []. */
  const inert = new Proxy({}, { get: () => () => [] });
  function closeable() {
    const managers = ['_delayedChannelTurns', '_channelBridge', '_providerManager', '_permissionManager',
      '_backgroundJobManager', '_subAgentQuestions', '_pendingPlans', '_contextManager', '_brainstormManager',
      '_collaborationManager', '_visualTestManager', '_compactionManager'];
    const maps = ['_lastUserMessage', '_lastSendSettings', '_lastMentionContext', '_vtNonces', '_vtScanners',
      '_pendingPlanSelections', '_panelAutonomyLevel', '_mystiRunGen', '_mystiAbortControllers', '_mystiActiveDelegationRuns'];
    const sets = ['_runningPanels', '_cancelledPanels', '_pendingUiReadyPanels'];
    const h = harness({
      ...Object.fromEntries(managers.map((k) => [k, inert])),
      ...Object.fromEntries(maps.map((k) => [k, new Map()])),
      ...Object.fromEntries(sets.map((k) => [k, new Set()])),
      _tryPreSpawnPersistentProcess: () => undefined,
    });
    Object.assign((h.provider as unknown as { _conversationManager: object })._conversationManager, {
      createNewConversation: () => ({ id: 'c-new' }),
      getCurrentConversation: () => ({ id: 'c-side' }),
    });
    return h;
  }

  it('unbinds when the editor-tab chat it acts for closes', async () => {
    const h = closeable();
    (h.provider as unknown as { openInNewTab(): void }).openInNewTab();
    const chat = h.created[0];
    const chatId = [...h.panels.keys()].find((k) => k.startsWith('panel_'))!;
    await h.provider.openSettingsHub('settings', chatId);
    expect(h.hubPosts().at(-1)).toEqual({ type: 'hubShow', payload: { section: 'settings', chatTitle: 'New chat' } });
    chat.on.dispose!();
    expect(h.provider._hub!.originPanelId).toBeNull();
    expect(h.hubPosts().at(-1)).toEqual({ type: 'hubShow', payload: { section: null, chatTitle: null } });
  });

  it('unbinds when the sidebar chat it acts for closes', async () => {
    const h = closeable();
    let closeView!: () => void;
    const view = {
      webview: { options: {}, html: '', postMessage: vi.fn(async () => true), onDidReceiveMessage: () => ({ dispose() { /* noop */ } }) },
      onDidDispose: (cb: () => void) => { closeView = cb; return { dispose() { /* noop */ } }; },
    };
    (h.provider as unknown as { resolveWebviewView(v: unknown, c: unknown, t: unknown): void }).resolveWebviewView(view, {}, {});
    await h.provider.openSettingsHub('settings', 'sidebar');
    expect(h.hubPosts().at(-1)).toEqual({ type: 'hubShow', payload: { section: 'settings', chatTitle: 'Fix login' } });
    closeView();
    expect(h.provider._hub!.originPanelId).toBeNull();
    expect(h.hubPosts().at(-1)).toEqual({ type: 'hubShow', payload: { section: null, chatTitle: null } });
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

  it.each([
    // The configured provider ('sidebar' here) is not installed: the chat got the demotion notice.
    ['a demoted provider', { anyReady: true, providers: [{ providerId: 'gemini', installed: true }] }],
    // Nothing is ready: the chat got the setup wizard.
    ['no ready provider', { anyReady: false, providers: [] }],
  ])('posts nothing to its chat for %s — the chat already showed it', async (_case, status) => {
    const h = loading({
      _setupManager: {
        ensureProviderStatusFresh: async () => undefined,
        getWizardStatusCached: () => status,
        getWizardStatus: async () => status,
      },
      _providerManager: { getProviders: () => [], getProvider: () => undefined },
    });
    await h.provider.openSettingsHub('settings', 'sidebar');
    await h.settle();
    expect(typesOf(h.created[0].webview.postMessage)).toContain('initialState');
    expect(h.panels.get('sidebar')!.webview.postMessage).not.toHaveBeenCalled();
  });

  it("applies no edit to a chat whose state it does not show yet, then acts for it once it does", async () => {
    const handleMessage = vi.fn(async (_m: unknown) => undefined);
    const h = loading({ _handleMessage: handleMessage });
    const first = h.provider.openSettingsHub('agents', 'sidebar');
    await h.settle();
    h.release.sidebar();
    await first;
    const hub = h.created[0];
    // Rebound to 'tab', whose state is still loading: the tab still shows the
    // sidebar chat's personas, model and title, so an edit now is for THAT.
    const rebind = h.provider.openSettingsHub('agents', 'tab');
    await h.settle();
    await h.provider._receiveHubMessage({ type: 'updateAgentConfig', payload: { personaId: 'p', enabledSkills: [] } }, hub.webview);
    await h.provider._receiveHubMessage({ type: 'updateSettings', payload: { model: 'from-sidebar-list' } }, hub.webview);
    expect(handleMessage).not.toHaveBeenCalled();
    // Links need no chat.
    await h.provider._receiveHubMessage({ type: 'openExternal', payload: { url: 'https://example.com' } }, hub.webview);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    h.release.tab();
    await rebind;
    await h.provider._receiveHubMessage({ type: 'updateAgentConfig', payload: { personaId: 'p', enabledSkills: [] } }, hub.webview);
    expect(handleMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'updateAgentConfig', panelId: 'tab' }));
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

  it("never lets the tab set its chat's trust level or context mode", async () => {
    // No control in the tab sets them; the chat's own composer does.
    const t = await bound();
    await t.fromHub({ type: 'updateSettings', payload: {
      mode: 'edit-automatically', accessLevel: 'full-access', contextMode: 'manual', thinkingLevel: 'high',
    } });
    expect(t.handleMessage).toHaveBeenCalledWith({ type: 'updateSettings', payload: { thinkingLevel: 'high' }, panelId: 'sidebar' });
    expect(t.panels.get('sidebar')!.webview.postMessage).toHaveBeenCalledWith({ type: 'settingsSync', payload: { thinkingLevel: 'high' } });
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
      _providerManager: { getAllProviderIds: () => ['claude-code', 'openai-codex'], getProvider: (id: string) => ({ name: id }) },
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

  it("applies no edit to its chat's new conversation until it shows that conversation", async () => {
    const t = await bound();
    t.handleMessage.mockImplementationOnce(async () => { t.panels.get('sidebar')!.currentConversationId = 'c-new'; });
    const load = t.sendInitialState.getMockImplementation()!;
    let finish!: () => void;
    t.sendInitialState.mockImplementationOnce((id, forHub) => new Promise<undefined>((r) => {
      finish = () => { void load(id, forHub).then(() => r(undefined)); };
    }));
    const follow = t.provider._receivePanelMessage({ type: 'newConversation' }, 'sidebar', t.panels.get('sidebar')!.webview);
    await new Promise((r) => setTimeout(r, 0));
    t.handleMessage.mockClear();
    // The tab still shows the OLD conversation's persona & skills.
    await t.fromHub({ type: 'updateAgentConfig', payload: { personaId: 'old', enabledSkills: ['s'] } });
    expect(t.handleMessage).not.toHaveBeenCalled();
    finish();
    await follow;
    await t.fromHub({ type: 'updateAgentConfig', payload: { personaId: null, enabledSkills: [] } });
    expect(t.handleMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'updateAgentConfig', panelId: 'sidebar' }));
  });

  it('renames its header when its chat gets a generated title', async () => {
    const t = await bound();
    t.titles['c-side'] = 'Login redirect loop';
    await t.provider._postToPanel('sidebar', { type: 'titleUpdated', payload: { conversationId: 'c-side', title: 'Login redirect loop' } });
    expect(t.hubPosts().at(-1)).toEqual({ type: 'hubShow', payload: { section: null, chatTitle: 'Login redirect loop' } });
    t.titles['c-side'] = 'Login loop';
    t.provider._broadcastToAll({ type: 'titleUpdated', payload: { conversationId: 'c-side', title: 'Login loop' } });
    expect(t.hubPosts().at(-1)).toEqual({ type: 'hubShow', payload: { section: null, chatTitle: 'Login loop' } });
    // Another chat's title is not this header's.
    const posted = t.hubPosts().length;
    await t.provider._postToPanel('tab', { type: 'titleUpdated', payload: { conversationId: 'c-tab', title: 'x' } });
    expect(t.hubPosts()).toHaveLength(posted);
    expect(typesOf(t.hub.webview.postMessage)).not.toContain('titleUpdated');
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
