import type { MessageSegment, StreamChunk } from '../types';

/** All offsets refer to raw UTF-16 text, before Markdown or display filtering. */
export function applyStreamText(previous: string, chunk: Pick<StreamChunk, 'content' | 'replace'>): string {
  const content = chunk.content ?? '';
  if (!chunk.replace) { return previous + content; }
  const { start, end } = chunk.replace;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > previous.length) {
    throw new Error('Invalid response text revision range');
  }
  return previous.slice(0, start) + content + previous.slice(end);
}

/** Revise text in place while retaining thinking/tool order and tool identity. */
export function updateTextSegments(segments: MessageSegment[], chunk: StreamChunk): void {
  if (chunk.type !== 'text' && chunk.type !== 'thinking') { return; }
  const content = chunk.content ?? '';
  if (!chunk.replace) {
    if (!content) { return; }
    const last = segments.at(-1);
    if (last?.type === chunk.type) { last.content += content; }
    else { segments.push({ type: chunk.type, content }); }
    return;
  }
  applyStreamText(segments.filter(s => s.type === chunk.type).map(s => 'content' in s ? s.content : '').join(''), chunk);
  const { start, end } = chunk.replace;
  let offset = 0, inserted = false;
  for (const segment of segments) {
    if (segment.type !== chunk.type) { continue; }
    const value = segment.content, from = offset, to = offset + value.length;
    offset = to;
    if (to < start || from > end) { continue; }
    const prefix = value.slice(0, Math.max(0, start - from));
    const suffix = value.slice(Math.max(0, end - from));
    segment.content = prefix + (!inserted ? content : '') + suffix;
    inserted = true;
  }
  if (!inserted && content) { segments.push({ type: chunk.type, content }); }
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (segment.type !== 'tool' && !segment.content) { segments.splice(i, 1); }
  }
}

/**
 * Background consumers accept append-only text. Keep tool/control events live,
 * then deliver corrected text before completion/error (or iterator completion).
 * A caller returning early still closes the owned source iterator.
 */
export async function* finalizeStreamText(source: AsyncIterable<StreamChunk>, requireAnnouncement = false): AsyncGenerator<StreamChunk> {
  const buffers = new Map<'text' | 'thinking', string>();
  let failed = false;
  let revisable = !requireAnnouncement;
  function* flush(): Generator<StreamChunk> {
    for (const [type, content] of buffers) { if (content) { yield { type, content }; } }
    buffers.clear();
  }
  try {
    for await (const chunk of source) {
      if (chunk.type === 'session_active' && chunk.textRevisions) { revisable = true; }
      if (chunk.type === 'text' || chunk.type === 'thinking') {
        if (!revisable) {
          if (chunk.replace) { throw new Error('Provider revised text without announcing revision support'); }
          yield chunk;
          continue;
        }
        if (!failed) { buffers.set(chunk.type, applyStreamText(buffers.get(chunk.type) ?? '', chunk)); }
      } else {
        if (chunk.type === 'done' || chunk.type === 'error' || chunk.type === 'auth_error') { yield* flush(); }
        if (chunk.type === 'error' || chunk.type === 'auth_error') { failed = true; }
        yield chunk;
        if (chunk.type === 'done') { return; }
      }
    }
  } catch (error) {
    yield* flush();
    throw error;
  }
  yield* flush();
}
