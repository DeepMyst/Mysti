import { afterEach, expect, it, vi } from 'vitest';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import type { AskUserQuestionData } from '../../src/types';
import { clearMockConfig, setMockConfig } from '../helpers/mockVscode';

function harness() {
  vi.useFakeTimers();
  const panels = new Map(['a', 'b'].map(id => [id, { id, webview: {}, currentConversationId: `chat-${id}` }]));
  const host = Object.assign(Object.create(ChatViewProvider.prototype), {
    _panelStates: panels, _sidebarId: 'a', _cancelledPanels: new Set(), _mystiRunGen: new Map(),
    _pendingAskUserQuestions: new Map(), _pendingQuestionData: new Map(), _semiAutoQuestionTimeouts: new Map(),
    _lastSendSettings: new Map(),
    _subAgentQuestions: { cancelPanel: vi.fn() },
    _autonomousManager: { isActive: () => false, generateAutoAnswer: () => null },
    _isSemiAutonomousEnabled: () => true, _getSemiAutonomousTimeout: () => 30,
    _memoryManager: { learnFromQuestionAnswer: vi.fn() },
    _getPanelModel: (id: string) => `model-${id}`, _getPanelProvider: (id: string) => id === 'a' ? 'claude-code' : 'openai-codex',
    _contextManager: { getContext: (id: string) => [{ content: `context-${id}` }] },
    _postToPanel: vi.fn(), _handleSendMessage: vi.fn(async () => {}),
  });
  const question = (text: string): AskUserQuestionData => ({ toolCallId: 'native-1', source: 'detected', questions: [
    { question: text, header: 'Choice', options: [{ label: text, description: '' }], multiSelect: false },
  ] });
  const show = async (panel: string, text: string) => {
    const original = question(text);
    await host._handleDetectedQuestions(original, panel);
    const delivered = host._postToPanel.mock.calls.filter(([id, m]: any[]) => id === panel && m.type === 'askUserQuestion').at(-1)![1].payload;
    return { original, id: delivered.toolCallId };
  };
  const answer = (panel: string, id: string, skip = false, sender = panels.get(panel)!.webview) => host._receivePanelMessage({
    type: skip ? 'askUserQuestionSkipped' : 'askUserQuestionResponse', panelId: panel === 'a' ? 'b' : 'a',
    payload: { toolCallId: id, answers: { Choice: `answer-${panel}` } },
  }, panel, sender);
  return { host, panels, show, answer };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); clearMockConfig(); });

it.each([{ bad: true }, [null], [{ question: 'Choose a retry cap', options: 'invalid' }]])(
  'PB-01 invalid question shape cannot create invisible pending ownership: %j', questions => {
    const h = harness();
    h.host._showPendingQuestion('a', { toolCallId: 'malformed', source: 'tool', questions } as any);
    expect(h.host._pendingAskUserQuestions.size).toBe(0); expect(h.host._pendingQuestionData.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.host._postToPanel.mock.calls.filter(([, message]: any[]) => message.type === 'askUserQuestion')).toEqual([]);
    expect(h.host._postToPanel).toHaveBeenCalledWith('a', expect.objectContaining({ type: 'error', payload: expect.stringMatching(/invalid.*question.*retry/i) }));
  },
);

it('equal backend IDs preserve each panel question, memory, context and selected agent', async () => {
  const h = harness(); const a = await h.show('a', 'A private choice'); const b = await h.show('b', 'B private choice');
  await h.answer('a', a.id); await h.answer('b', b.id);
  expect(h.host._memoryManager.learnFromQuestionAnswer.mock.calls.map(([q]: any[]) => q.questions[0].question))
    .toEqual(['A private choice', 'B private choice']);
  expect(h.host._handleSendMessage.mock.calls.map(([p, id]: any[]) => [id, p.settings.provider, p.settings.model, p.context[0].content]))
    .toEqual([['a', 'claude-code', 'model-a', 'context-a'], ['b', 'openai-codex', 'model-b', 'context-b']]);
  expect(h.host._pendingQuestionData.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])('a sibling cannot consume another panel question (skip=%s)', async skip => {
  const h = harness(); const a = await h.show('a', 'A');
  await h.answer('b', a.id, skip);
  expect(h.host._handleSendMessage).not.toHaveBeenCalled();
  expect(h.host._pendingAskUserQuestions.get('a')).toBe(a.id);
  await h.answer('a', a.id);
  expect(h.host._handleSendMessage).toHaveBeenCalledOnce();
});

it.each([false, true])('an answer/skip is accepted once (skip=%s)', async skip => {
  const h = harness(); const a = await h.show('a', 'A');
  await h.answer('a', a.id, skip); await h.answer('a', a.id, skip);
  expect(h.host._handleSendMessage).toHaveBeenCalledOnce();
});

it('a saved card cannot answer a replacement reusing the same backend ID', async () => {
  const h = harness(); const old = await h.show('a', 'OLD'); const fresh = await h.show('a', 'FRESH');
  await h.answer('a', old.id);
  expect(h.host._handleSendMessage).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
  await h.answer('a', fresh.id);
  expect(h.host._memoryManager.learnFromQuestionAnswer).toHaveBeenCalledWith(fresh.original, { Choice: 'answer-a' });
});

it('panel cancellation discards its question and timer while a sibling still times out', async () => {
  const h = harness(); const a = await h.show('a', 'A'); await h.show('b', 'B');
  h.host._cancelPendingSubAgentQuestions('a');
  await h.answer('a', a.id);
  expect(h.host._handleSendMessage).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.host._handleSendMessage.mock.calls.map(([, id]: any[]) => id)).toEqual(['b']);
  expect(h.host._memoryManager.learnFromQuestionAnswer.mock.calls[0][0].questions[0].question).toBe('B');
  expect(h.host._pendingQuestionData.size).toBe(0);
});

