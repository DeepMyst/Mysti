import { describe, it, expect, beforeEach } from 'vitest';
import { TestableQwenProvider } from '../../helpers/providerFactory';
import { createQwenSession } from '../../helpers/sessionFactory';
import type { QwenSessionState } from '../../../src/providers/qwen/QwenCodeProvider';

describe('QwenCodeProvider.parseStreamLine', () => {
  let provider: TestableQwenProvider;
  let session: QwenSessionState;

  beforeEach(() => {
    provider = new TestableQwenProvider();
    session = createQwenSession();
  });

  describe('text streaming', () => {
    it('should parse text_delta', () => {
      const line = JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello from Qwen' } },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({ type: 'text', content: 'Hello from Qwen' });
      expect(session.hasStreamedText).toBe(true);
    });
  });

  describe('thinking', () => {
    it('should parse thinking_delta', () => {
      const line = JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Analyzing...' } },
      });
      expect(provider.parseStreamLine(line, session)).toEqual({ type: 'thinking', content: 'Analyzing...' });
    });
  });

  describe('tool use', () => {
    it('should emit tool_use on content_block_start (unlike Claude, Qwen emits immediately)', () => {
      const line = JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool_1', name: 'Read' } },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({
        type: 'tool_use',
        toolCall: { id: 'tool_1', name: 'Read', input: {}, status: 'running' },
      });
    });

    it('should accumulate input_json_delta and emit on stop', () => {
      // Start tool
      provider.parseStreamLine(JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool_1', name: 'Read' } },
      }), session);

      // Accumulate
      expect(provider.parseStreamLine(JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":"test.ts"}' } },
      }), session)).toBeNull();

      // Stop → emit with parsed input
      const result = provider.parseStreamLine(JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 1 },
      }), session);
      expect(result?.toolCall?.input).toEqual({ file_path: 'test.ts' });
    });
  });

  describe('auth error detection', () => {
    it('should detect auth error in result event', () => {
      const line = JSON.stringify({
        type: 'result',
        is_error: true,
        error: { message: 'No auth type is selected. Please configure an auth type.' },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result?.type).toBe('auth_error');
      expect(result?.authCommand).toBe('qwen');
      expect(result?.providerName).toBe('Qwen Code');
    });

    it('should emit regular error for non-auth errors in result', () => {
      const line = JSON.stringify({
        type: 'result',
        is_error: true,
        error: { message: 'Rate limit exceeded' },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({ type: 'error', content: 'Rate limit exceeded' });
    });
  });

  describe('session initialization', () => {
    it('should parse system init', () => {
      const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'qwen_sess_1' });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({ type: 'session_active', sessionId: 'qwen_sess_1' });
      expect(session.sessionId).toBe('qwen_sess_1');
    });

    it('should extract session from result event', () => {
      const line = JSON.stringify({ type: 'result', session_id: 'qwen_from_result' });
      provider.parseStreamLine(line, session);
      expect(session.sessionId).toBe('qwen_from_result');
    });
  });

  describe('result event', () => {
    it('should emit text from result when no text streamed', () => {
      const line = JSON.stringify({ type: 'result', result: 'Final answer' });
      expect(provider.parseStreamLine(line, session)).toEqual({ type: 'text', content: 'Final answer' });
    });

    it('should skip result when text was already streamed', () => {
      session.hasStreamedText = true;
      const line = JSON.stringify({ type: 'result', result: 'Duplicate' });
      expect(provider.parseStreamLine(line, session)).toBeNull();
    });
  });

  describe('error handling', () => {
    it('should parse error events', () => {
      const line = JSON.stringify({ type: 'error', error: { message: 'Model error' } });
      expect(provider.parseStreamLine(line, session)).toEqual({ type: 'error', content: 'Model error' });
    });

    it('should handle malformed JSON as text', () => {
      expect(provider.parseStreamLine('plain text output', session)).toEqual({ type: 'text', content: 'plain text output' });
    });

    it('should return null for empty lines', () => {
      expect(provider.parseStreamLine('', session)).toBeNull();
    });
  });

  describe('tool result', () => {
    it('should parse user message with tool_result', () => {
      const line = JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'output', is_error: false }] },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({
        type: 'tool_result',
        toolCall: { id: 'tool_1', name: '', input: {}, output: 'output', status: 'completed' },
      });
    });
  });

  describe('usage stats', () => {
    it('should capture from message_delta', () => {
      const line = JSON.stringify({
        type: 'stream_event',
        event: { type: 'message_delta', usage: { input_tokens: 200, output_tokens: 100 } },
      });
      provider.parseStreamLine(line, session);
      expect(session.lastUsageStats).toEqual({ input_tokens: 200, output_tokens: 100 });
    });
  });
});
