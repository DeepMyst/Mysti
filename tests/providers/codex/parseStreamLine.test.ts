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

    it('should NOT reclassify ** wrapped plain text as thinking (Plan 02 Phase 3)', () => {
      // Bold markdown in agent text is body content; only reasoning items
      // become thinking chunks.
      const result = provider.parseStreamLine('**Thinking about this**', session);
      expect(result?.type).toBe('text');
      expect(result?.content).toBe('**Thinking about this**');
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
          kind: 'execute',
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

    // Plan 18 4.6b — `undefined !== null && undefined !== 0` marked an
    // item.completed WITHOUT exit_code as failed. Missing exit_code is
    // success-unknown, not failure.
    it('should treat a completed command WITHOUT exit_code as completed, not failed', () => {
      const line = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          id: 'cmd_noexit',
          command: 'echo hi',
          aggregated_output: 'hi',
        },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result?.type).toBe('tool_result');
      expect(result?.toolCall?.status).toBe('completed');
    });

    it('should treat a completed command with exit_code null as completed, not failed', () => {
      const line = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          id: 'cmd_nullexit',
          command: 'echo hi',
          exit_code: null,
          aggregated_output: 'hi',
        },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result?.type).toBe('tool_result');
      expect(result?.toolCall?.status).toBe('completed');
    });

    it('should still mark status:failed as failed even without exit_code', () => {
      const line = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          id: 'cmd_statusfail',
          command: 'bad',
          status: 'failed',
          aggregated_output: 'boom',
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

    // Plan 18 4.6a — event.error can be a raw object; content must always be a
    // string and never render "[object Object]".
    it('should surface error.message when turn.failed carries an object error', () => {
      const line = JSON.stringify({
        type: 'turn.failed',
        error: { message: 'usage limit reached', code: 'rate_limited' },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result?.type).toBe('error');
      expect(result?.content).toBe('usage limit reached');
    });

    it('should JSON-stringify an object error without a message field', () => {
      const line = JSON.stringify({
        type: 'turn.failed',
        error: { code: 429, retry_after: 30 },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result?.type).toBe('error');
      expect(typeof result?.content).toBe('string');
      expect(result?.content).toBe(JSON.stringify({ code: 429, retry_after: 30 }));
      expect(result?.content).not.toContain('[object Object]');
    });

    it('should fall back to "Turn failed" when turn.failed has no error payload', () => {
      const line = JSON.stringify({ type: 'turn.failed' });
      expect(provider.parseStreamLine(line, session)).toEqual({ type: 'error', content: 'Turn failed' });
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

  describe('per-panel state isolation', () => {
    // Plan 18 4.6c — the dead singleton fields (_activeToolCalls,
    // _completedToolCalls, _lastUsageStats) were deleted; all stream state
    // lives on CodexSessionState. Guard against reintroduction.
    it('keeps no tool/usage stream state on the provider instance', () => {
      const keys = Object.getOwnPropertyNames(provider);
      expect(keys).not.toContain('_activeToolCalls');
      expect(keys).not.toContain('_completedToolCalls');
      expect(keys).not.toContain('_lastUsageStats');
    });
  });
});
