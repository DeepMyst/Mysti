/**
 * Streaming tool_call accumulator (Plan 19 Phase 4) — reassembling OpenAI-style
 * tool_call deltas (id/name early, arguments streamed in fragments, keyed by index).
 */
import { describe, it, expect } from 'vitest';
import { ToolCallAccumulator, parseToolArgs, parseToolArgsChecked } from '../../src/utils/toolCallAccumulator';

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

describe('parseToolArgsChecked', () => {
  it('parses a JSON object and reports ok', () => {
    expect(parseToolArgsChecked('{"a":1,"b":"x"}')).toEqual({ args: { a: 1, b: 'x' }, truncated: false, status: 'ok' });
    expect(parseToolArgsChecked('{}')).toEqual({ args: {}, truncated: false, status: 'ok' });
    expect(parseToolArgsChecked('  {"a":[1,2],"b":{"c":null}}  ')).toMatchObject({ status: 'ok', truncated: false });
  });

  it('distinguishes an ABSENT payload from a cut-off one', () => {
    for (const empty of ['', '   ', '\n\t']) {
      expect(parseToolArgsChecked(empty), JSON.stringify(empty)).toEqual({ args: {}, truncated: false, status: 'empty' });
    }
  });

  it('flags a truncated object as truncated, not as wrong arguments', () => {
    const cases = [
      '{',                                   // cut immediately after the brace
      '{"pageId":"p1",',                     // cut after a separator
      '{"pageId":"p1","text":',              // cut after a key, before the value
      '{"pageId"',                           // cut mid-key-terminator
      '{"a":{"b":[{"c":',                    // cut deep inside nesting
      '{"a":1,"b":tru',                      // cut inside a literal
      '{"a":-',                              // cut inside a number
      '{"a":1.',                             // cut after a decimal point
      '{"a":1e',                             // cut after an exponent marker
    ];
    for (const raw of cases) {
      expect(parseToolArgsChecked(raw), raw).toEqual({ args: {}, truncated: true, status: 'truncated' });
    }
  });

  it('flags a truncated string literal, including mid-escape cuts', () => {
    const cases = [
      '{"text":"Get started with',           // plain unterminated string
      '{"text":"has a } brace and a \\" quote', // braces/quotes inside the string
      '{"text":"trailing backslash \\',      // cut on the escape itself
      '{"text":"\\u00',                      // cut inside a \u escape
      '{"jsx":"function Page(){ return <div>',
    ];
    for (const raw of cases) {
      expect(parseToolArgsChecked(raw), raw).toMatchObject({ truncated: true, status: 'truncated' });
    }
  });

  it('does NOT call genuinely broken output truncated', () => {
    const cases: Array<[string, string]> = [
      ['{bad', 'unquoted key'],
      ['{"a":1,}', 'trailing comma'],
      ['{"a":1} oops', 'trailing garbage'],
      ['{"a" 1}', 'missing colon'],
      ['{"a":1]', 'mismatched closer'],
      ['{"a":"\\q"}', 'invalid escape'],
      ['{"a":01}', 'leading zero'],
      ['here is the json: {"a":1}', 'prose before the payload'],
      ['{"a":tXX', 'literal that never was'],
    ];
    for (const [raw, why] of cases) {
      expect(parseToolArgsChecked(raw), why).toEqual({ args: {}, truncated: false, status: 'malformed' });
    }
  });

  it('reports valid-but-wrong-shaped JSON separately from both', () => {
    for (const raw of ['[1,2]', '"str"', '42', 'true', 'null']) {
      expect(parseToolArgsChecked(raw), raw).toEqual({ args: {}, truncated: false, status: 'not-an-object' });
    }
  });

  it('bounds the scan so a nesting bomb cannot hang the turn', () => {
    const shallow = '{"a":'.repeat(50) + '1';
    expect(parseToolArgsChecked(shallow)).toMatchObject({ truncated: true });
    const bomb = '['.repeat(50_000);
    const started = Date.now();
    expect(parseToolArgsChecked(bomb)).toEqual({ args: {}, truncated: false, status: 'malformed' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('handles a large truncated payload (the real coordinator failure) quickly', () => {
    const raw = `{"jsx":"${'x'.repeat(200_000)}`;
    const started = Date.now();
    expect(parseToolArgsChecked(raw)).toMatchObject({ truncated: true, status: 'truncated' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('keeps parseToolArgs behaviour byte-for-byte for existing callers', () => {
    for (const raw of ['{"a":1}', '', '   ', '{bad', '[1,2]', '"str"', '{"a":1,"b":']) {
      expect(parseToolArgs(raw), raw).toEqual(parseToolArgsChecked(raw).args);
    }
    expect(parseToolArgs('{"a":1,"b":')).toEqual({});
  });

  it('composes with the accumulator: a stream cut mid-arguments is reported as truncated', () => {
    const acc = new ToolCallAccumulator();
    acc.add([{ index: 0, id: 'c1', function: { name: 'canvas_write_page_jsx' } }]);
    acc.add([{ index: 0, function: { arguments: '{"pageId":"p1","jsx":"function Page(){ return ' } }]);
    const [call] = acc.finalize();
    expect(parseToolArgsChecked(call.arguments)).toMatchObject({ truncated: true, status: 'truncated' });
  });
});
