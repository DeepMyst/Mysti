import { describe, it, expect, beforeEach } from 'vitest';
import { TestableCodexProvider } from '../../helpers/providerFactory';
import { createCodexSession } from '../../helpers/sessionFactory';

describe('CodexProvider.parseStreamLine', () => {
  let provider: TestableCodexProvider;
  let session: ReturnType<typeof createCodexSession>;

  beforeEach(() => {
    provider = new TestableCodexProvider();
    session = createCodexSession();
  });

  describe('session initialization', () => {
    it('should parse thread.started event', () => {
      const line = JSON.stringify({ type: 'thread.started', thread_id: 'thread_abc' });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({ type: 'session_active', sessionId: 'thread_abc' });
      expect(session.sessionId).toBe('thread_abc');
    });
  });

  describe('text streaming', () => {
    it('should parse agent_message item', () => {
      const line = JSON.stringify({
        type: 'item.updated',
        item: { type: 'agent_message', text: 'Here is the code' },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({ type: 'text', content: 'Here is the code' });
    });

    it('should parse message item type', () => {
      const line = JSON.stringify({
        type: 'item.updated',
        item: { type: 'message', text: 'Hello from Codex' },
      });
      expect(provider.parseStreamLine(line, session)?.type).toBe('text');
    });
  });

  describe('thinking/reasoning', () => {
    it('should parse reasoning item', () => {
      const line = JSON.stringify({
        type: 'item.updated',
        item: { type: 'reasoning', text: '**Analyzing the codebase**' },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result?.type).toBe('thinking');
      // Should strip ** markers
      expect(result?.content).toBe('Analyzing the codebase\n');
    });

    it('should detect thinking from ** wrapped plain text', () => {
      const result = provider.parseStreamLine('**Thinking about this**', session);
      expect(result?.type).toBe('thinking');
      expect(result?.content).toBe('Thinking about this\n');
    });
  });

  describe('tool use - command execution', () => {
    it('should emit tool_use for command start', () => {
      const line = JSON.stringify({
        type: 'item.started',
        item: { type: 'command_execution', id: 'cmd_1', command: 'ls -la' },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({
        type: 'tool_use',
        toolCall: {
          id: 'cmd_1',
          name: 'Bash',
          input: { command: 'ls -la' },
          status: 'running',
        },
      });
    });

    it('should emit tool_result for completed command', () => {
      const line = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          id: 'cmd_1',
          command: 'ls -la',
          exit_code: 0,
          aggregated_output: 'file1.ts\nfile2.ts',
        },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({
        type: 'tool_result',
        toolCall: {
          id: 'cmd_1',
          name: 'Bash',
          input: { command: 'ls -la' },
          output: 'file1.ts\nfile2.ts',
          status: 'completed',
        },
      });
    });

    it('should mark failed commands', () => {
      const line = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          id: 'cmd_2',
          command: 'invalid-cmd',
          exit_code: 1,
          aggregated_output: 'command not found',
        },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result?.toolCall?.status).toBe('failed');
    });

    it('should deduplicate completed tool calls', () => {
      const completedLine = JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', id: 'cmd_dup', command: 'ls', exit_code: 0, aggregated_output: 'ok' },
      });

      const first = provider.parseStreamLine(completedLine, session);
      expect(first?.type).toBe('tool_result');

      const second = provider.parseStreamLine(completedLine, session);
      expect(second).toBeNull();
    });
  });

  describe('ask user question', () => {
    it('should detect ask_user tool call', () => {
      const line = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'mcp_tool_call',
          id: 'ask_1',
          name: 'ask_user',
          arguments: {
            questions: [{
              question: 'Which approach?',
              header: 'Design',
              options: [{ label: 'A', description: 'Simple' }],
              multiSelect: false,
            }],
          },
        },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result?.type).toBe('ask_user_question');
      expect(result?.askUserQuestion?.toolCallId).toBe('ask_1');
      expect(result?.askUserQuestion?.questions).toHaveLength(1);
    });
  });

  describe('usage stats', () => {
    it('should capture from turn.completed', () => {
      const line = JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 200, output_tokens: 100, cached_input_tokens: 50 },
      });
      provider.parseStreamLine(line, session);
      expect(session.lastUsageStats).toEqual({
        input_tokens: 200,
        output_tokens: 100,
        cache_read_input_tokens: 50,
      });
    });
  });

  describe('error handling', () => {
    it('should parse turn.failed', () => {
      const line = JSON.stringify({ type: 'turn.failed', error: 'Rate limited' });
      expect(provider.parseStreamLine(line, session)).toEqual({ type: 'error', content: 'Rate limited' });
    });

    it('should parse error event', () => {
      const line = JSON.stringify({ type: 'error', message: 'API error' });
      expect(provider.parseStreamLine(line, session)).toEqual({ type: 'error', content: 'API error' });
    });

    it('should handle non-JSON as text', () => {
      expect(provider.parseStreamLine('plain output', session)).toEqual({ type: 'text', content: 'plain output' });
    });

    it('should return null for empty lines', () => {
      expect(provider.parseStreamLine('', session)).toBeNull();
    });
  });
});
