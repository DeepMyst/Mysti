import { describe, it, expect, beforeEach } from 'vitest';
import { TestableCopilotProvider } from '../../helpers/providerFactory';
import { createCopilotSession } from '../../helpers/sessionFactory';
import { clearMockConfig } from '../../helpers/mockVscode';

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
        toolCall: { id: 'tool_1', name: 'ReadFile', input: { path: '/src/main.ts' }, status: 'running', kind: 'read' },
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

// ---------------------------------------------------------------------------
// Copilot CLI 1.0 JSONL (2026-09-06)
//
// The 0.0.x line emitted plain text with NO tool events, so no tool_use chunk
// ever reached Mysti's stream-level permission gate — Copilot ran `bash`
// entirely unobserved, and ask-tier had to deny shell/write outright to stay
// safe. 1.0's `--output-format json` is what finally makes it gateable.
//
// Lines below are captured verbatim from `copilot -p … --output-format json`
// on 1.0.83.
// ---------------------------------------------------------------------------
describe('Copilot 1.0 JSON stream', () => {
  let p: TestableCopilotProvider;

  beforeEach(() => {
    clearMockConfig();
    p = new TestableCopilotProvider();
  });

  it('streams message deltas and not the repeated whole message', () => {
    const session = createCopilotSession();
    const deltas = [
      '{"type":"assistant.message_delta","data":{"messageId":"m1","deltaContent":"Okay"}}',
      '{"type":"assistant.message_delta","data":{"messageId":"m1","deltaContent":","}}',
      '{"type":"assistant.message_delta","data":{"messageId":"m1","deltaContent":" sure"}}',
    ].map((l) => p.parseStreamLine(l, session));
    expect(deltas.map((c) => c && c.type === 'text' ? c.content : '').join('')).toBe('Okay, sure');

    // `assistant.message` repeats the full answer after the deltas.
    expect(p.parseStreamLine(
      '{"type":"assistant.message","data":{"messageId":"m1","content":"Okay, sure","phase":"final_answer"}}',
      session,
    )).toBeNull();
  });

  /** The event Mysti's permission gate exists to intercept. */
  it('emits a tool_use for tool.execution_start', () => {
    const chunk = p.parseStreamLine(
      '{"type":"tool.execution_start","data":{"toolCallId":"call_1","toolName":"bash","arguments":{"command":"ls","description":"List files"}}}',
      createCopilotSession(),
    );
    expect(chunk).toEqual({
      type: 'tool_use',
      toolCall: {
        id: 'call_1',
        name: 'bash',
        input: { command: 'ls', description: 'List files' },
        status: 'running',
      },
    });
  });

  it('pairs the result back to the call it started', () => {
    const session = createCopilotSession();
    p.parseStreamLine(
      '{"type":"tool.execution_start","data":{"toolCallId":"call_1","toolName":"bash","arguments":{"command":"ls"}}}',
      session,
    );
    const chunk = p.parseStreamLine(
      '{"type":"tool.execution_complete","data":{"toolCallId":"call_1","success":true,"result":{"content":"README.md"}}}',
      session,
    );
    expect(chunk?.type).toBe('tool_result');
    expect(chunk?.toolCall).toMatchObject({
      id: 'call_1',
      name: 'bash',
      input: { command: 'ls' },
      output: 'README.md',
      status: 'completed',
    });
    expect(session.activeToolCalls.size).toBe(0);
  });

  it('marks a failed tool as failed', () => {
    const chunk = p.parseStreamLine(
      '{"type":"tool.execution_complete","data":{"toolCallId":"c2","toolName":"bash","success":false,"result":{"content":"boom"}}}',
      createCopilotSession(),
    );
    expect(chunk?.toolCall?.status).toBe('failed');
  });

  /**
   * The argument JSON arrives one fragment at a time and is delivered whole by
   * tool.execution_start; rendering the fragments would print `{"` at the user.
   */
  it('swallows telemetry and partial fragments', () => {
    const session = createCopilotSession();
    for (const line of [
      '{"type":"assistant.tool_call_delta","data":{"toolCallId":"c1","toolName":"bash","inputDelta":"{\\""}}',
      '{"type":"tool.execution_partial_result","data":{"toolCallId":"c1","partialOutput":"READ"}}',
      '{"type":"session.usage_checkpoint","data":{"totalNanoAiu":617725000}}',
      '{"type":"session.mcp_server_status_changed","data":{"serverName":"github-mcp-server","status":"pending"}}',
      '{"type":"model.call_start","data":{"turnId":"0"}}',
      '{"type":"assistant.turn_end","data":{"turnId":"0"}}',
      '{"type":"user.message","data":{"content":"hi"}}',
    ]) {
      expect(p.parseStreamLine(line, session), line.slice(0, 40)).toBeNull();
    }
  });

  /** An unknown dotted event is telemetry, not prose to show the user. */
  it('does not print an unrecognised 1.0 event as text', () => {
    expect(p.parseStreamLine(
      '{"type":"session.something_new","data":{"x":1}}',
      createCopilotSession(),
    )).toBeNull();
  });
});
