/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Plan 32: what the host tells the agent map beyond the chat itself: which
 * @agent:role run a collaborator chunk belongs to, and that a delegate
 * writing prose (which is never traced) is still alive.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatViewProvider } from '../../src/providers/ChatViewProvider';
import type { CollaboratorChunk, Settings, WebviewMessage } from '../../src/types';

vi.mock('../../src/webview/webviewContent', () => ({ getWebviewContent: () => '<html></html>' }));

type Trace = (chunk: { type: string; content?: string }) => void;

interface SignalHost {
  _runMentionCollaboration(
    collabMentions: unknown[], allMentions: unknown[], content: string, context: unknown[],
    settings: Settings, conversation: null, panelId: string,
  ): Promise<string>;
  _runMystiDelegations(
    requests: Array<{ agentId: string; task: string; collaboratorId: string; readOnly: boolean; fold: boolean; trace?: Trace }>,
    settings: Settings, panelId: string, runId: string, cancelKey: string, isCancelled: () => boolean,
  ): Promise<unknown[]>;
  _delegateTracer(panelId: string, parentId: string): Trace;
}

function host(extra: Record<string, unknown> = {}) {
  const posted: WebviewMessage[] = [];
  const h = Object.assign(Object.create(ChatViewProvider.prototype), {
    _cancelledPanels: new Set<string>(),
    _mystiActiveDelegationRuns: new Map(),
    _mentionRouter: { stripMentions: (c: string) => c },
    _providerManager: { getProvider: () => undefined },
    _createSubAgentQuestionCallback: () => undefined,
    _buildDelegationPrompt: (task: string) => task,
    _postToPanel: (_panelId: string, message: WebviewMessage) => { posted.push(message); return true; },
    ...extra,
  }) as SignalHost;
  return { h, posted };
}

const settings = { provider: 'claude-code', mode: 'default', accessLevel: 'ask-permission' } as Settings;

afterEach(() => { vi.useRealTimers(); });

describe('agent map host signals', () => {
  it('names the @agent:role run on every post, so a late run never lands in the next turn', async () => {
    const chunk = { type: 'collab_complete', collaboratorId: '0-claude-code', agentId: 'claude-code', responseText: 'ok' };
    const { h, posted } = host({
      _collaborationManager: {
        async *run() { yield chunk; return { contextBlock: 'block' }; },
      },
    });
    const mention = { type: 'agent', value: 'claude-code', role: 'critic' };

    await h._runMentionCollaboration([mention], [mention], 'x', [], settings, null, 'a');

    const runId = (posted[0].payload as { runId: string }).runId;
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(posted.map(m => m.type)).toEqual(['collaborationStarted', 'collaborator', 'collaborationComplete']);
    expect(posted[1].payload).toEqual({ ...chunk, runId });
    expect(posted[2].payload).toEqual({ runId });
  });

  it('tags a failed run\'s error with its run id', async () => {
    const { h, posted } = host({
      _collaborationManager: {
        // eslint-disable-next-line require-yield
        async *run(): AsyncGenerator<CollaboratorChunk> { throw new Error('boom'); },
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mention = { type: 'agent', value: 'claude-code', role: 'critic' };

    await h._runMentionCollaboration([mention], [mention], 'x', [], settings, null, 'a');

    const runId = (posted[0].payload as { runId: string }).runId;
    expect(posted.find(m => m.type === 'collaborationError')!.payload).toEqual({ runId, message: 'boom' });
  });

  it('turns a CLI delegate\'s streamed text into a content-free progress ping', async () => {
    const trace = vi.fn();
    const { h } = host({
      _collaboratorPool: {
        async *dispatch(): AsyncGenerator<CollaboratorChunk> {
          yield { type: 'collab_text', collaboratorId: 'c1', agentId: 'openai-codex', content: 'secret prose' };
        },
      },
    });

    await h._runMystiDelegations([{ agentId: 'openai-codex', task: 't', collaboratorId: 'c1', readOnly: true, fold: false, trace }],
      settings, 'a', 'r', 'a', () => false);

    expect(trace.mock.calls).toEqual([[{ type: 'progress' }]]);
  });

  it('posts a delegate card\'s progress ping at most once every 5 s, and every other trace as it comes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const { h, posted } = host();
    const card = h._delegateTracer('a', 'card-1');
    const other = h._delegateTracer('a', 'card-2');

    card({ type: 'progress' });
    card({ type: 'progress' });
    card({ type: 'thinking', content: 'hm' });
    other({ type: 'progress' });
    vi.advanceTimersByTime(4_999);
    card({ type: 'progress' });
    vi.advanceTimersByTime(1);
    card({ type: 'progress' });

    expect(posted.map(m => m.payload)).toEqual([
      { parentId: 'card-1', chunk: { type: 'progress' } },
      { parentId: 'card-1', chunk: { type: 'thinking', content: 'hm' } },
      { parentId: 'card-2', chunk: { type: 'progress' } },
      { parentId: 'card-1', chunk: { type: 'progress' } },
    ]);
    expect(posted.every(m => m.type === 'mystiDelegateTrace')).toBe(true);
  });
});
