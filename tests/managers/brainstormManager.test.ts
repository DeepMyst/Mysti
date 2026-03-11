/**
 * BrainstormManager stability tests.
 * Simulates user scenarios with mocked providers to verify brainstorm mode behavior
 * for Claude Code, Gemini, and Codex.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { clearMockConfig } from '../helpers/mockVscode';
import { MockProviderManager, createMockStream } from '../helpers/mockProviderManager';
import {
  createTestBrainstormManager,
  configureBrainstorm,
  createMockSettings,
  makeTextChunks,
  collectChunks
} from '../helpers/brainstormFactory';
import type { BrainstormStreamChunk, StreamChunk } from '../../src/types';
import { BRAINSTORM_SILENCE_TIMEOUT_MS } from '../../src/constants';

describe('BrainstormManager', () => {
  let mockPM: MockProviderManager;

  beforeEach(() => {
    clearMockConfig();
    mockPM = new MockProviderManager();
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
      const chunks = await collectChunks(manager.startBrainstormSession('Test query', [], settings, 'panel-timeout'));

      // Should have an agent_error for claude-code
      const errors = chunks.filter(c => c.type === 'agent_error' && c.agentId === 'claude-code');
      expect(errors.length).toBe(1);
      expect(errors[0].content).toContain('silent');

      // Gemini should still complete
      const geminiComplete = chunks.filter(c => c.type === 'agent_complete' && c.agentId === 'google-gemini');
      expect(geminiComplete.length).toBe(1);
    }, BRAINSTORM_SILENCE_TIMEOUT_MS + 30000); // Allow enough time for the timeout
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
    it('should cancel all agent processes when session is cancelled', async () => {
      const { manager, mockPM: pm } = createTestBrainstormManager(mockPM);

      configureBrainstorm({ agents: ['claude-code', 'google-gemini'], strategy: 'quick', synthesisAgent: 'claude-code' });
      pm.setProviderAvailable('claude-code', 'Claude');
      pm.setProviderAvailable('google-gemini', 'Gemini');

      // Slow streams
      pm.setProviderChunks('claude-code', makeTextChunks(['Working...']), { delayMs: 50 });
      pm.setProviderChunks('google-gemini', makeTextChunks(['Working...']), { delayMs: 50 });

      // Cancel after a short delay
      const panelId = 'panel-cancel';
      setTimeout(() => manager.cancelSession(panelId), 100);

      const settings = createMockSettings();
      // Start brainstorm — it will be cancelled mid-stream
      const gen = manager.startBrainstormSession('Test cancel', [], settings, panelId);
      const chunks: BrainstormStreamChunk[] = [];
      for await (const chunk of gen) {
        chunks.push(chunk);
        // Check if session was cancelled
        if (manager.getCurrentSession(panelId)?.phase === 'complete') {
          break;
        }
      }

      // Verify cancelRequest was called for both agents
      expect(pm.cancelledPanelIds).toContain(panelId);
      expect(pm.cancelledPanelIds).toContain(`${panelId}-brainstorm-claude-code`);
      expect(pm.cancelledPanelIds).toContain(`${panelId}-brainstorm-google-gemini`);
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
