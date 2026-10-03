/**
 * Codex NDJSON stream-conformance fixture (Plan 02 Phase 3).
 *
 * Covers the narrowed thinking heuristic: ONLY reasoning items become
 * thinking chunks — bold ("**…**") agent/plain text is body text. Also
 * asserts kind stamping, tool resolution, and zero parser-level done.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TestableCodexProvider } from '../../helpers/providerFactory';
import { createCodexSession } from '../../helpers/sessionFactory';
import { runFixture, expectStreamConformance, toolUsesById } from '../../helpers/fixtureRunner';

describe('CodexProvider stream conformance (NDJSON fixture)', () => {
  let provider: TestableCodexProvider;
  let session: ReturnType<typeof createCodexSession>;

  const FIXTURE = [
    { type: 'thread.started', thread_id: 'thread_cdx_01' },
    // Reasoning item — the ONLY legitimate source of thinking chunks
    { type: 'item.completed', item: { type: 'reasoning', id: 'r_1', text: '**Determining the fix**' } },
    // Agent message with inline bold markdown — must stay body text
    { type: 'item.updated', item: { type: 'agent_message', id: 'm_1', text: 'I will update **two files** now.' } },
    // Tool 1: shell command
    { type: 'item.started', item: { type: 'command_execution', id: 'cmd_1', command: 'npm test' } },
    { type: 'item.completed', item: { type: 'command_execution', id: 'cmd_1', command: 'npm test', exit_code: 0, aggregated_output: 'ok' } },
    // Tool 2: file write
    { type: 'item.started', item: { type: 'write', id: 'file_1', file_path: '/src/new.ts', content: 'x', status: 'in_progress' } },
    { type: 'item.completed', item: { type: 'write', id: 'file_1', file_path: '/src/new.ts', content: 'x', status: 'completed' } },
    // Usage — stored, not emitted
    { type: 'turn.completed', usage: { input_tokens: 900, output_tokens: 250, cached_input_tokens: 100 } },
    // Plain non-JSON bold line — historical false-positive for thinking
    '**Summary**',
    // Unknown event type with bold content — also body text
    { type: 'notification', content: '**All tests passed**' },
  ];

  beforeEach(() => {
    provider = new TestableCodexProvider();
    session = createCodexSession();
  });

  it('conforms to the normalized stream contract', () => {
    const chunks = runFixture(provider, session, FIXTURE);
    expectStreamConformance(chunks, { emitsToolResults: true });
  });

  it('stamps semantic kinds per tool', () => {
    const chunks = runFixture(provider, session, FIXTURE);
    expect(toolUsesById(chunks, 'cmd_1').every((c) => c.toolCall?.kind === 'execute')).toBe(true);
    expect(toolUsesById(chunks, 'cmd_1').length).toBeGreaterThan(0);
    expect(toolUsesById(chunks, 'file_1').every((c) => c.toolCall?.kind === 'edit')).toBe(true);
    expect(toolUsesById(chunks, 'file_1').length).toBeGreaterThan(0);
  });

  it('only reasoning items become thinking — bold text never does', () => {
    const chunks = runFixture(provider, session, FIXTURE);
    const thinking = chunks.filter((c) => c.type === 'thinking');
    const text = chunks.filter((c) => c.type === 'text');

    // Exactly one thinking chunk, from the reasoning item (markers stripped)
    expect(thinking).toHaveLength(1);
    expect(thinking[0].content).toBe('Determining the fix\n');

    // All bold body content arrives as text, untouched
    expect(text.some((c) => c.content === 'I will update **two files** now.')).toBe(true);
    expect(text.some((c) => c.content === '**Summary**')).toBe(true);
    expect(text.some((c) => c.content === '**All tests passed**')).toBe(true);
  });
});
