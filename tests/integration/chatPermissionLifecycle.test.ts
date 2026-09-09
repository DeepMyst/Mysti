/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { PermissionManager } from '../../src/managers/PermissionManager';
import { PendingPlanStore } from '../../src/chat/PendingPlanStore';
import { DelayedChannelTurns } from '../../src/chat/DelayedChannelTurns';
import { SubAgentQuestionBroker } from '../../src/chat/SubAgentQuestionBroker';
import { clearMockConfig, setMockConfig } from '../helpers/mockVscode';
import type { Conversation, PermissionResponse, WebviewMessage } from '../../src/types';

vi.mock('../../src/webview/webviewContent', () => ({ getWebviewContent: () => '<html></html>' }));

interface PermissionProvider {
  _delayedChannelTurns: DelayedChannelTurns;
  requestPermissionInline: ChatViewProvider['requestPermissionInline'];
  _handleMessage(message: WebviewMessage & { panelId: string }): Promise<void>;
  _abortMystiDirect(panelId: string): void;
  _forkConversation(panelId: string, messageId: string): Conversation | null;
  resolveWebviewView: ChatViewProvider['resolveWebviewView'];
  openInNewTab(): void;
}

function createHarness() {
  const permissions = new PermissionManager('ask-permission');
  const posted: Array<{ panelId: string; message: WebviewMessage }> = [];
  const learned = vi.fn();
  const panels = new Map(['a', 'b'].map(id => [id, { id, currentConversationId: `conversation-${id}` }]));
  const jobs = new Map([['job-a', { id: 'job-a', panelId: 'a' }]]);
  const provider = Object.assign(Object.create(ChatViewProvider.prototype), {
    _extensionUri: vscode.Uri.file('/mock'),
    _extensionContext: { extension: { packageJSON: { version: '0.0.0' } } },
    _sidebarId: 'a',
    _pendingUiReadyPanels: new Set(),
    _permissionManager: permissions,
    _panelStates: panels,
    _backgroundJobManager: {
      get: (id: string) => jobs.get(id),
      listRunning: (panelId: string) => [...jobs.values()].filter(job => job.panelId === panelId),
    },
    _mystiAbortControllers: new Map(),
    _mystiActiveDelegationRuns: new Map(),
    _cancelledPanels: new Set(),
    _subAgentQuestions: new SubAgentQuestionBroker(),
    _pendingPlans: new PendingPlanStore(),
    _delayedChannelTurns: new DelayedChannelTurns(),
    _pendingPlanSelections: new Set(),
    _lastUserMessage: new Map(),
    _lastMentionContext: new Map(),
    _runningPanels: new Set(),
    _panelAutonomyLevel: new Map(),
    _mystiRunGen: new Map(),
    _vtNonces: new Map(),
    _vtScanners: new Map(),
    _providerManager: { cancelRequest: vi.fn(), clearSession: vi.fn(), getAllProviderIds: () => [], getAllProviders: () => [] },
    _brainstormManager: { cancelSession: vi.fn(), clearSession: vi.fn() },
    _collaborationManager: { cancelPanel: vi.fn() },
    _sessionManager: { cancelPanel: vi.fn() },
    _mentionRouter: { cancelSubAgents: vi.fn() },
    _compactionManager: { resetUsage: vi.fn() },
    _lifecycleManager: { removeSession: vi.fn() },
    _conversationManager: {
      createNewConversation: () => ({ id: 'new' }),
      getCurrentConversation: () => ({ id: 'conversation-a' }),
      getConversation: (id: string) => id === 'other' ? { id } : null,
      getAllConversations: () => [], deleteConversation: vi.fn(),
      forkConversation: (_id: string, messageId: string) => messageId === 'valid' ? { id: 'fork' } : null,
    },
    _contextManager: { clearPanelContext: vi.fn() },
    _channelBridge: { clearPanel: vi.fn(), clearQueuedMessages: vi.fn() },
    _visualTestManager: { disposePanel: vi.fn(async () => undefined) },
    _sendInitialState: vi.fn(),
    _tryPreSpawnPersistentProcess: vi.fn(),
    _engagementManager: { trackConversationStarted: () => [] },
    _emitBadgeUnlocks: vi.fn(),
    _autonomousManager: { isActive: () => false },
    _memoryManager: { learnFromPermissionDecision: learned },
    _postToPanel: (panelId: string, message: WebviewMessage) => { posted.push({ panelId, message }); },
  }) as PermissionProvider;
  const request = (panelId: string, ownerKey?: string) => {
    const result = provider.requestPermissionInline('file-edit', 'Edit file', 'Change file', {}, panelId, undefined, ownerKey);
    const id = permissions.getPendingRequests().at(-1)!.id;
    return { id, result };
  };
  const reply = (panelId: string, requestId: string, decision: PermissionResponse['decision']) =>
    provider._handleMessage({ type: 'permissionResponse', panelId, payload: { requestId, decision } });
  return { provider, permissions, request, reply, posted, learned, panels, jobs };
}

