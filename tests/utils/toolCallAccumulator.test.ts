/**
 * Streaming tool_call accumulator (Plan 19 Phase 4) — reassembling OpenAI-style
 * tool_call deltas (id/name early, arguments streamed in fragments, keyed by index).
 */
import { describe, it, expect } from 'vitest';
import { ToolCallAccumulator, parseToolArgs } from '../../src/utils/toolCallAccumulator';

describe('ToolCallAccumulator', () => {
  it('reassembles a single tool call from streamed argument fragments', () => {
    const acc = new ToolCallAccumulator();
    acc.add([{ index: 0, id: 'call_1', function: { name: 'write' } }]);
    acc.add([{ index: 0, function: { arguments: '{"path":"a.ts",' } }]);
    acc.add([{ index: 0, function: { arguments: '"content":"x"}' } }]);
    expect(acc.hasAny()).toBe(true);
    expect(acc.finalize()).toEqual([{ id: 'call_1', name: 'write', arguments: '{"path":"a.ts","content":"x"}' }]);
  });

  it('handles multiple parallel tool calls by index (ordered)', () => {
    const acc = new ToolCallAccumulator();
    acc.add([{ index: 1, id: 'b', function: { name: 'ls', arguments: '{}' } }]);
    acc.add([{ index: 0, id: 'a', function: { name: 'read', arguments: '{"path":"x"}' } }]);
    expect(acc.finalize()).toEqual([
      { id: 'a', name: 'read', arguments: '{"path":"x"}' },
      { id: 'b', name: 'ls', arguments: '{}' },
    ]);
  });

  it('mints a synthetic id when the stream omits one, and drops nameless deltas', () => {
    const acc = new ToolCallAccumulator();
    acc.add([{ index: 0, function: { name: 'diag', arguments: '{}' } }]);
    acc.add([{ index: 5, function: { arguments: '{}' } }]); // no name → dropped
    expect(acc.finalize()).toEqual([{ id: 'call_0', name: 'diag', arguments: '{}' }]);
  });

  it('is empty and safe with no deltas', () => {
    const acc = new ToolCallAccumulator();
    acc.add(undefined);
    expect(acc.hasAny()).toBe(false);
    expect(acc.finalize()).toEqual([]);
  });
});

describe('parseToolArgs', () => {
  it('parses a JSON object', () => {
    expect(parseToolArgs('{"a":1,"b":"x"}')).toEqual({ a: 1, b: 'x' });
  });
  it('returns {} for empty / invalid / non-object JSON', () => {
    expect(parseToolArgs('')).toEqual({});
    expect(parseToolArgs('   ')).toEqual({});
    expect(parseToolArgs('{bad')).toEqual({});
    expect(parseToolArgs('[1,2]')).toEqual({});
    expect(parseToolArgs('"str"')).toEqual({});
  });
});
