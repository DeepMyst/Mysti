import { describe, it, expect, beforeEach } from 'vitest';
import { TestableGeminiProvider } from '../../helpers/providerFactory';
import { createGeminiSession } from '../../helpers/sessionFactory';

describe('GeminiProvider.parseStreamLine', () => {
  let provider: TestableGeminiProvider;
  let session: ReturnType<typeof createGeminiSession>;

  beforeEach(() => {
    provider = new TestableGeminiProvider();
    session = createGeminiSession();
  });

  describe('session initialization', () => {
    it('should parse init event', () => {
      const line = JSON.stringify({ type: 'init', session_id: 'gemini_sess_1' });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({ type: 'session_active', sessionId: 'gemini_sess_1' });
      expect(session.sessionId).toBe('gemini_sess_1');
    });

    it('should not re-emit session if already set', () => {
      session.sessionId = 'existing';
      const line = JSON.stringify({ type: 'init', session_id: 'new' });
      expect(provider.parseStreamLine(line, session)).toBeNull();
    });
  });

  describe('text streaming', () => {
    it('should parse message event', () => {
      const line = JSON.stringify({ type: 'message', role: 'assistant', content: 'Hello from Gemini' });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({ type: 'text', content: 'Hello from Gemini' });
    });

    it('should ignore non-assistant messages', () => {
      const line = JSON.stringify({ type: 'message', role: 'user', content: 'user input' });
      expect(provider.parseStreamLine(line, session)).toBeNull();
    });
  });

  describe('tool use', () => {
    it('should parse tool_use event', () => {
      const line = JSON.stringify({
        type: 'tool_use',
        tool_id: 'tool_1',
        tool_name: 'ReadFile',
        parameters: { path: '/src/main.ts' },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({
        type: 'tool_use',
        toolCall: {
          id: 'tool_1',
          name: 'ReadFile',
          input: { path: '/src/main.ts' },
          status: 'running',
        },
      });
      expect(session.activeToolCalls.has('tool_1')).toBe(true);
    });

    it('should parse tool_result event', () => {
      // First set up the active tool
      session.activeToolCalls.set('tool_1', { id: 'tool_1', name: 'ReadFile', input: { path: '/src/main.ts' } });

      const line = JSON.stringify({
        type: 'tool_result',
        tool_id: 'tool_1',
        output: 'file contents here',
        status: 'success',
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({
        type: 'tool_result',
        toolCall: {
          id: 'tool_1',
          name: 'ReadFile',
          input: { path: '/src/main.ts' },
          output: 'file contents here',
          status: 'completed',
        },
      });
      expect(session.activeToolCalls.has('tool_1')).toBe(false);
    });

    it('should mark failed tool_result', () => {
      session.activeToolCalls.set('tool_2', { id: 'tool_2', name: 'Bash', input: {} });
      const line = JSON.stringify({
        type: 'tool_result',
        tool_id: 'tool_2',
        output: 'command failed',
        status: 'error',
      });
      const result = provider.parseStreamLine(line, session);
      expect(result?.toolCall?.status).toBe('failed');
    });
  });

  describe('ask user question', () => {
    it('should detect ask_user tool and convert to ask_user_question', () => {
      const line = JSON.stringify({
        type: 'tool_use',
        tool_id: 'ask_1',
        tool_name: 'ask_user',
        parameters: {
          questions: [{
            question: 'Which database?',
            header: 'Setup',
            options: [
              { label: 'PostgreSQL', description: 'Relational' },
              { label: 'MongoDB', description: 'Document store' },
            ],
            multiSelect: false,
          }],
        },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result?.type).toBe('ask_user_question');
      expect(result?.askUserQuestion?.toolCallId).toBe('ask_1');
      expect(result?.askUserQuestion?.questions).toHaveLength(1);
      expect(result?.askUserQuestion?.questions[0].options).toHaveLength(2);
    });

    it('should detect AskUserQuestion tool name variant', () => {
      const line = JSON.stringify({
        type: 'tool_use',
        tool_id: 'ask_2',
        tool_name: 'AskUserQuestion',
        parameters: {
          questions: [{ question: 'Continue?', header: 'Confirm', options: [], multiSelect: false }],
        },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result?.type).toBe('ask_user_question');
    });
  });

  describe('error handling', () => {
    it('should parse error event', () => {
      const line = JSON.stringify({ type: 'error', message: 'Model overloaded' });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({ type: 'error', content: 'Model overloaded' });
    });

    it('should return null for empty lines', () => {
      expect(provider.parseStreamLine('', session)).toBeNull();
      expect(provider.parseStreamLine('   ', session)).toBeNull();
    });

    it('should return null for unknown types', () => {
      const line = JSON.stringify({ type: 'unknown', data: 'test' });
      expect(provider.parseStreamLine(line, session)).toBeNull();
    });
  });

  describe('usage stats', () => {
    it('should capture stats from result event', () => {
      const line = JSON.stringify({
        type: 'result',
        stats: { input_tokens: 500, output_tokens: 200 },
      });
      provider.parseStreamLine(line, session);
      expect(session.lastUsageStats).toEqual({
        input_tokens: 500,
        output_tokens: 200,
      });
    });
  });
});
