/**
 * Gemini NDJSON stream-conformance fixture (Plan 02 Phase 3).
 * Native tool names (write_file/run_shell_command) normalize at emission,
 * every tool_use carries kind, resolves, and the parser never emits done.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TestableGeminiProvider } from '../../helpers/providerFactory';
import { createGeminiSession } from '../../helpers/sessionFactory';
import { runFixture, expectStreamConformance, toolUsesById } from '../../helpers/fixtureRunner';

describe('GeminiProvider stream conformance (NDJSON fixture)', () => {
  let provider: TestableGeminiProvider;
  let session: ReturnType<typeof createGeminiSession>;

  const FIXTURE = [
    { type: 'init', session_id: 'gem_sess_01' },
    { type: 'message', role: 'assistant', content: 'Writing the file then running the tests.' },
    { type: 'tool_use', tool_id: 'gtool_01', tool_name: 'write_file', parameters: { file_path: '/src/new.ts', content: 'x' } },
    { type: 'tool_result', tool_id: 'gtool_01', output: 'File created', status: 'success' },
    { type: 'tool_use', tool_id: 'gtool_02', tool_name: 'run_shell_command', parameters: { command: 'npm test' } },
    { type: 'tool_result', tool_id: 'gtool_02', output: 'Tests passed', status: 'success' },
    { type: 'result', stats: { input_tokens: 700, output_tokens: 180 } },
  ];

  beforeEach(() => {
    provider = new TestableGeminiProvider();
    session = createGeminiSession();
  });

  it('conforms to the normalized stream contract', () => {
    const chunks = runFixture(provider, session, FIXTURE);
    expectStreamConformance(chunks, { emitsToolResults: true });
  });

  it('normalizes native names and stamps kinds', () => {
    const chunks = runFixture(provider, session, FIXTURE);
    const writeUses = toolUsesById(chunks, 'gtool_01');
    const bashUses = toolUsesById(chunks, 'gtool_02');
    expect(writeUses.length).toBeGreaterThan(0);
    expect(bashUses.length).toBeGreaterThan(0);
    expect(writeUses.every((c) => c.toolCall?.name === 'Write' && c.toolCall?.kind === 'edit')).toBe(true);
    expect(bashUses.every((c) => c.toolCall?.name === 'Bash' && c.toolCall?.kind === 'execute')).toBe(true);
  });
});
