import { describe, it, expect, beforeEach } from 'vitest';
import { TestableCopilotProvider } from '../../helpers/providerFactory';
import { createCopilotSession } from '../../helpers/sessionFactory';

describe('CopilotProvider.parseStreamLine', () => {
  let provider: TestableCopilotProvider;
  let session: ReturnType<typeof createCopilotSession>;

  beforeEach(() => {
    provider = new TestableCopilotProvider();
    session = createCopilotSession();
  });

  describe('plain text (primary mode)', () => {
    it('should format plain text output', () => {
      const result = provider.parseStreamLine('Here is the response from Copilot', session);
      expect(result?.type).toBe('text');
      expect(result?.content).toContain('Here is the response from Copilot');
    });

    it('should return null for empty lines', () => {
      expect(provider.parseStreamLine('', session)).toBeNull();
    });
  });

  describe('JSON mode (future support)', () => {
    it('should parse init event', () => {
      const line = JSON.stringify({ type: 'init', session_id: 'copilot_1' });
      const result = provider.parseStreamLine(line, session);
      expect(result).toEqual({ type: 'session_active', sessionId: 'copilot_1' });
      expect(session.sessionId).toBe('copilot_1');
    });

    it('should parse message event', () => {
      const line = JSON.stringify({ type: 'message', role: 'assistant', content: 'Hello' });
      expect(provider.parseStreamLine(line, session)).toEqual({ type: 'text', content: 'Hello' });
    });

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
        toolCall: { id: 'tool_1', name: 'ReadFile', input: { path: '/src/main.ts' }, status: 'running' },
      });
    });

    it('should parse tool_result event', () => {
      session.activeToolCalls.set('tool_1', { id: 'tool_1', name: 'ReadFile', input: {} });
      const line = JSON.stringify({
        type: 'tool_result',
        tool_id: 'tool_1',
        output: 'file contents',
        status: 'success',
      });
      const result = provider.parseStreamLine(line, session);
      expect(result?.toolCall?.status).toBe('completed');
    });

    it('should detect ask_user tool', () => {
      const line = JSON.stringify({
        type: 'tool_use',
        tool_id: 'ask_1',
        tool_name: 'ask_user',
        parameters: {
          questions: [{ question: 'Continue?', header: 'Confirm', options: [], multiSelect: false }],
        },
      });
      const result = provider.parseStreamLine(line, session);
      expect(result?.type).toBe('ask_user_question');
    });

    it('should parse error event', () => {
      const line = JSON.stringify({ type: 'error', message: 'Auth failed' });
      expect(provider.parseStreamLine(line, session)).toEqual({ type: 'error', content: 'Auth failed' });
    });

    it('should capture usage from result event', () => {
      provider.parseStreamLine(JSON.stringify({
        type: 'result',
        stats: { input_tokens: 300, output_tokens: 100 },
      }), session);
      expect(session.lastUsageStats).toEqual({ input_tokens: 300, output_tokens: 100 });
    });
  });
});
