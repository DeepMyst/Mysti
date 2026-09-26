import { describe, expect, it, vi } from 'vitest';
import { SubAgentQuestionBroker, parseSubAgentResponse } from '../../src/chat/SubAgentQuestionBroker';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import type { AskUserQuestionData, SubAgentQuestionCallback, WebviewMessage } from '../../src/types';

describe('sub-agent question ownership', () => {
  it('keeps identical tool IDs from different agents independent', async () => {
    const broker = new SubAgentQuestionBroker();
    const first = broker.wait('panel', 'claude-code', 'question-1');
    const second = broker.wait('panel', 'openai-codex', 'question-1');
    const answer = { answers: { Language: 'TypeScript' } };
    expect(broker.answer('panel', 'claude-code', 'question-1', answer)).toBe(true);
    expect(await first).toEqual(answer);
    expect(broker.answer('panel', 'openai-codex', 'question-1', null)).toBe(true);
    expect(await second).toBeNull();
  });

  it('cancels only an exact panel, including IDs that share a prefix', async () => {
    const broker = new SubAgentQuestionBroker();
    const first = broker.wait('panel', 'agent', 'q');
    const second = broker.wait('panel-child', 'agent', 'q');
    broker.cancelPanel('panel');
    expect(await first).toBeNull();
    expect(broker.answer('panel-child', 'agent', 'q', { answers: {} })).toBe(true);
    expect(await second).toEqual({ answers: {} });
  });

  it('does not collide when delimiters occur inside IDs', async () => {
    const broker = new SubAgentQuestionBroker();
    const first = broker.wait('panel-a', 'agent', 'b');
    const second = broker.wait('panel', 'agent', 'a-b');
    broker.cancelPanel('panel-a');
    expect(await first).toBeNull();
    expect(broker.answer('panel', 'agent', 'a-b', null)).toBe(true);
    expect(await second).toBeNull();
  });

  it('does not strand a caller when a backend repeats a question', async () => {
    const broker = new SubAgentQuestionBroker();
    const first = broker.wait('panel', 'agent', 'q');
    const second = broker.wait('panel', 'agent', 'q');
    broker.answer('panel', 'agent', 'q', { answers: {} });
    expect(await Promise.all([first, second])).toEqual([{ answers: {} }, { answers: {} }]);
    expect(broker.answer('panel', 'agent', 'q', null)).toBe(false);
  });

  it('settles every pending caller on disposal and refuses new waits', async () => {
    const broker = new SubAgentQuestionBroker();
    const pending = [broker.wait('a', 'one', 'q'), broker.wait('b', 'two', 'q')];
    broker.dispose();
    broker.dispose();
    expect(await Promise.all(pending)).toEqual([null, null]);
    expect(await broker.wait('a', 'one', 'q')).toBeNull();
  });
});

describe('sub-agent response validation', () => {
  it.each([null, [], {}, { agentId: 'a' }, { agentId: 'a', toolCallId: 'q', answers: [] },
    { agentId: 'a', toolCallId: 'q', answers: { Header: 42 } },
    { agentId: 'a', toolCallId: 'q', answers: { Header: ['ok', false] } }])(
    'rejects malformed responses: %j', payload => {
      expect(parseSubAgentResponse(payload, false)).toBeNull();
    },
  );

  it('accepts free text, multiple selections, and a skip without answers', () => {
    const payload = { agentId: 'a', toolCallId: 'q', answers: { One: 'text', Two: ['x', 'y'] } };
    expect(parseSubAgentResponse(payload, false)?.answer).toEqual({ answers: payload.answers });
    expect(parseSubAgentResponse({ agentId: 'a', toolCallId: 'q' }, true)?.answer).toBeNull();
  });
});

