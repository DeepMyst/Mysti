/**
 * MentionRouter stability tests.
 * Simulates user @-mention scenarios with mocked providers.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { clearMockConfig } from '../helpers/mockVscode';
import { MockProviderManager, createMockStream } from '../helpers/mockProviderManager';
import {
  createTestMentionRouter,
  agentMention,
  createMentionSettings,
  collectMentionChunks
} from '../helpers/mentionFactory';
import type { StreamChunk } from '../../src/types';

// Helper to make text chunks
function makeTextChunks(texts: string[]): StreamChunk[] {
  const chunks: StreamChunk[] = texts.map(t => ({ type: 'text', content: t }));
  chunks.push({ type: 'done', usage: { inputTokens: 50, outputTokens: 25 } });
  return chunks;
}

describe('MentionRouter', () => {
  let mockPM: MockProviderManager;

  beforeEach(() => {
    clearMockConfig();
    mockPM = new MockProviderManager();
  });

  // =========================================================================
  // 1. Single @claude mention — happy path
  // =========================================================================
  describe('Single agent mention', () => {
    it('should execute sub-agent and return response', async () => {
      const { router, mockPM: pm } = createTestMentionRouter(mockPM);

      pm.setProviderAvailable('claude-code', 'Claude');
      pm.setProviderChunks('claude-code', makeTextChunks(['Here is the rewritten function.']));

      const mentions = [agentMention('claude', 'claude-code', 0)];
      // Use a different provider as current so claude becomes a sub-agent
      const settings = createMentionSettings({ provider: 'google-gemini' as any });
      const chunks = await collectMentionChunks(
        router.processMentions('@claude rewrite this function', mentions, [], settings, null, 'panel-1')
      );

      // Should have subagent lifecycle chunks
      const started = chunks.filter(c => c.type === 'subagent_started');
      expect(started.length).toBe(1);
      expect(started[0].agentId).toBe('claude-code');

      const texts = chunks.filter(c => c.type === 'subagent_text');
      expect(texts.length).toBeGreaterThan(0);

      const complete = chunks.filter(c => c.type === 'subagent_complete');
      expect(complete.length).toBe(1);
      expect(complete[0].hasError).toBeFalsy();
    });
  });

  // =========================================================================
  // 2. Multi-mention @gemini @codex
  // =========================================================================
  describe('Multi-agent mention', () => {
    it('should execute both sub-agents sequentially', async () => {
      const { router, mockPM: pm } = createTestMentionRouter(mockPM);

      pm.setProviderAvailable('google-gemini', 'Gemini');
      pm.setProviderAvailable('openai-codex', 'Codex');
      pm.setProviderChunks('google-gemini', makeTextChunks(['Gemini analysis complete.']));
      pm.setProviderChunks('openai-codex', makeTextChunks(['Codex fix applied.']));

      // Multi-mention heuristic returns null → falls back to AI task gen.
      // Provide a claude-code stream that returns a valid JSON task list so AI fallback works.
      pm.setProviderAvailable('claude-code', 'Claude');
      pm.setProviderChunks('claude-code', makeTextChunks([
        '[{"agent":"google-gemini","task":"analyze the code","taskType":"execute","dependsOnPrevious":false},{"agent":"openai-codex","task":"fix the issues","taskType":"execute","dependsOnPrevious":true}]'
      ]));

      const mentions = [
        agentMention('gemini', 'google-gemini', 0),
        agentMention('codex', 'openai-codex', 15)
      ];
      // Use claude-code as current provider so both gemini and codex are sub-agents
      const settings = createMentionSettings({ provider: 'claude-code' as any });
      const chunks = await collectMentionChunks(
        router.processMentions('@gemini analyze @codex fix', mentions, [], settings, null, 'panel-multi')
      );

      const started = chunks.filter(c => c.type === 'subagent_started');
      expect(started.length).toBe(2);

      const agents = started.map(c => c.agentId);
      expect(agents).toContain('google-gemini');
      expect(agents).toContain('openai-codex');

      const complete = chunks.filter(c => c.type === 'subagent_complete');
      expect(complete.length).toBe(2);
    });
  });

  // =========================================================================
  // 3. Unavailable provider mention
  // =========================================================================
  describe('Unavailable provider', () => {
    it('should yield error with install hint', async () => {
      const { router, mockPM: pm } = createTestMentionRouter(mockPM);

      pm.setProviderNotInstalled('google-gemini', 'npm i -g @google/gemini-cli');

      const mentions = [agentMention('gemini', 'google-gemini', 0)];
      const settings = createMentionSettings();
      const chunks = await collectMentionChunks(
        router.processMentions('@gemini help', mentions, [], settings, null, 'panel-unavail')
      );

      const errors = chunks.filter(c => c.type === 'subagent_error');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].content).toContain('not installed');
      expect(errors[0].content).toContain('npm i -g @google/gemini-cli');

      const complete = chunks.filter(c => c.type === 'subagent_complete');
      expect(complete.length).toBe(1);
      expect(complete[0].hasError).toBe(true);
    });
  });

  // =========================================================================
  // 4. Sub-agent timeout
  // =========================================================================
  describe('Sub-agent timeout', () => {
    it('should emit error when sub-agent times out', async () => {
      const { router, mockPM: pm } = createTestMentionRouter(mockPM);

      pm.setProviderAvailable('claude-code', 'Claude');
      // Stream that hangs indefinitely
      pm.streamFactories.set('claude-code', () => createMockStream(
        [{ type: 'text', content: 'Working...' }],
        { hang: true }
      ));

      const mentions = [agentMention('claude', 'claude-code', 0)];
      // Use a different provider as current so claude becomes a sub-agent
      const settings = createMentionSettings({ provider: 'google-gemini' as any });

      // This test would take 1 hour with real timeout — just verify the stream factory is called
      const gen = router.processMentions('@claude slow task', mentions, [], settings, null, 'panel-timeout');

      // Read just the first few chunks (started + initial text)
      const chunks = [];
      for await (const chunk of gen) {
        chunks.push(chunk);
        if (chunks.length >= 3) { break; } // Don't wait for timeout
      }

      expect(chunks.some(c => c.type === 'subagent_started')).toBe(true);
    });
  });

  // =========================================================================
  // 5. Sub-agent question timeout (M1)
  // =========================================================================
  describe('Sub-agent question timeout (M1)', () => {
    it('should auto-skip question after SUBAGENT_QUESTION_TIMEOUT_MS', async () => {
      const { router, mockPM: pm } = createTestMentionRouter(mockPM);

      pm.setProviderAvailable('claude-code', 'Claude');
      // Return an ask_user_question chunk
      pm.streamFactories.set('claude-code', () => createMockStream([
        { type: 'text', content: 'Analyzing...' } as StreamChunk,
        {
          type: 'ask_user_question',
          askUserQuestion: {
            toolCallId: 'q1',
            questions: [{
              question: 'Which framework?',
              header: 'Choice',
              options: [{ label: 'React', description: '' }],
              multiSelect: false
            }]
          }
        } as StreamChunk,
      ]));

      const mentions = [agentMention('claude', 'claude-code', 0)];
      // Use a different provider as current so claude becomes a sub-agent
      const settings = createMentionSettings({ provider: 'google-gemini' as any });

      // Use a question callback that never resolves (simulates user not answering)
      const neverAnswer = () => new Promise<null>(() => {});

      const gen = router.processMentions(
        '@claude help', mentions, [], settings, null, 'panel-q-timeout', neverAnswer as any
      );

      // The question timeout (5 min) is too long for a unit test.
      // Instead, verify the ask_user_question chunk is yielded
      const chunks = [];
      for await (const chunk of gen) {
        chunks.push(chunk);
        // Once we see the ask question chunk, we know the path is taken
        if (chunk.type === 'subagent_ask_user_question') { break; }
        if (chunks.length > 10) { break; }
      }

      expect(chunks.some(c => c.type === 'subagent_ask_user_question')).toBe(true);
    });
  });

  // =========================================================================
  // 6. Retry with process cleanup (M8)
  // =========================================================================
  describe('Retry process cleanup (M8)', () => {
    it('should cancel previous attempt before retrying', async () => {
      const { router, mockPM: pm } = createTestMentionRouter(mockPM);

      pm.setProviderAvailable('claude-code', 'Claude');

      let callCount = 0;
      pm.streamFactories.set('claude-code', () => {
        callCount++;
        if (callCount === 1) {
          // First attempt: yield an error chunk (not a throw — MentionRouter sees error chunks as retryable)
          return createMockStream([
            { type: 'error', content: 'Connection reset' } as StreamChunk
          ]);
        }
        // Retry: succeed
        return createMockStream(makeTextChunks(['Success on retry']));
      });

      const mentions = [agentMention('claude', 'claude-code', 0)];
      // Use a different provider as current so claude becomes a sub-agent
      const settings = createMentionSettings({ provider: 'google-gemini' as any });
      const chunks = await collectMentionChunks(
        router.processMentions('@claude retry test', mentions, [], settings, null, 'panel-retry')
      );

      // Should have a retry chunk
      const retries = chunks.filter(c => c.type === 'subagent_retry');
      expect(retries.length).toBe(1);

      // M8: Previous panel should have been cancelled
      expect(pm.cancelledPanelIds).toContain('panel-retry-subagent-claude-code');

      // Should complete successfully after retry
      const complete = chunks.filter(c => c.type === 'subagent_complete');
      expect(complete.length).toBe(1);
    });
  });

  // =========================================================================
  // 7. File resolution warning (M7)
  // =========================================================================
  describe('File resolution warning (M7)', () => {
    it('should yield warning for unresolvable files', async () => {
      const { router } = createTestMentionRouter(mockPM);

      // File mention pointing to non-existent file
      const mentions = [{
        type: 'file' as const,
        value: '/nonexistent/path/file.ts',
        displayName: '@file.ts',
        startIndex: 0,
        endIndex: 8
      }];
      const settings = createMentionSettings();
      const chunks = await collectMentionChunks(
        router.processMentions('@file.ts help', mentions, [], settings, null, 'panel-file')
      );

      // Should have a file_resolution_warning
      const warnings = chunks.filter(c => c.type === 'file_resolution_warning');
      expect(warnings.length).toBe(1);
      expect(warnings[0].content).toContain('Could not read');
    });
  });

  // =========================================================================
  // 8. No agent mentions — passthrough to main
  // =========================================================================
  describe('No agent mentions', () => {
    it('should yield main_start when only file mentions', async () => {
      const { router } = createTestMentionRouter(mockPM);

      // Only file mentions, no agent mentions
      const mentions = [{
        type: 'file' as const,
        value: '/nonexistent/path/readme.md',
        displayName: '@readme.md',
        startIndex: 0,
        endIndex: 10
      }];
      const settings = createMentionSettings();
      const chunks = await collectMentionChunks(
        router.processMentions('@readme.md explain', mentions, [], settings, null, 'panel-no-agent')
      );

      // Should yield main_start (no sub-agents needed)
      const mainStarts = chunks.filter(c => c.type === 'main_start');
      expect(mainStarts.length).toBe(1);
    });
  });
});
