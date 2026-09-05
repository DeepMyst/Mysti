/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * D-3 regression: BaseCliProvider dropped the conversation history whenever
 * `session.sessionId` was truthy, on the assumption that a truthy id means the
 * CLI will resume. That is only true for `sessionKind: 'cli-resume'`.
 *
 * Codex declares `sessionKind: 'prompt-history'`, records `thread_id` into
 * `session.sessionId` from the `thread.started` event, and its argv
 * (`codex exec --json ... -`) carries NO resume flag — so from turn 2 every
 * Codex request went out with neither history nor resume.
 */
import { describe, it, expect } from 'vitest';
import { TestableCodexProvider, TestableClaudeProvider } from '../../helpers/providerFactory';
import { createCodexSession, createClaudeSession } from '../../helpers/sessionFactory';
import type { Conversation } from '../../../src/types';

const CONVERSATION = {
  id: 'c1',
  title: 'turn 1',
  messages: [
    { id: 'm1', role: 'user', content: 'remember the number 41', timestamp: 1 },
    { id: 'm2', role: 'assistant', content: 'Noted: 41.', timestamp: 2 },
  ],
  createdAt: 1,
  updatedAt: 2,
} as unknown as Conversation;

describe('D-3 — history suppression is gated on sessionKind, not on a truthy sessionId', () => {
  it('Codex keeps its history after thread.started assigns a sessionId', () => {
    const provider = new TestableCodexProvider();
    const session = createCodexSession();

    // Turn 1: no session yet — history is sent.
    expect((provider as any)._conversationForPrompt(session, CONVERSATION)).toBe(CONVERSATION);

    // The real turn-1 stream event that assigns the id.
    provider.parseStreamLine(
      JSON.stringify({ type: 'thread.started', thread_id: 'thread_abc' }),
      session as any,
    );
    expect(session.sessionId).toBe('thread_abc');

    // Codex has no resume flag, so turn 2 MUST still carry the history.
    expect(provider.capabilities.sessionKind).toBe('prompt-history');
    expect(provider.buildCliArgs({} as any, session as any).join(' ')).not.toMatch(/resume/);
    expect((provider as any)._conversationForPrompt(session, CONVERSATION)).toBe(CONVERSATION);
  });

  it('is behaviour-neutral for a cli-resume provider (Claude Code still drops history)', () => {
    const provider = new TestableClaudeProvider();
    const session = createClaudeSession();

    expect(provider.capabilities.sessionKind).toBe('cli-resume');
    expect((provider as any)._conversationForPrompt(session, CONVERSATION)).toBe(CONVERSATION);

    session.sessionId = 'sess_claude_01';
    expect((provider as any)._conversationForPrompt(session, CONVERSATION)).toBeNull();
  });
});
