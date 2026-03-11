import { describe, it, expect, beforeEach } from 'vitest';
import { TestableClaudeProvider } from '../../helpers/providerFactory';
import { createClaudeSession } from '../../helpers/sessionFactory';
import type { ClaudeSessionState } from '../../../src/providers/claude/ClaudeCodeProvider';

describe('ClaudeCodeProvider.parseStreamLine', () => {
  let provider: TestableClaudeProvider;
  let session: ClaudeSessionState;

  beforeEach(() => {
    provider = new TestableClaudeProvider();
    session = createClaudeSession();
  });

  // ==========================================================================
  // Text Streaming
  // ==========================================================================

  describe('text streaming', () => {
    it('should parse text_delta into text chunk', () => {
      const line = JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello world' },
        },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({ type: 'text', content: 'Hello world' });
    });

    it('should set hasStreamedText on text_delta', () => {
      const line = JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hi' },
        },
      });
      provider.parseStreamLine(line, session);
      expect(session.hasStreamedText).toBe(true);
    });

    it('should handle empty text_delta', () => {
      const line = JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '' },
        },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({ type: 'text', content: '' });
    });
  });

  // ==========================================================================
  // Thinking
  // ==========================================================================

  describe('thinking', () => {
    it('should parse thinking_delta into thinking chunk', () => {
      const line = JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Let me analyze this...' },
        },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({ type: 'thinking', content: 'Let me analyze this...' });
    });

    it('should emit thinking chunk on content_block_start with thinking type', () => {
      const line = JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking' },
        },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({ type: 'thinking', content: '' });
    });
  });

  // ==========================================================================
  // Tool Use
  // ==========================================================================

  describe('tool use', () => {
    it('should emit tool_use on content_block_start with tool_use type', () => {
      const line = JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_123', name: 'Read' },
        },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({
        type: 'tool_use',
        toolCall: {
          id: 'toolu_123',
          name: 'Read',
          input: {},
          status: 'running',
        },
      });
    });

    it('should accumulate input_json_delta and return null', () => {
      // First, start a tool
      provider.parseStreamLine(JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_123', name: 'Read' },
        },
      }), session);

      // Send partial JSON
      const delta = provider.parseStreamLine(JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"file_path":"/src/' },
        },
      }), session);
      expect(delta).toBeNull();
    });

    it('should emit completed tool_use on content_block_stop with parsed input', () => {
      // Start tool
      provider.parseStreamLine(JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_123', name: 'Read' },
        },
      }), session);

      // Accumulate input
      provider.parseStreamLine(JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"file_path":"/src/' },
        },
      }), session);

      provider.parseStreamLine(JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: 'main.ts"}' },
        },
      }), session);

      // Stop tool
      const result = provider.parseStreamLine(JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 1 },
      }), session);

      expect(result).toEqual({
        type: 'tool_use',
        toolCall: {
          id: 'toolu_123',
          name: 'Read',
          input: { file_path: '/src/main.ts' },
          status: 'running',
        },
      });
    });
  });

  // ==========================================================================
  // Tool Result
  // ==========================================================================

  describe('tool result', () => {
    it('should parse user message with tool_result blocks', () => {
      const line = JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_123',
              content: 'file contents here',
              is_error: false,
            },
          ],
        },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({
        type: 'tool_result',
        toolCall: {
          id: 'toolu_123',
          name: '',
          input: {},
          output: 'file contents here',
          status: 'completed',
        },
      });
    });

    it('should mark failed tool_result', () => {
      const line = JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_456',
              content: 'Permission denied',
              is_error: true,
            },
          ],
        },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result?.toolCall?.status).toBe('failed');
    });

    it('should parse direct tool_result events', () => {
      const line = JSON.stringify({
        type: 'tool_result',
        tool_use_id: 'toolu_789',
        tool_name: 'Bash',
        content: 'output here',
        is_error: false,
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({
        type: 'tool_result',
        toolCall: {
          id: 'toolu_789',
          name: 'Bash',
          input: {},
          output: 'output here',
          status: 'completed',
        },
      });
    });
  });

  // ==========================================================================
  // Ask User Question
  // ==========================================================================

  describe('ask user question', () => {
    it('should detect AskUserQuestion tool and emit ask_user_question chunk', () => {
      // Start AskUserQuestion tool (should return null, not immediate tool_use)
      const startResult = provider.parseStreamLine(JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'tool_use', id: 'toolu_ask1', name: 'AskUserQuestion' },
        },
      }), session);
      expect(startResult).toBeNull();

      // Accumulate question input
      const questionsJson = JSON.stringify({
        questions: [{
          question: 'Which approach do you prefer?',
          header: 'Design Choice',
          options: [
            { label: 'Option A', description: 'Simple approach' },
            { label: 'Option B', description: 'Complex approach' },
          ],
          multiSelect: false,
        }],
      });

      provider.parseStreamLine(JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: questionsJson },
        },
      }), session);

      // Stop block → should emit ask_user_question
      const result = provider.parseStreamLine(JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 2 },
      }), session);

      expect(result?.type).toBe('ask_user_question');
      expect(result?.askUserQuestion?.toolCallId).toBe('toolu_ask1');
      expect(result?.askUserQuestion?.questions).toHaveLength(1);
      expect(result?.askUserQuestion?.questions[0].question).toBe('Which approach do you prefer?');
      expect(result?.askUserQuestion?.questions[0].options).toHaveLength(2);
    });
  });

  // ==========================================================================
  // Session Initialization
  // ==========================================================================

  describe('session initialization', () => {
    it('should parse system init event and set sessionId', () => {
      const line = JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'sess_abc123',
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({ type: 'session_active', sessionId: 'sess_abc123' });
      expect(session.sessionId).toBe('sess_abc123');
    });

    it('should not re-emit session_active if sessionId already set', () => {
      session.sessionId = 'existing_session';
      const line = JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'sess_new',
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toBeNull();
      expect(session.sessionId).toBe('existing_session');
    });
  });

  // ==========================================================================
  // Usage Stats
  // ==========================================================================

  describe('usage stats', () => {
    it('should capture usage from message_delta', () => {
      const line = JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'message_delta',
          usage: {
            input_tokens: 1500,
            output_tokens: 300,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 50,
          },
        },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toBeNull();
      expect(session.lastUsageStats).toEqual({
        input_tokens: 1500,
        output_tokens: 300,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 50,
      });
    });
  });

  // ==========================================================================
  // Error Handling
  // ==========================================================================

  describe('error handling', () => {
    it('should parse error events', () => {
      const line = JSON.stringify({
        type: 'error',
        error: { message: 'Rate limit exceeded' },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({ type: 'error', content: 'Rate limit exceeded' });
    });

    it('should handle malformed JSON gracefully', () => {
      const result = provider.parseStreamLine('not valid json {{{', session);
      expect(result).toEqual({ type: 'text', content: 'not valid json {{{' });
    });

    it('should return null for empty lines', () => {
      expect(provider.parseStreamLine('', session)).toBeNull();
      expect(provider.parseStreamLine('   ', session)).toBeNull();
    });

    it('should return null for unknown event types', () => {
      const line = JSON.stringify({ type: 'unknown_event', data: 'something' });
      const result = provider.parseStreamLine(line, session);
      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // Result Event
  // ==========================================================================

  describe('result event', () => {
    it('should emit text for result when no text was streamed', () => {
      const line = JSON.stringify({
        type: 'result',
        result: 'Compaction complete',
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({ type: 'text', content: 'Compaction complete' });
    });

    it('should skip result when text was already streamed', () => {
      session.hasStreamedText = true;
      const line = JSON.stringify({
        type: 'result',
        result: 'Duplicate text',
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // Compact Boundary
  // ==========================================================================

  describe('compact boundary', () => {
    it('should handle compact_boundary system event', () => {
      const line = JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { pre_tokens: 50000 },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result?.type).toBe('text');
      expect(result?.content).toContain('50k tokens');
      expect(session.awaitingCompactSummary).toBe(true);
    });
  });

  // ==========================================================================
  // ExitPlanMode Tool
  // ==========================================================================

  describe('exit plan mode', () => {
    it('should detect ExitPlanMode tool and emit exit_plan_mode chunk', () => {
      // Start ExitPlanMode tool
      provider.parseStreamLine(JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 3,
          content_block: { type: 'tool_use', id: 'toolu_exit1', name: 'ExitPlanMode' },
        },
      }), session);

      // Input with plan path
      provider.parseStreamLine(JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 3,
          delta: { type: 'input_json_delta', partial_json: '{"plan_file_path":"/tmp/plan.md"}' },
        },
      }), session);

      // Stop
      const result = provider.parseStreamLine(JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 3 },
      }), session);

      expect(result).toEqual({
        type: 'exit_plan_mode',
        planFilePath: '/tmp/plan.md',
      });
    });
  });

  // ==========================================================================
  // Message Lifecycle
  // ==========================================================================

  describe('message lifecycle', () => {
    it('should reset hasStreamedText on message_start', () => {
      session.hasStreamedText = true;
      const line = JSON.stringify({
        type: 'stream_event',
        event: { type: 'message_start' },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toBeNull();
      expect(session.hasStreamedText).toBe(false);
    });

    it('should return null for message_stop', () => {
      const line = JSON.stringify({
        type: 'stream_event',
        event: { type: 'message_stop' },
      });
      expect(provider.parseStreamLine(line, session)).toBeNull();
    });
  });
});
