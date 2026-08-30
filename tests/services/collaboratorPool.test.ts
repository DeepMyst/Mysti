/**
 * CollaboratorPool tests (Plan 14 Phase 0).
 * Exercises the shared bounded dispatch primitive: cap, availability taxonomy,
 * timeout, retry, cancel fan-out, read-only deny, gated-write approval, and the
 * question relay — all without spawning real CLI processes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { clearMockConfig } from '../helpers/mockVscode';
import { MockProviderManager, createMockStream } from '../helpers/mockProviderManager';
import {
  createTestCollaboratorPool,
  collabSpec,
  collabOptions,
  collabSettings,
  collectCollabChunks,
} from '../helpers/collaboratorFactory';
import type { StreamChunk, CollaboratorChunk } from '../../src/types';

function textChunks(texts: string[]): StreamChunk[] {
  const chunks: StreamChunk[] = texts.map(t => ({ type: 'text', content: t }));
  chunks.push({ type: 'done', usage: { inputTokens: 10, outputTokens: 5 } });
  return chunks;
}

function byId(chunks: CollaboratorChunk[], id: string): CollaboratorChunk[] {
  return chunks.filter(c => c.collaboratorId === id);
}

describe('CollaboratorPool', () => {
  let mockPM: MockProviderManager;

  beforeEach(() => {
    clearMockConfig();
    mockPM = new MockProviderManager();
  });

  describe('Happy path', () => {
    it('dispatches a single collaborator and completes with accumulated text', async () => {
      const { pool, mockPM: pm } = createTestCollaboratorPool(mockPM);
      pm.setProviderAvailable('google-gemini', 'Gemini');
      pm.setProviderChunks('google-gemini', textChunks(['Advice: ', 'do X.']));

      const chunks = await collectCollabChunks(
        pool.dispatch([collabSpec('c1', 'google-gemini' as any)], collabOptions())
      );

      expect(byId(chunks, 'c1').some(c => c.type === 'collab_started')).toBe(true);
      const complete = chunks.find(c => c.type === 'collab_complete');
      expect(complete).toBeDefined();
      expect(complete!.hasError).toBeFalsy();
      expect(complete!.responseText).toBe('Advice: do X.');
    });

    it('runs multiple collaborators and completes all of them', async () => {
      const { pool, mockPM: pm } = createTestCollaboratorPool(mockPM);
      pm.setProviderAvailable('google-gemini', 'Gemini');
      pm.setProviderAvailable('openai-codex', 'Codex');
      pm.setProviderChunks('google-gemini', textChunks(['g']));
      pm.setProviderChunks('openai-codex', textChunks(['c']));

      const chunks = await collectCollabChunks(
        pool.dispatch(
          [collabSpec('c1', 'google-gemini' as any), collabSpec('c2', 'openai-codex' as any)],
          collabOptions()
        )
      );

      const completes = chunks.filter(c => c.type === 'collab_complete');
      expect(completes.length).toBe(2);
      expect(completes.every(c => !c.hasError)).toBe(true);
    });
  });

  describe('Availability taxonomy', () => {
    it('skips a not-installed collaborator with an install hint, never dispatching', async () => {
      const { pool, mockPM: pm } = createTestCollaboratorPool(mockPM);
      pm.setProviderNotInstalled('cursor', 'curl https://cursor.com/install | bash');

      const chunks = await collectCollabChunks(
        pool.dispatch([collabSpec('c1', 'cursor' as any)], collabOptions())
      );

      const skipped = chunks.find(c => c.type === 'collab_skipped');
      expect(skipped).toBeDefined();
      expect(skipped!.failure).toBe('not-installed');
      expect(skipped!.hint).toContain('cursor.com');
      // No text/complete — it was never dispatched.
      expect(chunks.some(c => c.type === 'collab_text')).toBe(false);
    });

    it('skips a not-authenticated collaborator with an auth hint', async () => {
      const { pool, mockPM: pm } = createTestCollaboratorPool(mockPM);
      pm.setProviderUnauthenticated('openclaw');

      const chunks = await collectCollabChunks(
        pool.dispatch([collabSpec('c1', 'openclaw' as any)], collabOptions())
      );

      const skipped = chunks.find(c => c.type === 'collab_skipped');
      expect(skipped!.failure).toBe('not-authenticated');
    });

    it('one collaborator failing does not sink the others', async () => {
      const { pool, mockPM: pm } = createTestCollaboratorPool(mockPM);
      pm.setProviderNotInstalled('cursor');
      pm.setProviderAvailable('google-gemini', 'Gemini');
      pm.setProviderChunks('google-gemini', textChunks(['survived']));

      const chunks = await collectCollabChunks(
        pool.dispatch(
          [collabSpec('bad', 'cursor' as any), collabSpec('good', 'google-gemini' as any)],
          collabOptions()
        )
      );

      expect(chunks.find(c => c.collaboratorId === 'bad' && c.type === 'collab_skipped')!.failure).toBe('not-installed');
      const goodComplete = chunks.find(c => c.collaboratorId === 'good' && c.type === 'collab_complete');
      expect(goodComplete!.responseText).toBe('survived');
    });
  });

  describe('Concurrency cap', () => {
    it('never runs more than maxConcurrent collaborators at once', async () => {
      const { pool, mockPM: pm } = createTestCollaboratorPool(mockPM);
      let active = 0;
      let peak = 0;
      const ids = ['a', 'b', 'c', 'd', 'e'];
      for (const id of ids) {
        const provider = `prov-${id}`;
        pm.setProviderAvailable(provider);
        pm.streamFactories.set(provider, async function* () {
          active++;
          peak = Math.max(peak, active);
          await new Promise(r => setTimeout(r, 15));
          yield { type: 'text', content: id } as StreamChunk;
          yield { type: 'done' } as StreamChunk;
          active--;
        });
      }

      const specs = ids.map((id) => collabSpec(id, `prov-${id}` as any));
      const chunks = await collectCollabChunks(pool.dispatch(specs, collabOptions({ maxConcurrent: 2 })));

      expect(peak).toBeLessThanOrEqual(2);
      expect(chunks.filter(c => c.type === 'collab_complete').length).toBe(5);
    });
  });

  describe('Timeout + retry', () => {
    it('times out a hung collaborator and maps to the timeout failure', async () => {
      const { pool, mockPM: pm } = createTestCollaboratorPool(mockPM);
      pm.setProviderAvailable('ollama');
      // Hang forever; a tiny per-spec timeout forces the timeout branch fast.
      pm.streamFactories.set('ollama', () => createMockStream([{ type: 'text', content: 'partial' }], { hang: true }));

      const chunks = await collectCollabChunks(
        pool.dispatch([collabSpec('c1', 'ollama' as any, { timeoutMs: 30 })], collabOptions())
      );

      const err = chunks.find(c => c.type === 'collab_error');
      expect(err).toBeDefined();
      expect(err!.failure).toBe('timeout');
      // Timeout cancels the child panel.
      expect(pm.cancelledPanelIds.some(p => p.includes('collab'))).toBe(true);
    });

    it('retries once on a stream error then surfaces the failure', async () => {
      const { pool, mockPM: pm } = createTestCollaboratorPool(mockPM);
      pm.setProviderAvailable('google-gemini');
      let calls = 0;
      pm.streamFactories.set('google-gemini', () => {
        calls++;
        return createMockStream([{ type: 'error', content: 'boom' }]);
      });

      const chunks = await collectCollabChunks(
        pool.dispatch([collabSpec('c1', 'google-gemini' as any)], collabOptions())
      );

      // SUBAGENT_MAX_RETRIES = 1 ⇒ two attempts total.
      expect(calls).toBe(2);
      expect(chunks.some(c => c.type === 'collab_retry')).toBe(true);
      const complete = chunks.find(c => c.type === 'collab_complete');
      expect(complete!.hasError).toBe(true);
      expect(complete!.failure).toBe('stream-error');
    });

    it('recovers when the retry succeeds', async () => {
      const { pool, mockPM: pm } = createTestCollaboratorPool(mockPM);
      pm.setProviderAvailable('google-gemini');
      let calls = 0;
      pm.streamFactories.set('google-gemini', () => {
        calls++;
        if (calls === 1) {
          return createMockStream([{ type: 'error', content: 'transient' }]);
        }
        return createMockStream(textChunks(['recovered']));
      });

      const chunks = await collectCollabChunks(
        pool.dispatch([collabSpec('c1', 'google-gemini' as any)], collabOptions())
      );

      const complete = chunks.find(c => c.type === 'collab_complete');
      expect(complete!.hasError).toBeFalsy();
      expect(complete!.responseText).toBe('recovered');
    });
  });

  describe('Empty response', () => {
    it('flags a collaborator that returns only whitespace', async () => {
      const { pool, mockPM: pm } = createTestCollaboratorPool(mockPM);
      pm.setProviderAvailable('google-gemini');
      pm.setProviderChunks('google-gemini', [{ type: 'text', content: '   ' }, { type: 'done' }]);

      const chunks = await collectCollabChunks(
        pool.dispatch([collabSpec('c1', 'google-gemini' as any)], collabOptions())
      );

      const err = chunks.find(c => c.type === 'collab_error');
      expect(err!.failure).toBe('empty-response');
    });
  });

  describe('Read-only enforcement', () => {
    it('hard-denies a write tool for a read-only collaborator and cancels the child', async () => {
      const { pool, mockPM: pm } = createTestCollaboratorPool(mockPM);
      pm.setProviderAvailable('claude-code');
      const suspendSpy = vi.spyOn(pm, 'suspendRequest');
      pm.streamFactories.set('claude-code', () => createMockStream([
        { type: 'text', content: 'let me edit' },
        { type: 'tool_use', toolCall: { id: 't1', name: 'Write', input: { path: 'x.ts' } } as any },
        { type: 'text', content: 'never reached' },
        { type: 'done' },
      ]));

      const chunks = await collectCollabChunks(
        pool.dispatch([collabSpec('c1', 'claude-code' as any, { access: 'read-only', role: 'critic' })], collabOptions())
      );

      const denied = chunks.find(c => c.type === 'collab_tool_denied');
      expect(denied).toBeDefined();
      expect(suspendSpy).toHaveBeenCalled();
      expect(pm.cancelledPanelIds.some(p => p.includes('collab'))).toBe(true);
      const complete = chunks.find(c => c.type === 'collab_complete');
      expect(complete!.failure).toBe('denied');
    });

    it('allows a read tool for a read-only collaborator', async () => {
      const { pool, mockPM: pm } = createTestCollaboratorPool(mockPM);
      pm.setProviderAvailable('claude-code');
      pm.streamFactories.set('claude-code', () => createMockStream([
        { type: 'tool_use', toolCall: { id: 't1', name: 'Read', input: { path: 'x.ts' } } as any },
        { type: 'text', content: 'looks good' },
        { type: 'done' },
      ]));

      const chunks = await collectCollabChunks(
        pool.dispatch([collabSpec('c1', 'claude-code' as any, { access: 'read-only' })], collabOptions())
      );

      expect(chunks.some(c => c.type === 'collab_tool_use')).toBe(true);
      expect(chunks.some(c => c.type === 'collab_tool_denied')).toBe(false);
      const complete = chunks.find(c => c.type === 'collab_complete');
      expect(complete!.hasError).toBeFalsy();
    });
  });

  describe('Gated-write', () => {
    it('re-emits a write when the gate approves and resumes the child', async () => {
      const { pool, mockPM: pm } = createTestCollaboratorPool(mockPM);
      pm.setProviderAvailable('claude-code');
      // Simulate a successful SIGSTOP so the pool resumes on approval (the mock
      // stub returns false, which would model a Windows no-op suspend).
      vi.spyOn(pm, 'suspendRequest').mockReturnValue(true);
      const resumeSpy = vi.spyOn(pm, 'resumeRequest');
      pm.streamFactories.set('claude-code', () => createMockStream([
        { type: 'tool_use', toolCall: { id: 't1', name: 'Write', input: { path: 'x.ts' } } as any },
        { type: 'text', content: 'done' },
        { type: 'done' },
      ]));

      const chunks = await collectCollabChunks(
        pool.dispatch(
          [collabSpec('c1', 'claude-code' as any, { access: 'gated-write', role: 'coworker' })],
          collabOptions({ onGate: async () => true })
        )
      );

      expect(chunks.some(c => c.type === 'collab_tool_use')).toBe(true);
      expect(chunks.some(c => c.type === 'collab_tool_denied')).toBe(false);
      expect(resumeSpy).toHaveBeenCalled();
      const complete = chunks.find(c => c.type === 'collab_complete');
      expect(complete!.hasError).toBeFalsy();
    });

    it('denies a write when the gate rejects', async () => {
      const { pool, mockPM: pm } = createTestCollaboratorPool(mockPM);
      pm.setProviderAvailable('claude-code');
      vi.spyOn(pm, 'suspendRequest').mockReturnValue(true);
      let gateCalled = false;
      pm.streamFactories.set('claude-code', () => createMockStream([
        { type: 'tool_use', toolCall: { id: 't1', name: 'Bash', input: { command: 'rm -rf /' } } as any },
        { type: 'done' },
      ]));

      const chunks = await collectCollabChunks(
        pool.dispatch(
          [collabSpec('c1', 'claude-code' as any, { access: 'gated-write' })],
          collabOptions({ onGate: async () => { gateCalled = true; return false; } })
        )
      );

      expect(gateCalled).toBe(true);
      expect(chunks.some(c => c.type === 'collab_tool_denied')).toBe(true);
      const complete = chunks.find(c => c.type === 'collab_complete');
      expect(complete!.failure).toBe('denied');
    });

    it('fails closed on a write when no gate hook is provided', async () => {
      const { pool, mockPM: pm } = createTestCollaboratorPool(mockPM);
      pm.setProviderAvailable('claude-code');
      vi.spyOn(pm, 'suspendRequest').mockReturnValue(true);
      pm.streamFactories.set('claude-code', () => createMockStream([
        { type: 'tool_use', toolCall: { id: 't1', name: 'Write', input: {} } as any },
        { type: 'done' },
      ]));

      const chunks = await collectCollabChunks(
        pool.dispatch([collabSpec('c1', 'claude-code' as any, { access: 'gated-write' })], collabOptions())
      );

      expect(chunks.some(c => c.type === 'collab_tool_denied')).toBe(true);
    });

    it('fails closed when the child cannot be frozen (suspend unavailable)', async () => {
      const { pool, mockPM: pm } = createTestCollaboratorPool(mockPM);
      pm.setProviderAvailable('claude-code');
      // suspendRequest returns false (Windows / no live process) by default.
      let gateCalled = false;
      pm.streamFactories.set('claude-code', () => createMockStream([
        { type: 'tool_use', toolCall: { id: 't1', name: 'Write', input: {} } as any },
        { type: 'done' },
      ]));

      const chunks = await collectCollabChunks(
        pool.dispatch(
          [collabSpec('c1', 'claude-code' as any, { access: 'gated-write' })],
          collabOptions({ onGate: async () => { gateCalled = true; return true; } })
        )
      );

      // The write is denied without ever asking the gate, because the child
      // was not actually paused.
      expect(gateCalled).toBe(false);
      expect(chunks.some(c => c.type === 'collab_tool_denied')).toBe(true);
    });
  });

  describe('Gate — delegation and web reads', () => {
    it('does not let a read-only collaborator delegate via the Task tool', async () => {
      const { pool, mockPM: pm } = createTestCollaboratorPool(mockPM);
      pm.setProviderAvailable('claude-code');
      pm.streamFactories.set('claude-code', () => createMockStream([
        { type: 'tool_use', toolCall: { id: 't1', name: 'Task', input: { prompt: 'write files' } } as any },
        { type: 'done' },
      ]));

      const chunks = await collectCollabChunks(
        pool.dispatch([collabSpec('c1', 'claude-code' as any, { access: 'read-only' })], collabOptions())
      );

      // Task must be denied for a read-only collaborator, not silently allowed.
      expect(chunks.some(c => c.type === 'collab_tool_denied')).toBe(true);
      expect(chunks.some(c => c.type === 'collab_tool_use')).toBe(false);
    });

    it('routes a gated-write Task delegation through the gate (not the read fast-path)', async () => {
      const { pool, mockPM: pm } = createTestCollaboratorPool(mockPM);
      pm.setProviderAvailable('claude-code');
      vi.spyOn(pm, 'suspendRequest').mockReturnValue(true);
      let gateCalled = false;
      pm.streamFactories.set('claude-code', () => createMockStream([
        { type: 'tool_use', toolCall: { id: 't1', name: 'agent', input: {} } as any },
        { type: 'done' },
      ]));

      await collectCollabChunks(
        pool.dispatch(
          [collabSpec('c1', 'claude-code' as any, { access: 'gated-write' })],
          collabOptions({ onGate: async () => { gateCalled = true; return false; } })
        )
      );

      expect(gateCalled).toBe(true);
    });

    it('allows a read-only advisor to do a web read without killing it (non-gating policy)', async () => {
      // Plan 18 (F5): the unconditional web fast-pass is gone — web reads now
      // defer to the user's gate policy. Under a NON-gating policy
      // (full access) the advisor's research still flows unprompted.
      const { pool, mockPM: pm } = createTestCollaboratorPool(mockPM);
      pm.setProviderAvailable('google-gemini');
      pm.streamFactories.set('google-gemini', () => createMockStream([
        { type: 'tool_use', toolCall: { id: 't1', name: 'WebFetch', input: { url: 'https://example.com' } } as any },
        { type: 'text', content: 'based on the page, ...' },
        { type: 'done' },
      ]));

      const chunks = await collectCollabChunks(
        pool.dispatch(
          [collabSpec('c1', 'google-gemini' as any, { access: 'read-only' })],
          collabOptions({ settings: collabSettings({ mode: 'edit-automatically', accessLevel: 'full-access' }) })
        )
      );

      expect(chunks.some(c => c.type === 'collab_tool_denied')).toBe(false);
      expect(chunks.some(c => c.type === 'collab_tool_use')).toBe(true);
      const complete = chunks.find(c => c.type === 'collab_complete');
      expect(complete!.hasError).toBeFalsy();
    });
  });

  describe('Cancel fan-out', () => {
    it('cancelRun cancels every live child of the run', async () => {
      const { pool, mockPM: pm } = createTestCollaboratorPool(mockPM);
      pm.setProviderAvailable('google-gemini');
      pm.setProviderAvailable('openai-codex');
      pm.streamFactories.set('google-gemini', () => createMockStream([{ type: 'text', content: 'g' }], { hang: true }));
      pm.streamFactories.set('openai-codex', () => createMockStream([{ type: 'text', content: 'c' }], { hang: true }));

      const gen = pool.dispatch(
        [collabSpec('c1', 'google-gemini' as any), collabSpec('c2', 'openai-codex' as any)],
        collabOptions({ maxConcurrent: 2 })
      );

      // Pull a few chunks so both children are dispatched, then cancel the run.
      const collected: CollaboratorChunk[] = [];
      const pump = (async () => {
        for await (const chunk of gen) {
          collected.push(chunk);
        }
      })();
      await new Promise(r => setTimeout(r, 20));
      pool.cancelRun('run-1');
      // Cancelling hung children lets the generator drain (mock cancel is a no-op
      // on the process, so also stop pumping after a beat).
      await new Promise(r => setTimeout(r, 10));

      expect(pm.cancelledPanelIds.filter(p => p.includes('collab')).length).toBeGreaterThanOrEqual(2);
      void pump;
    });

    it('derives UUID-scoped child panel ids that never collide across runs', async () => {
      const { pool, mockPM: pm } = createTestCollaboratorPool(mockPM);
      pm.setProviderAvailable('google-gemini');
      const seenPanels: string[] = [];
      pm.streamFactories.set('google-gemini', (_p, _c, _ctx, _s, _conv, _persona, panelId) => {
        seenPanels.push(panelId || '');
        return createMockStream(textChunks(['ok']));
      });

      await collectCollabChunks(pool.dispatch([collabSpec('c1', 'google-gemini' as any)], collabOptions({ runId: 'runA' })));
      await collectCollabChunks(pool.dispatch([collabSpec('c1', 'google-gemini' as any)], collabOptions({ runId: 'runB' })));

      expect(seenPanels[0]).toContain('collab-runA');
      expect(seenPanels[1]).toContain('collab-runB');
      expect(seenPanels[0]).not.toBe(seenPanels[1]);
    });
  });

  describe('Question relay', () => {
    it('relays a question and resumes with the answer on a follow-up process', async () => {
      const { pool, mockPM: pm } = createTestCollaboratorPool(mockPM);
      pm.setProviderAvailable('claude-code');
      let call = 0;
      pm.streamFactories.set('claude-code', () => {
        call++;
        if (call === 1) {
          return createMockStream([
            { type: 'text', content: 'thinking... ' },
            { type: 'ask_user_question', askUserQuestion: { questions: [{ question: 'Which one?', header: 'Choice', options: [] }] } } as any,
          ]);
        }
        return createMockStream(textChunks(['final answer']));
      });

      const chunks = await collectCollabChunks(
        pool.dispatch([collabSpec('c1', 'claude-code' as any)], collabOptions({
          onQuestion: async () => ({ answers: { Choice: 'A' } }),
        }))
      );

      expect(chunks.some(c => c.type === 'collab_ask_user_question')).toBe(true);
      const complete = chunks.find(c => c.type === 'collab_complete');
      expect(complete!.responseText).toContain('final answer');
      expect(complete!.hasError).toBeFalsy();
    });

    it('auto-skips a question when no relay callback is provided', async () => {
      const { pool, mockPM: pm } = createTestCollaboratorPool(mockPM);
      pm.setProviderAvailable('claude-code');
      pm.streamFactories.set('claude-code', () => createMockStream([
        { type: 'text', content: 'before' },
        { type: 'ask_user_question', askUserQuestion: { questions: [{ question: 'Q?', header: 'H', options: [] }] } } as any,
      ]));

      const chunks = await collectCollabChunks(
        pool.dispatch([collabSpec('c1', 'claude-code' as any)], collabOptions())
      );

      const complete = chunks.find(c => c.type === 'collab_complete');
      expect(complete!.responseText).toContain('auto-skipped');
    });
  });
});

// ---------------------------------------------------------------------------
// Plan 18 Wave 1 (H2 + Stop race): follow-up children are recorded for
// end-of-run disposal, and a disposed run is tombstoned so parked children
// resuming after Stop can't resurrect the tracking maps or spawn new children.
// ---------------------------------------------------------------------------
describe('CollaboratorPool disposeRun completeness (Plan 18)', () => {
  beforeEach(() => {
    clearMockConfig();
  });

  it('records question-relay follow-up children so disposeRun reclaims them', async () => {
    const { pool, mockPM } = createTestCollaboratorPool();
    // Child asks a question, user answers, follow-up child streams the answer.
    let call = 0;
    mockPM.streamFactories.set('google-gemini', () => {
      call++;
      if (call === 1) {
        return createMockStream([
          { type: 'ask_user_question', askUserQuestion: { questions: [{ question: 'Which file?', header: 'Q', options: [], multiSelect: false }] } } as unknown as StreamChunk,
          { type: 'done' } as StreamChunk,
        ]);
      }
      return createMockStream([
        { type: 'text', content: 'follow-up answer' } as StreamChunk,
        { type: 'done' } as StreamChunk,
      ]);
    });

    const spec = collabSpec('c1', 'google-gemini' as any);
    const options = collabOptions({
      runId: 'run-fu',
      onQuestion: async () => ({ answers: { Q: 'main.ts' } }),
    });
    await collectCollabChunks(pool.dispatch([spec], options));

    pool.disposeRun('run-fu');

    const disposed = mockPM.disposedChildren.map(d => d.panelId);
    expect(disposed.some(p => p.endsWith('-followup'))).toBe(true);
  });

  it('a parked child resuming after disposeRun cannot re-register or spawn a follow-up', async () => {
    const { pool, mockPM } = createTestCollaboratorPool();

    let releaseAnswer: (v: { answers: Record<string, string> }) => void = () => {};
    const answerPromise = new Promise<{ answers: Record<string, string> }>(r => { releaseAnswer = r; });

    let followUpDispatched = false;
    let call = 0;
    mockPM.streamFactories.set('google-gemini', () => {
      call++;
      if (call === 1) {
        return createMockStream([
          { type: 'ask_user_question', askUserQuestion: { questions: [{ question: 'Which?', header: 'Q', options: [], multiSelect: false }] } } as unknown as StreamChunk,
          { type: 'done' } as StreamChunk,
        ]);
      }
      followUpDispatched = true;
      return createMockStream([{ type: 'done' } as StreamChunk]);
    });

    const spec = collabSpec('c1', 'google-gemini' as any);
    const options = collabOptions({
      runId: 'run-race',
      onQuestion: () => answerPromise, // parks the child mid-run
    });

    const collecting = collectCollabChunks(pool.dispatch([spec], options));

    // Give the child time to reach the parked await, then Stop the run.
    await new Promise(r => setTimeout(r, 20));
    pool.disposeRun('run-race');

    // The user answers AFTER the run was reclaimed.
    releaseAnswer({ answers: { Q: 'too late' } });
    await collecting;

    expect(followUpDispatched).toBe(false);
    // The maps stay clean: a second disposeRun finds nothing new to reclaim.
    const before = mockPM.disposedChildren.length;
    pool.disposeRun('run-race');
    expect(mockPM.disposedChildren.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Plan 18 Wave 2 (F5): web-request defers to the user's gate policy instead
// of a hardcoded fast-pass — a repo-steered WebFetch is an exfil primitive.
// ---------------------------------------------------------------------------
describe('CollaboratorPool web-request policy (Plan 18 F5)', () => {
  beforeEach(() => {
    clearMockConfig();
  });

  function webFetchStream(): StreamChunk[] {
    return [
      { type: 'tool_use', toolCall: { id: 'w1', name: 'WebFetch', input: { url: 'https://example.com' } } } as StreamChunk,
      { type: 'text', content: 'fetched' } as StreamChunk,
      { type: 'done' } as StreamChunk,
    ];
  }

  it('gates a WebFetch under ask-permission (was a hardcoded pass)', async () => {
    const { pool, mockPM } = createTestCollaboratorPool();
    vi.spyOn(mockPM, 'suspendRequest').mockReturnValue(true);
    mockPM.setProviderChunks('google-gemini', webFetchStream());

    let gateAsked = false;
    const chunks = await collectCollabChunks(pool.dispatch(
      [collabSpec('c1', 'google-gemini' as any, { access: 'gated-write' })],
      collabOptions({
        runId: 'run-web-gate',
        // collabSettings default: mode 'default' + ask-permission → policy gates web requests
        onGate: async () => { gateAsked = true; return true; },
      })
    ));

    expect(gateAsked).toBe(true);
    expect(chunks.some(c => c.type === 'collab_tool_use')).toBe(true);
  });

  it('a read-only advisor gets the PROMPT for a policy-gated WebFetch, not the write hard-deny', async () => {
    const { pool, mockPM } = createTestCollaboratorPool();
    vi.spyOn(mockPM, 'suspendRequest').mockReturnValue(true);
    mockPM.setProviderChunks('google-gemini', webFetchStream());

    let gateAsked = false;
    const chunks = await collectCollabChunks(pool.dispatch(
      [collabSpec('c1', 'google-gemini' as any, { access: 'read-only' })],
      collabOptions({
        runId: 'run-web-ro',
        onGate: async () => { gateAsked = true; return true; },
      })
    ));

    expect(gateAsked).toBe(true);
    expect(chunks.some(c => c.type === 'collab_tool_denied')).toBe(false);
  });

  it('still fast-passes a WebFetch where policy would not gate it (full access)', async () => {
    const { pool, mockPM } = createTestCollaboratorPool();
    mockPM.setProviderChunks('google-gemini', webFetchStream());

    let gateAsked = false;
    const chunks = await collectCollabChunks(pool.dispatch(
      [collabSpec('c1', 'google-gemini' as any, { access: 'gated-write' })],
      collabOptions({
        runId: 'run-web-free',
        settings: collabSettings({ mode: 'edit-automatically', accessLevel: 'full-access' }),
        onGate: async () => { gateAsked = true; return true; },
      })
    ));

    expect(gateAsked).toBe(false);
    expect(chunks.some(c => c.type === 'collab_tool_use')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Plan 18 W2 review corrections: read-only specs always prompt for web reads
// (never silently ungated under the strictest setting), and a failed freeze
// downgrades a web read to a best-effort prompt instead of a kill.
// ---------------------------------------------------------------------------
describe('CollaboratorPool web-request corrections (Plan 18 W2 review)', () => {
  beforeEach(() => { clearMockConfig(); });

  it('read-only spec + read-only user policy: web request still PROMPTS (never ungated)', async () => {
    const { pool, mockPM } = createTestCollaboratorPool();
    vi.spyOn(mockPM, 'suspendRequest').mockReturnValue(true);
    mockPM.setProviderChunks('google-gemini', [
      { type: 'tool_use', toolCall: { id: 'w1', name: 'WebFetch', input: { url: 'https://evil.example' } } } as StreamChunk,
      { type: 'done' } as StreamChunk,
    ]);

    let gateAsked = false;
    await collectCollabChunks(pool.dispatch(
      [collabSpec('c1', 'google-gemini' as any, { access: 'read-only' })],
      collabOptions({
        runId: 'run-ro-strict',
        // Under accessLevel read-only the bare policy fn gates nothing —
        // the read-only spec must force the prompt anyway.
        settings: collabSettings({ accessLevel: 'read-only' }),
        onGate: async () => { gateAsked = true; return false; },
      })
    ));

    expect(gateAsked).toBe(true);
  });

  it('failed freeze (Windows) prompts for a web read instead of killing the child', async () => {
    const { pool, mockPM } = createTestCollaboratorPool();
    vi.spyOn(mockPM, 'suspendRequest').mockReturnValue(false); // no SIGSTOP available
    mockPM.setProviderChunks('google-gemini', [
      { type: 'tool_use', toolCall: { id: 'w1', name: 'WebFetch', input: { url: 'https://example.com' } } } as StreamChunk,
      { type: 'text', content: 'researched' } as StreamChunk,
      { type: 'done' } as StreamChunk,
    ]);

    let gateAsked = false;
    const chunks = await collectCollabChunks(pool.dispatch(
      [collabSpec('c1', 'google-gemini' as any, { access: 'gated-write' })],
      collabOptions({
        runId: 'run-win-web',
        onGate: async () => { gateAsked = true; return true; },
      })
    ));

    expect(gateAsked).toBe(true);
    expect(chunks.some(c => c.type === 'collab_tool_denied')).toBe(false);
    expect(chunks.some(c => c.type === 'collab_tool_use')).toBe(true);
  });

  it('failed freeze still fail-closes for WRITES (unchanged)', async () => {
    const { pool, mockPM } = createTestCollaboratorPool();
    vi.spyOn(mockPM, 'suspendRequest').mockReturnValue(false);
    mockPM.setProviderChunks('google-gemini', [
      { type: 'tool_use', toolCall: { id: 'w1', name: 'Write', input: { path: 'x' } } } as StreamChunk,
      { type: 'done' } as StreamChunk,
    ]);

    let gateAsked = false;
    const chunks = await collectCollabChunks(pool.dispatch(
      [collabSpec('c1', 'google-gemini' as any, { access: 'gated-write' })],
      collabOptions({ runId: 'run-win-write', onGate: async () => { gateAsked = true; return true; } })
    ));

    expect(gateAsked).toBe(false);
    expect(chunks.some(c => c.type === 'collab_tool_denied')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Plan 18 Wave 4 (1.3): follow-up deadline + approved-write terminal retry.
// ---------------------------------------------------------------------------
describe('CollaboratorPool Wave 4 (follow-up deadline, write-terminal retry)', () => {
  beforeEach(() => { clearMockConfig(); });

  it('an approved gated write makes a later crash TERMINAL (no retry, no double-apply)', async () => {
    const { pool, mockPM } = createTestCollaboratorPool();
    vi.spyOn(mockPM, 'suspendRequest').mockReturnValue(true);
    let dispatches = 0;
    mockPM.streamFactories.set('claude-code', () => {
      dispatches++;
      return (async function* (): AsyncGenerator<StreamChunk> {
        yield { type: 'tool_use', toolCall: { id: 'w1', name: 'Write', input: { path: 'a.ts' } } } as StreamChunk;
        throw new Error('CLI crashed after the write');
      })();
    });

    const chunks = await collectCollabChunks(pool.dispatch(
      [collabSpec('c1', 'claude-code' as any, { access: 'gated-write' })],
      collabOptions({ runId: 'run-write-term', onGate: async () => true })
    ));

    expect(dispatches).toBe(1); // crashed AFTER an approved write → no retry
    const complete = chunks.find(c => c.type === 'collab_complete');
    expect(complete?.hasError).toBe(true);
  });

  it('a crash with NO approved write still retries (unchanged)', async () => {
    const { pool, mockPM } = createTestCollaboratorPool();
    let dispatches = 0;
    mockPM.streamFactories.set('claude-code', () => {
      dispatches++;
      if (dispatches === 1) {
        return (async function* (): AsyncGenerator<StreamChunk> {
          yield { type: 'text', content: 'partial' } as StreamChunk;
          throw new Error('transient crash');
        })();
      }
      return createMockStream([
        { type: 'text', content: 'recovered' } as StreamChunk,
        { type: 'done' } as StreamChunk,
      ]);
    });

    const chunks = await collectCollabChunks(pool.dispatch(
      [collabSpec('c1', 'claude-code' as any)],
      collabOptions({ runId: 'run-retry-ok' })
    ));

    expect(dispatches).toBe(2);
    const complete = chunks.find(c => c.type === 'collab_complete');
    expect(complete?.hasError).toBeFalsy();
  });

  it('a hung question follow-up stream is terminated by the deadline', async () => {
    const { pool, mockPM } = createTestCollaboratorPool();
    let call = 0;
    mockPM.streamFactories.set('google-gemini', () => {
      call++;
      if (call === 1) {
        return createMockStream([
          { type: 'ask_user_question', askUserQuestion: { questions: [{ question: 'Q?', header: 'Q', options: [], multiSelect: false }] } } as unknown as StreamChunk,
          { type: 'done' } as StreamChunk,
        ]);
      }
      // Follow-up: yields once then hangs forever.
      return createMockStream([{ type: 'text', content: 'starting…' } as StreamChunk], { hang: true });
    });

    const chunks = await collectCollabChunks(pool.dispatch(
      [collabSpec('c1', 'google-gemini' as any, { timeoutMs: 150 })],
      collabOptions({
        runId: 'run-fu-hang',
        onQuestion: async () => ({ answers: { Q: 'ok' } }),
      })
    ));

    const complete = chunks.find(c => c.type === 'collab_complete');
    expect(complete).toBeTruthy();
    expect(complete?.hasError).toBe(true);
  }, 10000);
});

// ---------------------------------------------------------------------------
// Plan 21 Phase 0 — the `sealed` access class.
//
// The hole this closes: a `read-only` collaborator keeps its web-request
// carve-out, so under `edit-automatically` + `full-access` a WebFetch fast-
// passes with NO prompt (see "still fast-passes a WebFetch where policy would
// not gate it" above — that behaviour is correct and stays). That carve-out
// exists because a local advisor doing research is the point.
//
// It stops being correct the moment the PROMPT is authored off-machine: the
// fetch body is then attacker-chosen and the pass is a zero-prompt exfiltration
// channel. `sealed` is the class for that case — reads, nothing else, with no
// policy consultation and no carve-out reachable.
// ---------------------------------------------------------------------------
describe('CollaboratorPool sealed access (Plan 21 Phase 0)', () => {
  beforeEach(() => {
    clearMockConfig();
  });

  function toolStream(name: string, input: Record<string, unknown>): StreamChunk[] {
    return [
      { type: 'tool_use', toolCall: { id: 's1', name, input } } as StreamChunk,
      { type: 'text', content: 'after' } as StreamChunk,
      { type: 'done' } as StreamChunk,
    ];
  }

  /** The most permissive configuration that exists — the one that fast-passes. */
  const PERMISSIVE = { mode: 'edit-automatically' as const, accessLevel: 'full-access' as const };

  it('denies a WebFetch under the MOST permissive settings, and never consults the gate', async () => {
    const { pool, mockPM } = createTestCollaboratorPool();
    vi.spyOn(mockPM, 'suspendRequest').mockReturnValue(true);
    mockPM.setProviderChunks('google-gemini', toolStream('WebFetch', { url: 'https://evil.example' }));

    let gateAsked = false;
    const chunks = await collectCollabChunks(pool.dispatch(
      [collabSpec('c1', 'google-gemini' as any, { access: 'sealed' })],
      collabOptions({
        runId: 'run-sealed-web',
        settings: collabSettings(PERMISSIVE),
        onGate: async () => { gateAsked = true; return true; },
      })
    ));

    // No policy consultation at all: the deny is structural, not a decision.
    expect(gateAsked).toBe(false);
    expect(chunks.some(c => c.type === 'collab_tool_denied')).toBe(true);
    // And the tool never reaches the caller to be re-emitted.
    expect(chunks.some(c => c.type === 'collab_tool_use')).toBe(false);
  });

  it('a gated-write collaborator DOES fast-pass the same fetch — proving the difference is the class, not the settings', async () => {
    const { pool, mockPM } = createTestCollaboratorPool();
    mockPM.setProviderChunks('google-gemini', toolStream('WebFetch', { url: 'https://evil.example' }));

    const chunks = await collectCollabChunks(pool.dispatch(
      [collabSpec('c1', 'google-gemini' as any, { access: 'gated-write' })],
      collabOptions({
        runId: 'run-unsealed-web',
        settings: collabSettings(PERMISSIVE),
        onGate: async () => true,
      })
    ));

    expect(chunks.some(c => c.type === 'collab_tool_use')).toBe(true);
    expect(chunks.some(c => c.type === 'collab_tool_denied')).toBe(false);
  });

  it('still allows a plain file read — the sealed surface is exactly the read fast-path', async () => {
    const { pool, mockPM } = createTestCollaboratorPool();
    mockPM.setProviderChunks('google-gemini', toolStream('Read', { file_path: 'src/index.ts' }));

    const chunks = await collectCollabChunks(pool.dispatch(
      [collabSpec('c1', 'google-gemini' as any, { access: 'sealed' })],
      collabOptions({ runId: 'run-sealed-read', settings: collabSettings(PERMISSIVE) })
    ));

    expect(chunks.some(c => c.type === 'collab_tool_denied')).toBe(false);
    expect(chunks.some(c => c.type === 'collab_tool_use')).toBe(true);
  });

  it('denies a write even under full-access', async () => {
    const { pool, mockPM } = createTestCollaboratorPool();
    vi.spyOn(mockPM, 'suspendRequest').mockReturnValue(true);
    mockPM.setProviderChunks('google-gemini', toolStream('Write', { file_path: 'x.ts', content: 'hi' }));

    let gateAsked = false;
    const chunks = await collectCollabChunks(pool.dispatch(
      [collabSpec('c1', 'google-gemini' as any, { access: 'sealed' })],
      collabOptions({
        runId: 'run-sealed-write',
        settings: collabSettings(PERMISSIVE),
        onGate: async () => { gateAsked = true; return true; },
      })
    ));

    expect(gateAsked).toBe(false);
    expect(chunks.some(c => c.type === 'collab_tool_denied')).toBe(true);
  });

  it('denies a delegation tool, which classifies as a READ but hides writes inside the child', async () => {
    const { pool, mockPM } = createTestCollaboratorPool();
    vi.spyOn(mockPM, 'suspendRequest').mockReturnValue(true);
    mockPM.setProviderChunks('google-gemini', toolStream('task', { prompt: 'write a file for me' }));

    // An APPROVING gate is supplied deliberately: without the sealed branch the
    // spec would fall through to the gated-write path and this hook would let
    // the delegation run. Asserting it is never asked is what makes this test
    // discriminate, rather than passing via the generic fail-closed deny.
    let gateAsked = false;
    const chunks = await collectCollabChunks(pool.dispatch(
      [collabSpec('c1', 'google-gemini' as any, { access: 'sealed' })],
      collabOptions({
        runId: 'run-sealed-task',
        settings: collabSettings(PERMISSIVE),
        onGate: async () => { gateAsked = true; return true; },
      })
    ));

    expect(gateAsked).toBe(false);
    expect(chunks.some(c => c.type === 'collab_tool_denied')).toBe(true);
    expect(chunks.some(c => c.type === 'collab_tool_use')).toBe(false);
  });

  it('denies even when the freeze fails — no best-effort-prompt downgrade for a sealed web read', async () => {
    // read-only downgrades a web read to a prompt when SIGSTOP is unavailable
    // (Windows). sealed must not: an off-machine prompt gets no best effort.
    const { pool, mockPM } = createTestCollaboratorPool();
    vi.spyOn(mockPM, 'suspendRequest').mockReturnValue(false);
    mockPM.setProviderChunks('google-gemini', toolStream('WebFetch', { url: 'https://evil.example' }));

    let gateAsked = false;
    const chunks = await collectCollabChunks(pool.dispatch(
      [collabSpec('c1', 'google-gemini' as any, { access: 'sealed' })],
      collabOptions({
        runId: 'run-sealed-nofreeze',
        settings: collabSettings(PERMISSIVE),
        onGate: async () => { gateAsked = true; return true; },
      })
    ));

    expect(gateAsked).toBe(false);
    expect(chunks.some(c => c.type === 'collab_tool_denied')).toBe(true);
  });

  it('runs the child at read-only accessLevel regardless of the parent settings', async () => {
    const { pool, mockPM } = createTestCollaboratorPool();
    mockPM.setProviderChunks('google-gemini', textChunks(['ok']));

    await collectCollabChunks(pool.dispatch(
      [collabSpec('c1', 'google-gemini' as any, { access: 'sealed' })],
      collabOptions({ runId: 'run-sealed-level', settings: collabSettings(PERMISSIVE) })
    ));

    const call = mockPM.sendCalls.find(c => c.providerId === 'google-gemini');
    expect(call, 'the collaborator must actually have been dispatched').toBeDefined();
    expect(call!.settings.accessLevel).toBe('read-only');
  });
});
