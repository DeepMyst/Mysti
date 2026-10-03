/**
 * NDJSON fixture runner for provider stream-conformance tests (Plan 02 Phase 3).
 *
 * Feeds a recorded-style event stream through a provider's parseStreamLine and
 * asserts the normalized stream contract:
 *  - every tool_use chunk carries a valid semantic `kind`
 *  - every tool_use eventually resolves with a tool_result for the same id
 *    (unless the provider declares `emitsToolResults: false` — those rely on
 *    webview auto-resolution)
 *  - ZERO parser-level `done` chunks: the single authoritative done per
 *    response is emitted by sendMessage()/processStream() after the stream
 *    ends, never by parseStreamLine.
 */
import { expect } from 'vitest';
import type { StreamChunk, ToolCallKind } from '../../src/types';
import type { PanelSessionState } from '../../src/providers/base/BaseCliProvider';

export const VALID_TOOL_KINDS: readonly ToolCallKind[] = [
  'read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'other',
];

interface ParsingProvider {
  parseStreamLine(line: string, session: PanelSessionState): StreamChunk | null;
}

/** Serialize object events to NDJSON lines and collect non-null chunks. */
export function runFixture(
  provider: ParsingProvider,
  session: PanelSessionState,
  events: Array<string | Record<string, unknown>>,
): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  for (const event of events) {
    const line = typeof event === 'string' ? event : JSON.stringify(event);
    const chunk = provider.parseStreamLine(line, session);
    if (chunk) {
      chunks.push(chunk);
    }
  }
  return chunks;
}

/**
 * Assert the normalized stream contract over collected chunks.
 * `emitsToolResults: false` skips the resolution check (webview auto-resolves).
 */
export function expectStreamConformance(
  chunks: StreamChunk[],
  opts: { emitsToolResults: boolean },
): void {
  // Exactly one done per response — and it is NOT the parser's to emit.
  const doneChunks = chunks.filter((c) => c.type === 'done');
  expect(doneChunks, 'parseStreamLine must never emit done (sendMessage owns the single terminal done)').toHaveLength(0);

  // Every tool_use carries a valid semantic kind.
  const toolUses = chunks.filter((c) => c.type === 'tool_use');
  for (const chunk of toolUses) {
    expect(chunk.toolCall, 'tool_use chunk must carry a toolCall').toBeDefined();
    expect(
      chunk.toolCall!.kind,
      `tool_use "${chunk.toolCall!.name}" must be stamped with a kind`,
    ).toBeDefined();
    expect(VALID_TOOL_KINDS).toContain(chunk.toolCall!.kind);
  }

  // Every tool_use eventually resolves (matched tool_result by id).
  if (opts.emitsToolResults) {
    const resolvedIds = new Set(
      chunks.filter((c) => c.type === 'tool_result').map((c) => c.toolCall?.id),
    );
    for (const chunk of toolUses) {
      expect(
        resolvedIds.has(chunk.toolCall!.id),
        `tool_use "${chunk.toolCall!.name}" (${chunk.toolCall!.id}) must resolve with a tool_result`,
      ).toBe(true);
    }
  }
}

/** Convenience: tool_use chunks for a given tool-call id. */
export function toolUsesById(chunks: StreamChunk[], id: string): StreamChunk[] {
  return chunks.filter((c) => c.type === 'tool_use' && c.toolCall?.id === id);
}