describe('chat permission ownership and cancellation', () => {
  let h: ReturnType<typeof createHarness>;
  beforeEach(() => {
    clearMockConfig();
    setMockConfig('permission.timeout', 0);
    setMockConfig('permission.timeoutBehavior', 'require-action');
    h = createHarness();
  });
  afterEach(() => { h.permissions.dispose(); h.provider._delayedChannelTurns.dispose(); clearMockConfig(); });

  it.each(['false', 'reject', 'throw', 'replace'] as const)('denies an undelivered card when posting returns %s', async failure => {
    // Exercise the actual transport wrapper rather than the message collector.
    const prototype = ChatViewProvider.prototype as unknown as { _postToPanel: unknown };
    Object.assign(h.provider, { _postToPanel: prototype._postToPanel });
    let deliver!: (sent: boolean) => void;
    const delivery = new Promise<boolean>(resolve => { deliver = resolve; });
    const state = Object.assign(h.panels.get('a')!, {
      webview: { postMessage: () => {
        if (failure === 'throw') { throw new Error('disposed webview'); }
        if (failure === 'reject') { return Promise.reject(new Error('delivery failed')); }
        return failure === 'replace' ? delivery : Promise.resolve(false);
      } },
    });
    const gate = h.request('a');
    if (failure === 'replace') {
      state.webview = { postMessage: () => Promise.resolve(true) };
      deliver(true);
    }
    expect(await gate.result).toBe(false);
    expect(h.permissions.getPendingCount()).toBe(0);
  });

  it('aborting a native collaborator gate removes only its card, even during synchronous delivery', async () => {
    const unrelated = h.request('a', 'job-a');
    const controller = new AbortController();
    Object.assign(h.provider, { _postToPanel: () => { controller.abort(); } });
    const result = h.provider.requestPermissionInline(
      'file-edit', 'Write', 'Collaborator wants to write', {}, 'a', 'native-child', 'a', true, false, controller.signal,
    );
    expect(await result).toBe(false);
    expect(h.permissions.getPendingRequests().map(card => card.id)).toEqual([unrelated.id]);
    await h.reply('a', unrelated.id, 'deny');
    expect(await unrelated.result).toBe(false);
  });

  it.each(['approve', 'deny', 'always-allow'] as const)('rejects another panel\'s %s response', async decision => {
    const gate = h.request('b');
    await h.reply('a', gate.id, decision);
    expect(h.permissions.getPendingRequest(gate.id)).toBeDefined();
    expect(h.learned).not.toHaveBeenCalled();
    await h.reply('b', gate.id, 'approve');
    expect(await gate.result).toBe(true);
  });

  it('routes a background job gate only to its originating panel', async () => {
    const gate = h.request('a', 'job-a');
    await h.reply('b', gate.id, 'approve');
    expect(h.permissions.getPendingRequest(gate.id)).toBeDefined();
    await h.reply('a', gate.id, 'deny');
    expect(await gate.result).toBe(false);
  });

  it('ignores malformed decisions instead of treating them as approval', async () => {
    const gate = h.request('a');
    await h.reply('a', gate.id, 'unexpected' as PermissionResponse['decision']);
    expect(h.permissions.getPendingRequest(gate.id)).toBeDefined();
    await h.reply('a', gate.id, 'deny');
    expect(await gate.result).toBe(false);
  });

  it.each(['cancelRequest', 'newConversation', 'clearSession'] as const)('%s denies foreground gates without touching other panels or background jobs', async type => {
    const foreground = h.request('a');
    const other = h.request('b');
    const background = h.request('a', 'job-a');
    await h.provider._handleMessage({ type, panelId: 'a' });
    expect(h.permissions.getPendingRequest(foreground.id)).toBeUndefined();
    expect(await foreground.result).toBe(false);
    expect(h.permissions.getPendingRequest(other.id)).toBeDefined();
    expect(h.permissions.getPendingRequest(background.id)).toBeDefined();
    await h.reply('a', foreground.id, 'approve');
    expect(h.learned).not.toHaveBeenCalled();
  });

  it.each(['switch', 'delete', 'fork'] as const)('denies old gates after a successful conversation %s', async action => {
    const gate = h.request('a');
    if (action === 'fork') { h.provider._forkConversation('a', 'valid'); }
    else {
      await h.provider._handleMessage({
        type: action === 'switch' ? 'switchConversation' : 'deleteConversation',
        panelId: 'a', payload: { id: action === 'switch' ? 'other' : 'conversation-a' },
      });
    }
    expect(h.permissions.getPendingRequest(gate.id)).toBeUndefined();
    expect(await gate.result).toBe(false);
  });

  it('preserves current gates after an unknown switch, unrelated deletion or failed fork', async () => {
    const gate = h.request('a');
    await h.provider._handleMessage({ type: 'switchConversation', panelId: 'a', payload: { id: 'missing' } });
    await h.provider._handleMessage({ type: 'deleteConversation', panelId: 'a', payload: { id: 'unrelated' } });
    expect(h.provider._forkConversation('a', 'missing')).toBeNull();
    expect(h.permissions.getPendingRequest(gate.id)).toBeDefined();
    await h.reply('a', gate.id, 'approve');
    expect(await gate.result).toBe(true);
  });

  it.each(['sidebar', 'tab'] as const)('closing the %s denies its foreground and background gates while other panels remain pending', async kind => {
    let close!: () => void;
    const webview = { onDidReceiveMessage: vi.fn(), postMessage: vi.fn() };
    const view = { webview, onDidDispose: (callback: () => void) => { close = callback; } };
    const mutableWindow = vscode.window as unknown as Record<string, unknown>;
    const original = mutableWindow.createWebviewPanel;
    let panelId = 'a';
    try {
      if (kind === 'sidebar') {
        h.provider.resolveWebviewView(view as unknown as vscode.WebviewView, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
      } else {
        mutableWindow.createWebviewPanel = () => view;
        h.provider.openInNewTab();
        panelId = [...h.panels.keys()].find(id => id.startsWith('panel_'))!;
        h.jobs.set('job-a', { id: 'job-a', panelId });
      }
      const foreground = h.request(panelId);
      const background = h.request(panelId, 'job-a');
      const other = h.request('b');
      h.provider._delayedChannelTurns.schedule(panelId, vi.fn(), 500);
      h.provider._delayedChannelTurns.schedule('b', vi.fn(), 500);
      close();
      expect(h.provider._delayedChannelTurns.has(panelId)).toBe(false);
      expect(h.provider._delayedChannelTurns.has('b')).toBe(true);
      expect(h.permissions.getPendingRequest(foreground.id)).toBeUndefined();
      expect(h.permissions.getPendingRequest(background.id)).toBeUndefined();
      expect(await Promise.all([foreground.result, background.result])).toEqual([false, false]);
      expect(h.permissions.getPendingRequest(other.id)).toBeDefined();
    } finally {
      if (original === undefined) { delete mutableWindow.createWebviewPanel; }
      else { mutableWindow.createWebviewPanel = original; }
    }
  });
});
