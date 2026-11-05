import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import { ConversationManager } from '../../src/managers/ConversationManager';
import { clearMockConfig } from '../helpers/mockVscode';

function deferred<T>() {
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
  const source = manager.getCurrentConversation()!;
  const anchor = manager.addMessageToConversation(source.id, 'user', 'Keep retryBaseMs=73; explain attempt zero');
  manager.updateMessageInConversation(source.id, anchor.id, { checkpoint: { commit: 'a'.repeat(40), createdAt: 1 } });
  manager.addMessageToConversation(source.id, 'assistant', '73 * 2 ** 0 = 73');
  const other = manager.createNewConversation();
  const foreign = manager.addMessageToConversation(other.id, 'user', 'FOREIGN');
  manager.updateMessageInConversation(other.id, foreign.id, { checkpoint: { commit: 'b'.repeat(40), createdAt: 2 } });
  const panels = new Map(['a', 'b'].map(id => [id, {
    id, currentConversationId: id === 'a' ? source.id : other.id, webview: {}, navigationRevision: 0,
  }]));
  const checkpoint = { snapshot: vi.fn(async () => 'c'.repeat(40)), rewindTo: vi.fn(async (_commit: string, _current?: () => boolean) => ({ ok: true, safetyCommit: 'd'.repeat(40) } as { ok: boolean; safetyCommit?: string; reason?: string })) };
  const providers = { clearSession: vi.fn(), cancelRequest: vi.fn(), getAllProviderIds: () => [] };
  const host = Object.assign(Object.create(ChatViewProvider.prototype), {
    _panelStates: panels, _conversationManager: manager, _providerManager: providers, _checkpointManager: checkpoint,
    _dictationManager: { cancelPanel: vi.fn(async () => {}) },
    _mystiRunGen: new Map(), _cancelledPanels: new Set(), _runningPanels: new Set(),
    _delayedChannelTurns: { cancelPanel: vi.fn() }, _channelBridge: { clearQueuedMessages: vi.fn() },
    _brainstormManager: { cancelSession: vi.fn(), clearSession: vi.fn() },
    _collaborationManager: { cancelPanel: vi.fn() }, _sessionManager: { cancelPanel: vi.fn() },
    _mentionRouter: { cancelSubAgents: vi.fn() }, _subAgentQuestions: { cancelPanel: vi.fn() },
    _pendingPlans: { clearPanel: vi.fn() }, _pendingPlanSelections: new Set(),
    _backgroundJobManager: { listAll: () => [] },
    _permissionManager: { clearSessionUpgrade: vi.fn() }, _lifecycleManager: { markIdle: vi.fn(), removeSession: vi.fn() },
    _compactionManager: { resetUsage: vi.fn() }, _engagementManager: { trackConversationStarted: () => [] },
    _abortMystiDirect: vi.fn(), _emitBadgeUnlocks: vi.fn(), _postToPanel: vi.fn(), postMessage: vi.fn(),
  });
  const action = (type = 'forkAndRewind', payload: unknown = { messageId: anchor.id, commit: anchor.checkpoint!.commit }) =>
    host._handleMessage({ type, panelId: 'a', payload });
  const view = () => panels.get('a')!.currentConversationId;
  return { host, manager, source, other, anchor, foreign, panels, checkpoint, providers, action, view };
}

beforeEach(() => {
  vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Rewind' as any);
  vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
  vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
});
afterEach(() => { clearMockConfig(); vi.restoreAllMocks(); });

