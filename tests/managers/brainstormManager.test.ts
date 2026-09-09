/**
 * BrainstormManager stability tests.
 * Simulates user scenarios with mocked providers to verify brainstorm mode behavior
 * for Claude Code, Gemini, and Codex.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { clearMockConfig } from '../helpers/mockVscode';
import { MockProviderManager, createMockStream } from '../helpers/mockProviderManager';
import {
  createTestBrainstormManager,
  configureBrainstorm,
  createMockSettings,
  makeTextChunks,
  collectChunks
} from '../helpers/brainstormFactory';
import type { CollaborationStrategy, StreamChunk } from '../../src/types';
import { BRAINSTORM_SILENCE_TIMEOUT_MS } from '../../src/constants';

describe('BrainstormManager', () => {
  let mockPM: MockProviderManager;

  beforeEach(() => {
    clearMockConfig();
    mockPM = new MockProviderManager();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Happy path — quick strategy with Claude + Gemini
  // =========================================================================
  describe('Quick strategy happy path', () => {
    it('should yield individual + synthesis phases with both agents responding', async () => {
      const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);

      // Configure 2 agents
      configureBrainstorm({ agents: ['claude-code', 'google-gemini'], strategy: 'quick', synthesisAgent: 'claude-code' });
      pm.setProviderAvailable('claude-code', 'Claude');
      pm.setProviderAvailable('google-gemini', 'Gemini');

      // Mock responses
      pm.setProviderChunks('claude-code', makeTextChunks(['Claude analysis: React is component-based.']));
      pm.setProviderChunks('google-gemini', makeTextChunks(['Gemini analysis: Vue is progressive.']));

      const settings = createMockSettings();
      const chunks = await collectChunks(manager.startBrainstormSession('Compare React vs Vue', [], settings, 'panel-1'));

      // Verify phase transitions
      const phaseChanges = chunks.filter(c => c.type === 'phase_change');
      expect(phaseChanges.length).toBeGreaterThanOrEqual(2); // individual + synthesis + complete

      // Verify both agents produced text
      const agentTexts = chunks.filter(c => c.type === 'agent_text');
      const agentIds = new Set(agentTexts.map(c => c.agentId));
      expect(agentIds.has('claude-code')).toBe(true);
      expect(agentIds.has('google-gemini')).toBe(true);

      // Verify synthesis happened
      const synthesisTexts = chunks.filter(c => c.type === 'synthesis_text');
      expect(synthesisTexts.length).toBeGreaterThan(0);

      // Verify done
      expect(chunks[chunks.length - 1].type).toBe('done');
    });
  });

  // =========================================================================
  // 2. Happy path — debate strategy with Codex + Claude
  // =========================================================================
  describe('Debate strategy happy path', () => {
    it('should run individual → discussion → synthesis phases', async () => {
      const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);

      configureBrainstorm({
        agents: ['openai-codex', 'claude-code'],
        strategy: 'debate',
        maxRounds: 1,
        autoConverge: false,
        synthesisAgent: 'claude-code'
      });
      pm.setProviderAvailable('openai-codex', 'Codex');
      pm.setProviderAvailable('claude-code', 'Claude');

      // Individual + discussion + synthesis all use sendMessageToProvider
      pm.setProviderChunks('openai-codex', makeTextChunks(['Codex: Use TypeScript for type safety.']));
      pm.setProviderChunks('claude-code', makeTextChunks(['Claude: TypeScript adds complexity but improves maintainability.']));

      const settings = createMockSettings();
      const chunks = await collectChunks(manager.startBrainstormSession('Should we use TypeScript?', [], settings, 'panel-2'));

      const phases = chunks.filter(c => c.type === 'phase_change').map(c => c.phase);
      expect(phases).toContain('individual');
      expect(phases).toContain('discussion');
      expect(phases).toContain('synthesis');
      expect(phases).toContain('complete');
    });
  });

  // =========================================================================
  // 3. Silence timeout — agent hangs mid-stream (B1)
  // =========================================================================
  describe('Silence timeout (B1)', () => {
    it('should emit agent_error when an agent goes silent', async () => {
      const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);

      configureBrainstorm({ agents: ['claude-code', 'google-gemini'], strategy: 'quick', synthesisAgent: 'google-gemini' });
      pm.setProviderAvailable('claude-code', 'Claude');
      pm.setProviderAvailable('google-gemini', 'Gemini');

      // Claude hangs after 2 chunks
      pm.streamFactories.set('claude-code', () => createMockStream(
        [{ type: 'text', content: 'Starting...' }, { type: 'text', content: 'Analyzing...' }],
        { hang: true }
      ));
      // Gemini responds normally
      pm.setProviderChunks('google-gemini', makeTextChunks(['Gemini completed its analysis.']));

      const settings = createMockSettings();

      // FAKE timers. The hang is `await new Promise(() => {})` — never a timer —
      // so the ONLY real clock here is the manager's own silence `setTimeout`.
      // Waiting it out for real cost 90 s, which was ~98% of the entire suite's
      // wall clock on three CI runners. advanceTimersByTimeAsync flushes
      // microtasks between fires, so the async generator actually progresses;
      // advanceTimersByTime (sync) would fire the timer and then deadlock on the
      // generator's pending await.
      vi.useFakeTimers();
      try {
        const pending = collectChunks(manager.startBrainstormSession('Test query', [], settings, 'panel-timeout'));
        await vi.advanceTimersByTimeAsync(BRAINSTORM_SILENCE_TIMEOUT_MS + 1_000);
        const chunks = await pending;

        // Should have an agent_error for claude-code
        const errors = chunks.filter(c => c.type === 'agent_error' && c.agentId === 'claude-code');
        expect(errors.length).toBe(1);
        expect(errors[0].content).toContain('silent');

        // Gemini should still complete
        const geminiComplete = chunks.filter(c => c.type === 'agent_complete' && c.agentId === 'google-gemini');
        expect(geminiComplete.length).toBe(1);
        expect(pm.cancelledPanelIds).toContain('panel-timeout-brainstorm-claude-code');
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it.each(['silence', 'error'] as const)('cancels a failed discussion child on %s and still synthesizes', async (failure) => {
      vi.useFakeTimers();
      const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);
      configureBrainstorm({ agents: ['claude-code', 'google-gemini'], strategy: 'debate', maxRounds: 1, autoConverge: false, synthesisAgent: 'claude-code' });
      pm.setProviderAvailable('claude-code');
      pm.setProviderAvailable('google-gemini');
      let calls = 0;
      pm.streamFactories.set('claude-code', () => ++calls === 2
        ? createMockStream(failure === 'error' ? [{ type: 'error', content: 'Discussion failed' }] : [], { hang: failure === 'silence' })
        : createMockStream(makeTextChunks(['Analysis and synthesis'])));
      pm.setProviderChunks('google-gemini', makeTextChunks(['Gemini analysis']));

      const pending = collectChunks(manager.startBrainstormSession('q', [], createMockSettings(), 'panel-discussion-failure'));
      await vi.advanceTimersByTimeAsync(BRAINSTORM_SILENCE_TIMEOUT_MS);
      const chunks = await pending;
      expect(chunks.filter(c => c.type === 'discussion_error' && c.agentId === 'claude-code')).toHaveLength(1);
      expect(pm.cancelledPanelIds).toContain('panel-discussion-failure-brainstorm-claude-code');
      expect(chunks.some(c => c.type === 'synthesis_text')).toBe(true);
      expect(chunks.at(-1)?.type).toBe('done');
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  // =========================================================================
  // 3b. Silence timer cleanup — per-chunk timer leak fix (part of #31)
  // =========================================================================
  describe('Silence timer cleanup (#31 timer leak)', () => {
    type SilenceIterable = {
      _iterateWithSilenceTimeout<T>(gen: AsyncGenerator<T>, timeoutMs?: number | null, signal?: AbortSignal): AsyncGenerator<T>;
    };

    afterEach(() => {
      vi.useRealTimers();
    });

    function getIterate(manager: unknown) {
      const m = manager as SilenceIterable;
      return m._iterateWithSilenceTimeout.bind(m);
    }

    async function* makeChunks(count: number): AsyncGenerator<number> {
      for (let i = 0; i < count; i++) {
        yield i;
      }
    }

    it('should keep at most one live timer per chunk and clear all on completion', async () => {
      vi.useFakeTimers();
      const { manager } = createTestBrainstormManager(mockPM);
      const iterate = getIterate(manager);

      const received: number[] = [];
      for await (const value of iterate(makeChunks(5), 1000)) {
        received.push(value);
        // Timer is cleared before each chunk is yielded — no accumulation across chunks.
        // (The pre-fix implementation leaked one un-cleared 90s timer per chunk.)
        expect(vi.getTimerCount()).toBe(0);
      }
      expect(received).toEqual([0, 1, 2, 3, 4]);
      // No timers left pending after the generator completes
      expect(vi.getTimerCount()).toBe(0);
    });

    it('should clear the pending timer when the source generator throws', async () => {
      vi.useFakeTimers();
      const { manager } = createTestBrainstormManager(mockPM);
      const iterate = getIterate(manager);

      async function* failing(): AsyncGenerator<number> {
        yield 1;
        throw new Error('stream blew up');
      }

      const received: number[] = [];
      await expect(async () => {
        for await (const value of iterate(failing(), 1000)) {
          received.push(value);
        }
      }).rejects.toThrow('stream blew up');

      expect(received).toEqual([1]);
      // The timer armed for the failed next() must have been cleared
      expect(vi.getTimerCount()).toBe(0);
    });

    it('should still abort after sustained silence (timeout policy unchanged)', async () => {
      vi.useFakeTimers();
      const { manager } = createTestBrainstormManager(mockPM);
      const iterate = getIterate(manager);

      async function* hanging(): AsyncGenerator<number> {
        yield 1;
        await new Promise(() => { /* hang forever */ });
      }

      const gen = iterate(hanging(), 1000);
      const first = await gen.next();
      expect(first.value).toBe(1);

      // Attach rejection handling before advancing the clock
      const outcome = gen.next().then(
        () => 'resolved',
        (err: Error) => err.message
      );
      await vi.advanceTimersByTimeAsync(1001);

      expect(await outcome).toContain('silent');
      // Fired timer is gone and nothing else is left pending
      expect(vi.getTimerCount()).toBe(0);
    });

    it('closes the source generator when its consumer stops early', async () => {
      const { manager } = createTestBrainstormManager(mockPM);
      const iterate = getIterate(manager);
      const closed = vi.fn();
      async function* source(): AsyncGenerator<number> {
        try {
          yield 1;
          yield 2;
        } finally {
          closed();
        }
      }
      for await (const _value of iterate(source(), 1000)) { break; }
      expect(closed).toHaveBeenCalledOnce();
    });

    it('honors cancellation triggered synchronously by the source before it hangs', async () => {
      vi.useFakeTimers();
      const { manager } = createTestBrainstormManager(mockPM);
      const controller = new AbortController();
      const cancellation = new Error('Stopped while advancing the source');
      async function* source(): AsyncGenerator<number> {
        controller.abort(cancellation);
        await new Promise<void>(() => {});
        yield 1;
      }
      const iterator = getIterate(manager)(source(), null, controller.signal);
      await expect(iterator.next()).rejects.toBe(cancellation);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  // =========================================================================
  // 4. Auth failure — unauthenticated provider (B2)
  // =========================================================================
  describe('Authentication check (B2)', () => {
    it('should reject unauthenticated providers before starting', async () => {
      const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);

      configureBrainstorm({ agents: ['claude-code', 'google-gemini'], strategy: 'quick' });
      pm.setProviderAvailable('claude-code', 'Claude');
      pm.setProviderUnauthenticated('google-gemini');

      const settings = createMockSettings();
      const chunks = await collectChunks(manager.startBrainstormSession('Test', [], settings, 'panel-auth'));

      // Should get an error about needing 2 available providers
      const errors = chunks.filter(c => c.type === 'agent_error');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].content).toContain('not authenticated');
    });
  });

  // =========================================================================
  // 5. Synthesis fallback — primary agent fails (B3)
  // =========================================================================
  describe('Synthesis fallback (B3)', () => {
    it('should yield synthesis_fallback chunk before retrying with another agent', async () => {
      const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);

      configureBrainstorm({ agents: ['claude-code', 'google-gemini'], strategy: 'quick', synthesisAgent: 'claude-code' });
      pm.setProviderAvailable('claude-code', 'Claude');
      pm.setProviderAvailable('google-gemini', 'Gemini');

      let claudeCallCount = 0;
      pm.streamFactories.set('claude-code', () => {
        claudeCallCount++;
        if (claudeCallCount <= 1) {
          // First call: individual phase — succeed
          return createMockStream(makeTextChunks(['Claude individual response']));
        }
        // Second call: synthesis — fail
        return createMockStream([], { throwAfter: new Error('Synthesis failed') });
      });
      pm.setProviderChunks('google-gemini', makeTextChunks(['Gemini synthesis result']));

      const settings = createMockSettings();
      const chunks = await collectChunks(manager.startBrainstormSession('Test', [], settings, 'panel-synth'));

      // Should have a synthesis_fallback chunk
      const fallbacks = chunks.filter(c => c.type === 'synthesis_fallback');
      expect(fallbacks.length).toBe(1);
      expect(fallbacks[0].content).toContain('Retrying');

      // Should still get synthesis text from fallback agent
      const synthTexts = chunks.filter(c => c.type === 'synthesis_text');
      expect(synthTexts.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 6. Synthesis total failure — both agents fail
  // =========================================================================
  describe('Synthesis total failure', () => {
    it('should concatenate individual analyses as last resort', async () => {
      const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);

      configureBrainstorm({ agents: ['claude-code', 'google-gemini'], strategy: 'quick', synthesisAgent: 'claude-code' });
      pm.setProviderAvailable('claude-code', 'Claude');
      pm.setProviderAvailable('google-gemini', 'Gemini');

      let claudeCallCount = 0;
      let geminiCallCount = 0;
      pm.streamFactories.set('claude-code', () => {
        claudeCallCount++;
        if (claudeCallCount === 1) { return createMockStream(makeTextChunks(['Claude analysis'])); }
        return createMockStream([], { throwAfter: new Error('fail') });
      });
      pm.streamFactories.set('google-gemini', () => {
        geminiCallCount++;
        if (geminiCallCount === 1) { return createMockStream(makeTextChunks(['Gemini analysis'])); }
        return createMockStream([], { throwAfter: new Error('fail') });
      });

      const settings = createMockSettings();
      const chunks = await collectChunks(manager.startBrainstormSession('Test', [], settings, 'panel-both-fail'));

      // Should get fallback concatenated content
      const synthTexts = chunks.filter(c => c.type === 'synthesis_text');
      expect(synthTexts.length).toBeGreaterThan(0);
      const combined = synthTexts.map(c => c.content).join('');
      expect(combined).toContain('individual analyses below');
    });
  });

  // =========================================================================
  // 7. Duplicate agents (B8)
  // =========================================================================
  describe('Duplicate agent validation (B8)', () => {
    it('should reject when both agents are the same', async () => {
      const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);

      configureBrainstorm({ agents: ['claude-code', 'claude-code'], strategy: 'quick' });
      pm.setProviderAvailable('claude-code', 'Claude');

      const settings = createMockSettings();
      const chunks = await collectChunks(manager.startBrainstormSession('Test', [], settings, 'panel-dup'));

      const errors = chunks.filter(c => c.type === 'agent_error');
      expect(errors.length).toBe(1);
      expect(errors[0].content).toContain('2 different providers');

      const done = chunks.filter(c => c.type === 'done');
      expect(done.length).toBe(1);
    });
  });

  // =========================================================================
  // 8. Empty discussion contribution (B6)
  // =========================================================================
  describe('Empty contribution guard (B6)', () => {
    it('should not falsely converge when agent returns only thinking', async () => {
      const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);

      configureBrainstorm({
        agents: ['claude-code', 'google-gemini'],
        strategy: 'debate',
        maxRounds: 2,
        autoConverge: true,
        synthesisAgent: 'claude-code'
      });
      pm.setProviderAvailable('claude-code', 'Claude');
      pm.setProviderAvailable('google-gemini', 'Gemini');

      let callCount = 0;
      pm.streamFactories.set('claude-code', () => {
        callCount++;
        if (callCount === 1) { return createMockStream(makeTextChunks(['Claude individual'])); }
        // Discussion: return only thinking, no text
        return createMockStream([
          { type: 'thinking', content: 'Thinking about this...' } as StreamChunk,
          { type: 'done' } as StreamChunk
        ]);
      });
      pm.setProviderChunks('google-gemini', makeTextChunks(['Gemini response with content']));

      const settings = createMockSettings();
      const chunks = await collectChunks(manager.startBrainstormSession('Test', [], settings, 'panel-empty'));

      // Should NOT have a premature convergence with 'converged' recommendation
      const convergenceUpdates = chunks.filter(c => c.type === 'convergence_update');
      for (const cu of convergenceUpdates) {
        if (cu.convergence) {
          expect(cu.convergence.recommendation).not.toBe('converged');
        }
      }
    });
  });

  // =========================================================================
  // 9. Convergence oscillation (B4) — tested indirectly via assessConvergence behavior
  // =========================================================================
  describe('Convergence oscillation (B4)', () => {
    it('should detect stalled state when positions oscillate', async () => {
      const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);

      configureBrainstorm({
        agents: ['claude-code', 'google-gemini'],
        strategy: 'debate',
        maxRounds: 4,
        autoConverge: true,
        synthesisAgent: 'claude-code'
      });
      pm.setProviderAvailable('claude-code', 'Claude');
      pm.setProviderAvailable('google-gemini', 'Gemini');

      // Alternate between two fixed positions
      let claudeCall = 0;
      pm.streamFactories.set('claude-code', () => {
        claudeCall++;
        if (claudeCall === 1) { return createMockStream(makeTextChunks(['I strongly agree with using React for its ecosystem'])); }
        // Odd rounds: position A, Even rounds: position B
        const position = claudeCall % 2 === 0
          ? 'I disagree, we should reject React and maintain Vue instead'
          : 'I agree, we should accept React and defend its ecosystem';
        return createMockStream(makeTextChunks([position]));
      });

      let geminiCall = 0;
      pm.streamFactories.set('google-gemini', () => {
        geminiCall++;
        if (geminiCall === 1) { return createMockStream(makeTextChunks(['I strongly agree with using Vue for its simplicity'])); }
        const position = geminiCall % 2 === 0
          ? 'I agree with the React approach and accept the complexity'
          : 'I disagree and reject React, we should defend Vue simplicity';
        return createMockStream(makeTextChunks([position]));
      });

      const settings = createMockSettings();
      const chunks = await collectChunks(manager.startBrainstormSession('React vs Vue', [], settings, 'panel-oscillate'));

      // With 4 rounds, oscillation should eventually be detected as stalled
      const convergenceUpdates = chunks.filter(c => c.type === 'convergence_update');
      // Should reach synthesis (not infinite loop)
      expect(chunks.some(c => c.type === 'phase_change' && c.phase === 'synthesis')).toBe(true);
    });
  });

  // =========================================================================
  // 10. Delphi convergence score variants (B5)
  // =========================================================================
  describe('Delphi convergence regex (B5)', () => {
    it('should parse various convergence score phrasings', async () => {
      const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);

      configureBrainstorm({
        agents: ['claude-code', 'google-gemini'],
        strategy: 'delphi',
        maxRounds: 1,
        autoConverge: true,
        synthesisAgent: 'claude-code'
      });
      pm.setProviderAvailable('claude-code', 'Claude');
      pm.setProviderAvailable('google-gemini', 'Gemini');

      // Facilitator = claude-code (first agent), uses "Consensus Score: 9 / 10" phrasing
      let claudeCall = 0;
      pm.streamFactories.set('claude-code', () => {
        claudeCall++;
        if (claudeCall === 1) { return createMockStream(makeTextChunks(['Claude individual analysis'])); }
        if (claudeCall === 2) {
          // Facilitator summary with alternative phrasing
          return createMockStream(makeTextChunks(['Summary: Both agents agree.\n\nConsensus Score: 9 / 10']));
        }
        // Synthesis
        return createMockStream(makeTextChunks(['Final synthesis.']));
      });
      pm.setProviderChunks('google-gemini', makeTextChunks(['Gemini agrees with the approach.']));

      const settings = createMockSettings();
      const chunks = await collectChunks(manager.startBrainstormSession('Test delphi', [], settings, 'panel-delphi'));

      // Should parse the convergence score
      const convergenceUpdates = chunks.filter(c => c.type === 'convergence_update');
      if (convergenceUpdates.length > 0 && convergenceUpdates[0].convergence) {
        // 9/10 = 0.9, which should trigger converged
        expect(convergenceUpdates[0].convergence.overallConvergence).toBe(0.9);
      }
    });
  });

  // =========================================================================
  // 11. Cancel mid-brainstorm (B9)
  // =========================================================================
  describe('Cancel propagation (B9)', () => {
    const strategies: CollaborationStrategy[] = ['quick', 'debate', 'red-team', 'perspectives', 'delphi'];

    it.each(strategies)('cancels silent %s agents immediately without dispatching another phase', async (strategy) => {
      vi.useFakeTimers();
      const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);

      configureBrainstorm({ agents: ['claude-code', 'google-gemini'], strategy, synthesisAgent: 'claude-code' });
      pm.setProviderAvailable('claude-code', 'Claude');
      pm.setProviderAvailable('google-gemini', 'Gemini');

      // These providers ignore cancellation and never settle. Stop must release
      // the consumer independently of a provider's cooperation or a timeout.
      pm.setProviderChunks('claude-code', [{ type: 'text', content: 'Working...' }], { hang: true });
      pm.setProviderChunks('google-gemini', [{ type: 'text', content: 'Working...' }], { hang: true });
      const panelId = 'panel-cancel';
      const pending = collectChunks(manager.startBrainstormSession('Test cancel', [], createMockSettings(), panelId));
      await vi.advanceTimersByTimeAsync(0);
      const dispatched = pm.sendCalls.length;
      expect(dispatched).toBeGreaterThan(0);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      manager.cancelSession(panelId);
      const chunks = await pending;
      await vi.advanceTimersByTimeAsync(0);

      expect(pm.cancelledPanelIds).toContain(panelId);
      expect(pm.cancelledPanelIds).toContain(`${panelId}-brainstorm-claude-code`);
      expect(pm.cancelledPanelIds).toContain(`${panelId}-brainstorm-google-gemini`);
      expect(pm.sendCalls).toHaveLength(dispatched);
      expect(chunks.filter(c => c.type === 'done')).toHaveLength(1);
      expect(chunks.some(c => c.type === 'agent_error' || c.type === 'synthesis_fallback')).toBe(false);
      expect(manager.isSessionActive(panelId)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('does not start a fallback when cancellation interrupts synthesis', async () => {
      vi.useFakeTimers();
      const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);
      configureBrainstorm({ agents: ['claude-code', 'google-gemini'], strategy: 'quick', synthesisAgent: 'claude-code' });
      pm.setProviderAvailable('claude-code');
      pm.setProviderAvailable('google-gemini');
      let calls = 0;
      pm.streamFactories.set('claude-code', () => ++calls === 1
        ? createMockStream(makeTextChunks(['Analysis']))
        : createMockStream([], { hang: true }));
      pm.setProviderChunks('google-gemini', makeTextChunks(['Gemini analysis']));

      const pending = collectChunks(manager.startBrainstormSession('q', [], createMockSettings(), 'panel-synthesis-cancel'));
      await vi.advanceTimersByTimeAsync(0);
      expect(manager.getCurrentSession('panel-synthesis-cancel')?.phase).toBe('synthesis');
      manager.cancelSession('panel-synthesis-cancel');
      const chunks = await pending;
      expect(pm.sendCalls).toHaveLength(3);
      expect(chunks.some(c => c.type === 'synthesis_fallback')).toBe(false);
      expect(chunks.at(-1)?.type).toBe('done');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('cancels and retires children when the consumer stops reading', async () => {
      vi.useFakeTimers();
      const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);
      configureBrainstorm({ agents: ['claude-code', 'google-gemini'], strategy: 'quick' });
      pm.setProviderAvailable('claude-code');
      pm.setProviderAvailable('google-gemini');
      pm.setProviderChunks('claude-code', [{ type: 'text', content: 'Partial' }], { hang: true });
      pm.setProviderChunks('google-gemini', [{ type: 'text', content: 'Partial' }], { hang: true });

      for await (const chunk of manager.startBrainstormSession('q', [], createMockSettings(), 'panel-break')) {
        if (chunk.type === 'agent_text') { break; }
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(manager.isSessionActive('panel-break')).toBe(false);
      expect(pm.disposedChildren).toHaveLength(2);
      expect(pm.sendCalls).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('preserves child continuity when the consumer stops at the done chunk', async () => {
      const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);
      configureBrainstorm({ agents: ['claude-code', 'google-gemini'], strategy: 'quick', synthesisAgent: 'claude-code' });
      pm.setProviderAvailable('claude-code');
      pm.setProviderAvailable('google-gemini');
      pm.setProviderChunks('claude-code', makeTextChunks(['Answer']));
      pm.setProviderChunks('google-gemini', makeTextChunks(['Answer']));
      for await (const chunk of manager.startBrainstormSession('q', [], createMockSettings(), 'panel-done')) {
        if (chunk.type === 'done') { break; }
      }
      expect(pm.cancelledPanelIds).toHaveLength(0);
      expect(pm.disposedChildren).toHaveLength(0);
      expect(manager.isSessionActive('panel-done')).toBe(false);
    });

    it('does not resurrect a cleared session after provider discovery completes', async () => {
      vi.useFakeTimers();
      const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);
      configureBrainstorm({ agents: ['claude-code', 'google-gemini'], strategy: 'quick' });
      pm.setProviderAvailable('claude-code');
      pm.setProviderAvailable('google-gemini');
      let release!: () => void;
      const discovery = new Promise<void>(resolve => { release = resolve; });
      const getStatus = pm.getProviderStatus.bind(pm);
      vi.spyOn(pm, 'getProviderStatus').mockImplementation(async id => {
        await discovery;
        return getStatus(id);
      });

      const pending = collectChunks(manager.startBrainstormSession('q', [], createMockSettings(), 'panel-discovery'));
      await vi.advanceTimersByTimeAsync(0);
      manager.clearSession('panel-discovery');
      expect((await pending).at(-1)?.type).toBe('done');
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(pm.sendCalls).toHaveLength(0);
      expect(manager.getCurrentSession('panel-discovery')).toBeNull();
    });

    it('retires an older run without cancelling its replacement in the same panel', async () => {
      vi.useFakeTimers();
      const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);
      configureBrainstorm({ agents: ['claude-code', 'google-gemini'], strategy: 'quick', synthesisAgent: 'claude-code' });
      pm.setProviderAvailable('claude-code');
      pm.setProviderAvailable('google-gemini');
      pm.setProviderChunks('claude-code', [], { hang: true });
      pm.setProviderChunks('google-gemini', [], { hang: true });
      const first = collectChunks(manager.startBrainstormSession('old', [], createMockSettings(), 'panel-replace'));
      await vi.advanceTimersByTimeAsync(0);

      pm.setProviderChunks('claude-code', makeTextChunks(['New answer']));
      pm.setProviderChunks('google-gemini', makeTextChunks(['New answer']));
      const next = await collectChunks(manager.startBrainstormSession('new', [], createMockSettings(), 'panel-replace'));
      expect((await first).at(-1)?.type).toBe('done');
      expect(next.filter(c => c.type === 'synthesis_text')).toHaveLength(1);
      expect(manager.getCurrentSession('panel-replace')?.query).toBe('new');
      expect(pm.cancelledPanelIds.filter(id => id === 'panel-replace')).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  // =========================================================================
  // 12. Provider not installed
  // =========================================================================
  describe('Provider not installed', () => {
    it('should report install command when provider is missing', async () => {
      const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);

      configureBrainstorm({ agents: ['claude-code', 'google-gemini'], strategy: 'quick' });
      pm.setProviderAvailable('claude-code', 'Claude');
      pm.setProviderNotInstalled('google-gemini', 'npm install -g @google/gemini-cli');

      const settings = createMockSettings();
      const chunks = await collectChunks(manager.startBrainstormSession('Test', [], settings, 'panel-missing'));

      const errors = chunks.filter(c => c.type === 'agent_error');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].content).toContain('not installed');
      expect(errors[0].content).toContain('npm install -g @google/gemini-cli');
    });
  });
});
