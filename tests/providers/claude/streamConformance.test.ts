/**
 * Claude Code NDJSON stream-conformance fixture (Plan 02 Phase 3).
 *
 * Recorded-style stream-json transcript: thinking + text + two tools + usage.
 * Asserts the normalized contract: every tool_use carries `kind`, every tool
 * resolves, ZERO parser-level done (sendMessage owns the single done), and no
 * thinking/body cross-contamination.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TestableClaudeProvider } from '../../helpers/providerFactory';
import { createClaudeSession } from '../../helpers/sessionFactory';
import { runFixture, expectStreamConformance } from '../../helpers/fixtureRunner';

describe('ClaudeCodeProvider stream conformance (NDJSON fixture)', () => {
  let provider: TestableClaudeProvider;
  let session: ReturnType<typeof createClaudeSession>;

  const FIXTURE = [
    { type: 'system', subtype: 'init', session_id: 'sess_claude_01', model: 'claude-sonnet-4' },
    { type: 'stream_event', event: { type: 'message_start' } },
    // Thinking block
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'I should read the config first.' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    // Text block
    { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Let me check the **configuration**.' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
    // Tool 1: Read
    { type: 'stream_event', event: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_01', name: 'Read' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/src/config.ts"}' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 2 } },
    // Full assistant echo (must NOT re-emit the tool)
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/src/config.ts' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'export const config = {};', is_error: false }] } },
    // Tool 2: Bash
    { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_02', name: 'Bash' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"npm test"}' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_02', content: 'All tests passed', is_error: false }] } },
    // Usage + termination events (parser must stay silent on done)
    { type: 'stream_event', event: { type: 'message_delta', usage: { input_tokens: 1200, output_tokens: 300 } } },
    { type: 'stream_event', event: { type: 'message_stop' } },
    { type: 'result', result: 'final text already streamed' },
  ];

  beforeEach(() => {
    provider = new TestableClaudeProvider();
    session = createClaudeSession();
  });

  it('conforms to the normalized stream contract', () => {
    const chunks = runFixture(provider, session, FIXTURE);
    expectStreamConformance(chunks, { emitsToolResults: true });
  });

  it('stamps semantic kinds per tool', () => {
    const chunks = runFixture(provider, session, FIXTURE);
    const readUses = chunks.filter((c) => c.type === 'tool_use' && c.toolCall?.id === 'toolu_01');
    const bashUses = chunks.filter((c) => c.type === 'tool_use' && c.toolCall?.id === 'toolu_02');
    expect(readUses.length).toBeGreaterThan(0);
    expect(bashUses.length).toBeGreaterThan(0);
    expect(readUses.every((c) => c.toolCall?.kind === 'read')).toBe(true);
    expect(bashUses.every((c) => c.toolCall?.kind === 'execute')).toBe(true);
  });

  it('keeps thinking and body separated', () => {
    const chunks = runFixture(provider, session, FIXTURE);
    const thinking = chunks.filter((c) => c.type === 'thinking' && c.content);
    const text = chunks.filter((c) => c.type === 'text');
    expect(thinking.map((c) => c.content).join('')).toBe('I should read the config first.');
    // Bold markdown stays body text, never thinking
    expect(text.some((c) => c.content?.includes('**configuration**'))).toBe(true);
  });

  it('does not re-emit tool_use from the assistant echo event', () => {
    const chunks = runFixture(provider, session, FIXTURE);
    // toolu_01 emits exactly twice: content_block_start (empty input) +
    // content_block_stop (parsed input) — the assistant echo adds nothing.
    const uses = chunks.filter((c) => c.type === 'tool_use' && c.toolCall?.id === 'toolu_01');
    expect(uses).toHaveLength(2);
  });
});
