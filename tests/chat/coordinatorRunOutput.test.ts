import { describe, expect, it } from 'vitest';
import { CoordinatorRunOutput } from '../../src/chat/CoordinatorRunOutput';
import type { WebviewMessage } from '../../src/types';

function harness(jobId?: string) {
  const messages: WebviewMessage[] = [];
  const output = new CoordinatorRunOutput(message => messages.push(message), jobId, () => 123);
  return { output, messages };
}

describe('coordinator run output', () => {
  it('preserves interleaved prose, delegation tier, review identity and reasoning for replay', () => {
    const { output, messages } = harness();
    output.emitText('Checking ');
    output.emitText('the change.');
    output.observe({ model: 'actual-model', reasoning: 'Consider the edge cases.' });
    output.recordDelegation('d1', 'writer', 'fix', 'patched', false, 'strong');
    output.emitText('Now review.');
    output.recordReview('r1', 'reviewer', 'writer', 'needs work', true);
    const snapshot = output.snapshot(output.model!);
    expect(snapshot.content).toBe('Checking the change.Now review.');
    expect(snapshot.thinking).toBe('Consider the edge cases.');
    expect(snapshot.extras.model).toBe('actual-model');
    expect(snapshot.extras.segments).toEqual([
      { type: 'text', content: 'Checking the change.' },
      { type: 'tool', toolCallId: 'd1' },
      { type: 'text', content: 'Now review.' },
      { type: 'tool', toolCallId: 'r1' },
    ]);
    expect(snapshot.extras.toolCalls).toEqual([
      { id: 'd1', name: 'delegate', input: { agent: 'writer', task: 'fix', tier: 'strong' }, output: 'patched', status: 'completed' },
      { id: 'r1', name: 'review', input: { reviewer: 'reviewer', of: 'writer' }, output: 'needs work', status: 'failed' },
    ]);
    expect(messages[0]).toEqual({ type: 'responseChunk', payload: { type: 'text', content: 'Checking ', perfSentAt: 123 } });
    expect(messages[1]).toEqual({ type: 'responseChunk', payload: { type: 'text', content: 'the change.' } });
  });

  it('keeps concurrent foreground and background delivery and records separate', () => {
    const a = harness(), b = harness('job-b');
    const tool = { id: 'read', name: 'read', input: { path: 'a.ts' } };
    const result = { id: 'read', name: 'read', output: 'bytes', status: 'completed' };
    b.output.emitText('Background');
    b.output.emitThinking('Thinking');
    b.output.postToolUse(tool);
    b.output.postToolResult(result);
    a.output.emitText('Foreground');
    a.output.postToolUse(tool);
    a.output.postToolResult(result);
    expect(b.messages).toEqual([
      { type: 'jobProgress', payload: { jobId: 'job-b', kind: 'text', content: 'Background' } },
      { type: 'jobProgress', payload: { jobId: 'job-b', kind: 'thinking', content: 'Thinking' } },
      { type: 'jobToolUse', payload: { jobId: 'job-b', toolCall: tool } },
      { type: 'jobToolResult', payload: { jobId: 'job-b', toolCall: result } },
    ]);
    expect(a.messages.slice(1)).toEqual([{ type: 'toolUse', payload: tool }, { type: 'toolResult', payload: result }]);
    expect(a.output.text).toBe('Foreground');
    expect(a.output.snapshot('m').thinking).toBeUndefined();
  });

  it('snapshots interrupted work without duplicating the marker or sharing mutable tool data', () => {
    const { output, messages } = harness();
    const input = { edit: { path: 'original.ts' } };
    output.recordTool('t', 'write', input, 'written', false);
    input.edit.path = 'changed.ts';
    const stopped = output.snapshot('m', 'Stopped');
    expect(output.hasContent).toBe(true);
    expect(stopped.content).toBe('Stopped');
    expect(stopped.extras.toolCalls![0].input).toEqual({ edit: { path: 'original.ts' } });
    stopped.extras.toolCalls![0].output = 'mutated';
    stopped.extras.segments!.push({ type: 'text', content: 'mutated' });
    const second = output.snapshot('m', 'Stopped');
    expect(second.extras.toolCalls![0].output).toBe('written');
    expect(second.extras.segments).toEqual([{ type: 'tool', toolCallId: 't' }, { type: 'text', content: '\n\nStopped' }]);
    expect(messages).toEqual([]);
  });

  it('distinguishes unknown usage from measured zero and keeps spend separate from fill', () => {
    const { output } = harness();
    expect(output.receipt(0)).toBeUndefined();
    expect(output.measurements()).toMatchObject({ outputTokens: undefined, contextTokens: undefined, estimated: true });
    output.beginTurn();
    output.observe({ usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 300 }, costUsd: 0.2 });
    output.beginTurn();
    output.observe({ usage: { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 100 }, costUsd: 0.3 });
    expect(output.receipt(2)).toMatchObject({ input_tokens: 150, output_tokens: 30, contextTokens: 150, cache_read_input_tokens: 300, cache_creation_input_tokens: 300, costUsd: 0.5, delegations: 2 });
    expect(output.measurements()).toMatchObject({ contextTokens: 150, outputTokens: 30, estimated: false });
    const zero = harness().output;
    zero.observe({ usage: { input_tokens: 0, output_tokens: 0 } });
    expect(zero.receipt(0)).toMatchObject({ input_tokens: 0, output_tokens: 0, contextTokens: 0 });
    expect(zero.measurements()).toMatchObject({ outputTokens: 0, estimated: false });
  });

  it('does not estimate over real usage delivered with a directive', () => {
    const { output } = harness();
    output.beginTurn();
    output.observe({ text: '<read:nonce path="a"/>', usage: { input_tokens: 13, output_tokens: 9 } });
    output.estimateInterruptedTurn('<read:nonce path="a"/>');
    expect(output.receipt(0)).toMatchObject({ input_tokens: 13, output_tokens: 9, contextTokens: 13 });
    expect(output.receipt(0)).not.toHaveProperty('tokensPartial');
  });

  it('flags estimates and avoids claiming an earlier prompt size is current', () => {
    const { output } = harness();
    output.beginTurn();
    output.observe({ usage: { input_tokens: 500, output_tokens: 10 } });
    output.beginTurn();
    output.estimateInterruptedTurn('123456789');
    expect(output.receipt(1)).toMatchObject({ output_tokens: 13, tokensPartial: true });
    expect(output.receipt(1)).not.toHaveProperty('contextTokens');
    expect(output.measurements()).toMatchObject({ contextTokens: undefined, estimated: true });
  });

  it('rejects malformed cost measurements without poisoning a later valid receipt', () => {
    const { output } = harness();
    for (const costUsd of [NaN, Infinity, -1]) { output.observe({ costUsd }); }
    expect(output.receipt(0)).toBeUndefined();
    output.observe({ costUsd: 0.25 });
    expect(output.receipt(0)).toMatchObject({ costUsd: 0.25 });
  });
});
