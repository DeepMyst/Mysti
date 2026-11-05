import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collabOptions, collabSpec, collectCollabChunks, createTestCollaboratorPool } from '../helpers/collaboratorFactory';
import { createMockStream } from '../helpers/mockProviderManager';
import { clearMockConfig } from '../helpers/mockVscode';

describe('Collaborator failures after user answers a question', () => {
  beforeEach(() => { clearMockConfig(); vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('reports expired authentication without repeating the task', async () => {
    const { pool, mockPM } = createTestCollaboratorPool();
    mockPM.setProviderChunks('claude-code', [{ type: 'auth_error', content: 'Please sign in again.' }]);
    const chunks = await collectCollabChunks(pool.dispatch([collabSpec('author', 'claude-code')], collabOptions()));
    expect(chunks.find(chunk => chunk.type === 'collab_complete')?.failure).toBe('not-authenticated');
    expect(mockPM.sendCalls).toHaveLength(1);
    expect(chunks.some(chunk => chunk.type === 'collab_retry')).toBe(false);
  });

  it.each([
    '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6.1-sol\' model is not supported when using Codex with a ChatGPT account.","code":"model_not_found"}}',
    'Error: Model "gpt-5.4" from --model flag is not available.',
    'Unknown model: retired-preview',
    'Error: Model owned-invalid-model is not supported.',
    'Error: Model owned-retired-preview is not supported.',
  ])('does not retry a model availability rejection: %s', async content => {
    const { pool, mockPM } = createTestCollaboratorPool();
    mockPM.setProviderChunks('openai-codex', [{ type: 'error', content }]);
    const chunks = await collectCollabChunks(pool.dispatch([collabSpec('reviewer', 'openai-codex')], collabOptions()));
    expect(mockPM.sendCalls).toHaveLength(1);
    expect(chunks.some(chunk => chunk.type === 'collab_retry')).toBe(false);
    expect(chunks.filter(chunk => chunk.type === 'collab_error')).toEqual([
      expect.objectContaining({ failure: 'model-unavailable', content, hasError: true }),
    ]);
    expect(chunks.find(chunk => chunk.type === 'collab_complete')).toMatchObject({ hasError: true, failure: 'model-unavailable' });
  });

  it('preserves healthy peer output beside an unavailable model', async () => {
    const { pool, mockPM } = createTestCollaboratorPool();
    mockPM.setProviderChunks('openai-codex', [{ type: 'error', content: 'Model "owned-unavailable" is not available.' }]);
    mockPM.setProviderChunks('github-copilot', [{ type: 'text', content: 'Independent review survives.' }, { type: 'done' }]);
    const chunks = await collectCollabChunks(pool.dispatch([
      collabSpec('unavailable', 'openai-codex'), collabSpec('healthy', 'github-copilot'),
    ], collabOptions()));
    expect(mockPM.sendCalls).toHaveLength(2);
    expect(chunks.find(chunk => chunk.type === 'collab_complete' && chunk.agentId === 'github-copilot'))
      .toMatchObject({ hasError: false, responseText: 'Independent review survives.' });
    expect(chunks.some(chunk => chunk.type === 'collab_retry')).toBe(false);
  });

  it.each(['Model service is temporarily unavailable.', 'Model service is not available.',
    'Model is overloaded; retry later.', 'Network connection failed.'])
    ('still retries a transient failure: %s', async content => {
      const { pool, mockPM } = createTestCollaboratorPool();
      let attempts = 0;
      mockPM.streamFactories.set('openai-codex', () => createMockStream(++attempts === 1
        ? [{ type: 'error', content }] : [{ type: 'text', content: 'Recovered.' }, { type: 'done' }]));
      const chunks = await collectCollabChunks(pool.dispatch([collabSpec('reviewer', 'openai-codex')], collabOptions()));
      expect(mockPM.sendCalls).toHaveLength(2);
      expect(chunks.find(chunk => chunk.type === 'collab_complete')).toMatchObject({ hasError: false, responseText: 'Recovered.' });
    });

  it.each(['Model requested-model does not exist.', 'Error: Model owned-invalid-model is not supported.',
    'Error: Model owned-retired-preview is not supported.'])
    ('does not repeat the original question when its follow-up model is unavailable: %s', async content => {
    const { pool, mockPM } = createTestCollaboratorPool();
    mockPM.streamFactories.set('claude-code', (_provider, _prompt, _context, _settings, _conversation, _persona, panelId) =>
      createMockStream(panelId?.endsWith('-followup')
        ? [{ type: 'error', content }]
        : [{ type: 'text', content: 'Choose a database.' }, { type: 'ask_user_question', askUserQuestion: {
          questions: [{ header: 'Database', question: 'Which database?', options: [], multiSelect: false }],
        } }]));
    const chunks = await collectCollabChunks(pool.dispatch([collabSpec('author', 'claude-code')], collabOptions({
      onQuestion: async () => ({ answers: { Database: 'PostgreSQL' } }),
    })));
    expect(mockPM.sendCalls).toHaveLength(2);
    expect(chunks.find(chunk => chunk.type === 'collab_complete')).toMatchObject({ hasError: true, failure: 'model-unavailable' });
    expect(chunks.some(chunk => chunk.type === 'collab_retry')).toBe(false);
  });

  it.each(['auth_error', 'empty'] as const)('reports a failed %s follow-up even when the original question included text', async failure => {
    const { pool, mockPM } = createTestCollaboratorPool();
    mockPM.streamFactories.set('claude-code', (_provider, _prompt, _context, _settings, _conversation, _persona, panelId) =>
      createMockStream(panelId?.endsWith('-followup')
        ? failure === 'auth_error' ? [{ type: 'auth_error', content: 'Please sign in again.' }] : [{ type: 'done' }]
        : [{ type: 'text', content: 'I need your database choice before proceeding.' }, { type: 'ask_user_question', askUserQuestion: {
          questions: [{ header: 'Database', question: 'Which database?', options: [], multiSelect: false }],
        } }]));
    const chunks = await collectCollabChunks(pool.dispatch([collabSpec('author', 'claude-code')], collabOptions({
      onQuestion: async () => ({ answers: { Database: 'PostgreSQL' } }),
    })));
    const completed = chunks.find(chunk => chunk.type === 'collab_complete');
    expect(completed?.hasError).toBe(true);
    expect(completed?.failure).toBe(failure === 'auth_error' ? 'not-authenticated' : 'empty-response');
    if (failure === 'auth_error') { expect(mockPM.sendCalls).toHaveLength(2); }
    expect(vi.getTimerCount()).toBe(0);
  });
});
