import { describe, it, expect, beforeEach } from 'vitest';
import { TestableCursorProvider } from '../../helpers/providerFactory';
import { createCursorSession } from '../../helpers/sessionFactory';

describe('CursorProvider.parseStreamLine', () => {
  let provider: TestableCursorProvider;
  let session: ReturnType<typeof createCursorSession>;

  beforeEach(() => {
    provider = new TestableCursorProvider();
    session = createCursorSession();
  });

  describe('session initialization', () => {
    it('should parse system init with session_id', () => {
      const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cursor_1' });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({ type: 'session_active', sessionId: 'cursor_1' });
    });

    it('should return null for system without session_id', () => {
      const line = JSON.stringify({ type: 'system', model: 'auto' });
      expect(provider.parseStreamLine(line, session)).toBeNull();
    });
  });

  describe('cumulative text deduplication', () => {
    it('should emit full text on first assistant event', () => {
      const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello' }] },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({ type: 'text', content: 'Hello' });
      expect(session.streamedTextLength).toBe(5);
    });

    it('should only emit new text on subsequent cumulative events', () => {
      // First event
      provider.parseStreamLine(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hel' }] },
      }), session);

      // Second event — cumulative, includes previous text
      const result = provider.parseStreamLine(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello world' }] },
      }), session);
      expect(result).toEqual({ type: 'text', content: 'lo world' });
      expect(session.streamedTextLength).toBe(11);
    });

    it('should skip if no new text', () => {
      session.streamedTextLength = 5;
      const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello' }] },
      });
      expect(provider.parseStreamLine(line, session)).toBeNull();
    });

    it('should handle flat content fallback', () => {
      const line = JSON.stringify({ type: 'assistant', content: 'Flat text' });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({ type: 'text', content: 'Flat text' });
    });
  });

  describe('tool use', () => {
    it('should parse tool_call started with nested ToolCall key', () => {
      const line = JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'tc_1',
        tool_call: {
          readToolCall: { args: { path: '/src/main.ts' } },
        },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({
        type: 'tool_use',
        toolCall: {
          id: 'tc_1',
          name: 'read',
          input: { path: '/src/main.ts' },
          status: 'running',
        },
      });
    });

    it('should normalize glob fields', () => {
      const line = JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'tc_2',
        tool_call: {
          listToolCall: { args: { globPattern: '**/*.ts', targetDirectory: '/src' } },
        },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result?.toolCall?.input).toEqual({ pattern: '**/*.ts', path: '/src' });
    });

    it('should parse tool_call completed with result', () => {
      // Start tool first
      provider.parseStreamLine(JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'tc_3',
        tool_call: { readToolCall: { args: { path: '/src/main.ts' } } },
      }), session);

      // Complete
      const result = provider.parseStreamLine(JSON.stringify({
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'tc_3',
        tool_call: {
          readToolCall: { result: { success: 'file contents here' } },
        },
      }), session);
      expect(result).toEqual({
        type: 'tool_result',
        toolCall: {
          id: 'tc_3',
          name: 'read',
          input: { path: '/src/main.ts' },
          output: 'file contents here',
          status: 'completed',
        },
      });
    });

    it('should reset streamedTextLength on tool_call', () => {
      session.streamedTextLength = 50;
      provider.parseStreamLine(JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'tc_4',
        tool_call: { readToolCall: { args: {} } },
      }), session);
      expect(session.streamedTextLength).toBe(0);
    });
  });

  describe('ask user question', () => {
    it('should detect ask_user tool call', () => {
      const line = JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'ask_1',
        tool_call: {
          function: {
            name: 'ask_user',
            arguments: JSON.stringify({
              questions: [{ question: 'Which?', header: 'Choice', options: [], multiSelect: false }],
            }),
          },
        },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result?.type).toBe('ask_user_question');
      expect(result?.askUserQuestion?.toolCallId).toBe('ask_1');
    });
  });

  describe('error handling', () => {
    it('should parse error events', () => {
      const line = JSON.stringify({ type: 'error', error: 'Model not available' });
      expect(provider.parseStreamLine(line, session)).toEqual({ type: 'error', content: 'Model not available' });
    });

    it('should return null for empty lines', () => {
      expect(provider.parseStreamLine('', session)).toBeNull();
    });

    it('should skip bracket-prefixed lines', () => {
      expect(provider.parseStreamLine('[INFO] Starting...', session)).toBeNull();
    });
  });

  describe('done events', () => {
    it('should emit done on done event', () => {
      const line = JSON.stringify({ type: 'done' });
      expect(provider.parseStreamLine(line, session)).toEqual({ type: 'done' });
    });

    it('should reset streamedTextLength on done', () => {
      session.streamedTextLength = 100;
      provider.parseStreamLine(JSON.stringify({ type: 'done' }), session);
      expect(session.streamedTextLength).toBe(0);
    });
  });

  describe('usage stats', () => {
    it('should capture from result event', () => {
      provider.parseStreamLine(JSON.stringify({
        type: 'result',
        duration_ms: 1500,
        stats: { input_tokens: 300, output_tokens: 150 },
      }), session);
      expect(session.lastUsageStats).toEqual({ input_tokens: 300, output_tokens: 150 });
    });
  });
});
