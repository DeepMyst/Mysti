import { afterEach, expect, it, vi } from 'vitest';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { ConversationManager } from '../../src/managers/ConversationManager';
import { clearMockConfig } from '../helpers/mockVscode';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  const store = new Map<string, unknown>();
  const manager = new ConversationManager({ globalState: {
    get: (key: string) => store.get(key),
    update: async (key: string, value: unknown) => { store.set(key, JSON.parse(JSON.stringify(value))); },
  } } as any);
  const first = manager.getCurrentConversation()!;
  const second = manager.createNewConversation();
  const third = manager.createNewConversation();
  const panel = (id: string, conversationId: string) => ({ id, currentConversationId: conversationId, webview: {} });
  const panels = new Map([
    ['a', panel('a', first.id)], ['b', panel('b', first.id)], ['c', panel('c', second.id)],
  ]);
  const providers = { clearSession: vi.fn(), cancelRequest: vi.fn(), getAllProviderIds: () => [] };
  const lifecycle = { markIdle: vi.fn(), removeSession: vi.fn() };
  const title = deferred<string>();
  const host = Object.assign(Object.create(ChatViewProvider.prototype), {
    _panelStates: panels, _conversationManager: manager, _providerManager: providers,
    _dictationManager: { cancelPanel: vi.fn(async () => {}) },
    _suggestionManager: { generateTitle: vi.fn(() => title.promise) },
    _mystiRunGen: new Map(), _cancelledPanels: new Set(), _runningPanels: new Set(['a', 'b', 'c']),
    _delayedChannelTurns: { cancelPanel: vi.fn() }, _channelBridge: { clearQueuedMessages: vi.fn() },
    _brainstormManager: { cancelSession: vi.fn(), clearSession: vi.fn() },
    _collaborationManager: { cancelPanel: vi.fn() }, _sessionManager: { cancelPanel: vi.fn() },
    _mentionRouter: { cancelSubAgents: vi.fn() }, _subAgentQuestions: { cancelPanel: vi.fn() },
    _pendingPlans: { clearPanel: vi.fn() }, _pendingPlanSelections: new Set(),
    _backgroundJobManager: { listAll: () => [] },
    _permissionManager: { clearSessionUpgrade: vi.fn() }, _lifecycleManager: lifecycle,
    _compactionManager: { resetUsage: vi.fn() }, _engagementManager: { trackConversationStarted: () => [] },
    _abortMystiDirect: vi.fn(), _emitBadgeUnlocks: vi.fn(), _postToPanel: vi.fn(), postMessage: vi.fn(),
  });
  const switchTo = (id: string) => host._handleMessage({ type: 'switchConversation', panelId: 'a', payload: { id } });
  const remove = (id: string, panelId = 'a') => host._handleMessage({ type: 'deleteConversation', panelId, payload: { id } });
  return { host, manager, panels, providers, first, second, third, title, switchTo, remove };
}

afterEach(() => { clearMockConfig(); vi.restoreAllMocks(); });

it('the New Conversation command resets the active panel and leaves sibling chats running', async () => {
  const h = harness(); h.host._lastActivePanelId = 'b'; h.host._sidebarId = 'a';
  await h.host.newConversation();
  const currentId = h.panels.get('b')!.currentConversationId;
  expect(currentId).not.toBe(h.first.id);
  expect(h.panels.get('a')!.currentConversationId).toBe(h.first.id);
  expect(h.panels.get('c')!.currentConversationId).toBe(h.second.id);
  expect(h.providers.cancelRequest.mock.calls).toEqual([['b']]);
  expect(h.host._postToPanel).toHaveBeenCalledWith('b', { type: 'conversationChanged', payload: h.manager.getConversation(currentId) });
  expect(h.host.postMessage).not.toHaveBeenCalled();
});

it('the New Conversation command opens a chat when no existing panel can own it', async () => {
  const h = harness(); h.panels.clear(); h.host.openInNewTab = vi.fn();
  h.host._lastActivePanelId = 'closed-tab'; h.host._sidebarId = 'sidebar';
  await h.host.newConversation();
  expect(h.host.openInNewTab).toHaveBeenCalledOnce();
  expect(h.host.postMessage).not.toHaveBeenCalled();
});

it('the New Conversation command follows the active editor chat, not the last sender', async () => {
  const h = harness(); h.host._lastActivePanelId = 'a'; h.host._sidebarId = 'a';
  Object.assign(h.panels.get('a')!, { panel: { active: false } });
  Object.assign(h.panels.get('b')!, { panel: { active: true } });
  await h.host.newConversation();
  expect(h.panels.get('a')!.currentConversationId).toBe(h.first.id);
  expect(h.panels.get('b')!.currentConversationId).not.toBe(h.first.id);
  expect(h.providers.cancelRequest.mock.calls).toEqual([['b']]);
});

