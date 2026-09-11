import { describe, expect, it } from 'vitest';
import { decodeGeminiPermission, decodeGeminiUsage } from '../../../src/providers/gemini/GeminiNativeApproval';

describe('Gemini bounded native file approval surface', () => {
  it('uses the full native file diff without reconstructing title arguments', () => {
    const frame = { toolCall: { toolCallId: 'edit', status: 'pending', kind: 'edit', title: 'misleading display text',
      content: [{ type: 'diff', path: '/workspace/actual', oldText: 'before', newText: 'after' }] } };
    expect(decodeGeminiPermission(frame)?.input).toMatchObject({ file_path: '/workspace/actual', old_text: 'before', new_text: 'after' });
  });
  it.each(['execute', 'other', 'fetch', 'move', 'delete'])('denies %s rather than guessing missing final native arguments', kind => {
    expect(decodeGeminiPermission({ toolCall: { toolCallId: 'tool', status: 'pending', kind, title: 'safe looking command', rawInput: { command: 'ls' } } })).toBeUndefined();
  });
  it('rejects missing content, relative paths, and incomplete diff proposals', () => {
    for (const diff of [undefined, { type: 'diff', path: 'relative', newText: 'after' }, { type: 'diff', path: '/workspace/file' }]) {
      expect(decodeGeminiPermission({ toolCall: { toolCallId: 'tool', status: 'pending', kind: 'edit', content: [diff] } })).toBeUndefined();
    }
  });
  it('binds reads to exactly one native absolute file location', () => {
    expect(decodeGeminiPermission({ toolCall: { toolCallId: 'read', status: 'pending', kind: 'read', locations: [{ path: '/workspace/file' }] } })?.input.file_path).toBe('/workspace/file');
    expect(decodeGeminiPermission({ toolCall: { toolCallId: 'read', status: 'pending', kind: 'read', title: '/workspace/file' } })).toBeUndefined();
  });
});

it('uses final Gemini quota totals without double-counting per-model detail', () => {
  expect(decodeGeminiUsage({ _meta: { quota: { token_count: { input_tokens: 20, output_tokens: 8 }, model_usage: [{ token_count: { input_tokens: 10, output_tokens: 4 } }] } } })).toEqual({ input_tokens: 20, output_tokens: 8 });
  expect(decodeGeminiUsage({ _meta: { quota: { token_count: { input_tokens: -1, output_tokens: 8 } } } })).toBeUndefined();
});
