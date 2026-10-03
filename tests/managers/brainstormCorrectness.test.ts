/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Brainstorm correctness (Plan 18 Wave 4 Phase 5).
 *
 * 5.1: synthesis fallback must fire on streamed {type:'error'} CHUNKS and on
 *      empty synthesis output — providers surface CLI failures as error
 *      chunks, not throws, so an error-only stream used to complete
 *      "normally" with an empty synthesis and no fallback. Both synthesis
 *      streams are also wrapped in the 90s silence timeout like every other
 *      brainstorm stream.
 * 5.2: the error path of startBrainstormSession must still yield `done` —
 *      the webview derives brainstormComplete from it.
 * 5.3: convergence honesty — assessed after EVERY debate round (reachable at
 *      the default maxDiscussionRounds=2), stability excluded when there is
 *      no cross-round data, delphi compares same-agent refinement rounds
 *      (stride 2) and breaks on 'stalled'.
 * 5.4: _interleaveGenerators — per-child rejection isolation and child
 *      closure when the consumer breaks. (First direct tests of the
 *      interleaver.)
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
import type {
  BrainstormSession,
  BrainstormStreamChunk,
  ConvergenceMetrics,
  StreamChunk
} from '../../src/types';
import { BRAINSTORM_SILENCE_TIMEOUT_MS } from '../../src/constants';

