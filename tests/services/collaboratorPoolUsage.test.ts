/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Plan 32 H5: a child's `done` usage reaches collab_complete, normalized with
 * the CHILD's convention, and only when it actually measured something.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { clearMockConfig } from '../helpers/mockVscode';
import { MockProviderManager, createMockStream } from '../helpers/mockProviderManager';
import { createTestCollaboratorPool, collabSpec, collabOptions, collectCollabChunks } from '../helpers/collaboratorFactory';
import type { StreamChunk, UsageStats } from '../../src/types';
import type { UsageConvention } from '../../src/services/TokenAccounting';

function answer(usage?: UsageStats, text = 'ok'): StreamChunk[] {
  return [
    ...(text ? [{ type: 'text', content: text } as StreamChunk] : []),
    { type: 'done', ...(usage ? { usage } : {}) } as StreamChunk,
  ];
}

function withConvention(pm: MockProviderManager, usageConvention: UsageConvention, emitsUsage?: boolean): void {
  (pm as any).getProviderInstance = () => ({ capabilities: { usageConvention, ...(emitsUsage === undefined ? {} : { emitsUsage }) } });
}

async function complete(pm: MockProviderManager, spec = collabSpec('c1', 'openai-codex' as any), options = collabOptions()) {
  const { pool } = createTestCollaboratorPool(pm);
  const chunks = await collectCollabChunks(pool.dispatch([spec], options));
  return chunks.find(c => c.type === 'collab_complete')!;
}

describe('CollaboratorPool child usage', () => {
  let pm: MockProviderManager;

  beforeEach(() => {
    clearMockConfig();
    pm = new MockProviderManager();
    pm.setProviderAvailable('openai-codex', 'Codex');
  });

  it('splits an OpenAI child\'s cached subset out of its input', async () => {
    withConvention(pm, 'openai');
    pm.setProviderChunks('openai-codex', answer({ input_tokens: 100, output_tokens: 7, cache_read_input_tokens: 40 }));
    const done = await complete(pm);
    expect(done.usage).toMatchObject({ input_tokens: 60, cache_read_input_tokens: 40, output_tokens: 7, normalized: true });
  });

  it('resolves an auto child per model, so a Claude model keeps disjoint buckets', async () => {
    withConvention(pm, 'auto');
    pm.setProviderChunks('openai-codex', answer({ input_tokens: 100, output_tokens: 7, cache_read_input_tokens: 40 }));
    const done = await complete(pm, collabSpec('c1', 'openai-codex' as any, { model: 'anthropic/claude-sonnet-4.6' }));
    expect(done.usage).toMatchObject({ input_tokens: 100, cache_read_input_tokens: 40 });
  });

  it('omits usage when the record carries no signal or the child never measures', async () => {
    withConvention(pm, 'openai');
    pm.setProviderChunks('openai-codex', answer({ input_tokens: 0, output_tokens: 0 }));
    expect((await complete(pm)).usage).toBeUndefined();

    withConvention(pm, 'none', false);
    pm.setProviderChunks('openai-codex', answer({ input_tokens: 50, output_tokens: 5 }));
    expect((await complete(pm)).usage).toBeUndefined();
  });

  it('reports the follow-up process\'s usage after the child asked a question', async () => {
    withConvention(pm, 'openai');
    let call = 0;
    pm.streamFactories.set('openai-codex', () => createMockStream(call++ === 0
      ? [{ type: 'ask_user_question', askUserQuestion: { questions: [{ question: 'Which?', header: 'Q', options: [] }] } } as unknown as StreamChunk]
      : answer({ input_tokens: 100, output_tokens: 7, cache_read_input_tokens: 40 })));
    const done = await complete(pm, undefined, collabOptions({ onQuestion: async () => ({ answers: { Q: 'a' } }) }));
    expect(call).toBe(2);
    expect(done.usage).toMatchObject({ input_tokens: 60, cache_read_input_tokens: 40, output_tokens: 7 });
  });

  it('reports the attempt that produced the result, not an earlier retried one', async () => {
    withConvention(pm, 'openai');
    let call = 0;
    pm.streamFactories.set('openai-codex', () => createMockStream(call++ === 0
      // Empty response with usage: retried, and its numbers must not leak.
      ? answer({ input_tokens: 999, output_tokens: 1 }, '')
      : answer(undefined)));
    const done = await complete(pm);
    expect(call).toBe(2);
    expect(done.hasError).toBeFalsy();
    expect(done.usage).toBeUndefined();
  });
});
