/** Streaming framing for local HTTP providers. No provider or account state is retained. */
type HttpBody = { getReader(): ReadableStreamDefaultReader<Uint8Array> };
/** Bound incomplete frames from a broken server (UTF-16 code units, at most 8 MiB). */
export const MAX_HTTP_FRAME_CHARS = 4 * 1024 * 1024;

/** Decode UTF-8 across reads, including a final unterminated line. onChunk observes raw reads for idle deadlines. */
export async function* readHttpLines(body: HttpBody, signal: AbortSignal, onChunk?: () => void): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let skipLF = false;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (!done) { onChunk?.(); }
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // SSE permits LF, CRLF and CR. A CR split from its LF is still one delimiter.
      if (skipLF && buffer.length) {
        if (buffer[0] === '\n') { buffer = buffer.slice(1); }
        skipLF = false;
      }
      let end: number;
      while ((end = buffer.search(/[\r\n]/)) !== -1) {
        if (end > MAX_HTTP_FRAME_CHARS) { throw new Error('HTTP stream line exceeds the frame size limit'); }
        const line = buffer.slice(0, end);
        const isCR = buffer[end] === '\r';
        buffer = buffer.slice(end + 1);
        if (isCR) {
          if (buffer[0] === '\n') { buffer = buffer.slice(1); }
          else if (!buffer.length) { skipLF = true; }
        }
        signal.throwIfAborted();
        yield line;
      }
      if (buffer.length > MAX_HTTP_FRAME_CHARS) { throw new Error('HTTP stream line exceeds the frame size limit'); }
      if (done) {
        if (buffer.length) { signal.throwIfAborted(); yield buffer; }
        return;
      }
    }
  } finally {
    // Completion markers and generator abandonment must stop the HTTP body too.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Assemble SSE data fields; tolerate an EOF after the final data frame. */
export async function* readServerSentData(body: HttpBody, signal: AbortSignal, onChunk?: () => void): AsyncGenerator<string> {
  let data: string[] = [];
  let size = 0;
  for await (const line of readHttpLines(body, signal, onChunk)) {
    if (!line) {
      if (data.length) { yield data.join('\n'); data = []; size = 0; }
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    if (field !== 'data') { continue; }
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) { value = value.slice(1); }
    size += value.length + 1;
    if (size > MAX_HTTP_FRAME_CHARS) { throw new Error('HTTP SSE event exceeds the frame size limit'); }
    data.push(value);
  }
  if (data.length) { signal.throwIfAborted(); yield data.join('\n'); }
}
