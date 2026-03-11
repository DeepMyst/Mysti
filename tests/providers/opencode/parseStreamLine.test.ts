import { describe, it, expect, beforeEach } from 'vitest';
import { TestableOpenCodeProvider } from '../../helpers/providerFactory';
import { createOpenCodeSession } from '../../helpers/sessionFactory';

describe('OpenCodeProvider.parseStreamLine', () => {
  let provider: TestableOpenCodeProvider;
  let session: ReturnType<typeof createOpenCodeSession>;

  beforeEach(() => {
    provider = new TestableOpenCodeProvider();
    session = createOpenCodeSession();
  });

  describe('session initialization', () => {
    it('should extract sessionID from step_start', () => {
      // The generic sessionID extraction at the top of parseStreamLine sets session.sessionId
      // before the step_start case runs, so step_start's !session.sessionId check is false.
      // Result is null but sessionId is still set on the session.
      const line = JSON.stringify({ type: 'step_start', sessionID: 'oc_sess_1' });
      const result = provider.parseStreamLine(line, session);
      expect(result).toBeNull();
      expect(session.sessionId).toBe('oc_sess_1');
    });

    it('should extract sessionID from any event', () => {
      const line = JSON.stringify({ type: 'text', sessionID: 'oc_sess_2', part: { text: 'hello' } });
      provider.parseStreamLine(line, session);
      expect(session.sessionId).toBe('oc_sess_2');
    });
  });

  describe('text streaming', () => {
    it('should parse text event with part.text', () => {
      const line = JSON.stringify({ type: 'text', part: { text: 'Hello from OpenCode' } });
      expect(provider.parseStreamLine(line, session)).toEqual({ type: 'text', content: 'Hello from OpenCode' });
    });

    it('should parse message.part.updated with text type', () => {
      const line = JSON.stringify({
        type: 'message.part.updated',
        part: { type: 'text', text: 'Response text' },
      });
      expect(provider.parseStreamLine(line, session)).toEqual({ type: 'text', content: 'Response text' });
    });
  });

  describe('thinking', () => {
    it('should parse thinking part', () => {
      const line = JSON.stringify({
        type: 'message.part.updated',
        part: { type: 'thinking', text: 'Let me analyze...' },
      });
      expect(provider.parseStreamLine(line, session)).toEqual({ type: 'thinking', content: 'Let me analyze...' });
    });

    it('should parse reasoning part', () => {
      const line = JSON.stringify({
        type: 'message.part.updated',
        part: { type: 'reasoning', text: 'Considering options...' },
      });
      expect(provider.parseStreamLine(line, session)).toEqual({ type: 'thinking', content: 'Considering options...' });
    });
  });

  describe('tool use via message.part.updated', () => {
    it('should emit tool_use for running tool part', () => {
      const line = JSON.stringify({
        type: 'message.part.updated',
        part: { type: 'tool', id: 'tool_1', name: 'bash', state: 'running', input: { command: 'ls' } },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({
        type: 'tool_use',
        toolCall: { id: 'tool_1', name: 'bash', input: { command: 'ls' }, status: 'running' },
      });
    });

    it('should emit tool_result for completed tool part', () => {
      session.activeToolCalls.set('tool_1', { id: 'tool_1', name: 'bash', input: { command: 'ls' } });
      const line = JSON.stringify({
        type: 'message.part.updated',
        part: { type: 'tool', id: 'tool_1', name: 'bash', state: 'completed', output: 'file1\nfile2' },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({
        type: 'tool_result',
        toolCall: { id: 'tool_1', name: 'bash', input: { command: 'ls' }, output: 'file1\nfile2', status: 'completed' },
      });
    });

    it('should emit failed tool_result for error state', () => {
      const line = JSON.stringify({
        type: 'message.part.updated',
        part: { type: 'tool', id: 'tool_2', name: 'bash', state: 'error', error: 'Permission denied' },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result?.toolCall?.status).toBe('failed');
      expect(result?.toolCall?.output).toBe('Permission denied');
    });
  });

  describe('direct tool events', () => {
    it('should parse tool_use event', () => {
      const line = JSON.stringify({
        type: 'tool_use',
        tool_id: 'direct_1',
        tool_name: 'read',
        parameters: { path: '/src/main.ts' },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({
        type: 'tool_use',
        toolCall: { id: 'direct_1', name: 'read', input: { path: '/src/main.ts' }, status: 'running' },
      });
    });

    it('should parse tool_result event', () => {
      session.activeToolCalls.set('direct_1', { id: 'direct_1', name: 'read', input: {} });
      const line = JSON.stringify({
        type: 'tool_result',
        tool_id: 'direct_1',
        output: 'file contents',
        status: 'completed',
      });
      const result = provider.parseStreamLine(line, session);
      expect(result?.type).toBe('tool_result');
      expect(result?.toolCall?.status).toBe('completed');
    });
  });

  describe('usage stats', () => {
    it('should capture from step_finish', () => {
      provider.parseStreamLine(JSON.stringify({
        type: 'step_finish',
        part: { tokens: { input: 500, output: 200 } },
      }), session);
      expect(session.lastUsageStats).toEqual({ input_tokens: 500, output_tokens: 200 });
    });
  });

  describe('error handling', () => {
    it('should parse error event with string message', () => {
      const line = JSON.stringify({ type: 'error', message: 'Model not found' });
      expect(provider.parseStreamLine(line, session)).toEqual({ type: 'error', content: 'Model not found' });
    });

    it('should stringify non-string error messages', () => {
      const line = JSON.stringify({ type: 'error', message: { name: 'UnknownError', data: { message: 'Bad request' } } });
      const result = provider.parseStreamLine(line, session);
      expect(result?.type).toBe('error');
      expect(result?.content).toContain('UnknownError');
    });

    it('should return null for empty lines', () => {
      expect(provider.parseStreamLine('', session)).toBeNull();
    });
  });
});
