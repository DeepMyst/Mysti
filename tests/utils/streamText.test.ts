import { expect, it } from 'vitest';
import { applyStreamText, updateTextSegments, finalizeStreamText } from '../../src/utils/streamText';
import { ProviderManager } from '../../src/managers/ProviderManager';
import type { MessageSegment, StreamChunk } from '../../src/types';

it('revises UTF-16 text across interleaved segments without changing tool/thinking records', () => {
  const segments: MessageSegment[] = [{ type: 'text', content: 'A🙂B' }, { type: 'tool', toolCallId: 'owned' },
    { type: 'thinking', content: 'Thought' }, { type: 'text', content: 'CDE' }];
  const revision: StreamChunk = { type: 'text', content: 'Corrected', replace: { start: 1, end: 6 } };
  updateTextSegments(segments, revision);
  expect(segments).toEqual([{ type: 'text', content: 'ACorrected' }, { type: 'tool', toolCallId: 'owned' },
    { type: 'thinking', content: 'Thought' }, { type: 'text', content: 'E' }]);
  expect(applyStreamText('A🙂BCDE', revision)).toBe('ACorrectedE');
});
it.each([{ start: -1, end: 1 }, { start: 2, end: 1 }, { start: 0, end: 10 }, { start: 0.5, end: 1 }])('rejects invalid ranges without changing segments: %j', replace => {
  const segments: MessageSegment[] = [{ type: 'text', content: 'ABC' }];
  expect(() => updateTextSegments(segments, { type: 'text', content: 'X', replace })).toThrow(/revision range/);
  expect(segments).toEqual([{ type: 'text', content: 'ABC' }]);
});
it('handles insertion at a segment boundary and full empty retraction', () => {
  const segments: MessageSegment[] = [{ type: 'text', content: 'A' }, { type: 'tool', toolCallId: 't' }, { type: 'text', content: 'B' }];
  updateTextSegments(segments, { type: 'text', content: 'X', replace: { start: 1, end: 1 } });
  expect(segments[0]).toEqual({ type: 'text', content: 'AX' });
  updateTextSegments(segments, { type: 'text', content: '', replace: { start: 0, end: 3 } });
  expect(segments).toEqual([{ type: 'tool', toolCallId: 't' }]);
});
const chunks: StreamChunk[] = [{ type: 'text', content: 'Wrong' }, { type: 'tool_use', toolCall: { id: 't', name: 'read', input: {}, status: 'running' } },
  { type: 'text', content: 'Right', replace: { start: 0, end: 5 } }, { type: 'done' }];
async function collect(source: AsyncIterable<StreamChunk>) { const out: StreamChunk[] = []; for await (const c of source) out.push(c); return out; }
it.each(['done', 'error', 'throw', 'end'])('append-only readers receive corrected partial/final text on %s', async terminal => {
  let closed = false;
  async function* source(): AsyncGenerator<StreamChunk> {
    try { yield* chunks.slice(0, -1); if (terminal === 'throw') throw new Error('Owned failure');
      if (terminal === 'done' || terminal === 'error') yield { type: terminal, content: terminal === 'error' ? 'Owned failure' : undefined };
    } finally { closed = true; }
  }
  const out: StreamChunk[] = []; let error;
  try { for await (const chunk of finalizeStreamText(source())) out.push(chunk); } catch (e) { error = e; }
  expect(out[0].type).toBe('tool_use'); expect(out.filter(c => c.type === 'text')).toEqual([{ type: 'text', content: 'Right' }]);
  expect(!!error).toBe(terminal === 'throw'); expect(closed).toBe(true);
});
it('early return closes the source while tools remain live and provisional text stays buffered', async () => {
  let closed = false;
  async function* source() { try { yield* chunks; } finally { closed = true; } }
  const stream = finalizeStreamText(source()); expect((await stream.next()).value?.type).toBe('tool_use'); await stream.return(undefined);
  expect(closed).toBe(true);
});
it.each(['main-default', 'background', 'main-revisions', 'ordinary-provider'])('ProviderManager routes %s through the proper text contract', async kind => {
  const announcement: StreamChunk = { type: 'session_active', sessionId: 'owned', textRevisions: true };
  const emitted = kind === 'ordinary-provider' ? chunks : [announcement, ...chunks];
  const provider = { id: 'owned', capabilities: { emitsTextRevisions: kind !== 'ordinary-provider' }, sendMessage: async function* () { yield* emitted; } };
  const manager = Object.create(ProviderManager.prototype) as any;
  manager._getActiveProvider = () => provider; manager._panelProviders = new Map();
  const stream = kind === 'background' ? manager.sendMessageToProvider('owned', '', [], {}, null)
    : manager.sendMessage('', [], {}, null, undefined, undefined, undefined, undefined, undefined, kind === 'main-revisions');
  const out = await collect(stream);
  if (kind === 'main-revisions' || kind === 'ordinary-provider') expect(out).toEqual(emitted);
  else expect(out.map(c => c.type)).toEqual(['session_active', 'tool_use', 'text', 'done']);
  if (kind === 'main-default' || kind === 'background') expect(out[2].content).toBe('Right');
});

it('does not buffer an append-only transport and rejects unannounced revisions', async () => {
  async function* source() { yield { type: 'text', content: 'Live' } as StreamChunk; yield { type: 'done' } as StreamChunk; }
  expect(await collect(finalizeStreamText(source(), true))).toEqual([{ type: 'text', content: 'Live' }, { type: 'done' }]);
  async function* invalid() { yield* chunks; }
  await expect(collect(finalizeStreamText(invalid(), true))).rejects.toThrow(/without announcing/);
});
