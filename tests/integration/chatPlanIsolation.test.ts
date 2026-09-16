/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { PendingPlanStore } from '../../src/chat/PendingPlanStore';
import { DelayedChannelTurns } from '../../src/chat/DelayedChannelTurns';
import { SubAgentQuestionBroker } from '../../src/chat/SubAgentQuestionBroker';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { clearMockConfig } from '../helpers/mockVscode';
import type { Conversation, Message, PlanOption, PlanSelectionResult, WebviewMessage } from '../../src/types';
import { createMockSettings } from '../helpers/brainstormFactory';

vi.mock('../../src/webview/webviewContent', () => ({ getWebviewContent: () => '<html></html>' }));

const plan: PlanOption = {
  id: 'option', title: 'Implement the plan', summary: 'Summary', approach: 'Approach',
  pros: [], cons: [], complexity: 'low', icon: 'code', color: 'blue',
};

interface PlanProvider {
  _pendingPlans: PendingPlanStore;
  _pendingPlanSelections: Set<string>;
  _handleDetectedPlanOptions(options: PlanOption[], messageId: string, query: string, questions: undefined, panelId: string): Promise<void>;
  _handlePlanOptionSelected(selection: PlanSelectionResult, panelId: string): Promise<void>;
  _detectAndSendPlanOptions(message: Message, panelId: string, isCurrent?: () => boolean): Promise<boolean>;
  _forkConversation(panelId: string, messageId: string): Conversation | null;
  _handleMessage(message: WebviewMessage, panelId?: string): Promise<void>;
  openInNewTab(): void;
  dispose(): void;
}

function createHarness() {
  const sent = vi.fn(async () => undefined);
  const posted = vi.fn();
  const updateSettings = vi.fn(async () => undefined);
  const panels = new Map(['a', 'b', 'sidebar'].map(id => [id, {
    id, currentConversationId: `conversation-${id}`, webview: { postMessage: vi.fn() },
  }]));
  const conversations = new Map(['conversation-a', 'conversation-b', 'other'].map(id => [id, { id, messages: [] } as unknown as Conversation]));
  const questions = new SubAgentQuestionBroker();
  const classify = vi.fn(async (_content: string) => ({ questions: [], planOptions: [plan] }));
  const provider = Object.assign(Object.create(ChatViewProvider.prototype), {
    _extensionUri: vscode.Uri.file('/mock'),
    _extensionContext: { extension: { packageJSON: { version: '0.0.0' } } },
    _pendingPlans: new PendingPlanStore(),
    _delayedChannelTurns: new DelayedChannelTurns(),
    _subAgentQuestions: questions,
    _nativeApprovalRegistration: { dispose: vi.fn() },
    _nativeApprovalCards: { dispose: vi.fn() },
    _canvasTurns: { dispose: vi.fn() },
    _canvasMcpSession: { dispose: vi.fn(async () => undefined) },
    _pendingPlanSelections: new Set<string>(),
    _panelStates: panels,
    _lastUserMessage: new Map(),
    _lastMentionContext: new Map(),
    _cancelledPanels: new Set(),
    _runningPanels: new Set(),
    _panelAutonomyLevel: new Map(),
    _mystiRunGen: new Map(),
    _mystiAbortControllers: new Map(),
    _mystiExecutionAborts: new Map(),
    _vtNonces: new Map(),
    _vtScanners: new Map(),
    _autonomousManager: { isActive: () => false },
    _planOptionManager: { createSelectionPrompt: (_option: PlanOption, query: string) => query, classifyResponse: classify },
    _providerManager: {
      cancelRequest: vi.fn(), clearSession: vi.fn(), getAllProviders: () => [],
      getAllProviderIds: () => ['claude-code', 'openai-codex'], dispose: vi.fn(),
    },
    _backgroundJobManager: { listRunning: () => [], dispose: vi.fn() },
    _conversationManager: {
      createNewConversation: () => ({ id: 'new-conversation' }),
      getConversation: (id: string) => conversations.get(id) ?? null,
      getAllConversations: () => [...conversations.values()],
      deleteConversation: (id: string) => conversations.delete(id),
      forkConversation: (_id: string, messageId: string) => messageId === 'valid-message' ? { id: 'fork' } : null,
      addMessageToConversation: (_id: string, role: string, content: string) => ({ id: 'message', role, content }),
    },
    _contextManager: { clearPanelContext: vi.fn(), getContext: () => [] },
    _channelBridge: { clearPanel: vi.fn(), clearQueuedMessages: vi.fn(), dispose: vi.fn() },
    _brainstormManager: { cancelSession: vi.fn(), clearSession: vi.fn() },
    _collaborationManager: { cancelPanel: vi.fn() },
    _sessionManager: {
      cancelPanel: vi.fn(),
      async *run() { yield { type: 'session_complete', markdown: 'Done' }; },
    },
    _mentionRouter: { cancelSubAgents: vi.fn() },
    _permissionManager: { clearSessionUpgrade: vi.fn() },
    _lifecycleManager: { removeSession: vi.fn(), touchSession: vi.fn(), markBusy: vi.fn(), markIdle: vi.fn() },
    _engagementManager: { trackConversationStarted: () => [] },
    _emitBadgeUnlocks: vi.fn(),
    _visualTestManager: { disposePanel: vi.fn(async () => undefined) },
    _compactionManager: { resetUsage: vi.fn() },
    _abortMystiDirect: vi.fn(),
    _sendInitialState: vi.fn(),
    _tryPreSpawnPersistentProcess: vi.fn(),
    _getPanelModel: () => 'model',
    _getPanelProvider: () => 'claude-code',
    _handleUpdateSettings: updateSettings,
    _handleSendMessage: sent,
    _isSemiAutonomousEnabled: () => true,
    _getSemiAutonomousTimeout: () => 1,
    _postToPanel: posted,
  }) as PlanProvider;
  const detect = (panelId: string, messageId = 'shared-message') =>
    provider._handleDetectedPlanOptions([plan], messageId, `query-${panelId}`, undefined, panelId);
  return { provider, detect, sent, posted, panels, classify, updateSettings, questions };
}