describe('chat question integration', () => {
  function harness() {
    const broker = new SubAgentQuestionBroker();
    const post = vi.fn(async (_message: unknown) => true);
    const webview = { postMessage: post };
    const otherWebview = { postMessage: post };
    const panels = new Map([['panel', { webview }], ['other', { webview: otherWebview }]]);
    const cancelled = new Set<string>();
    const provider = Object.assign(Object.create(ChatViewProvider.prototype), {
      _subAgentQuestions: broker, _panelStates: panels, _cancelledPanels: cancelled,
      _postToPanel: post, _sidebarId: 'panel',
    }) as {
      _createSubAgentQuestionCallback(panelId: string): SubAgentQuestionCallback;
      _receivePanelMessage(message: unknown, panelId: string, sender: unknown): Promise<void>;
    };
    const question: AskUserQuestionData = { toolCallId: 'q', questions: [] };
    const deliveryId = (index: number) => (post.mock.calls[index][0] as {
      payload: { questionData: AskUserQuestionData };
    }).payload.questionData.toolCallId;
    return { broker, panels, cancelled, post, provider, question, webview, otherWebview, deliveryId };
  }

  it('answers only the actual sending panel even when the payload names another panel', async () => {
    const h = harness();
    const first = h.provider._createSubAgentQuestionCallback('panel')('claude-code', h.question);
    const second = h.provider._createSubAgentQuestionCallback('other')('claude-code', h.question);
    await h.provider._receivePanelMessage({
      type: 'subAgentQuestionResponse', panelId: 'other',
      payload: { agentId: 'claude-code', toolCallId: h.deliveryId(0), answers: { Choice: 'yes' } },
    }, 'panel', h.webview);
    expect(await first).toEqual({ answers: { Choice: 'yes' } });
    expect(h.broker.answer('other', 'claude-code', h.deliveryId(1), null)).toBe(true);
    expect(await second).toBeNull();
  });

  it('settles a pending caller when posting the question fails', async () => {
    const h = harness();
    h.post.mockImplementation(() => { throw new Error('webview disposed'); });
    expect(await h.provider._createSubAgentQuestionCallback('panel')('claude-code', h.question)).toBeNull();
  });

  it.each(['rejected', 'undelivered'])('settles a caller after asynchronous %s delivery', async kind => {
    const h = harness();
    h.post.mockImplementation(() => kind === 'rejected'
      ? Promise.reject(new Error('webview closed')) : Promise.resolve(false));
    expect(await h.provider._createSubAgentQuestionCallback('panel')('claude-code', h.question)).toBeNull();
  });

  it('rejects callbacks and cards retained by a cancelled turn', async () => {
    const h = harness();
    const oldCallback = h.provider._createSubAgentQuestionCallback('panel');
    const oldAnswer = oldCallback('claude-code', h.question);
    h.broker.cancelPanel('panel');
    expect(await oldAnswer).toBeNull();
    const current = h.provider._createSubAgentQuestionCallback('panel')('claude-code', h.question);
    expect(await oldCallback('claude-code', h.question)).toBeNull();
    expect(h.post).toHaveBeenCalledTimes(2);
    expect(h.deliveryId(0)).not.toBe(h.deliveryId(1));
    await h.provider._receivePanelMessage({ type: 'subAgentQuestionResponse', payload: {
      agentId: 'claude-code', toolCallId: h.deliveryId(0), answers: { Choice: 'stale' },
    } }, 'panel', h.webview);
    expect(h.broker.answer('panel', 'claude-code', h.deliveryId(1), { answers: { Choice: 'current' } })).toBe(true);
    expect(await current).toEqual({ answers: { Choice: 'current' } });
  });

  it('ignores the listener of a replaced sidebar webview', async () => {
    const h = harness();
    const dispatch = vi.fn();
    Object.assign(h.provider, { _handleMessage: dispatch });
    h.panels.set('panel', { webview: h.otherWebview });
    await h.provider._receivePanelMessage({ type: 'newConversation' }, 'panel', h.webview);
    expect(dispatch).not.toHaveBeenCalled();
    await h.provider._receivePanelMessage({ type: 'newConversation' }, 'panel', h.otherWebview);
    expect(dispatch).toHaveBeenCalledWith({ type: 'newConversation', panelId: 'panel' });
  });

  it('contains asynchronous handler failures and reports them only to the sender', async () => {
    const h = harness();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    Object.assign(h.provider, { _handleMessage: vi.fn().mockRejectedValue(new TypeError('private data')) });
    try {
      await expect(h.provider._receivePanelMessage({ type: 'sendMessage' }, 'panel', h.webview)).resolves.toBeUndefined();
      expect(h.post).toHaveBeenCalledWith({ type: 'error', payload: expect.any(String) });
      expect(JSON.stringify(log.mock.calls)).not.toContain('private data');
      h.post.mockRejectedValue(new Error('closed'));
      await expect(h.provider._receivePanelMessage({ type: 'sendMessage' }, 'panel', h.webview)).resolves.toBeUndefined();
    } finally { log.mockRestore(); }
  });

  it('does not wait for an answer from a closed or cancelled panel', async () => {
    const h = harness();
    h.panels.delete('panel');
    h.cancelled.add('other');
    for (const panelId of ['panel', 'other']) {
      expect(await h.provider._createSubAgentQuestionCallback(panelId)('claude-code', h.question)).toBeNull();
    }
    expect(h.post).not.toHaveBeenCalled();
  });

  it('rejects malformed messages and messages from a disposed panel', async () => {
    const h = harness();
    const dispatch = vi.fn();
    Object.assign(h.provider, { _handleMessage: dispatch });
    for (const message of [null, undefined, [], 1, 'sendMessage', {}, { type: 42 }]) {
      await h.provider._receivePanelMessage(message, 'panel', h.webview);
    }
    await h.provider._receivePanelMessage({ type: 'sendMessage' }, 'gone', h.webview);
    expect(dispatch).not.toHaveBeenCalled();
    await h.provider._receivePanelMessage({ type: 'ready', panelId: null } as unknown as WebviewMessage, 'other', h.otherWebview);
    expect(dispatch).toHaveBeenCalledWith({ type: 'ready', panelId: 'other' });
  });
});
