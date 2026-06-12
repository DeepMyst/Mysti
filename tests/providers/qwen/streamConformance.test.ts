/**
 * Qwen Code NDJSON stream-conformance fixture (Plan 02 Phase 3).
 *
 * Covers the F16 fix: the assistant-event duplicate tool_use emission branch
 * was removed — a multi-tool turn streams BOTH tools via content_block_start
 * (the old branch returned only the first block and double-fired the
 * permission gate for it).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TestableQwenProvider } from '../../helpers/providerFactory';
import { createQwenSession } from '../../helpers/sessionFactory';
import { runFixture, expectStreamConformance, toolUsesById } from '../../helpers/fixtureRunner';

describe('QwenCodeProvider stream conformance (NDJSON fixture)', () => {
  let provider: TestableQwenProvider;
  let session: ReturnType<typeof createQwenSession>;

  // Multi-tool turn: write_file + run_shell_command in ONE assistant message.
  const FIXTURE = [
    { type: 'system', subtype: 'init', session_id: 'qwen_sess_01' },
    { type: 'stream_event', event: { type: 'message_start' } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Creating the file and running tests.' } } },
    // Tool 1: write_file (native gemini-cli fork name)
    { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'qtool_01', name: 'write_file' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/src/new.ts","content":"x"}' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
    // Tool 2: run_shell_command — same assistant turn
    { type: 'stream_event', event: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'qtool_02', name: 'run_shell_command' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"command":"npm test"}' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 2 } },
    // Assistant complete-message echo containing BOTH tool blocks — must emit nothing
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'qtool_01', name: 'write_file', input: { file_path: '/src/new.ts', content: 'x' } },
          { type: 'tool_use', id: 'qtool_02', name: 'run_shell_command', input: { command: 'npm test' } },
        ],
      },
    },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'qtool_01', content: 'File written', is_error: false }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'qtool_02', content: 'Tests passed', is_error: false }] } },
    { type: 'stream_event', event: { type: 'message_delta', usage: { input_tokens: 800, output_tokens: 200 } } },
    { type: 'stream_event', event: { type: 'message_stop' } },
    { type: 'result', result: 'streamed already' },
  ];

  beforeEach(() => {
    provider = new TestableQwenProvider();
    session = createQwenSession();
  });

  it('conforms to the normalized stream contract', () => {
    const chunks = runFixture(provider, session, FIXTURE);
    expectStreamConformance(chunks, { emitsToolResults: true });
  });

  it('emits BOTH tools of a multi-tool turn with normalized names and kinds', () => {
    const chunks = runFixture(provider, session, FIXTURE);
    const writeUses = toolUsesById(chunks, 'qtool_01');
    const bashUses = toolUsesById(chunks, 'qtool_02');
    expect(writeUses.length).toBeGreaterThan(0);
    expect(bashUses.length).toBeGreaterThan(0);
    expect(writeUses.every((c) => c.toolCall?.name === 'Write' && c.toolCall?.kind === 'edit')).toBe(true);
    expect(bashUses.every((c) => c.toolCall?.name === 'Bash' && c.toolCall?.kind === 'execute')).toBe(true);
  });

  it('does not double-emit tool_use from the assistant echo (no double permission gating)', () => {
    const chunks = runFixture(provider, session, FIXTURE);
    // Exactly 2 emissions per tool: content_block_start + content_block_stop.
    // The assistant complete-message echo must add a third for NEITHER tool.
    expect(toolUsesById(chunks, 'qtool_01')).toHaveLength(2);
    expect(toolUsesById(chunks, 'qtool_02')).toHaveLength(2);
  });
});