it('an already queued old timeout cannot consume a replacement question', async () => {
  const h = harness(); const old = await h.show('a', 'OLD'); const fresh = await h.show('a', 'FRESH');
  await h.host._handleSemiAutonomousQuestionTimeout('a', old.original, old.id);
  expect(h.host._handleSendMessage).not.toHaveBeenCalled();
  await h.answer('a', fresh.id);
  expect(h.host._handleSendMessage).toHaveBeenCalledOnce();
});

it('a removed panel cannot auto-answer after its deadline', async () => {
  const h = harness(); await h.show('a', 'A'); h.panels.delete('a');
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.host._handleSendMessage).not.toHaveBeenCalled();
});

it('a replaced webview cannot answer the current panel question', async () => {
  const h = harness(); const oldWebview = h.panels.get('a')!.webview;
  h.panels.get('a')!.webview = {};
  const a = await h.show('a', 'A');
  await h.answer('a', a.id, false, oldWebview);
  expect(h.host._handleSendMessage).not.toHaveBeenCalled();
  await h.answer('a', a.id);
  expect(h.host._handleSendMessage).toHaveBeenCalledOnce();
});

it.each(['conversation', 'webview', 'turn', 'state'] as const)('a saved timer is revoked when its %s changes', async change => {
  const h = harness(); await h.show('a', 'OLD');
  const state = h.panels.get('a')!;
  if (change === 'conversation') state.currentConversationId = 'new-chat';
  if (change === 'webview') state.webview = {};
  if (change === 'turn') h.host._mystiRunGen.set('a', 1);
  if (change === 'state') h.panels.set('a', { ...state });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.host._handleSendMessage).not.toHaveBeenCalled();
  expect(h.host._pendingQuestionData.size).toBe(0);
});

it('an explicit tool result retains its native ID when the card uses a delivery ID', async () => {
  const h = harness();
  const question: AskUserQuestionData = { toolCallId: 'native-tool-7', source: 'tool', questions: [
    { question: 'Which retry cap?', header: 'Cap', options: [{ label: '500', description: 'Milliseconds' }], multiSelect: false },
  ] };
  h.host._showPendingQuestion('a', question);
  const delivery = h.host._postToPanel.mock.calls.find(([, m]: any[]) => m.type === 'askUserQuestion')![1].payload.toolCallId;
  expect(delivery).not.toBe(question.toolCallId);
  await h.answer('a', delivery);
  expect(h.host._postToPanel).toHaveBeenCalledWith('a', expect.objectContaining({ type: 'toolResult', payload: expect.objectContaining({ id: 'native-tool-7' }) }));
});

it.each([false, true])('a question continuation preserves its own mode/access/effort despite changed global defaults (skip=%s)', async skip => {
  const h = harness();
  const last = { provider: 'claude-code', model: 'model-a', mode: 'quick-plan', accessLevel: 'read-only',
    effortLevel: 'low', thinkingLevel: 'none', ultracode: false, contextMode: 'manual' };
  h.host._lastSendSettings.set('a', last);
  const a = await h.show('a', 'A');
  setMockConfig('defaultMode', 'edit-automatically'); setMockConfig('accessLevel', 'full-access');
  setMockConfig('defaultEffortLevel', 'high'); setMockConfig('claudeUltracode', true); setMockConfig('autoContext', true);
  await h.answer('a', a.id, skip);
  expect(h.host._handleSendMessage.mock.calls[0][0].settings).toEqual(last);
});

it('changing the selected backend while a question waits still preserves that turn\'s read-only policy', async () => {
  const h = harness();
  h.host._lastSendSettings.set('a', { provider: 'claude-code', mode: 'quick-plan', accessLevel: 'read-only', contextMode: 'manual' });
  const a = await h.show('a', 'A');
  h.host._getPanelProvider = () => 'openai-codex';
  setMockConfig('defaultMode', 'edit-automatically'); setMockConfig('accessLevel', 'full-access');
  await h.answer('a', a.id);
  expect(h.host._handleSendMessage.mock.calls[0][0].settings).toMatchObject({ provider: 'openai-codex', mode: 'quick-plan', accessLevel: 'read-only' });
});

it.each([null, {}, { Choice: 42 }, { Choice: ['ok', false] }])('malformed answers do not consume the question: %j', async answers => {
  const h = harness(); const a = await h.show('a', 'A');
  await h.host._receivePanelMessage({ type: 'askUserQuestionResponse', payload: { toolCallId: a.id, answers } }, 'a', h.panels.get('a')!.webview);
  expect(h.host._handleSendMessage).not.toHaveBeenCalled();
  expect(h.host._pendingAskUserQuestions.get('a')).toBe(a.id);
});