it.each(['new chat', 'new send', 'replaced panel'] as const)('a delayed history switch cannot replace a %s', async action => {
  const h = harness(); const wait = deferred();
  h.host._dictationManager.cancelPanel.mockReturnValueOnce(wait.promise);
  const pending = h.switchTo(h.second.id);
  if (action === 'new chat') await h.host._handleNewConversation('a');
  else if (action === 'new send') h.host._mystiRunGen.set('a', 1);
  else h.panels.set('a', { ...h.panels.get('a')!, currentConversationId: h.third.id });
  const expectedId = h.panels.get('a')!.currentConversationId;
  h.providers.cancelRequest.mockClear(); h.host._postToPanel.mockClear();
  wait.resolve(); await pending;
  expect(h.panels.get('a')!.currentConversationId).toBe(expectedId);
  expect(h.providers.cancelRequest).not.toHaveBeenCalled();
  expect(h.host._postToPanel).not.toHaveBeenCalled();
});

it('selecting the current history row supersedes an older pending navigation', async () => {
  const h = harness(); const wait = deferred();
  h.host._dictationManager.cancelPanel.mockReturnValueOnce(wait.promise);
  const pending = h.switchTo(h.second.id);
  await h.switchTo(h.first.id);
  wait.resolve(); await pending;
  expect(h.panels.get('a')!.currentConversationId).toBe(h.first.id);
  expect(h.providers.cancelRequest).not.toHaveBeenCalled();
});

it('selecting the current history row supersedes a pending New Chat', async () => {
  const h = harness(); const wait = deferred(); const before = h.manager.getAllConversations().length;
  h.host._dictationManager.cancelPanel.mockReturnValueOnce(wait.promise);
  const pending = h.host._handleNewConversation('a');
  await h.switchTo(h.first.id);
  wait.resolve(); await pending;
  expect(h.panels.get('a')!.currentConversationId).toBe(h.first.id);
  expect(h.manager.getAllConversations()).toHaveLength(before);
});

it('a target deleted during dictation cancellation cannot be reopened', async () => {
  const h = harness(); const wait = deferred();
  h.host._dictationManager.cancelPanel.mockReturnValueOnce(wait.promise);
  const pending = h.switchTo(h.second.id);
  h.manager.deleteConversation(h.second.id);
  wait.resolve(); await pending;
  expect(h.panels.get('a')!.currentConversationId).toBe(h.first.id);
  expect(h.providers.cancelRequest).not.toHaveBeenCalled();
});

it('deleting a chat stops every panel viewing it and preserves unrelated work', async () => {
  const h = harness();
  h.manager.addMessageToConversation(h.second.id, 'assistant', 'KEEP_OTHER_CHAT');
  const otherBefore = JSON.stringify(h.manager.getConversation(h.second.id));
  await h.remove(h.first.id, 'c');
  expect(h.manager.getConversation(h.first.id)).toBeNull();
  for (const id of ['a', 'b']) {
    expect(h.providers.clearSession).toHaveBeenCalledWith(id, { allProviders: true });
    expect(h.providers.cancelRequest).toHaveBeenCalledWith(id);
    expect(h.panels.get(id)!.currentConversationId).not.toBe(h.first.id);
    expect(h.manager.getConversation(h.panels.get(id)!.currentConversationId)).not.toBeNull();
    expect(h.host._runningPanels.has(id)).toBe(false);
  }
  expect(h.providers.cancelRequest).not.toHaveBeenCalledWith('c');
  expect(h.host._runningPanels.has('c')).toBe(true);
  expect(JSON.stringify(h.manager.getConversation(h.second.id))).toBe(otherBefore);
  expect(h.panels.get('c')!.currentConversationId).toBe(h.second.id);
});

it('deleting the last chat leaves one replacement instead of duplicate empty history', async () => {
  const h = harness();
  h.panels.delete('b'); h.panels.delete('c');
  h.manager.deleteConversation(h.second.id); h.manager.deleteConversation(h.third.id);
  expect(h.manager.getAllConversations()).toHaveLength(1);
  await h.remove(h.first.id);
  expect(h.manager.getAllConversations()).toHaveLength(1);
  expect(h.manager.getConversation(h.panels.get('a')!.currentConversationId)).not.toBeNull();
});

it('a stale missing delete request cannot cancel a valid active chat', async () => {
  const h = harness(); const before = JSON.stringify(h.manager.getAllConversations());
  await h.remove('already-deleted');
  expect(JSON.stringify(h.manager.getAllConversations())).toBe(before);
  expect(h.providers.cancelRequest).not.toHaveBeenCalled();
});

it.each(['switch', 'delete'] as const)('late automatic titles stay with their original conversation after %s', async action => {
  const h = harness(); const secondBefore = JSON.stringify(h.second);
  const pending = h.host._generateTitleAsync(h.first.id, 'Repair payment retries', 'a');
  if (action === 'switch') await h.switchTo(h.second.id);
  else await h.remove(h.first.id);
  h.title.resolve('Payment retry repair'); await pending;
  expect(JSON.stringify(h.manager.getConversation(h.second.id))).toBe(secondBefore);
  if (action === 'delete') expect(h.manager.getConversation(h.first.id)).toBeNull();
  else expect(h.manager.getConversation(h.first.id)?.title).toBe('Payment retry repair');
});
