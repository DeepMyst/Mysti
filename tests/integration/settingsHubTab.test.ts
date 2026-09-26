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
  function loading() {
    const release: Record<string, () => void> = {};
    const h = harness({
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
