import { beforeEach, describe, expect, it } from 'vitest';
import { createTestBrainstormManager, configureBrainstorm, createMockSettings, collectChunks } from '../helpers/brainstormFactory';
import { createMockStream } from '../helpers/mockProviderManager';
import { clearMockConfig } from '../helpers/mockVscode';
import type { StreamChunk } from '../../src/types';

describe('Brainstorm provider failures after readiness', () => {
  beforeEach(() => clearMockConfig());

  it('forwards explicit unknown context even if the provider has no turn totals', async () => {
    const { manager, mockPM } = createTestBrainstormManager();
    configureBrainstorm({ agents: ['claude-code', 'openai-codex'], strategy: 'quick', synthesisAgent: 'openai-codex' });
    mockPM.setProviderAvailable('claude-code'); mockPM.setProviderAvailable('openai-codex');
    mockPM.setProviderChunks('claude-code', [{ type: 'text', content: 'Analysis with unreported usage.' }, { type: 'done', contextUsage: null }]);
    mockPM.setProviderChunks('openai-codex', [{ type: 'text', content: 'Second analysis.' }]);
    const chunks = await collectChunks(manager.startBrainstormSession('Review usage.', [], createMockSettings(), 'unknown-usage-analysis'));
    const complete = chunks.find(chunk => chunk.type === 'agent_complete' && chunk.agentId === 'claude-code');
    expect(complete?.contextUsage).toBeNull();
    expect(complete?.usage).toBeUndefined();
  });

  it.each([null, { input_tokens: 367, output_tokens: 90, cache_read_input_tokens: 96256, normalized: true }])('forwards explicit latest-context metadata independently of agent totals: %j', async contextUsage => {
    const { manager, mockPM } = createTestBrainstormManager();
    configureBrainstorm({ agents: ['claude-code', 'openai-codex'], strategy: 'quick', synthesisAgent: 'openai-codex' });
    mockPM.setProviderAvailable('claude-code'); mockPM.setProviderAvailable('openai-codex');
    const usage = { input_tokens: 95797, output_tokens: 311, cache_read_input_tokens: 193088, normalized: true };
    mockPM.setProviderChunks('claude-code', [{ type: 'text', content: 'Keep the measured context separate.' }, { type: 'done', usage, contextUsage }]);
    mockPM.setProviderChunks('openai-codex', [{ type: 'text', content: 'Keep totals for accounting.' }]);
    const chunks = await collectChunks(manager.startBrainstormSession('Review usage.', [], createMockSettings(), 'usage-analysis'));
    expect(chunks.find(chunk => chunk.type === 'agent_complete' && chunk.agentId === 'claude-code')).toMatchObject({ usage, contextUsage });
  });

  it.each(['auth_error', 'empty'] as const)('surfaces %s during independent analysis and keeps the other agent useful', async failure => {
    const { manager, mockPM } = createTestBrainstormManager();
    configureBrainstorm({ agents: ['claude-code', 'openai-codex'], strategy: 'quick', synthesisAgent: 'openai-codex' });
    mockPM.setProviderAvailable('claude-code');
    mockPM.setProviderAvailable('openai-codex');
    mockPM.setProviderChunks('claude-code', failure === 'auth_error' ? [{ type: 'auth_error', content: 'Your session expired. Sign in again.' }] : [{ type: 'done' }]);
    mockPM.setProviderChunks('openai-codex', [{ type: 'text', content: 'Use a unique idempotency key for retries.' }]);
    const chunks = await collectChunks(manager.startBrainstormSession('Review our payment retry design.', [], createMockSettings(), 'failure-analysis'));

    expect(chunks.filter(chunk => chunk.type === 'agent_error' && chunk.agentId === 'claude-code')).toHaveLength(1);
    expect(chunks.some(chunk => chunk.type === 'agent_complete' && chunk.agentId === 'claude-code')).toBe(false);
    expect(manager.getCurrentSession('failure-analysis')?.agentResponses.get('claude-code')?.status).toBe('error');
    expect(chunks.some(chunk => chunk.type === 'synthesis_text')).toBe(true);
    expect(chunks.at(-1)?.type).toBe('done');
  });

  it('reports expired credentials during a discussion instead of accepting a silent round', async () => {
    const { manager, mockPM } = createTestBrainstormManager();
    configureBrainstorm({ agents: ['claude-code', 'openai-codex'], strategy: 'debate', maxRounds: 1, autoConverge: false, synthesisAgent: 'openai-codex' });
    mockPM.setProviderAvailable('claude-code');
    mockPM.setProviderAvailable('openai-codex');
    let claudeTurns = 0;
    mockPM.streamFactories.set('claude-code', () => createMockStream(++claudeTurns === 1
      ? [{ type: 'text', content: 'Use an idempotency token.' }]
      : [{ type: 'auth_error', content: 'Your Claude session expired.' }]));
    mockPM.setProviderChunks('openai-codex', [{ type: 'text', content: 'Store the token before calling the payment service.' }]);
    const chunks = await collectChunks(manager.startBrainstormSession('Debate payment retry guarantees.', [], createMockSettings(), 'failure-discussion'));
    expect(chunks.filter(chunk => chunk.type === 'discussion_error' && chunk.agentId === 'claude-code')).toHaveLength(1);
    expect(chunks.at(-1)?.type).toBe('done');
  });

  it('falls back if authentication fails after partial synthesis text', async () => {
    const { manager, mockPM } = createTestBrainstormManager();
    configureBrainstorm({ agents: ['claude-code', 'openai-codex'], strategy: 'quick', synthesisAgent: 'claude-code' });
    mockPM.setProviderAvailable('claude-code');
    mockPM.setProviderAvailable('openai-codex');
    let claudeTurns = 0;
    mockPM.streamFactories.set('claude-code', () => createMockStream(++claudeTurns === 1
      ? [{ type: 'text', content: 'Use an idempotency token.' }]
      : [{ type: 'text', content: 'The final plan is...' }, { type: 'auth_error', content: 'Session expired.' }] as StreamChunk[]));
    mockPM.setProviderChunks('openai-codex', [{ type: 'text', content: 'Persist a unique token and retry safely.' }]);
    const chunks = await collectChunks(manager.startBrainstormSession('Combine the payment retry review.', [], createMockSettings(), 'failure-synthesis'));
    expect(chunks.some(chunk => chunk.type === 'synthesis_fallback')).toBe(true);
    expect(manager.getCurrentSession('failure-synthesis')?.unifiedSolution).toBe('Persist a unique token and retry safely.');
  });
});
