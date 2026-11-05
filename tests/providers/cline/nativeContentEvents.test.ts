import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestableClineProvider } from '../../helpers/providerFactory';
import { createClineSession } from '../../helpers/sessionFactory';

// Source-derived fixtures from installed Cline 3.0.61's event translator:
// assistant-reasoning-delta -> content_start/reasoning;
// tool-started/tool-finished -> content_start/content_end with contentType=tool.
// These are synthetic payloads in the installed wire format, not live results.
describe('Cline native content-event vocabulary', () => {
  let provider: TestableClineProvider;
  beforeEach(() => { provider = new TestableClineProvider(); });
  afterEach(() => provider.dispose());
  const session = () => createClineSession();
  function parse(event: Record<string, unknown>, owner = session()) {
    return provider.parseStreamLine(JSON.stringify({ type: 'agent_event', event }), owner);
  }

  it('retains the native tool name, input and identity through completion', () => {
    const owner = session();
    const input = { paths: ['src/retry.cjs'] };
    expect(parse({ type: 'content_start', contentType: 'tool', toolCallId: 'read-1', toolName: 'read_file', input }, owner))
      .toEqual({ type: 'tool_use', toolCall: { id: 'read-1', name: 'read_file', input, status: 'running' } });
    expect(parse({ type: 'content_end', contentType: 'tool', toolCallId: 'read-1', toolName: 'read_file', output: 'actual file bytes' }, owner))
      .toEqual({ type: 'tool_result', toolCall: { id: 'read-1', name: 'read_file', input, output: 'actual file bytes', status: 'completed' } });
    expect(owner.activeToolCalls.size).toBe(0);
  });

  it('keeps interleaved tool results attached to their original input and failure', () => {
    const owner = session();
    parse({ type: 'content_start', contentType: 'tool', toolCallId: 'one', toolName: 'read_file', input: { path: 'one' } }, owner);
    parse({ type: 'content_start', contentType: 'tool', toolCallId: 'two', toolName: 'write_file', input: { path: 'two' } }, owner);
    expect(parse({ type: 'content_end', contentType: 'tool', toolCallId: 'two', toolName: 'write_file', output: { reason: 'denied' }, error: true }, owner)?.toolCall)
      .toEqual({ id: 'two', name: 'write_file', input: { path: 'two' }, output: '{"reason":"denied"}', status: 'failed' });
    expect(parse({ type: 'content_end', contentType: 'tool', toolCallId: 'one', output: 'one bytes' }, owner)?.toolCall?.input).toEqual({ path: 'one' });
  });

  it('does not borrow a matching tool ID from a different panel', () => {
    const a = createClineSession('A'), b = createClineSession('B');
    parse({ type: 'content_start', contentType: 'tool', toolCallId: 'same', toolName: 'read_file', input: { path: 'A' } }, a);
    expect(parse({ type: 'content_end', contentType: 'tool', toolCallId: 'same', toolName: 'run_command', output: 'B output' }, b)?.toolCall)
      .toEqual({ id: 'same', name: 'run_command', input: {}, output: 'B output', status: 'completed' });
    expect(a.activeToolCalls.size).toBe(1);
  });

  it('streams native reasoning separately and never repeats its final summary', () => {
    const owner = session();
    expect(parse({ type: 'content_start', contentType: 'reasoning', reasoning: 'Inspect first.', redacted: false }, owner))
      .toEqual({ type: 'thinking', content: 'Inspect first.' });
    expect(parse({ type: 'content_start', contentType: 'reasoning', redacted: true }, owner)).toBeNull();
    expect(parse({ type: 'content_end', contentType: 'reasoning', reasoning: 'Inspect first.' }, owner)).toBeNull();
  });

  it('does not display opaque redacted reasoning as readable thinking', () => {
    expect(parse({ type: 'content_start', contentType: 'reasoning', reasoning: 'opaque-redacted-block', redacted: true })).toBeNull();
  });

  it('keeps tool updates and unrelated content out of assistant text', () => {
    expect(parse({ type: 'content_update', contentType: 'tool', toolCallId: 'x', update: 'progress' })).toBeNull();
    expect(parse({ type: 'content_start', contentType: 'media', text: 'not an answer' })).toBeNull();
    expect(parse({ type: 'content_start', contentType: 'text', text: 'Answer', accumulated: 'Answer' }))
      .toEqual({ type: 'text', content: 'Answer' });
  });

  it.each(['Native model request failed', { message: 'Native model request failed' }])('preserves native run-failed diagnostics: %j', error => {
    expect(parse({ type: 'error', error, recoverable: false, iteration: 1 }))
      .toEqual({ type: 'error', content: 'Native model request failed' });
  });
});
