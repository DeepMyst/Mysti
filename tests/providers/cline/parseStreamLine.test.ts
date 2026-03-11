import { describe, it, expect, beforeEach } from 'vitest';
import { TestableClineProvider } from '../../helpers/providerFactory';
import { createClineSession } from '../../helpers/sessionFactory';

describe('ClineProvider.parseStreamLine', () => {
  let provider: TestableClineProvider;
  let session: ReturnType<typeof createClineSession>;

  beforeEach(() => {
    provider = new TestableClineProvider();
    session = createClineSession();
  });

  describe('text streaming', () => {
    it('should parse completion_result as text', () => {
      const line = JSON.stringify({ type: 'say', say: 'completion_result', text: 'Here is the answer' });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({ type: 'text', content: 'Here is the answer' });
    });

    it('should parse say:text as thinking (reasoning stream)', () => {
      const line = JSON.stringify({ type: 'say', say: 'text', text: 'Analyzing the codebase...' });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({ type: 'thinking', content: 'Analyzing the codebase...' });
    });

    it('should parse direct text type', () => {
      const line = JSON.stringify({ type: 'text', content: 'Direct text content' });
      expect(provider.parseStreamLine(line, session)).toEqual({ type: 'text', content: 'Direct text content' });
    });

    it('should filter echoed user input', () => {
      session.lastUserInput = 'Hello';
      const line = JSON.stringify({ type: 'say', say: 'text', text: 'Hello' });
      expect(provider.parseStreamLine(line, session)).toBeNull();
    });
  });

  describe('thinking', () => {
    it('should parse reasoning messages', () => {
      const line = JSON.stringify({ type: 'say', say: 'reasoning', reasoning: 'Let me think about this...' });
      expect(provider.parseStreamLine(line, session)).toEqual({ type: 'thinking', content: 'Let me think about this...' });
    });

    it('should parse direct thinking type', () => {
      const line = JSON.stringify({ type: 'thinking', content: 'Deep thought' });
      expect(provider.parseStreamLine(line, session)).toEqual({ type: 'thinking', content: 'Deep thought' });
    });
  });

  describe('ask user question', () => {
    it('should convert ask with question to ask_user_question', () => {
      const askData = JSON.stringify({ question: 'Which database?', options: [{ label: 'PostgreSQL', description: 'SQL' }] });
      const line = JSON.stringify({ type: 'ask', ask: 'followup', text: askData });
      const result = provider.parseStreamLine(line, session);
      expect(result?.type).toBe('ask_user_question');
      expect(result?.askUserQuestion?.questions[0].question).toBe('Which database?');
      expect(result?.askUserQuestion?.questions[0].options).toHaveLength(1);
      expect(session.askReceived).toBe(true);
    });

    it('should provide default Yes/No options when none given', () => {
      const askData = JSON.stringify({ question: 'Should I proceed?' });
      const line = JSON.stringify({ type: 'ask', ask: 'followup', text: askData });
      const result = provider.parseStreamLine(line, session);
      expect(result?.askUserQuestion?.questions[0].options).toEqual([
        { label: 'Yes', description: 'Accept' },
        { label: 'No', description: 'Decline' },
      ]);
    });
  });

  describe('error handling', () => {
    it('should parse say:error', () => {
      const line = JSON.stringify({ type: 'say', say: 'error', text: 'Something went wrong' });
      expect(provider.parseStreamLine(line, session)).toEqual({ type: 'error', content: 'Something went wrong' });
    });

    it('should parse api_req_failed ask', () => {
      const failData = JSON.stringify({ message: 'API key invalid', modelId: 'gpt-4' });
      const line = JSON.stringify({ type: 'ask', ask: 'api_req_failed', text: failData });
      const result = provider.parseStreamLine(line, session);
      expect(result?.type).toBe('error');
      expect(result?.content).toContain('API key invalid');
      expect(result?.content).toContain('gpt-4');
      expect(session.askReceived).toBe(true);
    });

    it('should parse direct error type', () => {
      const line = JSON.stringify({ type: 'error', error: 'Connection failed' });
      expect(provider.parseStreamLine(line, session)).toEqual({ type: 'error', content: 'Connection failed' });
    });

    it('should return null for empty lines', () => {
      expect(provider.parseStreamLine('', session)).toBeNull();
    });

    it('should skip startup noise', () => {
      expect(provider.parseStreamLine('[DEBUG] Loading config...', session)).toBeNull();
      expect(provider.parseStreamLine('Starting new Cline instance', session)).toBeNull();
      expect(provider.parseStreamLine('Press Ctrl+C to exit', session)).toBeNull();
      expect(provider.parseStreamLine('**', session)).toBeNull();
    });
  });

  describe('completion_result ask', () => {
    it('should set askReceived on completion_result ask', () => {
      const line = JSON.stringify({ type: 'ask', ask: 'completion_result' });
      provider.parseStreamLine(line, session);
      expect(session.askReceived).toBe(true);
    });
  });

  describe('tool use', () => {
    it('should parse tool_use events with deduplication', () => {
      const line = JSON.stringify({
        type: 'tool_use',
        toolCall: { id: 'tool_1', name: 'ReadFile', input: { path: '/src/main.ts' }, status: 'running' },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({
        type: 'tool_use',
        toolCall: { id: 'tool_1', name: 'ReadFile', input: { path: '/src/main.ts' }, status: 'running' },
      });

      // Duplicate should be skipped after completion
      session.completedToolCalls.add('tool_1');
      expect(provider.parseStreamLine(line, session)).toBeNull();
    });

    it('should parse tool_result events with deduplication', () => {
      const line = JSON.stringify({
        type: 'tool_result',
        toolCall: { id: 'tool_1', name: 'ReadFile', output: 'contents', status: 'completed' },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result?.type).toBe('tool_result');

      // Second result for same ID should be deduped
      expect(provider.parseStreamLine(line, session)).toBeNull();
    });
  });

  describe('usage stats', () => {
    it('should capture from done event', () => {
      const line = JSON.stringify({
        type: 'done',
        usage: { input_tokens: 500, output_tokens: 200 },
      });
      provider.parseStreamLine(line, session);
      expect(session.lastUsageStats).toEqual({
        input_tokens: 500,
        output_tokens: 200,
        cache_creation_input_tokens: undefined,
        cache_read_input_tokens: undefined,
      });
    });

    it('should capture from usage event', () => {
      const line = JSON.stringify({
        type: 'usage',
        tokens: { inputTokens: 300, outputTokens: 150 },
      });
      provider.parseStreamLine(line, session);
      expect(session.lastUsageStats?.input_tokens).toBe(300);
    });
  });

  describe('multi-line JSON buffering', () => {
    it('should buffer and parse multi-line JSON', () => {
      // First line starts JSON
      expect(provider.parseStreamLine('{"type":"say",', session)).toBeNull();
      // Second line continues
      expect(provider.parseStreamLine('"say":"completion_result",', session)).toBeNull();
      // Third line completes
      const result = provider.parseStreamLine('"text":"Hello"}', session);
      expect(result).toEqual({ type: 'text', content: 'Hello' });
    });
  });
});
