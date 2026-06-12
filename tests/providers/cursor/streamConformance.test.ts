/**
 * Cursor NDJSON stream-conformance fixture (Plan 02 Phase 3).
 *
 * Covers the two Cursor conformance fixes:
 *  - result.rejected → tool_result status 'failed' (was 'completed')
 *  - parser-level done removed — sendMessage() emits the single done
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TestableCursorProvider } from '../../helpers/providerFactory';
import { createCursorSession } from '../../helpers/sessionFactory';
import { runFixture, expectStreamConformance, toolUsesById } from '../../helpers/fixtureRunner';

describe('CursorProvider stream conformance (NDJSON fixture)', () => {
  let provider: TestableCursorProvider;
  let session: ReturnType<typeof createCursorSession>;

  const FIXTURE = [
    { type: 'system', subtype: 'init', session_id: 'cursor_sess_01', model: 'auto' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Updating the file and running the build.' }] } },
    // Tool 1: edit — REJECTED by the user
    { type: 'tool_call', subtype: 'started', call_id: 'tc_edit_1', tool_call: { editToolCall: { args: { path: '/src/main.ts' } } } },
    { type: 'tool_call', subtype: 'completed', call_id: 'tc_edit_1', tool_call: { editToolCall: { result: { rejected: 'User rejected the edit' } } } },
    // Tool 2: shell — succeeds
    { type: 'tool_call', subtype: 'started', call_id: 'tc_sh_1', tool_call: { shellToolCall: { args: { command: 'npm run build' } } } },
    { type: 'tool_call', subtype: 'completed', call_id: 'tc_sh_1', tool_call: { shellToolCall: { result: { success: 'build ok' } } } },
    // Completion metrics + terminal event — parser must yield NOTHING for done
    { type: 'result', duration_ms: 4200, stats: { input_tokens: 500, output_tokens: 120 } },
    { type: 'done' },
  ];

  beforeEach(() => {
    provider = new TestableCursorProvider();
    session = createCursorSession();
  });

  it('conforms to the normalized stream contract', () => {
    const chunks = runFixture(provider, session, FIXTURE);
    expectStreamConformance(chunks, { emitsToolResults: true });
  });

  it('stamps semantic kinds per tool', () => {
    const chunks = runFixture(provider, session, FIXTURE);
    expect(toolUsesById(chunks, 'tc_edit_1').every((c) => c.toolCall?.kind === 'edit')).toBe(true);
    expect(toolUsesById(chunks, 'tc_edit_1').length).toBeGreaterThan(0);
    expect(toolUsesById(chunks, 'tc_sh_1').every((c) => c.toolCall?.kind === 'execute')).toBe(true);
    expect(toolUsesById(chunks, 'tc_sh_1').length).toBeGreaterThan(0);
  });

  it('maps result.rejected to tool_result status failed', () => {
    const chunks = runFixture(provider, session, FIXTURE);
    const rejected = chunks.find((c) => c.type === 'tool_result' && c.toolCall?.id === 'tc_edit_1');
    expect(rejected).toBeDefined();
    expect(rejected!.toolCall!.status).toBe('failed');
    expect(rejected!.toolCall!.output).toBe('User rejected the edit');

    const success = chunks.find((c) => c.type === 'tool_result' && c.toolCall?.id === 'tc_sh_1');
    expect(success!.toolCall!.status).toBe('completed');
  });

  it('emits zero parser-level done chunks (sendMessage owns the single done)', () => {
    const chunks = runFixture(provider, session, FIXTURE);
    expect(chunks.filter((c) => c.type === 'done')).toHaveLength(0);
  });
});
