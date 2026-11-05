/*
 * Copyright 2025 DeepMyst Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { clearMockConfig } from '../helpers/mockVscode';
import { MockProviderManager } from '../helpers/mockProviderManager';
import { configureBrainstorm, createMockSettings, createTestBrainstormManager, collectChunks } from '../helpers/brainstormFactory';
import type { CollaborationStrategy, Conversation } from '../../src/types';

// Brainstorm agents see the earlier chat on their first dispatch in a run, the
// same history an agent you switch to receives. Later dispatches in the run
// resume that child session or carry both answers in the prompt.
const STRATEGIES: CollaborationStrategy[] = ['quick', 'debate', 'red-team', 'perspectives', 'delphi'];

const conv = {
  id: 'c1', title: 'Costs', createdAt: 0, updatedAt: 0, mode: 'default', model: 'opus', provider: 'claude-code',
  messages: [
    { id: 'm1', role: 'user', content: 'Why did costs triple?', timestamp: 1 },
    { id: 'm2', role: 'assistant', content: 'Try a smaller model.', timestamp: 2 },
  ],
} as unknown as Conversation;

function byProvider(pm: MockProviderManager) {
  const groups = new Map<string, MockProviderManager['sendCalls']>();
  for (const call of pm.sendCalls) {
    groups.set(call.providerId, [...(groups.get(call.providerId) ?? []), call]);
  }
  return groups;
}

describe('Brainstorm agents and the earlier chat', () => {
  let pm: MockProviderManager;

  beforeEach(() => {
    clearMockConfig();
    pm = new MockProviderManager();
    pm.setProviderAvailable('claude-code', 'Claude');
    pm.setProviderAvailable('openai-codex', 'Codex');
    pm.setProviderChunks('claude-code', [{ type: 'text', content: 'Claude view.' }, { type: 'done' }]);
    pm.setProviderChunks('openai-codex', [{ type: 'text', content: 'Codex view.' }, { type: 'done' }]);
  });

  const run = async (strategy: CollaborationStrategy, conversation?: Conversation | null, panel = 'p') => {
    configureBrainstorm({ agents: ['claude-code', 'openai-codex'], strategy, maxRounds: 1, autoConverge: false, synthesisAgent: 'claude-code' });
    const { manager } = createTestBrainstormManager(pm);
    await collectChunks(manager.startBrainstormSession('Look at it together', [], createMockSettings(), panel, conversation));
    return manager;
  };

  it.each(STRATEGIES)('first dispatch per agent receives the earlier chat (%s)', async (strategy) => {
    await run(strategy, conv);
    const groups = byProvider(pm);
    expect([...groups.keys()].sort()).toEqual(['claude-code', 'openai-codex']);
    for (const calls of groups.values()) {
      expect(calls[0].conversation).toEqual(conv);
    }
  });

  it.each(STRATEGIES)('later dispatches get no chat (%s)', async (strategy) => {
    await run(strategy, conv);
    for (const calls of byProvider(pm).values()) {
      for (const later of calls.slice(1)) {
        expect(later.conversation).toBeNull();
      }
    }
  });

  it('first-answer gets null when there is no earlier chat', async () => {
    await run('debate');
    expect(pm.sendCalls.length).toBeGreaterThan(0);
    for (const call of pm.sendCalls) {
      expect(call.conversation).toBeNull();
    }
  });

  it('a second run sends the chat again', async () => {
    configureBrainstorm({ agents: ['claude-code', 'openai-codex'], strategy: 'quick', synthesisAgent: 'claude-code' });
    const { manager } = createTestBrainstormManager(pm);
    await collectChunks(manager.startBrainstormSession('First', [], createMockSettings(), 'p', conv));
    const firstRun = pm.sendCalls.length;
    await collectChunks(manager.startBrainstormSession('Second', [], createMockSettings(), 'p', conv));
    const second = pm.sendCalls.slice(firstRun);
    for (const agent of ['claude-code', 'openai-codex']) {
      expect(second.find(call => call.providerId === agent)?.conversation).toEqual(conv);
    }
  });
});
