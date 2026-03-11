import { describe, it, expect, beforeEach } from 'vitest';
import { TestableOpenClawProvider } from '../../helpers/providerFactory';
import { createOpenClawSession } from '../../helpers/sessionFactory';

describe('OpenClawProvider.parseStreamLine', () => {
  let provider: TestableOpenClawProvider;
  let session: ReturnType<typeof createOpenClawSession>;

  beforeEach(() => {
    provider = new TestableOpenClawProvider();
    session = createOpenClawSession();
  });

  describe('session initialization', () => {
    it('should parse system event', () => {
      const line = JSON.stringify({ type: 'system', session_id: 'oc_1' });
      expect(provider.parseStreamLine(line, session)).toEqual({ type: 'session_active', sessionId: 'oc_1' });
    });

    it('should parse init event', () => {
      const line = JSON.stringify({ type: 'init', agent_id: 'agent_abc' });
      expect(provider.parseStreamLine(line, session)).toEqual({ type: 'session_active', sessionId: 'agent_abc' });
    });
  });

  describe('text streaming', () => {
    it('should parse text event', () => {
      const line = JSON.stringify({ type: 'text', content: 'Hello from OpenClaw' });
      expect(provider.parseStreamLine(line, session)).toEqual({ type: 'text', content: 'Hello from OpenClaw' });
    });

    it('should parse assistant event', () => {
      const line = JSON.stringify({ type: 'assistant', text: 'Response text' });
      expect(provider.parseStreamLine(line, session)).toEqual({ type: 'text', content: 'Response text' });
    });

    it('should parse content event', () => {
      const line = JSON.stringify({ type: 'content', content: 'Content block' });
      expect(provider.parseStreamLine(line, session)).toEqual({ type: 'text', content: 'Content block' });
    });

    it('should parse block/chunk events', () => {
      expect(provider.parseStreamLine(JSON.stringify({ type: 'block', content: 'Block data' }), session))
        .toEqual({ type: 'text', content: 'Block data' });
      expect(provider.parseStreamLine(JSON.stringify({ type: 'chunk', text: 'Chunk data' }), session))
        .toEqual({ type: 'text', content: 'Chunk data' });
    });
  });

  describe('thinking', () => {
    it('should parse thinking event', () => {
      const line = JSON.stringify({ type: 'thinking', content: 'Analyzing...' });
      expect(provider.parseStreamLine(line, session)).toEqual({ type: 'thinking', content: 'Analyzing...' });
    });

    it('should parse reasoning event', () => {
      const line = JSON.stringify({ type: 'reasoning', text: 'Deep reasoning' });
      expect(provider.parseStreamLine(line, session)).toEqual({ type: 'thinking', content: 'Deep reasoning' });
    });
  });

  describe('tool use', () => {
    it('should parse tool_call started', () => {
      const line = JSON.stringify({
        type: 'tool_call',
        id: 'tool_1',
        name: 'read',
        input: { path: '/src/main.ts' },
        status: 'started',
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({
        type: 'tool_use',
        toolCall: { id: 'tool_1', name: 'read', input: { path: '/src/main.ts' }, status: 'running' },
      });
    });

    it('should parse tool_call completed', () => {
      session.activeToolCalls.set('tool_1', { id: 'tool_1', name: 'read', inputJson: '{"path":"/src/main.ts"}' });
      const line = JSON.stringify({
        type: 'tool_call',
        id: 'tool_1',
        name: 'read',
        status: 'completed',
        output: 'file contents',
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({
        type: 'tool_result',
        toolCall: {
          id: 'tool_1',
          name: 'read',
          input: { path: '/src/main.ts' },
          output: 'file contents',
          status: 'completed',
        },
      });
    });

    it('should parse standalone tool_result', () => {
      const line = JSON.stringify({
        type: 'tool_result',
        tool_use_id: 'tool_2',
        tool_name: 'bash',
        content: 'command output',
        is_error: false,
      });
      const result = provider.parseStreamLine(line, session);
      expect(result?.type).toBe('tool_result');
      expect(result?.toolCall?.status).toBe('completed');
    });
  });

  describe('ask user question', () => {
    it('should detect ask_user tool call', () => {
      const line = JSON.stringify({
        type: 'tool_call',
        id: 'ask_1',
        name: 'ask_user',
        input: {
          questions: [{ question: 'Continue?', header: 'Confirm', options: [], multiSelect: false }],
        },
        status: 'started',
      });
      const result = provider.parseStreamLine(line, session);
      expect(result?.type).toBe('ask_user_question');
      expect(result?.askUserQuestion?.questions).toHaveLength(1);
    });
  });

  describe('error handling', () => {
    it('should parse error event', () => {
      const line = JSON.stringify({ type: 'error', message: 'Connection failed' });
      expect(provider.parseStreamLine(line, session)).toEqual({ type: 'error', content: 'Connection failed' });
    });

    it('should return null for empty lines', () => {
      expect(provider.parseStreamLine('', session)).toBeNull();
    });

    it('should treat non-JSON as text', () => {
      expect(provider.parseStreamLine('plain output text', session)).toEqual({ type: 'text', content: 'plain output text' });
    });
  });

  describe('done events', () => {
    it('should parse done event', () => {
      expect(provider.parseStreamLine(JSON.stringify({ type: 'done' }), session)).toEqual({ type: 'done' });
    });

    it('should parse complete event', () => {
      expect(provider.parseStreamLine(JSON.stringify({ type: 'complete' }), session)).toEqual({ type: 'done' });
    });

    it('should parse end event', () => {
      expect(provider.parseStreamLine(JSON.stringify({ type: 'end' }), session)).toEqual({ type: 'done' });
    });
  });

  describe('usage stats', () => {
    it('should capture from usage event', () => {
      provider.parseStreamLine(JSON.stringify({
        type: 'usage',
        input_tokens: 500,
        output_tokens: 200,
      }), session);
      expect(session.lastUsageStats).toEqual({ input_tokens: 500, output_tokens: 200 });
    });
  });
});