describe('chat plan selection ownership', () => {
  let harness: ReturnType<typeof createHarness>;
  beforeEach(() => {
    vi.useFakeTimers();
    clearMockConfig();
    harness = createHarness();
  });
  afterEach(() => {
    harness.provider._pendingPlans.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('selecting a plan preserves the other panel timer and original query', async () => {
    await harness.detect('a');
    await harness.detect('b');
    await harness.provider._handlePlanOptionSelected({
      selectedPlan: plan, messageId: 'shared-message', originalQuery: 'a', executionMode: 'quick-plan',
    }, 'a');

    expect(vi.getTimerCount()).toBe(1);
    expect(harness.provider._pendingPlanSelections.has('b')).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.sent).toHaveBeenCalledOnce();
    expect(harness.sent).toHaveBeenCalledWith(expect.objectContaining({ content: 'query-b' }), 'b');
  });

  it('closing a tab preserves another panel timer and selection', async () => {
    let close!: () => void;
    const mutableWindow = vscode.window as unknown as Record<string, unknown>;
    const original = mutableWindow.createWebviewPanel;
    mutableWindow.createWebviewPanel = () => ({
      webview: { onDidReceiveMessage: vi.fn() },
      onDidDispose: (callback: () => void) => { close = callback; },
    });
    try {
      const tabId = `panel_${Date.now()}`;
      harness.provider.openInNewTab();
      await harness.detect(tabId);
      await harness.detect('b');
      close();
      expect(vi.getTimerCount()).toBe(1);
      expect(harness.provider._pendingPlanSelections.has(tabId)).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(harness.sent).toHaveBeenCalledOnce();
      expect(harness.sent).toHaveBeenCalledWith(expect.objectContaining({ content: 'query-b' }), 'b');
    } finally {
      if (original === undefined) { delete mutableWindow.createWebviewPanel; }
      else { mutableWindow.createWebviewPanel = original; }
    }
  });

  it('a skipped plan id cannot dismiss a selection owned by another panel', async () => {
    await harness.detect('a', 'a-message');
    await harness.detect('b', 'b-message');
    const bPlanId = `plan-b-message-${Date.now()}`;
    await harness.provider._handleMessage({
      type: 'planOptionsSkipped', panelId: 'a', payload: { syntheticPlanId: bPlanId },
    } as WebviewMessage, 'a');
    expect(vi.getTimerCount()).toBe(2);
    expect(harness.provider._pendingPlanSelections.has('a')).toBe(true);
    expect(harness.provider._pendingPlanSelections.has('b')).toBe(true);
  });

  it('new options replace the previous deadline in the same panel', async () => {
    await harness.detect('a', 'old-message');
    await vi.advanceTimersByTimeAsync(500);
    await harness.detect('a', 'new-message');
    await vi.advanceTimersByTimeAsync(500);
    expect(harness.sent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(harness.sent).toHaveBeenCalledOnce();
    const decision = harness.posted.mock.calls.find(([, message]) => message.type === 'semiAutonomousDecision');
    expect(decision?.[1].payload.requestId).toContain('new-message');
  });

  it('provider disposal releases timers for every panel including the sidebar', async () => {
    await harness.detect('sidebar');
    await harness.detect('b');
    harness.provider.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.provider._pendingPlanSelections.size).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.sent).not.toHaveBeenCalled();
  });

  it.each(['cancelRequest', 'newConversation', 'clearSession'] as const)(
    '%s invalidates only that panel pending plan and timer', async type => {
      await harness.detect('a');
      await harness.detect('b');
      await harness.provider._handleMessage({ type, panelId: 'a' } as WebviewMessage);
      expect(harness.provider._pendingPlanSelections.has('a')).toBe(false);
      expect(harness.provider._pendingPlanSelections.has('b')).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(harness.sent).toHaveBeenCalledOnce();
      expect(harness.sent).toHaveBeenCalledWith(expect.objectContaining({ content: 'query-b' }), 'b');
    },
  );

  it.each(['cancelRequest', 'newConversation', 'clearSession'] as const)(
    'discards classification that finishes after %s in the same panel', async type => {
      let release!: () => void;
      const parked = new Promise<void>(resolve => { release = resolve; });
      harness.classify.mockImplementation(async () => {
        await parked;
        return { questions: [], planOptions: [plan] };
      });
      const message = { id: 'late', role: 'assistant', content: 'A plan', timestamp: 0 } as Message;
      const pending = harness.provider._detectAndSendPlanOptions(message, 'a');
      await harness.provider._handleMessage({ type, panelId: 'a' } as WebviewMessage);
      // The panel still exists (including after New Conversation), so presence
      // alone cannot distinguish this old classifier from the next turn's.
      expect(harness.panels.has('a')).toBe(true);
      release();
      expect(await pending).toBe(false);
      expect(harness.provider._pendingPlanSelections.has('a')).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(harness.posted.mock.calls.some(([, message]) => message.type === 'planOptions')).toBe(false);
    },
  );

  it('does not publish classification or create timers after provider disposal', async () => {
    let release!: () => void;
    const parked = new Promise<void>(resolve => { release = resolve; });
    harness.classify.mockImplementation(async () => {
      await parked;
      return { questions: [], planOptions: [plan] };
    });
    const pending = harness.provider._detectAndSendPlanOptions({ id: 'late', content: 'Plan' } as Message, 'a');
    harness.provider.dispose();
    release();
    expect(await pending).toBe(false);
    await harness.detect('a');
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.provider._pendingPlanSelections.size).toBe(0);
    expect(harness.posted).not.toHaveBeenCalled();
  });

  it('rejects a stale turn before starting its classifier and allows the current turn', async () => {
    const stale = harness.provider._pendingPlans.capture('a');
    harness.provider._pendingPlans.clearPanel('a');
    const current = harness.provider._pendingPlans.capture('a');
    const message = { id: 'response', content: 'Plan' } as Message;
    expect(await harness.provider._detectAndSendPlanOptions(message, 'a', stale)).toBe(false);
    expect(harness.classify).not.toHaveBeenCalled();
    expect(await harness.provider._detectAndSendPlanOptions(message, 'a', current)).toBe(true);
    expect(harness.classify).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each(['cancelRequest', 'newConversation', 'clearSession'] as const)(
    'does not execute a selected plan after %s interrupts the mode update', async type => {
      let release!: () => void;
      harness.updateSettings.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
      const selecting = harness.provider._handlePlanOptionSelected({
        selectedPlan: plan, messageId: 'message', originalQuery: 'execute', executionMode: 'edit-automatically',
      }, 'a');
      expect(harness.updateSettings).toHaveBeenCalledOnce();
      await harness.provider._handleMessage({ type, panelId: 'a' } as WebviewMessage);
      release();
      await selecting;
      expect(harness.sent).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: 'switching conversation', type: 'switchConversation', payload: { id: 'other' }, currentId: 'other' },
    { name: 'deleting the active conversation', type: 'deleteConversation', payload: { id: 'conversation-a' }, currentId: 'new-conversation' },
    { name: 'forking successfully', type: 'forkConversation', payload: { messageId: 'valid-message' }, currentId: 'fork' },
    { name: 'starting a session', type: 'startSession', payload: {
      shape: 'review', agentIds: ['claude-code', 'openai-codex'], brief: 'Review', settings: createMockSettings(),
    }, currentId: 'conversation-a' },
  ])('$name invalidates that panel plans, classification and questions', async ({ type, payload, currentId }) => {
    await harness.detect('a');
    await harness.detect('b');
    const isCurrent = harness.provider._pendingPlans.capture('a');
    const first = harness.questions.wait('a', 'claude-code', 'q');
    const other = harness.questions.wait('b', 'claude-code', 'q');

    await harness.provider._handleMessage({ type, panelId: 'a', payload } as WebviewMessage);
    expect(harness.panels.get('a')?.currentConversationId).toBe(currentId);
    expect(isCurrent()).toBe(false);
    expect(harness.provider._pendingPlanSelections.has('a')).toBe(false);
    expect(harness.provider._pendingPlanSelections.has('b')).toBe(true);
    expect(await first).toBeNull();
    expect(harness.questions.answer('b', 'claude-code', 'q', { answers: {} })).toBe(true);
    expect(await other).toEqual({ answers: {} });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.sent).toHaveBeenCalledOnce();
    expect(harness.sent).toHaveBeenCalledWith(expect.objectContaining({ content: 'query-b' }), 'b');
  });

  it.each([
    { name: 'unknown switch target', type: 'switchConversation', payload: { id: 'missing' } },
    { name: 'current switch target', type: 'switchConversation', payload: { id: 'conversation-a' } },
    { name: 'deletion of another conversation', type: 'deleteConversation', payload: { id: 'other' } },
    { name: 'failed fork', type: 'forkConversation', payload: { messageId: 'missing-message' } },
    { name: 'invalid session start', type: 'startSession', payload: {
      shape: 'missing', agentIds: ['claude-code', 'openai-codex'], brief: 'Review', settings: createMockSettings(),
    } },
  ])('$name preserves the current conversation and interactions', async ({ type, payload }) => {
    await harness.detect('a');
    const isCurrent = harness.provider._pendingPlans.capture('a');
    const pending = harness.questions.wait('a', 'claude-code', 'q');
    await harness.provider._handleMessage({ type, panelId: 'a', payload } as WebviewMessage);
    expect(harness.panels.get('a')?.currentConversationId).toBe('conversation-a');
    expect(isCurrent()).toBe(true);
    expect(harness.provider._pendingPlanSelections.has('a')).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    expect(harness.questions.answer('a', 'claude-code', 'q', { answers: {} })).toBe(true);
    expect(await pending).toEqual({ answers: {} });
  });
});
