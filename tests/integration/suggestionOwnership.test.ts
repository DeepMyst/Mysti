import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { clearMockConfig, setMockConfig } from '../helpers/mockVscode';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const answer = { id: 'answer', role: 'assistant', content: 'Owned cache explanation' };
const suggestions = [{ title: 'Review expiration', message: 'Explain the cache lifetime.' }];
let host: any, panels: Map<string, any>, conversations: Map<string, any>, currentConversationId: string;
const delivered = (panel: any) => panel.webview.postMessage.mock.calls.map(([message]: any[]) => message)
  .filter((message: any) => ['suggestionsReady', 'suggestionsError'].includes(message.type));
beforeEach(() => {
  clearMockConfig(); setMockConfig('showSuggestions', true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  panels = new Map(['a', 'b'].map(id => [id, { id, currentConversationId: `chat-${id}`,
    webview: { postMessage: vi.fn(async () => true) } }]));
  conversations = new Map(['a', 'b', 'other'].map(id => [`chat-${id}`, { id: `chat-${id}`, messages: [answer] }]));
  currentConversationId = 'chat-a';
  host = Object.assign(Object.create(ChatViewProvider.prototype), {
    _panelStates: panels, _mystiRunGen: new Map(), _brainstormPreparations: new Map(), _cancelledPanels: new Set(), _pendingPlanSelections: new Set(),
    _suggestionManager: { generateSuggestions: vi.fn() }, _mirrorToHub: vi.fn(),
    _conversationManager: { getConversation: (id: string) => conversations.get(id),
      getCurrentConversation: () => conversations.get(currentConversationId),
      createNewConversation: () => { const value = { id: 'new-chat', messages: [] }; conversations.set(value.id, value); return value; } },
    _delayedChannelTurns: { capture: () => () => true, dispose: vi.fn() },
    _pendingPlans: { clearPanel: vi.fn(), capture: () => () => true, dispose: vi.fn() },
    _providerManager: { clearSession: vi.fn(), cancelRequest: vi.fn(), getAllProviderIds: () => [], dispose: vi.fn() },
    _cancelQueuedChannelTurn: vi.fn(), _abortMystiDirect: vi.fn(), _cancelPendingSubAgentQuestions: vi.fn(),
    _brainstormManager: { cancelSession: vi.fn(), clearSession: vi.fn() },
    _collaborationManager: { cancelPanel: vi.fn() }, _sessionManager: { cancelPanel: vi.fn() },
    _mentionRouter: { cancelSubAgents: vi.fn() }, _permissionManager: { clearSessionUpgrade: vi.fn() },
    _runningPanels: new Set(), _lifecycleManager: { markIdle: vi.fn(), removeSession: vi.fn() },
    _compactionManager: { resetUsage: vi.fn() }, _emitBadgeUnlocks: vi.fn(),
    _engagementManager: { trackConversationStarted: vi.fn() },
    _nativeApprovalRegistration: { dispose: vi.fn() }, _nativeApprovalCards: { dispose: vi.fn() },
    _subAgentQuestions: { dispose: vi.fn() }, _lastUserMessage: new Map(), _lastMentionContext: new Map(),
    _backgroundJobManager: { dispose: vi.fn() }, _channelBridge: { dispose: vi.fn() },
  });
});
afterEach(() => { clearMockConfig(); vi.restoreAllMocks(); });

describe('PB02-D17 delayed suggestions remain owned by their original panel and turn', () => {
  for (const outcome of ['success', 'error']) {
    for (const change of ['switch', 'reset', 'dispose', 'replace panel', 'replace webview', 'new send', 'reselect history', 'cancel', 'disable', 'delete conversation', 'replace conversation']) {
      it(`drops ${outcome} after ${change}`, async () => {
        const gate = deferred<typeof suggestions>(), original = panels.get('a');
        host._suggestionManager.generateSuggestions.mockReturnValueOnce(gate.promise);
        const pending = host._generateSuggestionsAsync(answer, 'a');
        expect(original.webview.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'suggestionsLoading' });
        let releaseSend: (() => Promise<void>) | undefined;
        if (change === 'switch') await host._handleSwitchConversation('a', 'chat-other');
        else if (change === 'reset') await host._handleNewConversation('a');
        else if (change === 'dispose') host.dispose();
        else if (change === 'replace panel') panels.set('a', { ...original, webview: { postMessage: vi.fn() } });
        else if (change === 'replace webview') original.webview = { postMessage: vi.fn() };
        else if (change === 'reselect history') await host._handleSwitchConversation('a', 'chat-a');
        else if (change === 'cancel') host._cancelledPanels.add('a');
        else if (change === 'disable') setMockConfig('showSuggestions', false);
        else if (change === 'delete conversation') conversations.delete('chat-a');
        else if (change === 'replace conversation') conversations.set('chat-a', { id: 'chat-a', messages: [] });
        else {
          // Execute the real send entry through its generation bump, then hold
          // settings persistence so no provider/network work can begin.
          const settings = deferred<void>(); original.pendingSettingsUpdates = new Set([settings.promise]);
          const sending = host._handleSendMessageForTurn({ content: 'Next task', context: [], settings: {} }, 'a', () => {});
          releaseSend = async () => { host._cancelledPanels.add('a'); settings.resolve(); await sending; };
        }
        if (outcome === 'success') gate.resolve(suggestions); else gate.reject(new Error('OLD_HELPER_ERROR'));
        await pending;
        expect(delivered(original)).toEqual([]);
        for (const panel of panels.values()) expect(delivered(panel)).toEqual([]);
        expect(host._mirrorToHub.mock.calls.filter(([, message]: any[]) =>
          ['suggestionsReady', 'suggestionsError'].includes(message.type))).toEqual([]);
        await releaseSend?.();
      });
    }

    it(`a superseded operation's ${outcome} cannot overwrite the newer suggestions`, async () => {
      const first = deferred<typeof suggestions>(), second = deferred<typeof suggestions>();
      host._suggestionManager.generateSuggestions.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const older = host._generateSuggestionsAsync(answer, 'a');
      const newer = host._generateSuggestionsAsync({ ...answer, id: 'new-answer' }, 'a');
      second.resolve(suggestions); await newer;
      if (outcome === 'success') first.resolve([{ title: 'STALE', message: 'STALE' }]); else first.reject(new Error('OLD_HELPER_ERROR'));
      await older;
      expect(delivered(panels.get('a'))).toEqual([{ type: 'suggestionsReady', payload: { suggestions } }]);
      expect(delivered(panels.get('b'))).toEqual([]);
    });

    it(`delivers the current ${outcome} only to its owner while another panel changes`, async () => {
      const gate = deferred<typeof suggestions>(); host._suggestionManager.generateSuggestions.mockReturnValueOnce(gate.promise);
      const pending = host._generateSuggestionsAsync(answer, 'a');
      await host._handleNewConversation('b');
      if (outcome === 'success') gate.resolve(suggestions); else gate.reject(new Error('CURRENT_HELPER_ERROR'));
      await pending;
      expect(delivered(panels.get('a'))).toEqual([outcome === 'success'
        ? { type: 'suggestionsReady', payload: { suggestions } } : { type: 'suggestionsError' }]);
      expect(delivered(panels.get('b'))).toEqual([]);
    });

    it(`an older ${outcome} settling first cannot clear the newer operation's ownership`, async () => {
      const first = deferred<typeof suggestions>(), second = deferred<typeof suggestions>();
      host._suggestionManager.generateSuggestions.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const older = host._generateSuggestionsAsync(answer, 'a');
      const newer = host._generateSuggestionsAsync({ ...answer, id: 'new-answer' }, 'a');
      if (outcome === 'success') first.resolve([{ title: 'STALE', message: 'STALE' }]); else first.reject(new Error('OLD_HELPER_ERROR'));
      await older;
      expect(delivered(panels.get('a'))).toEqual([]);
      second.resolve(suggestions); await newer;
      expect(delivered(panels.get('a'))).toEqual([{ type: 'suggestionsReady', payload: { suggestions } }]);
    });

    for (const change of [false, true]) it(`legacy current-conversation ${outcome} ${change ? 'is dropped after switching' : 'still delivers when current'}`, async () => {
      const gate = deferred<typeof suggestions>(); host._suggestionManager.generateSuggestions.mockReturnValueOnce(gate.promise);
      const pending = host._generateSuggestionsAsync(answer);
      if (change) currentConversationId = 'chat-other';
      if (outcome === 'success') gate.resolve(suggestions); else gate.reject(new Error('LEGACY_HELPER_ERROR'));
      await pending;
      for (const panel of panels.values()) expect(delivered(panel)).toEqual(change ? [] : [outcome === 'success'
        ? { type: 'suggestionsReady', payload: { suggestions } } : { type: 'suggestionsError' }]);
    });
  }

  it('does not start a helper for a panel that has already closed', async () => {
    panels.delete('a'); await host._generateSuggestionsAsync(answer, 'a');
    expect(host._suggestionManager.generateSuggestions).not.toHaveBeenCalled();
    expect(delivered(panels.get('b'))).toEqual([]);
  });
});