describe('Brainstorm correctness (Plan 18 Wave 4 Phase 5)', () => {
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
  // 5.1 — synthesis fallback on error CHUNKS (throw-based fallback is pinned
  // in brainstormManager.test.ts; these cover the streamed-error path)
  // =========================================================================
  describe('5.1 synthesis fallback on error chunks', () => {
    it('falls back to the other agent when the primary synthesis stream yields an error chunk', async () => {
      const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);
      configureBrainstorm({ agents: ['claude-code', 'google-gemini'], strategy: 'quick', synthesisAgent: 'claude-code' });
      pm.setProviderAvailable('claude-code', 'Claude');
      pm.setProviderAvailable('google-gemini', 'Gemini');

      let claudeCall = 0;
      pm.streamFactories.set('claude-code', () => {
        claudeCall++;
        if (claudeCall === 1) { return createMockStream(makeTextChunks(['Claude analysis'])); }
        // Synthesis: the CLI failure arrives as a STREAMED error chunk — the
        // stream itself completes without throwing.
        return createMockStream([{ type: 'error', content: 'CLI exploded' } as StreamChunk]);
      });
      let geminiCall = 0;
      pm.streamFactories.set('google-gemini', () => {
        geminiCall++;
        if (geminiCall === 1) { return createMockStream(makeTextChunks(['Gemini analysis'])); }
        return createMockStream(makeTextChunks(['Gemini fallback synthesis']));
      });

      const chunks = await collectChunks(
        manager.startBrainstormSession('q', [], createMockSettings(), 'panel-errchunk')
      );

      const fallbacks = chunks.filter(c => c.type === 'synthesis_fallback');
      expect(fallbacks.length).toBe(1);
      expect(fallbacks[0].content).toContain('Retrying');

      const synth = chunks.filter(c => c.type === 'synthesis_text').map(c => c.content).join('');
      expect(synth).toContain('Gemini fallback synthesis');
      expect(manager.getCurrentSession('panel-errchunk')?.unifiedSolution).toBe('Gemini fallback synthesis');
      expect(chunks[chunks.length - 1].type).toBe('done');
    });

    it('falls back when the primary synthesis stream completes with no text at all', async () => {
      const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);
      configureBrainstorm({ agents: ['claude-code', 'google-gemini'], strategy: 'quick', synthesisAgent: 'claude-code' });
      pm.setProviderAvailable('claude-code', 'Claude');
      pm.setProviderAvailable('google-gemini', 'Gemini');

      let claudeCall = 0;
      pm.streamFactories.set('claude-code', () => {
        claudeCall++;
        if (claudeCall === 1) { return createMockStream(makeTextChunks(['Claude analysis'])); }
        // Synthesis: stream "succeeds" but never produces text
        return createMockStream([{ type: 'done' } as StreamChunk]);
      });
      let geminiCall = 0;
      pm.streamFactories.set('google-gemini', () => {
        geminiCall++;
        if (geminiCall === 1) { return createMockStream(makeTextChunks(['Gemini analysis'])); }
        return createMockStream(makeTextChunks(['Gemini fallback synthesis']));
      });

      const chunks = await collectChunks(
        manager.startBrainstormSession('q', [], createMockSettings(), 'panel-empty-synth')
      );

      expect(chunks.filter(c => c.type === 'synthesis_fallback').length).toBe(1);
      const synth = chunks.filter(c => c.type === 'synthesis_text').map(c => c.content).join('');
      expect(synth).toContain('Gemini fallback synthesis');
    });

    it('concatenates individual analyses when BOTH synthesis streams yield error chunks', async () => {
      const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);
      configureBrainstorm({ agents: ['claude-code', 'google-gemini'], strategy: 'quick', synthesisAgent: 'claude-code' });
      pm.setProviderAvailable('claude-code', 'Claude');
      pm.setProviderAvailable('google-gemini', 'Gemini');

      let claudeCall = 0;
      pm.streamFactories.set('claude-code', () => {
        claudeCall++;
        if (claudeCall === 1) { return createMockStream(makeTextChunks(['Claude analysis body'])); }
        return createMockStream([{ type: 'error', content: 'primary died' } as StreamChunk]);
      });
      let geminiCall = 0;
      pm.streamFactories.set('google-gemini', () => {
        geminiCall++;
        if (geminiCall === 1) { return createMockStream(makeTextChunks(['Gemini analysis body'])); }
        return createMockStream([{ type: 'error', content: 'fallback died' } as StreamChunk]);
      });

      const chunks = await collectChunks(
        manager.startBrainstormSession('q', [], createMockSettings(), 'panel-both-errchunk')
      );

      const synth = chunks.filter(c => c.type === 'synthesis_text').map(c => c.content).join('');
      expect(synth).toContain('individual analyses below');
      expect(synth).toContain('Claude analysis body');
      expect(synth).toContain('Gemini analysis body');
      expect(chunks[chunks.length - 1].type).toBe('done');
    });

    it('falls back when the primary synthesis stream goes silent (synthesis is silence-timeout wrapped)', async () => {
      vi.useFakeTimers();
      const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);
      configureBrainstorm({ agents: ['claude-code', 'google-gemini'], strategy: 'quick', synthesisAgent: 'claude-code' });
      pm.setProviderAvailable('claude-code', 'Claude');
      pm.setProviderAvailable('google-gemini', 'Gemini');

      let claudeCall = 0;
      pm.streamFactories.set('claude-code', () => {
        claudeCall++;
        if (claudeCall === 1) { return createMockStream(makeTextChunks(['Claude analysis'])); }
        // Synthesis hangs silently — previously this stalled to the 5-min
        // process timeout because synthesis was the only unwrapped stream.
        return createMockStream([], { hang: true });
      });
      let geminiCall = 0;
      pm.streamFactories.set('google-gemini', () => {
        geminiCall++;
        if (geminiCall === 1) { return createMockStream(makeTextChunks(['Gemini analysis'])); }
        return createMockStream(makeTextChunks(['Gemini fallback synthesis']));
      });

      const collecting = collectChunks(
        manager.startBrainstormSession('q', [], createMockSettings(), 'panel-synth-hang')
      );
      await vi.advanceTimersByTimeAsync(BRAINSTORM_SILENCE_TIMEOUT_MS + 1000);
      const chunks = await collecting;

      expect(chunks.filter(c => c.type === 'synthesis_fallback').length).toBe(1);
      const synth = chunks.filter(c => c.type === 'synthesis_text').map(c => c.content).join('');
      expect(synth).toContain('Gemini fallback synthesis');
      expect(chunks[chunks.length - 1].type).toBe('done');
    });

    it('drops to concatenation when the FALLBACK synthesis stream goes silent (fallback is wrapped too)', async () => {
      vi.useFakeTimers();
      const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);
      configureBrainstorm({ agents: ['claude-code', 'google-gemini'], strategy: 'quick', synthesisAgent: 'claude-code' });
      pm.setProviderAvailable('claude-code', 'Claude');
      pm.setProviderAvailable('google-gemini', 'Gemini');

      let claudeCall = 0;
      pm.streamFactories.set('claude-code', () => {
        claudeCall++;
        if (claudeCall === 1) { return createMockStream(makeTextChunks(['Claude analysis body'])); }
        return createMockStream([{ type: 'error', content: 'primary died' } as StreamChunk]);
      });
      let geminiCall = 0;
      pm.streamFactories.set('google-gemini', () => {
        geminiCall++;
        if (geminiCall === 1) { return createMockStream(makeTextChunks(['Gemini analysis body'])); }
        return createMockStream([], { hang: true });
      });

      const collecting = collectChunks(
        manager.startBrainstormSession('q', [], createMockSettings(), 'panel-fallback-hang')
      );
      await vi.advanceTimersByTimeAsync(BRAINSTORM_SILENCE_TIMEOUT_MS + 1000);
      const chunks = await collecting;

      const synth = chunks.filter(c => c.type === 'synthesis_text').map(c => c.content).join('');
      expect(synth).toContain('individual analyses below');
      expect(chunks[chunks.length - 1].type).toBe('done');
    });
  });

  // =========================================================================
  // 5.2 — `done` on the error path
  // =========================================================================
  describe('5.2 done on error path', () => {
    it('yields done (and marks the session complete) when a strategy throws', async () => {
      const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);
      configureBrainstorm({ agents: ['claude-code', 'google-gemini'], strategy: 'quick', synthesisAgent: 'claude-code' });
      pm.setProviderAvailable('claude-code', 'Claude');
      pm.setProviderAvailable('google-gemini', 'Gemini');
      pm.setProviderChunks('claude-code', makeTextChunks(['a']));
      pm.setProviderChunks('google-gemini', makeTextChunks(['b']));

      // Simulate an unexpected orchestration error escaping to the session catch
      const priv = manager as unknown as {
        _runQuickStrategy: (...args: unknown[]) => AsyncGenerator<BrainstormStreamChunk>;
      };
      vi.spyOn(priv, '_runQuickStrategy').mockImplementation(
        (): AsyncGenerator<BrainstormStreamChunk> => { throw new Error('strategy blew up'); }
      );

      const chunks = await collectChunks(
        manager.startBrainstormSession('q', [], createMockSettings(), 'panel-err-done')
      );

      const errors = chunks.filter(c => c.type === 'agent_error');
      expect(errors.length).toBe(1);
      expect(errors[0].content).toContain('strategy blew up');
      // The webview derives brainstormComplete from `done` — it must arrive
      // on the error path too.
      expect(chunks[chunks.length - 1].type).toBe('done');
      expect(manager.isSessionActive('panel-err-done')).toBe(false);
    });
  });

  // =========================================================================
  // 5.3 — convergence honesty
  // =========================================================================
  describe('5.3 convergence honesty', () => {
    it('debate converges at default settings only WITH stability evidence — round 1 alone cannot end it', async () => {
      const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);
      configureBrainstorm({
        agents: ['claude-code', 'google-gemini'],
        strategy: 'debate',
        maxRounds: 2, // the shipped default
        autoConverge: true,
        synthesisAgent: 'claude-code'
      });
      pm.setProviderAvailable('claude-code', 'Claude');
      pm.setProviderAvailable('google-gemini', 'Gemini');

      // Critiques that are pure agreement (no disagree-pattern words)
      const agreement = 'I agree. The analysis is correct. I accept these points. Valid point overall.';
      let claudeCall = 0;
      pm.streamFactories.set('claude-code', () => {
        claudeCall++;
        if (claudeCall === 1) { return createMockStream(makeTextChunks(['Claude thinks React fits here.'])); }
        return createMockStream(makeTextChunks([agreement]));
      });
      let geminiCall = 0;
      pm.streamFactories.set('google-gemini', () => {
        geminiCall++;
        if (geminiCall === 1) { return createMockStream(makeTextChunks(['Gemini thinks React fits here too.'])); }
        return createMockStream(makeTextChunks([agreement]));
      });

      const chunks = await collectChunks(
        manager.startBrainstormSession('React or Vue?', [], createMockSettings(), 'panel-converge')
      );

      // W4 review correction: 'converged' REQUIRES cross-round stability
      // evidence — round 1 (no stability data) must NOT end the debate on
      // agreement keywords alone, or the rebuttal phase the strategy is
      // named for would be skipped on the weakest possible signal. Both
      // rounds run; the FINAL assessment (which has stability data, and the
      // identical agreeing contributions give stability 1.0) reports
      // converged — reachable at the shipped default, unreachable pre-5.3.
      const updates = chunks.filter(c => c.type === 'convergence_update');
      expect(updates.length).toBe(2);
      expect(updates[0].convergence?.recommendation).toBe('continue');
      expect(updates[1].convergence?.recommendation).toBe('converged');
      const roundStarts = chunks.filter(c => c.type === 'discussion_round_start');
      expect(roundStarts.length).toBe(2);
      expect(chunks.some(c => c.type === 'phase_change' && c.phase === 'synthesis')).toBe(true);
      expect(chunks[chunks.length - 1].type).toBe('done');
    });

    it('the FINAL debate round gets a convergence_update (previously skipped by round < maxRounds)', async () => {
      const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);
      configureBrainstorm({
        agents: ['claude-code', 'google-gemini'],
        strategy: 'debate',
        maxRounds: 1,
        autoConverge: true,
        synthesisAgent: 'claude-code'
      });
      pm.setProviderAvailable('claude-code', 'Claude');
      pm.setProviderAvailable('google-gemini', 'Gemini');
      // Neutral text: no agreement/disagreement pattern words
      pm.setProviderChunks('claude-code', makeTextChunks(['The tradeoffs balance out either way.']));
      pm.setProviderChunks('google-gemini', makeTextChunks(['Each option carries similar costs.']));

      const chunks = await collectChunks(
        manager.startBrainstormSession('q', [], createMockSettings(), 'panel-final-update')
      );

      const updates = chunks.filter(c => c.type === 'convergence_update');
      expect(updates.length).toBe(1);
      expect(updates[0].roundNumber).toBe(1);
      // Neutral signals + no stability data → agreement-ratio-only 0.5, continue
      expect(updates[0].convergence?.recommendation).toBe('continue');
      expect(updates[0].convergence?.overallConvergence).toBeCloseTo(0.5);
    });

    it('delphi position stability compares the SAME agent across refinement rounds (stride 2), not against the facilitator summary', () => {
      const { manager } = createTestBrainstormManager(mockPM);
      const priv = manager as unknown as {
        _panelSessions: Map<string, BrainstormSession>;
        _assessConvergence(sessionId: string, round: number, roundStride?: number): ConvergenceMetrics;
      };

      const refineClaude = 'Refined position keep incremental migration path stable rollout';
      const refineGemini = 'Prefer gradual adoption with feature flags everywhere';
      const session: BrainstormSession = {
        id: 's-delphi',
        query: 'q',
        phase: 'discussion',
        strategy: 'delphi',
        agents: [
          { id: 'claude-code', displayName: 'Claude', color: '#fff', icon: 'x', persona: { type: 'neutral' } },
          { id: 'google-gemini', displayName: 'Gemini', color: '#fff', icon: 'x', persona: { type: 'neutral' } }
        ],
        agentResponses: new Map(),
        discussionRounds: [
          { // facilitator summary, delphi round 1 (pushed as 1)
            roundNumber: 1,
            contributions: new Map([['claude-code', 'Facilitator overview divergence consensus questions']]),
            roleAssignments: new Map([['claude-code', 'facilitator']])
          },
          { // refinement, delphi round 1 (pushed as 2)
            roundNumber: 2,
            contributions: new Map([['claude-code', refineClaude], ['google-gemini', refineGemini]]),
            roleAssignments: new Map([['claude-code', 'refiner'], ['google-gemini', 'refiner']])
          },
          { // facilitator summary, delphi round 2 (pushed as 3) — totally different vocabulary
            roundNumber: 3,
            contributions: new Map([['claude-code', 'Completely unrelated moderator recap wording vocabulary']]),
            roleAssignments: new Map([['claude-code', 'facilitator']])
          },
          { // refinement, delphi round 2 (pushed as 4) — identical positions to round 1
            roundNumber: 4,
            contributions: new Map([['claude-code', refineClaude], ['google-gemini', refineGemini]]),
            roleAssignments: new Map([['claude-code', 'refiner'], ['google-gemini', 'refiner']])
          }
        ],
        convergenceHistory: [],
        unifiedSolution: null,
        createdAt: 0,
        updatedAt: 0,
        childPanels: []
      };
      priv._panelSessions.set('panel-stride', session);

      // Stride 2 (delphi): refinement vs previous refinement — identical → 1.0
      const honest = priv._assessConvergence('panel-stride', 2, 2);
      expect(honest.positionStability.get('claude-code')).toBeCloseTo(1);
      expect(honest.positionStability.get('google-gemini')).toBeCloseTo(1);

      // Stride 1 (the old behavior) compared the refinement against the
      // FACILITATOR summary — a different role with different vocabulary.
      const crossRole = priv._assessConvergence('panel-stride', 2, 1);
      expect(crossRole.positionStability.get('claude-code') ?? 0).toBeLessThan(0.5);
    });

    it('delphi breaks out of remaining rounds when the assessment says stalled', async () => {
      const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);
      configureBrainstorm({
        agents: ['claude-code', 'google-gemini'],
        strategy: 'delphi',
        maxRounds: 3,
        autoConverge: true,
        synthesisAgent: 'claude-code'
      });
      pm.setProviderAvailable('claude-code', 'Claude');
      pm.setProviderAvailable('google-gemini', 'Gemini');

      let claudeCall = 0;
      pm.streamFactories.set('claude-code', () => {
        claudeCall++;
        if (claudeCall === 1) { return createMockStream(makeTextChunks(['Claude individual analysis'])); }
        if (claudeCall === 2) {
          // Facilitator summary WITHOUT a parseable score, so the heuristic
          // recommendation (stalled, via the spy below) is what drives flow
          return createMockStream(makeTextChunks(['Positions restated; the team remains split.']));
        }
        return createMockStream(makeTextChunks(['Final synthesis.']));
      });
      pm.setProviderChunks('google-gemini', makeTextChunks(['Gemini holds its position.']));

      const priv = manager as unknown as {
        _assessConvergence(sessionId: string, round: number, roundStride?: number): ConvergenceMetrics;
      };
      vi.spyOn(priv, '_assessConvergence').mockReturnValue({
        round: 1,
        agreementCount: 0,
        disagreementCount: 4,
        agreementRatio: 0,
        positionStability: new Map(),
        overallConvergence: 0.1,
        recommendation: 'stalled'
      });

      const chunks = await collectChunks(
        manager.startBrainstormSession('q', [], createMockSettings(), 'panel-delphi-stall')
      );

      const updates = chunks.filter(c => c.type === 'convergence_update');
      expect(updates.length).toBe(1);
      expect(updates[0].convergence?.recommendation).toBe('stalled');
      // Only round 1's two sub-steps (facilitator + refinement) ran — rounds
      // 2 and 3 were skipped by the new stalled break.
      const roundStarts = chunks.filter(c => c.type === 'discussion_round_start');
      expect(roundStarts.length).toBe(2);
      expect(chunks.some(c => c.type === 'phase_change' && c.phase === 'synthesis')).toBe(true);
      expect(chunks[chunks.length - 1].type).toBe('done');
    });
  });

  // =========================================================================
  // 5.4 — interleaver hardening (first direct tests)
  // =========================================================================
  describe('5.4 _interleaveGenerators', () => {
    type InterleaveFn = (
      generators: AsyncGenerator<BrainstormStreamChunk>[]
    ) => AsyncGenerator<BrainstormStreamChunk>;

    function getInterleave(manager: unknown): InterleaveFn {
      const m = manager as { _interleaveGenerators: InterleaveFn };
      return m._interleaveGenerators.bind(m);
    }

    const text = (content: string): BrainstormStreamChunk => ({ type: 'agent_text', content });
    const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

    it('a fast child is not blocked behind a slow sibling and all chunks arrive', async () => {
      const { manager } = createTestBrainstormManager(mockPM);
      const interleave = getInterleave(manager);

      async function* fast(): AsyncGenerator<BrainstormStreamChunk> {
        yield text('f1'); yield text('f2'); yield text('f3');
      }
      async function* slow(): AsyncGenerator<BrainstormStreamChunk> {
        await sleep(15); yield text('s1');
        await sleep(15); yield text('s2');
      }

      const received: string[] = [];
      for await (const chunk of interleave([fast(), slow()])) {
        received.push(chunk.content!);
      }

      // Completeness: nothing lost from either child
      expect([...received].sort()).toEqual(['f1', 'f2', 'f3', 's1', 's2']);
      // Fairness: the fast child's chunks all surfaced before the slow
      // sibling's first (the interleaver never serializes children)
      expect(received.slice(0, 3)).toEqual(['f1', 'f2', 'f3']);
    });

    it('one child rejecting surfaces an agent_error chunk and does NOT kill the sibling', async () => {
      const { manager } = createTestBrainstormManager(mockPM);
      const interleave = getInterleave(manager);

      async function* failing(): AsyncGenerator<BrainstormStreamChunk> {
        yield text('a1');
        throw new Error('child exploded');
      }
      async function* healthy(): AsyncGenerator<BrainstormStreamChunk> {
        for (const c of ['b1', 'b2', 'b3']) {
          await sleep(5);
          yield text(c);
        }
      }

      const chunks: BrainstormStreamChunk[] = [];
      // Must complete without throwing — the rejection is per-child terminal
      for await (const chunk of interleave([failing(), healthy()])) {
        chunks.push(chunk);
      }

      const errors = chunks.filter(c => c.type === 'agent_error');
      expect(errors.length).toBe(1);
      expect(errors[0].content).toContain('child exploded');
      // The healthy sibling streamed to completion
      const texts = chunks.filter(c => c.type === 'agent_text').map(c => c.content);
      expect(texts).toContain('a1');
      expect(texts).toContain('b1');
      expect(texts).toContain('b2');
      expect(texts).toContain('b3');
    });

    it('closes all child generators when the consumer breaks early', async () => {
      const { manager } = createTestBrainstormManager(mockPM);
      const interleave = getInterleave(manager);

      let aClosed = false;
      let bClosed = false;
      async function* a(): AsyncGenerator<BrainstormStreamChunk> {
        try {
          yield text('a1');
          yield text('a2');
        } finally {
          aClosed = true;
        }
      }
      async function* b(): AsyncGenerator<BrainstormStreamChunk> {
        try {
          await sleep(5);
          yield text('b1');
          await sleep(5);
          yield text('b2');
        } finally {
          bClosed = true;
        }
      }

      for await (const chunk of interleave([a(), b()])) {
        expect(chunk.content).toBe('a1');
        break; // consumer bails after the first chunk
      }

      // finally fires the children's return() without awaiting — give the
      // suspended/in-flight children a beat to run their finally blocks.
      await sleep(30);
      expect(aClosed).toBe(true);
      expect(bClosed).toBe(true);
    });
  });
});