describe('fork and rewind transaction ownership', () => {
  it('cancelled confirmation preserves active conversation and exact history', async () => {
    const h = harness(); const before = JSON.stringify(h.manager.getAllConversations());
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined);
    await h.action();
    expect(h.view()).toBe(h.source.id);
    expect(JSON.stringify(h.manager.getAllConversations())).toBe(before);
    expect(h.providers.cancelRequest).not.toHaveBeenCalled();
    expect(h.checkpoint.rewindTo).not.toHaveBeenCalled();
  });

  it('an unavailable checkpoint cannot create a misleading branch', async () => {
    const h = harness(); const before = JSON.stringify(h.manager.getAllConversations());
    h.checkpoint.rewindTo.mockResolvedValue({ ok: false, reason: 'Checkpoint no longer exists.' });
    await h.action();
    expect(h.view()).toBe(h.source.id);
    expect(JSON.stringify(h.manager.getAllConversations())).toBe(before);
    expect(h.host._postToPanel.mock.calls.some(([, m]: any) => m.type === 'conversationChanged')).toBe(false);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('no longer exists'));
  });

  it('fork-and-rewind without a checkpoint does not silently perform fork-only', async () => {
    const h = harness(); const before = JSON.stringify(h.manager.getAllConversations());
    await h.action('forkAndRewind', { messageId: h.anchor.id });
    expect(h.view()).toBe(h.source.id);
    expect(JSON.stringify(h.manager.getAllConversations())).toBe(before);
    expect(h.checkpoint.rewindTo).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'foreign message', payload: (h: ReturnType<typeof harness>) => ({ messageId: h.foreign.id, commit: h.foreign.checkpoint!.commit }) },
    { name: 'mismatched commit', payload: (h: ReturnType<typeof harness>) => ({ messageId: h.anchor.id, commit: h.foreign.checkpoint!.commit }) },
    { name: 'missing message', payload: () => ({ commit: 'a'.repeat(40) }) },
    { name: 'malformed payload', payload: () => null },
  ])('rejects $name before confirmation or disk access', async ({ payload }) => {
    const h = harness(); const before = JSON.stringify(h.manager.getAllConversations());
    await h.action('rewindToCheckpoint', payload(h));
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(h.checkpoint.rewindTo).not.toHaveBeenCalled();
    expect(JSON.stringify(h.manager.getAllConversations())).toBe(before);
  });

  it.each(['navigation', 'new turn', 'same-chat navigation', 'close', 'replacement', 'deleted source'] as const)(
    'confirmation arriving after %s cannot rewind or fork', async kind => {
      const h = harness(); const prompt = deferred<any>();
      vi.mocked(vscode.window.showWarningMessage).mockReturnValueOnce(prompt.promise);
      const pending = h.action();
      if (kind === 'navigation') await h.host._handleSwitchConversation('a', h.other.id);
      else if (kind === 'new turn') h.host._mystiRunGen.set('a', 99);
      else if (kind === 'same-chat navigation') h.panels.get('a')!.navigationRevision++;
      else if (kind === 'close') h.panels.delete('a');
      else if (kind === 'replacement') h.panels.set('a', { ...h.panels.get('a')! });
      else h.manager.deleteConversation(h.source.id);
      const before = JSON.stringify(h.manager.getAllConversations());
      const current = h.panels.get('a')?.currentConversationId;
      h.host._postToPanel.mockClear(); h.providers.cancelRequest.mockClear();
      prompt.resolve('Rewind'); await pending;
      expect(h.checkpoint.rewindTo).not.toHaveBeenCalled();
      expect(JSON.stringify(h.manager.getAllConversations())).toBe(before);
      expect(h.panels.get('a')?.currentConversationId).toBe(current);
      expect(h.host._postToPanel).not.toHaveBeenCalled();
      expect(h.providers.cancelRequest).not.toHaveBeenCalled();
    },
  );

  it('duplicate actions while a confirmation is pending execute once', async () => {
    const h = harness(); const prompt = deferred<any>();
    vi.mocked(vscode.window.showWarningMessage).mockReturnValue(prompt.promise);
    const one = h.action(); const two = h.action();
    prompt.resolve('Rewind'); await Promise.all([one, two]);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce();
    expect(h.checkpoint.rewindTo).toHaveBeenCalledOnce();
    expect(h.manager.getAllConversations()).toHaveLength(3);
  });

  it('successful rewind creates only the prefix after disk success and preserves original bytes', async () => {
    const h = harness(); const before = JSON.stringify(h.source); const disk = deferred<any>();
    h.checkpoint.rewindTo.mockReturnValueOnce(disk.promise);
    const pending = h.action(); await vi.waitFor(() => expect(h.checkpoint.rewindTo).toHaveBeenCalledOnce());
    expect(h.view()).toBe(h.source.id);
    expect(h.manager.getAllConversations()).toHaveLength(2);
    disk.resolve({ ok: true, safetyCommit: 'd'.repeat(40) }); await pending;
    expect(h.view()).not.toBe(h.source.id);
    expect(h.manager.getConversation(h.view())!.messages).toEqual([h.anchor]);
    expect(JSON.stringify(h.source)).toBe(before);
    expect(h.panels.get('b')!.currentConversationId).toBe(h.other.id);
    expect(h.providers.cancelRequest).not.toHaveBeenCalledWith('b');
  });

  it('a checkpoint engine exception is reported and preserves the active history', async () => {
    const h = harness(); const before = JSON.stringify(h.manager.getAllConversations());
    h.checkpoint.rewindTo.mockRejectedValueOnce(new Error('test disk denied'));
    await expect(h.action()).resolves.toBeUndefined();
    expect(h.view()).toBe(h.source.id);
    expect(JSON.stringify(h.manager.getAllConversations())).toBe(before);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('test disk denied'));
  });

  it('Undo from a previous conversation cannot mutate a newly opened chat workspace', async () => {
    const h = harness(); const notice = deferred<any>();
    vi.mocked(vscode.window.showInformationMessage).mockReturnValueOnce(notice.promise);
    const pending = h.action('rewindToCheckpoint');
    await vi.waitFor(() => expect(vscode.window.showInformationMessage).toHaveBeenCalledOnce());
    await h.host._handleSwitchConversation('a', h.other.id);
    notice.resolve('Undo'); await pending;
    expect(h.checkpoint.rewindTo).toHaveBeenCalledOnce();
    expect(h.view()).toBe(h.other.id);
  });

  it('fork resets its context usage and stale session indicator', async () => {
    const h = harness();
    await h.action('forkConversation', { messageId: h.anchor.id });
    expect(h.host._compactionManager.resetUsage).toHaveBeenCalledWith('a');
    expect(h.host._lifecycleManager.removeSession).toHaveBeenCalledWith('a');
    expect(h.host._postToPanel).toHaveBeenCalledWith('a', expect.objectContaining({ type: 'sessionCleared' }));
  });

  it('late checkpoint for an original anchor is saved to the original without enabling the fork UI', async () => {
    const h = harness(); const snapshot = deferred<string>();
    delete h.anchor.checkpoint; h.checkpoint.snapshot.mockReturnValueOnce(snapshot.promise);
    h.host._captureCheckpoint('a', h.source.id, h.anchor.id, h.anchor.content);
    await h.action('forkConversation', { messageId: h.anchor.id });
    h.host._postToPanel.mockClear(); snapshot.resolve('c'.repeat(40));
    await vi.waitFor(() => expect(h.anchor.checkpoint?.commit).toBe('c'.repeat(40)));
    expect(h.manager.getConversation(h.view())!.messages[0].checkpoint).toBeUndefined();
    expect(h.host._postToPanel).not.toHaveBeenCalled();
  });

  it('a late checkpoint cannot publish a deleted message or replacement panel', async () => {
    const h = harness(); const snapshot = deferred<string>();
    h.checkpoint.snapshot.mockReturnValueOnce(snapshot.promise);
    h.host._captureCheckpoint('a', h.source.id, h.anchor.id, h.anchor.content);
    h.manager.deleteConversation(h.source.id);
    h.panels.set('a', { ...h.panels.get('a')!, currentConversationId: h.other.id });
    snapshot.resolve('c'.repeat(40)); await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.manager.getConversation(h.source.id)).toBeNull();
    expect(h.host._postToPanel).not.toHaveBeenCalled();
  });
  it('a stale queued action from the original cannot operate on its same-ID fork', async () => {
    const h = harness();
    await h.action('forkConversation', { messageId: h.anchor.id, conversationId: h.source.id });
    const current = h.view(); const before = JSON.stringify(h.manager.getAllConversations());
    await h.action('forkConversation', { messageId: h.anchor.id, conversationId: h.source.id });
    await h.action('forkAndRewind', { messageId: h.anchor.id, commit: h.anchor.checkpoint!.commit, conversationId: h.source.id });
    expect(h.view()).toBe(current);
    expect(JSON.stringify(h.manager.getAllConversations())).toBe(before);
    expect(h.checkpoint.rewindTo).not.toHaveBeenCalled();
  });

  it('rewind stops the visible active response before restoring its files', async () => {
    const h = harness(); const partial = { id: 'partial', role: 'assistant', content: 'Visible progress', timestamp: 1 };
    const stop = vi.fn(() => partial);
    h.host._runningPanels.add('a');
    h.host._responseStops = new Map([['a', { generation: 0, stop }]]);
    h.checkpoint.rewindTo.mockImplementationOnce(async () => {
      expect(stop).toHaveBeenCalledOnce();
      expect(h.host._postToPanel).toHaveBeenCalledWith('a', { type: 'requestCancelled', payload: { message: partial } });
      return { ok: true };
    });
    await h.action('rewindToCheckpoint');
    expect(stop).toHaveBeenCalledOnce();
    expect(h.host._responseStops.has('a')).toBe(false);
  });

  it('rewind refuses to restore shared files while another panel is actively working', async () => {
    const h = harness(); h.host._runningPanels.add('b');
    await h.action('rewindToCheckpoint');
    expect(h.checkpoint.rewindTo).not.toHaveBeenCalled();
    expect(h.providers.cancelRequest).not.toHaveBeenCalled();
    expect(h.host._postToPanel).toHaveBeenCalledWith('a', expect.objectContaining({
      type: 'rewindComplete', payload: expect.objectContaining({ ok: false, reason: expect.stringMatching(/another.*(chat|task)/i) }),
    }));
  });

  it('a late completed disk transaction reports its real effect without activating a stale branch', async () => {
    const h = harness(); const disk = deferred<any>();
    h.checkpoint.rewindTo.mockReturnValueOnce(disk.promise);
    const pending = h.action(); await vi.waitFor(() => expect(h.checkpoint.rewindTo).toHaveBeenCalledOnce());
    const guard = h.checkpoint.rewindTo.mock.calls[0][1];
    expect(guard?.()).toBe(true);
    await h.host._handleSwitchConversation('a', h.other.id);
    expect(guard?.()).toBe(false);
    h.host._postToPanel.mockClear(); disk.resolve({ ok: true, safetyCommit: 'd'.repeat(40) }); await pending;
    expect(h.view()).toBe(h.other.id);
    expect(h.manager.getAllConversations()).toHaveLength(2);
    expect(h.host._postToPanel).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringMatching(/rewound.*conversation changed/i));
  });

  it('an older Undo cannot reverse a newer successful rewind in the same chat', async () => {
    const h = harness(); const firstNotice = deferred<any>();
    vi.mocked(vscode.window.showInformationMessage).mockReturnValueOnce(firstNotice.promise);
    const first = h.action('rewindToCheckpoint');
    await vi.waitFor(() => expect(vscode.window.showInformationMessage).toHaveBeenCalledOnce());
    await h.action('rewindToCheckpoint');
    firstNotice.resolve('Undo'); await first;
    expect(h.checkpoint.rewindTo).toHaveBeenCalledTimes(2);
  });

  it.each(['rewind', 'undo'] as const)('a failed late %s exposes its recovery checkpoint without writing into the new chat', async phase => {
    const h = harness(); const disk = deferred<any>();
    const reason = 'Automatic recovery failed. Workspace files may be partially restored; recovery checkpoint: ' + 'e'.repeat(40);
    if (phase === 'undo') {
      vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce('Undo' as any);
      h.checkpoint.rewindTo.mockResolvedValueOnce({ ok: true, safetyCommit: 'd'.repeat(40) }).mockReturnValueOnce(disk.promise);
    } else { h.checkpoint.rewindTo.mockReturnValueOnce(disk.promise); }
    const pending = h.action('rewindToCheckpoint');
    await vi.waitFor(() => expect(h.checkpoint.rewindTo).toHaveBeenCalledTimes(phase === 'undo' ? 2 : 1));
    await h.host._handleSwitchConversation('a', h.other.id);
    h.host._postToPanel.mockClear(); disk.resolve({ ok: false, reason }); await pending;
    expect(h.view()).toBe(h.other.id);
    expect(h.host._postToPanel).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining(reason));
  });

});
