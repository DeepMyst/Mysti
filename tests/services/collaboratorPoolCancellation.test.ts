import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collabOptions, collabSpec, collectCollabChunks, createTestCollaboratorPool } from '../helpers/collaboratorFactory';
import { createMockStream } from '../helpers/mockProviderManager';
import { clearMockConfig } from '../helpers/mockVscode';
import type { CollaboratorChunk } from '../../src/types';

describe('CollaboratorPool conversational cancellation', () => {
  beforeEach(() => { clearMockConfig(); vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('Stop settles a silent child promptly and never starts queued reviewers or retries', async () => {
    const { pool, mockPM } = createTestCollaboratorPool();
    mockPM.defaultStreamFactory = () => createMockStream([{ type: 'text', content: 'Inspecting the race...' }], { hang: true });
    let result: CollaboratorChunk[] | undefined;
    const pending = collectCollabChunks(pool.dispatch([
      collabSpec('author', 'claude-code'), collabSpec('reviewer', 'openai-codex'), collabSpec('tester', 'google-gemini'),
    ], collabOptions({ maxConcurrent: 1 }))).then(chunks => { result = chunks; });
    await vi.advanceTimersByTimeAsync(1);
    pool.cancelRun('run-1');
    await vi.advanceTimersByTimeAsync(1);

    expect(result, 'Stop must finish even when the provider ignores cancellation').toBeDefined();
    await pending;
    expect(mockPM.sendCalls.map(call => call.providerId)).toEqual(['claude-code']);
    expect(result!.filter(chunk => chunk.type === 'collab_complete').every(chunk => chunk.failure === 'cancelled')).toBe(true);
    expect(result!.some(chunk => chunk.type === 'collab_retry')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stopping one lane cancels its unanswered question while the other agent completes', async () => {
    const { pool, mockPM } = createTestCollaboratorPool();
    let answer!: (value: { answers: Record<string, string> }) => void;
    mockPM.setProviderChunks('claude-code', [{ type: 'ask_user_question', askUserQuestion: {
      questions: [{ header: 'Database', question: 'Which database should I target?', options: [], multiSelect: false }],
    } }]);
    mockPM.setProviderChunks('openai-codex', [{ type: 'text', content: 'The migration needs an index.' }]);
    let result: CollaboratorChunk[] | undefined;
    const pending = collectCollabChunks(pool.dispatch([
      collabSpec('author', 'claude-code'), collabSpec('reviewer', 'openai-codex'),
    ], collabOptions({ onQuestion: () => new Promise(resolve => { answer = resolve; }) }))).then(chunks => { result = chunks; });
    await vi.advanceTimersByTimeAsync(1);
    pool.cancelCollaborator('run-1', 'author');
    await vi.advanceTimersByTimeAsync(1);

    expect(result, 'An unanswered question must not keep a stopped lane alive').toBeDefined();
    await pending;
    answer({ answers: { Database: 'PostgreSQL' } });
    await vi.advanceTimersByTimeAsync(1);
    expect(mockPM.sendCalls).toHaveLength(2);
    expect(result!.find(chunk => chunk.type === 'collab_complete' && chunk.collaboratorId === 'author')?.failure).toBe('cancelled');
    expect(result!.find(chunk => chunk.type === 'collab_complete' && chunk.collaboratorId === 'reviewer')?.responseText).toBe('The migration needs an index.');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Stop dismisses a pending legacy write gate and ignores an approval that arrives later', async () => {
    const { pool, mockPM } = createTestCollaboratorPool();
    vi.spyOn(mockPM, 'suspendRequest').mockReturnValue(true);
    const resume = vi.spyOn(mockPM, 'resumeRequest');
    let approve!: (value: boolean) => void;
    mockPM.setProviderChunks('claude-code', [
      { type: 'tool_use', toolCall: { id: 'write-1', name: 'Write', input: { file_path: 'src/db.ts', content: 'migration' } } },
      { type: 'text', content: 'Applied the migration.' },
    ]);
    let result: CollaboratorChunk[] | undefined;
    const pending = collectCollabChunks(pool.dispatch([collabSpec('author', 'claude-code', { access: 'gated-write' })],
      collabOptions({ onGate: () => new Promise(resolve => { approve = resolve; }) }))).then(chunks => { result = chunks; });
    await vi.advanceTimersByTimeAsync(1);
    pool.cancelRun('run-1');
    await vi.advanceTimersByTimeAsync(1);

    expect(result, 'A stopped request must not wait for approval').toBeDefined();
    await pending;
    approve(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(resume).not.toHaveBeenCalled();
    expect(mockPM.sendCalls).toHaveLength(1);
    expect(result!.find(chunk => chunk.type === 'collab_complete')?.failure).toBe('cancelled');
    expect(result!.some(chunk => chunk.type === 'collab_tool_use')).toBe(false);
  });

  it('cancels a hung availability probe without ever starting the agent', async () => {
    const { pool, mockPM } = createTestCollaboratorPool();
    vi.spyOn(mockPM, 'getProviderStatus').mockImplementation(() => new Promise(() => {}));
    let result: CollaboratorChunk[] | undefined;
    const pending = collectCollabChunks(pool.dispatch([collabSpec('author', 'claude-code')], collabOptions()))
      .then(chunks => { result = chunks; });
    await vi.advanceTimersByTimeAsync(1);
    pool.cancelRun('run-1');
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBeDefined();
    await pending;
    expect(mockPM.sendCalls).toHaveLength(0);
    expect(result!.find(chunk => chunk.type === 'collab_complete')?.failure).toBe('cancelled');
  });

  it('bounds a hung readiness check while a healthy reviewer still produces a result', async () => {
    const { pool, mockPM } = createTestCollaboratorPool();
    vi.spyOn(mockPM, 'getProviderStatus').mockImplementation(provider => provider === 'claude-code'
      ? new Promise(() => {}) : Promise.resolve(null));
    mockPM.setProviderChunks('openai-codex', [{ type: 'text', content: 'The migration is reversible.' }]);
    let result: CollaboratorChunk[] | undefined;
    const pending = collectCollabChunks(pool.dispatch([
      collabSpec('author', 'claude-code'), collabSpec('reviewer', 'openai-codex'),
    ], collabOptions())).then(chunks => { result = chunks; });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(result, 'Provider discovery must not keep the collaboration running indefinitely').toBeDefined();
    await pending;
    expect(result!.find(chunk => chunk.type === 'collab_complete' && chunk.collaboratorId === 'author')?.failure).toBe('timeout');
    expect(result!.find(chunk => chunk.type === 'collab_complete' && chunk.collaboratorId === 'reviewer')?.responseText).toBe('The migration is reversible.');
    expect(mockPM.sendCalls.map(call => call.providerId)).toEqual(['openai-codex']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps sequential dispatches in the same run usable after a successful round', async () => {
    const { pool, mockPM } = createTestCollaboratorPool();
    mockPM.setProviderChunks('openai-codex', [{ type: 'text', content: 'Reviewed.' }]);
    const spec = collabSpec('reviewer', 'openai-codex');
    await collectCollabChunks(pool.dispatch([spec], collabOptions()));
    const second = await collectCollabChunks(pool.dispatch([spec], collabOptions()));
    expect(mockPM.sendCalls).toHaveLength(2);
    expect(second.find(chunk => chunk.type === 'collab_complete')?.hasError).toBe(false);
    expect(mockPM.sendCalls[0].panelId).toBe(mockPM.sendCalls[1].panelId);
  });
});
