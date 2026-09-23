/** Mysti - AI Coding Agent. SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import { MentionRetryStore, type MentionTurn } from '../../src/chat/MentionRetryStore';

const turn = (content: string, conversationId: string | null = 'c1'): MentionTurn => ({
  content, context: [], settings: {} as MentionTurn['settings'], conversationId,
  mentions: [
    { type: 'file', value: 'openai-codex', displayName: 'openai-codex', startIndex: 0, endIndex: 1 },
    { type: 'agent', value: 'openai-codex', displayName: '@codex', startIndex: 2, endIndex: 8 },
  ],
});

describe('mention retry store', () => {
  it('resolves a click to its own turn, panel, conversation and agent mention', () => {
    const store = new MentionRetryStore();
    const a = store.record('p', turn('A'));
    store.record('p', turn('B'));
    expect(store.claim('p', { retryId: a, agentId: 'openai-codex' }, 'c1')).toMatchObject({
      id: a, turn: { content: 'A' }, mention: { type: 'agent' },
    });
    expect(store.claim('other', { retryId: a, agentId: 'openai-codex' }, 'c1')).toBeUndefined();
    expect(store.claim('p', { retryId: a, agentId: 'openai-codex' }, 'c2')).toBeUndefined();
    expect(store.claim('p', { retryId: a, agentId: 'claude-code' }, 'c1')).toBeUndefined();
    expect(store.claim('p', { retryId: 'bad id!', agentId: 'openai-codex' }, 'c1')).toBeUndefined();
    expect(store.claim('p', null, 'c1')).toBeUndefined();
  });

  it('keeps a bounded window per panel and forgets a cleared panel', () => {
    const store = new MentionRetryStore();
    const ids = Array.from({ length: 9 }, (_, i) => store.record('p', turn(String(i))));
    const click = (id: string) => store.claim('p', { retryId: id, agentId: 'openai-codex' }, 'c1');
    expect(click(ids[0])).toBeUndefined();
    expect(click(ids[1])?.turn.content).toBe('1');
    store.clearPanel('p');
    expect(click(ids[8])).toBeUndefined();
  });
});
